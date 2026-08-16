import { describe, expect, it } from 'vitest';

import {
  TerminalLiveDecoder,
  TerminalLiveFrameType,
  MAX_INPUT_BYTES,
  decodeInput,
  decodeInputIntent,
  decodePasteChunk,
  decodeActivate,
  decodeResize,
  encodeAttached,
  encodeActivated,
  encodeActivationRejected,
  encodeControllerChanged,
  encodeResizeApplied,
} from './codec.js';
import { MAX_QUEUED_INPUT_BYTES, connectTerminalLive, type TerminalByteStream } from './client.js';

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
    stream.push(encodeAttached({ presentationSequence: 4n, geometryGeneration: 1n, controllerEpoch: 1n, cols: 80, rows: 24, isController: true }));
    const connection = await connecting;
    await connection.sendInput(new TextEncoder().encode('中'));
    await connection.sendInputIntent({ code: 'Enter', text: '', action: 'press', modifiers: 0 });
    const resizing = connection.resizeWithEffectiveGeometry(120, 40);
    await waitUntil(() => stream.writes.length === 4);
    const input = decodeInput(new TerminalLiveDecoder().push(stream.writes[1]!)[0]!);
    expect(new TextDecoder().decode(input.data)).toBe('中');
    expect(decodeInputIntent(new TerminalLiveDecoder().push(stream.writes[2]!)[0]!)).toEqual({
      sequence: 2n, code: 'Enter', text: '', action: 'press', modifiers: 0,
    });
    expect(decodeResize(new TerminalLiveDecoder().push(stream.writes[3]!)[0]!)).toEqual({ sequence: 1n, cols: 120, rows: 40 });
    stream.push(encodeResizeApplied({ sequence: 1n, geometryGeneration: 2n, presentationSequence: 4n, cols: 120, rows: 40 }));
    await expect(resizing).resolves.toMatchObject({ effective: { generation: 2, cols: 120, rows: 40 } });
    expect(geometries).toHaveLength(2);
  });

  it('sends one bounded paste as ordered start and end chunks', async () => {
    const stream = new FakeStream();
    const connecting = connectTerminalLive({
      openStream: async () => stream,
      attach: { sessionId: 's', connectionId: 'c', attachGeneration: 1, cols: 80, rows: 24 },
    });
    await waitUntil(() => stream.writes.length === 1);
    stream.push(encodeAttached({ presentationSequence: 1n, geometryGeneration: 1n, controllerEpoch: 1n, cols: 80, rows: 24, isController: true }));
    const connection = await connecting;
    const payload = new Uint8Array(MAX_INPUT_BYTES + 17).fill(0x70);

    await connection.sendPaste(payload);

    expect(stream.writes).toHaveLength(3);
    const first = decodePasteChunk(new TerminalLiveDecoder().push(stream.writes[1]!)[0]!);
    const last = decodePasteChunk(new TerminalLiveDecoder().push(stream.writes[2]!)[0]!);
    expect(first).toMatchObject({ sequence: 1n, start: true, end: false });
    expect(first.data).toHaveLength(MAX_INPUT_BYTES);
    expect(last).toMatchObject({ sequence: 2n, start: false, end: true });
    expect(last.data).toHaveLength(17);
    const joined = new Uint8Array(first.data.byteLength + last.data.byteLength);
    joined.set(first.data);
    joined.set(last.data, first.data.byteLength);
    expect(joined).toEqual(payload);
  });

  it('rejects an oversized paste before writing any chunk', async () => {
    const stream = new FakeStream();
    const connecting = connectTerminalLive({
      openStream: async () => stream,
      attach: { sessionId: 's', connectionId: 'c', attachGeneration: 1, cols: 80, rows: 24 },
    });
    await waitUntil(() => stream.writes.length === 1);
    stream.push(encodeAttached({ presentationSequence: 1n, geometryGeneration: 1n, controllerEpoch: 1n, cols: 80, rows: 24, isController: true }));
    const connection = await connecting;

    await expect(connection.sendPaste(new Uint8Array(MAX_QUEUED_INPUT_BYTES + 1))).rejects.toThrow(/paste queue limit/i);
    expect(stream.writes).toHaveLength(1);
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
    stream.push(encodeAttached({ presentationSequence: 1n, geometryGeneration: 1n, controllerEpoch: 1n, cols: 80, rows: 24, isController: true }));
    await connecting;
    const raw = new Uint8Array(8);
    raw[0] = 0x82;
    stream.push(raw);
    await waitUntil(() => errors.length === 1);
    expect(errors[0]?.message).toMatch(/unknown/i);
  });

  it('orders explicit activation before immediately queued input and applies its controller geometry', async () => {
    const stream = new FakeStream();
    const controllers: unknown[] = [];
    const connecting = connectTerminalLive({
      openStream: async () => stream,
      attach: { sessionId: 's', connectionId: 'workbench', attachGeneration: 7, cols: 46, rows: 16 },
      onController: controller => controllers.push(controller),
    });
    await waitUntil(() => stream.writes.length === 1);
    stream.push(encodeAttached({
      presentationSequence: 4n, geometryGeneration: 1n, controllerEpoch: 3n,
      cols: 46, rows: 16, isController: false,
    }));
    const connection = await connecting;
    const activating = connection.activateWithEffectiveGeometry(120, 40);
    const input = connection.sendInput(new TextEncoder().encode('x'));
    await waitUntil(() => stream.writes.length === 3);
    const activate = decodeActivate(new TerminalLiveDecoder().push(stream.writes[1]!)[0]!);
    const writtenInput = decodeInput(new TerminalLiveDecoder().push(stream.writes[2]!)[0]!);
    expect(activate).toEqual({ sequence: 1n, controllerEpoch: 3n, cols: 120, rows: 40 });
    expect(new TextDecoder().decode(writtenInput.data)).toBe('x');

    stream.push(encodeControllerChanged({ epoch: 4n, isController: true }));
    stream.push(encodeActivated({
      sequence: 1n, controllerEpoch: 4n, geometryGeneration: 2n,
      presentationSequence: 5n, cols: 120, rows: 40,
    }));
    await expect(activating).resolves.toMatchObject({
      effective: { generation: 2, presentationSequence: 5, cols: 120, rows: 40 },
      controller: { epoch: 4, isController: true },
    });
    await input;
    expect(controllers).toEqual([
      { epoch: 3, isController: false },
      { epoch: 4, isController: true },
    ]);
  });

  it('retries a stale activation epoch without closing or reattaching the stream', async () => {
    const stream = new FakeStream();
    const errors: Error[] = [];
    const connecting = connectTerminalLive({
      openStream: async () => stream,
      attach: { sessionId: 's', connectionId: 'activity', attachGeneration: 1, cols: 46, rows: 16 },
      onError: error => errors.push(error),
    });
    await waitUntil(() => stream.writes.length === 1);
    stream.push(encodeAttached({
      presentationSequence: 4n, geometryGeneration: 1n, controllerEpoch: 3n,
      cols: 46, rows: 16, isController: false,
    }));
    const connection = await connecting;
    const activating = connection.activateWithEffectiveGeometry(120, 40);
    await waitUntil(() => stream.writes.length === 2);
    stream.push(encodeActivationRejected({ sequence: 1n, controllerEpoch: 4n, isController: false }));
    await waitUntil(() => stream.writes.length === 3);
    expect(decodeActivate(new TerminalLiveDecoder().push(stream.writes[2]!)[0]!)).toEqual({
      sequence: 2n, controllerEpoch: 4n, cols: 120, rows: 40,
    });
    stream.push(encodeActivated({
      sequence: 2n, controllerEpoch: 5n, geometryGeneration: 2n,
      presentationSequence: 5n, cols: 120, rows: 40,
    }));
    await expect(activating).resolves.toMatchObject({
      effective: { cols: 120, rows: 40 },
      controller: { epoch: 5, isController: true },
    });
    expect(errors).toEqual([]);
    expect(stream.writes).toHaveLength(3);
  });
});
