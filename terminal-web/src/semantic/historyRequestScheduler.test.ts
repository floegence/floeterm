import { describe, expect, it } from 'vitest';
import { runSemanticHistoryRequest } from './historyRequestScheduler';

const tick = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe('semantic history request scheduler', () => {
  it('keeps one slot available for demand while prefetch is active', async () => {
    const order: string[] = [];
    let releasePrefetch: (() => void) | undefined;
    const prefetch = runSemanticHistoryRequest(async () => {
      order.push('prefetch');
      await new Promise<void>(resolve => { releasePrefetch = resolve; });
    }, { priority: 'prefetch' });
    await tick();

    const demand = runSemanticHistoryRequest(async () => { order.push('demand'); }, { priority: 'demand' });
    await demand;
    expect(order).toEqual(['prefetch', 'demand']);
    releasePrefetch?.();
    await prefetch;
  });

  it('runs waiting demand before waiting prefetch', async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const first = runSemanticHistoryRequest(async () => {
      order.push('first-demand');
      await new Promise<void>(resolve => releases.push(resolve));
    });
    const activePrefetch = runSemanticHistoryRequest(async () => {
      order.push('active-prefetch');
      await new Promise<void>(resolve => releases.push(resolve));
    }, { priority: 'prefetch' });
    const queuedPrefetch = runSemanticHistoryRequest(async () => { order.push('queued-prefetch'); }, { priority: 'prefetch' });
    const queuedDemand = runSemanticHistoryRequest(async () => { order.push('queued-demand'); });
    await tick();
    releases.shift()?.();
    await first;
    await queuedDemand;
    expect(order.slice(0, 3)).toEqual(['first-demand', 'active-prefetch', 'queued-demand']);
    releases.shift()?.();
    await activePrefetch;
    await queuedPrefetch;
  });

  it('does not start an already canceled queued prefetch', async () => {
    let release: (() => void) | undefined;
    const active = runSemanticHistoryRequest(async () => {
      await new Promise<void>(resolve => { release = resolve; });
    }, { priority: 'prefetch' });
    const controller = new AbortController();
    let called = false;
    const canceled = runSemanticHistoryRequest(async () => { called = true; }, {
      priority: 'prefetch', signal: controller.signal,
    });
    controller.abort();
    release?.();
    await active;
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    expect(called).toBe(false);
  });
});
