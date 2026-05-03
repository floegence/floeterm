import { describe, expect, it } from 'vitest';
import { TerminalInitializationScheduler } from './TerminalInitializationScheduler';

describe('TerminalInitializationScheduler', () => {
  it('limits concurrent terminal initialization and drains queued work by turn', async () => {
    const turns: Array<() => void> = [];
    const scheduler = new TerminalInitializationScheduler(2, callback => {
      turns.push(callback);
    });

    const requests = [
      scheduler.acquire(),
      scheduler.acquire(),
      scheduler.acquire(),
      scheduler.acquire(),
    ];

    expect(scheduler.getSnapshot()).toEqual({ active: 0, queued: 4, maxConcurrent: 2 });
    turns.shift()?.();

    const first = await requests[0];
    const second = await requests[1];
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(scheduler.getSnapshot()).toEqual({ active: 2, queued: 2, maxConcurrent: 2 });

    let thirdResolved = false;
    requests[2].then(() => {
      thirdResolved = true;
    });
    await Promise.resolve();
    expect(thirdResolved).toBe(false);

    first?.release();
    expect(scheduler.getSnapshot()).toEqual({ active: 1, queued: 2, maxConcurrent: 2 });
    turns.shift()?.();

    const third = await requests[2];
    expect(third).not.toBeNull();
    expect(scheduler.getSnapshot()).toEqual({ active: 2, queued: 1, maxConcurrent: 2 });

    second?.release();
    third?.release();
    turns.shift()?.();

    const fourth = await requests[3];
    expect(fourth).not.toBeNull();
    expect(scheduler.getSnapshot()).toEqual({ active: 1, queued: 0, maxConcurrent: 2 });
    fourth?.release();
    turns.shift()?.();
    expect(scheduler.getSnapshot()).toEqual({ active: 0, queued: 0, maxConcurrent: 2 });
  });

  it('removes aborted queued initializations without consuming a permit', async () => {
    const turns: Array<() => void> = [];
    const scheduler = new TerminalInitializationScheduler(1, callback => {
      turns.push(callback);
    });
    const first = scheduler.acquire();
    const controller = new AbortController();
    const second = scheduler.acquire(controller.signal);
    const third = scheduler.acquire();

    turns.shift()?.();
    const firstPermit = await first;
    expect(firstPermit).not.toBeNull();
    expect(scheduler.getSnapshot()).toEqual({ active: 1, queued: 2, maxConcurrent: 1 });

    controller.abort();
    expect(await second).toBeNull();
    expect(scheduler.getSnapshot()).toEqual({ active: 1, queued: 1, maxConcurrent: 1 });

    firstPermit?.release();
    turns.shift()?.();

    const thirdPermit = await third;
    expect(thirdPermit).not.toBeNull();
    expect(scheduler.getSnapshot()).toEqual({ active: 1, queued: 0, maxConcurrent: 1 });
  });
});
