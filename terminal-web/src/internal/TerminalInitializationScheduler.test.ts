import { describe, expect, it } from 'vitest';
import type { TerminalInitializationPriority } from '../types';
import { TerminalInitializationScheduler } from './TerminalInitializationScheduler';

describe('TerminalInitializationScheduler', () => {
  const createHarness = (maxConcurrent = 3, maxBackgroundConcurrent = 1) => {
    const turns: Array<() => void> = [];
    const scheduler = new TerminalInitializationScheduler(maxConcurrent, callback => {
      turns.push(callback);
    }, maxBackgroundConcurrent);
    return {
      scheduler,
      runTurn: () => turns.shift()?.(),
      turns,
    };
  };

  it('prioritizes interactive work while limiting total and background concurrency', async () => {
    const harness = createHarness(3, 1);
    const backgroundOne = harness.scheduler.request('background');
    const backgroundTwo = harness.scheduler.request('background');
    const interactiveOne = harness.scheduler.request('interactive');
    const interactiveTwo = harness.scheduler.request('interactive');

    expect(harness.scheduler.getSnapshot()).toEqual({
      active: 0,
      activeBackground: 0,
      queued: 4,
      queuedInteractive: 2,
      queuedBackground: 2,
      maxConcurrent: 3,
      maxBackgroundConcurrent: 1,
    });

    harness.runTurn();

    const firstInteractivePermit = await interactiveOne.permit;
    const secondInteractivePermit = await interactiveTwo.permit;
    const firstBackgroundPermit = await backgroundOne.permit;
    let secondBackgroundResolved = false;
    backgroundTwo.permit.then(() => {
      secondBackgroundResolved = true;
    });
    await Promise.resolve();

    expect(secondBackgroundResolved).toBe(false);
    expect(harness.scheduler.getSnapshot()).toEqual({
      active: 3,
      activeBackground: 1,
      queued: 1,
      queuedInteractive: 0,
      queuedBackground: 1,
      maxConcurrent: 3,
      maxBackgroundConcurrent: 1,
    });

    firstInteractivePermit?.release();
    harness.runTurn();
    await Promise.resolve();
    expect(secondBackgroundResolved).toBe(false);

    firstBackgroundPermit?.release();
    harness.runTurn();
    const secondBackgroundPermit = await backgroundTwo.permit;
    expect(secondBackgroundPermit).not.toBeNull();
    expect(harness.scheduler.getSnapshot().activeBackground).toBe(1);

    secondInteractivePermit?.release();
    secondBackgroundPermit?.release();
    harness.runTurn();
    expect(harness.scheduler.getSnapshot().active).toBe(0);
  });

  it.each(['interactive', 'background'] as const)('keeps %s requests FIFO', async (priority) => {
    const harness = createHarness(1, 1);
    const order: number[] = [];
    const requests = [1, 2, 3].map(index => {
      const request = harness.scheduler.request(priority);
      request.permit.then(permit => {
        if (permit) order.push(index);
      });
      return request;
    });

    harness.runTurn();
    const firstPermit = await requests[0]!.permit;
    expect(order).toEqual([1]);

    firstPermit?.release();
    harness.runTurn();
    const secondPermit = await requests[1]!.permit;
    expect(order).toEqual([1, 2]);

    secondPermit?.release();
    harness.runTurn();
    const thirdPermit = await requests[2]!.permit;
    expect(order).toEqual([1, 2, 3]);

    thirdPermit?.release();
    harness.runTurn();
  });

  it('promotes queued background work ahead of the background queue', async () => {
    const harness = createHarness(1, 1);
    const blocker = harness.scheduler.request('interactive');
    const backgroundOne = harness.scheduler.request('background');
    const backgroundTwo = harness.scheduler.request('background');

    harness.runTurn();
    const blockerPermit = await blocker.permit;
    backgroundTwo.promote();

    expect(harness.scheduler.getSnapshot()).toMatchObject({
      active: 1,
      queuedInteractive: 1,
      queuedBackground: 1,
    });

    blockerPermit?.release();
    harness.runTurn();
    const promotedPermit = await backgroundTwo.permit;
    let firstBackgroundResolved = false;
    backgroundOne.permit.then(() => {
      firstBackgroundResolved = true;
    });
    await Promise.resolve();

    expect(promotedPermit).not.toBeNull();
    expect(firstBackgroundResolved).toBe(false);
    expect(harness.scheduler.getSnapshot().activeBackground).toBe(0);

    promotedPermit?.release();
    harness.runTurn();
    const firstBackgroundPermit = await backgroundOne.permit;
    firstBackgroundPermit?.release();
    harness.runTurn();
  });

  it.each(['interactive', 'background'] as const)('cancels queued %s work without consuming capacity', async (priority: TerminalInitializationPriority) => {
    const harness = createHarness(1, 1);
    const blocker = harness.scheduler.request('interactive');
    const cancelled = harness.scheduler.request(priority);
    const survivor = harness.scheduler.request('interactive');

    harness.runTurn();
    const blockerPermit = await blocker.permit;
    cancelled.cancel();

    expect(await cancelled.permit).toBeNull();
    expect(harness.scheduler.getSnapshot().queued).toBe(1);

    blockerPermit?.release();
    harness.runTurn();
    const survivorPermit = await survivor.permit;
    expect(survivorPermit).not.toBeNull();
    expect(harness.scheduler.getSnapshot().active).toBe(1);

    survivorPermit?.release();
    survivorPermit?.release();
    harness.runTurn();
    expect(harness.scheduler.getSnapshot().active).toBe(0);
  });
});
