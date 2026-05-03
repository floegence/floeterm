import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  createTerminalInstance,
  getTerminalFabricDiagnostics,
  getTerminalRenderSchedulerStats,
  type TerminalFabricDiagnostics,
  type TerminalInstanceController,
  type TerminalInstanceSnapshot,
  type TerminalManagerActions,
  type TerminalRenderSchedulerStats,
  TerminalState,
  type TerminalThemeName,
} from '@floegence/floeterm-terminal-web';
import { type AppTerminalTransport } from './terminalApi';
import {
  buildLiveGridCommand,
  createFloetermDemoRuntime,
  createProgressiveCount,
  formatBytes,
  formatNumber,
  GRID_COUNTS,
  GRID_MOUNT_BATCH_DELAY_MS,
  GRID_MOUNT_BATCH_SIZE,
  gridStreamStartDelay,
  type DemoEventSource,
  type GridCount,
  type GridRuntimeStats,
  type GridSession,
} from './demoRuntime';

const THEME_STORAGE_KEY = 'floeterm_theme_name';
const HISTORY_STATS_POLL_MS = 2000;

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

const isThemeName = (value: string): value is TerminalThemeName => {
  return value === 'tokyoNight' || value === 'dark' || value === 'monokai' || value === 'solarizedDark' || value === 'light';
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
  const [fabric, setFabric] = createSignal<TerminalFabricDiagnostics>(getTerminalFabricDiagnostics());
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
      setFabric(getTerminalFabricDiagnostics());
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
      <div class="metric metricStrong">
        <span class="metricLabel">renderer</span>
        <span class="metricValue">{fabric().backend === 'beamterm_webgl2' ? 'Beamterm' : 'Canvas'}</span>
      </div>
      <div class="metric">
        <span class="metricLabel">path</span>
        <span class="metricValue">{fabric().renderPath === 'main_thread_webgl2' ? 'WebGL2' : 'fallback'}</span>
      </div>
      <div class="metric">
        <span class="metricLabel">active</span>
        <span class="metricValue">{fabric().activeRendererCount}</span>
      </div>
      <div class="metric">
        <span class="metricLabel">fabric rows</span>
        <span class="metricValue">{fabric().lastFrameRenderedRows}</span>
      </div>
      <div class="metric">
        <span class="metricLabel">fabric cells</span>
        <span class="metricValue">{fabric().lastFrameDirtyCells}</span>
      </div>
      <div class="metric">
        <span class="metricLabel">webgl/wasm</span>
        <span class="metricValue">{fabric().webgl2Supported && fabric().beamtermLoaded ? 'ready' : 'loading'}</span>
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
  eventSource: DemoEventSource;
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
    config: {
      rendererType: 'webgl',
    },
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
    const parts: string[] = [
      snapshot.connection.isConnected ? 'live' : snapshot.connection.error?.message || snapshot.connection.state,
    ];
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
  eventSource: DemoEventSource;
  themeName: TerminalThemeName;
  streamStartDelayMs: number;
  onFocus: (sessionId: string) => void;
  onRuntimeState: (sessionId: string, state: string, connected: boolean, hasError: boolean) => void;
}) => {
  const terminal = createSolidTerminal(() => ({
    sessionId: props.session.id,
    isActive: true,
    autoFocus: false,
    fontSize: 8,
    themeName: props.themeName,
    transport: props.transport,
    eventSource: props.eventSource,
    config: {
      scrollback: 400,
      fit: {
        scrollbarReservePx: 0,
      },
      responsive: {
        fitOnFocus: true,
        emitResizeOnFocus: true,
        notifyResizeOnlyWhenFocused: false,
      },
      rendererType: 'webgl',
    },
  }));

  let didStartStream = false;
  const isLive = createMemo(() => terminal.snapshot().connection.isConnected);
  const tileStatus = createMemo(() => {
    const snapshot = terminal.snapshot();
    return snapshot.state.hasError
      ? 'error'
      : snapshot.connection.error?.message || snapshot.loadingMessage || (snapshot.connection.isConnected ? 'live' : snapshot.connection.state);
  });

  createEffect(() => {
    const snapshot = terminal.snapshot();
    props.onRuntimeState(props.session.id, tileStatus(), snapshot.connection.isConnected, snapshot.state.hasError);
  });

  createEffect(() => {
    if (didStartStream || !isLive()) {
      return;
    }
    didStartStream = true;
    const timeoutId = window.setTimeout(() => {
      props.transport.sendInput(props.session.id, '\u0003' + buildLiveGridCommand(props.session.name)).catch(() => {
        didStartStream = false;
      });
    }, props.streamStartDelayMs);
    onCleanup(() => window.clearTimeout(timeoutId));
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
    const settleTimer = window.setTimeout(scheduleResize, 180);
    window.addEventListener('resize', scheduleResize);

    onCleanup(() => {
      window.clearTimeout(settleTimer);
      window.removeEventListener('resize', scheduleResize);
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
        <span class="tileState">{tileStatus()}</span>
      </div>
      <div class="tileTerminal" ref={terminal.mount} />
    </section>
  );
};

const GridTerminalTileShell = (props: {
  name: string;
  status: string;
}) => (
  <section class="gridTerminalTile gridTerminalTileShell">
    <div class="tileHeader">
      <span class="tileName">{props.name}</span>
      <span class="tileState">{props.status}</span>
    </div>
    <div class="tileTerminal tileTerminalShell" aria-hidden="true">
      <span>live slot</span>
    </div>
  </section>
);

const GridTerminalDemo = (props: {
  transport: AppTerminalTransport;
  eventSource: DemoEventSource;
  themeName: TerminalThemeName;
  gridCount: GridCount;
  isBusy: boolean;
  error: string;
  sessions: GridSession[];
  activeSessionId: string;
  runtimeStats: GridRuntimeStats;
  onGridCountChange: (count: GridCount) => void;
  onRebuild: () => void;
  onThemeChange: (theme: TerminalThemeName) => void;
  onFocusSession: (sessionId: string) => void;
  onRuntimeState: (sessionId: string, state: string, connected: boolean, hasError: boolean) => void;
}) => {
  const hydratedCount = createProgressiveCount(() => props.sessions.length, GRID_MOUNT_BATCH_SIZE, GRID_MOUNT_BATCH_DELAY_MS);

  return (
    <>
    <div class="toolbar gridToolbar">
      <div class="toolbarPrimary">
        <span class="appTitle">floeterm fabric</span>
        <span class="status">
          {props.isBusy ? 'building live grid...' : `${props.sessions.length} live terminals`}
          {hydratedCount() < props.sessions.length ? ` :: hydrating ${hydratedCount()}/${props.sessions.length}` : ''}
          {props.sessions.length > 0 ? ` :: connected ${props.runtimeStats.connected}/${props.sessions.length}` : ''}
          {props.runtimeStats.errors > 0 ? ` :: errors ${props.runtimeStats.errors}` : ''}
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
            {(session, index) => (
              <Show
                when={index() < hydratedCount()}
                fallback={<GridTerminalTileShell name={session.name} status="queued" />}
              >
                <GridTerminalTile
                  session={session}
                  transport={props.transport}
                  eventSource={props.eventSource}
                  themeName={props.themeName}
                  streamStartDelayMs={gridStreamStartDelay(index())}
                  onFocus={props.onFocusSession}
                  onRuntimeState={props.onRuntimeState}
                />
              </Show>
            )}
          </For>
        </Show>
      </div>
    </div>
    </>
  );
};

export const App = () => {
  const demo = createFloetermDemoRuntime();
  const [themeName, setThemeName] = createThemeName();

  return (
    <div class="app">
      <div
        hidden
        data-testid="demo-runtime-state"
        data-mode={demo.mode()}
        data-single-session-id={demo.singleSessionId()}
        data-single-busy={demo.singleBusy() ? 'true' : 'false'}
        data-single-error={demo.singleError()}
        data-grid-busy={demo.gridBusy() ? 'true' : 'false'}
        data-grid-session-count={demo.gridSessions().length}
        data-grid-connected={demo.gridRuntimeStats().connected}
        data-grid-errors={demo.gridRuntimeStats().errors}
      />
      <div class="modeBar">
        <div class="modeBarBrand">
          <span>floeterm</span>
          <strong>live terminal fabric</strong>
        </div>
        <div class="modeSwitch" aria-label="demo mode">
          <button class={demo.mode() === 'single' ? 'isActive' : ''} onClick={() => demo.switchMode('single')}>single</button>
          <button class={demo.mode() === 'grid' ? 'isActive' : ''} onClick={() => demo.switchMode('grid')}>grid</button>
        </div>
      </div>
      <main class="main">
        <Show
          when={demo.mode() === 'grid'}
          fallback={(
            <Show
              when={demo.singleSessionId()}
              fallback={(
                <>
                  <div class="toolbar">
                    <div class="toolbarPrimary">
                      <span class="appTitle">floeterm</span>
                      <span class="status">{demo.singleBusy() ? 'initializing...' : 'idle'}</span>
                    </div>
                  </div>
                  <Show when={demo.singleError()}>
                    <div class="error">{demo.singleError()}</div>
                  </Show>
                  <div class="terminalContainer">
                    <div class="terminalPane">
                      <div class="loading">{demo.singleBusy() ? 'connecting' : 'waiting'}</div>
                    </div>
                  </div>
                </>
              )}
            >
              {id => (
                <SingleTerminalPane
                  sessionId={id()}
                  transport={demo.transport}
                  eventSource={demo.eventSource}
                  themeName={themeName()}
                  isBusy={demo.singleBusy()}
                  error={demo.singleError()}
                  onRestart={() => void demo.restartSingleSession()}
                  onThemeChange={setThemeName}
                />
              )}
            </Show>
          )}
        >
          <GridTerminalDemo
            transport={demo.transport}
            eventSource={demo.eventSource}
            themeName={themeName()}
            gridCount={demo.gridCount()}
            isBusy={demo.gridBusy()}
            error={demo.gridError()}
            sessions={demo.gridSessions()}
            activeSessionId={demo.activeGridSessionId()}
            runtimeStats={demo.gridRuntimeStats()}
            onGridCountChange={demo.changeGridCount}
            onRebuild={() => void demo.rebuildGrid(demo.gridCount(), { force: true })}
            onThemeChange={setThemeName}
            onFocusSession={demo.focusGridSession}
            onRuntimeState={demo.updateGridRuntimeState}
          />
        </Show>
      </main>
    </div>
  );
};
