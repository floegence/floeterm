import { describe, expect, it, vi } from 'vitest';
import { TerminalRenderScheduler, type TerminalRenderTask } from './TerminalRenderScheduler';

const createHarness = (options?: { frameBudgetMs?: number; maxTasksPerFrame?: number }) => {
  const callbacks: FrameRequestCallback[] = [];
  let now = 0;
  const scheduler = new TerminalRenderScheduler({
    requestFrame: callback => {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancelFrame: handle => {
      callbacks[handle - 1] = () => {};
    },
    now: () => now,
    ...options,
  });

  const flushNextFrame = (advanceMs = 1) => {
    const callback = callbacks.shift();
    if (!callback) {
      throw new Error('No frame is pending');
    }
    now += advanceMs;
    callback(now);
    now += advanceMs;
  };

  return {
    scheduler,
    callbacks,
    flushNextFrame,
  };
};

type TestRenderTask = TerminalRenderTask & {
  run: ReturnType<typeof vi.fn<(forceAll: boolean) => void>>;
};

const createTask = (id: number): TestRenderTask => {
  const run = vi.fn();
  const task: TestRenderTask = { id, run };
  return task;
};

describe('TerminalRenderScheduler', () => {
  it('dedupes the same terminal in one frame', () => {
    const { scheduler, flushNextFrame } = createHarness();
    const task = createTask(1);

    scheduler.schedule(task, false);
    scheduler.schedule(task, false);
    flushNextFrame();

    expect(task.run).toHaveBeenCalledTimes(1);
    expect(task.run).toHaveBeenCalledWith(false);
    expect(scheduler.getStats()).toMatchObject({
      scheduled: 2,
      rendered: 1,
      frameCount: 1,
      lastFrameRendered: 1,
      pending: 0,
    });
  });

  it('upgrades forceAll but never downgrades it in the same frame', () => {
    const { scheduler, flushNextFrame } = createHarness();
    const task = createTask(1);

    scheduler.schedule(task, false);
    scheduler.schedule(task, true);
    scheduler.schedule(task, false);
    flushNextFrame();

    expect(task.run).toHaveBeenCalledTimes(1);
    expect(task.run).toHaveBeenCalledWith(true);
    expect(scheduler.getStats()).toMatchObject({
      forceAllRequests: 1,
      forceAllUpgrades: 1,
    });
  });

  it('preserves first schedule ordering across terminals', () => {
    const { scheduler, flushNextFrame } = createHarness();
    const order: string[] = [];
    const first: TerminalRenderTask = { id: 1, run: vi.fn(() => order.push('first')) };
    const second: TerminalRenderTask = { id: 2, run: vi.fn(() => order.push('second')) };
    const third: TerminalRenderTask = { id: 3, run: vi.fn(() => order.push('third')) };

    scheduler.schedule(second, false);
    scheduler.schedule(first, false);
    scheduler.schedule(second, true);
    scheduler.schedule(third, false);
    flushNextFrame();

    expect(order).toEqual(['second', 'first', 'third']);
    expect(second.run).toHaveBeenCalledWith(true);
  });

  it('cancels a pending task before the frame flushes', () => {
    const { scheduler, flushNextFrame } = createHarness();
    const first = createTask(1);
    const second = createTask(2);

    scheduler.schedule(first, false);
    scheduler.schedule(second, false);
    scheduler.cancel(first);
    flushNextFrame();

    expect(first.run).not.toHaveBeenCalled();
    expect(second.run).toHaveBeenCalledTimes(1);
    expect(scheduler.getStats()).toMatchObject({
      canceled: 1,
      rendered: 1,
    });
  });

  it('moves reentrant schedules to the next frame', () => {
    const { scheduler, flushNextFrame, callbacks } = createHarness();
    const task: TerminalRenderTask = {
      id: 1,
      run: vi.fn(() => {
        scheduler.schedule(task, true);
      }),
    };

    scheduler.schedule(task, false);
    flushNextFrame();

    expect(task.run).toHaveBeenCalledTimes(1);
    expect(task.run).toHaveBeenCalledWith(false);
    expect(callbacks).toHaveLength(1);

    flushNextFrame();

    expect(task.run).toHaveBeenCalledTimes(2);
    expect(task.run).toHaveBeenLastCalledWith(true);
    expect(scheduler.getStats()).toMatchObject({
      frameCount: 2,
      rendered: 2,
    });
  });

  it('spreads large render queues across frames by budget', () => {
    const { scheduler, flushNextFrame, callbacks } = createHarness({
      frameBudgetMs: 2,
      maxTasksPerFrame: 2,
    });
    const tasks = [createTask(1), createTask(2), createTask(3), createTask(4), createTask(5)];

    for (const task of tasks) {
      scheduler.schedule(task, false);
    }

    flushNextFrame();
    expect(tasks.map(task => task.run.mock.calls.length)).toEqual([1, 1, 0, 0, 0]);
    expect(callbacks).toHaveLength(1);
    expect(scheduler.getStats()).toMatchObject({
      frameCount: 1,
      lastFrameRendered: 2,
      pending: 3,
    });

    flushNextFrame();
    expect(tasks.map(task => task.run.mock.calls.length)).toEqual([1, 1, 1, 1, 0]);
    expect(scheduler.getStats()).toMatchObject({
      frameCount: 2,
      lastFrameRendered: 2,
      pending: 1,
    });

    flushNextFrame();
    expect(tasks.map(task => task.run.mock.calls.length)).toEqual([1, 1, 1, 1, 1]);
    expect(scheduler.getStats()).toMatchObject({
      frameCount: 3,
      lastFrameRendered: 1,
      pending: 0,
    });
  });

  it('resets cumulative counters while keeping pending queue state visible', () => {
    const { scheduler } = createHarness();
    const task = createTask(1);

    scheduler.schedule(task, false);
    scheduler.resetStats();

    expect(scheduler.getStats()).toMatchObject({
      scheduled: 0,
      rendered: 0,
      frameCount: 0,
      pending: 1,
    });
  });
});
