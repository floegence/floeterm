export type SemanticHistoryRequestPriority = 'demand' | 'prefetch';

type WaitingOperation<T> = {
  operation: () => Promise<T>;
  priority: SemanticHistoryRequestPriority;
  signal?: AbortSignal;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

class SemanticHistoryRequestScheduler {
  private active = 0;
  private activePrefetch = 0;
  private readonly demand: Array<WaitingOperation<unknown>> = [];
  private readonly prefetch: Array<WaitingOperation<unknown>> = [];

  run<T>(
    operation: () => Promise<T>,
    options: Readonly<{ priority?: SemanticHistoryRequestPriority; signal?: AbortSignal }> = {},
  ): Promise<T> {
    const priority = options.priority ?? 'demand';
    if (options.signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const waiting: WaitingOperation<T> = {
        operation, priority, signal: options.signal, resolve, reject,
      };
      (priority === 'demand' ? this.demand : this.prefetch).push(waiting as WaitingOperation<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < 2) {
      const waiting = this.next();
      if (!waiting) return;
      if (waiting.signal?.aborted) {
        waiting.reject(abortError());
        continue;
      }
      this.active += 1;
      if (waiting.priority === 'prefetch') this.activePrefetch += 1;
      void waiting.operation().then(waiting.resolve, waiting.reject).finally(() => {
        this.active -= 1;
        if (waiting.priority === 'prefetch') this.activePrefetch -= 1;
        this.drain();
      });
    }
  }

  private next(): WaitingOperation<unknown> | undefined {
    const demand = this.demand.shift();
    if (demand) return demand;
    // Reserve one global slot for foreground work. This prevents background
    // neighborhood warming in several terminals from forming a demand queue.
    if (this.activePrefetch === 0) return this.prefetch.shift();
    return undefined;
  }
}

const scheduler = new SemanticHistoryRequestScheduler();

export const runSemanticHistoryRequest = async <T>(
  operation: () => Promise<T>,
  options?: Readonly<{ priority?: SemanticHistoryRequestPriority; signal?: AbortSignal }>,
): Promise<T> => await scheduler.run(operation, options);

function abortError(): Error {
  const error = new Error('semantic history request was canceled');
  error.name = 'AbortError';
  return error;
}
