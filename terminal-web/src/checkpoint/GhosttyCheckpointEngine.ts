import type {
  GhosttyAuthoritativeCheckpoint,
  GhosttyCheckpointChunk,
} from './GhosttyCheckpointActor';

interface GhosttyCheckpointMetadata {
  formatVersion: number;
  cols: number;
  rows: number;
  historySequence: bigint;
  geometryGeneration: bigint;
  parserEpoch: bigint;
}

interface GhosttyCheckpointTerminal {
  readonly cols: number;
  readonly rows: number;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  captureCheckpoint(coordinates?: {
    historySequence: bigint;
    geometryGeneration: bigint;
    parserEpoch: bigint;
  }): { bytes: Uint8Array; metadata: GhosttyCheckpointMetadata };
  validateCheckpoint(bytes: Uint8Array): GhosttyCheckpointMetadata;
  restoreCheckpoint(bytes: Uint8Array, expectedCoordinates?: {
    historySequence: bigint;
    geometryGeneration: bigint;
    parserEpoch: bigint;
  }): void;
  getStateDigest(): string;
  free(): void;
}

export interface GhosttyCheckpointRuntimeLike {
  createTerminal(cols: number, rows: number): GhosttyCheckpointTerminal;
}

export interface GhosttyCheckpointEngineOptions {
  cols: number;
  rows: number;
  parserEpoch: number;
  initialSequence?: number;
  checkpoint?: GhosttyAuthoritativeCheckpoint;
}

export interface GhosttyCheckpointEngineAppendResult {
  throughSequence: number;
  releasedBytes: number;
}

const toBigInt = (value: number, field: string): bigint => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return BigInt(value);
};

const assertDigest = (value: string, field: string): void => {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${field} must be lowercase SHA-256`);
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const assertMetadataMatches = (
  metadata: GhosttyCheckpointMetadata,
  checkpoint: GhosttyAuthoritativeCheckpoint,
): void => {
  if (
    metadata.formatVersion !== checkpoint.formatVersion
    || metadata.cols !== checkpoint.cols
    || metadata.rows !== checkpoint.rows
    || metadata.historySequence !== BigInt(checkpoint.coveredThroughSequence)
    || metadata.geometryGeneration !== BigInt(checkpoint.geometryGeneration)
    || metadata.parserEpoch !== BigInt(checkpoint.parserEpoch)
  ) {
    throw new Error('checkpoint metadata does not match its requested coordinates');
  }
};

export class GhosttyCheckpointEngine {
  private readonly runtime: GhosttyCheckpointRuntimeLike;
  private readonly parserEpoch: number;
  private terminal: GhosttyCheckpointTerminal;
  private queuedThroughSequence: number;
  private geometryGeneration: number;
  private cols: number;
  private rows: number;
  private disposed = false;

  constructor(runtime: GhosttyCheckpointRuntimeLike, options: GhosttyCheckpointEngineOptions) {
    if (!Number.isSafeInteger(options.parserEpoch) || options.parserEpoch <= 0) {
      throw new Error('checkpoint parser epoch must be positive');
    }
    if (!Number.isSafeInteger(options.cols) || options.cols <= 0 || !Number.isSafeInteger(options.rows) || options.rows <= 0) {
      throw new Error('checkpoint engine dimensions must be positive safe integers');
    }
    if (!Number.isSafeInteger(options.initialSequence ?? 0) || (options.initialSequence ?? 0) < 0) {
      throw new Error('checkpoint engine initial sequence must be a non-negative safe integer');
    }
    if (options.checkpoint && options.initialSequence !== undefined) {
      throw new Error('checkpoint and initial sequence are mutually exclusive');
    }
    this.runtime = runtime;
    this.parserEpoch = options.parserEpoch;
    this.terminal = runtime.createTerminal(options.checkpoint?.cols ?? options.cols, options.checkpoint?.rows ?? options.rows);
    this.queuedThroughSequence = options.checkpoint?.coveredThroughSequence ?? options.initialSequence ?? 0;
    this.geometryGeneration = options.checkpoint?.geometryGeneration ?? 0;
    this.cols = options.checkpoint?.cols ?? options.cols;
    this.rows = options.checkpoint?.rows ?? options.rows;
    if (options.checkpoint) {
      assertDigest(options.checkpoint.stateDigestSha256, 'checkpoint state digest');
      const coordinates = {
        historySequence: toBigInt(options.checkpoint.coveredThroughSequence, 'checkpoint history sequence'),
        geometryGeneration: toBigInt(options.checkpoint.geometryGeneration, 'checkpoint geometry generation'),
        parserEpoch: toBigInt(options.checkpoint.parserEpoch, 'checkpoint parser epoch'),
      };
      const metadata = this.terminal.validateCheckpoint(options.checkpoint.bytes);
      assertMetadataMatches(metadata, options.checkpoint);
      this.terminal.restoreCheckpoint(options.checkpoint.bytes.slice(), coordinates);
      if (this.terminal.getStateDigest() !== options.checkpoint.stateDigestSha256) {
        throw new Error('checkpoint restore state digest mismatch');
      }
    }
  }

  append(chunks: readonly GhosttyCheckpointChunk[]): GhosttyCheckpointEngineAppendResult {
    this.assertLive();
    let sequence = this.queuedThroughSequence;
    let geometryGeneration = this.geometryGeneration;
    let cols = this.cols;
    let rows = this.rows;
    let releasedBytes = 0;
    for (const chunk of chunks) {
      if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence !== sequence + 1) {
        throw new Error(`checkpoint engine sequence gap: got ${chunk.sequence}, want ${sequence + 1}`);
      }
      if (!Number.isSafeInteger(chunk.geometryGeneration) || chunk.geometryGeneration <= 0) {
        throw new Error('checkpoint engine geometry generation is invalid');
      }
      if (chunk.geometryGeneration < geometryGeneration) {
        throw new Error('checkpoint engine geometry generation moved backwards');
      }
      if (chunk.geometryGeneration === geometryGeneration && geometryGeneration > 0 && (chunk.cols !== cols || chunk.rows !== rows)) {
        throw new Error('checkpoint engine geometry generation has conflicting dimensions');
      }
      if (chunk.geometryGeneration > geometryGeneration) {
        if (!Number.isSafeInteger(chunk.cols) || chunk.cols <= 0 || !Number.isSafeInteger(chunk.rows) || chunk.rows <= 0) {
          throw new Error('checkpoint engine geometry dimensions are invalid');
        }
        geometryGeneration = chunk.geometryGeneration;
        cols = chunk.cols;
        rows = chunk.rows;
        this.terminal.resize(cols, rows);
      }
      if (chunk.data.byteLength === 0) throw new Error('checkpoint engine output chunk is empty');
      this.terminal.write(chunk.data.slice());
      sequence = chunk.sequence;
      releasedBytes += chunk.data.byteLength;
    }
    this.queuedThroughSequence = sequence;
    this.geometryGeneration = geometryGeneration;
    this.cols = cols;
    this.rows = rows;
    return { throughSequence: sequence, releasedBytes };
  }

  async capture(targetSequence: number): Promise<GhosttyAuthoritativeCheckpoint> {
    this.assertLive();
    if (!Number.isSafeInteger(targetSequence) || targetSequence <= 0 || targetSequence !== this.queuedThroughSequence) {
      throw new Error(`checkpoint engine target must equal queued sequence ${this.queuedThroughSequence}`);
    }
    const coordinates = {
      historySequence: toBigInt(targetSequence, 'checkpoint history sequence'),
      geometryGeneration: toBigInt(this.geometryGeneration, 'checkpoint geometry generation'),
      parserEpoch: toBigInt(this.parserEpoch, 'checkpoint parser epoch'),
    };
    const captured = this.terminal.captureCheckpoint(coordinates);
    assertMetadataMatches(captured.metadata, {
      formatVersion: 1,
      engineId: 'floegence-ghostty-web',
      coveredThroughSequence: targetSequence,
      geometryGeneration: this.geometryGeneration,
      parserEpoch: this.parserEpoch,
      cols: this.cols,
      rows: this.rows,
      checksumSha256: '0'.repeat(64),
      stateDigestSha256: this.terminal.getStateDigest(),
      bytes: captured.bytes,
    });
    const metadata = this.terminal.validateCheckpoint(captured.bytes);
    assertMetadataMatches(metadata, {
      formatVersion: 1,
      engineId: 'floegence-ghostty-web',
      coveredThroughSequence: targetSequence,
      geometryGeneration: this.geometryGeneration,
      parserEpoch: this.parserEpoch,
      cols: this.cols,
      rows: this.rows,
      checksumSha256: '0'.repeat(64),
      stateDigestSha256: this.terminal.getStateDigest(),
      bytes: captured.bytes,
    });
    const liveDigest = this.terminal.getStateDigest();
    assertDigest(liveDigest, 'live state digest');
    const verifier = this.runtime.createTerminal(this.cols, this.rows);
    try {
      verifier.restoreCheckpoint(captured.bytes.slice(), coordinates);
      if (verifier.getStateDigest() !== liveDigest) {
        throw new Error('self-restore state digest mismatch');
      }
      const bytes = captured.bytes.slice();
      return {
        formatVersion: 1,
        engineId: 'floegence-ghostty-web',
        coveredThroughSequence: targetSequence,
        geometryGeneration: this.geometryGeneration,
        parserEpoch: this.parserEpoch,
        cols: this.cols,
        rows: this.rows,
        checksumSha256: await sha256Hex(bytes),
        stateDigestSha256: liveDigest,
        bytes,
      };
    } finally {
      verifier.free();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.free();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('checkpoint engine is disposed');
  }
}
