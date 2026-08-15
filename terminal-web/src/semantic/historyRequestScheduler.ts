const scheduler = new class {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= 2) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}();

export const runSemanticHistoryRequest = async <T>(operation: () => Promise<T>): Promise<T> => (
  await scheduler.run(operation)
);
