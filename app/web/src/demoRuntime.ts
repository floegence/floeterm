import { batch, createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js';
import {
  resetTerminalFabricDiagnostics,
  resetTerminalRenderSchedulerStats,
} from '@floegence/floeterm-terminal-web';
import { createEventSource, createTransport, getOrCreateConnId, type AppTerminalTransport } from './terminalApi';

const SESSION_STORAGE_KEY = 'floeterm_session_id';
const GRID_SIZE_STORAGE_KEY = 'floeterm_grid_size';

export const GRID_COUNTS = [4, 12, 24, 48, 64] as const;
export const DEFAULT_GRID_COUNT: GridCount = 12;
export const PERF_GRID_COUNT: GridCount = 64;
export const GRID_MOUNT_BATCH_SIZE = 4;
export const GRID_MOUNT_BATCH_DELAY_MS = 100;
export const GRID_STREAM_START_BASE_DELAY_MS = 240;
export const GRID_STREAM_START_STAGGER_MS = 32;
export const GRID_STREAM_START_STAGGER_WINDOW_MS = 760;

export type DemoMode = 'single' | 'grid';
export type GridCount = typeof GRID_COUNTS[number];
export type DemoEventSource = ReturnType<typeof createEventSource>;

export type GridSession = {
  id: string;
  name: string;
};

export type GridRuntimeStats = {
  stateCounts: Record<string, number>;
  connected: number;
  errors: number;
};

type GridRuntimeState = {
  state: string;
  connected: boolean;
  hasError: boolean;
};

type DemoSessionInfo = Awaited<ReturnType<AppTerminalTransport['listSessions']>>[number];

type PendingGridRequest = {
  count: GridCount;
  force: boolean;
};

export type FloetermDemoRuntime = {
  connId: string;
  transport: AppTerminalTransport;
  eventSource: DemoEventSource;
  mode: Accessor<DemoMode>;
  gridCount: Accessor<GridCount>;
  singleSessionId: Accessor<string>;
  singleBusy: Accessor<boolean>;
  singleError: Accessor<string>;
  gridSessions: Accessor<GridSession[]>;
  gridBusy: Accessor<boolean>;
  gridError: Accessor<string>;
  activeGridSessionId: Accessor<string>;
  gridRuntimeStats: Accessor<GridRuntimeStats>;
  switchMode: (nextMode: DemoMode) => void;
  restartSingleSession: () => Promise<void>;
  changeGridCount: (nextCount: GridCount) => void;
  rebuildGrid: (count?: GridCount, options?: { force?: boolean }) => Promise<void>;
  focusGridSession: (sessionId: string) => void;
  updateGridRuntimeState: (sessionId: string, state: string, connected: boolean, hasError: boolean) => void;
};

export const singleSessionName = (connId: string): string => `home-${connId.slice(0, 8)}`;

export const gridSessionPrefix = (connId: string): string => `grid-${connId.slice(0, 8)}-`;

export const gridSessionName = (connId: string, index: number): string => (
  `${gridSessionPrefix(connId)}${String(index + 1).padStart(2, '0')}`
);

export const gridStreamStartDelay = (index: number): number => (
  GRID_STREAM_START_BASE_DELAY_MS
  + ((index * GRID_STREAM_START_STAGGER_MS) % GRID_STREAM_START_STAGGER_WINDOW_MS)
);

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const rounded = unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
};

export const formatNumber = (value: number, digits = 1): string => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toFixed(digits);
};

export const isDemoMode = (value: string): value is DemoMode => value === 'single' || value === 'grid';

export const readStoredGridCount = (): GridCount => {
  const stored = Number(window.localStorage.getItem(GRID_SIZE_STORAGE_KEY));
  return GRID_COUNTS.includes(stored as GridCount) ? stored as GridCount : DEFAULT_GRID_COUNT;
};

export const resolveInitialDemoState = (): { mode: DemoMode; gridCount: GridCount } => {
  const params = new URLSearchParams(window.location.search);
  const requestedMode = params.get('mode') ?? '';
  const requestedCount = Number(params.get('count') ?? params.get('grid') ?? '');
  const perfMode = params.get('perf') === '1';
  const mode = isDemoMode(requestedMode)
    ? requestedMode
    : perfMode
      ? 'grid'
      : 'single';
  const gridCount = GRID_COUNTS.includes(requestedCount as GridCount)
    ? requestedCount as GridCount
    : perfMode
      ? PERF_GRID_COUNT
      : readStoredGridCount();
  return { mode, gridCount };
};

export const updateDemoModeSearchParams = (nextMode: DemoMode, nextGridCount?: GridCount): void => {
  const url = new URL(window.location.href);
  url.searchParams.delete('perf');
  url.searchParams.set('mode', nextMode);
  if (nextMode === 'grid') {
    url.searchParams.set('count', String(nextGridCount ?? readStoredGridCount()));
  } else {
    url.searchParams.delete('count');
    url.searchParams.delete('grid');
  }
  window.history.replaceState(null, '', url);
};

export const buildLiveGridCommand = (label: string): string => {
  const shellLabel = label.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return [
    'clear',
    `printf '\\033[38;5;51mfabric\\033[0m %s\\n' ${shellLabel}`,
    'i=0',
    `while true; do i=$((i+1)); printf '%04d  %s\\n' "$i" "$(date +%H:%M:%S)"; sleep 0.8; done`,
  ].join('\r') + '\r';
};

export const createProgressiveCount = (totalCount: Accessor<number>, batchSize: number, delayMs: number): Accessor<number> => {
  const [visibleCount, setVisibleCount] = createSignal(totalCount());

  createEffect(() => {
    const total = totalCount();
    setVisibleCount(Math.min(batchSize, total));
  });

  createEffect(() => {
    const total = totalCount();
    const visible = visibleCount();
    if (visible >= total) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setVisibleCount(current => Math.min(total, current + batchSize));
    }, delayMs);
    onCleanup(() => window.clearTimeout(timeoutId));
  });

  return visibleCount;
};

const createStaleRuntimeError = (): Error => {
  const error = new Error('demo runtime request is no longer current');
  error.name = 'AbortError';
  return error;
};

const isAbortError = (error: unknown): boolean => (
  error instanceof Error && error.name === 'AbortError'
);

const cleanupNamedSessionsWithTransport = async (
  transport: AppTerminalTransport,
  keepIds: Set<string>,
  shouldManage: (session: DemoSessionInfo) => boolean,
  isCurrent: () => boolean = () => true,
): Promise<void> => {
  const list = await transport.listSessions();
  if (!isCurrent()) {
    throw createStaleRuntimeError();
  }
  await Promise.all(
    list
      .filter(item => shouldManage(item) && !keepIds.has(item.id))
      .map(async item => {
        if (!isCurrent()) {
          throw createStaleRuntimeError();
        }
        await transport.deleteSession(item.id).catch(() => {});
      }),
  );
};

const pickReusableGridSessions = (
  sessions: DemoSessionInfo[],
  connId: string,
  count: GridCount,
): GridSession[] | null => {
  const selected: GridSession[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = gridSessionName(connId, index);
    const session = sessions
      .filter(item => item.name === name)
      .sort((left, right) => right.createdAtMs - left.createdAtMs)[0];
    if (!session) {
      return null;
    }
    selected.push({ id: session.id, name });
  }
  return selected;
};

export const createFloetermDemoRuntime = (): FloetermDemoRuntime => {
  const connId = getOrCreateConnId();
  const transport = createTransport(connId);
  const eventSource = createEventSource(connId);
  const initial = resolveInitialDemoState();

  const [mode, setMode] = createSignal<DemoMode>(initial.mode);
  const [gridCount, setGridCount] = createSignal<GridCount>(initial.gridCount);
  const [singleSessionId, setSingleSessionIdSignal] = createSignal('');
  const [singleBusy, setSingleBusy] = createSignal(false);
  const [singleError, setSingleError] = createSignal('');
  const [gridSessions, setGridSessionsSignal] = createSignal<GridSession[]>([]);
  const [gridBusy, setGridBusy] = createSignal(false);
  const [gridError, setGridError] = createSignal('');
  const [activeGridSessionId, setActiveGridSessionId] = createSignal('');
  const [gridRuntimeBySession, setGridRuntimeBySession] = createSignal<Record<string, GridRuntimeState>>({});

  let modeValue = initial.mode;
  let singleSessionIdValue = '';
  let gridSessionsValue: GridSession[] = [];
  let singleEpoch = 0;
  let gridEpoch = 0;
  let ensureSingleInFlight: Promise<void> | null = null;
  let rebuildGridInFlight: Promise<void> | null = null;
  let pendingGridRequest: PendingGridRequest | null = null;

  createEffect(() => {
    modeValue = mode();
  });

  createEffect(() => {
    window.localStorage.setItem(GRID_SIZE_STORAGE_KEY, String(gridCount()));
    updateDemoModeSearchParams(mode(), gridCount());
  });

  const gridRuntimeStats = createMemo<GridRuntimeStats>(() => {
    const values = Object.values(gridRuntimeBySession());
    const stateCounts = values.reduce<Record<string, number>>((acc, item) => {
      acc[item.state] = (acc[item.state] ?? 0) + 1;
      return acc;
    }, {});
    return {
      stateCounts,
      connected: values.filter(item => item.connected).length,
      errors: values.filter(item => item.hasError).length,
    };
  });

  const setSingleSessionId = (next: string) => {
    singleSessionIdValue = next;
    setSingleSessionIdSignal(next);
  };

  const setGridSessions = (next: GridSession[]) => {
    gridSessionsValue = next;
    setGridSessionsSignal(next);
  };

  const disposeGridSessions = async (sessions: GridSession[]) => {
    await Promise.all(sessions.map(session => transport.deleteSession(session.id).catch(() => {})));
  };

  const cleanupOwnedGridSessions = async (isCurrent: () => boolean = () => true) => {
    await cleanupNamedSessionsWithTransport(
      transport,
      new Set(),
      session => session.name.startsWith(gridSessionPrefix(connId)),
      isCurrent,
    );
  };

  const cleanupOwnedSingleSessions = async (isCurrent: () => boolean = () => true) => {
    await cleanupNamedSessionsWithTransport(
      transport,
      new Set(),
      session => session.name === singleSessionName(connId),
      isCurrent,
    );
  };

  const ensureSingleSession = async () => {
    if (ensureSingleInFlight) {
      await ensureSingleInFlight;
      return;
    }

    const epoch = singleEpoch;
    const isCurrent = () => modeValue === 'single' && singleEpoch === epoch;
    const assertCurrent = () => {
      if (!isCurrent()) {
        throw createStaleRuntimeError();
      }
    };

    const run = (async () => {
      setSingleBusy(true);
      setSingleError('');
      let createdSessionId = '';
      try {
        assertCurrent();
        const name = singleSessionName(connId);
        const stored = window.sessionStorage.getItem(SESSION_STORAGE_KEY) ?? '';
        const list = await transport.listSessions();
        assertCurrent();

        let chosen = '';
        if (singleSessionIdValue && list.some(item => item.id === singleSessionIdValue && item.name === name)) {
          chosen = singleSessionIdValue;
        } else if (stored && list.some(item => item.id === stored && item.name === name)) {
          chosen = stored;
        } else {
          chosen = list
            .filter(item => item.name === name)
            .sort((left, right) => right.createdAtMs - left.createdAtMs)[0]?.id ?? '';
        }

        if (!chosen) {
          const created = await transport.createSession(name, '');
          createdSessionId = created.id;
          chosen = created.id;
        }

        assertCurrent();
        await cleanupNamedSessionsWithTransport(
          transport,
          new Set([chosen]),
          session => session.name === name,
          isCurrent,
        );
        assertCurrent();
        window.sessionStorage.setItem(SESSION_STORAGE_KEY, chosen);
        setSingleSessionId(chosen);
      } catch (error) {
        if (isAbortError(error)) {
          if (createdSessionId) {
            await transport.deleteSession(createdSessionId).catch(() => {});
          }
          return;
        }
        setSingleError(error instanceof Error ? error.message : String(error));
      } finally {
        if (isCurrent()) {
          setSingleBusy(false);
        }
      }
    })();

    ensureSingleInFlight = run;
    try {
      await run;
    } finally {
      if (ensureSingleInFlight === run) {
        ensureSingleInFlight = null;
      }
    }
  };

  const restartSingleSession = async () => {
    const epoch = singleEpoch;
    const isCurrent = () => modeValue === 'single' && singleEpoch === epoch;
    const assertCurrent = () => {
      if (!isCurrent()) {
        throw createStaleRuntimeError();
      }
    };

    setSingleBusy(true);
    setSingleError('');
    let createdSessionId = '';
    try {
      const current = singleSessionIdValue;
      if (current) {
        await transport.deleteSession(current).catch(() => {});
      }
      assertCurrent();
      const created = await transport.createSession(singleSessionName(connId), '');
      createdSessionId = created.id;
      assertCurrent();
      await cleanupNamedSessionsWithTransport(
        transport,
        new Set([created.id]),
        session => session.name === singleSessionName(connId),
        isCurrent,
      );
      assertCurrent();
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, created.id);
      setSingleSessionId(created.id);
    } catch (error) {
      if (isAbortError(error)) {
        if (createdSessionId) {
          await transport.deleteSession(createdSessionId).catch(() => {});
        }
        return;
      }
      setSingleError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrent()) {
        setSingleBusy(false);
      }
    }
  };

  const performGridBuild = async (request: PendingGridRequest) => {
    if (modeValue !== 'grid') {
      return;
    }

    const epoch = gridEpoch;
    setGridBusy(true);
    setGridError('');
    resetTerminalRenderSchedulerStats();
    resetTerminalFabricDiagnostics();

    try {
      batch(() => {
        setGridSessions([]);
        setGridRuntimeBySession({});
        setActiveGridSessionId('');
      });

      const isCurrent = () => modeValue === 'grid' && gridEpoch === epoch;
      const existing = request.force
        ? null
        : pickReusableGridSessions(await transport.listSessions(), connId, request.count);
      if (!isCurrent()) {
        throw createStaleRuntimeError();
      }

      if (request.force) {
        await cleanupOwnedGridSessions(isCurrent);
      }

      const sessions = existing ?? [];
      const created: GridSession[] = [];
      try {
        for (let index = sessions.length; index < request.count; index += 1) {
          if (!isCurrent()) {
            throw createStaleRuntimeError();
          }
          const session = await transport.createSession(gridSessionName(connId, index), '');
          const gridSession = { id: session.id, name: session.name };
          sessions[index] = gridSession;
          created.push(gridSession);
        }
      } catch (error) {
        if (isAbortError(error)) {
          await disposeGridSessions(created);
        }
        throw error;
      }

      if (!isCurrent()) {
        await disposeGridSessions(sessions);
        throw createStaleRuntimeError();
      }

      await cleanupNamedSessionsWithTransport(
        transport,
        new Set(sessions.map(session => session.id)),
        session => session.name.startsWith(gridSessionPrefix(connId)),
        isCurrent,
      );
      batch(() => {
        setGridSessions(sessions);
        setGridRuntimeBySession({});
        setActiveGridSessionId(sessions[0]?.id ?? '');
      });
    } catch (error) {
      if (!isAbortError(error)) {
        setGridError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (modeValue === 'grid' && gridEpoch === epoch) {
        setGridBusy(false);
      }
    }
  };

  const rebuildGrid = async (count = gridCount(), options?: { force?: boolean }) => {
    if (modeValue !== 'grid') {
      return;
    }

    if (rebuildGridInFlight) {
      pendingGridRequest = {
        count,
        force: options?.force === true || pendingGridRequest?.force === true,
      };
      await rebuildGridInFlight;
      return;
    }

    let nextRequest: PendingGridRequest | null = {
      count,
      force: options?.force === true,
    };

    while (nextRequest) {
      pendingGridRequest = null;
      const run = performGridBuild(nextRequest);
      rebuildGridInFlight = run;
      await run;
      if (rebuildGridInFlight === run) {
        rebuildGridInFlight = null;
      }
      nextRequest = pendingGridRequest;
    }
  };

  const switchMode = (nextMode: DemoMode) => {
    if (nextMode === modeValue) {
      return;
    }

    modeValue = nextMode;
    if (nextMode === 'single') {
      gridEpoch += 1;
      pendingGridRequest = null;
      batch(() => {
        setGridBusy(false);
        setGridError('');
        setGridRuntimeBySession({});
        setActiveGridSessionId('');
      });
      const sessionsToDispose = gridSessionsValue;
      setGridSessions([]);
      void Promise.all([
        disposeGridSessions(sessionsToDispose),
        cleanupOwnedGridSessions(() => modeValue !== 'grid'),
      ]).catch(error => {
        if (!isAbortError(error) && modeValue !== 'grid') {
          setGridError(error instanceof Error ? error.message : String(error));
        }
      });
    } else {
      singleEpoch += 1;
      setSingleBusy(false);
      setSingleError('');
      const currentSingleSessionId = singleSessionIdValue;
      setSingleSessionId('');
      const stored = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (!currentSingleSessionId || stored === currentSingleSessionId) {
        window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      }
      void cleanupOwnedSingleSessions(() => modeValue === 'grid').catch(error => {
        if (!isAbortError(error) && modeValue === 'grid') {
          setGridError(error instanceof Error ? error.message : String(error));
        }
      });
    }

    setMode(nextMode);
    updateDemoModeSearchParams(nextMode, gridCount());
  };

  const changeGridCount = (nextCount: GridCount) => {
    setGridCount(nextCount);
    if (modeValue !== 'grid') {
      switchMode('grid');
      return;
    }
    void rebuildGrid(nextCount, { force: true });
  };

  const updateGridRuntimeState = (sessionId: string, state: string, connected: boolean, hasError: boolean) => {
    setGridRuntimeBySession(prev => {
      const current = prev[sessionId];
      if (current && current.state === state && current.connected === connected && current.hasError === hasError) {
        return prev;
      }
      return {
        ...prev,
        [sessionId]: { state, connected, hasError },
      };
    });
  };

  createEffect(() => {
    if (mode() === 'single') {
      void ensureSingleSession();
    }
  });

  createEffect(() => {
    if (mode() !== 'grid' || gridSessions().length > 0 || gridBusy()) {
      return;
    }
    void rebuildGrid();
  });

  onCleanup(() => {
    gridEpoch += 1;
    singleEpoch += 1;
    pendingGridRequest = null;
    const sessionsToDispose = gridSessionsValue;
    gridSessionsValue = [];
    void disposeGridSessions(sessionsToDispose);
  });

  return {
    connId,
    transport,
    eventSource,
    mode,
    gridCount,
    singleSessionId,
    singleBusy,
    singleError,
    gridSessions,
    gridBusy,
    gridError,
    activeGridSessionId,
    gridRuntimeStats,
    switchMode,
    restartSingleSession,
    changeGridCount,
    rebuildGrid,
    focusGridSession: setActiveGridSessionId,
    updateGridRuntimeState,
  };
};
