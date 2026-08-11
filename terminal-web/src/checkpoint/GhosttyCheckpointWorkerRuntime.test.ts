import { describe, expect, it, vi } from 'vitest';
import { GhosttyCheckpointWorkerRuntime } from './GhosttyCheckpointWorkerRuntime';

const bytes = (value: string) => new TextEncoder().encode(value);

describe('GhosttyCheckpointWorkerRuntime', () => {
  it('serializes initialize, append, and self-verified capture messages', async () => {
    const checkpoint = {
      formatVersion: 1,
      engineId: 'floegence-ghostty-web' as const,
      coveredThroughSequence: 2,
      geometryGeneration: 1,
      parserEpoch: 7,
      cols: 80,
      rows: 24,
      checksumSha256: '1'.repeat(64),
      stateDigestSha256: '2'.repeat(64),
      bytes: bytes('checkpoint'),
    };
    const engine = {
      append: vi.fn(() => ({ throughSequence: 2, releasedBytes: 6 })),
      capture: vi.fn().mockResolvedValue(checkpoint),
      dispose: vi.fn(),
    };
    const postMessage = vi.fn();
    const runtime = new GhosttyCheckpointWorkerRuntime({
      loadRuntime: vi.fn().mockResolvedValue({}),
      createEngine: vi.fn(() => engine),
      postMessage,
    });

    await runtime.handle({ type: 'initialize', cols: 80, rows: 24, parserEpoch: 7 });
    await runtime.handle({
      type: 'append',
      chunks: [
        { sequence: 1, data: bytes('one'), geometryGeneration: 1, cols: 80, rows: 24 },
        { sequence: 2, data: bytes('two'), geometryGeneration: 1, cols: 80, rows: 24 },
      ],
    });
    await runtime.handle({ type: 'capture', requestId: 5, targetSequence: 2 });

    expect(postMessage.mock.calls).toEqual([
      [{ type: 'ready', parserEpoch: 7, historySequence: 0 }, undefined],
      [{ type: 'applied', throughSequence: 2, releasedBytes: 6 }, undefined],
      [expect.objectContaining({ type: 'checkpoint', requestId: 5, historySequence: 2 }), [checkpoint.bytes.buffer]],
    ]);
    runtime.dispose();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects a restored checkpoint whose whole-blob checksum does not match', async () => {
    const createEngine = vi.fn();
    const postMessage = vi.fn();
    const runtime = new GhosttyCheckpointWorkerRuntime({
      loadRuntime: vi.fn().mockResolvedValue({}),
      createEngine,
      postMessage,
    });

    await runtime.handle({
      type: 'initialize',
      cols: 80,
      rows: 24,
      parserEpoch: 7,
      checkpoint: {
        formatVersion: 1,
        engineId: 'floegence-ghostty-web',
        coveredThroughSequence: 2,
        geometryGeneration: 1,
        parserEpoch: 7,
        cols: 80,
        rows: 24,
        checksumSha256: '0'.repeat(64),
        stateDigestSha256: '2'.repeat(64),
        bytes: bytes('corrupt'),
      },
    });

    expect(createEngine).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: expect.stringMatching(/checksum mismatch/i),
    }), undefined);
    await runtime.handle({ type: 'capture', requestId: 1, targetSequence: 2 });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
