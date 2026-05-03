import { scheduleNextFrame, type ScheduleTurn } from './scheduleUiTurn';

export type TerminalInitializationPermit = {
  release(): void;
};

type TerminalInitializationWaiter = {
  resolve: (permit: TerminalInitializationPermit | null) => void;
  signal?: AbortSignal;
  onAbort: () => void;
};

const DEFAULT_MAX_CONCURRENT_INITIALIZERS = 3;

// Terminal initialization is CPU and WebGL-resource heavy. A small global gate
// keeps large live grids responsive while every mounted terminal still becomes
// a real, live terminal instead of a snapshot or paused placeholder.
export class TerminalInitializationScheduler {
  private readonly queue: TerminalInitializationWaiter[] = [];
  private activeCount = 0;
  private drainScheduled = false;

  constructor(
    private readonly maxConcurrent = DEFAULT_MAX_CONCURRENT_INITIALIZERS,
    private readonly scheduleTurn: ScheduleTurn = scheduleNextFrame,
  ) {}

  acquire(signal?: AbortSignal): Promise<TerminalInitializationPermit | null> {
    if (signal?.aborted) {
      return Promise.resolve(null);
    }

    return new Promise(resolve => {
      const waiter: TerminalInitializationWaiter = {
        resolve,
        signal,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          resolve(null);
        },
      };

      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
      this.scheduleDrain();
    });
  }

  getSnapshot(): { active: number; queued: number; maxConcurrent: number } {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
    };
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) {
      return;
    }

    this.drainScheduled = true;
    this.scheduleTurn(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const waiter = this.queue.shift();
      if (!waiter) {
        continue;
      }

      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.resolve(null);
        continue;
      }

      this.activeCount += 1;
      let released = false;
      waiter.resolve({
        release: () => {
          if (released) {
            return;
          }
          released = true;
          this.activeCount = Math.max(0, this.activeCount - 1);
          this.scheduleDrain();
        },
      });
    }
  }
}

export const terminalInitializationScheduler = new TerminalInitializationScheduler();
