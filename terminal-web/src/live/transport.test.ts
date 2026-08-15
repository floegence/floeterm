import { describe, expect, it, vi } from 'vitest';

import {
  TerminalLiveDecoder,
  decodeActivate,
  decodeInput,
  decodeInputIntent,
  encodeActivated,
  encodeAttached,
  encodeControllerChanged,
} from './codec.js';
import type { TerminalByteStream } from './client.js';
import { createSemanticTerminalLiveTransport } from './transport.js';

class FakeStream implements TerminalByteStream {
  readonly writes: Uint8Array[] = [];
  private reads: Array<Uint8Array | null> = [];
  private waiters: Array<(value: Uint8Array | null) => void> = [];
  async read(): Promise<Uint8Array | null> { return this.reads.length ? this.reads.shift() ?? null : await new Promise(resolve => this.waiters.push(resolve)); }
  async write(data: Uint8Array): Promise<void> { this.writes.push(data.slice()); }
  async close(): Promise<void> { this.push(null); }
  push(data: Uint8Array | null): void { const waiter = this.waiters.shift(); if (waiter) waiter(data); else this.reads.push(data); }
}

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) { if (predicate()) return; await Promise.resolve(); }
  throw new Error('condition was not reached');
};

describe('semantic terminal live transport', () => {
  it('reassembles one transport-bounded snapshot before returning a complete viewport', async () => {
    const streams: FakeStream[] = [];
    const payload = new TextEncoder().encode(JSON.stringify({
      v: 1,
      frame: {
        width: 2, height: 1, bufferKind: 'normal',
        cursor: { x: 0, y: 0, visible: false, shape: 'block', blinking: false },
        history: { revision: 4, totalRows: 10, screenStartOffset: 9 },
        graphics: { generation: 0, images: [], placements: [] },
        styles: [['default', 'default', false, false, false]],
        styleInverses: [false],
        rows: [[['H', 1, 0, ''], ['I', 1, 0, '']]],
      },
    }));
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', payload))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const split = Math.floor(payload.byteLength / 2);
    const rawChunks = [payload.slice(0, split), payload.slice(split)].map((part, chunkIndex) => ({
      snapshotId: 'snapshot',
      ...(chunkIndex === 0 ? { continuation: 'hc-snapshot-1' } : {}),
      chunkIndex, chunkCount: 2, payloadBytes: payload.byteLength, payloadSha256: digest, payload: part,
      revision: 4, transportGeneration: 1, contentEpoch: 0, geometryGeneration: 1,
      cols: 2, rows: 1,
      anchor: 'anchor', firstAvailable: 'first', lastAvailable: 'last', screenStart: 'screen',
      offset: 3, totalRows: 10, screenStartOffset: 9, hasPrevious: true, hasNext: true,
    }));
    const semanticHistory = vi.fn(async (_sessionId, _connectionId, _generation, request) => (
      'continuation' in request ? rawChunks[1]! : rawChunks[0]!
    ));
    const bundle = createSemanticTerminalLiveTransport({
      connectionId: 'view',
      openStream: async () => { const stream = new FakeStream(); streams.push(stream); return stream; },
      control: { semanticHistory },
    });
    const attaching = bundle.transport.attachWithPresentation('session', 2, 1);
    await waitUntil(() => streams[0]?.writes.length === 1);
    streams[0]!.push(encodeAttached({
      presentationSequence: 1n, geometryGeneration: 1n, controllerEpoch: 1n,
      cols: 2, rows: 1, isController: true,
    }));
    await attaching;

    const result = await bundle.transport.semanticHistory('session', { direction: 'start', viewportRows: 1 });

    expect(semanticHistory).toHaveBeenCalledTimes(2);
    expect(semanticHistory.mock.calls[1]?.[3]).toEqual({ continuation: 'hc-snapshot-1' });
    expect(result.frame.rows[0]!.cells.map(cell => cell.text).join('')).toBe('HI');
    expect(result.frame.height).toBe(1);
    bundle.transport.dispose();
  });

  it('keeps one current attachment and sends input only through it', async () => {
    const streams: FakeStream[] = [];
    const bundle = createSemanticTerminalLiveTransport({
      connectionId: 'view',
      openStream: async () => { const stream = new FakeStream(); streams.push(stream); return stream; },
      control: { semanticHistory: vi.fn(), clearSemanticContent: vi.fn(async () => ({ presentationSequence: 2, contentEpoch: 1 })) },
    });
    const attaching = bundle.transport.attachWithPresentation('session', 80, 24);
    await waitUntil(() => streams.length === 1 && streams[0]!.writes.length === 1);
    streams[0]!.push(encodeAttached({ presentationSequence: 1n, geometryGeneration: 1n, controllerEpoch: 1n, cols: 80, rows: 24, isController: true }));
    await expect(attaching).resolves.toMatchObject({ runtimeAttachGeneration: 1, cols: 80, rows: 24 });
    await bundle.transport.sendInput('session', '中');
    const frame = new TerminalLiveDecoder().push(streams[0]!.writes[1]!)[0]!;
    expect(new TextDecoder().decode(decodeInput(frame).data)).toBe('中');
    await bundle.transport.sendInputIntent('session', {
      kind: 'key', code: 'Enter', text: '', action: 'press',
      modifiers: { shift: false, control: false, alt: false, super: false, capsLock: false, numLock: false },
    });
    const intentFrame = new TerminalLiveDecoder().push(streams[0]!.writes[2]!)[0]!;
    expect(decodeInputIntent(intentFrame)).toEqual({
      sequence: 2n, code: 'Enter', text: '', action: 'press', modifiers: 0,
    });

    const replacing = bundle.transport.attachWithPresentation('session', 120, 40);
    await waitUntil(() => streams.length === 2 && streams[1]!.writes.length === 1);
    streams[1]!.push(encodeAttached({ presentationSequence: 2n, geometryGeneration: 2n, controllerEpoch: 2n, cols: 120, rows: 40, isController: true }));
    await expect(replacing).resolves.toMatchObject({ runtimeAttachGeneration: 2, cols: 120, rows: 40 });
    expect(streams[0]!.writes).toHaveLength(3);

    await expect(bundle.transport.clearSemanticContent?.('session')).resolves.toEqual({
      presentationSequence: 2,
      contentEpoch: 1,
    });
  });

  it('rejects a clear settlement from a superseded transport generation', async () => {
    const streams: FakeStream[] = [];
    let settleClear: ((value: { presentationSequence: number; contentEpoch: number }) => void) | undefined;
    const clearSemanticContent = vi.fn(() => new Promise<{ presentationSequence: number; contentEpoch: number }>((resolve) => {
      settleClear = resolve;
    }));
    const bundle = createSemanticTerminalLiveTransport({
      connectionId: 'view',
      openStream: async () => { const stream = new FakeStream(); streams.push(stream); return stream; },
      control: { semanticHistory: vi.fn(), clearSemanticContent },
    });
    const firstAttach = bundle.transport.attachWithPresentation('session', 80, 24);
    await waitUntil(() => streams.length === 1 && streams[0]!.writes.length === 1);
    streams[0]!.push(encodeAttached({ presentationSequence: 1n, geometryGeneration: 1n, controllerEpoch: 1n, cols: 80, rows: 24, isController: true }));
    await firstAttach;

    const clearing = bundle.transport.clearSemanticContent!('session');
    expect(clearSemanticContent).toHaveBeenCalledWith('session', 'view', 1);
    const replacement = bundle.transport.attachWithPresentation('session', 80, 24);
    await waitUntil(() => streams.length === 2 && streams[1]!.writes.length === 1);
    streams[1]!.push(encodeAttached({ presentationSequence: 1n, geometryGeneration: 1n, controllerEpoch: 1n, cols: 80, rows: 24, isController: true }));
    await replacement;
    settleClear?.({ presentationSequence: 2, contentEpoch: 1 });

    await expect(clearing).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('activates only the current attachment and publishes controller ownership', async () => {
    const streams: FakeStream[] = [];
    const bundle = createSemanticTerminalLiveTransport({
      connectionId: 'workbench',
      openStream: async () => { const stream = new FakeStream(); streams.push(stream); return stream; },
      control: { semanticHistory: vi.fn() },
    });
    const controllers: unknown[] = [];
    bundle.eventSource.onTerminalController('session', event => controllers.push(event));
    const attaching = bundle.transport.attachWithPresentation('session', 46, 16);
    await waitUntil(() => streams[0]?.writes.length === 1);
    streams[0]!.push(encodeAttached({
      presentationSequence: 1n, geometryGeneration: 1n, controllerEpoch: 3n,
      cols: 46, rows: 16, isController: false,
    }));
    await attaching;

    const activating = bundle.transport.activate('session', 120, 40);
    await waitUntil(() => streams[0]!.writes.length === 2);
    expect(decodeActivate(new TerminalLiveDecoder().push(streams[0]!.writes[1]!)[0]!)).toEqual({
      sequence: 1n, controllerEpoch: 3n, cols: 120, rows: 40,
    });
    streams[0]!.push(encodeControllerChanged({ epoch: 4n, isController: true }));
    streams[0]!.push(encodeActivated({
      sequence: 1n, controllerEpoch: 4n, geometryGeneration: 2n,
      presentationSequence: 2n, cols: 120, rows: 40,
    }));
    await expect(activating).resolves.toMatchObject({
      runtimeAttachGeneration: 1,
      effective: { cols: 120, rows: 40 },
      controller: { epoch: 4, isController: true },
    });
    expect(controllers).toEqual([
      { sessionId: 'session', epoch: 3, isController: false },
      { sessionId: 'session', epoch: 4, isController: true },
    ]);
  });
});
