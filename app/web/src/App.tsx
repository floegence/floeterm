import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  RendererSurface,
  createTerminalInstance,
  isTerminalThemeName,
  getTerminalFabricDiagnostics,
  getTerminalRenderSchedulerStats,
  type TerminalFabricDiagnostics,
  type TerminalInstanceController,
  type TerminalInstanceSnapshot,
  type TerminalManagerActions,
  type TerminalRenderSchedulerStats,
  TerminalState,
  validatePresentation,
  type SemanticPresentation,
  type TerminalThemeName,
} from '@floegence/floeterm-terminal-web';
import { applyTerminalThemeShell, ThemeSelector } from './themeCatalog';
import { createTerminalRuntime, type AppTerminalTransport } from './terminalApi';
import { createSemanticResizeController } from './semanticResizeController';
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

type FloetermPerfHarness = {
  sendInput(data: string): void;
  clear(): void;
  serialize(): string;
  getVisibleLines(): string[];
  getSelectionText(): string;
  hasSelection(): boolean;
  getTerminalInfo(): ReturnType<TerminalManagerActions['getTerminalInfo']>;
  getPresentationDiagnostics?(): SemanticPresentation | null;
  getResizeDiagnostics?(): readonly unknown[];
  getSnapshot(): TerminalInstanceSnapshot;
  getFabricDiagnostics(): TerminalFabricDiagnostics;
  forceResize(): void;
  getGeometryDiagnostics(): { generation: number; outputSequenceBoundary: number; cols: number; rows: number };
  getStreamDiagnostics(): {
    dataEvents: number;
    firstSequence: number;
    lastSequence: number;
    sequenceGaps: number;
    totalBytes: number;
    hash: number;
    tail: string;
  };
  resetStreamDiagnostics(afterSequence?: number): void;
};

type FloetermMirrorViewHarness = FloetermPerfHarness & {
  label: string;
  forceResize(): void;
  synchronizeSize(): Promise<void>;
  getStreamDiagnostics(): {
    dataEvents: number;
    firstSequence: number;
    lastSequence: number;
    totalBytes: number;
    hash: number;
  };
  getRenderDiagnostics(): { count: number; lastRenderAtMs: number };
  resetRenderDiagnostics(): void;
  resetStreamDiagnostics(afterSequence?: number): void;
  reconnect(): void;
};

type FloetermMirrorHarness = {
  getViews(): FloetermMirrorViewHarness[];
  getRuntimeState(): { connectedCount: number; errorCount: number };
};

type FloetermPerfWindow = Window & {
  __floetermPerfHarness?: FloetermPerfHarness;
  __floetermMirrorHarness?: FloetermMirrorHarness;
};

const noopActions: TerminalManagerActions = {
  write: () => {},
  clear: () => {},
  findNext: () => false,
  findPrevious: () => false,
  clearSearch: () => {},
  serialize: () => '',
  readBufferLine: () => '',
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
  const [themeName, setThemeName] = createSignal<TerminalThemeName>(isTerminalThemeName(stored) ? stored : 'tokyoNight');

  createEffect(() => {
    const nextTheme = themeName();
    applyTerminalThemeShell(document.documentElement, nextTheme);
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
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
        <span class="metricValue">Beamterm</span>
      </div>
      <div class="metric">
        <span class="metricLabel">path</span>
        <span class="metricValue">WebGL2</span>
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

const SingleTerminalPane = (props: {
  sessionId: string;
  transport: AppTerminalTransport;
  eventSource: DemoEventSource;
  themeName: TerminalThemeName;
  isBusy: boolean;
  error: string;
  canRestart: boolean;
  onRestart: () => void;
  onThemeChange: (theme: TerminalThemeName) => void;
}) => {
  const initialStreamDiagnostics = () => ({
    dataEvents: 0,
    firstSequence: 0,
    lastSequence: 0,
    sequenceGaps: 0,
    totalBytes: 0,
    hash: 2166136261,
    tail: '',
  });
  let streamDiagnostics = initialStreamDiagnostics();
  let streamDecoder = new TextDecoder();
  let streamDiagnosticsAfterSequence = 0;
  let geometryDiagnostics = { generation: 0, outputSequenceBoundary: 0, cols: 0, rows: 0 };
  const [historyBytes, setHistoryBytes] = createSignal<number | null>(null);
  let mounted = true;
  let clearStatsRefreshTimer: number | null = null;
	let semanticCanvas: HTMLCanvasElement | undefined;
	let semanticRenderer: RendererSurface | undefined;
	let inputBridge: HTMLTextAreaElement | undefined;
  const [presentationError, setPresentationError] = createSignal('');
  let liveConnected = false;
  let latestPresentation: SemanticPresentation | null = null;
  const resizeDiagnostics: unknown[] = [];
  const recordResizeDiagnostic = (value: unknown) => {
    resizeDiagnostics.push(value);
    if (resizeDiagnostics.length > 64) resizeDiagnostics.shift();
  };
  let viewDimensions = { cols: 80, rows: 24 };
  const measuredDimensions = () => {
    const host = semanticCanvas?.parentElement?.getBoundingClientRect();
    if (!host) return viewDimensions;
    return {
      cols: Math.max(20, Math.min(500, Math.floor(host.width / 9))),
      rows: Math.max(5, Math.min(200, Math.floor(host.height / 18))),
    };
  };
  const semanticResize = createSemanticResizeController({
    measure: () => {
      const dimensions = measuredDimensions();
      viewDimensions = dimensions;
      return dimensions;
    },
    repaint: () => { semanticRenderer?.resize(); },
    attach: async dimensions => {
      recordResizeDiagnostic({ action: 'attach-requested', dimensions: { ...dimensions } });
      const attached = await props.transport.attachWithHistoryBoundary(
        props.sessionId,
        dimensions.cols,
        dimensions.rows,
      );
      const geometry = {
        generation: attached.geometryGeneration,
        outputSequenceBoundary: attached.historyBoundarySequence,
        cols: attached.cols,
        rows: attached.rows,
      };
      recordResizeDiagnostic({ action: 'attach-applied', geometry });
      return geometry;
    },
    resize: async dimensions => {
      recordResizeDiagnostic({ action: 'resize-requested', dimensions: { ...dimensions } });
      const result = await props.transport.resizeWithEffectiveGeometry(
        props.sessionId,
        dimensions.cols,
        dimensions.rows,
      );
      recordResizeDiagnostic({ action: 'resize-applied', geometry: result.effective });
      return result.effective;
    },
    onConnectionChange: connected => { liveConnected = connected; },
    onGeometry: geometry => { geometryDiagnostics = { ...geometry }; },
    onError: setPresentationError,
  });
  const perfWindow = window as FloetermPerfWindow;
  const perfParams = new URLSearchParams(window.location.search);
  const perfHarness: FloetermPerfHarness | null = (
    perfParams.get('perf') === '1' || perfParams.get('perf_probe') === '1'
  )
    ? {
      sendInput: data => { void props.transport.sendInput(props.sessionId, data); },
      clear: () => { void props.transport.clear(props.sessionId); },
      serialize: () => latestPresentation?.frame.rows.map(row => row.cells.map(cell => cell.text).join('')).join('\n') ?? '',
      getVisibleLines: () => latestPresentation?.frame.rows.map(row => row.cells.map(cell => cell.text).join('').trimEnd()) ?? [],
      getSelectionText: () => '', hasSelection: () => false,
      getTerminalInfo: () => latestPresentation ? ({ rows: latestPresentation.frame.height, cols: latestPresentation.frame.width, bufferLength: latestPresentation.frame.height }) : null,
      getPresentationDiagnostics: () => latestPresentation,
      getResizeDiagnostics: () => resizeDiagnostics.map(value => structuredClone(value)),
      getSnapshot: () => ({ ...initialTerminalSnapshot, state: { ...initialTerminalSnapshot.state, dimensions: viewDimensions }, connection: { ...initialTerminalSnapshot.connection, isConnected: liveConnected || latestPresentation !== null, state: (liveConnected || latestPresentation !== null) ? 'connected' : 'connecting' } }),
      getFabricDiagnostics: () => getTerminalFabricDiagnostics(),
      forceResize: () => { void requestResize(); },
      getGeometryDiagnostics: () => ({ ...geometryDiagnostics }),
      getStreamDiagnostics: () => ({ ...streamDiagnostics }),
      resetStreamDiagnostics: (afterSequence = 0) => {
        streamDiagnostics = initialStreamDiagnostics();
        streamDecoder = new TextDecoder();
        streamDiagnosticsAfterSequence = Math.max(0, Number(afterSequence) || 0);
      },
    }
    : null;
  if (perfHarness) perfWindow.__floetermPerfHarness = perfHarness;
  onCleanup(() => {
    if (perfHarness && perfWindow.__floetermPerfHarness === perfHarness) {
      delete perfWindow.__floetermPerfHarness;
    }
  });

  const requestResize = async () => {
    if (!semanticCanvas?.parentElement) return;
    await semanticResize.requestResize();
  };

  onMount(() => {
	if (semanticCanvas) semanticRenderer = new RendererSurface(semanticCanvas);
	const semanticResizeObserver = semanticCanvas && typeof ResizeObserver !== 'undefined'
		? new ResizeObserver(() => { void requestResize(); })
		: undefined;
	if (semanticCanvas?.parentElement) semanticResizeObserver?.observe(semanticCanvas.parentElement);
	const applyPresentation = (value: unknown) => { try { const presentation = validatePresentation(value); latestPresentation = presentation; semanticRenderer?.apply(presentation); setPresentationError(''); } catch (error) { setPresentationError(error instanceof Error ? error.message : String(error)); } };
	const unsubscribePresentation = props.eventSource.onTerminalPresentation?.(props.sessionId, value => { liveConnected = true; applyPresentation(value); });
	const unsubscribeLifecycle = props.eventSource.onTerminalLiveAttachmentLifecycle?.(props.sessionId, event => {
		if (event.state === 'attached') { semanticResize.handleAttached(); return; }
		semanticResize.handleClosed(event.reason);
	});
	void requestResize();
    const unsubscribeData = props.eventSource.onTerminalData(props.sessionId, event => {
      if (event.type !== 'data') return;
      const sequence = Number(event.sequence ?? 0);
      if (sequence > 0 && sequence <= streamDiagnosticsAfterSequence) return;
      streamDiagnostics.dataEvents += 1;
      streamDiagnostics.totalBytes += event.data.byteLength;
      if (streamDiagnostics.firstSequence === 0) {
        streamDiagnostics.firstSequence = sequence;
      } else if (sequence !== streamDiagnostics.lastSequence + 1) {
        streamDiagnostics.sequenceGaps += 1;
      }
      streamDiagnostics.lastSequence = sequence;
      streamDiagnostics.tail = (
        streamDiagnostics.tail + streamDecoder.decode(event.data, { stream: true })
      ).slice(-4096);
      for (const byte of event.data) {
        streamDiagnostics.hash = Math.imul(streamDiagnostics.hash ^ byte, 16777619) >>> 0;
      }
    });
    const unsubscribeGeometry = props.eventSource.onTerminalGeometry?.(props.sessionId, event => {
      semanticResize.handleGeometry({
        generation: event.generation,
        outputSequenceBoundary: event.outputSequenceBoundary,
        cols: event.cols,
        rows: event.rows,
      });
    });
    onCleanup(() => {
		unsubscribePresentation?.();
		unsubscribeLifecycle?.();
		semanticResizeObserver?.disconnect();
		semanticResize.dispose();
		semanticRenderer?.dispose();
      unsubscribeData();
      unsubscribeGeometry?.();
    });
  });

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
    void requestResize();
  });

  onMount(() => {
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
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (clearStatsRefreshTimer !== null) {
        window.clearTimeout(clearStatsRefreshTimer);
        clearStatsRefreshTimer = null;
      }
    });
  });

  const clearTerminal = () => {
    void props.transport.clear(props.sessionId);
    if (clearStatsRefreshTimer !== null) {
      window.clearTimeout(clearStatsRefreshTimer);
    }
    clearStatsRefreshTimer = window.setTimeout(() => {
      clearStatsRefreshTimer = null;
      void refreshHistoryBytes();
    }, 150);
  };

  const status = createMemo(() => {
    const parts: string[] = ['live'];
    const bytes = historyBytes();
    if (bytes !== null) {
      parts.push(`history ${formatBytes(bytes)}`);
    }
    return parts.join(' :: ');
  });
  const rendererError = createMemo(() => {
    return presentationError();
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
          <button
            onClick={props.onRestart}
            disabled={props.isBusy || !props.canRestart}
            title={props.canRestart ? 'Restart terminal session' : 'This shared session is managed externally'}
          >restart</button>
          <button onClick={clearTerminal} disabled={props.isBusy}>clear</button>
        </div>
      </div>
      <Show when={props.error}>
        <div class="error">{props.error}</div>
      </Show>
      <div class="terminalContainer">
        <div class="terminalPane">
          <canvas class="semanticTerminalSurface" ref={semanticCanvas} aria-label="Semantic terminal surface" />
          <textarea class="terminalInputBridge" ref={inputBridge} aria-label="Terminal input"
            onPaste={event => { const value = event.clipboardData?.getData('text/plain') ?? ''; if (value) { event.preventDefault(); void props.transport.sendInput(props.sessionId, value); } }}
            onInput={event => { const value = event.currentTarget.value; if (value) { void props.transport.sendInput(props.sessionId, value); event.currentTarget.value = ''; } }} />
          <Show when={rendererError()}>
            {message => (
              <div class="terminalRendererError" role="alert">
                <strong>Terminal presentation unavailable</strong>
                <span>{message()}</span>
                <span>presentation path stopped</span>
              </div>
            )}
          </Show>
        </div>
      </div>
    </>
  );
};

type MirrorTerminalRuntime = ReturnType<typeof createTerminalRuntime>;

const MirrorTerminalConnection = (props: {
  sessionId: string;
  label: string;
  runtime: MirrorTerminalRuntime;
  themeName: TerminalThemeName;
  onRuntimeState: (label: string, connected: boolean, error: string) => void;
  onReconnect: () => void;
  onHarnessChange: (label: string, harness: FloetermMirrorViewHarness | null) => void;
}) => {
  const initialStreamDiagnostics = () => ({
    dataEvents: 0,
    firstSequence: 0,
    lastSequence: 0,
    sequenceGaps: 0,
    totalBytes: 0,
    hash: 2166136261,
    tail: '',
  });
  let streamDiagnostics = initialStreamDiagnostics();
  let streamDecoder = new TextDecoder();
  let streamDiagnosticsAfterSequence = 0;
  let geometryDiagnostics = { generation: 0, outputSequenceBoundary: 0, cols: 0, rows: 0 };
  let renderDiagnostics = { count: 0, lastRenderAtMs: 0 };
  const terminal = createSolidTerminal(() => ({
    sessionId: props.sessionId,
    isActive: true,
    autoFocus: false,
    fontSize: 11,
    themeName: props.themeName,
    transport: props.runtime.transport,
    eventSource: props.runtime.eventSource,
    onRender: () => {
      renderDiagnostics.count += 1;
      renderDiagnostics.lastRenderAtMs = performance.now();
    },
    config: {
      rendererType: 'webgl',
      responsive: {
        fitOnFocus: true,
        emitResizeOnFocus: true,
        notifyResizeOnlyWhenFocused: false,
        reportHostDimensionsWithFixedGrid: true,
      },
    },
  }));

  const status = createMemo(() => {
    const snapshot = terminal.snapshot();
    return snapshot.state.hasError
      ? snapshot.state.error?.message ?? 'renderer error'
      : snapshot.connection.error?.message || snapshot.loadingMessage || (snapshot.connection.isConnected ? 'live' : snapshot.connection.state);
  });
  const rendererError = createMemo(() => {
    const snapshot = terminal.snapshot();
    return snapshot.state.hasError ? snapshot.state.error?.message ?? 'Beamterm WebGL2 renderer failed' : '';
  });

  createEffect(() => {
    const snapshot = terminal.snapshot();
    props.onRuntimeState(props.label, snapshot.connection.isConnected, status());
  });

  const harness: FloetermMirrorViewHarness = {
    label: props.label,
    sendInput: data => terminal.actions().sendInput(data),
    clear: () => terminal.actions().clear(),
    serialize: () => terminal.actions().serialize(),
    getVisibleLines: () => {
      const info = terminal.actions().getTerminalInfo();
      if (!info) return [];
      const firstVisibleRow = Math.max(0, info.bufferLength - info.rows);
      return Array.from(
        { length: info.rows },
        (_, index) => terminal.actions().readBufferLine(firstVisibleRow + index, { trimRight: true }),
      );
    },
    getSelectionText: () => terminal.actions().getSelectionText(),
    hasSelection: () => terminal.actions().hasSelection(),
    getTerminalInfo: () => terminal.actions().getTerminalInfo(),
    getSnapshot: () => terminal.snapshot(),
    getFabricDiagnostics: () => getTerminalFabricDiagnostics(),
    forceResize: () => terminal.actions().forceResize(),
    synchronizeSize: async () => {
      const dimensions = terminal.snapshot().state.dimensions;
      await props.runtime.transport.resize(props.sessionId, dimensions.cols, dimensions.rows);
    },
    getGeometryDiagnostics: () => ({ ...geometryDiagnostics }),
    getRenderDiagnostics: () => ({ ...renderDiagnostics }),
    resetRenderDiagnostics: () => { renderDiagnostics = { count: 0, lastRenderAtMs: 0 }; },
    getStreamDiagnostics: () => ({ ...streamDiagnostics }),
    resetStreamDiagnostics: (afterSequence = 0) => {
      streamDiagnostics = initialStreamDiagnostics();
      streamDecoder = new TextDecoder();
      streamDiagnosticsAfterSequence = Math.max(0, Number(afterSequence) || 0);
    },
    reconnect: props.onReconnect,
  };

  onMount(() => {
    props.onHarnessChange(props.label, harness);
    const unsubscribe = props.runtime.eventSource.onTerminalData(props.sessionId, event => {
      if (event.type !== 'data') return;
      const sequence = Number(event.sequence ?? 0);
      if (sequence > 0 && sequence <= streamDiagnosticsAfterSequence) return;
      streamDiagnostics.dataEvents += 1;
      streamDiagnostics.totalBytes += event.data.byteLength;
      if (streamDiagnostics.firstSequence === 0) {
        streamDiagnostics.firstSequence = sequence;
      } else if (sequence !== streamDiagnostics.lastSequence + 1) {
        streamDiagnostics.sequenceGaps += 1;
      }
      streamDiagnostics.lastSequence = sequence;
      streamDiagnostics.tail = (
        streamDiagnostics.tail + streamDecoder.decode(event.data, { stream: true })
      ).slice(-4096);
      for (const byte of event.data) {
        streamDiagnostics.hash = Math.imul(streamDiagnostics.hash ^ byte, 16777619) >>> 0;
      }
    });
    const unsubscribeGeometry = props.runtime.eventSource.onTerminalGeometry?.(props.sessionId, event => {
      geometryDiagnostics = {
        generation: event.generation,
        outputSequenceBoundary: event.outputSequenceBoundary,
        cols: event.cols,
        rows: event.rows,
      };
    });
    onCleanup(() => {
      unsubscribe();
      unsubscribeGeometry?.();
    });
  });
  onCleanup(() => props.onHarnessChange(props.label, null));

  return (
    <section class="mirrorTerminalView" data-mirror-view={props.label}>
      <div class="tileHeader">
        <span class="tileName">{props.label}</span>
        <div class="mirrorViewActions">
          <span class="tileState">{status()}</span>
          <button onClick={props.onReconnect}>reconnect</button>
        </div>
      </div>
      <div class="mirrorTerminalSurface">
        <div class="terminalSurface" ref={terminal.mount} />
        <Show when={rendererError()}>
          <div class="terminalRendererError terminalRendererErrorCompact" role="alert">
            <strong>WebGL2 error</strong>
            <button onClick={() => void terminal.actions().reinitialize?.()}>Retry</button>
          </div>
        </Show>
      </div>
    </section>
  );
};

const MirrorTerminalView = (props: {
  sessionId: string;
  label: string;
  runtime: MirrorTerminalRuntime;
  themeName: TerminalThemeName;
  onRuntimeState: (label: string, connected: boolean, error: string) => void;
  onHarnessChange: (label: string, harness: FloetermMirrorViewHarness | null) => void;
}) => {
  const [generation, setGeneration] = createSignal(1);
  return (
    <For each={[generation()]}>
      {() => (
        <MirrorTerminalConnection
          sessionId={props.sessionId}
          label={props.label}
          runtime={props.runtime}
          themeName={props.themeName}
          onRuntimeState={props.onRuntimeState}
          onReconnect={() => setGeneration(value => value + 1)}
          onHarnessChange={props.onHarnessChange}
        />
      )}
    </For>
  );
};

const MirrorTerminalDemo = (props: {
  sessionId: string;
  runtimes: readonly MirrorTerminalRuntime[];
  themeName: TerminalThemeName;
  isBusy: boolean;
  error: string;
  canRestart: boolean;
  onRestart: () => void;
  onThemeChange: (theme: TerminalThemeName) => void;
}) => {
  const [runtimeState, setRuntimeState] = createSignal<Record<string, { connected: boolean; error: string }>>({});
  const connectedCount = createMemo(() => Object.values(runtimeState()).filter(state => state.connected).length);
  const errorCount = createMemo(() => Object.values(runtimeState()).filter(state => state.error && !state.connected).length);
  const updateRuntimeState = (label: string, connected: boolean, error: string) => {
    setRuntimeState(previous => ({ ...previous, [label]: { connected, error } }));
  };
  const harnessViews = new Map<string, FloetermMirrorViewHarness>();
  const updateHarness = (label: string, harness: FloetermMirrorViewHarness | null) => {
    if (harness) {
      harnessViews.set(label, harness);
      return;
    }
    harnessViews.delete(label);
  };
  const perfWindow = window as FloetermPerfWindow;
  const perfEnabled = new URLSearchParams(window.location.search).get('perf_probe') === '1';
  const mirrorHarness: FloetermMirrorHarness | null = perfEnabled
    ? {
      getViews: () => Array.from(harnessViews.values()).sort((left, right) => left.label.localeCompare(right.label)),
      getRuntimeState: () => ({ connectedCount: connectedCount(), errorCount: errorCount() }),
    }
    : null;
  if (mirrorHarness) perfWindow.__floetermMirrorHarness = mirrorHarness;
  onCleanup(() => {
    if (mirrorHarness && perfWindow.__floetermMirrorHarness === mirrorHarness) {
      delete perfWindow.__floetermMirrorHarness;
    }
  });

  return (
    <>
      <div
        hidden
        data-testid="mirror-runtime-state"
        data-session-id={props.sessionId}
        data-view-count={props.runtimes.length}
        data-connected-count={connectedCount()}
        data-error-count={errorCount()}
      />
      <div class="toolbar">
        <div class="toolbarPrimary">
          <span class="appTitle">floeterm mirror</span>
          <span class="status">
            {props.runtimes.length} views :: 1 session :: connected {connectedCount()}/{props.runtimes.length}
            {errorCount() > 0 ? ` :: errors ${errorCount()}` : ''}
          </span>
        </div>
        <div class="toolbarActions">
          <ThemeSelector themeName={props.themeName} onThemeChange={props.onThemeChange} disabled={props.isBusy} />
          <button
            onClick={props.onRestart}
            disabled={props.isBusy || !props.canRestart}
            title={props.canRestart ? 'Restart terminal session' : 'This shared session is managed externally'}
          >restart session</button>
        </div>
      </div>
      <Show when={props.error}>
        <div class="error">{props.error}</div>
      </Show>
      <div class="mirrorTerminalContainer">
        <For each={props.runtimes}>
          {(runtime, index) => (
            <MirrorTerminalView
              sessionId={props.sessionId}
              label={`view ${index() + 1}`}
              runtime={runtime}
              themeName={props.themeName}
              onRuntimeState={updateRuntimeState}
              onHarnessChange={updateHarness}
            />
          )}
        </For>
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
  const rendererError = createMemo(() => {
    const snapshot = terminal.snapshot();
    return snapshot.state.hasError ? snapshot.state.error?.message ?? 'Beamterm WebGL2 renderer failed' : '';
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
      <div class="tileTerminal">
        <div class="terminalSurface" ref={terminal.mount} />
        <Show when={rendererError()}>
          <div class="terminalRendererError terminalRendererErrorCompact" role="alert">
            <strong>WebGL2 error</strong>
            <button onClick={() => void terminal.actions().reinitialize?.()}>Retry</button>
          </div>
        </Show>
      </div>
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
  const mirrorRuntimes = [1, 2].map(index => createTerminalRuntime(`${demo.connId}-mirror-${index}`));
  onCleanup(() => {
    for (const runtime of mirrorRuntimes) runtime.transport.dispose();
  });

  return (
    <div class="app">
      <div
        hidden
        data-testid="demo-runtime-state"
        data-connection-id={demo.connId}
        data-mode={demo.mode()}
        data-single-session-id={demo.singleSessionId()}
        data-single-session-external={demo.singleSessionExternallyManaged() ? 'true' : 'false'}
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
          <button class={demo.mode() === 'mirror' ? 'isActive' : ''} onClick={() => demo.switchMode('mirror')}>mirror</button>
          <button class={demo.mode() === 'grid' ? 'isActive' : ''} onClick={() => demo.switchMode('grid')}>grid</button>
        </div>
      </div>
      <main class="main">
        <Show when={demo.mode() === 'grid'} fallback={(
          <Show when={demo.mode() === 'mirror'} fallback={(
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
                  canRestart={demo.canRestartSingleSession()}
                  onRestart={() => void demo.restartSingleSession()}
                  onThemeChange={setThemeName}
                />
              )}
            </Show>
          )}>
            <Show when={demo.singleSessionId()}>
              {id => (
                <MirrorTerminalDemo
                  sessionId={id()}
                  runtimes={mirrorRuntimes}
                  themeName={themeName()}
                  isBusy={demo.singleBusy()}
                  error={demo.singleError()}
                  canRestart={demo.canRestartSingleSession()}
                  onRestart={() => void demo.restartSingleSession()}
                  onThemeChange={setThemeName}
                />
              )}
            </Show>
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
