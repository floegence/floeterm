import { describe, expect, it, vi } from 'vitest';
import { GhosttyCheckpointEngine } from './GhosttyCheckpointEngine';

const encoder = new TextEncoder();

const createTerminal = (digest = 'a'.repeat(64)) => ({
  cols: 80,
  rows: 24,
  write: vi.fn(),
  resize: vi.fn(function resize(this: { cols: number; rows: number }, cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }),
  getCheckpointFormatVersion: vi.fn(() => 1),
  captureCheckpoint: vi.fn((coordinates: { historySequence: bigint; geometryGeneration: bigint; parserEpoch: bigint }) => ({
    bytes: encoder.encode('checkpoint'),
    metadata: {
      formatVersion: 1,
      cols: 100,
      rows: 30,
      uncompressedLength: 10,
      checksum: 'internal',
      ...coordinates,
    },
  })),
  validateCheckpoint: vi.fn((_: Uint8Array) => ({
    formatVersion: 1,
    cols: 100,
    rows: 30,
    uncompressedLength: 10,
    checksum: 'internal',
    historySequence: 2n,
    geometryGeneration: 2n,
    parserEpoch: 7n,
  })),
  restoreCheckpoint: vi.fn(),
  getStateDigest: vi.fn(() => digest),
  free: vi.fn(),
});

describe('GhosttyCheckpointEngine', () => {
  it('captures and self-restores the exact sequence and geometry with the same engine', async () => {
    const live = createTerminal();
    const verifier = createTerminal();
    const runtime = { createTerminal: vi.fn().mockReturnValueOnce(live).mockReturnValueOnce(verifier) };
    const engine = new GhosttyCheckpointEngine(runtime, { cols: 80, rows: 24, parserEpoch: 7 });

    expect(engine.append([
      { sequence: 1, data: encoder.encode('one'), geometryGeneration: 1, cols: 80, rows: 24 },
      { sequence: 2, data: encoder.encode('two'), geometryGeneration: 2, cols: 100, rows: 30 },
    ])).toEqual({ throughSequence: 2, releasedBytes: 6 });
    const checkpoint = await engine.capture(2);

    expect(live.resize).toHaveBeenCalledWith(100, 30);
    expect(live.write.mock.calls).toEqual([
      [encoder.encode('one')],
      [encoder.encode('two')],
    ]);
    expect(live.captureCheckpoint).toHaveBeenCalledWith({
      historySequence: 2n,
      geometryGeneration: 2n,
      parserEpoch: 7n,
    });
    expect(verifier.restoreCheckpoint).toHaveBeenCalledWith(
      encoder.encode('checkpoint'),
      { historySequence: 2n, geometryGeneration: 2n, parserEpoch: 7n },
    );
    expect(checkpoint).toMatchObject({
      formatVersion: 1,
      coveredThroughSequence: 2,
      geometryGeneration: 2,
      parserEpoch: 7,
      cols: 100,
      rows: 30,
      stateDigestSha256: 'a'.repeat(64),
    });
    expect(checkpoint.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifier.free).toHaveBeenCalledTimes(1);
    engine.dispose();
    expect(live.free).toHaveBeenCalledTimes(1);
  });

  it('fails closed when self-restore produces a different state digest', async () => {
    const live = createTerminal('a'.repeat(64));
    const verifier = createTerminal('b'.repeat(64));
    const runtime = { createTerminal: vi.fn().mockReturnValueOnce(live).mockReturnValueOnce(verifier) };
    const engine = new GhosttyCheckpointEngine(runtime, { cols: 80, rows: 24, parserEpoch: 7 });
    engine.append([
      { sequence: 1, data: encoder.encode('one'), geometryGeneration: 1, cols: 80, rows: 24 },
      { sequence: 2, data: encoder.encode('two'), geometryGeneration: 2, cols: 100, rows: 30 },
    ]);

    await expect(engine.capture(2)).rejects.toThrow(/self-restore state digest mismatch/i);
    expect(verifier.free).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it('restores an existing checkpoint before accepting deltas', () => {
    const restored = createTerminal('c'.repeat(64));
    restored.validateCheckpoint.mockReturnValue({
      formatVersion: 1,
      cols: 100,
      rows: 30,
      uncompressedLength: 10,
      checksum: 'internal',
      historySequence: 8n,
      geometryGeneration: 4n,
      parserEpoch: 9n,
    });
    const runtime = { createTerminal: vi.fn(() => restored) };
    const engine = new GhosttyCheckpointEngine(runtime, {
      cols: 100,
      rows: 30,
      parserEpoch: 9,
      checkpoint: {
        formatVersion: 1,
        engineId: 'floegence-ghostty-web',
        coveredThroughSequence: 8,
        geometryGeneration: 4,
        parserEpoch: 9,
        cols: 100,
        rows: 30,
        checksumSha256: '1'.repeat(64),
        stateDigestSha256: 'c'.repeat(64),
        bytes: encoder.encode('existing'),
      },
    });

    expect(restored.restoreCheckpoint).toHaveBeenCalledWith(
      encoder.encode('existing'),
      { historySequence: 8n, geometryGeneration: 4n, parserEpoch: 9n },
    );
    expect(() => engine.append([
      { sequence: 10, data: encoder.encode('gap'), geometryGeneration: 4, cols: 100, rows: 30 },
    ])).toThrow(/sequence gap/i);
    engine.dispose();
  });
});
