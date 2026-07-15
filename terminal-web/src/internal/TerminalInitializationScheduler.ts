import { scheduleNextFrame, type ScheduleTurn } from './scheduleUiTurn.js';
import type { TerminalInitializationPriority } from '../types.js';

export type TerminalInitializationPermit = {
  release(): void;
};

type TerminalInitializationWaiter = {
  resolve: (permit: TerminalInitializationPermit | null) => void;
  priority: TerminalInitializationPriority;
  active: boolean;
};

export type TerminalInitializationRequest = Readonly<{
  permit: Promise<TerminalInitializationPermit | null>;
  promote: () => void;
  cancel: () => void;
}>;

export type TerminalInitializationSchedulerSnapshot = Readonly<{
  active: number;
  activeBackground: number;
  queued: number;
  queuedInteractive: number;
  queuedBackground: number;
  maxConcurrent: number;
  maxBackgroundConcurrent: number;
}>;

const DEFAULT_MAX_CONCURRENT_INITIALIZERS = 3;
const DEFAULT_MAX_BACKGROUND_INITIALIZERS = 1;

// Terminal initialization is CPU and WebGL-resource heavy. A small global gate
// keeps large live grids responsive while every mounted terminal still becomes
// a real, live terminal instead of a snapshot or paused placeholder.
export class TerminalInitializationScheduler {
  private readonly interactiveQueue: TerminalInitializationWaiter[] = [];
  private readonly backgroundQueue: TerminalInitializationWaiter[] = [];
  private activeCount = 0;
  private activeBackgroundCount = 0;
  private drainScheduled = false;

  constructor(
    private readonly maxConcurrent = DEFAULT_MAX_CONCURRENT_INITIALIZERS,
    private readonly scheduleTurn: ScheduleTurn = scheduleNextFrame,
    private readonly maxBackgroundConcurrent = DEFAULT_MAX_BACKGROUND_INITIALIZERS,
  ) {}

  request(priority: TerminalInitializationPriority = 'interactive'): TerminalInitializationRequest {
    let waiter!: TerminalInitializationWaiter;
    const permit = new Promise<TerminalInitializationPermit | null>(resolve => {
      waiter = { resolve, priority, active: true };
      this.queueFor(priority).push(waiter);
      this.scheduleDrain();
    });

    return {
      permit,
      promote: () => {
        if (!waiter.active || waiter.priority === 'interactive') return;
        const index = this.backgroundQueue.indexOf(waiter);
        if (index < 0) return;
        this.backgroundQueue.splice(index, 1);
        waiter.priority = 'interactive';
        this.interactiveQueue.push(waiter);
        this.scheduleDrain();
      },
      cancel: () => {
        if (!waiter.active) return;
        const queue = this.queueFor(waiter.priority);
        const index = queue.indexOf(waiter);
        if (index < 0) return;
        queue.splice(index, 1);
        waiter.active = false;
        waiter.resolve(null);
      },
    };
  }

  getSnapshot(): TerminalInitializationSchedulerSnapshot {
    return {
      active: this.activeCount,
      activeBackground: this.activeBackgroundCount,
      queued: this.interactiveQueue.length + this.backgroundQueue.length,
      queuedInteractive: this.interactiveQueue.length,
      queuedBackground: this.backgroundQueue.length,
      maxConcurrent: this.maxConcurrent,
      maxBackgroundConcurrent: this.maxBackgroundConcurrent,
    };
  }

  private queueFor(priority: TerminalInitializationPriority): TerminalInitializationWaiter[] {
    return priority === 'background' ? this.backgroundQueue : this.interactiveQueue;
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
    while (this.activeCount < this.maxConcurrent) {
      const waiter = this.interactiveQueue.shift()
        ?? (this.activeBackgroundCount < this.maxBackgroundConcurrent
          ? this.backgroundQueue.shift()
          : undefined);
      if (!waiter) {
        break;
      }
      if (!waiter.active) {
        continue;
      }

      waiter.active = false;
      this.activeCount += 1;
      if (waiter.priority === 'background') this.activeBackgroundCount += 1;
      let released = false;
      waiter.resolve({
        release: () => {
          if (released) {
            return;
          }
          released = true;
          this.activeCount = Math.max(0, this.activeCount - 1);
          if (waiter.priority === 'background') {
            this.activeBackgroundCount = Math.max(0, this.activeBackgroundCount - 1);
          }
          if (this.interactiveQueue.length > 0 || this.backgroundQueue.length > 0) {
            this.scheduleDrain();
          }
        },
      });
    }
  }
}

export const terminalInitializationScheduler = new TerminalInitializationScheduler();

export const getTerminalInitializationSchedulerStats = (): TerminalInitializationSchedulerSnapshot => (
  terminalInitializationScheduler.getSnapshot()
);
