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
