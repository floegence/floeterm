import { describe, expect, it, vi } from 'vitest';

import { TerminalLiveDecoder, decodeInput, encodeAttached } from './codec.js';
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
      control: { semanticHistory: vi.fn() },
    });
    const attaching = bundle.transport.attachWithPresentation('session', 80, 24);
    await waitUntil(() => streams.length === 1 && streams[0]!.writes.length === 1);
    streams[0]!.push(encodeAttached({ presentationSequence: 1n, geometryGeneration: 1n, cols: 80, rows: 24 }));
    await expect(attaching).resolves.toMatchObject({ runtimeAttachGeneration: 1, cols: 80, rows: 24 });
    await bundle.transport.sendInput('session', '中');
    const frame = new TerminalLiveDecoder().push(streams[0]!.writes[1]!)[0]!;
    expect(new TextDecoder().decode(decodeInput(frame).data)).toBe('中');

    const replacing = bundle.transport.attachWithPresentation('session', 120, 40);
    await waitUntil(() => streams.length === 2 && streams[1]!.writes.length === 1);
    streams[1]!.push(encodeAttached({ presentationSequence: 2n, geometryGeneration: 2n, cols: 120, rows: 40 }));
    await expect(replacing).resolves.toMatchObject({ runtimeAttachGeneration: 2, cols: 120, rows: 40 });
    expect(streams[0]!.writes).toHaveLength(2);
  });
});
