import { filterXtermAutoResponses } from '../utils/xtermAutoResponseFilter';
import { createConsoleLogger, noopLogger } from '../utils/logger';
import {
  TerminalState,
  type Logger,
  type TerminalClipboardConfig,
  type TerminalConfig,
  type TerminalCopySelectionResult,
  type TerminalCopySelectionSource,
  type TerminalDimensions,
  type TerminalEventHandlers,
  type TerminalFitConfig,
  type TerminalAppearance,
  type TerminalLinkProvider,
  type TerminalResponsiveConfig,
  type TerminalSelectionSnapshot,
  type TerminalVisualSuspendHandle,
  type TerminalVisualSuspendOptions,
  type TerminalVisualSuspendReason,
} from '../types';
import { resolveTerminalInputElement, TerminalInputBridge } from './TerminalInputBridge';

type terminal_search_match = {
  row: number;
  col: number;
  len: number;
};

type terminal_search_overlay = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  dpr: number;
  cssWidth: number;
  cssHeight: number;
  termCanvas: HTMLCanvasElement;
};

type terminal_selection_manager = {
  __floetermDemandRenderPatched?: boolean;
  copyToClipboard?: ((text: string) => Promise<void> | void) | null;
  requestRender?: () => void;
};

type floeterm_perf_probe = {
  onTerminalWrite?: (bytes: number) => void;
  onTerminalRender?: (durationMs: number) => void;
};

type ghostty_disposable = {
  dispose?: () => void;
};

type ghostty_runtime_terminal = import('ghostty-web').Terminal & {
  getScrollbackLength?: () => number;
  onBell?: (handler: () => void) => ghostty_disposable;
  onTitleChange?: (handler: (title: string) => void) => ghostty_disposable;
  onScroll?: (handler: () => void) => ghostty_disposable;
  onSelectionChange?: (handler: () => void) => ghostty_disposable;
  registerLinkProvider?: (provider: TerminalLinkProvider) => void;
};

type ghostty_cell_like = Partial<import('ghostty-web').GhosttyCell>;

type ghostty_renderer_with_row_cache = {
  __floetermDemandCursorPatched?: boolean;
  __floetermRowRenderCachePatched?: boolean;
  __floetermRowRenderCacheForceAll?: boolean;
  __floetermRowRenderCache?: Map<number, string>;
  cursorVisible?: boolean;
  ctx?: CanvasRenderingContext2D;
  currentBuffer?: {
    getCursor?: () => { y?: number };
    getGraphemeString?: (row: number, col: number) => string;
  } | null;
  currentSelectionCoords?: unknown;
  hoveredHyperlinkId?: number;
  hoveredLinkRange?: unknown;
  lastViewportY?: number;
  lastCursorPosition?: { y?: number };
  render?: (...args: unknown[]) => unknown;
  renderLine?: (cells: ghostty_cell_like[], row: number, cols: number) => unknown;
  remeasureFont?: () => unknown;
  setCursorBlink?: (enabled: boolean) => unknown;
};

type rgb_color = {
  r: number;
  g: number;
  b: number;
};

type terminal_theme_color_translator = {
  fg: Map<string, rgb_color>;
  bg: Map<string, rgb_color>;
};

type terminal_resize_reason = 'observer' | 'focus' | 'force' | 'post_init' | 'font';

type terminal_visual_render_state = {
  suspendDepth: number;
  nextSuspendId: number;
  activeReasons: Map<number, TerminalVisualSuspendReason>;
  pendingDemandRender: boolean;
  pendingForceFullRender: boolean;
  pendingResizeReason: terminal_resize_reason | null;
  pendingSearchOverlayRender: boolean;
};

type terminal_render_snapshot = {
  cursorY: number | null;
  rows: number | null;
  scrollbackLength: number | null;
  viewportY: number | null;
};

type ghostty_fit_addon_with_geometry_patch = import('ghostty-web').FitAddon & {
  __floetermGeometryPatchApplied?: boolean;
  proposeDimensions?: () => { cols: number; rows: number } | undefined;
};

const TERMINAL_SEARCH_MAX_RESULTS = 5000;

const PRESENTATION_SCALE_EPSILON = 0.0001;
const GHOSTTY_DEFAULT_SCROLLBAR_RESERVE_PX = 15;
const MIN_TERMINAL_COLS = 2;
const MIN_TERMINAL_ROWS = 1;

// Search highlighting: all matches use yellow background; active match uses yellow + red text.
const TERMINAL_SEARCH_MATCH_BACKGROUND = 'rgba(255, 234, 0, 0.38)';
const TERMINAL_SEARCH_ACTIVE_BACKGROUND = 'rgba(255, 234, 0, 0.72)';
const TERMINAL_SEARCH_ACTIVE_FOREGROUND = '#dc2626';
const TERMINAL_SELECTION_BACKGROUND = '#f5e6b3';
const TERMINAL_SELECTION_FOREGROUND = '#1f2328';
const TERMINAL_THEME_PALETTE_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

function parsePositiveCSSPixelValue(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveCanvasLocalDisplaySize(
  canvas: HTMLCanvasElement,
  coordinateRoot: HTMLElement,
): { cssWidth: number; cssHeight: number; dpr: number } {
  const canvasRect = canvas.getBoundingClientRect();
  const rootRect = coordinateRoot.getBoundingClientRect();
  const rootWidth = coordinateRoot.clientWidth;
  const rootHeight = coordinateRoot.clientHeight;

  const ratioWidth = rootRect.width > 0 && rootWidth > 0 && canvasRect.width > 0
    ? rootWidth * (canvasRect.width / rootRect.width)
    : null;
  const ratioHeight = rootRect.height > 0 && rootHeight > 0 && canvasRect.height > 0
    ? rootHeight * (canvasRect.height / rootRect.height)
    : null;

  const computed = (() => {
    try {
      return getComputedStyle(canvas);
    } catch {
      return null;
    }
  })();

  const cssWidth = ratioWidth
    ?? parsePositiveCSSPixelValue(canvas.style.width)
    ?? parsePositiveCSSPixelValue(computed?.width)
    ?? (canvas.offsetWidth > 0 ? canvas.offsetWidth : null)
    ?? (canvas.clientWidth > 0 ? canvas.clientWidth : null)
    ?? canvas.width;
  const cssHeight = ratioHeight
    ?? parsePositiveCSSPixelValue(canvas.style.height)
    ?? parsePositiveCSSPixelValue(computed?.height)
    ?? (canvas.offsetHeight > 0 ? canvas.offsetHeight : null)
    ?? (canvas.clientHeight > 0 ? canvas.clientHeight : null)
    ?? canvas.height;
  const dpr = cssWidth > 0 ? canvas.width / cssWidth : window.devicePixelRatio ?? 1;

  return {
    cssWidth,
    cssHeight,
    dpr: Number.isFinite(dpr) && dpr > 0 ? dpr : 1,
  };
}

const getPerfProbe = (): floeterm_perf_probe | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return (window as Window & { __floetermPerfProbe?: floeterm_perf_probe }).__floetermPerfProbe;
};

// Dynamic imports avoid SSR issues and keep the bundle flexible.
let TerminalCtor: typeof import('ghostty-web').Terminal | null = null;
let FitAddonCtor: typeof import('ghostty-web').FitAddon | null = null;
let ghosttyInit: typeof import('ghostty-web').init | null = null;
let ghosttyInitPromise: Promise<void> | null = null;

const loadGhosttyModules = async (logger: Logger): Promise<void> => {
  if (typeof window === 'undefined') {
    throw new Error('ghostty-web 只能在浏览器环境中加载');
  }

  if (TerminalCtor && FitAddonCtor && ghosttyInit) {
    return;
  }

  const { Terminal, FitAddon, init } = await import('ghostty-web');
  TerminalCtor = Terminal;
  FitAddonCtor = FitAddon;
  ghosttyInit = init;

  if (!ghosttyInitPromise) {
    logger.debug('[TerminalCore] Initializing ghostty-web WASM');
    ghosttyInitPromise = init().catch((error: unknown) => {
      ghosttyInitPromise = null;
      throw error;
    });
  }

  await ghosttyInitPromise;
};

const mapThemeToGhostty = (theme: Record<string, unknown> | undefined): Record<string, string> => {
  if (!theme) {
    return {};
  }

  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme)) {
    if (typeof value === 'string') {
      mapped[key] = value;
    }
  }

  if (mapped.selection && !mapped.selectionBackground) {
    mapped.selectionBackground = mapped.selection;
    delete mapped.selection;
  }

  return mapped;
};

function normalizeThemeColor(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const shortHex = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortHex) {
    const [r, g, b] = shortHex[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }

  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(trimmed);
  if (!rgb) {
    return null;
  }

  const channels = rgb.slice(1).map(channel => Number(channel));
  if (channels.some(channel => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    return null;
  }

  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function parseThemeColor(value: string | undefined): rgb_color | null {
  const normalized = normalizeThemeColor(value);
  if (!normalized) {
    return null;
  }

  const hex = normalized.slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function colorKey(color: rgb_color): string {
  return `${color.r},${color.g},${color.b}`;
}

function cellColorKey(cell: ghostty_cell_like, prefix: 'fg' | 'bg'): string | null {
  const r = Number(cell[`${prefix}_r`]);
  const g = Number(cell[`${prefix}_g`]);
  const b = Number(cell[`${prefix}_b`]);
  if (![r, g, b].every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
    return null;
  }
  return `${r},${g},${b}`;
}

function colorsEqual(left: rgb_color, right: rgb_color): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b;
}

function setColorTranslation(
  map: Map<string, rgb_color>,
  source: Record<string, string>,
  target: Record<string, string>,
  key: string,
): void {
  const sourceColor = parseThemeColor(source[key]);
  const targetColor = parseThemeColor(target[key]);
  if (!sourceColor || !targetColor || colorsEqual(sourceColor, targetColor)) {
    return;
  }
  map.set(colorKey(sourceColor), targetColor);
}

function buildThemeColorTranslator(
  source: Record<string, string>,
  target: Record<string, string>,
): terminal_theme_color_translator | null {
  const fg = new Map<string, rgb_color>();
  const bg = new Map<string, rgb_color>();

  for (const key of TERMINAL_THEME_PALETTE_KEYS) {
    setColorTranslation(fg, source, target, key);
    setColorTranslation(bg, source, target, key);
  }
  setColorTranslation(fg, source, target, 'foreground');
  setColorTranslation(bg, source, target, 'background');

  if (fg.size === 0 && bg.size === 0) {
    return null;
  }

  return { fg, bg };
}

function buildCellSignature(
  renderer: ghostty_renderer_with_row_cache,
  cell: ghostty_cell_like,
  row: number,
  col: number,
): string {
  const grapheme = (cell.grapheme_len ?? 0) > 0
    ? String(renderer.currentBuffer?.getGraphemeString?.(row, col) ?? '')
    : '';
  return [
    cell.codepoint ?? 0,
    cell.fg_r ?? 0,
    cell.fg_g ?? 0,
    cell.fg_b ?? 0,
    cell.bg_r ?? 0,
    cell.bg_g ?? 0,
    cell.bg_b ?? 0,
    cell.flags ?? 0,
    cell.width ?? 0,
    cell.hyperlink_id ?? 0,
    cell.grapheme_len ?? 0,
    grapheme,
  ].join(',');
}

function buildRowSignature(
  renderer: ghostty_renderer_with_row_cache,
  cells: readonly ghostty_cell_like[],
  row: number,
  cols: number,
): string {
  const parts = [`cols:${cols}`, `len:${cells.length}`];
  for (let col = 0; col < cells.length; col += 1) {
    parts.push(buildCellSignature(renderer, cells[col] ?? {}, row, col));
  }
  return parts.join(';');
}

function canSkipCachedRowRender(renderer: ghostty_renderer_with_row_cache, row: number): boolean {
  if (renderer.__floetermRowRenderCacheForceAll) {
    return false;
  }
  if (hasTransientRendererState(renderer)) {
    renderer.__floetermRowRenderCache?.clear();
    return false;
  }
  const cursorY = renderer.currentBuffer?.getCursor?.()?.y;
  if (typeof cursorY === 'number' && cursorY === row) {
    return false;
  }
  const previousCursorY = renderer.lastCursorPosition?.y;
  if (typeof previousCursorY === 'number' && previousCursorY === row) {
    return false;
  }
  return true;
}

function samePresentationScale(left: number, right: number): boolean {
  return Math.abs(left - right) <= PRESENTATION_SCALE_EPSILON;
}

function normalizeTerminalDimensions(value: unknown): TerminalDimensions | null {
  const raw = (typeof value === 'object' && value) ? value as Partial<TerminalDimensions> : null;
  if (!raw) {
    return null;
  }

  const cols = Math.floor(Number(raw.cols));
  const rows = Math.floor(Number(raw.rows));
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
    return null;
  }

  return { cols, rows };
}

function sameTerminalDimensions(left: TerminalDimensions | null, right: TerminalDimensions | null): boolean {
  return Boolean(left && right && left.cols === right.cols && left.rows === right.rows);
}

function normalizeNonNegativePixels(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function hasUsableClientSize(element: HTMLElement | null | undefined): element is HTMLElement {
  return Boolean(element && element.clientWidth > 0 && element.clientHeight > 0);
}

function hasTransientRendererState(renderer: ghostty_renderer_with_row_cache): boolean {
  return Boolean(
    renderer.currentSelectionCoords
    || (renderer.hoveredHyperlinkId ?? 0) > 0
    || renderer.hoveredLinkRange,
  );
}

// TerminalCore provides a focused wrapper around ghostty-web (xterm.js API-compatible) and its fit addon.
export class TerminalCore {
  private terminal: ghostty_runtime_terminal | null = null;
  private fitAddon: import('ghostty-web').FitAddon | null = null;
  private needsFullRenderOnNextWrite = false;
  private demandRenderRaf: number | null = null;
  private demandRenderForceAll = false;
  private viewportHost: HTMLDivElement | null = null;
  private renderHost: HTMLDivElement | null = null;

  private resizeObserver: ResizeObserver | null = null;
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeRaf: number | null = null;
  private focusResizeRaf: number | null = null;
  private presentationScaleRaf: number | null = null;
  private state: TerminalState = TerminalState.IDLE;
  private isDisposed = false;

  private isReplayingHistory = false;
  private replayingHistoryTimer: ReturnType<typeof setTimeout> | null = null;

  private logger: Logger;
  private eventHandlers: TerminalEventHandlers;
  private clipboard: Required<TerminalClipboardConfig>;
  private fit: Required<TerminalFitConfig>;
  private responsive: Required<TerminalResponsiveConfig>;
  private logicalFontSize = 12;
  private presentationScale = 1;
  private fixedDimensions: TerminalDimensions | null = null;
  private terminalThemeSource: Record<string, string> = {};
  private themeColorTranslator: terminal_theme_color_translator | null = null;
  private fontMetricSeq = 0;
  private pendingPresentationScale: number | null = null;
  private suppressResizeNotifications = false;
  private clearResizeSuppressionRaf: number | null = null;

  private hasFocus = false;
  private resizeNotifySeq = 0;
  private lastNotifiedSize: { cols: number; rows: number } | null = null;

  private unbindResponsiveListeners: (() => void) | null = null;

  private searchQuery = '';
  private searchOptionsKey = '';
  private searchMatches: terminal_search_match[] = [];
  private searchMatchIndex = -1;
  private searchRowIndex = new Map<number, terminal_search_match[]>();
  private searchResultsCallback:
    | ((results: { resultIndex: number; resultCount: number; matchPositions?: number[] }) => void)
    | null = null;

  private searchOverlay: terminal_search_overlay | null = null;
  private searchOverlayRaf: number | null = null;
  private searchOverlayUnsubs: Array<() => void> = [];

  // Temporary theme override while search is active.
  private searchThemeRestore: Record<string, string> | null = null;
  private inputBridge: TerminalInputBridge | null = null;
  private terminalEventDisposables: Array<() => void> = [];
  private readonly registeredLinkProviders = new Set<TerminalLinkProvider>();
  private readonly appliedLinkProviders = new Set<TerminalLinkProvider>();
  private readonly visualRenderState: terminal_visual_render_state = {
    suspendDepth: 0,
    nextSuspendId: 1,
    activeReasons: new Map(),
    pendingDemandRender: false,
    pendingForceFullRender: false,
    pendingResizeReason: null,
    pendingSearchOverlayRender: false,
  };

  constructor(
    private container: HTMLElement,
    private config: TerminalConfig = {},
    eventHandlers: TerminalEventHandlers = {},
    logger: Logger = createConsoleLogger()
  ) {
    this.eventHandlers = eventHandlers;
    this.clipboard = TerminalCore.normalizeClipboardConfig(config?.clipboard);
    this.fit = TerminalCore.normalizeFitConfig(config?.fit);
    this.logger = logger ?? noopLogger;
    this.responsive = TerminalCore.normalizeResponsiveConfig(config?.responsive);
    this.logicalFontSize = TerminalCore.normalizeFontSize(config?.fontSize);
    this.presentationScale = TerminalCore.normalizePresentationScale(config?.presentationScale);
    this.fixedDimensions = normalizeTerminalDimensions(config?.fixedDimensions);
  }

  // initialize creates the ghostty-web terminal instance and binds addons.
  async initialize(): Promise<void> {
    if (this.isDisposed) {
      throw new Error('Cannot initialize a disposed TerminalCore');
    }

    if (this.terminal || this.state === TerminalState.INITIALIZING) {
      return;
    }

    this.setState(TerminalState.INITIALIZING);
    await loadGhosttyModules(this.logger);
    await this.createTerminalInstance();
    await this.loadAddons();
    await this.openTerminal();
    this.setupEventListeners();
    this.setupResponsiveListeners();
    this.startSizeWatching();

    this.setState(TerminalState.READY);
    this.performResize('post_init');
    this.forceFullRender();

    setTimeout(() => {
      if (!this.isReady()) {
        return;
      }
      // Defer the initial fit slightly to ensure the container has stable layout and fonts are ready.
      this.performResize('post_init');
    }, 100);
  }

  private async createTerminalInstance(): Promise<void> {
    if (!TerminalCtor) {
      throw new Error('ghostty-web module not loaded');
    }

    const defaultConfig: TerminalConfig = {
      cols: 80,
      rows: 24,
      theme: {
        background: '#1a1a1a',
        foreground: '#ffffff',
        cursor: '#ffffff',
        selectionBackground: TERMINAL_SELECTION_BACKGROUND,
        selectionForeground: TERMINAL_SELECTION_FOREGROUND
      },
      fontSize: 12,
      fontFamily: '\"SF Mono\", Monaco, \"Cascadia Code\", \"Roboto Mono\", Consolas, \"Courier New\", monospace',
      cursorBlink: false,
      scrollback: 1000,
      allowTransparency: false,
      convertEol: true,
      cursorStyle: 'block',
      disableStdin: false,
      smoothScrollDuration: 80
    };

    const finalConfig = { ...defaultConfig, ...this.config };
    const initialTheme = mapThemeToGhostty(finalConfig.theme);
    this.terminalThemeSource = initialTheme;
    this.themeColorTranslator = null;
    this.logicalFontSize = TerminalCore.normalizeFontSize(finalConfig.fontSize);
    this.presentationScale = TerminalCore.normalizePresentationScale(finalConfig.presentationScale);
    await this.waitForTerminalFontReady(
      typeof finalConfig.fontFamily === 'string' ? finalConfig.fontFamily : undefined,
      this.resolveEffectiveFontSize(),
      'initial',
    );
    const initialDimensions = this.fixedDimensions;
    this.terminal = new TerminalCtor({
      cols: initialDimensions?.cols ?? (typeof finalConfig.cols === 'number' ? finalConfig.cols : undefined),
      rows: initialDimensions?.rows ?? (typeof finalConfig.rows === 'number' ? finalConfig.rows : undefined),
      cursorBlink: typeof finalConfig.cursorBlink === 'boolean' ? finalConfig.cursorBlink : undefined,
      cursorStyle: typeof (finalConfig as any).cursorStyle === 'string' ? ((finalConfig as any).cursorStyle as any) : undefined,
      theme: initialTheme,
      scrollback: typeof finalConfig.scrollback === 'number' ? finalConfig.scrollback : undefined,
      fontSize: this.resolveEffectiveFontSize(),
      fontFamily: typeof finalConfig.fontFamily === 'string' ? finalConfig.fontFamily : undefined,
      allowTransparency: typeof finalConfig.allowTransparency === 'boolean' ? finalConfig.allowTransparency : undefined,
      convertEol: typeof finalConfig.convertEol === 'boolean' ? finalConfig.convertEol : undefined,
      disableStdin: typeof (finalConfig as any).disableStdin === 'boolean' ? ((finalConfig as any).disableStdin as boolean) : undefined,
      smoothScrollDuration: typeof (finalConfig as any).smoothScrollDuration === 'number' ? ((finalConfig as any).smoothScrollDuration as number) : undefined
    }) as ghostty_runtime_terminal;
  }

  private async loadAddons(): Promise<void> {
    if (!this.terminal) {
      throw new Error('Terminal instance not created');
    }

    if (!FitAddonCtor) {
      throw new Error('Required ghostty-web addons not loaded');
    }

    this.fitAddon = new FitAddonCtor();
    this.terminal.loadAddon(this.fitAddon);
    this.installFitAddonGeometryPatch();
  }

  private async openTerminal(): Promise<void> {
    if (!this.terminal) {
      throw new Error('Terminal instance not created');
    }

    await this.waitForDOMAndFonts();
    await this.ensureContainerReady();
    this.ensurePresentationHosts();
    this.applyPresentationScaleStyles();
    this.installDemandRenderPatchBeforeOpen();
    this.terminal.open(this.renderHost ?? this.container);
    this.stopGhosttyRenderLoop();
    this.patchDemandRenderTriggersAfterOpen();
    this.patchSelectionManagerClipboardBehavior();
    this.patchSelectionManagerRenderingBehavior();
    this.setupInputBridge();
    this.applyRegisteredLinkProviders();
    void this.refreshFontMetricsAfterLoad('open');
  }

  private installFitAddonGeometryPatch(): void {
    const fitAddon = this.fitAddon as ghostty_fit_addon_with_geometry_patch | null;
    if (!fitAddon || fitAddon.__floetermGeometryPatchApplied) {
      return;
    }

    fitAddon.__floetermGeometryPatchApplied = true;
    fitAddon.proposeDimensions = () => this.proposeFitDimensions();
  }

  private proposeFitDimensions(): TerminalDimensions | undefined {
    const terminalAny = this.terminal as unknown as {
      element?: HTMLElement | null;
      renderer?: {
        getMetrics?: () => { width?: number; height?: number } | null | undefined;
      } | null;
    } | null;
    const renderer = terminalAny?.renderer;
    const metrics = typeof renderer?.getMetrics === 'function' ? renderer.getMetrics() : null;
    const cellWidth = Number(metrics?.width);
    const cellHeight = Number(metrics?.height);
    if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) {
      return undefined;
    }

    const element = this.resolveFitElement(terminalAny?.element);
    if (!element || typeof element.clientWidth === 'undefined') {
      return undefined;
    }

    const width = element.clientWidth;
    const height = element.clientHeight;
    if (width === 0 || height === 0) {
      return undefined;
    }

    const style = getComputedStyle(element);
    const paddingTop = Number.parseInt(style.getPropertyValue('padding-top')) || 0;
    const paddingBottom = Number.parseInt(style.getPropertyValue('padding-bottom')) || 0;
    const paddingLeft = Number.parseInt(style.getPropertyValue('padding-left')) || 0;
    const paddingRight = Number.parseInt(style.getPropertyValue('padding-right')) || 0;

    const availableWidth = Math.max(0, width - paddingLeft - paddingRight - this.fit.scrollbarReservePx);
    const availableHeight = Math.max(0, height - paddingTop - paddingBottom);
    return {
      cols: Math.max(MIN_TERMINAL_COLS, Math.floor(availableWidth / cellWidth)),
      rows: Math.max(MIN_TERMINAL_ROWS, Math.floor(availableHeight / cellHeight)),
    };
  }

  private resolveFitElement(terminalElement: HTMLElement | null | undefined): HTMLElement | null {
    const candidates = [
      terminalElement,
      this.renderHost,
      this.viewportHost,
      this.container,
    ];
    return candidates.find(hasUsableClientSize) ?? terminalElement ?? this.renderHost ?? this.container;
  }

  private installDemandRenderPatchBeforeOpen(): void {
    const terminalAny = this.terminal as unknown as {
      __floetermDemandRenderLoopPatched?: boolean;
      startRenderLoop?: () => void;
    } | null;

    if (!terminalAny || terminalAny.__floetermDemandRenderLoopPatched) {
      return;
    }

    terminalAny.__floetermDemandRenderLoopPatched = true;
    // ghostty-web currently starts a perpetual RAF loop from open(). TerminalCore
    // already knows every meaningful invalidation point, so keep rendering
    // demand-driven while preserving the upstream terminal surface.
    terminalAny.startRenderLoop = () => {
      this.requestDemandRender(false);
    };
  }

  private patchDemandRenderTriggersAfterOpen(): void {
    const terminalAny = this.terminal as unknown as {
      __floetermDemandRenderTriggersPatched?: boolean;
      animateScroll?: (...args: unknown[]) => unknown;
      renderer?: ghostty_renderer_with_row_cache & {
        __floetermDemandRenderPatched?: boolean;
        setHoveredHyperlinkId?: (...args: unknown[]) => unknown;
        setHoveredLinkRange?: (...args: unknown[]) => unknown;
        setCursorStyle?: (...args: unknown[]) => unknown;
        setCursorBlink?: (...args: unknown[]) => unknown;
        setTheme?: (...args: unknown[]) => unknown;
        setFontSize?: (...args: unknown[]) => unknown;
        setFontFamily?: (...args: unknown[]) => unknown;
        clear?: (...args: unknown[]) => unknown;
      };
    } | null;

    if (!terminalAny || terminalAny.__floetermDemandRenderTriggersPatched) {
      return;
    }

    terminalAny.__floetermDemandRenderTriggersPatched = true;

    if (typeof terminalAny.animateScroll === 'function') {
      const originalAnimateScroll = terminalAny.animateScroll.bind(terminalAny);
      terminalAny.animateScroll = (...args: unknown[]) => {
        const result = originalAnimateScroll(...args);
        this.requestDemandRender(false);
        return result;
      };
    }

    const renderer = terminalAny.renderer;
    this.installRendererRowCachePatch(renderer);
    if (!renderer || renderer.__floetermDemandRenderPatched) {
      return;
    }

    renderer.__floetermDemandRenderPatched = true;
    const wrapRendererInvalidation = <T extends keyof typeof renderer>(method: T): void => {
      const original = renderer[method];
      if (typeof original !== 'function') {
        return;
      }

      renderer[method] = ((...args: unknown[]) => {
        const result = original.apply(renderer, args);
        this.requestDemandRender(false);
        return result;
      }) as typeof renderer[T];
    };

    wrapRendererInvalidation('setHoveredHyperlinkId');
    wrapRendererInvalidation('setHoveredLinkRange');
    wrapRendererInvalidation('setCursorStyle');
    wrapRendererInvalidation('setCursorBlink');
    wrapRendererInvalidation('setTheme');
    wrapRendererInvalidation('setFontSize');
    wrapRendererInvalidation('setFontFamily');
    wrapRendererInvalidation('clear');

    this.patchRendererCursorBlinkForDemandRendering(renderer);
  }

  private patchRendererCursorBlinkForDemandRendering(renderer: ghostty_renderer_with_row_cache | null | undefined): void {
    if (!renderer || renderer.__floetermDemandCursorPatched) {
      return;
    }

    renderer.__floetermDemandCursorPatched = true;
    renderer.cursorVisible = true;

    try {
      renderer.setCursorBlink?.(false);
    } catch (error) {
      this.logger.debug('[TerminalCore] Failed to disable cursor blink for demand rendering', { error });
    }

    if (this.terminal) {
      this.terminal.options.cursorBlink = false;
    }
  }

  private keepDemandCursorVisible(renderer: ghostty_renderer_with_row_cache | undefined): void {
    if (!renderer) {
      return;
    }

    renderer.cursorVisible = true;
  }

  private installRendererRowCachePatch(renderer: ghostty_renderer_with_row_cache | null | undefined): void {
    if (!renderer || renderer.__floetermRowRenderCachePatched) {
      return;
    }
    if (typeof renderer.render !== 'function' || typeof renderer.renderLine !== 'function') {
      return;
    }

    const originalRender = renderer.render.bind(renderer);
    const originalRenderLine = renderer.renderLine.bind(renderer);
    const cache = new Map<number, string>();

    renderer.__floetermRowRenderCachePatched = true;
    renderer.__floetermRowRenderCache = cache;
    renderer.render = (...args: unknown[]) => {
      const incomingViewportY = Number(args[2] ?? 0);
      const currentViewportY = Number(renderer.lastViewportY ?? 0);
      const viewportChanged = Number.isFinite(incomingViewportY)
        && Number.isFinite(currentViewportY)
        && incomingViewportY !== currentViewportY;
      renderer.__floetermRowRenderCacheForceAll = Boolean(args[1]) || viewportChanged;
      try {
        return originalRender(...args);
      } finally {
        renderer.__floetermRowRenderCacheForceAll = false;
      }
    };
    renderer.renderLine = (cells: ghostty_cell_like[], row: number, cols: number) => {
      const themedCells = this.translateCellsForTheme(cells);
      const signature = buildRowSignature(renderer, themedCells, row, cols);
      if (canSkipCachedRowRender(renderer, row) && cache.get(row) === signature) {
        return undefined;
      }

      const result = originalRenderLine(themedCells, row, cols);
      if (hasTransientRendererState(renderer)) {
        cache.delete(row);
        return result;
      }
      cache.set(row, signature);
      return result;
    };
  }

  private translateCellsForTheme(cells: ghostty_cell_like[]): ghostty_cell_like[] {
    const translator = this.themeColorTranslator;
    if (!translator) {
      return cells;
    }

    let translatedCells: ghostty_cell_like[] | null = null;
    for (let index = 0; index < cells.length; index += 1) {
      const cell = translatedCells?.[index] ?? cells[index] ?? {};
      const translated = this.translateCellForTheme(cell, translator);
      if (translated !== cell && !translatedCells) {
        translatedCells = cells.slice(0, index);
      }
      translatedCells?.push(translated);
    }

    return translatedCells ?? cells;
  }

  private translateCellForTheme(
    cell: ghostty_cell_like,
    translator: terminal_theme_color_translator,
  ): ghostty_cell_like {
    const fgKey = cellColorKey(cell, 'fg');
    const bgKey = cellColorKey(cell, 'bg');
    const fg = fgKey ? translator.fg.get(fgKey) : undefined;
    const bg = bgKey ? translator.bg.get(bgKey) : undefined;

    if (!fg && !bg) {
      return cell;
    }

    return {
      ...cell,
      ...(fg ? { fg_r: fg.r, fg_g: fg.g, fg_b: fg.b } : {}),
      ...(bg ? { bg_r: bg.r, bg_g: bg.g, bg_b: bg.b } : {}),
    };
  }

  private ensurePresentationHosts(): void {
    if (this.viewportHost && this.renderHost) {
      return;
    }

    const viewportHost = document.createElement('div');
    viewportHost.style.position = 'relative';
    viewportHost.style.width = '100%';
    viewportHost.style.height = '100%';
    viewportHost.style.overflow = 'hidden';

    const renderHost = document.createElement('div');
    renderHost.style.position = 'absolute';
    renderHost.style.inset = '0';
    renderHost.style.overflow = 'hidden';
    renderHost.style.transformOrigin = 'top left';
    renderHost.style.willChange = 'transform';

    viewportHost.appendChild(renderHost);
    this.container.replaceChildren(viewportHost);
    this.viewportHost = viewportHost;
    this.renderHost = renderHost;
  }

  private applyPresentationScaleStyles(): void {
    const renderHost = this.renderHost;
    if (!renderHost) {
      return;
    }

    const scale = this.pendingPresentationScale ?? this.presentationScale;
    if (scale <= 1.001) {
      renderHost.style.width = '100%';
      renderHost.style.height = '100%';
      renderHost.style.transform = 'none';
      return;
    }

    renderHost.style.width = `${scale * 100}%`;
    renderHost.style.height = `${scale * 100}%`;
    renderHost.style.transform = `scale(${1 / scale})`;
  }

  private patchSelectionManagerClipboardBehavior(): void {
    if (this.clipboard.copyOnSelect) {
      return;
    }

    const selectionManager = ((this.terminal as unknown as { selectionManager?: terminal_selection_manager | null } | null)
      ?.selectionManager) ?? null;
    if (!selectionManager || typeof selectionManager.copyToClipboard !== 'function') {
      return;
    }

    selectionManager.copyToClipboard = async () => {
      // Disable the upstream copy-on-select side effect while keeping
      // the selection lifecycle intact for explicit copy commands.
    };
  }

  private patchSelectionManagerRenderingBehavior(): void {
    const selectionManager = ((this.terminal as unknown as { selectionManager?: terminal_selection_manager | null } | null)
      ?.selectionManager) ?? null;
    if (!selectionManager || selectionManager.__floetermDemandRenderPatched) {
      return;
    }

    selectionManager.__floetermDemandRenderPatched = true;
    const originalRequestRender = typeof selectionManager.requestRender === 'function'
      ? selectionManager.requestRender.bind(selectionManager)
      : null;

    selectionManager.requestRender = () => {
      originalRequestRender?.();
      this.requestDemandRender(false);
    };
  }

  private setupInputBridge(): void {
    this.disposeInputBridge();

    const input = resolveTerminalInputElement(this.container);
    if (!input) {
      this.logger.debug('[TerminalCore] No terminal input host found for input bridge');
      return;
    }

    this.inputBridge = new TerminalInputBridge(
      this.container,
      input,
      (data: string) => {
        this.eventHandlers.onData?.(data);
      },
      this.logger,
      () => this.hasSelection(),
      (source, clipboardData) => this.performSelectionCopy(source, clipboardData),
    );
  }

  private async waitForDOMAndFonts(): Promise<void> {
    if (document.readyState !== 'complete') {
      await new Promise<void>((resolve) => {
        const handler = () => {
          if (document.readyState === 'complete') {
            document.removeEventListener('readystatechange', handler);
            resolve();
          }
        };
        document.addEventListener('readystatechange', handler);
      });
    }

    if (typeof document.fonts !== 'undefined' && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch (error) {
        this.logger.warn('[TerminalCore] Font loading failed, continuing', { error });
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  private async waitForTerminalFontReady(fontFamily: string | undefined, fontSize: number, reason: string): Promise<void> {
    if (typeof document === 'undefined') {
      return;
    }

    await this.waitForDOMAndFonts();

    const fonts = document.fonts;
    if (!fontFamily || typeof fonts === 'undefined' || typeof fonts.load !== 'function') {
      return;
    }

    const cssFont = `${Math.max(1, fontSize)}px ${fontFamily}`;
    try {
      await fonts.load(cssFont, 'MMMMMMMMMM');
      if (fonts.ready) {
        await fonts.ready;
      }
    } catch (error) {
      this.logger.warn('[TerminalCore] Terminal font loading failed, continuing', { error, reason, fontFamily });
    }
  }

  private async refreshFontMetricsAfterLoad(reason: string): Promise<void> {
    if (!this.terminal) {
      return;
    }

    const terminalAny = this.terminal as unknown as {
      options?: { fontFamily?: string; fontSize?: number };
      renderer?: ghostty_renderer_with_row_cache;
    };
    const fontFamily = terminalAny.options?.fontFamily ?? this.config.fontFamily;
    const fontSize = Number(terminalAny.options?.fontSize ?? this.resolveEffectiveFontSize());
    const seq = ++this.fontMetricSeq;

    await this.waitForTerminalFontReady(typeof fontFamily === 'string' ? fontFamily : undefined, fontSize, reason);

    if (this.isDisposed || seq !== this.fontMetricSeq || !this.terminal) {
      return;
    }

    try {
      terminalAny.renderer?.remeasureFont?.();
    } catch (error) {
      this.logger.debug('[TerminalCore] Terminal font remeasure failed', { error, reason });
    }

    this.performResize('font');
    this.forceFullRender();
    this.scheduleRenderSearchOverlay();
  }

  private async ensureContainerReady(): Promise<void> {
    const maxRetries = 15;
    const retryDelay = 50;

    if (!document.contains(this.container)) {
      throw new Error('Container element is no longer in the DOM');
    }

    for (let i = 0; i < maxRetries; i += 1) {
      if (!document.contains(this.container)) {
        throw new Error('Container element removed from DOM during initialization');
      }

      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      const style = getComputedStyle(this.container);

      if (width > 0 && height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
        return;
      }

      await new Promise(resolve => requestAnimationFrame(resolve));
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  private setupEventListeners(): void {
    if (!this.terminal) {
      return;
    }

    this.disposeTerminalEventListeners();

    if (this.eventHandlers.onData) {
      const disposable = this.terminal.onData((data: string) => {
        let filtered = data;
        if (this.isReplayingHistory) {
          filtered = filterXtermAutoResponses(data);
          if (filtered.length === 0) {
            return;
          }
        }
        this.eventHandlers.onData?.(filtered);
      });
      this.trackTerminalEventDisposable(disposable);
    }

    if (this.eventHandlers.onResize) {
      const disposable = this.terminal.onResize((size: { cols: number; rows: number }) => {
        this.emitResize(size, { source: 'terminal' });
      });
      this.trackTerminalEventDisposable(disposable);
    }

    if (this.eventHandlers.onBell && typeof this.terminal.onBell === 'function') {
      const disposable = this.terminal.onBell(() => {
        this.eventHandlers.onBell?.();
      });
      this.trackTerminalEventDisposable(disposable);
    }

    if (this.eventHandlers.onTitleChange && typeof this.terminal.onTitleChange === 'function') {
      const disposable = this.terminal.onTitleChange((title: string) => {
        this.eventHandlers.onTitleChange?.(title);
      });
      this.trackTerminalEventDisposable(disposable);
    }

    if (typeof this.terminal.onScroll === 'function') {
      const disposable = this.terminal.onScroll(() => {
        this.requestDemandRender(false);
      });
      this.trackTerminalEventDisposable(disposable);
    }

    if (typeof this.terminal.onSelectionChange === 'function') {
      const disposable = this.terminal.onSelectionChange(() => {
        this.requestDemandRender(false);
      });
      this.trackTerminalEventDisposable(disposable);
    }
  }

  private setupResponsiveListeners(): void {
    const enabled = this.responsive.fitOnFocus || this.responsive.emitResizeOnFocus || this.responsive.notifyResizeOnlyWhenFocused;
    if (!enabled) {
      return;
    }

    const onFocusIn = () => {
      this.hasFocus = true;
      this.scheduleFocusResize();
    };

    const onFocusOut = () => {
      // focusout fires even when moving focus within the subtree; re-check on next frame.
      requestAnimationFrame(() => {
        if (this.isDisposed) {
          return;
        }
        this.hasFocus = this.isContainerFocused();
      });
    };

    const onPointerDown = () => {
      // pointerdown can happen before focus moves; treat it as "intent to interact".
      this.hasFocus = true;
      this.scheduleFocusResize();
    };

    this.container.addEventListener('focusin', onFocusIn);
    this.container.addEventListener('focusout', onFocusOut);
    this.container.addEventListener('pointerdown', onPointerDown);

    this.hasFocus = this.isContainerFocused();

    this.unbindResponsiveListeners = () => {
      this.container.removeEventListener('focusin', onFocusIn);
      this.container.removeEventListener('focusout', onFocusOut);
      this.container.removeEventListener('pointerdown', onPointerDown);
    };
  }

  private startSizeWatching(): void {
    if (!this.container || !this.fitAddon) {
      return;
    }
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleObservedResize();
    });

    const observed = new Set<Element>();
    const observe = (target: Element | null | undefined) => {
      if (!target || observed.has(target)) {
        return;
      }
      observed.add(target);
      this.resizeObserver?.observe(target);
    };

    observe(this.container);
    observe(this.container.parentElement);
    observe(this.viewportHost);
    observe(this.renderHost);
  }

  private scheduleObservedResize(): void {
    if (this.resizeRaf === null) {
      this.resizeRaf = requestAnimationFrame(() => {
        this.resizeRaf = null;
        this.performResize('observer');
      });
    }

    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
    }

    this.resizeDebounceTimer = setTimeout(() => {
      this.resizeDebounceTimer = null;
      this.performResize('observer');
    }, 80);
  }

  private performResize(reason: terminal_resize_reason): void {
    if (this.isVisualRenderSuspended()) {
      this.markPendingResize(reason);
      return;
    }

    this.performResizeNow(reason);
  }

  private performResizeNow(reason: terminal_resize_reason): void {
    if (!this.isReady() || !this.fitAddon || !this.terminal) {
      return;
    }

    if (this.fixedDimensions) {
      this.applyFixedDimensions(reason);
      return;
    }

    if (this.container.clientWidth === 0 || this.container.clientHeight === 0) {
      return;
    }

    const startSeq = this.resizeNotifySeq;
    const before = this.lastNotifiedSize;

    try {
      this.fitAddon.fit();
    } catch (error) {
      this.logger.debug('[TerminalCore] Resize failed', { error });
    }

    // Some ghostty-web builds may not always emit onResize for programmatic fit().
    // Emit a deduped notification based on the actual terminal dimensions.
    if (this.resizeNotifySeq !== startSeq) {
      return;
    }

    const dims = this.getDimensions();
    if (reason === 'focus' && this.responsive.emitResizeOnFocus) {
      const force = Boolean(before) && before!.cols === dims.cols && before!.rows === dims.rows;
      this.emitResize(dims, { source: 'core', force });
      return;
    }

    this.emitResize(dims, { source: 'core' });
  }

  private applyFixedDimensions(reason: terminal_resize_reason): void {
    if (!this.terminal || !this.fixedDimensions) {
      return;
    }

    const dims = this.fixedDimensions;
    const startSeq = this.resizeNotifySeq;
    const before = this.lastNotifiedSize;
    const changed = this.terminal.cols !== dims.cols || this.terminal.rows !== dims.rows;

    if (changed) {
      try {
        this.terminal.resize(dims.cols, dims.rows);
      } catch (error) {
        this.logger.debug('[TerminalCore] Fixed-dimension resize failed', { error });
      }
    }

    // Some ghostty-web builds may not emit onResize for programmatic resize().
    if (this.resizeNotifySeq !== startSeq) {
      return;
    }

    if (reason === 'focus' && this.responsive.emitResizeOnFocus) {
      const force = Boolean(before) && before!.cols === dims.cols && before!.rows === dims.rows;
      this.emitResize(dims, { source: 'core', force });
      return;
    }

    if (changed) {
      this.emitResize(dims, { source: 'core' });
    }
  }

  private scheduleFocusResize(): void {
    if (!this.responsive.fitOnFocus && !this.responsive.emitResizeOnFocus) {
      return;
    }
    if (this.focusResizeRaf !== null) {
      return;
    }
    this.focusResizeRaf = requestAnimationFrame(() => {
      this.focusResizeRaf = null;
      this.performResize('focus');
    });
  }

  private emitResize(size: { cols: number; rows: number }, opts: { source: 'terminal' | 'core'; force?: boolean }): void {
    if (!this.eventHandlers.onResize) {
      return;
    }
    if (this.suppressResizeNotifications) {
      return;
    }
    if (this.responsive.notifyResizeOnlyWhenFocused && !this.hasFocus) {
      return;
    }

    const cols = typeof size?.cols === 'number' ? size.cols : 0;
    const rows = typeof size?.rows === 'number' ? size.rows : 0;

    if (!opts.force && this.lastNotifiedSize && this.lastNotifiedSize.cols === cols && this.lastNotifiedSize.rows === rows) {
      return;
    }

    this.lastNotifiedSize = { cols, rows };
    this.resizeNotifySeq += 1;

    try {
      this.eventHandlers.onResize({ cols, rows });
    } catch (error) {
      this.logger.warn('[TerminalCore] onResize handler threw', { error });
    }
  }

  private isContainerFocused(): boolean {
    if (typeof document === 'undefined') {
      return false;
    }
    const el = document.activeElement;
    if (!el) {
      return false;
    }
    return this.container.contains(el);
  }

  private setState(newState: TerminalState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.eventHandlers.onStateChange?.(newState);
    }
  }

  private isReady(): boolean {
    return this.state === TerminalState.READY || this.state === TerminalState.CONNECTED;
  }

  // startHistoryReplay enables auto-response filtering for a limited duration.
  startHistoryReplay(duration = 2000): void {
    if (this.replayingHistoryTimer) {
      clearTimeout(this.replayingHistoryTimer);
    }
    this.isReplayingHistory = true;
    this.replayingHistoryTimer = setTimeout(() => this.endHistoryReplay(), duration);
  }

  // endHistoryReplay disables auto-response filtering.
  endHistoryReplay(): void {
    if (this.replayingHistoryTimer) {
      clearTimeout(this.replayingHistoryTimer);
      this.replayingHistoryTimer = null;
    }
    this.isReplayingHistory = false;
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    if (!this.terminal || !this.isReady()) {
      callback?.();
      return;
    }

    try {
      getPerfProbe()?.onTerminalWrite?.(typeof data === 'string' ? data.length : data.byteLength);
      const beforeWrite = this.captureRenderSnapshot();
      const shouldForce = this.needsFullRenderOnNextWrite;

      if (callback || shouldForce) {
        this.terminal.write(data as string | Uint8Array, () => {
          const shouldForceAfterWrite = shouldForce || this.shouldForceFullRenderAfterWrite(beforeWrite);
          if (shouldForceAfterWrite) {
            this.needsFullRenderOnNextWrite = false;
          }
          this.requestDemandRender(shouldForceAfterWrite);
          callback?.();
        });
        return;
      }

      this.terminal.write(data as string | Uint8Array);
      this.requestDemandRender(this.shouldForceFullRenderAfterWrite(beforeWrite));
    } catch (error) {
      this.logger.error('[TerminalCore] Write failed', { error });
      callback?.();
    }
  }

  clear(): void {
    if (!this.terminal || !this.isReady()) {
      return;
    }

    this.terminal.clear();
    this.needsFullRenderOnNextWrite = true;
    this.forceFullRender();
  }

  serialize(): string {
    return '';
  }

  getSelectionText(): string {
    if (!this.terminal) {
      return '';
    }
    return this.terminal.getSelection();
  }

  hasSelection(): boolean {
    return this.getSelectionSnapshot().hasSelection;
  }

  async copySelection(source: TerminalCopySelectionSource = 'command'): Promise<TerminalCopySelectionResult> {
    return this.performSelectionCopy(source);
  }

  getState(): TerminalState {
    return this.state;
  }

  private getSelectionSnapshot(): TerminalSelectionSnapshot {
    const text = this.getSelectionText();
    return {
      text,
      hasSelection: text.length > 0,
    };
  }

  private async performSelectionCopy(
    source: TerminalCopySelectionSource,
    clipboardData: DataTransfer | null = null,
  ): Promise<TerminalCopySelectionResult> {
    const selection = this.getSelectionSnapshot();
    if (!selection.hasSelection) {
      return {
        copied: false,
        reason: 'empty_selection',
        source,
      };
    }

    if (clipboardData && typeof clipboardData.setData === 'function') {
      clipboardData.setData('text/plain', selection.text);
      return {
        copied: true,
        textLength: selection.text.length,
        source,
      };
    }

    if (await this.copyTextWithNavigatorClipboard(selection.text, source)) {
      return {
        copied: true,
        textLength: selection.text.length,
        source,
      };
    }

    if (this.copyTextWithExecCommand(selection.text)) {
      return {
        copied: true,
        textLength: selection.text.length,
        source,
      };
    }

    this.logger.warn('[TerminalCore] Clipboard copy unavailable', {
      source,
      textLength: selection.text.length,
    });
    return {
      copied: false,
      reason: 'clipboard_unavailable',
      source,
    };
  }

  private async copyTextWithNavigatorClipboard(
    text: string,
    source: TerminalCopySelectionSource,
  ): Promise<boolean> {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      return false;
    }

    try {
      await clipboard.writeText(text);
      return true;
    } catch (error) {
      this.logger.debug('[TerminalCore] navigator.clipboard.writeText failed', {
        error,
        source,
      });
      return false;
    }
  }

  private copyTextWithExecCommand(text: string): boolean {
    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
      return false;
    }

    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restorableSelection = (
      previousActiveElement instanceof HTMLInputElement ||
      previousActiveElement instanceof HTMLTextAreaElement
    )
      ? {
        element: previousActiveElement,
        start: previousActiveElement.selectionStart ?? 0,
        end: previousActiveElement.selectionEnd ?? 0,
        direction: previousActiveElement.selectionDirection ?? 'none',
      }
      : null;

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';

    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
      textarea.setSelectionRange(0, text.length);
    } catch {
      this.logger.debug('[TerminalCore] Failed to prepare textarea selection for clipboard fallback');
    }

    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {
      this.logger.debug('[TerminalCore] document.execCommand("copy") failed', { error });
    }

    textarea.remove();
    previousActiveElement?.focus();

    if (restorableSelection) {
      try {
        restorableSelection.element.setSelectionRange(
          restorableSelection.start,
          restorableSelection.end,
          restorableSelection.direction,
        );
      } catch {
        this.logger.debug('[TerminalCore] Failed to restore previous selection after clipboard fallback');
      }
    }

    return copied;
  }

  getDimensions(): { cols: number; rows: number } {
    if (!this.terminal) {
      return { cols: 0, rows: 0 };
    }
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  getTerminalInfo(): { rows: number; cols: number; bufferLength: number } | null {
    if (!this.terminal) {
      return null;
    }
    return {
      rows: this.terminal.rows,
      cols: this.terminal.cols,
      bufferLength: this.terminal.buffer.active.length
    };
  }

  findNext(term: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }): boolean {
    return this.findInternal(term, options, 1);
  }

  findPrevious(term: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }): boolean {
    return this.findInternal(term, options, -1);
  }

  clearSearch(): void {
    this.searchQuery = '';
    this.searchOptionsKey = '';
    this.searchMatches = [];
    this.searchRowIndex = new Map();
    this.searchMatchIndex = -1;
    this.clearActiveSearchSelection();
    this.disposeSearchOverlay();
    this.restoreSearchTheme();
    this.notifySearchResults();
  }

  setSearchResultsCallback(callback: ((results: { resultIndex: number; resultCount: number; matchPositions?: number[] }) => void) | null): void {
    this.searchResultsCallback = callback;
    this.notifySearchResults();
  }

  private notifySearchResults(): void {
    if (!this.searchResultsCallback) return;
    const count = this.searchMatches.length;
    const index = this.searchMatchIndex;
    try {
      this.searchResultsCallback({ resultIndex: index, resultCount: count });
    } catch (error) {
      this.logger.debug('[TerminalCore] Search results callback failed', { error });
    }
  }

  private findInternal(
    rawTerm: string,
    options: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } | undefined,
    dir: 1 | -1
  ): boolean {
    if (!this.terminal || !this.isReady()) return false;

    const term = (rawTerm ?? '').trim();
    const key = JSON.stringify({
      term,
      caseSensitive: Boolean(options?.caseSensitive),
      wholeWord: Boolean(options?.wholeWord),
      regex: Boolean(options?.regex)
    });

    if (!term) {
      this.clearSearch();
      return false;
    }

    const shouldRescan = term !== this.searchQuery || key !== this.searchOptionsKey;
    this.searchQuery = term;
    this.searchOptionsKey = key;

    if (shouldRescan) {
      this.searchMatches = this.scanTerminalMatches(term, options);
      this.searchRowIndex = this.buildSearchRowIndex(this.searchMatches);
      this.searchMatchIndex = this.searchMatches.length > 0 ? (dir === 1 ? 0 : this.searchMatches.length - 1) : -1;
      this.ensureSearchTheme();
      this.ensureSearchOverlaySubscriptions();
      this.scheduleRenderSearchOverlay();
    } else if (this.searchMatches.length > 0) {
      this.searchMatchIndex = dir === 1
        ? (this.searchMatchIndex + 1) % this.searchMatches.length
        : (this.searchMatchIndex - 1 + this.searchMatches.length) % this.searchMatches.length;
    }

    const match = this.searchMatchIndex >= 0 ? this.searchMatches[this.searchMatchIndex] : null;
    if (!match) {
      this.clearActiveSearchSelection();
      this.scheduleRenderSearchOverlay();
      this.notifySearchResults();
      return false;
    }

    this.applySearchMatch(match);
    this.scheduleRenderSearchOverlay();
    this.notifySearchResults();
    return true;
  }

  private scanTerminalMatches(
    term: string,
    options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }
  ): terminal_search_match[] {
    const t = this.terminal;
    if (!t) return [];

    const buffer = t.buffer?.active;
    if (!buffer || typeof buffer.length !== 'number') return [];

    const caseSensitive = Boolean(options?.caseSensitive);
    const query = caseSensitive ? term : term.toLowerCase();
    // 模糊搜索：按空白切分为多个 token（例如 "git status" -> ["git", "status"]）
    const tokens = query.split(/\s+/).filter(Boolean);

    let regex: RegExp | null = null;
    if (options?.regex) {
      try {
        regex = new RegExp(term, caseSensitive ? 'g' : 'gi');
      } catch {
        regex = null;
      }
    }

    const results: terminal_search_match[] = [];
    for (let row = 0; row < buffer.length; row += 1) {
      const line = buffer.getLine(row);
      if (!line) continue;

      const raw = line.translateToString(false);
      if (!raw) continue;

      const text = caseSensitive ? raw : raw.toLowerCase();

      if (regex) {
        regex.lastIndex = 0;
        for (;;) {
          const m = regex.exec(raw);
          if (!m || typeof m.index !== 'number') break;
          const len = Math.max(1, String(m[0] ?? '').length);
          results.push({ row, col: m.index, len });
          if (results.length >= TERMINAL_SEARCH_MAX_RESULTS) break;
          if (len <= 0) break;
          if (regex.lastIndex === m.index) regex.lastIndex += 1;
        }
      } else if (tokens.length <= 1) {
        const needle = query;
        let idx = 0;
        while (idx <= text.length - needle.length) {
          const at = text.indexOf(needle, idx);
          if (at < 0) break;
          if (options?.wholeWord && !this.isWholeWordMatch(text, at, needle.length)) {
            idx = at + Math.max(1, needle.length);
            continue;
          }
          results.push({ row, col: at, len: Math.max(1, needle.length) });
          if (results.length >= TERMINAL_SEARCH_MAX_RESULTS) break;
          idx = at + Math.max(1, needle.length);
        }
      } else {
        // Multi-token fuzzy: tokens must appear in order; highlight the full span.
        let from = 0;
        let start = -1;
        let end = -1;
        let ok = true;
        for (const token of tokens) {
          const at = text.indexOf(token, from);
          if (at < 0) {
            ok = false;
            break;
          }
          if (start < 0) start = at;
          end = at + token.length;
          from = end;
        }
        if (ok && start >= 0 && end > start) {
          const len = end - start;
          if (!options?.wholeWord || this.isWholeWordMatch(text, start, len)) {
            results.push({ row, col: start, len });
          }
        }
      }

      if (results.length >= TERMINAL_SEARCH_MAX_RESULTS) break;
    }

    // Prefer recent output: sort from bottom to top.
    results.sort((a, b) => {
      const dr = b.row - a.row;
      if (dr !== 0) return dr;
      return a.col - b.col;
    });

    return results;
  }

  private buildSearchRowIndex(matches: terminal_search_match[]): Map<number, terminal_search_match[]> {
    const byRow = new Map<number, terminal_search_match[]>();
    for (const m of matches) {
      const list = byRow.get(m.row);
      if (list) list.push(m);
      else byRow.set(m.row, [m]);
    }
    return byRow;
  }

  private isWholeWordMatch(haystack: string, start: number, len: number): boolean {
    const before = start > 0 ? haystack[start - 1] : '';
    const after = start + len < haystack.length ? haystack[start + len] : '';
    const isWordChar = (ch: string) => /[0-9A-Za-z_]/.test(ch);
    if (before && isWordChar(before)) return false;
    if (after && isWordChar(after)) return false;
    return true;
  }

  private applySearchMatch(match: terminal_search_match): void {
    const t: any = this.terminal;
    if (!t) return;

    const scrollbackLen = typeof t.getScrollbackLength === 'function' ? t.getScrollbackLength() : 0;
    const rows = typeof t.rows === 'number' ? t.rows : 24;

    // Center the match line in viewport when possible.
    const desiredTop =
      match.row >= scrollbackLen ? scrollbackLen : Math.max(0, Math.min(scrollbackLen, match.row - Math.floor(rows / 2)));
    const viewportY = Math.max(0, Math.min(scrollbackLen, scrollbackLen - desiredTop));
    if (typeof t.scrollToLine === 'function') t.scrollToLine(viewportY);

    const sm = t?.selectionManager;
    const startCol = Math.max(0, match.col);
    const endCol = Math.max(startCol, startCol + Math.max(1, match.len) - 1);

    if (sm) {
      this.patchSearchSelectionManager(sm);
      sm.__floeterm_searchAllowSingleCellSelection = true;
      sm.markCurrentSelectionDirty?.();
      sm.selectionStart = { col: startCol, absoluteRow: match.row };
      sm.selectionEnd = { col: endCol, absoluteRow: match.row };
      sm.markCurrentSelectionDirty?.();
      sm.selectionChangedEmitter?.fire?.();
      // ghostty-web 不会因为 selection change 自动触发 render；主动刷新以保证 UI（按钮/快捷键）操作立即可见。
      this.forceFullRender();
      return;
    }

    // Fallback: select within viewport row (may fail for scrollback).
    const viewportRow = Math.max(0, Math.min(rows - 1, Math.floor(rows / 2)));
    if (typeof t.select === 'function') {
      t.select(startCol, viewportRow, Math.max(1, match.len));
      // 同上：确保当前匹配的 selection 颜色立即显示。
      this.forceFullRender();
    }
  }

  private clearActiveSearchSelection(): void {
    const t: any = this.terminal;
    const sm = t?.selectionManager;
    if (sm) {
      sm.__floeterm_searchAllowSingleCellSelection = false;
    }
    if (t?.clearSelection) {
      try {
        t.clearSelection();
      } catch {
      }
    }
    // ghostty-web 不会因为 clearSelection 自动触发 render；主动刷新以清除残留高亮。
    this.forceFullRender();
  }

  private patchSearchSelectionManager(sm: any): void {
    if (!sm || sm.__floeterm_searchPatched) return;
    const original = typeof sm.hasSelection === 'function' ? sm.hasSelection.bind(sm) : null;
    if (!original) return;
    sm.__floeterm_searchPatched = true;
    sm.__floeterm_searchAllowSingleCellSelection = false;
    sm.hasSelection = () => {
      // Keep original mouse selection semantics, but allow a single-cell selection for search.
      if (sm.__floeterm_searchAllowSingleCellSelection && sm.selectionStart && sm.selectionEnd) return true;
      return original();
    };
  }

  private ensureSearchTheme(): void {
    if (!this.terminal) return;
    if (this.searchThemeRestore) return;

    const terminalAny: any = this.terminal;
    const rendererTheme = terminalAny?.renderer?.theme;
    const base = rendererTheme && typeof rendererTheme === 'object' ? { ...rendererTheme } : mapThemeToGhostty(this.config.theme);
    this.searchThemeRestore = { ...base };

    const themed = this.applySearchThemeOverride(base);
    this.applyRendererTheme(terminalAny, themed);
  }

  private restoreSearchTheme(): void {
    if (!this.terminal) return;
    if (!this.searchThemeRestore) return;
    const terminalAny: any = this.terminal;
    const restore = this.searchThemeRestore;
    this.searchThemeRestore = null;
    this.applyRendererTheme(terminalAny, restore);
  }

  private applySearchThemeOverride(theme: Record<string, string>): Record<string, string> {
    return {
      ...theme,
      selectionBackground: TERMINAL_SEARCH_ACTIVE_BACKGROUND,
      selectionForeground: TERMINAL_SEARCH_ACTIVE_FOREGROUND,
      selection: TERMINAL_SEARCH_ACTIVE_BACKGROUND
    };
  }

  private applyRendererTheme(
    terminalAny: {
      isOpen?: boolean;
      renderer?: { setTheme?: (theme: Record<string, string>) => void; render?: (...args: unknown[]) => void };
      wasmTerm?: unknown;
      viewportY?: number;
      scrollbarOpacity?: number;
    },
    theme: Record<string, string>
  ): void {
    // ghostty-web emits a warning when mutating options.theme after open().
    // Apply theme directly to the renderer to avoid noisy console output.
    if (!terminalAny.isOpen && this.terminal) {
      this.terminal.options.theme = theme;
    }

    terminalAny.renderer?.setTheme?.(theme);

    if (this.isVisualRenderSuspended()) {
      this.markPendingDemandRender(true);
      return;
    }

    if (terminalAny.renderer?.render && terminalAny.wasmTerm) {
      try {
        terminalAny.renderer.render(
          terminalAny.wasmTerm,
          true,
          terminalAny.viewportY ?? 0,
          terminalAny,
          terminalAny.scrollbarOpacity
        );
      } catch (error) {
        this.logger.debug('[TerminalCore] Theme render failed', { error });
      }
    }
  }

  private captureRenderSnapshot(): terminal_render_snapshot | null {
    const terminalAny = this.terminal as unknown as {
      getScrollbackLength?: () => number;
      rows?: number;
      viewportY?: number;
      wasmTerm?: {
        getCursor?: () => { y?: number };
        getScrollbackLength?: () => number;
      };
    } | null;
    if (!terminalAny) {
      return null;
    }

    const cursor = terminalAny.wasmTerm?.getCursor?.();
    const cursorY = Number(cursor?.y);
    const rows = Number(terminalAny.rows);
    const scrollbackLength = (() => {
      if (typeof terminalAny.getScrollbackLength === 'function') {
        return Number(terminalAny.getScrollbackLength.call(terminalAny));
      }
      if (typeof terminalAny.wasmTerm?.getScrollbackLength === 'function') {
        return Number(terminalAny.wasmTerm.getScrollbackLength.call(terminalAny.wasmTerm));
      }
      return Number.NaN;
    })();
    const viewportY = Number(terminalAny.viewportY ?? 0);

    return {
      cursorY: Number.isFinite(cursorY) ? cursorY : null,
      rows: Number.isFinite(rows) ? rows : null,
      scrollbackLength: Number.isFinite(scrollbackLength) ? scrollbackLength : null,
      viewportY: Number.isFinite(viewportY) ? viewportY : null,
    };
  }

  private shouldForceFullRenderAfterWrite(before: terminal_render_snapshot | null): boolean {
    if (!before) {
      return false;
    }

    const after = this.captureRenderSnapshot();
    if (!after) {
      return false;
    }

    if (
      before.viewportY !== null
      && after.viewportY !== null
      && before.viewportY !== after.viewportY
    ) {
      return true;
    }

    if (
      before.scrollbackLength !== null
      && after.scrollbackLength !== null
      && before.scrollbackLength !== after.scrollbackLength
    ) {
      return true;
    }

    return Boolean(
      before.cursorY !== null
      && after.cursorY !== null
      && before.rows !== null
      && before.cursorY >= before.rows - 1
      && after.cursorY < before.cursorY
    );
  }

  private ensureSearchOverlaySubscriptions(): void {
    const t: any = this.terminal;
    if (!t) return;
    if (this.searchOverlayUnsubs.length > 0) return;

    // Keep overlay synced with scroll/resize.
    const onScroll = typeof t.onScroll === 'function' ? t.onScroll(() => this.scheduleRenderSearchOverlay()) : null;
    if (onScroll?.dispose) this.searchOverlayUnsubs.push(() => onScroll.dispose());
    const onResize = typeof t.onResize === 'function' ? t.onResize(() => this.scheduleRenderSearchOverlay()) : null;
    if (onResize?.dispose) this.searchOverlayUnsubs.push(() => onResize.dispose());
  }

  private disposeSearchOverlaySubscriptions(): void {
    for (const unsub of this.searchOverlayUnsubs) unsub();
    this.searchOverlayUnsubs = [];
  }

  private disposeSearchOverlay(): void {
    if (this.searchOverlayRaf !== null) {
      cancelAnimationFrame(this.searchOverlayRaf);
      this.searchOverlayRaf = null;
    }
    this.disposeSearchOverlaySubscriptions();
    if (this.searchOverlay?.canvas?.parentElement) {
      this.searchOverlay.canvas.parentElement.removeChild(this.searchOverlay.canvas);
    }
    this.searchOverlay = null;
  }

  private ensureSearchOverlay(): terminal_search_overlay | null {
    const t: any = this.terminal;
    if (!t) return null;
    const renderer = t?.renderer;
    const termCanvas = renderer?.getCanvas?.() as HTMLCanvasElement | undefined;
    if (!termCanvas) return null;

    // Ensure we have a positioning context.
    try {
      const style = getComputedStyle(this.container);
      if (style.position === 'static') this.container.style.position = 'relative';
    } catch {
    }

    if (this.searchOverlay && this.searchOverlay.termCanvas !== termCanvas) {
      this.disposeSearchOverlay();
    }

    if (!this.searchOverlay) {
      const overlay = document.createElement('canvas');
      overlay.style.position = 'absolute';
      overlay.style.top = '0';
      overlay.style.left = '0';
      overlay.style.pointerEvents = 'none';
      overlay.style.zIndex = '5';
      const ctx = overlay.getContext('2d');
      if (!ctx) return null;
      this.container.appendChild(overlay);
      this.searchOverlay = {
        canvas: overlay,
        ctx,
        dpr: 1,
        cssWidth: 0,
        cssHeight: 0,
        termCanvas
      };
    }

    const { cssWidth, cssHeight, dpr } = resolveCanvasLocalDisplaySize(termCanvas, this.container);

    if (
      this.searchOverlay.canvas.width !== termCanvas.width ||
      this.searchOverlay.canvas.height !== termCanvas.height ||
      this.searchOverlay.cssWidth !== cssWidth ||
      this.searchOverlay.cssHeight !== cssHeight ||
      this.searchOverlay.dpr !== dpr
    ) {
      this.searchOverlay.dpr = dpr;
      this.searchOverlay.cssWidth = cssWidth;
      this.searchOverlay.cssHeight = cssHeight;
      this.searchOverlay.canvas.style.width = `${cssWidth}px`;
      this.searchOverlay.canvas.style.height = `${cssHeight}px`;
      this.searchOverlay.canvas.width = termCanvas.width;
      this.searchOverlay.canvas.height = termCanvas.height;
      this.searchOverlay.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.searchOverlay.ctx.scale(this.searchOverlay.dpr, this.searchOverlay.dpr);
    }

    return this.searchOverlay;
  }

  private scheduleRenderSearchOverlay(): void {
    if (this.isVisualRenderSuspended()) {
      this.visualRenderState.pendingSearchOverlayRender = true;
      return;
    }

    if (this.searchOverlayRaf !== null) return;
    this.searchOverlayRaf = requestAnimationFrame(() => {
      this.searchOverlayRaf = null;
      this.renderSearchOverlay();
    });
  }

  private renderSearchOverlay(): void {
    const overlay = this.ensureSearchOverlay();
    if (!overlay) return;

    const t: any = this.terminal;
    const queryActive = this.searchQuery.trim().length > 0;
    const rowIndex = this.searchRowIndex;

    if (!queryActive || rowIndex.size === 0 || !t) {
      overlay.ctx.clearRect(0, 0, overlay.cssWidth, overlay.cssHeight);
      return;
    }

    const renderer = t?.renderer;
    const charW = typeof renderer?.charWidth === 'number' ? renderer.charWidth : 0;
    const charH = typeof renderer?.charHeight === 'number' ? renderer.charHeight : 0;
    const cols = typeof t.cols === 'number' ? t.cols : 0;
    const rows = typeof t.rows === 'number' ? t.rows : 0;
    const scrollbackLen = typeof t.getScrollbackLength === 'function' ? t.getScrollbackLength() : 0;
    const viewportY = Math.max(0, Math.floor(typeof t.getViewportY === 'function' ? t.getViewportY() : t.viewportY ?? 0));
    const viewportTop = Math.max(0, scrollbackLen - viewportY);

    if (charW <= 0 || charH <= 0 || cols <= 0 || rows <= 0) {
      overlay.ctx.clearRect(0, 0, overlay.cssWidth, overlay.cssHeight);
      return;
    }

    overlay.ctx.clearRect(0, 0, overlay.cssWidth, overlay.cssHeight);
    overlay.ctx.fillStyle = TERMINAL_SEARCH_MATCH_BACKGROUND;

    for (let y = 0; y < rows; y += 1) {
      const absRow = viewportTop + y;
      const list = rowIndex.get(absRow);
      if (!list || list.length === 0) continue;
      for (const m of list) {
        const col = Math.max(0, Math.min(cols - 1, m.col));
        const maxLen = Math.max(0, cols - col);
        const len = Math.max(0, Math.min(maxLen, m.len));
        if (len <= 0) continue;
        overlay.ctx.fillRect(col * charW, y * charH, len * charW, charH);
      }
    }
  }

  focus(): void {
    this.terminal?.focus();

    if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) {
      this.inputBridge?.focus();
    }
  }

  setConnected(isConnected: boolean): void {
    this.setState(isConnected ? TerminalState.CONNECTED : TerminalState.READY);
  }

  forceResize(): void {
    this.flushPendingPresentationScale();
    this.performResize('force');
    this.forceFullRender();
  }

  setFixedDimensions(dimensions: TerminalDimensions | null): void {
    const next = normalizeTerminalDimensions(dimensions);
    if (sameTerminalDimensions(this.fixedDimensions, next) || (!this.fixedDimensions && !next)) {
      return;
    }

    this.fixedDimensions = next;
    this.config = { ...this.config, fixedDimensions: next };

    if (!this.terminal) {
      return;
    }

    this.forceResize();
  }

  setAppearance(appearance: TerminalAppearance): void {
    if (!appearance || typeof appearance !== 'object') {
      return;
    }

    if (appearance.theme) {
      this.setTheme(appearance.theme);
    }
    if (typeof appearance.fontSize === 'number') {
      this.setFontSize(appearance.fontSize);
    }
    if (typeof appearance.fontFamily === 'string') {
      this.setFontFamily(appearance.fontFamily);
    }
    if (typeof appearance.presentationScale === 'number') {
      this.setPresentationScale(appearance.presentationScale);
    }
  }

  setTheme(theme: Record<string, unknown>): void {
    const mapped = mapThemeToGhostty(theme);
    // Persist latest theme so a future re-initialization can reuse it.
    this.config = { ...this.config, theme: mapped };
    this.themeColorTranslator = buildThemeColorTranslator(this.terminalThemeSource, mapped);

    if (!this.terminal) {
      return;
    }

    const terminalAny = this.terminal as unknown as {
      isOpen?: boolean;
      renderer?: { setTheme?: (theme: Record<string, string>) => void; render?: (...args: unknown[]) => void };
      wasmTerm?: unknown;
      viewportY?: number;
      scrollbarOpacity?: number;
    };

    // If search is active, apply the theme but keep the search selection colors.
    if (this.searchQuery.trim().length > 0) {
      this.searchThemeRestore = { ...mapped };
      this.applyRendererTheme(terminalAny, this.applySearchThemeOverride(mapped));
      this.scheduleRenderSearchOverlay();
      return;
    }

    this.applyRendererTheme(terminalAny, mapped);
  }

  setFontSize(size: number): void {
    this.logicalFontSize = TerminalCore.normalizeFontSize(size);
    this.config = { ...this.config, fontSize: this.logicalFontSize };
    if (!this.terminal) {
      return;
    }
    this.terminal.options.fontSize = this.resolveEffectiveFontSize();
    this.performResize('font');
    void this.refreshFontMetricsAfterLoad('font_size');
  }

  setPresentationScale(scale: number): void {
    const nextScale = TerminalCore.normalizePresentationScale(scale);
    const currentTargetScale = this.pendingPresentationScale ?? this.presentationScale;
    if (samePresentationScale(nextScale, currentTargetScale)) {
      return;
    }

    this.pendingPresentationScale = nextScale;
    this.config = { ...this.config, presentationScale: nextScale };
    this.applyPresentationScaleStyles();

    if (typeof window === 'undefined') {
      this.commitPresentationScale(nextScale);
      return;
    }
    if (this.presentationScaleRaf !== null) {
      return;
    }

    this.presentationScaleRaf = window.requestAnimationFrame(() => {
      this.presentationScaleRaf = null;
      const targetScale = this.pendingPresentationScale ?? this.presentationScale;
      this.pendingPresentationScale = null;
      this.commitPresentationScale(targetScale);
    });
  }

  setFontFamily(family: string): void {
    const nextFamily = String(family ?? '').trim();
    if (!nextFamily) {
      return;
    }

    this.config = { ...this.config, fontFamily: nextFamily };
    if (!this.terminal) {
      return;
    }

    this.terminal.options.fontFamily = nextFamily;
    this.performResize('font');
    this.forceFullRender();
    void this.refreshFontMetricsAfterLoad('font_family');
  }

  beginVisualSuspend(options: TerminalVisualSuspendOptions = {}): TerminalVisualSuspendHandle {
    const id = this.visualRenderState.nextSuspendId;
    this.visualRenderState.nextSuspendId += 1;
    const reason = options.reason ?? 'external';
    let disposed = false;

    this.visualRenderState.suspendDepth += 1;
    this.visualRenderState.activeReasons.set(id, reason);

    return {
      id,
      reason,
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.endVisualSuspend(id);
      },
    };
  }

  registerLinkProvider(provider: TerminalLinkProvider): void {
    if (!provider || this.registeredLinkProviders.has(provider)) {
      return;
    }

    this.registeredLinkProviders.add(provider);
    this.applyRegisteredLinkProviders();
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.focusResizeRaf !== null) {
      cancelAnimationFrame(this.focusResizeRaf);
      this.focusResizeRaf = null;
    }
    if (this.presentationScaleRaf !== null) {
      cancelAnimationFrame(this.presentationScaleRaf);
      this.presentationScaleRaf = null;
    }
    if (this.clearResizeSuppressionRaf !== null) {
      cancelAnimationFrame(this.clearResizeSuppressionRaf);
      this.clearResizeSuppressionRaf = null;
    }
    if (this.resizeRaf !== null) {
      cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = null;
    }
    this.cancelDemandRender();
    this.unbindResponsiveListeners?.();
    this.unbindResponsiveListeners = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
    this.visualRenderState.suspendDepth = 0;
    this.visualRenderState.activeReasons.clear();
    this.visualRenderState.pendingDemandRender = false;
    this.visualRenderState.pendingForceFullRender = false;
    this.visualRenderState.pendingResizeReason = null;
    this.visualRenderState.pendingSearchOverlayRender = false;
    if (this.replayingHistoryTimer) {
      clearTimeout(this.replayingHistoryTimer);
      this.replayingHistoryTimer = null;
    }
    this.disposeInputBridge();
    this.disposeTerminalEventListeners();
    this.disposeSearchOverlay();
    this.terminal?.dispose();
    this.terminal = null;
    this.viewportHost = null;
    this.renderHost = null;
    this.registeredLinkProviders.clear();
    this.appliedLinkProviders.clear();
    this.setState(TerminalState.DISPOSED);
  }

  private disposeInputBridge(): void {
    this.inputBridge?.dispose();
    this.inputBridge = null;
  }

  private disposeTerminalEventListeners(): void {
    for (const dispose of this.terminalEventDisposables) {
      dispose();
    }
    this.terminalEventDisposables = [];
  }

  private trackTerminalEventDisposable(disposable: ghostty_disposable | null | undefined): void {
    if (!disposable?.dispose) {
      return;
    }

    this.terminalEventDisposables.push(() => disposable.dispose?.());
  }

  private applyRegisteredLinkProviders(): void {
    if (!this.terminal || typeof this.terminal.registerLinkProvider !== 'function') {
      return;
    }

    for (const provider of this.registeredLinkProviders) {
      if (this.appliedLinkProviders.has(provider)) {
        continue;
      }

      try {
        this.terminal.registerLinkProvider(provider);
        this.appliedLinkProviders.add(provider);
      } catch (error) {
        this.logger.warn('[TerminalCore] Failed to register link provider', { error });
      }
    }
  }

  private static normalizeResponsiveConfig(value: unknown): Required<TerminalResponsiveConfig> {
    const raw = (typeof value === 'object' && value) ? (value as Partial<TerminalResponsiveConfig>) : {};
    return {
      fitOnFocus: Boolean(raw.fitOnFocus),
      emitResizeOnFocus: Boolean(raw.emitResizeOnFocus),
      notifyResizeOnlyWhenFocused: Boolean(raw.notifyResizeOnlyWhenFocused),
    };
  }

  private static normalizeClipboardConfig(value: unknown): Required<TerminalClipboardConfig> {
    const raw = (typeof value === 'object' && value) ? (value as Partial<TerminalClipboardConfig>) : {};
    return {
      copyOnSelect: raw.copyOnSelect !== false,
    };
  }

  private static normalizeFitConfig(value: unknown): Required<TerminalFitConfig> {
    const raw = (typeof value === 'object' && value) ? (value as Partial<TerminalFitConfig>) : {};
    return {
      scrollbarReservePx: normalizeNonNegativePixels(raw.scrollbarReservePx, GHOSTTY_DEFAULT_SCROLLBAR_RESERVE_PX),
    };
  }

  private static normalizeFontSize(value: unknown): number {
    const size = Number(value);
    if (!Number.isFinite(size) || size <= 0) {
      return 12;
    }
    return size;
  }

  private static normalizePresentationScale(value: unknown): number {
    const scale = Number(value);
    if (!Number.isFinite(scale) || scale <= 1.001) {
      return 1;
    }
    return Math.min(scale, 4);
  }

  private resolveEffectiveFontSize(scale = this.pendingPresentationScale ?? this.presentationScale): number {
    return Math.max(1, this.logicalFontSize * scale);
  }

  private isVisualRenderSuspended(): boolean {
    return this.visualRenderState.suspendDepth > 0;
  }

  private markPendingDemandRender(forceAll: boolean): void {
    this.visualRenderState.pendingDemandRender = true;
    this.visualRenderState.pendingForceFullRender = this.visualRenderState.pendingForceFullRender || forceAll;
    this.demandRenderForceAll = this.demandRenderForceAll || forceAll;
  }

  private markPendingResize(reason: terminal_resize_reason): void {
    this.visualRenderState.pendingResizeReason = this.mergePendingResizeReason(
      this.visualRenderState.pendingResizeReason,
      reason,
    );
  }

  private mergePendingResizeReason(
    current: terminal_resize_reason | null,
    next: terminal_resize_reason,
  ): terminal_resize_reason {
    if (!current) {
      return next;
    }
    if (current === 'force' || next === 'force') {
      return 'force';
    }
    if (current === 'font' || next === 'font') {
      return 'font';
    }
    if (current === 'focus' || next === 'focus') {
      return 'focus';
    }
    if (current === 'post_init' || next === 'post_init') {
      return 'post_init';
    }
    return 'observer';
  }

  private endVisualSuspend(id: number): void {
    if (!this.visualRenderState.activeReasons.has(id)) {
      return;
    }

    this.visualRenderState.activeReasons.delete(id);
    this.visualRenderState.suspendDepth = Math.max(0, this.visualRenderState.suspendDepth - 1);
    if (this.visualRenderState.suspendDepth > 0) {
      return;
    }

    this.flushDeferredVisualWork();
  }

  private flushDeferredVisualWork(): void {
    if (this.isDisposed || !this.terminal) {
      return;
    }

    const resizeReason = this.visualRenderState.pendingResizeReason;
    const shouldRender = this.visualRenderState.pendingDemandRender || this.demandRenderForceAll;
    const shouldForceRender = this.visualRenderState.pendingForceFullRender || this.demandRenderForceAll;
    const shouldRenderSearchOverlay = this.visualRenderState.pendingSearchOverlayRender;

    this.visualRenderState.pendingResizeReason = null;
    this.visualRenderState.pendingDemandRender = false;
    this.visualRenderState.pendingForceFullRender = false;
    this.visualRenderState.pendingSearchOverlayRender = false;
    this.demandRenderForceAll = false;

    if (resizeReason) {
      this.performResizeNow(resizeReason);
    }
    if (shouldRender) {
      this.requestDemandRender(shouldForceRender);
    }
    if (shouldRenderSearchOverlay) {
      this.scheduleRenderSearchOverlay();
    }
  }

  private flushPendingPresentationScale(): void {
    if (this.pendingPresentationScale === null) {
      return;
    }
    const targetScale = this.pendingPresentationScale;
    this.pendingPresentationScale = null;
    if (this.presentationScaleRaf !== null) {
      cancelAnimationFrame(this.presentationScaleRaf);
      this.presentationScaleRaf = null;
    }
    this.commitPresentationScale(targetScale);
  }

  private commitPresentationScale(scale: number): void {
    const nextScale = TerminalCore.normalizePresentationScale(scale);
    if (samePresentationScale(nextScale, this.presentationScale)) {
      this.applyPresentationScaleStyles();
      return;
    }

    this.presentationScale = nextScale;
    this.applyPresentationScaleStyles();
    if (!this.terminal) {
      return;
    }

    this.suppressResizeNotifications = true;
    if (this.clearResizeSuppressionRaf !== null) {
      cancelAnimationFrame(this.clearResizeSuppressionRaf);
    }
    this.clearResizeSuppressionRaf = requestAnimationFrame(() => {
      this.clearResizeSuppressionRaf = null;
      this.suppressResizeNotifications = false;
    });

    this.terminal.options.fontSize = this.resolveEffectiveFontSize(nextScale);
    if (this.isVisualRenderSuspended()) {
      this.markPendingResize('force');
      this.markPendingDemandRender(true);
      this.scheduleRenderSearchOverlay();
      return;
    }

    this.fitAddon?.fit();
    this.forceFullRender();
    this.scheduleRenderSearchOverlay();
  }

  private forceFullRender(): void {
    if (!this.terminal || !this.isReady()) {
      return;
    }

    if (this.isVisualRenderSuspended()) {
      this.markPendingDemandRender(true);
      return;
    }

    this.renderDemandFrame(true);
  }

  private requestDemandRender(forceAll: boolean): void {
    if (!this.terminal || this.isDisposed) {
      return;
    }

    if (this.isVisualRenderSuspended()) {
      this.markPendingDemandRender(forceAll);
      return;
    }

    this.demandRenderForceAll = this.demandRenderForceAll || forceAll;
    if (this.demandRenderRaf !== null) {
      return;
    }

    this.demandRenderRaf = requestAnimationFrame(() => {
      this.demandRenderRaf = null;
      const shouldForce = this.demandRenderForceAll;
      this.demandRenderForceAll = false;
      this.renderDemandFrame(shouldForce);
    });
  }

  private cancelDemandRender(): void {
    if (this.demandRenderRaf !== null) {
      cancelAnimationFrame(this.demandRenderRaf);
      this.demandRenderRaf = null;
    }
    this.demandRenderForceAll = false;
    this.stopGhosttyRenderLoop();
  }

  private stopGhosttyRenderLoop(): void {
    const terminalAny = this.terminal as unknown as { animationFrameId?: number } | null;
    if (!terminalAny || typeof terminalAny.animationFrameId !== 'number') {
      return;
    }

    cancelAnimationFrame(terminalAny.animationFrameId);
    terminalAny.animationFrameId = undefined;
  }

  private renderDemandFrame(forceAll: boolean): void {
    if (!this.terminal || this.isDisposed) {
      return;
    }

    const terminalAny = this.terminal as unknown as {
      isDisposed?: boolean;
      isOpen?: boolean;
      renderer?: ghostty_renderer_with_row_cache;
      wasmTerm?: {
        getCursor?: () => { y?: number };
      };
      viewportY?: number;
      scrollbarOpacity?: number;
      lastCursorY?: number;
      cursorMoveEmitter?: { fire?: () => void };
    };

    if (terminalAny.isDisposed || terminalAny.isOpen === false || !terminalAny.renderer?.render || !terminalAny.wasmTerm) {
      return;
    }

    try {
      const startedAt = performance.now();
      this.keepDemandCursorVisible(terminalAny.renderer);
      terminalAny.renderer.render(
        terminalAny.wasmTerm,
        forceAll,
        terminalAny.viewportY ?? 0,
        terminalAny,
        terminalAny.scrollbarOpacity
      );
      const cursor = terminalAny.wasmTerm.getCursor?.();
      if (cursor && typeof cursor.y === 'number' && cursor.y !== terminalAny.lastCursorY) {
        terminalAny.lastCursorY = cursor.y;
        terminalAny.cursorMoveEmitter?.fire?.();
      }
      getPerfProbe()?.onTerminalRender?.(performance.now() - startedAt);
    } catch (error) {
      this.logger.debug('[TerminalCore] Force render failed', { error });
    }
  }
}
