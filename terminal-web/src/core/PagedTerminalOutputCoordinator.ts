import type {
  TerminalOutputPipelineChunk,
  TerminalOutputPipelineScheduler,
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
  endSequence?: number;
  historyGeneration?: number;
  cursor?: string | number;
  signal: AbortSignal;
}

export interface PagedTerminalHistoryPage {
  chunks: readonly TerminalOutputPipelineChunk[];
  hasMore: boolean;
  nextCursor?: string | number;
  firstAvailableSequence?: number;
  firstRetainedSequence?: number;
  coveredThroughSequence: number;
  snapshotEndSequence?: number;
  historyGeneration?: number;
  historyReset?: boolean;
  historyTruncated?: boolean;
  coveredBytes?: number;
  totalBytes?: number;
}

export type PagedTerminalHistoryTruncationReason =
  | 'history-evicted'
  | 'retained-live-overflow';

export type PagedTerminalOutputFailureCode =
  | 'history_fetch_failed'
  | 'history_coverage_incomplete'
  | 'history_contract_missing'
  | 'history_contract_invalid'
  | 'retained_live_overflow'
  | 'history_evicted';

export interface PagedTerminalOutputFailure {
  code: PagedTerminalOutputFailureCode;
  phase: 'initial' | 'catch_up';
  retryable: boolean;
  attempt: number;
  coveredSequence: number;
  firstRetainedSequence?: number;
  attachGeneration: number;
  cause?: unknown;
}

export interface PagedTerminalOutputPolicy {
  maxRetainedLiveChunks: number;
  maxRetainedLiveBytes: number;
  retryDelaysMs: readonly number[];
  maxWriteBatchBytes: number;
}

export interface PagedTerminalOutputScheduler extends TerminalOutputPipelineScheduler {
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
}

export interface PagedTerminalOutputSnapshot {
  state: PagedTerminalOutputState;
  active: boolean;
  baselineReady: boolean;
  coveredThroughSequence: number;
  retainedLiveChunks: number;
  retainedLiveBytes: number;
  retryAttempt: number;
  retryScheduled: boolean;
  failure: PagedTerminalOutputFailure | null;
  /** @deprecated Use failure for stable recovery diagnostics. */
  lastError: unknown;
  attachGeneration: number;
  disposed: boolean;
}

type PagedTerminalOutputWriter = (
  data: Uint8Array,
  chunks: readonly TerminalOutputPipelineChunk[],
) => unknown | Promise<unknown>;

export interface PagedTerminalOutputCoordinatorOptions {
  fetchPage(request: PagedTerminalHistoryRequest): Promise<PagedTerminalHistoryPage>;
  write: PagedTerminalOutputWriter;
  writeHistory?: PagedTerminalOutputWriter;
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
  waitForBaseline(): Promise<PagedTerminalOutputSnapshot>;
  pause(): Promise<PagedTerminalOutputSnapshot>;
  pushLive(chunk: TerminalOutputPipelineChunk): void;
  setActive(active: boolean): void;
  clear(startSequence?: number): void;
  retry(): void;
  getSnapshot(): PagedTerminalOutputSnapshot;
  dispose(): void;
}

export interface AtomicPagedTerminalOutputCoordinatorHandle
  extends PagedTerminalOutputCoordinatorHandle {
  beginAttach(startSequence?: number): number;
  completeAttach(attachGeneration: number, snapshotEndSequence?: number): Promise<void>;
  attach(startSequence?: number, snapshotEndSequence?: number): Promise<void>;
}

type RecoveryKind = 'initial' | 'catch-up';
type TaggedChunk = TerminalOutputPipelineChunk & { source?: 'history' | 'live' };

const DEFAULT_POLICY: PagedTerminalOutputPolicy = {
  maxRetainedLiveChunks: 2048,
  maxRetainedLiveBytes: 8 * 1024 * 1024,
  retryDelaysMs: [250, 1000, 4000],
  maxWriteBatchBytes: 256 * 1024,
};

const normalizePositiveInteger = (value: number | undefined, fallback: number): number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback
);

const normalizeSequence = (value: unknown, field: string, optional = false): number | undefined => {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HistoryContractError('history_contract_invalid', `${field} must be a non-negative safe integer`);
  }
  return value;
};

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

class HistoryContractError extends Error {
  readonly code: PagedTerminalOutputFailureCode;
  readonly firstRetainedSequence?: number;

  constructor(code: PagedTerminalOutputFailureCode, message: string, firstRetainedSequence?: number) {
    super(message);
    this.name = 'HistoryContractError';
    this.code = code;
    this.firstRetainedSequence = firstRetainedSequence;
  }
}

class PagedTerminalOutputCoordinator implements PagedTerminalOutputCoordinatorHandle {
  private readonly options: PagedTerminalOutputCoordinatorOptions;
  private readonly policy: PagedTerminalOutputPolicy;
  private active = true;
  private state: PagedTerminalOutputState = 'idle';
  private baselineReady = false;
  private coveredThroughSequence = 0;
  private scheduledThroughSequence = 0;
  private retainedLive: TaggedChunk[] = [];
  private retainedLiveBytes = 0;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private generation = 0;
  private recoverySerial = 0;
  private disposed = false;
  private lastError: unknown = null;
  private failure: PagedTerminalOutputFailure | null = null;
  private recoveryStartSequence = 1;
  private recoveryEndSequence: number | undefined;
  private explicitAttachFence = false;
  private recoveryKind: RecoveryKind = 'initial';
  private recoveryRunning = false;
  private needsRebase = false;
  private historyRebasePrepared = false;
  private writeChain: Promise<void> = Promise.resolve();
  private pendingLiveWrites: TaggedChunk[] = [];
  private liveWriteScheduled = false;
  private baselineWaiters: Array<(snapshot: PagedTerminalOutputSnapshot) => void> = [];
  private activeWriters = 0;
  private writerQuiescenceWaiters: Array<() => void> = [];
  private pausedRecoveryPending = false;
  private droppedLiveThroughSequence = 0;

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
      maxWriteBatchBytes: normalizePositiveInteger(
        options.policy?.maxWriteBatchBytes,
        DEFAULT_POLICY.maxWriteBatchBytes,
      ),
    };
  }

  async attach(startSequence = 1, snapshotEndSequence?: number): Promise<void> {
    const attachGeneration = this.beginAttach(startSequence);
    await this.completeAttach(attachGeneration, snapshotEndSequence);
  }

  beginAttach(startSequence = 1): number {
    if (this.disposed) return this.generation;
    this.cancelRecovery();
    this.resolveBaselineWaiters();
    this.retainedLive = [];
    this.retainedLiveBytes = 0;
    this.pendingLiveWrites = [];
    this.liveWriteScheduled = false;
    this.pausedRecoveryPending = false;
    this.writeChain = Promise.resolve();
    this.baselineReady = false;
    this.coveredThroughSequence = Math.max(0, Math.floor(startSequence) - 1);
    this.scheduledThroughSequence = this.coveredThroughSequence;
    this.recoveryKind = 'initial';
    this.recoveryStartSequence = Math.max(0, Math.floor(startSequence));
    this.recoveryEndSequence = undefined;
    this.explicitAttachFence = false;
    this.droppedLiveThroughSequence = 0;
    this.needsRebase = false;
    this.retryAttempt = 0;
    this.failure = null;
    this.lastError = null;
    this.historyRebasePrepared = false;
    this.setState('idle');
    return this.generation;
  }

  async completeAttach(attachGeneration: number, snapshotEndSequence?: number): Promise<void> {
    if (this.disposed || !this.isCurrent(attachGeneration)) return;
    this.explicitAttachFence = snapshotEndSequence !== undefined;
    this.recoveryEndSequence = normalizeSequence(snapshotEndSequence, 'snapshotEndSequence', true);
    if (this.explicitAttachFence && this.recoveryEndSequence === 0) {
      if (this.needsRebase) {
        this.prepareRetainedLiveRebase();
        await this.runRecovery();
        return;
      }
      this.baselineReady = true;
      this.resolveBaselineWaiters();
      this.emitState();
      this.setState('live');
      this.drainRetainedLive();
      return;
    }
    await this.runRecovery();
  }

  waitForBaseline(): Promise<PagedTerminalOutputSnapshot> {
    const snapshot = this.getSnapshot();
    if (snapshot.baselineReady || snapshot.state === 'failed' || snapshot.disposed) {
      return Promise.resolve(snapshot);
    }
    return new Promise(resolve => this.baselineWaiters.push(resolve));
  }

  async pause(): Promise<PagedTerminalOutputSnapshot> {
    if (this.disposed) return this.getSnapshot();
    this.active = false;
    const recoveryPending = this.recoveryRunning
      || this.state === 'initial-replay'
      || this.state === 'catching-up'
      || this.state === 'retry-wait';
    if (recoveryPending) {
      this.pausedRecoveryPending = true;
      this.cancelRecovery(false);
    }
    this.emitState();
    await this.writeChain;
    await this.waitForWriterQuiescence();
    return this.getSnapshot();
  }

  pushLive(chunk: TerminalOutputPipelineChunk): void {
    if (this.disposed) return;
    const tagged: TaggedChunk = { ...chunk, source: 'live' };
    if (this.state !== 'live' || !this.canRenderLive()) {
      this.retainLive(tagged);
      return;
    }
    this.acceptLive(tagged);
  }

  setActive(active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    if (active) {
      if (this.pausedRecoveryPending) {
        this.pausedRecoveryPending = false;
        void this.runRecovery();
      } else if (this.needsRebase) {
		if (!this.recoveryRunning) {
			this.prepareRetainedLiveRebase();
			void this.runRecovery();
		}
      } else if (this.state === 'live') {
        this.drainRetainedLive();
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
    this.pendingLiveWrites = [];
    this.liveWriteScheduled = false;
    this.pausedRecoveryPending = false;
    this.writeChain = Promise.resolve();
    this.baselineReady = false;
    this.coveredThroughSequence = Math.max(0, Math.floor(startSequence) - 1);
    this.scheduledThroughSequence = this.coveredThroughSequence;
    this.recoveryEndSequence = undefined;
    this.explicitAttachFence = false;
    this.droppedLiveThroughSequence = 0;
    this.retryAttempt = 0;
    this.failure = null;
    this.lastError = null;
    this.historyRebasePrepared = false;
    this.setState('idle');
    this.resolveBaselineWaiters();
  }

  retry(): void {
    if (this.disposed || this.state !== 'failed') return;
    this.retryAttempt = 0;
    this.failure = null;
    void this.runRecovery();
  }

  getSnapshot(): PagedTerminalOutputSnapshot {
    return {
      state: this.state,
      active: this.active,
      baselineReady: this.baselineReady,
      coveredThroughSequence: this.coveredThroughSequence,
      retainedLiveChunks: this.retainedLive.length,
      retainedLiveBytes: this.retainedLiveBytes,
      retryAttempt: this.retryAttempt,
      retryScheduled: this.retryTimer !== null,
      failure: this.failure,
      lastError: this.lastError,
      attachGeneration: this.generation,
      disposed: this.disposed,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRecovery();
    this.retainedLive = [];
    this.retainedLiveBytes = 0;
    this.pendingLiveWrites = [];
    this.liveWriteScheduled = false;
    this.pausedRecoveryPending = false;
    this.setState('disposed');
    this.resolveBaselineWaiters();
  }

  private beginCatchUp(startSequence: number): void {
    if (this.disposed || this.recoveryRunning || this.state === 'initial-replay') return;
    this.recoveryKind = 'catch-up';
    this.recoveryStartSequence = Math.max(0, Math.floor(startSequence));
    const firstRetainedSequence = this.firstRetainedLiveSequence();
    this.recoveryEndSequence = firstRetainedSequence === undefined
      ? undefined
      : Math.max(0, firstRetainedSequence - 1);
    this.retryAttempt = 0;
    void this.runRecovery();
  }

  private async runRecovery(): Promise<void> {
    if (this.disposed || this.recoveryRunning) return;
    this.cancelRecovery(false);
    const generation = this.generation;
    const recoverySerial = ++this.recoverySerial;
    const controller = new AbortController();
    this.abortController = controller;
    this.lastError = null;
    this.failure = null;
    this.recoveryRunning = true;
    this.setState(this.recoveryKind === 'initial' ? 'initial-replay' : 'catching-up');

    try {
      await this.writeChain;
      if (!this.isRecoveryCurrent(generation, recoverySerial, controller)) return;

      const historyChunks: TaggedChunk[] = [];
      let cursor: string | number | undefined;
      let startSequence = this.recoveryStartSequence;
      let snapshotEnd = this.recoveryEndSequence;
      let historyGeneration: number | undefined;
      let coveredEnd = this.coveredThroughSequence;
      let firstPage = true;

      do {
        const page = await this.options.fetchPage({
          startSequence,
          endSequence: snapshotEnd,
          historyGeneration,
          cursor,
          signal: controller.signal,
        });
        if (!this.isRecoveryCurrent(generation, recoverySerial, controller)) return;

        const pageSnapshotEnd = normalizeSequence(page.snapshotEndSequence, 'snapshotEndSequence', true);
        const pageGeneration = normalizeSequence(page.historyGeneration, 'historyGeneration', true);
        const firstRetained = normalizeSequence(
          page.firstRetainedSequence ?? page.firstAvailableSequence,
          'firstRetainedSequence',
          true,
        );
        const generationChanged = historyGeneration !== undefined
          && pageGeneration !== undefined
          && pageGeneration !== historyGeneration;
        const effectivePageStart = Math.max(1, startSequence);
        const retentionAdvanced = firstRetained !== undefined
          && firstRetained > effectivePageStart;
        const generationNeedsRebase = page.historyReset || generationChanged;
        const retentionNeedsRebase = page.historyTruncated || retentionAdvanced;
        const fencedRangeFullyEvicted = this.recoveryEndSequence !== undefined
          && firstRetained !== undefined
          && firstRetained > this.recoveryEndSequence;
        if (!this.historyRebasePrepared && (generationNeedsRebase || retentionNeedsRebase)) {
          if (fencedRangeFullyEvicted) {
            this.options.clear?.();
            this.options.onHistoryTruncated?.('history-evicted');
            if (generationNeedsRebase) {
              this.historyRebasePrepared = true;
              this.recoveryRunning = false;
              await this.runRecovery();
              return;
            }
          } else {
            this.prepareHistoryGenerationRebase(firstRetained);
            this.recoveryRunning = false;
            await this.runRecovery();
            return;
          }
        }
        if (this.historyRebasePrepared && generationNeedsRebase) {
          throw new HistoryContractError('history_contract_invalid', 'history generation reset persisted after rebase');
        }

        const coverage = this.validatePage(page, coveredEnd);
        if (snapshotEnd !== undefined && coverage > snapshotEnd) {
          throw new HistoryContractError('history_contract_invalid', 'coveredThroughSequence exceeded the recovery fence');
        }

        if (firstPage) {
          if (this.recoveryEndSequence !== undefined) {
            if (pageSnapshotEnd !== undefined && pageSnapshotEnd !== this.recoveryEndSequence) {
              throw new HistoryContractError(
                'history_contract_invalid',
                'snapshotEndSequence does not match the requested recovery fence',
              );
            }
            snapshotEnd = this.recoveryEndSequence;
          } else {
            snapshotEnd = pageSnapshotEnd;
          }
          historyGeneration = pageGeneration;
          const effectiveStart = Math.max(1, startSequence);
          if (!fencedRangeFullyEvicted && firstRetained !== undefined && firstRetained > effectiveStart) {
            if (!this.historyRebasePrepared) {
              this.options.clear?.();
              this.options.onHistoryTruncated?.('history-evicted');
            }
            this.coveredThroughSequence = Math.max(0, (firstRetained ?? effectiveStart) - 1);
            this.scheduledThroughSequence = this.coveredThroughSequence;
          }
          this.historyRebasePrepared = false;
        } else {
          if (snapshotEnd !== undefined && pageSnapshotEnd !== undefined && pageSnapshotEnd !== snapshotEnd) {
            throw new HistoryContractError('history_contract_invalid', 'snapshotEndSequence changed during pagination');
          }
        }

        firstPage = false;
        historyChunks.push(...page.chunks.map(item => ({ ...item, source: 'history' as const })));
        coveredEnd = Math.max(coveredEnd, coverage);
        cursor = page.nextCursor;
        if (!page.hasMore) break;
        if (cursor === undefined) {
          throw new HistoryContractError('history_contract_invalid', 'nextCursor is required when hasMore is true');
        }
        startSequence = coverage + 1;
      } while (!controller.signal.aborted);

      if (!this.isRecoveryCurrent(generation, recoverySerial, controller)) return;
      if (this.recoveryEndSequence !== undefined && coveredEnd < this.recoveryEndSequence) {
        throw new HistoryContractError(
          'history_coverage_incomplete',
          'terminal history coverage did not reach the recovery fence',
        );
      }
      if (this.needsRebase) {
		this.prepareRetainedLiveRebase();
        this.recoveryRunning = false;
        await this.runRecovery();
        return;
      }

      const replayChunks = this.mergeRecoveryChunks(historyChunks, coveredEnd);
      await this.writeOrdered(
        replayChunks,
        generation,
        () => this.isRecoveryCurrent(generation, recoverySerial, controller),
      );
      if (!this.isRecoveryCurrent(generation, recoverySerial, controller)) return;
      if (this.needsRebase) {
        this.prepareRetainedLiveRebase();
        this.recoveryRunning = false;
        await this.runRecovery();
        return;
      }
      this.coveredThroughSequence = Math.max(this.coveredThroughSequence, coveredEnd);
      this.scheduledThroughSequence = Math.max(this.scheduledThroughSequence, coveredEnd);

      const firstRetainedSequence = this.firstRetainedLiveSequence();
      if (
        this.recoveryKind === 'catch-up'
        && firstRetainedSequence !== undefined
        && firstRetainedSequence > coveredEnd + 1
      ) {
        throw new HistoryContractError(
          'history_coverage_incomplete',
          'terminal history coverage has not reached retained live output',
          firstRetainedSequence,
        );
      }

      if (this.recoveryKind === 'initial' && !this.baselineReady) {
        this.baselineReady = true;
        this.resolveBaselineWaiters();
        this.emitState();
      }

      this.retryAttempt = 0;
      this.lastError = null;
      this.failure = null;
      this.setState('live');
      this.recoveryRunning = false;
      this.drainRetainedLive();
    } catch (error) {
      if (!this.isRecoveryCurrent(generation, recoverySerial, controller)) return;
      this.lastError = error;
      const contract = error instanceof HistoryContractError ? error : null;
      this.failure = {
        code: contract?.code ?? 'history_fetch_failed',
        phase: this.recoveryKind === 'initial' ? 'initial' : 'catch_up',
        retryable: contract?.code !== 'history_contract_missing' && contract?.code !== 'history_contract_invalid',
        attempt: this.retryAttempt,
        coveredSequence: this.coveredThroughSequence,
        firstRetainedSequence: contract?.firstRetainedSequence,
        attachGeneration: generation,
        cause: error,
      };
      this.recoveryRunning = false;
      this.scheduleRetry();
    }
  }

  private validatePage(page: PagedTerminalHistoryPage, previousCoverage: number): number {
    if (!Object.prototype.hasOwnProperty.call(page, 'coveredThroughSequence')) {
      throw new HistoryContractError('history_contract_missing', 'coveredThroughSequence is required');
    }
    const coverage = normalizeSequence(page.coveredThroughSequence, 'coveredThroughSequence')!;
    if (coverage < previousCoverage) {
      throw new HistoryContractError('history_contract_invalid', 'coveredThroughSequence regressed');
    }
    return coverage;
  }

  private mergeRecoveryChunks(history: readonly TaggedChunk[], coveredEnd: number): TaggedChunk[] {
    const selected = new Map<number, TaggedChunk>();
    const unsequenced: TaggedChunk[] = [];
    for (const item of history) {
      const sequence = this.chunkSequence(item);
      if (sequence === undefined) unsequenced.push(item);
      else if (sequence > this.coveredThroughSequence && sequence <= coveredEnd) selected.set(sequence, item);
    }

    const remaining: TaggedChunk[] = [];
    let remainingBytes = 0;
    for (const item of this.retainedLive) {
      const sequence = this.chunkSequence(item);
      if (sequence !== undefined && sequence <= coveredEnd) {
        // A live copy preserves terminal query/response semantics that history replay suppresses.
        selected.set(sequence, item);
      } else {
        remaining.push(item);
        remainingBytes += item.data.byteLength;
      }
    }
    this.retainedLive = remaining;
    this.retainedLiveBytes = remainingBytes;

    return [
      ...[...selected.entries()].sort(([left], [right]) => left - right).map(([, item]) => item),
      ...unsequenced,
    ];
  }

  private async writeOrdered(
    chunks: readonly TaggedChunk[],
    generation: number,
    canStartBatch: () => boolean = () => this.isCurrent(generation),
  ): Promise<void> {
    let batch: TaggedChunk[] = [];
    let batchBytes = 0;
    let batchSource: 'history' | 'live' | undefined;

    const flush = async () => {
      if (batch.length === 0 || !this.isCurrent(generation) || !canStartBatch()) return;
      const current = batch;
      const source = batchSource;
      batch = [];
      batchBytes = 0;
      batchSource = undefined;

      const accepted: TaggedChunk[] = [];
      const data: Uint8Array[] = [];
      for (const item of current) {
        const transformed = this.options.transformChunk ? this.options.transformChunk(item) : item.data;
        if (transformed === null) continue;
        accepted.push({ ...item, data: transformed });
        data.push(transformed);
      }
      if (accepted.length === 0 || !this.isCurrent(generation)) return;
      const writer = source === 'history' ? (this.options.writeHistory ?? this.options.write) : this.options.write;
      await this.invokeWriter(writer, concatData(data), accepted, generation);
    };

    for (const item of chunks) {
      const source = item.source ?? 'live';
      if (batch.length > 0 && (
        source !== batchSource || batchBytes + item.data.byteLength > this.policy.maxWriteBatchBytes
      )) {
        await flush();
      }
      batchSource = source;
      batch.push(item);
      batchBytes += item.data.byteLength;
    }
    await flush();
  }

  private scheduleRetry(): void {
    if (this.failure && !this.failure.retryable) {
      this.setState('failed');
      if (!this.baselineReady) this.resolveBaselineWaiters();
      return;
    }
    const delay = this.policy.retryDelaysMs[this.retryAttempt];
    if (delay === undefined) {
      this.setState('failed');
      if (!this.baselineReady) this.resolveBaselineWaiters();
      return;
    }
    this.retryAttempt += 1;
    this.setState('retry-wait');
    const generation = this.generation;
    const setTimer = this.options.scheduler?.setTimer ?? setTimeout;
    this.retryTimer = setTimer(() => {
      this.retryTimer = null;
      if (!this.isCurrent(generation)) return;
      void this.runRecovery();
    }, delay);
    this.emitState();
  }

  private retainLive(chunk: TaggedChunk): void {
    this.retainedLive.push(chunk);
    this.retainedLiveBytes += chunk.data.byteLength;
    while (
      this.retainedLive.length > this.policy.maxRetainedLiveChunks
      || this.retainedLiveBytes > this.policy.maxRetainedLiveBytes
    ) {
      const removed = this.retainedLive.shift();
      if (!removed) break;
      this.retainedLiveBytes -= removed.data.byteLength;
      const removedSequence = this.chunkSequence(removed);
      if (removedSequence !== undefined) {
        this.droppedLiveThroughSequence = Math.max(this.droppedLiveThroughSequence, removedSequence);
      }
      this.needsRebase = true;
    }
    this.emitState();
  }

  private prepareRetainedLiveRebase(): void {
    this.needsRebase = false;
    this.historyRebasePrepared = false;
    this.recoveryKind = this.baselineReady ? 'catch-up' : 'initial';
    this.recoveryStartSequence = 0;
    const firstRetainedSequence = this.firstRetainedLiveSequence();
    this.recoveryEndSequence = Math.max(
      this.droppedLiveThroughSequence,
      firstRetainedSequence === undefined ? 0 : firstRetainedSequence - 1,
    ) || undefined;
    this.droppedLiveThroughSequence = 0;
    this.coveredThroughSequence = 0;
    this.scheduledThroughSequence = 0;
    this.options.clear?.();
    this.options.onHistoryTruncated?.('retained-live-overflow');
  }

  private prepareHistoryGenerationRebase(firstRetainedSequence: number | undefined): void {
    this.recoveryKind = this.baselineReady ? 'catch-up' : 'initial';
    this.recoveryStartSequence = 0;
    this.coveredThroughSequence = 0;
    this.scheduledThroughSequence = 0;
    this.options.clear?.();
    this.options.onHistoryTruncated?.('history-evicted');
    this.historyRebasePrepared = true;
    if (firstRetainedSequence !== undefined && firstRetainedSequence > 1) {
      this.recoveryStartSequence = firstRetainedSequence;
      this.coveredThroughSequence = firstRetainedSequence - 1;
      this.scheduledThroughSequence = this.coveredThroughSequence;
    }
  }

  private canRenderLive(): boolean {
    return this.active && (this.options.isInteractive?.() ?? true);
  }

  private acceptLive(chunk: TaggedChunk): void {
    const sequence = this.chunkSequence(chunk);
    if (sequence !== undefined && sequence <= this.scheduledThroughSequence) return;
    if (
      sequence !== undefined
      && this.explicitAttachFence
      && this.scheduledThroughSequence === 0
      && sequence > 1
    ) {
      this.retainLive(chunk);
      this.beginCatchUp(1);
      return;
    }
    if (
      sequence !== undefined
      && this.scheduledThroughSequence > 0
      && sequence > this.scheduledThroughSequence + 1
    ) {
      this.retainLive(chunk);
      this.beginCatchUp(this.scheduledThroughSequence + 1);
      return;
    }
    if (sequence !== undefined && this.scheduledThroughSequence === 0) {
      this.coveredThroughSequence = sequence - 1;
      this.scheduledThroughSequence = sequence - 1;
    }
    this.enqueueLiveWrite(chunk);
  }

  private enqueueLiveWrite(chunk: TaggedChunk): void {
    const generation = this.generation;
    const sequence = this.chunkSequence(chunk);
    if (sequence !== undefined) this.scheduledThroughSequence = Math.max(this.scheduledThroughSequence, sequence);

    this.pendingLiveWrites.push(chunk);
    if (this.liveWriteScheduled) return;
    this.liveWriteScheduled = true;
    this.writeChain = this.writeChain.then(async () => {
      if (!this.isCurrent(generation)) return;
      await Promise.resolve();
      if (!this.isCurrent(generation)) return;
      const pending = this.pendingLiveWrites.splice(0);
      this.liveWriteScheduled = false;
      await this.writeOrdered(pending, generation);
    }).catch(error => {
      this.liveWriteScheduled = false;
      if (!this.isCurrent(generation)) return;
      this.lastError = error;
      this.failure = {
        code: 'history_fetch_failed',
        phase: 'catch_up',
        retryable: true,
        attempt: this.retryAttempt,
        coveredSequence: this.coveredThroughSequence,
        attachGeneration: generation,
        cause: error,
      };
      this.setState('failed');
    });
  }

  private drainRetainedLive(): void {
    if (!this.canRenderLive() || this.retainedLive.length === 0 || this.state !== 'live') return;
    const retained = [...this.retainedLive].sort((left, right) => (
      (this.chunkSequence(left) ?? Number.MAX_SAFE_INTEGER)
      - (this.chunkSequence(right) ?? Number.MAX_SAFE_INTEGER)
    ));
    this.retainedLive = [];
    this.retainedLiveBytes = 0;
    for (let index = 0; index < retained.length; index += 1) {
      this.acceptLive(retained[index]!);
      if (this.state !== 'live') {
        for (const pending of retained.slice(index + 1)) this.retainLive(pending);
        break;
      }
    }
  }

  private async invokeWriter(
    writer: PagedTerminalOutputWriter,
    data: Uint8Array,
    chunks: readonly TerminalOutputPipelineChunk[],
    generation: number,
  ): Promise<void> {
    this.activeWriters += 1;
    try {
      await writer(data, chunks);
      if (!this.isCurrent(generation)) return;
      for (const item of chunks) {
        const sequence = this.chunkSequence(item);
        if (sequence !== undefined) {
          this.coveredThroughSequence = Math.max(this.coveredThroughSequence, sequence);
          this.scheduledThroughSequence = Math.max(this.scheduledThroughSequence, sequence);
        }
      }
    } finally {
      this.activeWriters -= 1;
      if (this.activeWriters === 0) {
        const waiters = this.writerQuiescenceWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  private waitForWriterQuiescence(): Promise<void> {
    if (this.activeWriters === 0) return Promise.resolve();
    return new Promise(resolve => this.writerQuiescenceWaiters.push(resolve));
  }

  private chunkSequence(chunk: TerminalOutputPipelineChunk): number | undefined {
    const sequence = chunk.sequence;
    return typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0
      ? sequence
      : undefined;
  }

  private firstRetainedLiveSequence(): number | undefined {
    let first: number | undefined;
    for (const item of this.retainedLive) {
      const sequence = this.chunkSequence(item);
      if (sequence !== undefined && (first === undefined || sequence < first)) first = sequence;
    }
    return first;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private isRecoveryCurrent(
    generation: number,
    recoverySerial: number,
    controller: AbortController,
  ): boolean {
    return this.isCurrent(generation)
      && recoverySerial === this.recoverySerial
      && !controller.signal.aborted;
  }

  private cancelRecovery(incrementGeneration = true): void {
    this.abortController?.abort();
    this.abortController = null;
    this.recoveryRunning = false;
    this.recoverySerial += 1;
    if (this.retryTimer !== null) {
      const clearTimer = this.options.scheduler?.clearTimer ?? clearTimeout;
      clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
    if (incrementGeneration) this.generation += 1;
  }

  private resolveBaselineWaiters(): void {
    if (this.baselineWaiters.length === 0) return;
    const snapshot = this.getSnapshot();
    const waiters = this.baselineWaiters.splice(0);
    for (const resolve of waiters) resolve(snapshot);
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
): AtomicPagedTerminalOutputCoordinatorHandle => new PagedTerminalOutputCoordinator(options);
