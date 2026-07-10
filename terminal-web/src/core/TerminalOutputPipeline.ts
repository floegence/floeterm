import { concatChunks } from '../utils/history';

export type TerminalOutputPipelineCatchUpReason =
  | 'sequence-gap'
  | 'inactive-buffer-overflow';

export interface TerminalOutputPipelineChunk {
  data: Uint8Array;
  sequence?: number;
  timestampMs?: number;
}

export interface TerminalOutputPipelinePolicy {
  maxLiveBatchChunks: number;
  maxLiveBatchBytes: number;
  maxInactiveChunks: number;
  maxInactiveBytes: number;
}

export interface TerminalOutputPipelineCatchUpRequest {
  reason: TerminalOutputPipelineCatchUpReason;
  startSequence: number;
  expectedSequence?: number;
  observedSequence?: number;
  firstBufferedSequence?: number;
  droppedChunks: number;
  droppedBytes: number;
}

export interface TerminalOutputPipelineStats {
  enqueuedChunks: number;
  enqueuedBytes: number;
  flushedChunks: number;
  flushedBytes: number;
  droppedChunks: number;
  droppedBytes: number;
  duplicateChunks: number;
  sequenceGaps: number;
  catchUpRequests: number;
  inactiveOverflows: number;
  pendingChunks: number;
  pendingBytes: number;
  inactiveChunks: number;
  inactiveBytes: number;
  lastObservedSequence: number;
  lastAppliedSequence: number;
  catchUpPending: boolean;
  disposed: boolean;
}

export interface TerminalOutputPipelineDrainState {
  livePending: boolean;
  inactivePending: boolean;
  catchUpPending: boolean;
  drainPending: boolean;
  disposed: boolean;
}

export interface TerminalOutputPipelineScheduler {
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  now?: () => number;
}

export interface TerminalOutputPipelineOptions {
  write: (data: Uint8Array, chunks: readonly TerminalOutputPipelineChunk[]) => void;
  isInteractive?: () => boolean;
  requestCatchUp?: (request: TerminalOutputPipelineCatchUpRequest) => void;
  onDrain?: () => void;
  policy?: Partial<TerminalOutputPipelinePolicy>;
  scheduler?: TerminalOutputPipelineScheduler;
  startSequence?: number;
}

export interface TerminalOutputPipelineResetOptions {
  startSequence?: number;
  resetStats?: boolean;
}

export interface TerminalOutputPipelineHandle {
  enqueue(chunk: TerminalOutputPipelineChunk): void;
  flush(): void;
  reset(options?: TerminalOutputPipelineResetOptions): void;
  dispose(): void;
  getStats(): TerminalOutputPipelineStats;
  getDrainState(): TerminalOutputPipelineDrainState;
}

const DEFAULT_POLICY: TerminalOutputPipelinePolicy = {
  maxLiveBatchChunks: 64,
  maxLiveBatchBytes: 256 * 1024,
  maxInactiveChunks: 256,
  maxInactiveBytes: 512 * 1024,
};

const resolveRequestFrame = (): ((callback: FrameRequestCallback) => number) => {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame.bind(globalThis);
  }
  return callback => setTimeout(() => callback(resolveNow()), 16) as unknown as number;
};

const resolveCancelFrame = (): ((handle: number) => void) => {
  if (typeof cancelAnimationFrame === 'function') {
    return cancelAnimationFrame.bind(globalThis);
  }
  return handle => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
};

const resolveNow = (): number => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
};

const createEmptyStats = () => ({
  enqueuedChunks: 0,
  enqueuedBytes: 0,
  flushedChunks: 0,
  flushedBytes: 0,
  droppedChunks: 0,
  droppedBytes: 0,
  duplicateChunks: 0,
  sequenceGaps: 0,
  catchUpRequests: 0,
  inactiveOverflows: 0,
});

const normalizePositiveInteger = (value: number | undefined, fallback: number): number => {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
};

const normalizePolicy = (policy: Partial<TerminalOutputPipelinePolicy> | undefined): TerminalOutputPipelinePolicy => ({
  maxLiveBatchChunks: normalizePositiveInteger(policy?.maxLiveBatchChunks, DEFAULT_POLICY.maxLiveBatchChunks),
  maxLiveBatchBytes: normalizePositiveInteger(policy?.maxLiveBatchBytes, DEFAULT_POLICY.maxLiveBatchBytes),
  maxInactiveChunks: normalizePositiveInteger(policy?.maxInactiveChunks, DEFAULT_POLICY.maxInactiveChunks),
  maxInactiveBytes: normalizePositiveInteger(policy?.maxInactiveBytes, DEFAULT_POLICY.maxInactiveBytes),
});

const normalizeSequence = (sequence: number | undefined): number | undefined => {
  return typeof sequence === 'number' && Number.isFinite(sequence) && sequence > 0
    ? Math.floor(sequence)
    : undefined;
};

const normalizeStartSequence = (sequence: number | undefined): number => {
  return normalizeSequence(sequence) ?? 1;
};

const countChunkBytes = (chunks: readonly TerminalOutputPipelineChunk[]): number => {
  return chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
};

const takeChunkBatch = (
  queue: TerminalOutputPipelineChunk[],
  maxChunks: number,
  maxBytes: number,
): TerminalOutputPipelineChunk[] => {
  if (queue.length === 0) {
    return [];
  }

  let count = 0;
  let byteLength = 0;
  while (count < queue.length && count < maxChunks) {
    const next = queue[count];
    if (!next) {
      break;
    }
    if (count > 0 && byteLength + next.data.byteLength > maxBytes) {
      break;
    }
    byteLength += next.data.byteLength;
    count += 1;
    if (byteLength >= maxBytes) {
      break;
    }
  }

  return queue.splice(0, Math.max(1, count));
};

class TerminalOutputPipeline implements TerminalOutputPipelineHandle {
  private readonly write: TerminalOutputPipelineOptions['write'];
  private readonly isInteractive: () => boolean;
  private readonly requestCatchUp: TerminalOutputPipelineOptions['requestCatchUp'];
  private readonly onDrain: TerminalOutputPipelineOptions['onDrain'];
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly policy: TerminalOutputPipelinePolicy;

  private liveQueue: TerminalOutputPipelineChunk[] = [];
  private liveBytes = 0;
  private inactiveQueue: TerminalOutputPipelineChunk[] = [];
  private inactiveBytes = 0;
  private queuedSequences = new Set<number>();
  private frameHandle: number | null = null;
  private disposed = false;
  private catchUpPending = false;
  private lastObservedSequence: number;
  private lastAppliedSequence: number;
  private stats = createEmptyStats();

  constructor(options: TerminalOutputPipelineOptions) {
    this.write = options.write;
    this.isInteractive = options.isInteractive ?? (() => true);
    this.requestCatchUp = options.requestCatchUp;
    this.onDrain = options.onDrain;
    this.requestFrame = options.scheduler?.requestFrame ?? resolveRequestFrame();
    this.cancelFrame = options.scheduler?.cancelFrame ?? resolveCancelFrame();
    this.policy = normalizePolicy(options.policy);

    const startSequence = normalizeStartSequence(options.startSequence);
    this.lastObservedSequence = startSequence - 1;
    this.lastAppliedSequence = startSequence - 1;
  }

  enqueue(chunk: TerminalOutputPipelineChunk): void {
    if (this.disposed) {
      return;
    }

    if (this.catchUpPending) {
      this.stats.droppedChunks += 1;
      this.stats.droppedBytes += chunk.data.byteLength;
      return;
    }

    const sequence = normalizeSequence(chunk.sequence);
    const normalizedChunk: TerminalOutputPipelineChunk = sequence
      ? { ...chunk, sequence }
      : chunk;
    if (!this.acceptSequence(sequence, normalizedChunk.data.byteLength)) {
      return;
    }

    this.stats.enqueuedChunks += 1;
    this.stats.enqueuedBytes += normalizedChunk.data.byteLength;

    if (normalizedChunk.data.byteLength === 0) {
      this.markApplied([normalizedChunk]);
      this.emitDrainIfIdle();
      return;
    }

    if (!this.isInteractive()) {
      this.enqueueInactive(normalizedChunk);
      return;
    }

    this.liveQueue.push(normalizedChunk);
    this.liveBytes += normalizedChunk.data.byteLength;
    this.scheduleFrame();
  }

  flush(): void {
    if (this.disposed || this.catchUpPending) {
      return;
    }

    if (!this.isInteractive()) {
      this.deferLiveQueue();
      return;
    }

    this.promoteInactiveQueue();
    if (this.liveQueue.length === 0) {
      this.emitDrainIfIdle();
      return;
    }
    this.scheduleFrame();
  }

  reset(options: TerminalOutputPipelineResetOptions = {}): void {
    this.cancelFrameIfScheduled();
    this.clearQueues();
    this.catchUpPending = false;

    const startSequence = normalizeStartSequence(options.startSequence);
    this.lastObservedSequence = startSequence - 1;
    this.lastAppliedSequence = startSequence - 1;

    if (options.resetStats) {
      this.stats = createEmptyStats();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelFrameIfScheduled();
    this.clearQueues();
    this.catchUpPending = false;
  }

  getStats(): TerminalOutputPipelineStats {
    return {
      ...this.stats,
      pendingChunks: this.liveQueue.length,
      pendingBytes: this.liveBytes,
      inactiveChunks: this.inactiveQueue.length,
      inactiveBytes: this.inactiveBytes,
      lastObservedSequence: this.lastObservedSequence,
      lastAppliedSequence: this.lastAppliedSequence,
      catchUpPending: this.catchUpPending,
      disposed: this.disposed,
    };
  }

  getDrainState(): TerminalOutputPipelineDrainState {
    const livePending = this.liveQueue.length > 0 || this.frameHandle !== null;
    const inactivePending = this.inactiveQueue.length > 0;
    const catchUpPending = this.catchUpPending;
    return {
      livePending,
      inactivePending,
      catchUpPending,
      drainPending: livePending || inactivePending || catchUpPending,
      disposed: this.disposed,
    };
  }

  private acceptSequence(sequence: number | undefined, byteLength: number): boolean {
    if (!sequence) {
      return true;
    }

    if (sequence <= this.lastAppliedSequence || this.queuedSequences.has(sequence)) {
      this.stats.duplicateChunks += 1;
      return false;
    }

    const expectedSequence = Math.max(this.lastObservedSequence, this.lastAppliedSequence) + 1;
    if (sequence > expectedSequence) {
      this.stats.sequenceGaps += 1;
      if (this.requestCatchUp) {
        this.requestCatchUpForGap(sequence, expectedSequence, byteLength);
        return false;
      }
    }

    this.lastObservedSequence = Math.max(this.lastObservedSequence, sequence);
    this.queuedSequences.add(sequence);
    return true;
  }

  private requestCatchUpForGap(
    observedSequence: number,
    expectedSequence: number,
    currentChunkBytes: number,
  ): void {
    const droppedChunks = this.liveQueue.length + this.inactiveQueue.length + 1;
    const droppedBytes = this.liveBytes + this.inactiveBytes + currentChunkBytes;
    const startSequence = this.lastAppliedSequence > 0 ? this.lastAppliedSequence + 1 : 0;

    this.clearQueues();
    this.cancelFrameIfScheduled();
    this.catchUpPending = true;
    this.stats.catchUpRequests += 1;
    this.stats.droppedChunks += droppedChunks;
    this.stats.droppedBytes += droppedBytes;
    this.requestCatchUp?.({
      reason: 'sequence-gap',
      startSequence,
      expectedSequence,
      observedSequence,
      droppedChunks,
      droppedBytes,
    });
  }

  private requestCatchUpForInactiveOverflow(nextChunk: TerminalOutputPipelineChunk): void {
    const droppedChunks = this.liveQueue.length + this.inactiveQueue.length + 1;
    const droppedBytes = this.liveBytes + this.inactiveBytes + nextChunk.data.byteLength;
    const firstBufferedSequence = this.findFirstBufferedSequence();
    const startSequence = firstBufferedSequence ?? (this.lastAppliedSequence > 0 ? this.lastAppliedSequence + 1 : 0);

    this.clearQueues();
    this.cancelFrameIfScheduled();
    this.catchUpPending = true;
    this.stats.catchUpRequests += 1;
    this.stats.inactiveOverflows += 1;
    this.stats.droppedChunks += droppedChunks;
    this.stats.droppedBytes += droppedBytes;
    this.requestCatchUp?.({
      reason: 'inactive-buffer-overflow',
      startSequence,
      firstBufferedSequence,
      droppedChunks,
      droppedBytes,
    });
  }

  private enqueueInactive(chunk: TerminalOutputPipelineChunk): void {
    const nextBytes = this.inactiveBytes + chunk.data.byteLength;
    if (
      this.inactiveQueue.length >= this.policy.maxInactiveChunks
      || nextBytes > this.policy.maxInactiveBytes
    ) {
      if (this.requestCatchUp) {
        this.requestCatchUpForInactiveOverflow(chunk);
        return;
      }
      this.evictInactiveUntilFits(chunk);
    }

    if (chunk.data.byteLength > this.policy.maxInactiveBytes) {
      this.dropAcceptedChunk(chunk);
      this.stats.inactiveOverflows += 1;
      return;
    }

    this.inactiveQueue.push(chunk);
    this.inactiveBytes += chunk.data.byteLength;
  }

  private evictInactiveUntilFits(chunk: TerminalOutputPipelineChunk): void {
    this.stats.inactiveOverflows += 1;
    while (
      this.inactiveQueue.length > 0
      && (
        this.inactiveQueue.length >= this.policy.maxInactiveChunks
        || this.inactiveBytes + chunk.data.byteLength > this.policy.maxInactiveBytes
      )
    ) {
      const dropped = this.inactiveQueue.shift();
      if (!dropped) {
        break;
      }
      this.inactiveBytes -= dropped.data.byteLength;
      this.forgetQueuedSequence(dropped);
      this.stats.droppedChunks += 1;
      this.stats.droppedBytes += dropped.data.byteLength;
    }
  }

  private deferLiveQueue(): void {
    if (this.liveQueue.length === 0) {
      return;
    }
    this.cancelFrameIfScheduled();
    const pending = this.liveQueue;
    this.liveQueue = [];
    this.liveBytes = 0;
    for (const chunk of pending) {
      this.enqueueInactive(chunk);
      if (this.catchUpPending) {
        return;
      }
    }
  }

  private promoteInactiveQueue(): void {
    if (this.inactiveQueue.length === 0) {
      return;
    }
    this.liveQueue.push(...this.inactiveQueue);
    this.liveBytes += this.inactiveBytes;
    this.inactiveQueue = [];
    this.inactiveBytes = 0;
  }

  private scheduleFrame(): void {
    if (this.frameHandle !== null || this.disposed || this.catchUpPending) {
      return;
    }

    this.frameHandle = this.requestFrame(() => {
      this.frameHandle = null;
      this.flushFrame();
    });
  }

  private flushFrame(): void {
    if (this.disposed || this.catchUpPending) {
      return;
    }

    if (!this.isInteractive()) {
      this.deferLiveQueue();
      return;
    }

    this.promoteInactiveQueue();
    const batch = takeChunkBatch(
      this.liveQueue,
      this.policy.maxLiveBatchChunks,
      this.policy.maxLiveBatchBytes,
    );
    if (batch.length === 0) {
      this.emitDrainIfIdle();
      return;
    }

    this.liveBytes -= countChunkBytes(batch);
    const payload = batch.length === 1 ? batch[0]!.data : concatChunks(batch.map(chunk => chunk.data));
    if (payload.byteLength > 0) {
      this.write(payload, batch);
    }
    this.markApplied(batch);

    this.stats.flushedChunks += batch.length;
    this.stats.flushedBytes += payload.byteLength;

    if (this.liveQueue.length > 0) {
      this.scheduleFrame();
      return;
    }

    this.emitDrainIfIdle();
  }

  private markApplied(chunks: readonly TerminalOutputPipelineChunk[]): void {
    for (const chunk of chunks) {
      const sequence = normalizeSequence(chunk.sequence);
      if (!sequence) {
        continue;
      }
      this.queuedSequences.delete(sequence);
      if (sequence > this.lastAppliedSequence) {
        this.lastAppliedSequence = sequence;
      }
    }
  }

  private dropAcceptedChunk(chunk: TerminalOutputPipelineChunk): void {
    this.forgetQueuedSequence(chunk);
    this.stats.droppedChunks += 1;
    this.stats.droppedBytes += chunk.data.byteLength;
  }

  private forgetQueuedSequence(chunk: TerminalOutputPipelineChunk): void {
    const sequence = normalizeSequence(chunk.sequence);
    if (sequence) {
      this.queuedSequences.delete(sequence);
    }
  }

  private findFirstBufferedSequence(): number | undefined {
    let first: number | undefined;
    for (const chunk of [...this.inactiveQueue, ...this.liveQueue]) {
      const sequence = normalizeSequence(chunk.sequence);
      if (sequence && (first === undefined || sequence < first)) {
        first = sequence;
      }
    }
    return first;
  }

  private clearQueues(): void {
    this.liveQueue = [];
    this.liveBytes = 0;
    this.inactiveQueue = [];
    this.inactiveBytes = 0;
    this.queuedSequences.clear();
  }

  private cancelFrameIfScheduled(): void {
    if (this.frameHandle === null) {
      return;
    }
    this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
  }

  private emitDrainIfIdle(): void {
    if (
      this.disposed
      || this.catchUpPending
      || this.liveQueue.length > 0
      || this.inactiveQueue.length > 0
      || this.frameHandle !== null
    ) {
      return;
    }
    this.onDrain?.();
  }
}

export const createTerminalOutputPipeline = (
  options: TerminalOutputPipelineOptions,
): TerminalOutputPipelineHandle => {
  return new TerminalOutputPipeline(options);
};
