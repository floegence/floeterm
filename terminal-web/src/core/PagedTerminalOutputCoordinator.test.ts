import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPagedTerminalOutputCoordinator,
  type PagedTerminalHistoryPage,
} from './PagedTerminalOutputCoordinator';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const chunk = (sequence: number, data = String(sequence)) => ({
  sequence,
  data: encoder.encode(data),
});
const page = (overrides: Partial<PagedTerminalHistoryPage> = {}): PagedTerminalHistoryPage => ({
  chunks: [],
  hasMore: false,
  coveredThroughSequence: 0,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PagedTerminalOutputCoordinator', () => {
  it('publishes baseline readiness only after the history writer completes', async () => {
    let completeWrite: (() => void) | undefined;
    const historyWrite = new Promise<void>(resolve => { completeWrite = resolve; });
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage: async () => page({ chunks: [chunk(1, 'one')], coveredThroughSequence: 1 }),
      write: () => {},
      writeHistory: () => historyWrite,
    });

    const attach = coordinator.attach(1);
    const baseline = coordinator.waitForBaseline();
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('initial-replay'));
    expect(coordinator.getSnapshot().baselineReady).toBe(false);
    completeWrite?.();
    await attach;

    expect((await baseline).baselineReady).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({ baselineReady: true, state: 'live' });
    coordinator.dispose();
  });

  it('distinguishes explicit zero coverage from a missing contract field', async () => {
    const valid = createPagedTerminalOutputCoordinator({
      fetchPage: async () => page({ coveredThroughSequence: 0 }),
      write: () => {},
    });
    await valid.attach(0);
    expect(valid.getSnapshot()).toMatchObject({ baselineReady: true, failure: null });
    valid.dispose();

    const missing = createPagedTerminalOutputCoordinator({
      fetchPage: async () => ({ chunks: [], hasMore: false } as unknown as PagedTerminalHistoryPage),
      write: () => {},
      policy: { retryDelaysMs: [] },
    });
    await missing.attach(0);
    expect(missing.getSnapshot()).toMatchObject({
      baselineReady: false,
      state: 'failed',
      failure: { code: 'history_contract_missing', retryable: false },
    });
    missing.dispose();
  });

  it('rejects malformed sequence metadata without guessing from chunks', async () => {
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage: async () => page({ coveredThroughSequence: -1 }),
      write: () => {},
      policy: { retryDelaysMs: [] },
    });
    await coordinator.attach(0);
    expect(coordinator.getSnapshot().failure?.code).toBe('history_contract_invalid');
    coordinator.dispose();
  });

  it('ignores a late fetch from an obsolete attach generation', async () => {
    let resolveObsolete: ((value: PagedTerminalHistoryPage) => void) | undefined;
    const obsolete = new Promise<PagedTerminalHistoryPage>(resolve => { resolveObsolete = resolve; });
    const writes: string[] = [];
    const fetchPage = vi.fn()
      .mockReturnValueOnce(obsolete)
      .mockResolvedValueOnce(page({ chunks: [chunk(2, 'current')], coveredThroughSequence: 2 }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => { writes.push(decoder.decode(data)); },
    });

    const firstAttach = coordinator.attach(1);
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
    await coordinator.attach(2);
    resolveObsolete?.(page({ chunks: [chunk(1, 'obsolete')], coveredThroughSequence: 1 }));
    await firstAttach;

    expect(writes.join('')).toBe('current');
    expect(coordinator.getSnapshot()).toMatchObject({ baselineReady: true, coveredThroughSequence: 2 });
    coordinator.dispose();
  });

  it('does not let an obsolete write completion block a new attach', async () => {
    const neverCompletes = new Promise<void>(() => {});
    let historyWriteCount = 0;
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page({ chunks: [chunk(1, 'obsolete')], coveredThroughSequence: 1 }))
      .mockResolvedValueOnce(page({ chunks: [chunk(2, 'current')], coveredThroughSequence: 2 }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: () => {},
      writeHistory: () => {
        historyWriteCount += 1;
        return historyWriteCount === 1 ? neverCompletes : Promise.resolve();
      },
    });

    void coordinator.attach(1);
    await vi.waitFor(() => expect(historyWriteCount).toBe(1));
    await coordinator.attach(2);

    expect(coordinator.getSnapshot()).toMatchObject({ baselineReady: true, coveredThroughSequence: 2 });
    coordinator.dispose();
  });

  it('replays sparse pages and deduplicates live output buffered during attach', async () => {
    const writes: string[] = [];
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page({
        chunks: [chunk(2, 'two')],
        hasMore: true,
        nextCursor: 'next',
        firstAvailableSequence: 1,
        coveredThroughSequence: 3,
      }))
      .mockResolvedValueOnce(page({
        chunks: [chunk(5, 'five')],
        coveredThroughSequence: 6,
      }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
    });

    const attach = coordinator.attach(1);
    coordinator.pushLive(chunk(4, 'sparse-live-four'));
    coordinator.pushLive(chunk(5, 'duplicate-five'));
    coordinator.pushLive(chunk(7, 'seven'));
    await attach;
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(writes.join('')).toBe('twosparse-live-fourfiveseven');
    expect(coordinator.getSnapshot().coveredThroughSequence).toBe(7);
    coordinator.dispose();
  });

  it('accepts the first non-one live sequence after empty initial history', async () => {
    const writes: string[] = [];
    const fetchPage = vi.fn().mockResolvedValue(page({ coveredThroughSequence: 0 }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
    });
    await coordinator.attach(0);
    coordinator.pushLive(chunk(264, 'late-first'));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(['late-first']);
    coordinator.dispose();
  });

  it('retains inactive output and drains it without recreating the coordinator', async () => {
    const writes: string[] = [];
    const fetchPage = vi.fn().mockResolvedValue(page({ coveredThroughSequence: 1 }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
    });
    await coordinator.attach(1);
    coordinator.setActive(false);
    coordinator.pushLive(chunk(2, 'two'));
    coordinator.pushLive(chunk(3, 'three'));
    expect(writes).toEqual([]);

    coordinator.setActive(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(writes.join('')).toBe('twothree');
    expect(fetchPage).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it('catches up a live sequence gap without losing the triggering chunk', async () => {
    const writes: string[] = [];
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page({ coveredThroughSequence: 1 }))
      .mockResolvedValueOnce(page({
        chunks: [chunk(2, 'two')],
        coveredThroughSequence: 2,
      }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
    });
    await coordinator.attach(1);
    coordinator.pushLive(chunk(3, 'three'));
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('live'));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(writes.join('')).toBe('twothree');
    coordinator.dispose();
  });

  it('rebases a catch-up when history is cleared into a new generation', async () => {
    const writes: string[] = [];
    const truncations: string[] = [];
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page({
        coveredThroughSequence: 5,
        snapshotEndSequence: 5,
        historyGeneration: 1,
      }))
      .mockResolvedValueOnce(page({
        coveredThroughSequence: 0,
        snapshotEndSequence: 0,
        firstRetainedSequence: 0,
        historyGeneration: 2,
        historyReset: true,
      }))
      .mockResolvedValueOnce(page({
        chunks: [chunk(6, 'six')],
        coveredThroughSequence: 6,
        snapshotEndSequence: 6,
        firstRetainedSequence: 6,
        historyGeneration: 2,
      }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
      clear: () => writes.push('[clear]'),
      onHistoryTruncated: reason => truncations.push(reason),
      policy: { retryDelaysMs: [] },
    });

    await coordinator.attach(1);
    coordinator.pushLive(chunk(7, 'seven'));
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('live'));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ startSequence: 0 }));
    expect(coordinator.getSnapshot()).toMatchObject({
      baselineReady: true,
      state: 'live',
      failure: null,
      retainedLiveChunks: 0,
      coveredThroughSequence: 7,
    });
    expect(truncations).toEqual(['history-evicted']);
    expect(writes.join('')).toBe('[clear]sixseven');
    coordinator.dispose();
  });

  it('rebases when retention advances between history pages', async () => {
    const writes: string[] = [];
    const truncations: string[] = [];
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page({
        chunks: [chunk(1, 'one')],
        hasMore: true,
        nextCursor: 'next',
        coveredThroughSequence: 2,
        snapshotEndSequence: 6,
        firstRetainedSequence: 1,
        historyGeneration: 1,
      }))
      .mockResolvedValueOnce(page({
        coveredThroughSequence: 2,
        snapshotEndSequence: 6,
        firstRetainedSequence: 6,
        historyGeneration: 1,
        historyTruncated: true,
      }))
      .mockResolvedValueOnce(page({
        chunks: [chunk(6, 'six')],
        coveredThroughSequence: 6,
        snapshotEndSequence: 6,
        firstRetainedSequence: 6,
        historyGeneration: 1,
      }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
      writeHistory: data => writes.push(decoder.decode(data)),
      clear: () => writes.push('[clear]'),
      onHistoryTruncated: reason => truncations.push(reason),
      policy: { retryDelaysMs: [] },
    });

    await coordinator.attach(1);

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ startSequence: 6 }));
    expect(coordinator.getSnapshot()).toMatchObject({
      baselineReady: true,
      state: 'live',
      failure: null,
      coveredThroughSequence: 6,
    });
    expect(truncations).toEqual(['history-evicted']);
    expect(writes.join('')).toBe('[clear]six');
    coordinator.dispose();
  });

  it('flushes accepted live output before a following gap starts recovery', async () => {
    const writes: string[] = [];
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page({ coveredThroughSequence: 1 }))
      .mockResolvedValueOnce(page({ coveredThroughSequence: 4 }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
    });

    await coordinator.attach(1);
    coordinator.pushLive(chunk(2, 'two'));
    coordinator.pushLive(chunk(5, 'five'));
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('live'));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(writes.join('')).toBe('twofive');
    coordinator.dispose();
  });

  it('retries transient failures and keeps input live during background recovery', async () => {
    vi.useFakeTimers();
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page({ coveredThroughSequence: 1 }))
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(page({ chunks: [chunk(2)], coveredThroughSequence: 2 }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: () => {},
      policy: { retryDelaysMs: [250] },
    });
    await coordinator.attach(1);
    coordinator.pushLive(chunk(3));
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('retry-wait'));
    coordinator.pushLive(chunk(4));
    expect(coordinator.getSnapshot().retainedLiveChunks).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('live'));
    coordinator.dispose();
  });

  it('uses bounded retries when catch-up history has not reached retained live output', async () => {
    vi.useFakeTimers();
    let historyCaughtUp = false;
    const writes: string[] = [];
    const fetchPage = vi.fn().mockImplementation(async () => {
      if (fetchPage.mock.calls.length === 1) {
        return page({ coveredThroughSequence: 1 });
      }
      return historyCaughtUp
        ? page({ coveredThroughSequence: 4 })
        : page({ chunks: [chunk(2, 'two')], coveredThroughSequence: 2 });
    });
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
      policy: { retryDelaysMs: [250, 1000] },
    });

    await coordinator.attach(1);
    coordinator.pushLive(chunk(5, 'five'));
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('retry-wait'));
    expect(fetchPage).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(coordinator.getSnapshot().retryAttempt).toBe(2));
    expect(fetchPage).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('failed'));
    expect(coordinator.getSnapshot().baselineReady).toBe(true);
    expect(coordinator.getSnapshot().failure?.code).toBe('history_coverage_incomplete');
    expect(fetchPage).toHaveBeenCalledTimes(4);
    expect(coordinator.getSnapshot().retainedLiveChunks).toBe(1);
    expect(writes.join('')).toBe('two');

    historyCaughtUp = true;
    coordinator.retry();
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('live'));
    await vi.runAllTimersAsync();
    expect(writes.join('')).toBe('twofive');
    coordinator.dispose();
  });

  it('retains the rest of the live queue when draining discovers another gap', async () => {
    let releaseFirstCatchUp: ((value: PagedTerminalHistoryPage) => void) | undefined;
    const firstCatchUp = new Promise<PagedTerminalHistoryPage>(resolve => {
      releaseFirstCatchUp = resolve;
    });
    const writes: string[] = [];
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page({ coveredThroughSequence: 1 }))
      .mockReturnValueOnce(firstCatchUp)
      .mockResolvedValueOnce(page({ coveredThroughSequence: 9 }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
    });

    await coordinator.attach(1);
    coordinator.pushLive(chunk(5, 'five'));
    coordinator.pushLive(chunk(10, 'ten'));
    coordinator.pushLive(chunk(11, 'eleven'));
    releaseFirstCatchUp?.(page({ coveredThroughSequence: 4 }));

    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('live'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(writes.join('')).toBe('fiveteneleven');
    coordinator.dispose();
  });

  it('exposes manual retry after automatic retries are exhausted', async () => {
    const fetchPage = vi.fn()
      .mockRejectedValueOnce(new Error('initial'))
      .mockResolvedValueOnce(page({ coveredThroughSequence: 0 }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: () => {},
      policy: { retryDelaysMs: [] },
    });
    await coordinator.attach(1);
    expect(coordinator.getSnapshot().state).toBe('failed');
    coordinator.retry();
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('live'));
    coordinator.dispose();
  });

  it('rebases when retained live output overflows', async () => {
    let resolveFirst: ((value: PagedTerminalHistoryPage) => void) | undefined;
    const first = new Promise<PagedTerminalHistoryPage>(resolve => { resolveFirst = resolve; });
    const truncated = vi.fn();
    const cleared = vi.fn();
    const fetchPage = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(page({ chunks: [chunk(2)], coveredThroughSequence: 2 }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: () => {},
      clear: cleared,
      onHistoryTruncated: truncated,
      policy: { maxRetainedLiveChunks: 1, maxRetainedLiveBytes: 1024 },
    });
    const attaching = coordinator.attach(1);
    coordinator.pushLive(chunk(1));
    coordinator.pushLive(chunk(2));
    resolveFirst?.(page({ coveredThroughSequence: 0 }));
    await attaching;

    expect(truncated).toHaveBeenCalledWith('retained-live-overflow');
    expect(cleared).toHaveBeenCalled();
    coordinator.dispose();
  });

  it('cancels retry timers and in-flight requests on dispose', async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage: vi.fn().mockRejectedValue(new Error('offline')),
      write: () => {},
      onStateChange: snapshot => states.push(snapshot.state),
    });
    await coordinator.attach();
    expect(coordinator.getSnapshot().retryScheduled).toBe(true);
    coordinator.dispose();
    await vi.runAllTimersAsync();
    expect(states[states.length - 1]).toBe('disposed');
  });

  it('transforms each accepted chunk exactly once', async () => {
    const transform = vi.fn(item => item.data);
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage: async () => page({ chunks: [chunk(1)], coveredThroughSequence: 1 }),
      write: () => {},
      transformChunk: transform,
    });
    await coordinator.attach();
    coordinator.pushLive(chunk(1, 'duplicate'));
    coordinator.pushLive(chunk(2));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(transform.mock.calls.map(call => call[0].sequence)).toEqual([1, 2]);
    coordinator.dispose();
  });
});
