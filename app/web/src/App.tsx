import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  createTerminalInstance,
  getTerminalRenderSchedulerStats,
  resetTerminalRenderSchedulerStats,
  type TerminalInstanceController,
  type TerminalInstanceSnapshot,
  type TerminalManagerActions,
  type TerminalRenderSchedulerStats,
  TerminalState,
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

const noopActions: TerminalManagerActions = {
  write: () => {},
  clear: () => {},
  findNext: () => false,
  findPrevious: () => false,
  clearSearch: () => {},
  serialize: () => '',
  getSelectionText: () => '',
  hasSelection: () => false,
  copySelection: source => Promise.resolve({ copied: false, reason: 'empty_selection', source: source ?? 'command' }),
  setConnected: () => {},
  forceResize: () => {},
  setSearchResultsCallback: () => {},
  focus: () => {},
  getTerminalInfo: () => null,
  sendInput: () => {},
  setAppearance: () => {},
  setTheme: () => {},
  setFontSize: () => {},
  setPresentationScale: () => {},
};

const initialTerminalSnapshot: TerminalInstanceSnapshot = {
  state: {
    state: TerminalState.IDLE,
    dimensions: { cols: 80, rows: 24 },
    get isReady() { return false; },
    get isConnected() { return false; },
    get hasError() { return false; },
    get isInitializing() { return false; },
    get isIdle() { return true; },
  },
  connection: {
    state: 'idle',
    error: null,
    retryCount: 0,
    connect: () => {},
    disconnect: () => {},
    retry: () => {},
    clearError: () => {},
    get isConnecting() { return false; },
    get isConnected() { return false; },
  },
  loadingState: 'idle',
  loadingMessage: '',
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

const createMediaQuery = (query: string) => {
  const [matches, setMatches] = createSignal(typeof window !== 'undefined' ? window.matchMedia(query).matches : false);

  onMount(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    onCleanup(() => mql.removeEventListener('change', onChange));
  });

  return matches;
};

const createThemeName = () => {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY) ?? '';
  const [themeName, setThemeName] = createSignal<TerminalThemeName>(isThemeName(stored) ? stored : 'tokyoNight');

  createEffect(() => {
    document.documentElement.dataset.theme = themeName();
    window.localStorage.setItem(THEME_STORAGE_KEY, themeName());
  });

  return [themeName, setThemeName] as const;
};

const createSolidTerminal = (options: () => Parameters<typeof createTerminalInstance>[0]) => {
  const [snapshot, setSnapshot] = createSignal<TerminalInstanceSnapshot>(initialTerminalSnapshot);
  const [actions, setActions] = createSignal<TerminalManagerActions>(noopActions);
  let controller: TerminalInstanceController | null = null;
  let container: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;

  const ensureController = () => {
    if (controller) {
      return controller;
    }
    controller = createTerminalInstance(options());
    setActions(() => controller!.actions);
    unsubscribe = controller.subscribe(next => setSnapshot(next));
    return controller;
  };

  const mount = (node: HTMLDivElement) => {
    container = node;
    const nextController = ensureController();
    void nextController.mount(node);
  };

  createEffect(() => {
    const nextOptions = options();
    if (!controller) {
      return;
    }
    controller.updateOptions(nextOptions);
  });

  onCleanup(() => {
    unsubscribe?.();
    unsubscribe = null;
    controller?.dispose();
    controller = null;
    container = null;
  });

  return {
    mount,
    snapshot,
    actions,
    getContainer: () => container,
  };
};

const SchedulerStatsPanel = () => {
  const [stats, setStats] = createSignal<TerminalRenderSchedulerStats>(getTerminalRenderSchedulerStats());
  let previous = stats();
  const [rates, setRates] = createSignal({ scheduled: 0, rendered: 0, frames: 0 });

  onMount(() => {
    const intervalId = window.setInterval(() => {
      const current = getTerminalRenderSchedulerStats();
      setRates({
        scheduled: current.scheduled - previous.scheduled,
        rendered: current.rendered - previous.rendered,
        frames: current.frameCount - previous.frameCount,
      });
      previous = current;
      setStats(current);
    }, 1000);

    onCleanup(() => window.clearInterval(intervalId));
  });

  return (
    <div class="schedulerPanel" aria-label="render scheduler stats">
      <div class="metric">
        <span class="metricLabel">scheduled/s</span>
        <span class="metricValue">{rates().scheduled}</span>
      </div>
      <div class="metric">
        <span class="metricLabel">rendered/s</span>
        <span class="metricValue">{rates().rendered}</span>
      </div>
      <div class="metric">
        <span class="metricLabel">frames/s</span>
        <span class="metricValue">{rates().frames}</span>
      </div>
      <div class="metric">
        <span class="metricLabel">last frame</span>
        <span class="metricValue">{stats().lastFrameRendered} terms</span>
      </div>
      <div class="metric">
        <span class="metricLabel">duration</span>
        <span class="metricValue">{formatNumber(stats().lastFrameDurationMs)} ms</span>
      </div>
      <div class="metric">
        <span class="metricLabel">pending</span>
        <span class="metricValue">{stats().pending}</span>
      </div>
    </div>
  );
};

const ThemeSelector = (props: {
  themeName: TerminalThemeName;
  disabled?: boolean;
  onThemeChange: (theme: TerminalThemeName) => void;
}) => (
  <select value={props.themeName} onChange={e => props.onThemeChange(e.currentTarget.value as TerminalThemeName)} disabled={props.disabled}>
    <option value="tokyoNight">tokyo night</option>
    <option value="dark">dark</option>
    <option value="monokai">monokai</option>
    <option value="solarizedDark">solarized dark</option>
    <option value="light">light</option>
  </select>
);

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
  const isMobile = createMediaQuery('(max-width: 640px), (pointer: coarse)');
  const fontSize = createMemo(() => (isMobile() ? 14 : 12));
  const terminal = createSolidTerminal(() => ({
    sessionId: props.sessionId,
    isActive: true,
    autoFocus: !isMobile(),
    fontSize: fontSize(),
    themeName: props.themeName,
    transport: props.transport,
    eventSource: props.eventSource,
  }));

  const [historyBytes, setHistoryBytes] = createSignal<number | null>(null);
  let mounted = true;
  let clearStatsRefreshTimer: number | null = null;

  const refreshHistoryBytes = async () => {
    try {
      const stats = await props.transport.getSessionStats(props.sessionId);
      if (!mounted) {
        return;
      }
      setHistoryBytes(stats.history.totalBytes);
    } catch {
    }
  };

  createEffect(() => {
    void fontSize();
    terminal.actions().forceResize();
  });

  onMount(() => {
    const scheduleResize = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          terminal.actions().forceResize();
        });
      });
    };

    scheduleResize();
    const postLayoutTimer = window.setTimeout(scheduleResize, 200);
    window.addEventListener('resize', scheduleResize);
    window.addEventListener('orientationchange', scheduleResize);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', scheduleResize);
    vv?.addEventListener('scroll', scheduleResize);

    let intervalId: number | null = null;
    const stop = () => {
      if (intervalId === null) {
        return;
      }
      window.clearInterval(intervalId);
      intervalId = null;
    };
    const start = () => {
      if (HISTORY_STATS_POLL_MS <= 0 || intervalId !== null) {
        return;
      }
      intervalId = window.setInterval(refreshHistoryBytes, HISTORY_STATS_POLL_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshHistoryBytes();
        start();
        return;
      }
      stop();
    };
    onVisibilityChange();
    document.addEventListener('visibilitychange', onVisibilityChange);

    onCleanup(() => {
      mounted = false;
      window.clearTimeout(postLayoutTimer);
      window.removeEventListener('resize', scheduleResize);
      window.removeEventListener('orientationchange', scheduleResize);
      vv?.removeEventListener('resize', scheduleResize);
      vv?.removeEventListener('scroll', scheduleResize);
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (clearStatsRefreshTimer !== null) {
        window.clearTimeout(clearStatsRefreshTimer);
        clearStatsRefreshTimer = null;
      }
    });
  });

  const clearTerminal = () => {
    terminal.actions().clear();
    if (clearStatsRefreshTimer !== null) {
      window.clearTimeout(clearStatsRefreshTimer);
    }
    clearStatsRefreshTimer = window.setTimeout(() => {
      clearStatsRefreshTimer = null;
      void refreshHistoryBytes();
    }, 150);
  };

  const status = createMemo(() => {
    const snapshot = terminal.snapshot();
    const parts: string[] = [snapshot.state.state];
    if (snapshot.loadingMessage) {
      parts.push(snapshot.loadingMessage);
    }
    const bytes = historyBytes();
    if (bytes !== null) {
      parts.push(`history ${formatBytes(bytes)}`);
    }
    return parts.join(' :: ');
  });

  return (
    <>
      <div class="toolbar">
        <div class="toolbarPrimary">
          <span class="appTitle">floeterm</span>
          <span class="status">{status()}</span>
        </div>
        <div class="toolbarActions">
          <ThemeSelector themeName={props.themeName} onThemeChange={props.onThemeChange} disabled={props.isBusy} />
          <button onClick={props.onRestart} disabled={props.isBusy}>restart</button>
          <button onClick={clearTerminal} disabled={props.isBusy}>clear</button>
        </div>
      </div>
      <Show when={props.error}>
        <div class="error">{props.error}</div>
      </Show>
      <div class="terminalContainer">
        <div class="terminalPane" ref={terminal.mount} />
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
  const terminal = createSolidTerminal(() => ({
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
  }));

  let didStartStream = false;

  createEffect(() => {
    if (didStartStream || !terminal.snapshot().state.isConnected) {
      return;
    }
    didStartStream = true;
    props.transport.sendInput(props.session.id, buildLiveGridCommand(props.session.name)).catch(() => {
      didStartStream = false;
    });
  });

  onMount(() => {
    requestAnimationFrame(() => {
      terminal.actions().forceResize();
    });
  });

  return (
    <section
      class="gridTerminalTile"
      onFocusIn={() => props.onFocus(props.session.id)}
      onPointerDown={() => props.onFocus(props.session.id)}
    >
      <div class="tileHeader">
        <span class="tileName">{props.session.name}</span>
        <span class="tileState">{terminal.snapshot().loadingMessage || terminal.snapshot().state.state}</span>
      </div>
      <div class="tileTerminal" ref={terminal.mount} />
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
}) => (
  <>
    <div class="toolbar gridToolbar">
      <div class="toolbarPrimary">
        <span class="appTitle">floeterm fabric</span>
        <span class="status">
          {props.isBusy ? 'building live grid...' : `${props.sessions.length} live terminals`}
          {props.activeSessionId ? ` :: active ${props.activeSessionId.slice(0, 8)}` : ''}
        </span>
      </div>
      <div class="toolbarActions">
        <div class="segmentedControl" aria-label="terminal count">
          <For each={GRID_COUNTS}>
            {count => (
              <button
                class={count === props.gridCount ? 'isActive' : ''}
                onClick={() => props.onGridCountChange(count)}
                disabled={props.isBusy}
              >
                {count}
              </button>
            )}
          </For>
        </div>
        <ThemeSelector themeName={props.themeName} onThemeChange={props.onThemeChange} disabled={props.isBusy} />
        <button onClick={props.onRebuild} disabled={props.isBusy}>rebuild</button>
      </div>
    </div>
    <Show when={props.error}>
      <div class="error">{props.error}</div>
    </Show>
    <div class="fabricShell">
      <SchedulerStatsPanel />
      <div class="gridTerminalContainer" data-count={props.gridCount}>
        <Show
          when={props.sessions.length > 0}
          fallback={<div class="gridEmpty">{props.isBusy ? 'building live terminal grid' : 'no sessions'}</div>}
        >
          <For each={props.sessions}>
            {session => (
              <GridTerminalTile
                session={session}
                transport={props.transport}
                eventSource={props.eventSource}
                themeName={props.themeName}
                onFocus={props.onFocusSession}
              />
            )}
          </For>
        </Show>
      </div>
    </div>
  </>
);

export const App = () => {
  const connId = getOrCreateConnId();
  const transport = createTransport(connId);
  const eventSource = createEventSource(connId);
  const [themeName, setThemeName] = createThemeName();

  const storedMode = window.localStorage.getItem(MODE_STORAGE_KEY) ?? '';
  const [mode, setMode] = createSignal<DemoMode>(isDemoMode(storedMode) ? storedMode : 'single');
  const [gridCount, setGridCount] = createSignal<GridCount>(readStoredGridCount());
  const [sessionId, setSessionId] = createSignal('');
  const [gridSessions, setGridSessions] = createSignal<GridSession[]>([]);
  const [activeGridSessionId, setActiveGridSessionId] = createSignal('');
  const [isBusy, setIsBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  let ensureSingleInFlight: Promise<void> | null = null;

  createEffect(() => {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode());
  });

  createEffect(() => {
    window.localStorage.setItem(GRID_SIZE_STORAGE_KEY, String(gridCount()));
  });

  const cleanupSessions = async (keepIds: Set<string>) => {
    const list = await transport.listSessions();
    await Promise.all(
      list
        .filter(item => !keepIds.has(item.id))
        .map(item => transport.deleteSession(item.id).catch(() => {}))
    );
  };

  const ensureSingleSession = async () => {
    if (ensureSingleInFlight) {
      await ensureSingleInFlight;
      return;
    }

    const run = (async () => {
      setIsBusy(true);
      setError('');

      try {
        const stored = window.sessionStorage.getItem(SESSION_STORAGE_KEY) ?? '';
        const list = await transport.listSessions();
        const current = sessionId();

        let chosen = '';
        if (current && list.some(item => item.id === current)) {
          chosen = current;
        } else if (stored && list.some(item => item.id === stored)) {
          chosen = stored;
        } else if (list.length > 0 && !list[0]!.name.startsWith('grid-')) {
          chosen = list[0]!.id;
        } else {
          const created = await transport.createSession('', '');
          chosen = created.id;
        }

        await cleanupSessions(new Set([chosen]));
        window.sessionStorage.setItem(SESSION_STORAGE_KEY, chosen);
        setGridSessions([]);
        setActiveGridSessionId('');
        setSessionId(chosen);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsBusy(false);
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

  const restartSession = async () => {
    setIsBusy(true);
    setError('');

    try {
      const current = sessionId();
      if (current) {
        await transport.deleteSession(current).catch(() => {});
      }
      const created = await transport.createSession('', '');
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, created.id);
      setSessionId(created.id);
      await cleanupSessions(new Set([created.id]));
      setGridSessions([]);
      setActiveGridSessionId('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsBusy(false);
    }
  };

  const rebuildGrid = async (count = gridCount()) => {
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
  };

  const switchMode = (nextMode: DemoMode) => {
    setMode(nextMode);
    setError('');
    if (nextMode === 'single') {
      setGridSessions([]);
      setActiveGridSessionId('');
    }
  };

  const changeGridCount = (nextCount: GridCount) => {
    setGridCount(nextCount);
    void rebuildGrid(nextCount);
  };

  createEffect(() => {
    if (mode() === 'single') {
      void ensureSingleSession();
    }
  });

  createEffect(() => {
    if (mode() !== 'grid' || gridSessions().length > 0 || isBusy()) {
      return;
    }
    void rebuildGrid();
  });

  return (
    <div class="app">
      <div class="modeBar">
        <div class="modeBarBrand">
          <span>floeterm</span>
          <strong>live terminal fabric</strong>
        </div>
        <div class="modeSwitch" aria-label="demo mode">
          <button class={mode() === 'single' ? 'isActive' : ''} onClick={() => switchMode('single')}>single</button>
          <button class={mode() === 'grid' ? 'isActive' : ''} onClick={() => switchMode('grid')}>grid</button>
        </div>
      </div>
      <main class="main">
        <Show
          when={mode() === 'grid'}
          fallback={(
            <Show
              when={sessionId()}
              fallback={(
                <>
                  <div class="toolbar">
                    <div class="toolbarPrimary">
                      <span class="appTitle">floeterm</span>
                      <span class="status">{isBusy() ? 'initializing...' : 'idle'}</span>
                    </div>
                  </div>
                  <Show when={error()}>
                    <div class="error">{error()}</div>
                  </Show>
                  <div class="terminalContainer">
                    <div class="terminalPane">
                      <div class="loading">{isBusy() ? 'connecting' : 'waiting'}</div>
                    </div>
                  </div>
                </>
              )}
            >
              {id => (
                <SingleTerminalPane
                  sessionId={id()}
                  transport={transport}
                  eventSource={eventSource}
                  themeName={themeName()}
                  isBusy={isBusy()}
                  error={error()}
                  onRestart={() => void restartSession()}
                  onThemeChange={setThemeName}
                />
              )}
            </Show>
          )}
        >
          <GridTerminalDemo
            transport={transport}
            eventSource={eventSource}
            themeName={themeName()}
            gridCount={gridCount()}
            isBusy={isBusy()}
            error={error()}
            sessions={gridSessions()}
            activeSessionId={activeGridSessionId()}
            onGridCountChange={changeGridCount}
            onRebuild={() => void rebuildGrid()}
            onThemeChange={setThemeName}
            onFocusSession={setActiveGridSessionId}
          />
        </Show>
      </main>
    </div>
  );
};
