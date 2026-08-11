import { describe, expect, it, vi } from 'vitest';
import {
  createGhosttyCheckpointActor,
  type GhosttyCheckpointWorkerLike,
} from './GhosttyCheckpointActor';

class FakeWorker implements GhosttyCheckpointWorkerLike {
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  private readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>();

  addEventListener(type: 'message' | 'error', listener: EventListener): void {
    if (type === 'message') this.messageListeners.add(listener as (event: MessageEvent<unknown>) => void);
    else this.errorListeners.add(listener as (event: ErrorEvent) => void);
  }

  removeEventListener(type: 'message' | 'error', listener: EventListener): void {
    if (type === 'message') this.messageListeners.delete(listener as (event: MessageEvent<unknown>) => void);
    else this.errorListeners.delete(listener as (event: ErrorEvent) => void);
  }

  emitMessage(data: unknown): void {
    for (const listener of this.messageListeners) listener({ data } as MessageEvent<unknown>);
  }

  emitError(message: string): void {
    for (const listener of this.errorListeners) listener({ message } as ErrorEvent);
  }
}

const bytes = (value: string) => new TextEncoder().encode(value);

describe('GhosttyCheckpointActor', () => {
  it('publishes a self-verified checkpoint only for the exact queued sequence and geometry', async () => {
    const worker = new FakeWorker();
    const actor = createGhosttyCheckpointActor({
      createWorker: () => worker,
      maxQueuedBytes: 1024,
    });
    const starting = actor.start({ cols: 80, rows: 24, parserEpoch: 7 });
    worker.emitMessage({ type: 'ready', parserEpoch: 7, historySequence: 0 });
    await starting;

    const first = bytes('one');
    actor.append([
      { sequence: 1, data: first, geometryGeneration: 1, cols: 80, rows: 24 },
      { sequence: 2, data: bytes('two'), geometryGeneration: 2, cols: 100, rows: 30 },
    ]);
    first[0] = 0;
    expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'append',
      chunks: [
        expect.objectContaining({ sequence: 1, data: bytes('one') }),
        expect.objectContaining({ sequence: 2, geometryGeneration: 2, cols: 100, rows: 30 }),
      ],
    }), expect.any(Array));
    worker.emitMessage({ type: 'applied', throughSequence: 2, releasedBytes: 6 });

    const capturing = actor.capture(2);
    const checkpointBytes = bytes('opaque-checkpoint');
    worker.emitMessage({
      type: 'checkpoint',
      requestId: 1,
      formatVersion: 1,
      historySequence: 2,
      geometryGeneration: 2,
      parserEpoch: 7,
      cols: 100,
      rows: 30,
      checksumSha256: '1'.repeat(64),
      stateDigestSha256: '2'.repeat(64),
      bytes: checkpointBytes,
    });
    const checkpoint = await capturing;
    checkpointBytes[0] = 0;

    expect(checkpoint).toMatchObject({
      formatVersion: 1,
      engineId: 'floegence-ghostty-web',
      coveredThroughSequence: 2,
      geometryGeneration: 2,
      parserEpoch: 7,
      cols: 100,
      rows: 30,
      checksumSha256: '1'.repeat(64),
      stateDigestSha256: '2'.repeat(64),
    });
    expect(new TextDecoder().decode(checkpoint.bytes)).toBe('opaque-checkpoint');
    expect(actor.getSnapshot()).toMatchObject({
      state: 'ready',
      queuedThroughSequence: 2,
      appliedThroughSequence: 2,
      queuedBytes: 0,
    });
    actor.dispose();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects sequence gaps and conflicting dimensions before posting output', async () => {
    const worker = new FakeWorker();
    const actor = createGhosttyCheckpointActor({ createWorker: () => worker, maxQueuedBytes: 1024 });
    const starting = actor.start({ cols: 80, rows: 24, parserEpoch: 1 });
    worker.emitMessage({ type: 'ready', parserEpoch: 1, historySequence: 0 });
    await starting;

    expect(() => actor.append([
      { sequence: 2, data: bytes('gap'), geometryGeneration: 1, cols: 80, rows: 24 },
    ])).toThrow(/sequence gap/i);
    actor.append([
      { sequence: 1, data: bytes('one'), geometryGeneration: 1, cols: 80, rows: 24 },
    ]);
    expect(() => actor.append([
      { sequence: 2, data: bytes('two'), geometryGeneration: 1, cols: 100, rows: 30 },
    ])).toThrow(/geometry generation.*dimensions/i);
    actor.dispose();
  });

  it('fails closed on stale checkpoint results and worker errors', async () => {
    const worker = new FakeWorker();
    const actor = createGhosttyCheckpointActor({ createWorker: () => worker, maxQueuedBytes: 1024 });
    const starting = actor.start({ cols: 80, rows: 24, parserEpoch: 3 });
    worker.emitMessage({ type: 'ready', parserEpoch: 3, historySequence: 0 });
    await starting;
    actor.append([{ sequence: 1, data: bytes('one'), geometryGeneration: 1, cols: 80, rows: 24 }]);

    const capture = actor.capture(1);
    worker.emitMessage({
      type: 'checkpoint',
      requestId: 1,
      formatVersion: 1,
      historySequence: 0,
      geometryGeneration: 1,
      parserEpoch: 3,
      cols: 80,
      rows: 24,
      checksumSha256: '1'.repeat(64),
      stateDigestSha256: '2'.repeat(64),
      bytes: bytes('stale'),
    });
    await expect(capture).rejects.toThrow(/stale checkpoint sequence/i);
    expect(actor.getSnapshot().state).toBe('failed');
    actor.dispose();

    const crashingWorker = new FakeWorker();
    const crashingActor = createGhosttyCheckpointActor({ createWorker: () => crashingWorker });
    const crashed = crashingActor.start({ cols: 80, rows: 24, parserEpoch: 4 });
    crashingWorker.emitError('worker crashed');
    await expect(crashed).rejects.toThrow(/worker crashed/i);
    expect(crashingActor.getSnapshot().state).toBe('failed');
    crashingActor.dispose();
  });
});
