import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getTerminalRenderSchedulerStats,
  resetTerminalRenderSchedulerStats,
  useTerminalInstance,
  type TerminalRenderSchedulerStats,
  type TerminalThemeName,
} from '@floegence/floeterm-terminal-web';
import { createEventSource, createTransport, getOrCreateConnId, type AppTerminalTransport } from './terminalApi';

const SESSION_STORAGE_KEY = 'floeterm_session_id';
const THEME_STORAGE_KEY = 'floeterm_theme_name';
const MODE_STORAGE_KEY = 'floeterm_demo_mode';
const GRID_SIZE_STORAGE_KEY = 'floeterm_grid_size';
const HISTORY_STATS_POLL_MS = 2000;
const GRID_COUNTS = [4, 12, 24, 48] as const;

type DemoMode = 'single' | 'grid';
type GridCount = typeof GRID_COUNTS[number];

type GridSession = {
  id: string;
  name: string;
};

const formatBytes = (bytes: number): string => {
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

const formatNumber = (value: number, digits = 1): string => {
  if (!Number.isFinite(value)) {
    return '0';
  }

  return value.toFixed(digits);
};

const isThemeName = (value: string): value is TerminalThemeName => {
  return value === 'tokyoNight' || value === 'dark' || value === 'monokai' || value === 'solarizedDark' || value === 'light';
};

const isDemoMode = (value: string): value is DemoMode => {
  return value === 'single' || value === 'grid';
};

const readStoredGridCount = (): GridCount => {
  if (typeof window === 'undefined') {
    return 12;
  }

  const stored = Number(window.localStorage.getItem(GRID_SIZE_STORAGE_KEY));
  return GRID_COUNTS.includes(stored as GridCount) ? stored as GridCount : 12;
};

const buildLiveGridCommand = (label: string): string => {
  const escapedLabel = label.replace(/'/g, `'\\''`);
  return [
    'clear',
    `printf '\\033[1;36mfloeterm live fabric :: ${escapedLabel}\\033[0m\\n'`,
    'i=0',
    'while true; do',
    '  i=$((i+1))',
    `  printf '[${escapedLabel}] tick=%05d time=%s load=%s path=%s\\n' "$i" "$(date +%H:%M:%S)" "$(uptime | sed 's/^.*load averages*: //')" "$PWD"`,
    '  sleep 0.35',
    'done',
  ].join('; ') + '\r';
};

const useMediaQuery = (query: string): boolean => {
  const getMatch = () => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(getMatch);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);

    onChange();
    const legacyMql = mql as MediaQueryList & {
      addListener?: (listener: (this: MediaQueryList, ev: MediaQueryListEvent) => void) => void;
      removeListener?: (listener: (this: MediaQueryList, ev: MediaQueryListEvent) => void) => void;
    };

    if (typeof legacyMql.addEventListener === 'function') {
      legacyMql.addEventListener('change', onChange);
      return () => legacyMql.removeEventListener('change', onChange);
    }

    legacyMql.addListener?.(onChange);
    return () => legacyMql.removeListener?.(onChange);
  }, [query]);

  return matches;
};

const useThemeName = (): [TerminalThemeName, React.Dispatch<React.SetStateAction<TerminalThemeName>>] => {
  const [themeName, setThemeName] = useState<TerminalThemeName>(() => {
    if (typeof window === 'undefined') {
      return 'tokyoNight';
    }
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY) ?? '';
    return isThemeName(stored) ? stored : 'tokyoNight';
  });

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.dataset.theme = themeName;
  }, [themeName]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(THEME_STORAGE_KEY, themeName);
  }, [themeName]);

  return [themeName, setThemeName];
};

const SchedulerStatsPanel = () => {
  const [stats, setStats] = useState<TerminalRenderSchedulerStats>(() => getTerminalRenderSchedulerStats());
  const previousRef = useRef(stats);
  const [rates, setRates] = useState({ scheduled: 0, rendered: 0, frames: 0 });

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const intervalId = window.setInterval(() => {
      const current = getTerminalRenderSchedulerStats();
      const previous = previousRef.current;
      setRates({
        scheduled: current.scheduled - previous.scheduled,
        rendered: current.rendered - previous.rendered,
        frames: current.frameCount - previous.frameCount,
      });
      previousRef.current = current;
      setStats(current);
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <div className="schedulerPanel" aria-label="render scheduler stats">
      <div className="metric">
        <span className="metricLabel">scheduled/s</span>
        <span className="metricValue">{rates.scheduled}</span>
      </div>
      <div className="metric">
        <span className="metricLabel">rendered/s</span>
        <span className="metricValue">{rates.rendered}</span>
      </div>
      <div className="metric">
        <span className="metricLabel">frames/s</span>
        <span className="metricValue">{rates.frames}</span>
      </div>
      <div className="metric">
        <span className="metricLabel">last frame</span>
        <span className="metricValue">{stats.lastFrameRendered} terms</span>
      </div>
      <div className="metric">
        <span className="metricLabel">duration</span>
        <span className="metricValue">{formatNumber(stats.lastFrameDurationMs)} ms</span>
      </div>
      <div className="metric">
        <span className="metricLabel">pending</span>
        <span className="metricValue">{stats.pending}</span>
      </div>
    </div>
  );
};

const ThemeSelector = (props: {
  themeName: TerminalThemeName;
  disabled?: boolean;
  onThemeChange: (theme: TerminalThemeName) => void;
}) => {
  return (
    <select value={props.themeName} onChange={e => props.onThemeChange(e.target.value as TerminalThemeName)} disabled={props.disabled}>
      <option value="tokyoNight">tokyo night</option>
      <option value="dark">dark</option>
      <option value="monokai">monokai</option>
      <option value="solarizedDark">solarized dark</option>
      <option value="light">light</option>
    </select>
  );
};

const SingleTerminalPane = (props: {
  sessionId: string;
  transport: AppTerminalTransport;
  eventSource: ReturnType<typeof createEventSource>;
  themeName: TerminalThemeName;
  isBusy: boolean;
  error: string;
  onRestart: () => void;
  onThemeChange: (theme: TerminalThemeName) => void;
}) => {
  const isMobile = useMediaQuery('(max-width: 640px), (pointer: coarse)');
  const fontSize = isMobile ? 14 : 12;
  const { containerRef, actions, state, loadingMessage } = useTerminalInstance({
    sessionId: props.sessionId,
    isActive: true,
    autoFocus: !isMobile,
    fontSize,
    themeName: props.themeName,
    transport: props.transport,
    eventSource: props.eventSource
  });

  const [historyBytes, setHistoryBytes] = useState<number | null>(null);
  const isMountedRef = useRef(true);
  const clearStatsRefreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (typeof window !== 'undefined' && clearStatsRefreshTimerRef.current !== null) {
        window.clearTimeout(clearStatsRefreshTimerRef.current);
        clearStatsRefreshTimerRef.current = null;
      }
    };
  }, []);

  const refreshHistoryBytes = useCallback(async () => {
    try {
      const stats = await props.transport.getSessionStats(props.sessionId);
      if (!isMountedRef.current) {
        return;
      }
      setHistoryBytes(stats.history.totalBytes);
    } catch {
      // Best-effort: stats are purely informational and should not impact terminal usability.
    }
  }, [props.transport, props.sessionId]);

  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  useEffect(() => {
    actionsRef.current.forceResize();
  }, [fontSize]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const scheduleResize = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          actionsRef.current.forceResize();
        });
      });
    };

    scheduleResize();
    const postLayoutTimer = setTimeout(scheduleResize, 200);

    const onResize = () => scheduleResize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    const vv = window.visualViewport;
    vv?.addEventListener('resize', onResize);
    vv?.addEventListener('scroll', onResize);

    return () => {
      clearTimeout(postLayoutTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      vv?.removeEventListener('resize', onResize);
      vv?.removeEventListener('scroll', onResize);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    let intervalId: number | null = null;

    const stop = () => {
      if (intervalId === null) {
        return;
      }
      window.clearInterval(intervalId);
      intervalId = null;
    };

    const start = () => {
      if (HISTORY_STATS_POLL_MS <= 0) {
        return;
      }
      if (intervalId !== null) {
        return;
      }
      intervalId = window.setInterval(() => {
        refreshHistoryBytes();
      }, HISTORY_STATS_POLL_MS);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshHistoryBytes();
        start();
        return;
      }
      stop();
    };

    onVisibilityChange();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refreshHistoryBytes]);

  return (
    <>
      <div className="toolbar">
        <div className="toolbarPrimary">
          <span className="appTitle">floeterm</span>
          <span className="status">
            {state.state}
            {loadingMessage ? ` :: ${loadingMessage}` : ''}
            {historyBytes !== null ? ` :: history ${formatBytes(historyBytes)}` : ''}
          </span>
        </div>
        <div className="toolbarActions">
          <ThemeSelector themeName={props.themeName} onThemeChange={props.onThemeChange} disabled={props.isBusy} />
          <button onClick={props.onRestart} disabled={props.isBusy}>
            restart
          </button>
          <button
            onClick={() => {
              actions.clear();
              if (clearStatsRefreshTimerRef.current !== null) {
                window.clearTimeout(clearStatsRefreshTimerRef.current);
              }
              clearStatsRefreshTimerRef.current = window.setTimeout(() => {
                clearStatsRefreshTimerRef.current = null;
                refreshHistoryBytes();
              }, 150);
            }}
            disabled={props.isBusy}
          >
            clear
          </button>
        </div>
      </div>
      {props.error ? <div className="error">{props.error}</div> : null}
      <div className="terminalContainer">
        <div className="terminalPane" ref={containerRef} />
      </div>
    </>
  );
};

const GridTerminalTile = (props: {
  session: GridSession;
  transport: AppTerminalTransport;
  eventSource: ReturnType<typeof createEventSource>;
  themeName: TerminalThemeName;
  onFocus: (sessionId: string) => void;
}) => {
  const { containerRef, actions, state, loadingMessage } = useTerminalInstance({
    sessionId: props.session.id,
    isActive: true,
    autoFocus: false,
    fontSize: 11,
    themeName: props.themeName,
    transport: props.transport,
    eventSource: props.eventSource,
    config: {
      scrollback: 400,
      responsive: {
        fitOnFocus: true,
        emitResizeOnFocus: true,
        notifyResizeOnlyWhenFocused: true,
      },
    },
  });

  const didStartStreamRef = useRef(false);
  const actionsRef = useRef(actions);

  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  useEffect(() => {
    if (didStartStreamRef.current || !state.isConnected) {
      return;
    }
    didStartStreamRef.current = true;
    props.transport.sendInput(props.session.id, buildLiveGridCommand(props.session.name)).catch(() => {
      didStartStreamRef.current = false;
    });
  }, [props.session.id, props.session.name, props.transport, state.isConnected]);

  useEffect(() => {
    const scheduleResize = () => {
      requestAnimationFrame(() => {
        actionsRef.current.forceResize();
      });
    };

    scheduleResize();
  }, []);

  return (
    <section
      className="gridTerminalTile"
      onFocusCapture={() => props.onFocus(props.session.id)}
      onPointerDown={() => props.onFocus(props.session.id)}
    >
      <div className="tileHeader">
        <span className="tileName">{props.session.name}</span>
        <span className="tileState">{loadingMessage || state.state}</span>
      </div>
      <div className="tileTerminal" ref={containerRef} />
    </section>
  );
};

const GridTerminalDemo = (props: {
  transport: AppTerminalTransport;
  eventSource: ReturnType<typeof createEventSource>;
  themeName: TerminalThemeName;
  gridCount: GridCount;
  isBusy: boolean;
  error: string;
  sessions: GridSession[];
  activeSessionId: string;
  onGridCountChange: (count: GridCount) => void;
  onRebuild: () => void;
  onThemeChange: (theme: TerminalThemeName) => void;
  onFocusSession: (sessionId: string) => void;
}) => {
  return (
    <>
      <div className="toolbar gridToolbar">
        <div className="toolbarPrimary">
          <span className="appTitle">floeterm fabric</span>
          <span className="status">
            {props.isBusy ? 'building live grid...' : `${props.sessions.length} live terminals`}
            {props.activeSessionId ? ` :: active ${props.activeSessionId.slice(0, 8)}` : ''}
          </span>
        </div>
        <div className="toolbarActions">
          <div className="segmentedControl" aria-label="terminal count">
            {GRID_COUNTS.map(count => (
              <button
                key={count}
                className={count === props.gridCount ? 'isActive' : ''}
                onClick={() => props.onGridCountChange(count)}
                disabled={props.isBusy}
              >
                {count}
              </button>
            ))}
          </div>
          <ThemeSelector themeName={props.themeName} onThemeChange={props.onThemeChange} disabled={props.isBusy} />
          <button onClick={props.onRebuild} disabled={props.isBusy}>
            rebuild
          </button>
        </div>
      </div>
      {props.error ? <div className="error">{props.error}</div> : null}
      <div className="fabricShell">
        <SchedulerStatsPanel />
        <div className="gridTerminalContainer" data-count={props.gridCount}>
          {props.sessions.length === 0 ? (
            <div className="gridEmpty">{props.isBusy ? 'building live terminal grid' : 'no sessions'}</div>
          ) : (
            props.sessions.map((session, index) => (
              <GridTerminalTile
                key={session.id}
                session={session}
                transport={props.transport}
                eventSource={props.eventSource}
                themeName={props.themeName}
                onFocus={props.onFocusSession}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
};

export const App = () => {
  const connId = useMemo(() => getOrCreateConnId(), []);
  const transport = useMemo(() => createTransport(connId), [connId]);
  const eventSource = useMemo(() => createEventSource(connId), [connId]);
  const [themeName, setThemeName] = useThemeName();

  const [mode, setMode] = useState<DemoMode>(() => {
    if (typeof window === 'undefined') {
      return 'single';
    }
    const stored = window.localStorage.getItem(MODE_STORAGE_KEY) ?? '';
    return isDemoMode(stored) ? stored : 'single';
  });
  const [gridCount, setGridCount] = useState<GridCount>(() => readStoredGridCount());
  const [sessionId, setSessionId] = useState<string>('');
  const [gridSessions, setGridSessions] = useState<GridSession[]>([]);
  const [activeGridSessionId, setActiveGridSessionId] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const ensureSingleInFlightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(GRID_SIZE_STORAGE_KEY, String(gridCount));
  }, [gridCount]);

  const cleanupSessions = useCallback(async (keepIds: Set<string>) => {
    const list = await transport.listSessions();
    await Promise.all(
      list
        .filter(item => !keepIds.has(item.id))
        .map(item => transport.deleteSession(item.id).catch(() => {}))
    );
  }, [transport]);

  const ensureSingleSession = useCallback(async () => {
    if (ensureSingleInFlightRef.current) {
      await ensureSingleInFlightRef.current;
      return;
    }

    const run = (async () => {
      setIsBusy(true);
      setError('');

      try {
        const stored = window.sessionStorage.getItem(SESSION_STORAGE_KEY) ?? '';
        const list = await transport.listSessions();

        let chosen = '';
        if (sessionId && list.some(item => item.id === sessionId)) {
          chosen = sessionId;
        } else if (stored && list.some(item => item.id === stored)) {
          chosen = stored;
        } else if (list.length > 0 && !list[0].name.startsWith('grid-')) {
          chosen = list[0].id;
        } else {
          const created = await transport.createSession('', '');
          chosen = created.id;
        }

        await cleanupSessions(new Set([chosen]));
        window.sessionStorage.setItem(SESSION_STORAGE_KEY, chosen);
        setSessionId(chosen);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsBusy(false);
      }
    })();

    ensureSingleInFlightRef.current = run;
    try {
      await run;
    } finally {
      if (ensureSingleInFlightRef.current === run) {
        ensureSingleInFlightRef.current = null;
      }
    }
  }, [cleanupSessions, sessionId, transport]);

  const restartSession = useCallback(async () => {
    setIsBusy(true);
    setError('');

    try {
      const current = sessionId;
      if (current) {
        await transport.deleteSession(current).catch(() => {});
      }
      const created = await transport.createSession('', '');
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, created.id);
      setSessionId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(false);
    }
  }, [transport, sessionId]);

  const rebuildGrid = useCallback(async (count = gridCount) => {
    setIsBusy(true);
    setError('');
    resetTerminalRenderSchedulerStats();

    try {
      const created: GridSession[] = [];
      for (let index = 0; index < count; index += 1) {
        const name = `grid-${String(index + 1).padStart(2, '0')}`;
        const session = await transport.createSession(name, '');
        created.push({ id: session.id, name });
      }

      await cleanupSessions(new Set(created.map(session => session.id)));
      setGridSessions(created);
      setActiveGridSessionId(created[0]?.id ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(false);
    }
  }, [cleanupSessions, gridCount, transport]);

  const switchMode = useCallback((nextMode: DemoMode) => {
    setMode(nextMode);
    setError('');
  }, []);

  const changeGridCount = useCallback((nextCount: GridCount) => {
    setGridCount(nextCount);
    rebuildGrid(nextCount);
  }, [rebuildGrid]);

  useEffect(() => {
    if (mode === 'single') {
      ensureSingleSession().catch(e => setError(e instanceof Error ? e.message : String(e)));
    }
  }, [ensureSingleSession, mode]);

  useEffect(() => {
    if (mode !== 'grid' || gridSessions.length > 0 || isBusy) {
      return;
    }
    rebuildGrid().catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [gridSessions.length, isBusy, mode, rebuildGrid]);

  return (
    <div className="app">
      <div className="modeBar">
        <div className="modeBarBrand">
          <span>floeterm</span>
          <strong>live terminal fabric</strong>
        </div>
        <div className="modeSwitch" aria-label="demo mode">
          <button className={mode === 'single' ? 'isActive' : ''} onClick={() => switchMode('single')}>
            single
          </button>
          <button className={mode === 'grid' ? 'isActive' : ''} onClick={() => switchMode('grid')}>
            grid
          </button>
        </div>
      </div>
      <main className="main">
        {mode === 'grid' ? (
          <GridTerminalDemo
            transport={transport}
            eventSource={eventSource}
            themeName={themeName}
            gridCount={gridCount}
            isBusy={isBusy}
            error={error}
            sessions={gridSessions}
            activeSessionId={activeGridSessionId}
            onGridCountChange={changeGridCount}
            onRebuild={() => rebuildGrid()}
            onThemeChange={setThemeName}
            onFocusSession={setActiveGridSessionId}
          />
        ) : sessionId ? (
          <SingleTerminalPane
            key={sessionId}
            sessionId={sessionId}
            transport={transport}
            eventSource={eventSource}
            themeName={themeName}
            isBusy={isBusy}
            error={error}
            onRestart={restartSession}
            onThemeChange={setThemeName}
          />
        ) : (
          <>
            <div className="toolbar">
              <div className="toolbarPrimary">
                <span className="appTitle">floeterm</span>
                <span className="status">{isBusy ? 'initializing...' : 'idle'}</span>
              </div>
            </div>
            {error ? <div className="error">{error}</div> : null}
            <div className="terminalContainer">
              <div className="terminalPane">
                <div className="loading">{isBusy ? 'connecting' : 'waiting'}</div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
};
