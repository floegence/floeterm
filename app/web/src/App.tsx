import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  RendererSurface,
  SEMANTIC_CELL_HEIGHT_CSS_PX,
  SEMANTIC_CELL_WIDTH_CSS_PX,
  isTerminalThemeName,
  presentationAdvances,
  TerminalState,
  type TerminalInstanceSnapshot,
  validatePresentation,
  type SemanticHistoryDirection,
  type SemanticHistoryPage,
  type SemanticPresentation,
  type TerminalThemeName,
} from '@floegence/floeterm-terminal-web/semantic';
import { applyTerminalThemeShell, ThemeSelector } from './themeCatalog';
import { createTerminalRuntime, type AppTerminalTransport } from './terminalApi';
import { createSemanticResizeController } from './semanticResizeController';
import {
  buildLiveGridCommand,
  createFloetermDemoRuntime,
  createProgressiveCount,
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

type FloetermPerfHarness = {
  sendInput(data: string): void;
  clear(): void;
  serialize(): string;
  getVisibleLines(): string[];
  getSelectionText(): string;
  hasSelection(): boolean;
  getTerminalInfo(): { rows: number; cols: number; bufferLength: number } | null;
  getPresentationDiagnostics?(): SemanticPresentation | null;
  getResizeDiagnostics?(): readonly unknown[];
  getSnapshot(): TerminalInstanceSnapshot;
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

const terminalKeyInput = (event: KeyboardEvent): string | null => {
  if (event.isComposing) return null;
  if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) {
    const code = event.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  }
  switch (event.key) {
    case 'Enter': return '\r';
    case 'Backspace': return '\x7f';
    case 'Tab': return '\t';
    case 'Escape': return '\x1b';
    case 'ArrowUp': return '\x1b[A';
    case 'ArrowDown': return '\x1b[B';
    case 'ArrowRight': return '\x1b[C';
    case 'ArrowLeft': return '\x1b[D';
    case 'Home': return '\x1b[H';
    case 'End': return '\x1b[F';
    case 'PageUp': return '\x1b[5~';
    case 'PageDown': return '\x1b[6~';
    case 'Delete': return '\x1b[3~';
    default: return null;
  }
};

const SemanticTerminalSurface = (props: {
  canvasId?: string;
  inputId?: string;
  canvasLabel?: string;
  onCanvas(node: HTMLCanvasElement): void;
  onInputBridge(node: HTMLTextAreaElement): void;
  renderer(): RendererSurface | undefined;
  sendInput(value: string): void;
}) => (
  <>
    <canvas id={props.canvasId} class="semanticTerminalSurface" ref={props.onCanvas} aria-label={props.canvasLabel ?? 'Semantic terminal surface'} />
    <textarea
      id={props.inputId}
      class="terminalInputBridge"
      ref={props.onInputBridge}
      aria-label="Terminal input"
      spellcheck={false}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        props.renderer()?.beginSelection(event.clientX, event.clientY);
      }}
      onPointerMove={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          props.renderer()?.updateSelection(event.clientX, event.clientY);
        }
      }}
      onPointerUp={event => {
        props.renderer()?.endSelection(event.clientX, event.clientY);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={event => {
        const value = terminalKeyInput(event);
        if (value === null) return;
        event.preventDefault();
        props.sendInput(value);
      }}
      onPaste={event => {
        const value = event.clipboardData?.getData('text/plain') ?? '';
        if (!value) return;
        event.preventDefault();
        props.sendInput(value);
      }}
      onInput={event => {
        const value = event.currentTarget.value;
        if (!value) return;
        props.sendInput(value);
        event.currentTarget.value = '';
      }}
    />
  </>
);

type SemanticViewportHandle = Readonly<{
  sendInput(data: string): void;
  clear(): void;
  serialize(): string;
  getVisibleLines(): string[];
  getSelectionText(): string;
  hasSelection(): boolean;
  getTerminalInfo(): { rows: number; cols: number; bufferLength: number } | null;
  getPresentation(): SemanticPresentation | null;
  getSnapshot(): TerminalInstanceSnapshot;
  forceResize(): void;
  synchronizeSize(): Promise<void>;
  getGeometryDiagnostics(): { generation: number; outputSequenceBoundary: number; cols: number; rows: number };
  getRenderDiagnostics(): { count: number; lastRenderAtMs: number };
  resetRenderDiagnostics(): void;
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
}>;

const SemanticTerminalViewport = (props: {
  sessionId: string;
  transport: AppTerminalTransport;
  eventSource: DemoEventSource;
  class: string;
  canvasLabel: string;
  onState?: (connected: boolean, error: string) => void;
  onHandle?: (handle: SemanticViewportHandle | null) => void;
}) => {
  const mountedSessionId = props.sessionId;
  const initialStreamDiagnostics = () => ({
    dataEvents: 0,
    firstSequence: 0,
    lastSequence: 0,
    sequenceGaps: 0,
    totalBytes: 0,
    hash: 2166136261,
    tail: '',
  });
  let canvas: HTMLCanvasElement | undefined;
  let inputBridge: HTMLTextAreaElement | undefined;
  let renderer: RendererSurface | undefined;
  let latestPresentation: SemanticPresentation | null = null;
  let geometryDiagnostics = { generation: 0, outputSequenceBoundary: 0, cols: 0, rows: 0 };
  let viewDimensions = { cols: 80, rows: 24 };
  let streamDiagnostics = initialStreamDiagnostics();
  let streamDecoder = new TextDecoder();
  let streamDiagnosticsAfterSequence = 0;
  let renderDiagnostics = { count: 0, lastRenderAtMs: 0 };
  const [connected, setConnected] = createSignal(false);
  const [presentationError, setPresentationError] = createSignal('');

  const measure = () => {
    const bounds = canvas?.parentElement?.getBoundingClientRect();
    if (!bounds) return viewDimensions;
    viewDimensions = {
      cols: Math.max(20, Math.min(500, Math.floor(bounds.width / SEMANTIC_CELL_WIDTH_CSS_PX))),
      rows: Math.max(5, Math.min(200, Math.floor(bounds.height / SEMANTIC_CELL_HEIGHT_CSS_PX))),
    };
    return viewDimensions;
  };
  const semanticResize = createSemanticResizeController({
    measure,
    repaint: () => renderer?.resize(),
    attach: async dimensions => {
      const attached = await props.transport.attachWithHistoryBoundary(
        mountedSessionId, dimensions.cols, dimensions.rows,
      );
      return {
        generation: attached.geometryGeneration,
        outputSequenceBoundary: attached.historyBoundarySequence,
        cols: attached.cols,
        rows: attached.rows,
      };
    },
    resize: async dimensions => (await props.transport.resizeWithEffectiveGeometry(
      mountedSessionId, dimensions.cols, dimensions.rows,
    )).effective,
    onConnectionChange: setConnected,
    onGeometry: geometry => { geometryDiagnostics = { ...geometry }; },
    onError: setPresentationError,
  });

  const requestResize = async () => {
    if (!canvas?.parentElement) return;
    await semanticResize.requestResize();
  };
  const handle: SemanticViewportHandle = {
    sendInput: data => { void props.transport.sendInput(mountedSessionId, data); },
    clear: () => { void props.transport.clear(mountedSessionId); },
    serialize: () => latestPresentation?.frame.rows
      .map(row => row.cells.map(cell => cell.text).join('')).join('\n') ?? '',
    getVisibleLines: () => latestPresentation?.frame.rows
      .map(row => row.cells.map(cell => cell.text).join('').trimEnd()) ?? [],
    getSelectionText: () => renderer?.getSelectionText() ?? '',
    hasSelection: () => renderer?.hasSelection() ?? false,
    getTerminalInfo: () => latestPresentation ? ({
      rows: latestPresentation.frame.height,
      cols: latestPresentation.frame.width,
      bufferLength: latestPresentation.frame.history.totalRows,
    }) : null,
    getPresentation: () => latestPresentation,
    getSnapshot: () => ({
      ...initialTerminalSnapshot,
      state: { ...initialTerminalSnapshot.state, dimensions: { ...viewDimensions } },
      connection: {
        ...initialTerminalSnapshot.connection,
        state: connected() ? 'connected' : presentationError() ? 'failed' : 'connecting',
        isConnected: connected(),
      },
    }),
    forceResize: () => { void requestResize(); },
    synchronizeSize: requestResize,
    getGeometryDiagnostics: () => ({ ...geometryDiagnostics }),
    getRenderDiagnostics: () => ({ ...renderDiagnostics }),
    resetRenderDiagnostics: () => { renderDiagnostics = { count: 0, lastRenderAtMs: 0 }; },
    getStreamDiagnostics: () => ({ ...streamDiagnostics }),
    resetStreamDiagnostics: (afterSequence = 0) => {
      streamDiagnostics = initialStreamDiagnostics();
      streamDecoder = new TextDecoder();
      streamDiagnosticsAfterSequence = Math.max(0, Number(afterSequence) || 0);
    },
  };

  createEffect(() => props.onState?.(connected(), presentationError()));
  onMount(() => {
    if (!canvas) throw new Error('semantic terminal canvas is required');
    renderer = new RendererSurface(canvas, error => setPresentationError(error.message));
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => { void requestResize(); });
    if (canvas.parentElement) resizeObserver?.observe(canvas.parentElement);
    const unsubscribePresentation = props.eventSource.onTerminalPresentation?.(mountedSessionId, value => {
      try {
        const presentation = validatePresentation(value);
        if (!presentationAdvances(latestPresentation, presentation)) return;
        latestPresentation = presentation;
        renderer?.apply(presentation);
        renderDiagnostics.count += 1;
        renderDiagnostics.lastRenderAtMs = performance.now();
        setPresentationError('');
      } catch (error) {
        setPresentationError(error instanceof Error ? error.message : String(error));
      }
    });
    const unsubscribeLifecycle = props.eventSource.onTerminalLiveAttachmentLifecycle?.(mountedSessionId, event => {
      if (event.state === 'attached') { semanticResize.handleAttached(); return; }
      semanticResize.handleClosed(event.reason);
    });
    const unsubscribeGeometry = props.eventSource.onTerminalGeometry?.(mountedSessionId, event => {
      semanticResize.handleGeometry({
        generation: event.generation,
        outputSequenceBoundary: event.outputSequenceBoundary,
        cols: event.cols,
        rows: event.rows,
      });
    });
    const unsubscribeData = props.eventSource.onTerminalData(mountedSessionId, event => {
      if (event.type !== 'data') return;
      const sequence = Number(event.sequence ?? 0);
      if (sequence > 0 && sequence <= streamDiagnosticsAfterSequence) return;
      streamDiagnostics.dataEvents += 1;
      streamDiagnostics.totalBytes += event.data.byteLength;
      if (streamDiagnostics.firstSequence === 0) streamDiagnostics.firstSequence = sequence;
      else if (sequence !== streamDiagnostics.lastSequence + 1) streamDiagnostics.sequenceGaps += 1;
      streamDiagnostics.lastSequence = sequence;
      streamDiagnostics.tail = (
        streamDiagnostics.tail + streamDecoder.decode(event.data, { stream: true })
      ).slice(-4096);
      for (const byte of event.data) {
        streamDiagnostics.hash = Math.imul(streamDiagnostics.hash ^ byte, 16777619) >>> 0;
      }
    });
    props.onHandle?.(handle);
    void requestResize();
    onCleanup(() => {
      props.onHandle?.(null);
      unsubscribePresentation?.();
      unsubscribeLifecycle?.();
      unsubscribeGeometry?.();
      unsubscribeData();
      resizeObserver?.disconnect();
      semanticResize.dispose();
      renderer?.dispose();
      props.transport.forgetSession(mountedSessionId);
    });
  });

  return (
    <div class={props.class}>
      <SemanticTerminalSurface
        canvasLabel={props.canvasLabel}
        onCanvas={node => { canvas = node; }}
        onInputBridge={node => { inputBridge = node; }}
        renderer={() => renderer}
        sendInput={value => { void props.transport.sendInput(mountedSessionId, value); }}
      />
      <Show when={presentationError()}>
        {message => (
          <div class="terminalRendererError terminalRendererErrorCompact" role="alert">
            <strong>Terminal presentation unavailable</strong>
            <span>{message()}</span>
          </div>
        )}
      </Show>
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
	let semanticCanvas: HTMLCanvasElement | undefined;
	let semanticRenderer: RendererSurface | undefined;
	let inputBridge: HTMLTextAreaElement | undefined;
  const [presentationError, setPresentationError] = createSignal('');
	const [historyError, setHistoryError] = createSignal('');
	const [historyPage, setHistoryPage] = createSignal<SemanticHistoryPage | null>(null);
	const [historyProjected, setHistoryProjected] = createSignal(false);
	const [historyHovered, setHistoryHovered] = createSignal(false);
	const [historyDragging, setHistoryDragging] = createSignal(false);
	const [historyBusy, setHistoryBusy] = createSignal(false);
	const [historySummary, setHistorySummary] = createSignal({ totalRows: 0, screenStartOffset: 0 });
  let liveConnected = false;
  let latestPresentation: SemanticPresentation | null = null;
	let historyRequestEpoch = 0;
  const resizeDiagnostics: unknown[] = [];
  let attachRequestCount = 0;
  let lifecycleCloseCount = 0;
  const recordResizeDiagnostic = (value: unknown) => {
    resizeDiagnostics.push(value);
    if (resizeDiagnostics.length > 64) resizeDiagnostics.shift();
  };
  let viewDimensions = { cols: 80, rows: 24 };
  const measuredDimensions = () => {
    const host = semanticCanvas?.parentElement?.getBoundingClientRect();
    if (!host) return viewDimensions;
    return {
      cols: Math.max(20, Math.min(500, Math.floor(host.width / SEMANTIC_CELL_WIDTH_CSS_PX))),
      rows: Math.max(5, Math.min(200, Math.floor(host.height / SEMANTIC_CELL_HEIGHT_CSS_PX))),
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
      attachRequestCount += 1;
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
      serialize: () => {
		const frame = historyProjected() ? historyPage()?.frame : latestPresentation?.frame;
		return frame?.rows.map(row => row.cells.map(cell => cell.text).join('')).join('\n') ?? '';
	  },
      getVisibleLines: () => {
		const frame = historyProjected() ? historyPage()?.frame : latestPresentation?.frame;
		return frame?.rows.map(row => row.cells.map(cell => cell.text).join('').trimEnd()) ?? [];
	  },
      getSelectionText: () => semanticRenderer?.getSelectionText() ?? '',
      hasSelection: () => semanticRenderer?.hasSelection() ?? false,
      getTerminalInfo: () => latestPresentation ? ({
		rows: latestPresentation.frame.height,
		cols: latestPresentation.frame.width,
		bufferLength: historySummary().totalRows,
	  }) : null,
      getPresentationDiagnostics: () => latestPresentation,
      getResizeDiagnostics: () => [
        { action: 'summary', attachRequestCount, lifecycleCloseCount },
        ...resizeDiagnostics.map(value => structuredClone(value)),
      ],
      getSnapshot: () => ({ ...initialTerminalSnapshot, state: { ...initialTerminalSnapshot.state, dimensions: viewDimensions }, connection: { ...initialTerminalSnapshot.connection, isConnected: liveConnected || latestPresentation !== null, state: (liveConnected || latestPresentation !== null) ? 'connected' : 'connecting' } }),
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
	historyRequestEpoch += 1;
	setHistoryProjected(false);
	semanticRenderer?.project(null);
    await semanticResize.requestResize();
  };

	const showLatestPresentation = () => {
		historyRequestEpoch += 1;
		setHistoryProjected(false);
		setHistoryError('');
		semanticRenderer?.project(null);
	};

	const queryHistory = async (direction: SemanticHistoryDirection, project: boolean): Promise<SemanticHistoryPage | null> => {
		if (!latestPresentation || historyBusy()) return null;
		const current = historyPage();
		if ((direction === 'forward' || direction === 'backward') && !current) return null;
		const requestEpoch = ++historyRequestEpoch;
		setHistoryBusy(true);
		try {
			const page = await props.transport.semanticHistory(props.sessionId, {
				expectedRevision: latestPresentation.sequence,
				...(direction === 'forward' || direction === 'backward' ? { anchor: current!.anchor } : {}),
				direction,
				limit: latestPresentation.frame.height,
			});
			if (requestEpoch !== historyRequestEpoch) return null;
			setHistoryPage(page);
			setHistoryError('');
			if (project && page.offset < page.screenStartOffset) {
				setHistoryProjected(true);
				semanticRenderer?.project(page.frame);
			} else {
				setHistoryProjected(false);
				semanticRenderer?.project(null);
			}
			return page;
		} catch (error) {
			if (requestEpoch === historyRequestEpoch && !(error instanceof DOMException && error.name === 'AbortError')) {
				setHistoryError(error instanceof Error ? error.message : String(error));
			}
			return null;
		} finally {
			if (requestEpoch === historyRequestEpoch) setHistoryBusy(false);
		}
	};

	const scrollHistory = async (direction: 'forward' | 'backward') => {
		if (!latestPresentation || historyBusy()) return;
		if (direction === 'forward' && !historyProjected()) return;
		let current = historyPage();
		if (!current) current = await queryHistory('end', false);
		if (!current) return;
		if (direction === 'backward' && !current.hasPrevious) return;
		if (direction === 'forward' && !current.hasNext) {
			showLatestPresentation();
			return;
		}
		await queryHistory(direction, true);
	};

	const historyMaximum = createMemo(() => Math.max(0, historySummary().screenStartOffset));
	const historyCurrent = createMemo(() => historyProjected() ? Math.min(historyMaximum(), historyPage()?.offset ?? historyMaximum()) : historyMaximum());
	const historyThumbSize = createMemo(() => {
		const page = historyPage();
		const totalRows = page?.totalRows ?? historySummary().totalRows;
		const visibleRows = page?.frame.height ?? latestPresentation?.frame.height ?? 0;
		if (totalRows <= 0 || visibleRows <= 0) return 100;
		return Math.max(6, Math.min(100, visibleRows / totalRows * 100));
	});
	const historyThumbStart = createMemo(() => {
		const maximum = historyMaximum();
		if (maximum === 0) return 0;
		return Math.min(100 - historyThumbSize(), historyCurrent() / maximum * (100 - historyThumbSize()));
	});
	const handleHistoryPointer = (event: PointerEvent) => {
		if (event.pointerType === 'touch') return;
		const rail = event.currentTarget as HTMLElement;
		const bounds = rail.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height)));
		if (ratio <= 0.25) {
			void queryHistory('start', true);
		} else if (ratio >= 0.75) {
			showLatestPresentation();
		} else if (ratio < 0.5) {
			void scrollHistory('backward');
		} else {
			void scrollHistory('forward');
		}
	};

  onMount(() => {
	if (semanticCanvas) semanticRenderer = new RendererSurface(semanticCanvas, error => {
		setPresentationError(error.message);
	});
	const semanticResizeObserver = semanticCanvas && typeof ResizeObserver !== 'undefined'
		? new ResizeObserver(() => { void requestResize(); })
		: undefined;
	if (semanticCanvas?.parentElement) semanticResizeObserver?.observe(semanticCanvas.parentElement);
		const applyPresentation = (value: unknown) => {
			try {
				const presentation = validatePresentation(value);
				if (!presentationAdvances(latestPresentation, presentation)) return;
				latestPresentation = presentation;
			setHistorySummary({
				totalRows: presentation.frame.history.totalRows,
				screenStartOffset: presentation.frame.history.screenStartOffset,
			});
			historyRequestEpoch += 1;
			setHistoryBusy(false);
			setHistoryProjected(false);
			semanticRenderer?.apply(presentation);
			setPresentationError('');
		} catch (error) {
			setPresentationError(error instanceof Error ? error.message : String(error));
		}
	};
	const unsubscribePresentation = props.eventSource.onTerminalPresentation?.(props.sessionId, value => { liveConnected = true; applyPresentation(value); });
	const unsubscribeLifecycle = props.eventSource.onTerminalLiveAttachmentLifecycle?.(props.sessionId, event => {
		if (event.state === 'attached') { semanticResize.handleAttached(); return; }
		lifecycleCloseCount += 1;
		recordResizeDiagnostic({ action: 'lifecycle-closed', reason: event.reason, attachRequestCount, lifecycleCloseCount });
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
		historyRequestEpoch += 1;
		unsubscribePresentation?.();
		unsubscribeLifecycle?.();
		semanticResizeObserver?.disconnect();
		semanticResize.dispose();
		semanticRenderer?.dispose();
      unsubscribeData();
      unsubscribeGeometry?.();
    });
  });

  createEffect(() => {
    void requestResize();
  });

  const clearTerminal = () => {
    void props.transport.clear(props.sessionId);
  };

  const status = () => 'live';
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
        <div class="terminalPane"
		  onWheel={event => {
			if (event.deltaY === 0) return;
			if (event.deltaY < 0 || historyProjected()) event.preventDefault();
			void scrollHistory(event.deltaY < 0 ? 'backward' : 'forward');
		  }}>
          <SemanticTerminalSurface
            canvasId="semantic-terminal-surface"
            inputId="semantic-terminal-input"
            onCanvas={node => { semanticCanvas = node; }}
            onInputBridge={node => { inputBridge = node; }}
            renderer={() => semanticRenderer}
            sendInput={value => { void props.transport.sendInput(props.sessionId, value); }}
          />
		  <div
			class="semanticHistoryRail"
			role="scrollbar"
			aria-label="Terminal scrollback"
			aria-orientation="vertical"
			aria-valuemin="0"
			aria-valuemax={historyMaximum()}
			aria-valuenow={historyCurrent()}
			aria-controls="semantic-terminal-surface"
			tabIndex={0}
			data-visible={historyHovered() || historyDragging() ? 'true' : 'false'}
			data-hovered={historyHovered() ? 'true' : 'false'}
			data-dragging={historyDragging() ? 'true' : 'false'}
			style={`--semantic-history-start:${historyThumbStart()}%;--semantic-history-size:${historyThumbSize()}%`}
			onPointerEnter={() => setHistoryHovered(true)}
			onPointerLeave={() => { setHistoryHovered(false); if (!historyDragging()) setHistoryDragging(false); }}
			onPointerDown={event => {
				if (event.pointerType === 'touch') return;
				event.preventDefault();
				setHistoryDragging(true);
				event.currentTarget.setPointerCapture(event.pointerId);
				handleHistoryPointer(event);
			}}
			onPointerMove={event => { if (historyDragging()) handleHistoryPointer(event); }}
			onPointerUp={event => {
				if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
				setHistoryDragging(false);
				inputBridge?.focus({ preventScroll: true });
			}}
			onKeyDown={event => {
				switch (event.key) {
					case 'Home': event.preventDefault(); void queryHistory('start', true); break;
					case 'End': event.preventDefault(); showLatestPresentation(); break;
					case 'PageUp': case 'ArrowUp': event.preventDefault(); void scrollHistory('backward'); break;
					case 'PageDown': case 'ArrowDown': event.preventDefault(); void scrollHistory('forward'); break;
				}
			}}
		  >
			<span class="semanticHistoryThumb" data-semantic-history-thumb />
		  </div>
		  <Show when={historyError()}>
			{message => <div class="semanticHistoryError" role="status">History unavailable: {message()}</div>}
		  </Show>
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
  const [status, setStatus] = createSignal('connecting');
  const installHandle = (handle: SemanticViewportHandle | null) => {
    if (!handle) {
      props.onHarnessChange(props.label, null);
      return;
    }
    props.onHarnessChange(props.label, {
      label: props.label,
      sendInput: handle.sendInput,
      clear: handle.clear,
      serialize: handle.serialize,
      getVisibleLines: handle.getVisibleLines,
      getSelectionText: handle.getSelectionText,
      hasSelection: handle.hasSelection,
      getTerminalInfo: handle.getTerminalInfo,
      getPresentationDiagnostics: handle.getPresentation,
      getSnapshot: handle.getSnapshot,
      forceResize: handle.forceResize,
      synchronizeSize: handle.synchronizeSize,
      getGeometryDiagnostics: handle.getGeometryDiagnostics,
      getRenderDiagnostics: handle.getRenderDiagnostics,
      resetRenderDiagnostics: handle.resetRenderDiagnostics,
      getStreamDiagnostics: handle.getStreamDiagnostics,
      resetStreamDiagnostics: handle.resetStreamDiagnostics,
      reconnect: props.onReconnect,
    });
  };

  return (
    <section class="mirrorTerminalView" data-mirror-view={props.label}>
      <div class="tileHeader">
        <span class="tileName">{props.label}</span>
        <div class="mirrorViewActions">
          <span class="tileState">{status()}</span>
          <button onClick={props.onReconnect}>reconnect</button>
        </div>
      </div>
      <SemanticTerminalViewport
        sessionId={props.sessionId}
        transport={props.runtime.transport}
        eventSource={props.runtime.eventSource}
        class="mirrorTerminalSurface"
        canvasLabel={`${props.label} semantic terminal surface`}
        onState={(connected, error) => {
          const nextStatus = error || (connected ? 'live' : 'connecting');
          setStatus(nextStatus);
          props.onRuntimeState(props.label, connected, nextStatus);
        }}
        onHandle={installHandle}
      />
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
    <For each={[`${props.sessionId}:${generation()}`]}>
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
  let didStartStream = false;
  let streamTimer: number | null = null;
  const [tileStatus, setTileStatus] = createSignal('connecting');
  const handleState = (connected: boolean, error: string) => {
    const nextStatus = error ? 'error' : connected ? 'live' : 'connecting';
    setTileStatus(nextStatus);
    props.onRuntimeState(props.session.id, nextStatus, connected, Boolean(error));
    if (!connected || didStartStream || streamTimer !== null) return;
    streamTimer = window.setTimeout(() => {
      streamTimer = null;
      didStartStream = true;
      props.transport.sendInput(props.session.id, '\u0003' + buildLiveGridCommand(props.session.name)).catch(() => {
        didStartStream = false;
      });
    }, props.streamStartDelayMs);
  };
  onCleanup(() => { if (streamTimer !== null) window.clearTimeout(streamTimer); });
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
      <SemanticTerminalViewport
        sessionId={props.session.id}
        transport={props.transport}
        eventSource={props.eventSource}
        class="tileTerminal"
        canvasLabel={`${props.session.name} semantic terminal surface`}
        onState={handleState}
      />
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
