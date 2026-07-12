import {
  createTerminalOutputPipeline,
  type TerminalOutputPipelineChunk,
  type TerminalOutputPipelineHandle,
  type TerminalOutputPipelinePolicy,
  type TerminalOutputPipelineScheduler,
} from './TerminalOutputPipeline';

export type PagedTerminalOutputState =
  | 'idle'
  | 'initial-replay'
  | 'live'
  | 'catching-up'
  | 'retry-wait'
  | 'failed'
  | 'disposed';

export interface PagedTerminalHistoryRequest {
  startSequence: number;
  cursor?: string | number;
  signal: AbortSignal;
}

export interface PagedTerminalHistoryPage {
  chunks: readonly TerminalOutputPipelineChunk[];
  hasMore: boolean;
  nextCursor?: string | number;
  firstAvailableSequence?: number;
  coveredThroughSequence: number;
  coveredBytes?: number;
  totalBytes?: number;
}

export type PagedTerminalHistoryTruncationReason =
  | 'history-evicted'
  | 'retained-live-overflow';

export interface PagedTerminalOutputPolicy {
  maxRetainedLiveChunks: number;
  maxRetainedLiveBytes: number;
  retryDelaysMs: readonly number[];
}

export interface PagedTerminalOutputScheduler extends TerminalOutputPipelineScheduler {
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
}

export interface PagedTerminalOutputSnapshot {
  state: PagedTerminalOutputState;
  active: boolean;
  coveredThroughSequence: number;
  retainedLiveChunks: number;
  retainedLiveBytes: number;
  retryAttempt: number;
  retryScheduled: boolean;
  lastError: unknown;
  disposed: boolean;
}

export interface PagedTerminalOutputCoordinatorOptions {
  fetchPage(request: PagedTerminalHistoryRequest): Promise<PagedTerminalHistoryPage>;
  write(data: Uint8Array, chunks: readonly TerminalOutputPipelineChunk[]): void;
  clear?: () => void;
  transformChunk?: (chunk: TerminalOutputPipelineChunk) => Uint8Array | null;
  isInteractive?: () => boolean;
  onStateChange?: (snapshot: PagedTerminalOutputSnapshot) => void;
  onHistoryTruncated?: (reason: PagedTerminalHistoryTruncationReason) => void;
  policy?: Partial<PagedTerminalOutputPolicy>;
  scheduler?: Partial<PagedTerminalOutputScheduler>;
}

export interface PagedTerminalOutputCoordinatorHandle {
  attach(startSequence?: number): Promise<void>;
  pushLive(chunk: TerminalOutputPipelineChunk): void;
  setActive(active: boolean): void;
  clear(startSequence?: number): void;
  retry(): void;
  getSnapshot(): PagedTerminalOutputSnapshot;
  dispose(): void;
}

type CoordinatorPipelineChunk = TerminalOutputPipelineChunk & {
  coordinatorSequence?: number;
};

const DEFAULT_POLICY: PagedTerminalOutputPolicy = {
  maxRetainedLiveChunks: 2048,
  maxRetainedLiveBytes: 8 * 1024 * 1024,
  retryDelaysMs: [250, 1000, 4000],
};

const normalizePositiveInteger = (value: number | undefined, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
);

const concatData = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

class PagedTerminalOutputCoordinator implements PagedTerminalOutputCoordinatorHandle {
  private readonly options: PagedTerminalOutputCoordinatorOptions;
  private readonly policy: PagedTerminalOutputPolicy;
  private readonly pipeline: TerminalOutputPipelineHandle;
  private active = true;
  private state: PagedTerminalOutputState = 'idle';
  private coveredThroughSequence = 0;
  private retainedLive: TerminalOutputPipelineChunk[] = [];
  private retainedLiveBytes = 0;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private generation = 0;
  private disposed = false;
  private lastError: unknown = null;
  private recoveryStartSequence = 1;
  private recoveryKind: 'initial' | 'catch-up' = 'initial';
  private needsRebase = false;

  constructor(options: PagedTerminalOutputCoordinatorOptions) {
    this.options = options;
    this.policy = {
      maxRetainedLiveChunks: normalizePositiveInteger(
        options.policy?.maxRetainedLiveChunks,
        DEFAULT_POLICY.maxRetainedLiveChunks,
      ),
      maxRetainedLiveBytes: normalizePositiveInteger(
        options.policy?.maxRetainedLiveBytes,
        DEFAULT_POLICY.maxRetainedLiveBytes,
      ),
      retryDelaysMs: options.policy?.retryDelaysMs !== undefined
        ? options.policy.retryDelaysMs.map(delay => Math.max(0, Math.floor(delay)))
        : DEFAULT_POLICY.retryDelaysMs,
    };

    const pipelinePolicy: Partial<TerminalOutputPipelinePolicy> = {
      maxInactiveChunks: this.policy.maxRetainedLiveChunks,
      maxInactiveBytes: this.policy.maxRetainedLiveBytes,
    };
    this.pipeline = createTerminalOutputPipeline({
      write: (_data, chunks) => this.writeAcceptedChunks(chunks),
      isInteractive: () => true,
      policy: pipelinePolicy,
      scheduler: options.scheduler,
    });
  }

  async attach(startSequence = 1): Promise<void> {
    if (this.disposed) return;
    this.cancelRecovery();
    this.retainedLive = [];
    this.retainedLiveBytes = 0;
    this.coveredThroughSequence = Math.max(0, Math.floor(startSequence) - 1);
    this.pipeline.reset({ startSequence: this.coveredThroughSequence + 1 });
    this.recoveryKind = 'initial';
    this.recoveryStartSequence = Math.max(0, Math.floor(startSequence));
    this.retryAttempt = 0;
    await this.runRecovery();
  }

  pushLive(chunk: TerminalOutputPipelineChunk): void {
    if (this.disposed) return;
    if (this.state !== 'live' || !this.canRenderLive()) {
      this.retainLive(chunk);
      return;
    }
    this.acceptLive(chunk);
  }

  setActive(active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    if (active) {
      if (this.needsRebase) {
        this.needsRebase = false;
        this.recoveryKind = 'catch-up';
        this.recoveryStartSequence = 0;
        this.options.clear?.();
        this.options.onHistoryTruncated?.('retained-live-overflow');
        void this.runRecovery();
      } else {
        this.drainRetainedLive(new Set());
        this.pipeline.flush();
      }
    }
    this.emitState();
  }

  clear(startSequence = 1): void {
    if (this.disposed) return;
    this.cancelRecovery();
    this.options.clear?.();
    this.retainedLive = [];
    this.retainedLiveBytes = 0;
    this.coveredThroughSequence = Math.max(0, Math.floor(startSequence) - 1);
    this.pipeline.reset({ startSequence: this.coveredThroughSequence + 1 });
    this.retryAttempt = 0;
    this.lastError = null;
    this.setState('idle');
  }

  retry(): void {
    if (this.disposed || this.state !== 'failed') return;
    this.retryAttempt = 0;
    void this.runRecovery();
  }

  getSnapshot(): PagedTerminalOutputSnapshot {
    return {
      state: this.state,
      active: this.active,
      coveredThroughSequence: this.coveredThroughSequence,
      retainedLiveChunks: this.retainedLive.length + this.pipeline.getStats().catchUpChunks,
      retainedLiveBytes: this.retainedLiveBytes + this.pipeline.getStats().catchUpBytes,
      retryAttempt: this.retryAttempt,
      retryScheduled: this.retryTimer !== null,
      lastError: this.lastError,
      disposed: this.disposed,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRecovery();
    this.retainedLive = [];
    this.retainedLiveBytes = 0;
    this.pipeline.dispose();
    this.setState('disposed');
  }

  private beginCatchUp(startSequence: number): void {
    if (this.disposed || this.state === 'initial-replay') return;
    this.recoveryKind = 'catch-up';
    this.recoveryStartSequence = Math.max(0, Math.floor(startSequence));
    this.retryAttempt = 0;
    void this.runRecovery();
  }

  private async runRecovery(): Promise<void> {
    if (this.disposed) return;
    this.cancelRecovery(false);
    const generation = ++this.generation;
    const controller = new AbortController();
    this.abortController = controller;
    this.lastError = null;
    this.setState(this.recoveryKind === 'initial' ? 'initial-replay' : 'catching-up');

    try {
      const replayedSequences = new Set<number>();
      let cursor: string | number | undefined;
      let startSequence = this.recoveryStartSequence;
      let firstPage = true;
      do {
        const page = await this.options.fetchPage({
          startSequence,
          cursor,
          signal: controller.signal,
        });
        if (this.disposed || generation !== this.generation) return;

        const firstAvailable = page.firstAvailableSequence;
        if (firstPage && firstAvailable && startSequence > 0 && firstAvailable > startSequence) {
          this.options.clear?.();
          this.options.onHistoryTruncated?.('history-evicted');
          this.coveredThroughSequence = firstAvailable - 1;
          this.pipeline.reset({ startSequence: firstAvailable });
        }
        firstPage = false;
        const replayChunks = page.chunks.filter(chunk => (
          !chunk.sequence || chunk.sequence > this.coveredThroughSequence
        ));
        for (const chunk of replayChunks) {
          if (chunk.sequence) replayedSequences.add(chunk.sequence);
        }
        this.writeAcceptedChunks(replayChunks);
        this.coveredThroughSequence = Math.max(
          this.coveredThroughSequence,
          Math.floor(page.coveredThroughSequence || 0),
        );
        cursor = page.nextCursor;
        startSequence = this.coveredThroughSequence + 1;
        if (!page.hasMore) break;
      } while (!controller.signal.aborted);

      if (this.disposed || generation !== this.generation) return;
      if (this.needsRebase) {
        this.needsRebase = false;
        this.options.clear?.();
        this.pipeline.reset({ startSequence: 1 });
        this.coveredThroughSequence = 0;
        this.recoveryStartSequence = 0;
        this.options.onHistoryTruncated?.('retained-live-overflow');
        await this.runRecovery();
        return;
      }

      this.pipeline.reset();
      this.retryAttempt = 0;
      this.lastError = null;
      this.setState('live');
      this.drainRetainedLive(replayedSequences);
      this.pipeline.flush();
    } catch (error) {
      if (controller.signal.aborted || this.disposed || generation !== this.generation) return;
      this.lastError = error;
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    const delay = this.policy.retryDelaysMs[this.retryAttempt];
    if (delay === undefined) {
      this.setState('failed');
      return;
    }
    this.retryAttempt += 1;
    this.setState('retry-wait');
    const setTimer = this.options.scheduler?.setTimer ?? setTimeout;
    this.retryTimer = setTimer(() => {
      this.retryTimer = null;
      void this.runRecovery();
    }, delay);
    this.emitState();
  }

  private retainLive(chunk: TerminalOutputPipelineChunk): void {
    this.retainedLive.push(chunk);
    this.retainedLiveBytes += chunk.data.byteLength;
    while (
      this.retainedLive.length > this.policy.maxRetainedLiveChunks
      || this.retainedLiveBytes > this.policy.maxRetainedLiveBytes
    ) {
      const removed = this.retainedLive.shift();
      if (!removed) break;
      this.retainedLiveBytes -= removed.data.byteLength;
      this.needsRebase = true;
    }
    this.emitState();
  }

  private canRenderLive(): boolean {
    return this.active && (this.options.isInteractive?.() ?? true);
  }

  private acceptLive(chunk: TerminalOutputPipelineChunk): void {
    const sequence = typeof chunk.sequence === 'number' && Number.isFinite(chunk.sequence) && chunk.sequence > 0
      ? Math.floor(chunk.sequence)
      : undefined;
    if (sequence && sequence <= this.coveredThroughSequence) {
      return;
    }
    if (sequence && this.coveredThroughSequence > 0 && sequence > this.coveredThroughSequence + 1) {
      this.retainLive({ ...chunk, sequence });
      this.beginCatchUp(this.coveredThroughSequence + 1);
      return;
    }
    this.enqueueForRender(sequence ? { ...chunk, sequence } : chunk);
  }

  private enqueueForRender(chunk: TerminalOutputPipelineChunk): void {
    const sequence = chunk.sequence;
    const pipelineChunk: CoordinatorPipelineChunk = {
      ...chunk,
      sequence: undefined,
      coordinatorSequence: sequence,
    };
    this.pipeline.enqueue(pipelineChunk);
    if (sequence) {
      this.coveredThroughSequence = Math.max(this.coveredThroughSequence, sequence);
    }
  }

  private drainRetainedLive(replayedSequences: ReadonlySet<number>): void {
    if (!this.canRenderLive() || this.retainedLive.length === 0) return;
    const retained = [...this.retainedLive].sort((left, right) => (
      (left.sequence ?? 0) - (right.sequence ?? 0)
    ));
    this.retainedLive = [];
    this.retainedLiveBytes = 0;

    const firstSequence = retained.find(chunk => chunk.sequence)?.sequence;
    if (this.coveredThroughSequence === 0 && firstSequence && replayedSequences.size === 0) {
      this.coveredThroughSequence = firstSequence - 1;
    }
    for (const chunk of retained) {
      if (chunk.sequence && replayedSequences.has(chunk.sequence)) continue;
      if (chunk.sequence && chunk.sequence <= this.coveredThroughSequence) {
        this.enqueueForRender(chunk);
        continue;
      }
      this.acceptLive(chunk);
      if (this.state !== 'live') break;
    }
  }

  private writeAcceptedChunks(chunks: readonly TerminalOutputPipelineChunk[]): void {
    if (chunks.length === 0) return;
    const acceptedChunks: TerminalOutputPipelineChunk[] = [];
    const data: Uint8Array[] = [];
    for (const queuedChunk of chunks) {
      const coordinatorSequence = (queuedChunk as CoordinatorPipelineChunk).coordinatorSequence;
      const chunk = coordinatorSequence
        ? { ...queuedChunk, sequence: coordinatorSequence }
        : queuedChunk;
      const transformed = this.options.transformChunk
        ? this.options.transformChunk(chunk)
        : chunk.data;
      if (transformed === null) continue;
      acceptedChunks.push({ ...chunk, data: transformed });
      data.push(transformed);
    }
    if (acceptedChunks.length > 0) {
      this.options.write(concatData(data), acceptedChunks);
      for (const chunk of acceptedChunks) {
        if (chunk.sequence) {
          this.coveredThroughSequence = Math.max(this.coveredThroughSequence, chunk.sequence);
        }
      }
    }
  }

  private cancelRecovery(incrementGeneration = true): void {
    this.abortController?.abort();
    this.abortController = null;
    if (this.retryTimer !== null) {
      const clearTimer = this.options.scheduler?.clearTimer ?? clearTimeout;
      clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
    if (incrementGeneration) this.generation += 1;
  }

  private setState(state: PagedTerminalOutputState): void {
    this.state = state;
    this.emitState();
  }

  private emitState(): void {
    this.options.onStateChange?.(this.getSnapshot());
  }
}

export const createPagedTerminalOutputCoordinator = (
  options: PagedTerminalOutputCoordinatorOptions,
): PagedTerminalOutputCoordinatorHandle => new PagedTerminalOutputCoordinator(options);
