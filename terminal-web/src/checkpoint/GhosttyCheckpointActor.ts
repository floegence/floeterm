import type { TerminalHistoryCheckpoint } from '../types.js';

export type GhosttyCheckpointActorState = 'idle' | 'starting' | 'ready' | 'failed' | 'disposed';

export interface GhosttyCheckpointChunk {
  sequence: number;
  data: Uint8Array;
  geometryGeneration: number;
  cols: number;
  rows: number;
}

export type GhosttyAuthoritativeCheckpoint = TerminalHistoryCheckpoint;

export interface GhosttyCheckpointWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', listener: EventListener): void;
  removeEventListener(type: 'message' | 'error', listener: EventListener): void;
  terminate(): void;
}

export interface GhosttyCheckpointActorOptions {
  createWorker?: () => GhosttyCheckpointWorkerLike;
  maxQueuedBytes?: number;
}

export interface GhosttyCheckpointActorStartOptions {
  cols: number;
  rows: number;
  parserEpoch: number;
  initialSequence?: number;
  checkpoint?: GhosttyAuthoritativeCheckpoint;
}

export interface GhosttyCheckpointActorSnapshot {
  state: GhosttyCheckpointActorState;
  queuedThroughSequence: number;
  appliedThroughSequence: number;
  queuedBytes: number;
  parserEpoch: number;
  failure: Error | null;
}

export interface GhosttyCheckpointActor {
  start(options: GhosttyCheckpointActorStartOptions): Promise<void>;
  append(chunks: readonly GhosttyCheckpointChunk[]): void;
  capture(targetSequence: number): Promise<GhosttyAuthoritativeCheckpoint>;
  getSnapshot(): GhosttyCheckpointActorSnapshot;
  dispose(): void;
}

type PendingCapture = {
  targetSequence: number;
  geometryGeneration: number;
  cols: number;
  rows: number;
  resolve: (checkpoint: GhosttyAuthoritativeCheckpoint) => void;
  reject: (error: Error) => void;
};

const DEFAULT_MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const assertPositiveSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
};

const assertNonNegativeSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
};

const toError = (value: unknown, fallback: string): Error => {
  if (value instanceof Error) return value;
  if (typeof value === 'string' && value.trim() !== '') return new Error(value);
  return new Error(fallback);
};

const defaultCreateWorker = (): GhosttyCheckpointWorkerLike => new Worker(
  new URL('./GhosttyCheckpoint.worker.js', import.meta.url),
  { type: 'module', name: 'floeterm-ghostty-checkpoint' },
);

class GhosttyCheckpointActorImpl implements GhosttyCheckpointActor {
  private readonly worker: GhosttyCheckpointWorkerLike;
  private readonly maxQueuedBytes: number;
  private state: GhosttyCheckpointActorState = 'idle';
  private parserEpoch = 0;
  private queuedThroughSequence = 0;
  private appliedThroughSequence = 0;
  private queuedBytes = 0;
  private geometryGeneration = 0;
  private cols = 0;
  private rows = 0;
  private nextRequestId = 1;
  private failure: Error | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((error: Error) => void) | null = null;
  private readonly captures = new Map<number, PendingCapture>();

  private readonly onMessage = (event: Event): void => {
    const data = (event as MessageEvent<unknown>).data;
    try {
      this.handleMessage(data);
    } catch (error) {
      this.fail(toError(error, 'invalid Ghostty checkpoint worker response'));
    }
  };

  private readonly onError = (event: Event): void => {
    const message = (event as ErrorEvent).message;
    this.fail(new Error(message || 'Ghostty checkpoint worker crashed'));
  };

  constructor(options: GhosttyCheckpointActorOptions) {
    const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    assertPositiveSafeInteger(maxQueuedBytes, 'maxQueuedBytes');
    this.maxQueuedBytes = maxQueuedBytes;
    this.worker = (options.createWorker ?? defaultCreateWorker)();
    this.worker.addEventListener('message', this.onMessage as EventListener);
    this.worker.addEventListener('error', this.onError as EventListener);
  }

  start(options: GhosttyCheckpointActorStartOptions): Promise<void> {
    if (this.state !== 'idle') return Promise.reject(new Error('Ghostty checkpoint actor has already started'));
    assertPositiveSafeInteger(options.cols, 'cols');
    assertPositiveSafeInteger(options.rows, 'rows');
    assertPositiveSafeInteger(options.parserEpoch, 'parserEpoch');
    assertNonNegativeSafeInteger(options.initialSequence ?? 0, 'initialSequence');
    if (options.checkpoint && options.initialSequence !== undefined) {
      return Promise.reject(new Error('checkpoint and initialSequence are mutually exclusive'));
    }
    if (options.checkpoint && options.checkpoint.parserEpoch !== options.parserEpoch) {
      return Promise.reject(new Error('checkpoint parser epoch does not match actor parser epoch'));
    }
    this.state = 'starting';
    this.parserEpoch = options.parserEpoch;
    this.cols = options.checkpoint?.cols ?? options.cols;
    this.rows = options.checkpoint?.rows ?? options.rows;
    this.geometryGeneration = options.checkpoint?.geometryGeneration ?? 0;
    this.queuedThroughSequence = options.checkpoint?.coveredThroughSequence ?? options.initialSequence ?? 0;
    this.appliedThroughSequence = this.queuedThroughSequence;
    const checkpointBytes = options.checkpoint?.bytes.slice();
    const transfer = checkpointBytes ? [checkpointBytes.buffer] : [];
    const started = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    this.worker.postMessage({
      type: 'initialize',
      cols: this.cols,
      rows: this.rows,
      parserEpoch: this.parserEpoch,
      initialSequence: options.initialSequence,
      checkpoint: options.checkpoint ? {
        ...options.checkpoint,
        bytes: checkpointBytes,
      } : undefined,
    }, transfer);
    return started;
  }

  append(chunks: readonly GhosttyCheckpointChunk[]): void {
    this.assertReady();
    if (chunks.length === 0) return;
    let sequence = this.queuedThroughSequence;
    let geometryGeneration = this.geometryGeneration;
    let cols = this.cols;
    let rows = this.rows;
    let addedBytes = 0;
    const ownedChunks = chunks.map(chunk => {
      assertPositiveSafeInteger(chunk.sequence, 'chunk.sequence');
      assertPositiveSafeInteger(chunk.geometryGeneration, 'chunk.geometryGeneration');
      assertPositiveSafeInteger(chunk.cols, 'chunk.cols');
      assertPositiveSafeInteger(chunk.rows, 'chunk.rows');
      if (chunk.sequence !== sequence + 1) {
        throw new Error(`Ghostty checkpoint actor sequence gap: got ${chunk.sequence}, want ${sequence + 1}`);
      }
      if (!(chunk.data instanceof Uint8Array) || chunk.data.byteLength === 0) {
        throw new Error('Ghostty checkpoint actor chunk data must be non-empty bytes');
      }
      if (chunk.geometryGeneration < geometryGeneration) {
        throw new Error('Ghostty checkpoint actor geometry generation moved backwards');
      }
      if (chunk.geometryGeneration === geometryGeneration && geometryGeneration > 0 && (chunk.cols !== cols || chunk.rows !== rows)) {
        throw new Error('Ghostty checkpoint actor geometry generation has conflicting dimensions');
      }
      sequence = chunk.sequence;
      if (chunk.geometryGeneration > geometryGeneration) {
        geometryGeneration = chunk.geometryGeneration;
        cols = chunk.cols;
        rows = chunk.rows;
      }
      addedBytes += chunk.data.byteLength;
      return { ...chunk, data: chunk.data.slice() };
    });
    if (this.queuedBytes + addedBytes > this.maxQueuedBytes) {
      throw new Error(`Ghostty checkpoint actor queue exceeds ${this.maxQueuedBytes} bytes`);
    }
    this.queuedThroughSequence = sequence;
    this.geometryGeneration = geometryGeneration;
    this.cols = cols;
    this.rows = rows;
    this.queuedBytes += addedBytes;
    this.worker.postMessage({ type: 'append', chunks: ownedChunks }, ownedChunks.map(chunk => chunk.data.buffer));
  }

  capture(targetSequence: number): Promise<GhosttyAuthoritativeCheckpoint> {
    this.assertReady();
    assertPositiveSafeInteger(targetSequence, 'targetSequence');
    if (targetSequence !== this.queuedThroughSequence) {
      return Promise.reject(new Error(`checkpoint target must equal queued sequence ${this.queuedThroughSequence}`));
    }
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const result = new Promise<GhosttyAuthoritativeCheckpoint>((resolve, reject) => {
      this.captures.set(requestId, {
        targetSequence,
        geometryGeneration: this.geometryGeneration,
        cols: this.cols,
        rows: this.rows,
        resolve,
        reject,
      });
    });
    this.worker.postMessage({ type: 'capture', requestId, targetSequence });
    return result;
  }

  getSnapshot(): GhosttyCheckpointActorSnapshot {
    return {
      state: this.state,
      queuedThroughSequence: this.queuedThroughSequence,
      appliedThroughSequence: this.appliedThroughSequence,
      queuedBytes: this.queuedBytes,
      parserEpoch: this.parserEpoch,
      failure: this.failure,
    };
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    const error = new Error('Ghostty checkpoint actor is disposed');
    this.startReject?.(error);
    this.startResolve = null;
    this.startReject = null;
    for (const pending of this.captures.values()) pending.reject(error);
    this.captures.clear();
    this.worker.removeEventListener('message', this.onMessage as EventListener);
    this.worker.removeEventListener('error', this.onError as EventListener);
    this.worker.terminate();
    this.state = 'disposed';
  }

  private handleMessage(value: unknown): void {
    if (!value || typeof value !== 'object') throw new Error('checkpoint worker message must be an object');
    const message = value as Record<string, unknown>;
    if (message.type === 'ready') {
      if (this.state !== 'starting') throw new Error('unexpected checkpoint worker ready message');
      if (message.parserEpoch !== this.parserEpoch || message.historySequence !== this.queuedThroughSequence) {
        throw new Error('checkpoint worker initialized at stale coordinates');
      }
      this.state = 'ready';
      this.startResolve?.();
      this.startResolve = null;
      this.startReject = null;
      return;
    }
    if (message.type === 'applied') {
      this.assertReady();
      const throughSequence = message.throughSequence;
      const releasedBytes = message.releasedBytes;
      assertNonNegativeSafeInteger(throughSequence as number, 'applied.throughSequence');
      assertNonNegativeSafeInteger(releasedBytes as number, 'applied.releasedBytes');
      if ((throughSequence as number) < this.appliedThroughSequence || (throughSequence as number) > this.queuedThroughSequence) {
        throw new Error('checkpoint worker applied sequence is stale or beyond queued output');
      }
      if ((releasedBytes as number) > this.queuedBytes) {
        throw new Error('checkpoint worker released more bytes than queued');
      }
      this.appliedThroughSequence = throughSequence as number;
      this.queuedBytes -= releasedBytes as number;
      return;
    }
    if (message.type === 'checkpoint') {
      const requestId = message.requestId;
      assertPositiveSafeInteger(requestId as number, 'checkpoint.requestId');
      const pending = this.captures.get(requestId as number);
      if (!pending) throw new Error('checkpoint worker returned an unknown request');
      const historySequence = message.historySequence as number;
      if (historySequence !== pending.targetSequence) {
        throw new Error(`stale checkpoint sequence: got ${historySequence}, want ${pending.targetSequence}`);
      }
      if (
        message.parserEpoch !== this.parserEpoch
        || message.geometryGeneration !== pending.geometryGeneration
        || message.cols !== pending.cols
        || message.rows !== pending.rows
      ) {
        throw new Error('stale checkpoint geometry or parser epoch');
      }
      if (message.formatVersion !== 1) throw new Error('unsupported checkpoint format version');
      if (typeof message.checksumSha256 !== 'string' || !SHA256_HEX.test(message.checksumSha256)) {
        throw new Error('checkpoint checksum must be lowercase SHA-256');
      }
      if (typeof message.stateDigestSha256 !== 'string' || !SHA256_HEX.test(message.stateDigestSha256)) {
        throw new Error('checkpoint state digest must be lowercase SHA-256');
      }
      if (!(message.bytes instanceof Uint8Array) || message.bytes.byteLength === 0) {
        throw new Error('checkpoint worker returned empty checkpoint bytes');
      }
      this.captures.delete(requestId as number);
      pending.resolve({
        formatVersion: 1,
        engineId: 'floegence-ghostty-web',
        coveredThroughSequence: historySequence,
        geometryGeneration: pending.geometryGeneration,
        parserEpoch: this.parserEpoch,
        cols: pending.cols,
        rows: pending.rows,
        checksumSha256: message.checksumSha256,
        stateDigestSha256: message.stateDigestSha256,
        bytes: message.bytes.slice(),
      });
      return;
    }
    if (message.type === 'error') {
      throw new Error(typeof message.message === 'string' ? message.message : 'Ghostty checkpoint worker failed');
    }
    throw new Error('unknown Ghostty checkpoint worker message');
  }

  private assertReady(): void {
    if (this.state !== 'ready') {
      throw this.failure ?? new Error(`Ghostty checkpoint actor is not ready (${this.state})`);
    }
  }

  private fail(error: Error): void {
    if (this.state === 'disposed' || this.state === 'failed') return;
    this.failure = error;
    this.state = 'failed';
    this.startReject?.(error);
    this.startResolve = null;
    this.startReject = null;
    for (const pending of this.captures.values()) pending.reject(error);
    this.captures.clear();
  }
}

export const createGhosttyCheckpointActor = (
  options: GhosttyCheckpointActorOptions = {},
): GhosttyCheckpointActor => new GhosttyCheckpointActorImpl(options);
