import { describe, expect, it } from 'vitest';

import {
  FRAME_HEADER_BYTES,
  MAX_INPUT_BYTES,
  TerminalLiveDecoder,
  TerminalLiveFrameType,
  decodeInput,
  encodeAttached,
  encodeInput,
  encodeGeometryChanged,
  encodeOutputBatch,
  encodeResizeApplied,
} from './codec.js';
import {
  MAX_QUEUED_INPUT_BYTES,
  TerminalLiveErrorCode,
  TerminalLiveServerError,
  connectTerminalLive,
  type TerminalByteStream,
} from './client.js';

class FakeStream implements TerminalByteStream {
  readonly writes: Uint8Array[] = [];
  private readonly reads: Array<Uint8Array | null> = [];
  private readonly waiters: Array<(value: Uint8Array | null) => void> = [];
  closed = false;

  async read(): Promise<Uint8Array | null> {
    if (this.reads.length > 0) return this.reads.shift() ?? null;
    return await new Promise(resolve => this.waiters.push(resolve));
  }

  async write(data: Uint8Array): Promise<void> {
    this.writes.push(data.slice());
  }

  async close(): Promise<void> {
    this.closed = true;
    this.push(null);
  }

  push(data: Uint8Array | null): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(data);
    else this.reads.push(data);
  }
}

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not reached');
};

const encodeServerError = (code: number, message: string): Uint8Array => {
  const text = new TextEncoder().encode(message);
  const encoded = new Uint8Array(FRAME_HEADER_BYTES + 4 + text.byteLength);
  const view = new DataView(encoded.buffer);
  encoded[0] = TerminalLiveFrameType.Error;
  view.setUint32(4, 4 + text.byteLength, false);
  view.setUint16(FRAME_HEADER_BYTES, code, false);
  view.setUint16(FRAME_HEADER_BYTES + 2, text.byteLength, false);
  encoded.set(text, FRAME_HEADER_BYTES + 4);
  return encoded;
};

const connect = async (
  stream: FakeStream,
  onOutputBatch: (records: ReadonlyArray<Readonly<{ sequence: bigint; data: Uint8Array }>>) => void = () => undefined,
  onGeometry: (geometry: Readonly<{ generation: number; cols: number; rows: number }>) => void = () => undefined,
) => {
  const promise = connectTerminalLive({
    openStream: async () => stream,
    attach: {
      sessionId: 'session',
      connectionId: 'connection',
      attachGeneration: 1,
      cols: 80,
      rows: 24,
    },
    onOutputBatch,
    onGeometry,
  });
  await waitUntil(() => stream.writes.length === 1);
  stream.push(encodeAttached({
    historyBoundarySequence: 4n,
    historyGeneration: 2n,
    historyStartSequence: 3n,
    geometryGeneration: 1n,
    cols: 80,
    rows: 24,
  }));
  return await promise;
};

describe('terminal live client', () => {
  it('preserves a structured server error during attach', async () => {
    const stream = new FakeStream();
    const connecting = connectTerminalLive({
      openStream: async () => stream,
      attach: { sessionId: 'missing', connectionId: 'connection', attachGeneration: 1, cols: 80, rows: 24 },
      onOutputBatch: () => undefined,
    });
    await waitUntil(() => stream.writes.length === 1);
    stream.push(encodeServerError(TerminalLiveErrorCode.SessionNotFound, 'terminal session not found'));

    await expect(connecting).rejects.toMatchObject({
      name: 'TerminalLiveServerError',
      code: TerminalLiveErrorCode.SessionNotFound,
      serverMessage: 'terminal session not found',
    } satisfies Partial<TerminalLiveServerError>);
  });

  it('reports an explicit session close separately from an unexpected stream end', async () => {
    const stream = new FakeStream();
    const closeReasons: string[] = [];
    const connecting = connectTerminalLive({
      openStream: async () => stream,
      attach: { sessionId: 'session', connectionId: 'connection', attachGeneration: 1, cols: 80, rows: 24 },
      onOutputBatch: () => undefined,
      onClosed: reason => closeReasons.push(reason),
    });
    await waitUntil(() => stream.writes.length === 1);
    stream.push(encodeAttached({
      historyBoundarySequence: 4n,
      historyGeneration: 1n,
      historyStartSequence: 3n,
      geometryGeneration: 1n,
      cols: 80,
      rows: 24,
    }));
    await connecting;
    const closed = new Uint8Array(FRAME_HEADER_BYTES);
    closed[0] = TerminalLiveFrameType.SessionClosed;
    stream.push(closed);
    await waitUntil(() => closeReasons.length === 1);
    expect(closeReasons).toEqual(['session_closed']);
  });

  it('attaches once and sends identical input once per call', async () => {
    const stream = new FakeStream();
    const connection = await connect(stream);
    expect(connection.attached).toEqual({
      historyBoundarySequence: 4,
      historyGeneration: 2,
      historyStartSequence: 3,
      geometryGeneration: 1,
      cols: 80,
      rows: 24,
    });

    await connection.sendInput(new Uint8Array([0x78]));
    await connection.sendInput(new Uint8Array([0x78]));
    const decoder = new TerminalLiveDecoder();
    const inputs = stream.writes.slice(1).flatMap(write => decoder.push(write)).map(decodeInput);
    expect(inputs.map(input => Number(input.sequence))).toEqual([1, 2]);
    expect(inputs.map(input => new TextDecoder().decode(input.data))).toEqual(['x', 'x']);
  });

  it('splits a large paste into ordered 64 KiB input frames without changing any byte', async () => {
    const stream = new FakeStream();
    const connection = await connect(stream);
    const payload = new Uint8Array(MAX_INPUT_BYTES * 3 + 17);
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31 + 7) & 0xff;

    await connection.sendInput(payload);

    const decoder = new TerminalLiveDecoder();
    const inputs = stream.writes.slice(1).flatMap(write => decoder.push(write)).map(decodeInput);
    expect(inputs.map(input => Number(input.sequence))).toEqual([1, 2, 3, 4]);
    expect(inputs.map(input => input.data.byteLength)).toEqual([
      MAX_INPUT_BYTES,
      MAX_INPUT_BYTES,
      MAX_INPUT_BYTES,
      17,
    ]);
    const reassembled = new Uint8Array(inputs.reduce((total, input) => total + input.data.byteLength, 0));
    let offset = 0;
    for (const input of inputs) {
      reassembled.set(input.data, offset);
      offset += input.data.byteLength;
    }
    expect(reassembled).toEqual(payload);
  });

  it('decodes fragmented output batches in sequence order', async () => {
    const stream = new FakeStream();
    const batches: Array<Array<[number, string]>> = [];
    const order: string[] = [];
    await connect(stream, records => {
      order.push('output');
      batches.push(records.map(record => [
        Number(record.sequence),
        new TextDecoder().decode(record.data),
      ]));
    }, geometry => order.push(`geometry:${geometry.generation}:${geometry.cols}x${geometry.rows}`));
    order.length = 0;
    const encoded = encodeOutputBatch({ geometryGeneration: 2n, cols: 100, rows: 30, records: [
      { sequence: 5n, timestampMs: 10n, data: new TextEncoder().encode('a') },
      { sequence: 6n, timestampMs: 11n, data: new TextEncoder().encode('b') },
    ] });
    stream.push(encoded.subarray(0, 7));
    stream.push(encoded.subarray(7));
    await waitUntil(() => batches.length === 1);
    expect(batches).toEqual([[[5, 'a'], [6, 'b']]]);
    expect(order).toEqual(['geometry:2:100x30', 'output']);
  });

  it('closes the live stream immediately when output sequence continuity is broken', async () => {
    const stream = new FakeStream();
    const errors: Error[] = [];
    const connecting = connectTerminalLive({
      openStream: async () => stream,
      attach: {
        sessionId: 'session',
        connectionId: 'connection',
        attachGeneration: 1,
        cols: 80,
        rows: 24,
      },
      onOutputBatch: () => undefined,
      onError: error => errors.push(error),
    });
    await waitUntil(() => stream.writes.length === 1);
    stream.push(encodeAttached({
      historyBoundarySequence: 4n,
      historyGeneration: 2n,
      historyStartSequence: 3n,
      geometryGeneration: 1n,
      cols: 80,
      rows: 24,
    }));
    await connecting;

    stream.push(encodeOutputBatch({ geometryGeneration: 1n, cols: 80, rows: 24, records: [
      { sequence: 6n, timestampMs: 10n, data: new TextEncoder().encode('gap') },
    ] }));

    await waitUntil(() => errors.length === 1);
    expect(errors[0]?.message).toMatch(/expected output sequence 5, received 6/i);
    expect(stream.closed).toBe(true);
  });

  it('resolves resize only after the matching acknowledgement', async () => {
    const stream = new FakeStream();
    const geometries: Array<Readonly<{ generation: number; cols: number; rows: number }>> = [];
    const connection = await connect(stream, () => undefined, geometry => geometries.push(geometry));
    let settled = false;
    const resized = connection.resize(120, 40).then(() => { settled = true; });
    await waitUntil(() => stream.writes.length === 2);
    expect(settled).toBe(false);
    stream.push(encodeResizeApplied({ sequence: 1n, geometryGeneration: 2n, outputSequenceBoundary: 4n, cols: 100, rows: 30 }));
    await resized;
    expect(settled).toBe(true);
    expect(geometries[geometries.length - 1]).toEqual({
      generation: 2,
      outputSequenceBoundary: 4,
      cols: 100,
      rows: 30,
    });
  });

  it('applies unsolicited geometry changes without waiting for output', async () => {
    const stream = new FakeStream();
    const geometries: Array<Readonly<{ generation: number; cols: number; rows: number }>> = [];
    await connect(stream, () => undefined, geometry => geometries.push(geometry));
    stream.push(encodeGeometryChanged({ generation: 2n, outputSequenceBoundary: 4n, cols: 70, rows: 20 }));
    await waitUntil(() => geometries.length === 2);
    expect(geometries).toEqual([
      { generation: 1, outputSequenceBoundary: 4, cols: 80, rows: 24 },
      { generation: 2, outputSequenceBoundary: 4, cols: 70, rows: 20 },
    ]);
  });

  it('defers resize geometry until output through its exact sequence boundary is processed', async () => {
    const stream = new FakeStream();
    const order: string[] = [];
    const connection = await connect(stream, records => {
      order.push(`output:${records.map(record => record.sequence).join(',')}`);
    }, geometry => order.push(`geometry:${geometry.generation}:${geometry.cols}x${geometry.rows}`));
    order.length = 0;

    let resizeSettled = false;
    const resizing = connection.resize(100, 30).then(() => { resizeSettled = true; });
    await waitUntil(() => stream.writes.length === 2);
    stream.push(encodeResizeApplied({
      sequence: 1n,
      geometryGeneration: 2n,
      outputSequenceBoundary: 5n,
      cols: 100,
      rows: 30,
    }));
    await Promise.resolve();
    expect(resizeSettled).toBe(false);
    expect(order).toEqual([]);

    stream.push(encodeOutputBatch({ geometryGeneration: 1n, cols: 80, rows: 24, records: [
      { sequence: 5n, timestampMs: 10n, data: new TextEncoder().encode('before-resize') },
    ] }));
    await resizing;
    expect(order).toEqual(['output:5', 'geometry:2:100x30']);
  });

  it('rejects input above the explicit queue limit', async () => {
    const stream = new FakeStream();
    const connection = await connect(stream);
    await expect(connection.sendInput(new Uint8Array(MAX_QUEUED_INPUT_BYTES + 1))).rejects.toThrow(/queue/i);
    expect(stream.writes).toHaveLength(1);
  });

  it('rejects a server frame that is invalid for the current direction', async () => {
    const stream = new FakeStream();
    const errors: Error[] = [];
    const connecting = connectTerminalLive({
      openStream: async () => stream,
      attach: { sessionId: 'session', connectionId: 'connection', attachGeneration: 1, cols: 80, rows: 24 },
      onOutputBatch: () => undefined,
      onError: error => errors.push(error),
    });
    await waitUntil(() => stream.writes.length === 1);
    stream.push(encodeInput({ sequence: 1n, data: new Uint8Array([0x78]) }));
    await expect(connecting).rejects.toThrow(/server frame/i);
    expect(errors).toHaveLength(1);
  });
});
