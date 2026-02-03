import { describe, expect, it, vi } from 'vitest';
import type { TerminalSessionInfo, TerminalTransport } from '../types';
import { TerminalSessionsCoordinator } from './TerminalSessionsCoordinator';

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
};

const makeSession = (id: string, overrides: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo => ({
  id,
  name: `Session ${id}`,
  workingDir: '/',
  createdAtMs: 0,
  lastActiveAtMs: 0,
  isActive: true,
  ...overrides
});

const makeTransport = (overrides: Partial<TerminalTransport> = {}): TerminalTransport => ({
  attach: vi.fn().mockResolvedValue(undefined),
  resize: vi.fn().mockResolvedValue(undefined),
  sendInput: vi.fn().mockResolvedValue(undefined),
  history: vi.fn().mockResolvedValue([]),
  clear: vi.fn().mockResolvedValue(undefined),
  ...overrides
});

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('TerminalSessionsCoordinator', () => {
  it('filters pending deletions during refresh to avoid session reappearing', async () => {
    const s1 = makeSession('s1', { createdAtMs: 1 });
    const s2 = makeSession('s2', { createdAtMs: 2 });
    const del = deferred<void>();

    const transport = makeTransport({
      listSessions: vi.fn().mockResolvedValue([s1, s2]),
      deleteSession: vi.fn().mockImplementation(() => del.promise)
    });

    const coordinator = new TerminalSessionsCoordinator({ transport, pollMs: 0 });

    await coordinator.refresh();
    expect(coordinator.getSnapshot().map((s) => s.id)).toEqual(['s1', 's2']);

    const deletePromise = coordinator.deleteSession('s1');
    expect(coordinator.getSnapshot().map((s) => s.id)).toEqual(['s2']);

    // A concurrent refresh should not re-introduce the session while deletion is pending.
    await coordinator.refresh();
    expect(coordinator.getSnapshot().map((s) => s.id)).toEqual(['s2']);

    del.resolve();
    await deletePromise;
  });

  it('rolls back optimistic deletion when deleteSession fails', async () => {
    const s1 = makeSession('s1', { createdAtMs: 1 });
    const s2 = makeSession('s2', { createdAtMs: 2 });
    const del = deferred<void>();

    const transport = makeTransport({
      listSessions: vi.fn().mockResolvedValue([s1, s2]),
      deleteSession: vi.fn().mockImplementation(() => del.promise)
    });

    const coordinator = new TerminalSessionsCoordinator({ transport, pollMs: 0 });

    await coordinator.refresh();
    expect(coordinator.getSnapshot().map((s) => s.id)).toEqual(['s1', 's2']);

    const p = coordinator.deleteSession('s1');
    expect(coordinator.getSnapshot().map((s) => s.id)).toEqual(['s2']);

    del.reject(new Error('delete failed'));
    await expect(p).rejects.toThrow('delete failed');

    // deleteSession() awaits a forced refresh before re-throwing.
    expect(coordinator.getSnapshot().map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('starts polling when subscribed and updates snapshot over time', async () => {
    vi.useFakeTimers();

    const s1 = makeSession('s1', { createdAtMs: 1 });
    const listSessions = vi.fn()
      .mockResolvedValueOnce([s1])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);

    const transport = makeTransport({ listSessions });
    const coordinator = new TerminalSessionsCoordinator({ transport, pollMs: 50 });

    const snapshots: string[][] = [];
    const unsub = coordinator.subscribe((sessions) => {
      snapshots.push(sessions.map((s) => s.id));
    });

    // Best-effort initial refresh triggered by subscribe().
    await flushPromises();
    expect(coordinator.getSnapshot().map((s) => s.id)).toEqual(['s1']);

    // Advance enough time for at least one poll tick that runs after the initial refresh settles.
    await vi.advanceTimersByTimeAsync(120);
    await flushPromises();
    expect(coordinator.getSnapshot().map((s) => s.id)).toEqual([]);

    unsub();
    vi.useRealTimers();

    // The listener is invoked at least for: immediate snapshot, first refresh, and a poll tick.
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
  });
});
