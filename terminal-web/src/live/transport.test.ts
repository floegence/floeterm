import { describe, expect, it, vi } from 'vitest';

import {
  TerminalLiveDecoder,
  TerminalLiveFrameType,
  decodeAttach,
  decodeInput,
  decodeResize,
  encodeAttached,
  encodeOutputBatch,
  encodeResizeApplied,
} from './codec.js';
import type { TerminalByteStream } from './client.js';
import { createTerminalLiveTransport } from './transport.js';

class FakeStream implements TerminalByteStream {
  readonly writes: Uint8Array[] = [];
  readonly resets: Error[] = [];
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
    if (this.closed) return;
    this.closed = true;
    this.push(null);
  }

  async reset(error?: Error): Promise<void> {
    if (error) this.resets.push(error);
    await this.close();
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

const decodeSingleWrite = (data: Uint8Array) => {
  const frames = new TerminalLiveDecoder().push(data);
  expect(frames).toHaveLength(1);
  return frames[0]!;
};

const createHarness = () => {
  const streams: FakeStream[] = [];
  const control = {
    history: vi.fn(async () => []),
    historyPage: vi.fn(async () => ({
      chunks: [],
      firstRetainedSequence: 0,
      nextStartSequence: 0,
      hasMore: false,
      coveredThroughSequence: 0,
      snapshotEndSequence: 0,
      historyGeneration: 1,
      historyReset: false,
      historyTruncated: false,
      totalBytes: 0,
    })),
    clear: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({
      id: 'created',
      name: 'created',
      workingDir: '/',
      createdAtMs: 1,
      lastActiveAtMs: 1,
      isActive: false,
    })),
    deleteSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
  };
  const bundle = createTerminalLiveTransport({
    connectionId: 'connection',
    openStream: async () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
    control,
  });
  return { ...bundle, control, streams };
};

const acknowledgeAttach = async (stream: FakeStream, boundary = 4n, generation = 2n): Promise<void> => {
  await waitUntil(() => stream.writes.length === 1);
  stream.push(encodeAttached({
    historyBoundarySequence: boundary,
    historyGeneration: generation,
    historyStartSequence: boundary === 4n ? 3n : 1n,
    geometryGeneration: 1n,
    cols: 80,
    rows: 24,
  }));
};

describe('terminal live transport', () => {
  it('opens one live_v1 stream and forwards input and acknowledged resize', async () => {
    const { transport, streams } = createHarness();
    const attaching = transport.attachWithHistoryBoundary('session', 80, 24);
    await waitUntil(() => streams.length === 1);
    const stream = streams[0]!;
    await acknowledgeAttach(stream);
    await expect(attaching).resolves.toEqual({
      runtimeAttachGeneration: 1,
      historyBoundarySequence: 4,
      historyGeneration: 2,
      historyStartSequence: 3,
      geometryGeneration: 1,
      cols: 80,
      rows: 24,
    });

    const attach = decodeAttach(decodeSingleWrite(stream.writes[0]!));
    expect(attach).toEqual({
      sessionId: 'session',
      connectionId: 'connection',
      attachGeneration: 1n,
      cols: 80,
      rows: 24,
    });

    await transport.sendInput('session', 'xx');
    const input = decodeInput(decodeSingleWrite(stream.writes[1]!));
    expect(input.sequence).toBe(1n);
    expect(new TextDecoder().decode(input.data)).toBe('xx');

    const resizing = transport.resize('session', 120, 40);
    await waitUntil(() => stream.writes.length === 3);
    const resize = decodeResize(decodeSingleWrite(stream.writes[2]!));
    expect(resize).toEqual({ sequence: 1n, cols: 120, rows: 40 });
    let settled = false;
    void resizing.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    stream.push(encodeResizeApplied({ sequence: resize.sequence, geometryGeneration: 2n, outputSequenceBoundary: 4n, cols: 100, rows: 30 }));
    await resizing;
  });

  it('emits exact ordered output metadata with the live protocol batch boundary', async () => {
    const { transport, eventSource, streams } = createHarness();
    const events: unknown[] = [];
    const geometries: unknown[] = [];
    eventSource.onTerminalData('session', event => events.push(event));
    eventSource.onTerminalGeometry?.('session', event => geometries.push(event));
    const attaching = transport.attach('session', 80, 24);
    await waitUntil(() => streams.length === 1);
    const stream = streams[0]!;
    await acknowledgeAttach(stream);
    await attaching;

    stream.push(encodeOutputBatch({ geometryGeneration: 2n, cols: 100, rows: 30, records: [
      { sequence: 5n, timestampMs: 10n, data: new Uint8Array([0x78]) },
      { sequence: 6n, timestampMs: 11n, data: new Uint8Array([0x79]) },
    ] }));
    await waitUntil(() => events.length === 2);
    expect(events).toEqual([
      {
        sessionId: 'session',
        type: 'data',
        data: new Uint8Array([0x78]),
        sequence: 5,
        timestampMs: 10,
        liveBatchSize: 2,
      },
      {
        sessionId: 'session',
        type: 'data',
        data: new Uint8Array([0x79]),
        sequence: 6,
        timestampMs: 11,
        liveBatchSize: 2,
      },
    ]);
    expect(geometries).toEqual([
      { sessionId: 'session', generation: 1, outputSequenceBoundary: 4, cols: 80, rows: 24 },
      { sessionId: 'session', generation: 2, outputSequenceBoundary: 4, cols: 100, rows: 30 },
    ]);
  });

  it('supersedes an older attach and increments the attach generation', async () => {
    const { transport, streams } = createHarness();
    const firstAttach = transport.attach('session', 80, 24);
    await waitUntil(() => streams.length === 1);
    await acknowledgeAttach(streams[0]!);
    await firstAttach;

    const secondAttach = transport.attach('session', 100, 30);
    await waitUntil(() => streams.length === 2);
    expect(streams[0]!.closed).toBe(true);
    await acknowledgeAttach(streams[1]!, 7n, 3n);
    await secondAttach;
    const second = decodeAttach(decodeSingleWrite(streams[1]!.writes[0]!));
    expect(second.attachGeneration).toBe(2n);
  });

  it('closes attached streams when the connection epoch changes', async () => {
    const { transport, streams } = createHarness();
    transport.syncConnectionEpoch({ id: 1 });
    const attaching = transport.attach('session', 80, 24);
    await waitUntil(() => streams.length === 1);
    await acknowledgeAttach(streams[0]!);
    await attaching;

    const sameEpoch = { id: 2 };
    transport.syncConnectionEpoch(sameEpoch);
    expect(streams[0]!.closed).toBe(true);

    const nextAttach = transport.attach('session', 80, 24);
    await waitUntil(() => streams.length === 2);
    await acknowledgeAttach(streams[1]!);
    await nextAttach;
    transport.syncConnectionEpoch(sameEpoch);
    expect(streams[1]!.closed).toBe(false);
  });

  it('delegates control-plane operations and emits session deletion', async () => {
    const { transport, eventSource, control } = createHarness();
    let deleted = 0;
    eventSource.onSessionDeleted?.('session', () => { deleted += 1; });

    await transport.clear('session');
    await transport.renameSession?.('session', 'renamed');
    await transport.deleteSession?.('session');

    expect(control.clear).toHaveBeenCalledWith('session');
    expect(control.renameSession).toHaveBeenCalledWith('session', 'renamed');
    expect(control.deleteSession).toHaveBeenCalledWith('session');
    expect(deleted).toBe(1);
  });

  it('reports an unexpected stream end as an explicit terminal error', async () => {
    const { transport, eventSource, streams } = createHarness();
    const events: Array<{ type?: string; error?: string }> = [];
    eventSource.onTerminalData('session', event => events.push(event));
    const attaching = transport.attach('session', 80, 24);
    await waitUntil(() => streams.length === 1);
    await acknowledgeAttach(streams[0]!);
    await attaching;

    streams[0]!.push(null);
    await waitUntil(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: 'error', error: 'terminal live stream closed' });
  });

  it('emits session deletion without a transport error for SESSION_CLOSED', async () => {
    const { transport, eventSource, streams } = createHarness();
    const events: Array<{ type?: string; error?: string }> = [];
    let deleted = 0;
    eventSource.onTerminalData('session', event => events.push(event));
    eventSource.onSessionDeleted?.('session', () => { deleted += 1; });
    const attaching = transport.attach('session', 80, 24);
    await waitUntil(() => streams.length === 1);
    await acknowledgeAttach(streams[0]!);
    await attaching;

    const closed = new Uint8Array(8);
    closed[0] = TerminalLiveFrameType.SessionClosed;
    streams[0]!.push(closed);
    await waitUntil(() => deleted === 1);
    expect(events).toEqual([]);
  });

  it('rejects server frames that are invalid after attach without switching transports', async () => {
    const { transport, eventSource, streams } = createHarness();
    const events: Array<{ type?: string; error?: string }> = [];
    eventSource.onTerminalData('session', event => events.push(event));
    const attaching = transport.attach('session', 80, 24);
    await waitUntil(() => streams.length === 1);
    await acknowledgeAttach(streams[0]!);
    await attaching;

    const invalid = new Uint8Array(8);
    invalid[0] = TerminalLiveFrameType.Input;
    streams[0]!.push(invalid);
    await waitUntil(() => events.length === 1);
    expect(events[0]?.error).toMatch(/invalid terminal live server frame/i);
    expect(streams[0]!.resets).toHaveLength(1);
  });
});
