import { Ghostty } from '@floegence/ghostty-web';
import type {
  GhosttyAuthoritativeCheckpoint,
  GhosttyCheckpointChunk,
} from './GhosttyCheckpointActor';
import {
  GhosttyCheckpointEngine,
  type GhosttyCheckpointEngineOptions,
  type GhosttyCheckpointRuntimeLike,
} from './GhosttyCheckpointEngine';

interface CheckpointEngineLike {
  append(chunks: readonly GhosttyCheckpointChunk[]): { throughSequence: number; releasedBytes: number };
  capture(targetSequence: number): Promise<GhosttyAuthoritativeCheckpoint>;
  dispose(): void;
}

export interface GhosttyCheckpointWorkerRuntimeOptions {
  loadRuntime?: () => Promise<GhosttyCheckpointRuntimeLike>;
  createEngine?: (
    runtime: GhosttyCheckpointRuntimeLike,
    options: GhosttyCheckpointEngineOptions,
  ) => CheckpointEngineLike;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const assertObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object') throw new Error('checkpoint worker request must be an object');
  return value as Record<string, unknown>;
};

const defaultLoadRuntime = async (): Promise<GhosttyCheckpointRuntimeLike> => Ghostty.load();

export class GhosttyCheckpointWorkerRuntime {
  private readonly loadRuntime: () => Promise<GhosttyCheckpointRuntimeLike>;
  private readonly createEngine: GhosttyCheckpointWorkerRuntimeOptions['createEngine'];
  private readonly postMessage: GhosttyCheckpointWorkerRuntimeOptions['postMessage'];
  private engine: CheckpointEngineLike | null = null;
  private queue: Promise<void> = Promise.resolve();
  private failed = false;
  private disposed = false;

  constructor(options: GhosttyCheckpointWorkerRuntimeOptions) {
    this.loadRuntime = options.loadRuntime ?? defaultLoadRuntime;
    this.createEngine = options.createEngine ?? ((runtime, engineOptions) => new GhosttyCheckpointEngine(runtime, engineOptions));
    this.postMessage = options.postMessage;
  }

  handle(value: unknown): Promise<void> {
    const task = this.queue.then(async () => {
      if (this.failed || this.disposed) return;
      await this.dispatch(value);
    }).catch(error => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    this.queue = task;
    return task;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.dispose();
    this.engine = null;
  }

  private async dispatch(value: unknown): Promise<void> {
    const message = assertObject(value);
    if (message.type === 'initialize') {
      if (this.engine) throw new Error('checkpoint worker is already initialized');
      const cols = message.cols as number;
      const rows = message.rows as number;
      const parserEpoch = message.parserEpoch as number;
      const initialSequence = message.initialSequence as number | undefined;
      const checkpoint = message.checkpoint as GhosttyAuthoritativeCheckpoint | undefined;
      if (checkpoint) {
        if (!(checkpoint.bytes instanceof Uint8Array) || checkpoint.bytes.byteLength === 0) {
          throw new Error('checkpoint restore bytes are empty');
        }
        const checksum = await sha256Hex(checkpoint.bytes);
        if (checksum !== checkpoint.checksumSha256) {
          throw new Error('checkpoint restore checksum mismatch');
        }
      }
      const runtime = await this.loadRuntime();
      this.engine = this.createEngine?.(runtime, { cols, rows, parserEpoch, initialSequence, checkpoint }) ?? null;
      if (!this.engine) throw new Error('checkpoint worker engine creation failed');
      this.postMessage({
        type: 'ready',
        parserEpoch,
        historySequence: checkpoint?.coveredThroughSequence ?? initialSequence ?? 0,
      }, undefined);
      return;
    }
    if (!this.engine) throw new Error('checkpoint worker is not initialized');
    if (message.type === 'append') {
      if (!Array.isArray(message.chunks)) throw new Error('checkpoint worker append chunks are invalid');
      const result = this.engine.append(message.chunks as GhosttyCheckpointChunk[]);
      this.postMessage({ type: 'applied', ...result }, undefined);
      return;
    }
    if (message.type === 'capture') {
      const requestId = message.requestId as number;
      const targetSequence = message.targetSequence as number;
      if (!Number.isSafeInteger(requestId) || requestId <= 0) throw new Error('checkpoint request id is invalid');
      const checkpoint = await this.engine.capture(targetSequence);
      this.postMessage({
        type: 'checkpoint',
        requestId,
        formatVersion: checkpoint.formatVersion,
        historySequence: checkpoint.coveredThroughSequence,
        geometryGeneration: checkpoint.geometryGeneration,
        parserEpoch: checkpoint.parserEpoch,
        cols: checkpoint.cols,
        rows: checkpoint.rows,
        checksumSha256: checkpoint.checksumSha256,
        stateDigestSha256: checkpoint.stateDigestSha256,
        bytes: checkpoint.bytes,
      }, [checkpoint.bytes.buffer]);
      return;
    }
    throw new Error('unknown checkpoint worker request');
  }

  private fail(error: Error): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.engine?.dispose();
    this.engine = null;
    this.postMessage({ type: 'error', message: error.message }, undefined);
  }
}
