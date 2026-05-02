export type TerminalRenderTask = {
  id: number;
  run: (forceAll: boolean) => void;
};

export type TerminalRenderSchedulerStats = {
  scheduled: number;
  rendered: number;
  canceled: number;
  frameCount: number;
  forceAllRequests: number;
  forceAllUpgrades: number;
  pending: number;
  lastFrameDurationMs: number;
  lastFrameRendered: number;
};

type SchedulerClock = () => number;

type SchedulerOptions = {
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  now?: SchedulerClock;
};

type PendingRenderTask = {
  task: TerminalRenderTask;
  forceAll: boolean;
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

const createEmptyStats = (): Omit<TerminalRenderSchedulerStats, 'pending'> => ({
  scheduled: 0,
  rendered: 0,
  canceled: 0,
  frameCount: 0,
  forceAllRequests: 0,
  forceAllUpgrades: 0,
  lastFrameDurationMs: 0,
  lastFrameRendered: 0,
});

export class TerminalRenderScheduler {
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly now: SchedulerClock;
  private readonly pending = new Map<number, PendingRenderTask>();
  private frameHandle: number | null = null;
  private stats = createEmptyStats();

  constructor(options: SchedulerOptions = {}) {
    this.requestFrame = options.requestFrame ?? resolveRequestFrame();
    this.cancelFrame = options.cancelFrame ?? resolveCancelFrame();
    this.now = options.now ?? resolveNow;
  }

  schedule(task: TerminalRenderTask, forceAll = false): void {
    this.stats.scheduled += 1;
    if (forceAll) {
      this.stats.forceAllRequests += 1;
    }

    const existing = this.pending.get(task.id);
    if (existing) {
      if (forceAll && !existing.forceAll) {
        existing.forceAll = true;
        this.stats.forceAllUpgrades += 1;
      }
    } else {
      this.pending.set(task.id, { task, forceAll });
    }

    this.ensureFrame();
  }

  cancel(task: TerminalRenderTask | number): void {
    const id = typeof task === 'number' ? task : task.id;
    if (!this.pending.delete(id)) {
      return;
    }

    this.stats.canceled += 1;
    if (this.pending.size === 0 && this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  getStats(): TerminalRenderSchedulerStats {
    return {
      ...this.stats,
      pending: this.pending.size,
    };
  }

  resetStats(): void {
    this.stats = createEmptyStats();
  }

  private ensureFrame(): void {
    if (this.frameHandle !== null) {
      return;
    }

    this.frameHandle = this.requestFrame(() => {
      this.frameHandle = null;
      this.flushFrame();
    });
  }

  private flushFrame(): void {
    if (this.pending.size === 0) {
      return;
    }

    const tasks = Array.from(this.pending.values());
    this.pending.clear();

    const startedAt = this.now();
    let rendered = 0;
    for (const { task, forceAll } of tasks) {
      task.run(forceAll);
      rendered += 1;
    }

    this.stats.frameCount += 1;
    this.stats.rendered += rendered;
    this.stats.lastFrameRendered = rendered;
    this.stats.lastFrameDurationMs = Math.max(0, this.now() - startedAt);

    if (this.pending.size > 0) {
      this.ensureFrame();
    }
  }
}

export const terminalRenderScheduler = new TerminalRenderScheduler();

export const getTerminalRenderSchedulerStats = (): TerminalRenderSchedulerStats => {
  return terminalRenderScheduler.getStats();
};

export const resetTerminalRenderSchedulerStats = (): void => {
  terminalRenderScheduler.resetStats();
};
