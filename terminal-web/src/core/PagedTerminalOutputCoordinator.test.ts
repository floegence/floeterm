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

  it('pins initial history to the attach snapshot fence', async () => {
    const fetchPage = vi.fn().mockResolvedValue(page({
      chunks: [chunk(4, 'four')],
      coveredThroughSequence: 4,
      snapshotEndSequence: 4,
    }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: () => {},
    });

    await coordinator.attach(1, 4);

    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({
      startSequence: 1,
      endSequence: 4,
    }));
    expect(coordinator.getSnapshot()).toMatchObject({ baselineReady: true, coveredThroughSequence: 4 });
    coordinator.dispose();
  });

  it('does not complete a recovery fence until coverage reaches it exactly', async () => {
    let resolveCompletePage: ((value: PagedTerminalHistoryPage) => void) | undefined;
    const completePage = new Promise<PagedTerminalHistoryPage>(resolve => { resolveCompletePage = resolve; });
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page({ coveredThroughSequence: 3, snapshotEndSequence: 4 }))
      .mockReturnValueOnce(completePage);
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: () => {},
      policy: { retryDelaysMs: [0] },
    });

    const attach = coordinator.attach(1, 4);
    const baseline = coordinator.waitForBaseline();
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(coordinator.getSnapshot().baselineReady).toBe(false);
    resolveCompletePage?.(page({ coveredThroughSequence: 4, snapshotEndSequence: 4 }));
    await attach;
    await expect(baseline).resolves.toMatchObject({ baselineReady: true, coveredThroughSequence: 4 });
    coordinator.dispose();
  });

  it('closes an explicit fence that has been fully evicted without a reverse range', async () => {
    const cleared = vi.fn();
    const truncated = vi.fn();
    const fetchPage = vi.fn().mockResolvedValue(page({
      coveredThroughSequence: 2,
      snapshotEndSequence: 2,
      firstRetainedSequence: 5,
      historyTruncated: true,
    }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: () => {},
      clear: cleared,
      onHistoryTruncated: truncated,
    });

    await coordinator.attach(1, 2);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ startSequence: 1, endSequence: 2 }));
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(truncated).toHaveBeenCalledWith('history-evicted');
    expect(coordinator.getSnapshot()).toMatchObject({ baselineReady: true, coveredThroughSequence: 2 });
    coordinator.dispose();
  });

  it('retains live output delivered between beginAttach and the attach boundary', async () => {
    const writes: string[] = [];
    const fetchPage = vi.fn().mockResolvedValue(page({
      chunks: [chunk(1, 'history-one')],
      coveredThroughSequence: 1,
      snapshotEndSequence: 1,
    }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
    });

    const attachGeneration = coordinator.beginAttach(1);
    coordinator.pushLive(chunk(2, 'live-two'));
    await coordinator.completeAttach(attachGeneration, 1);

    expect(writes.join('')).toBe('history-onelive-two');
    await vi.waitFor(() => expect(coordinator.getSnapshot().coveredThroughSequence).toBe(2));
    coordinator.dispose();
  });

  it('ignores completion from a stale two-phase attach generation', async () => {
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage: vi.fn(),
      write: () => {},
    });

    const staleGeneration = coordinator.beginAttach(0);
    const currentGeneration = coordinator.beginAttach(0);
    await coordinator.completeAttach(staleGeneration, 4);
    expect(coordinator.getSnapshot()).toMatchObject({ baselineReady: false, state: 'idle' });

    await coordinator.completeAttach(currentGeneration, 0);
    expect(coordinator.getSnapshot()).toMatchObject({ baselineReady: true, state: 'live' });
    coordinator.dispose();
  });

  it('does not carry retained overflow state into a new attach generation', async () => {
    const obsoletePage = new Promise<PagedTerminalHistoryPage>(() => {});
    const fetchPage = vi.fn().mockReturnValue(obsoletePage);
    const truncated = vi.fn();
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: () => {},
      onHistoryTruncated: truncated,
      policy: { maxRetainedLiveChunks: 1, maxRetainedLiveBytes: 3 },
    });

    void coordinator.attach(1);
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
    coordinator.pushLive(chunk(1, 'oversized'));
    const currentGeneration = coordinator.beginAttach(0);
    await coordinator.completeAttach(currentGeneration, 0);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(truncated).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({ baselineReady: true, state: 'live' });
    coordinator.dispose();
  });

  it('completes an explicit zero attach boundary without an unbounded history fetch', async () => {
    const writes: string[] = [];
    const fetchPage = vi.fn();
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
    });

    const attachGeneration = coordinator.beginAttach(0);
    coordinator.pushLive(chunk(1, 'first-live'));
    await coordinator.completeAttach(attachGeneration, 0);
    await vi.waitFor(() => expect(writes).toEqual(['first-live']));

    expect(fetchPage).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({ baselineReady: true, coveredThroughSequence: 1 });
    coordinator.dispose();
  });

  it('catches up a gap after an explicit zero attach boundary', async () => {
    const writes: string[] = [];
    const fetchPage = vi.fn().mockResolvedValue(page({
      chunks: [chunk(263, 'history-through-263')],
      coveredThroughSequence: 263,
      snapshotEndSequence: 263,
    }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
    });

    const attachGeneration = coordinator.beginAttach(0);
    coordinator.pushLive(chunk(264, 'live-264'));
    await coordinator.completeAttach(attachGeneration, 0);
    await vi.waitFor(() => expect(writes.join('')).toBe('history-through-263live-264'));

    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({
      startSequence: 1,
      endSequence: 263,
    }));
    coordinator.dispose();
  });

  it('bounds catch-up history before the first retained live sequence', async () => {
    const writes: string[] = [];
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page({ coveredThroughSequence: 1, snapshotEndSequence: 1 }))
      .mockResolvedValueOnce(page({
        chunks: [chunk(2, 'two')],
        coveredThroughSequence: 2,
        snapshotEndSequence: 2,
      }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
    });

    await coordinator.attach(1, 1);
    coordinator.pushLive(chunk(3, 'three'));
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(writes.join('')).toBe('twothree'));

    expect(fetchPage.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      startSequence: 2,
      endSequence: 2,
    }));
    coordinator.dispose();
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
    expect(writes.join('')).toBe('twosparse-live-fourduplicate-fiveseven');
    expect(coordinator.getSnapshot().coveredThroughSequence).toBe(7);
    coordinator.dispose();
  });

  it('prefers a retained live copy over history for the same source sequence', async () => {
    let releasePage: ((value: PagedTerminalHistoryPage) => void) | undefined;
    const historyPage = new Promise<PagedTerminalHistoryPage>(resolve => { releasePage = resolve; });
    const liveWrites: string[] = [];
    const historyWrites: string[] = [];
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage: () => historyPage,
      write: data => liveWrites.push(decoder.decode(data)),
      writeHistory: data => historyWrites.push(decoder.decode(data)),
    });

    const attach = coordinator.attach(1);
    coordinator.pushLive(chunk(1, 'raw-live-query'));
    releasePage?.(page({ chunks: [chunk(1, 'filtered-history')], coveredThroughSequence: 1 }));
    await attach;

    expect(liveWrites).toEqual(['raw-live-query']);
    expect(historyWrites).toEqual([]);
    expect(coordinator.getSnapshot().coveredThroughSequence).toBe(1);
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

  it('pauses only after an in-flight writer reaches parser completion', async () => {
    let completeWrite: (() => void) | undefined;
    const writerCompletion = new Promise<void>(resolve => { completeWrite = resolve; });
    const writes: string[] = [];
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage: async () => page({ coveredThroughSequence: 1 }),
      write: async data => {
        writes.push(decoder.decode(data));
        await writerCompletion;
      },
    });
    await coordinator.attach(1);
    coordinator.pushLive(chunk(2, 'two'));
    await vi.waitFor(() => expect(writes).toEqual(['two']));

    let paused = false;
    const pause = coordinator.pause().then(snapshot => {
      paused = true;
      return snapshot;
    });
    await Promise.resolve();
    expect(paused).toBe(false);
    coordinator.pushLive(chunk(3, 'three'));
    expect(coordinator.getSnapshot().retainedLiveChunks).toBe(1);

    completeWrite?.();
    expect(await pause).toMatchObject({ active: false, coveredThroughSequence: 2 });
    coordinator.setActive(true);
    await vi.waitFor(() => expect(writes).toEqual(['two', 'three']));
    coordinator.dispose();
  });

  it('stops a cancelled multi-batch history recovery after the committed writer', async () => {
    let completeFirstWrite: (() => void) | undefined;
    const firstWriteCompletion = new Promise<void>(resolve => { completeFirstWrite = resolve; });
    const writes: string[] = [];
    const transforms: number[] = [];
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage: async () => page({
        chunks: [chunk(1, 'one'), chunk(2, 'two')],
        coveredThroughSequence: 2,
      }),
      transformChunk: item => {
        transforms.push(item.sequence ?? 0);
        return item.data;
      },
      write: () => {},
      writeHistory: async data => {
        writes.push(decoder.decode(data));
        if (writes.length === 1) await firstWriteCompletion;
      },
      policy: { maxWriteBatchBytes: 3 },
    });

    void coordinator.attach(1);
    await vi.waitFor(() => expect(writes).toEqual(['one']));
    const pause = coordinator.pause();
    await Promise.resolve();
    expect(coordinator.getSnapshot().active).toBe(false);

    completeFirstWrite?.();
    await expect(pause).resolves.toMatchObject({
      active: false,
      coveredThroughSequence: 1,
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(transforms).toEqual([1]);
    expect(writes).toEqual(['one']);
    coordinator.dispose();
  });

  it('pauses catch-up without waiting for a fetch that ignores abort', async () => {
    let resolveCatchUp: ((value: PagedTerminalHistoryPage) => void) | undefined;
    const catchUp = new Promise<PagedTerminalHistoryPage>(resolve => { resolveCatchUp = resolve; });
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page({ coveredThroughSequence: 1 }))
      .mockReturnValueOnce(catchUp)
      .mockResolvedValueOnce(page({ coveredThroughSequence: 2 }));
    const writes: string[] = [];
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: data => writes.push(decoder.decode(data)),
    });
    await coordinator.attach(1);
    coordinator.pushLive(chunk(3, 'three'));
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

    await expect(coordinator.pause()).resolves.toMatchObject({ active: false });
    resolveCatchUp?.(page({ chunks: [chunk(2, 'obsolete')], coveredThroughSequence: 2 }));
    await Promise.resolve();
    expect(writes).toEqual([]);

    coordinator.setActive(true);
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(writes).toEqual(['three']));
    coordinator.dispose();
  });

  it('pauses a scheduled retry and resumes recovery when active again', async () => {
    vi.useFakeTimers();
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page({ coveredThroughSequence: 1 }))
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(page({ coveredThroughSequence: 2 }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: () => {},
      policy: { retryDelaysMs: [250] },
    });
    await coordinator.attach(1);
    coordinator.pushLive(chunk(3));
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('retry-wait'));

    await expect(coordinator.pause()).resolves.toMatchObject({ active: false, retryScheduled: false });
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchPage).toHaveBeenCalledTimes(2);

    coordinator.setActive(true);
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(coordinator.getSnapshot().state).toBe('live'));
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
        ? page({ chunks: [chunk(2, 'two')], coveredThroughSequence: 4 })
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
    expect(writes.join('')).toBe('');

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
      .mockResolvedValueOnce(page({
        chunks: [chunk(1)],
        coveredThroughSequence: 1,
        snapshotEndSequence: 1,
      }));
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

    expect(fetchPage.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ endSequence: 1 }));
    expect(truncated).toHaveBeenCalledWith('retained-live-overflow');
    expect(cleared).toHaveBeenCalled();
    expect(coordinator.getSnapshot().coveredThroughSequence).toBe(2);
    coordinator.dispose();
  });

  it('rebases an oversized retained live chunk to its dropped sequence fence', async () => {
    let resolveFirst: ((value: PagedTerminalHistoryPage) => void) | undefined;
    const first = new Promise<PagedTerminalHistoryPage>(resolve => { resolveFirst = resolve; });
    const fetchPage = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(page({
        chunks: [chunk(1, 'oversized')],
        coveredThroughSequence: 1,
        snapshotEndSequence: 1,
      }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: () => {},
      policy: { maxRetainedLiveChunks: 1, maxRetainedLiveBytes: 3 },
    });

    const attaching = coordinator.attach(1);
    coordinator.pushLive(chunk(1, 'oversized'));
    resolveFirst?.(page({ coveredThroughSequence: 0 }));
    await attaching;

    expect(fetchPage.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ endSequence: 1 }));
    expect(coordinator.getSnapshot().coveredThroughSequence).toBe(1);
    coordinator.dispose();
  });

  it('rebases overflow accumulated before an explicit zero attach boundary', async () => {
    const fetchPage = vi.fn().mockResolvedValue(page({
      chunks: [chunk(1, 'oversized')],
      coveredThroughSequence: 1,
      snapshotEndSequence: 1,
    }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: () => {},
      policy: { maxRetainedLiveChunks: 1, maxRetainedLiveBytes: 3 },
    });

    const attachGeneration = coordinator.beginAttach(0);
    coordinator.pushLive(chunk(1, 'oversized'));
    await coordinator.completeAttach(attachGeneration, 0);

    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ endSequence: 1 }));
    expect(coordinator.getSnapshot()).toMatchObject({ baselineReady: true, coveredThroughSequence: 1 });
    coordinator.dispose();
  });

  it('keeps the baseline pending while zero-boundary overflow history is writer-fenced', async () => {
    let completeWrite: (() => void) | undefined;
    const historyWrite = new Promise<void>(resolve => { completeWrite = resolve; });
    const fetchPage = vi.fn().mockResolvedValue(page({
      chunks: [chunk(1, 'oversized')],
      coveredThroughSequence: 1,
      snapshotEndSequence: 1,
    }));
    const coordinator = createPagedTerminalOutputCoordinator({
      fetchPage,
      write: () => {},
      writeHistory: () => historyWrite,
      policy: { maxRetainedLiveChunks: 1, maxRetainedLiveBytes: 3 },
    });

    const attachGeneration = coordinator.beginAttach(0);
    coordinator.pushLive(chunk(1, 'oversized'));
    const baseline = coordinator.waitForBaseline();
    const complete = coordinator.completeAttach(attachGeneration, 0);
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
    expect(coordinator.getSnapshot().baselineReady).toBe(false);

    let baselineResolved = false;
    void baseline.then(() => { baselineResolved = true; });
    await Promise.resolve();
    expect(baselineResolved).toBe(false);
    completeWrite?.();
    await complete;
    await expect(baseline).resolves.toMatchObject({ baselineReady: true });
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
