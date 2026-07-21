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
  it('preserves newer output activity metadata when a stale session snapshot arrives', () => {
    const coordinator = new TerminalSessionsCoordinator({ transport: makeTransport(), pollMs: 0 });
    coordinator.upsertSession({
      id: 'session-output',
      name: 'repo',
      workingDir: '/workspace/repo',
      createdAtMs: 1,
      lastActiveAtMs: 1,
      isActive: true,
      outputActivity: { phase: 'streaming', revision: 4, updatedAtMs: 40 },
    });

    coordinator.upsertSession({
      id: 'session-output',
      name: 'repo',
      workingDir: '/workspace/repo',
      createdAtMs: 1,
      lastActiveAtMs: 2,
      isActive: true,
      outputActivity: { phase: 'settled', revision: 3, updatedAtMs: 30 },
    });

    expect(coordinator.getSnapshot()[0]?.outputActivity).toEqual({
      phase: 'streaming', revision: 4, updatedAtMs: 40,
    });
  });

  it('applies output activity patches only when their own revision is newer and valid', () => {
    const coordinator = new TerminalSessionsCoordinator({ transport: makeTransport(), pollMs: 0 });
    coordinator.upsertSession(makeSession('session-output', {
      foregroundCommand: { phase: 'running', displayName: 'codex', revision: 5, updatedAtMs: 50 },
      outputActivity: { phase: 'streaming', revision: 2, updatedAtMs: 20 },
    }));

    coordinator.updateSessionMeta('session-output', {
      outputActivity: { phase: 'settled', revision: 3, updatedAtMs: 30 },
    });
    coordinator.updateSessionMeta('session-output', {
      outputActivity: { phase: 'unknown', revision: 2, updatedAtMs: 40 },
    });
    coordinator.updateSessionMeta('session-output', {
      outputActivity: { phase: 'invalid', revision: 999, updatedAtMs: 999 } as any,
    });

    expect(coordinator.getSnapshot()[0]).toMatchObject({
      foregroundCommand: { phase: 'running', displayName: 'codex', revision: 5, updatedAtMs: 50 },
      outputActivity: { phase: 'settled', revision: 3, updatedAtMs: 30 },
    });
  });

  it('merges command and output revisions independently across stale refreshes', async () => {
    const listSessions = vi.fn()
      .mockResolvedValueOnce([makeSession('session-output', {
        name: 'First refresh',
        foregroundCommand: { phase: 'idle', displayName: '', revision: 5, updatedAtMs: 50 },
        outputActivity: { phase: 'settled', revision: 5, updatedAtMs: 50 },
      })])
      .mockResolvedValueOnce([makeSession('session-output', {
        name: 'Second refresh',
        foregroundCommand: { phase: 'running', displayName: 'stale', revision: 4, updatedAtMs: 40 },
        outputActivity: { phase: 'settled', revision: 7, updatedAtMs: 70 },
      })]);
    const coordinator = new TerminalSessionsCoordinator({
      transport: makeTransport({ listSessions }),
      pollMs: 0,
    });
    coordinator.upsertSession(makeSession('session-output', {
      foregroundCommand: { phase: 'running', displayName: 'codex', revision: 4, updatedAtMs: 40 },
      outputActivity: { phase: 'streaming', revision: 6, updatedAtMs: 60 },
    }));

    await coordinator.refresh();
    expect(coordinator.getSnapshot()[0]).toMatchObject({
      name: 'First refresh',
      foregroundCommand: { phase: 'idle', displayName: '', revision: 5, updatedAtMs: 50 },
      outputActivity: { phase: 'streaming', revision: 6, updatedAtMs: 60 },
    });

    await coordinator.refresh();
    expect(coordinator.getSnapshot()[0]).toMatchObject({
      name: 'Second refresh',
      foregroundCommand: { phase: 'idle', displayName: '', revision: 5, updatedAtMs: 50 },
      outputActivity: { phase: 'settled', revision: 7, updatedAtMs: 70 },
    });
  });

  it('does not let malformed high-revision output metadata block a later valid update', () => {
    const coordinator = new TerminalSessionsCoordinator({ transport: makeTransport(), pollMs: 0 });
    coordinator.upsertSession(makeSession('session-output', {
      outputActivity: { phase: 'invalid', revision: 999, updatedAtMs: 999 } as any,
    }));

    coordinator.updateSessionMeta('session-output', {
      outputActivity: { phase: 'streaming', revision: 1, updatedAtMs: 10 },
    });

    expect(coordinator.getSnapshot()[0]?.outputActivity).toEqual({
      phase: 'streaming', revision: 1, updatedAtMs: 10,
    });
  });

  it('upserts and removes normalized sessions synchronously', () => {
    const coordinator = new TerminalSessionsCoordinator({ transport: makeTransport(), pollMs: 0 });
    const snapshots: string[][] = [];
    const unsubscribe = coordinator.subscribe((sessions) => {
      snapshots.push(sessions.map((session) => session.id));
    });

    expect(coordinator.upsertSession(makeSession(' s2 ', { createdAtMs: 2 })).id).toBe('s2');
    coordinator.upsertSession(makeSession('s1', { createdAtMs: 1 }));
    coordinator.upsertSession(makeSession('s2', { createdAtMs: 2, name: 'Updated' }));

    expect(coordinator.getSnapshot().map((session) => session.id)).toEqual(['s1', 's2']);
    expect(coordinator.getSnapshot().find((session) => session.id === 's2')?.name).toBe('Updated');
    expect(coordinator.removeSession('s1')).toBe(true);
    expect(coordinator.removeSession('missing')).toBe(false);
    expect(coordinator.getSnapshot().map((session) => session.id)).toEqual(['s2']);
    expect(snapshots).toContainEqual(['s1', 's2']);
    expect(snapshots[snapshots.length - 1]).toEqual(['s2']);

    unsubscribe();
  });

  it('rejects an upsert without a session id', () => {
    const coordinator = new TerminalSessionsCoordinator({ transport: makeTransport(), pollMs: 0 });

    expect(() => coordinator.upsertSession(makeSession('   '))).toThrow('missing id');
  });

  it('keeps a local upsert when an older refresh resolves afterward', async () => {
    const firstRefresh = deferred<TerminalSessionInfo[]>();
    const listSessions = vi.fn()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValueOnce([
        makeSession('local', { createdAtMs: 2 }),
        makeSession('remote', { createdAtMs: 3 }),
      ]);
    const transport = makeTransport({
      listSessions,
    });
    const coordinator = new TerminalSessionsCoordinator({ transport, pollMs: 0 });

    const refresh = coordinator.refresh();
    coordinator.upsertSession(makeSession('local', { createdAtMs: 2 }));
    firstRefresh.resolve([makeSession('stale', { createdAtMs: 1 })]);
    await refresh;

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot().map((session) => session.id)).toEqual(['local', 'remote']);
  });

  it('keeps a newly created session when an older refresh resolves afterward', async () => {
    const staleRefresh = deferred<TerminalSessionInfo[]>();
    const created = makeSession('created', { createdAtMs: 2 });
    const listSessions = vi.fn()
      .mockImplementationOnce(() => staleRefresh.promise)
      .mockResolvedValueOnce([created]);
    const transport = makeTransport({
      listSessions,
      createSession: vi.fn().mockResolvedValue(created),
    });
    const coordinator = new TerminalSessionsCoordinator({ transport, pollMs: 0 });

    const refresh = coordinator.refresh();
    await expect(coordinator.createSession('Created', '/workspace')).resolves.toMatchObject({
      ...created,
      foregroundCommand: { phase: 'unknown', displayName: '', revision: 0, updatedAtMs: 0 },
    });
    staleRefresh.resolve([]);
    await refresh;

    expect(coordinator.getSnapshot().map((session) => session.id)).toEqual(['created']);
  });

  it('keeps a local removal when an older refresh resolves afterward', async () => {
    const staleRefresh = deferred<TerminalSessionInfo[]>();
    const listSessions = vi.fn()
      .mockImplementationOnce(() => staleRefresh.promise)
      .mockResolvedValueOnce([]);
    const transport = makeTransport({
      listSessions,
    });
    const coordinator = new TerminalSessionsCoordinator({ transport, pollMs: 0 });
    coordinator.upsertSession(makeSession('s1'));

    const refresh = coordinator.refresh();
    expect(coordinator.removeSession('s1')).toBe(true);
    staleRefresh.resolve([makeSession('s1')]);
    await refresh;

    expect(coordinator.getSnapshot()).toEqual([]);
  });

  it('does not invalidate an in-flight refresh for no-op local mutations', async () => {
    const pending = deferred<TerminalSessionInfo[]>();
    const listSessions = vi.fn().mockImplementation(() => pending.promise);
    const coordinator = new TerminalSessionsCoordinator({
      transport: makeTransport({ listSessions }),
      pollMs: 0,
    });

    const refresh = coordinator.refresh();
    expect(coordinator.removeSession('missing')).toBe(false);
    coordinator.updateSessionMeta('missing', { name: 'ignored' });
    pending.resolve([makeSession('server')]);
    await refresh;

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot().map((session) => session.id)).toEqual(['server']);
  });

  it('shares refresh work only while the local mutation revision is unchanged', async () => {
    const firstRefresh = deferred<TerminalSessionInfo[]>();
    const secondRefresh = deferred<TerminalSessionInfo[]>();
    const listSessions = vi.fn()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockImplementationOnce(() => secondRefresh.promise);
    const coordinator = new TerminalSessionsCoordinator({
      transport: makeTransport({ listSessions }),
      pollMs: 0,
    });

    const first = coordinator.refresh();
    const sameRevision = coordinator.refresh();
    expect(first).toBe(sameRevision);
    expect(listSessions).toHaveBeenCalledTimes(1);

    coordinator.upsertSession(makeSession('local'));
    const nextRevision = coordinator.refresh();
    expect(nextRevision).not.toBe(first);
    expect(listSessions).toHaveBeenCalledTimes(2);

    secondRefresh.resolve([makeSession('server')]);
    await nextRevision;
    firstRefresh.resolve([makeSession('stale')]);
    await Promise.all([first, sameRevision]);

    expect(coordinator.getSnapshot().map((session) => session.id)).toEqual(['server']);
  });

  it('updates session metadata in-place without a refresh', async () => {
    const s1 = makeSession('s1', { createdAtMs: 1, name: 'Old', workingDir: '/old' });

    const transport = makeTransport({
      listSessions: vi.fn().mockResolvedValue([s1])
    });

    const coordinator = new TerminalSessionsCoordinator({ transport, pollMs: 0 });
    await coordinator.refresh();

    coordinator.updateSessionMeta('s1', { name: 'New Name', workingDir: '/new' });
    expect(coordinator.getSnapshot().find((s) => s.id === 's1')?.name).toBe('New Name');
    expect(coordinator.getSnapshot().find((s) => s.id === 's1')?.workingDir).toBe('/new');
  });

  it('publishes command-only metadata updates and rejects stale command revisions', () => {
    const coordinator = new TerminalSessionsCoordinator({ transport: makeTransport(), pollMs: 0 });
    coordinator.upsertSession(makeSession('s1', {
      foregroundCommand: { phase: 'idle', displayName: '', revision: 1, updatedAtMs: 10 },
    }));
    const snapshots: TerminalSessionInfo[][] = [];
    const unsubscribe = coordinator.subscribe((sessions) => snapshots.push(sessions));

    coordinator.updateSessionMeta('s1', {
      foregroundCommand: { phase: 'running', displayName: 'top', revision: 2, updatedAtMs: 20 },
    });
    coordinator.updateSessionMeta('s1', {
      foregroundCommand: { phase: 'idle', displayName: '', revision: 1, updatedAtMs: 30 },
    });

    expect(coordinator.getSnapshot()[0]?.foregroundCommand).toEqual({
      phase: 'running', displayName: 'top', revision: 2, updatedAtMs: 20,
    });
    expect(snapshots.some(snapshot => snapshot[0]?.foregroundCommand?.displayName === 'top')).toBe(true);
    unsubscribe();
  });

  it('preserves newer command metadata when a stale session upsert arrives', () => {
    const coordinator = new TerminalSessionsCoordinator({ transport: makeTransport(), pollMs: 0 });
    coordinator.upsertSession(makeSession('s1', {
      name: 'Original',
      foregroundCommand: { phase: 'idle', displayName: '', revision: 1, updatedAtMs: 10 },
    }));
    coordinator.updateSessionMeta('s1', {
      foregroundCommand: { phase: 'running', displayName: 'top', revision: 3, updatedAtMs: 30 },
    });

    coordinator.upsertSession(makeSession('s1', {
      name: 'Refreshed',
      foregroundCommand: { phase: 'idle', displayName: '', revision: 2, updatedAtMs: 20 },
    }));

    expect(coordinator.getSnapshot()[0]).toMatchObject({
      name: 'Refreshed',
      foregroundCommand: {
        phase: 'running', displayName: 'top', revision: 3, updatedAtMs: 30,
      },
    });
  });

  it('does not let a malformed snapshot revision block a later valid command update', () => {
    const coordinator = new TerminalSessionsCoordinator({ transport: makeTransport(), pollMs: 0 });
    coordinator.upsertSession(makeSession('s1', {
      foregroundCommand: {
        phase: 'garbage',
        displayName: 'unsafe token',
        revision: 999,
        updatedAtMs: 50,
      } as any,
    }));

    coordinator.updateSessionMeta('s1', {
      foregroundCommand: { phase: 'running', displayName: 'top', revision: 1, updatedAtMs: 60 },
    });

    expect(coordinator.getSnapshot()[0]?.foregroundCommand).toEqual({
      phase: 'running', displayName: 'top', revision: 1, updatedAtMs: 60,
    });
  });

  it('preserves newer command metadata when a stale refresh arrives', async () => {
    const listSessions = vi.fn().mockResolvedValue([
      makeSession('s1', {
        name: 'Refreshed',
        foregroundCommand: { phase: 'idle', displayName: '', revision: 2, updatedAtMs: 20 },
      }),
    ]);
    const coordinator = new TerminalSessionsCoordinator({
      transport: makeTransport({ listSessions }),
      pollMs: 0,
    });
    coordinator.upsertSession(makeSession('s1', {
      name: 'Original',
      foregroundCommand: { phase: 'running', displayName: 'top', revision: 3, updatedAtMs: 30 },
    }));

    await coordinator.refresh();

    expect(coordinator.getSnapshot()[0]).toMatchObject({
      name: 'Refreshed',
      foregroundCommand: {
        phase: 'running', displayName: 'top', revision: 3, updatedAtMs: 30,
      },
    });
  });

  it('applies cwd changes independently from command revision', () => {
    const coordinator = new TerminalSessionsCoordinator({ transport: makeTransport(), pollMs: 0 });
    coordinator.upsertSession(makeSession('s1', {
      workingDir: '/old',
      foregroundCommand: { phase: 'running', displayName: 'top', revision: 4, updatedAtMs: 20 },
    }));

    coordinator.updateSessionMeta('s1', { workingDir: '/new' });

    expect(coordinator.getSnapshot()[0]?.workingDir).toBe('/new');
    expect(coordinator.getSnapshot()[0]?.foregroundCommand).toMatchObject({
      phase: 'running', displayName: 'top', revision: 4,
    });
  });

  it('rejects malformed higher-revision command patches without clearing valid state', () => {
    const coordinator = new TerminalSessionsCoordinator({ transport: makeTransport(), pollMs: 0 });
    coordinator.upsertSession(makeSession('s1', {
      foregroundCommand: { phase: 'running', displayName: 'top', revision: 4, updatedAtMs: 20 },
    }));

    coordinator.updateSessionMeta('s1', {
      foregroundCommand: {
        phase: 'garbage',
        displayName: 'oops',
        revision: 5,
        updatedAtMs: 30,
      } as any,
    });
    coordinator.updateSessionMeta('s1', {
      foregroundCommand: { phase: 'idle', revision: 6 } as any,
    });

    expect(coordinator.getSnapshot()[0]?.foregroundCommand).toEqual({
      phase: 'running', displayName: 'top', revision: 4, updatedAtMs: 20,
    });
  });

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

    try {
      const snapshots: string[][] = [];
      const unsub = coordinator.subscribe((sessions) => {
        snapshots.push(sessions.map((s) => s.id));
      });

      await flushPromises();
      expect(coordinator.getSnapshot().map((s) => s.id)).toEqual(['s1']);

      await vi.advanceTimersByTimeAsync(120);
      await flushPromises();
      expect(coordinator.getSnapshot().map((s) => s.id)).toEqual([]);

      unsub();
      await vi.advanceTimersByTimeAsync(120);
      expect(listSessions).toHaveBeenCalledTimes(3);
      expect(snapshots.length).toBeGreaterThanOrEqual(3);
    } finally {
      coordinator.dispose();
      vi.useRealTimers();
    }
  });

  it('disables interval polling with pollMs zero while preserving initial and explicit refreshes', async () => {
    vi.useFakeTimers();
    const listSessions = vi.fn().mockResolvedValue([]);
    const coordinator = new TerminalSessionsCoordinator({
      transport: makeTransport({ listSessions }),
      pollMs: 0,
    });

    try {
      const unsubscribe = coordinator.subscribe(() => undefined);
      await flushPromises();
      expect(listSessions).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();
      expect(listSessions).toHaveBeenCalledTimes(1);

      await coordinator.refresh();
      expect(listSessions).toHaveBeenCalledTimes(2);
      unsubscribe();
    } finally {
      coordinator.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps the ten-second polling default when pollMs is omitted', async () => {
    vi.useFakeTimers();
    const listSessions = vi.fn().mockResolvedValue([]);
    const coordinator = new TerminalSessionsCoordinator({
      transport: makeTransport({ listSessions }),
    });

    try {
      coordinator.subscribe(() => undefined);
      await flushPromises();
      expect(listSessions).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      await flushPromises();
      expect(listSessions).toHaveBeenCalledTimes(2);
    } finally {
      coordinator.dispose();
      vi.useRealTimers();
    }
  });
});
