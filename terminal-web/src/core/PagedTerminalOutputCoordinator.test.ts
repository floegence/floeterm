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
    coordinator.pushLive(chunk(5, 'duplicate-five'));
    coordinator.pushLive(chunk(7, 'seven'));
    await attach;
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(writes.join('')).toBe('twofiveseven');
    expect(coordinator.getSnapshot().coveredThroughSequence).toBe(7);
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
