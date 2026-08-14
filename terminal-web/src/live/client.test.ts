import { describe, expect, it } from 'vitest';

import {
  TerminalLiveDecoder,
  TerminalLiveFrameType,
  decodeInput,
  decodeResize,
  encodeAttached,
  encodeResizeApplied,
} from './codec.js';
import { connectTerminalLive, type TerminalByteStream } from './client.js';

class FakeStream implements TerminalByteStream {
  readonly writes: Uint8Array[] = [];
  private reads: Array<Uint8Array | null> = [];
  private waiters: Array<(value: Uint8Array | null) => void> = [];
  async read(): Promise<Uint8Array | null> {
    if (this.reads.length > 0) return this.reads.shift() ?? null;
    return await new Promise(resolve => this.waiters.push(resolve));
  }
  async write(data: Uint8Array): Promise<void> { this.writes.push(data.slice()); }
  async close(): Promise<void> { this.push(null); }
  push(data: Uint8Array | null): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(data); else this.reads.push(data);
  }
}

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not reached');
};

describe('semantic terminal live client', () => {
  it('sends ordered input and settles resize only from its canonical acknowledgement', async () => {
    const stream = new FakeStream();
    const geometries: unknown[] = [];
    const connecting = connectTerminalLive({
      openStream: async () => stream,
      attach: { sessionId: 's', connectionId: 'c', attachGeneration: 1, cols: 80, rows: 24 },
      onGeometry: geometry => geometries.push(geometry),
    });
    await waitUntil(() => stream.writes.length === 1);
    stream.push(encodeAttached({ presentationSequence: 4n, geometryGeneration: 1n, cols: 80, rows: 24 }));
    const connection = await connecting;
    await connection.sendInput(new TextEncoder().encode('中'));
    const resizing = connection.resizeWithEffectiveGeometry(120, 40);
    await waitUntil(() => stream.writes.length === 3);
    const input = decodeInput(new TerminalLiveDecoder().push(stream.writes[1]!)[0]!);
    expect(new TextDecoder().decode(input.data)).toBe('中');
    expect(decodeResize(new TerminalLiveDecoder().push(stream.writes[2]!)[0]!)).toEqual({ sequence: 1n, cols: 120, rows: 40 });
    stream.push(encodeResizeApplied({ sequence: 1n, geometryGeneration: 2n, presentationSequence: 4n, cols: 120, rows: 40 }));
    await expect(resizing).resolves.toMatchObject({ effective: { generation: 2, cols: 120, rows: 40 } });
    expect(geometries).toHaveLength(2);
  });

  it('fails closed when a removed raw output frame is received', async () => {
    const stream = new FakeStream();
    const errors: Error[] = [];
    const connecting = connectTerminalLive({
      openStream: async () => stream,
      attach: { sessionId: 's', connectionId: 'c', attachGeneration: 1, cols: 80, rows: 24 },
      onError: error => errors.push(error),
    });
    await waitUntil(() => stream.writes.length === 1);
    stream.push(encodeAttached({ presentationSequence: 1n, geometryGeneration: 1n, cols: 80, rows: 24 }));
    await connecting;
    const raw = new Uint8Array(8);
    raw[0] = 0x82;
    stream.push(raw);
    await waitUntil(() => errors.length === 1);
    expect(errors[0]?.message).toMatch(/unknown/i);
  });
});
