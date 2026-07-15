import type {
  TerminalFabricCell,
  TerminalFabricCursor,
  TerminalFabricDiagnostics,
  TerminalFabricFrame,
  TerminalFabricFrameRenderResult,
  TerminalFabricGeometry,
  TerminalFabricRenderer,
  TerminalFabricRendererTarget,
  TerminalFabricTheme,
} from './types.js';
import { terminalFabricCoordinator } from './TerminalFabricCoordinator.js';
import {
  loadBeamtermModule,
  type BeamtermModule,
} from '../internal/BeamtermResourceLoader.js';

export { loadBeamtermModule } from '../internal/BeamtermResourceLoader.js';
export type { BeamtermModule } from '../internal/BeamtermResourceLoader.js';
export type BeamtermRendererInstance = InstanceType<BeamtermModule['BeamtermRenderer']>;
type BeamtermCellStyle = InstanceType<BeamtermModule['CellStyle']>;
type BeamtermCell = InstanceType<BeamtermModule['Cell']>;

const DEFAULT_BACKGROUND = 0x000000;
const DEFAULT_FOREGROUND = 0xffffff;
const MAX_STYLE_CACHE_ENTRIES = 4096;

export const parseHexColor = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const trimmed = value.trim();
  const shortHex = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortHex) {
    const [r, g, b] = shortHex[1].split('');
    return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  const longHex = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (longHex) {
    return Number.parseInt(longHex[1], 16);
  }
  return fallback;
};

export const formatHexColor = (value: number): string => {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.min(0xffffff, Math.trunc(value))) : 0;
  return `#${normalized.toString(16).padStart(6, '0')}`;
};

export const normalizeCanvasSelector = (canvas: HTMLCanvasElement): string => {
  if (!canvas.id) {
    canvas.id = `floeterm-beamterm-${Math.random().toString(36).slice(2)}`;
  }
  return `#${escapeCssIdentifier(canvas.id)}`;
};

const escapeCssIdentifier = (value: string): string => {
  const cssGlobal = globalThis as typeof globalThis & {
    CSS?: { escape?: (raw: string) => string };
  };
  if (typeof cssGlobal.CSS?.escape === 'function') {
    return cssGlobal.CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, match => `\\${match}`);
};

export const createStyle = (
  module: BeamtermModule,
  cell: TerminalFabricCell,
  defaultTheme: TerminalFabricTheme,
  cache?: Map<string, BeamtermCellStyle>,
): BeamtermCellStyle => {
  const fg = cell.attrs.inverse
    ? defaultTheme.background
    : (cell.fg.r << 16) | (cell.fg.g << 8) | cell.fg.b;
  const bg = cell.attrs.inverse
    ? defaultTheme.foreground
    : (cell.bg.r << 16) | (cell.bg.g << 8) | cell.bg.b;
  const key = cache ? styleCacheKey(fg, bg, cell.attrs) : '';
  const existing = key ? cache?.get(key) : undefined;
  if (existing) {
    return existing;
  }

  let style = module.style().fg(fg).bg(bg);
  if (cell.attrs.bold) {
    style = style.bold();
  }
  if (cell.attrs.italic) {
    style = style.italic();
  }
  if (cell.attrs.underline) {
    style = style.underline();
  }
  if (cell.attrs.strikethrough) {
    style = style.strikethrough();
  }

  if (cache && key) {
    if (cache.size >= MAX_STYLE_CACHE_ENTRIES) {
      cache.clear();
    }
    cache.set(key, style);
  }
  return style;
};

export const hasWebGL2 = (): boolean => {
  if (typeof document === 'undefined') {
    return false;
  }
  const canvas = document.createElement('canvas');
  try {
    return Boolean(canvas.getContext('webgl2'));
  } catch {
    return false;
  }
};

export const createBeamtermRenderer = (
  module: BeamtermModule,
  selector: string,
  fontFamilies: string[],
  fontSize: number,
): BeamtermRendererInstance => module.BeamtermRenderer.withDynamicAtlas(
  selector,
  fontFamilies,
  fontSize,
  false,
);

export const createCell = (
  module: BeamtermModule,
  symbol: string,
  style: BeamtermCellStyle,
): BeamtermCell => new module.Cell(symbol, style);

export class BeamtermFabricRenderer implements TerminalFabricRenderer {
  readonly backend = 'beamterm_webgl2' as const;
  readonly renderPath = 'main_thread_webgl2' as const;

  private module: BeamtermModule | null = null;
  private renderer: BeamtermRendererInstance | null = null;
  private target: TerminalFabricRendererTarget | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private visible = true;
  private initialized = false;
  private fontFamilies: string[] = ['monospace'];
  private fontSize = 12;
  private currentTheme: TerminalFabricTheme = {
    background: DEFAULT_BACKGROUND,
    foreground: DEFAULT_FOREGROUND,
  };
  private readonly styleCache = new Map<string, BeamtermCellStyle>();
  private lastRenderedRows = 0;
  private lastDirtyCells = 0;
  private geometry: TerminalFabricGeometry | null = null;
  private surfaceBackgroundCss: string | null = null;
  private hostInlineBackgroundColor: string | null = null;

  async initialize(target: TerminalFabricRendererTarget): Promise<void> {
    this.target = target;
    this.currentTheme = {
      background: parseHexColor(target.theme.background, DEFAULT_BACKGROUND),
      foreground: parseHexColor(target.theme.foreground, DEFAULT_FOREGROUND),
    };
    let canvas: HTMLCanvasElement | null = null;
    let ghosttyCanvas: HTMLCanvasElement | null = null;
    try {
      const webgl2Supported = hasWebGL2();
      terminalFabricCoordinator.setRendererState({
        webgl2Supported,
        backend: webgl2Supported ? 'beamterm_webgl2' : 'main_thread_canvas_live',
        renderPath: webgl2Supported ? 'main_thread_webgl2' : 'canvas_live_fallback',
      });
      if (!webgl2Supported) {
        throw new Error('WebGL2 is not available for Beamterm');
      }

      this.module = await loadBeamtermModule();
      terminalFabricCoordinator.setRendererState({ beamtermLoaded: true });

      canvas = document.createElement('canvas');
      canvas.className = 'floeterm-beamterm-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.pointerEvents = 'none';
      canvas.style.zIndex = '2';

      ghosttyCanvas = target.getGhosttyCanvas();
      if (ghosttyCanvas) {
        ghosttyCanvas.style.opacity = '0';
      }

      const host = target.container;
      const computed = getComputedStyle(host);
      if (computed.position === 'static') {
        host.style.position = 'relative';
      }
      this.hostInlineBackgroundColor = host.style.backgroundColor;
      host.appendChild(canvas);

      this.canvas = canvas;
      this.syncBackgroundSurface();
      const selector = normalizeCanvasSelector(canvas);
      this.fontFamilies = normalizeFontFamilies(target.fontFamily);
      this.fontSize = target.fontSize;
      this.renderer = createBeamtermRenderer(this.module, selector, this.fontFamilies, this.fontSize);
      this.installEventForwarding(canvas);
      this.resize(host.clientWidth, host.clientHeight);
      this.initialized = true;
      terminalFabricCoordinator.incrementRendererCounts({ active: 1, visible: 1 });
      terminalFabricCoordinator.setRendererState({
        backend: 'beamterm_webgl2',
        renderPath: 'main_thread_webgl2',
        lastError: '',
      });
    } catch (error) {
      this.renderer?.free();
      this.renderer = null;
      this.module = null;
      this.canvas = null;
      canvas?.remove();
      this.restoreBackgroundSurface();
      if (ghosttyCanvas) {
        ghosttyCanvas.style.opacity = '';
      }
      throw error;
    }
  }

  isActive(): boolean {
    return this.initialized && Boolean(this.renderer && this.module);
  }

  startFrame(
    frame: TerminalFabricFrame,
    options: { cols: number; rows: number; theme: TerminalFabricTheme },
  ): void {
    void frame;
    if (!this.renderer || !this.visible) {
      return;
    }
    this.currentTheme = options.theme;
    this.syncBackgroundSurface();
    this.lastRenderedRows = 0;
    this.lastDirtyCells = 0;
    if (frame.forceAll) {
      const batch = this.renderer.batch();
      batch.clear(options.theme.background);
    }
  }

  writeRow(row: number, cells: TerminalFabricCell[], cols: number): void {
    if (!this.renderer || !this.module || !this.visible) {
      return;
    }
    const batch = this.renderer.batch();
    for (let col = 0; col < cols; col += 1) {
      const current = cells[col];
      if (!current) {
        continue;
      }
      const style = createStyle(this.module, current, this.currentTheme, this.styleCache);
      const text = current.attrs.invisible ? ' ' : current.symbol || ' ';
      batch.cell(col, row, createCell(this.module, text, style));
      this.lastDirtyCells += 1;
    }
    this.lastRenderedRows += 1;
  }

  finishFrame(cursor: TerminalFabricCursor | null): TerminalFabricFrameRenderResult {
    if (!this.renderer || !this.visible) {
      return {
        rendered: false,
        renderedRows: 0,
        dirtyCells: 0,
      };
    }
    if (cursor?.visible && this.module) {
      const batch = this.renderer.batch();
      batch.cell(
        Math.max(0, cursor.x),
        Math.max(0, cursor.y),
        createCell(this.module, ' ', this.module.style().fg(this.currentTheme.background).bg(this.currentTheme.foreground)),
      );
    }
    this.renderer.render();
    return {
      rendered: true,
      renderedRows: this.lastRenderedRows,
      dirtyCells: this.lastDirtyCells,
    };
  }

  resize(width: number, height: number): void {
    if (!this.renderer || !this.canvas) {
      return;
    }
    const cssWidth = Math.max(1, Math.floor(width));
    const cssHeight = Math.max(1, Math.floor(height));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.renderer.resize(cssWidth, cssHeight);
    this.geometry = readBeamtermGeometry(this.renderer, this.canvas, cssWidth, cssHeight);
  }

  getGeometry(): TerminalFabricGeometry | null {
    return this.geometry ? { ...this.geometry } : null;
  }

  setAppearance(appearance: { fontFamily?: string; fontSize?: number; theme?: Record<string, string> }): void {
    if (appearance.theme) {
      this.currentTheme = {
        background: parseHexColor(appearance.theme.background, this.currentTheme.background),
        foreground: parseHexColor(appearance.theme.foreground, this.currentTheme.foreground),
      };
      this.syncBackgroundSurface();
      this.styleCache.clear();
    }
    if (!this.renderer || (!appearance.fontFamily && typeof appearance.fontSize !== 'number')) {
      return;
    }
    const family = appearance.fontFamily ? normalizeFontFamilies(appearance.fontFamily) : this.fontFamilies;
    const size = typeof appearance.fontSize === 'number' ? appearance.fontSize : this.fontSize;
    try {
      this.fontFamilies = family;
      this.fontSize = size;
      this.styleCache.clear();
      this.renderer.replaceWithDynamicAtlas(family, size);
      if (this.geometry) {
        this.resize(this.geometry.width, this.geometry.height);
      }
    } catch (error) {
      this.target?.logger.warn('[BeamtermFabricRenderer] Dynamic atlas replacement failed', { error });
    }
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) {
      return;
    }
    this.visible = visible;
    if (this.canvas) {
      this.canvas.style.display = visible ? 'block' : 'none';
    }
    terminalFabricCoordinator.incrementRendererCounts({
      visible: visible ? 1 : -1,
      offscreen: visible ? -1 : 1,
    });
  }

  loseContextForTest(): void {
    const gl = this.canvas?.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    extension?.loseContext();
  }

  getDiagnostics(): TerminalFabricDiagnostics {
    return terminalFabricCoordinator.getDiagnostics();
  }

  dispose(): void {
    if (!this.initialized && !this.renderer && !this.canvas) {
      return;
    }
    this.renderer?.free();
    this.renderer = null;
    this.module = null;
    this.initialized = false;
    this.geometry = null;
    const wasVisible = this.visible;
    this.visible = false;
    this.styleCache.clear();
    this.canvas?.remove();
    this.canvas = null;
    const ghosttyCanvas = this.target?.getGhosttyCanvas();
    if (ghosttyCanvas) {
      ghosttyCanvas.style.opacity = '';
    }
    this.restoreBackgroundSurface();
    terminalFabricCoordinator.incrementRendererCounts({
      active: -1,
      visible: wasVisible ? -1 : 0,
      offscreen: wasVisible ? 0 : -1,
    });
  }

  private syncBackgroundSurface(): void {
    const nextBackground = formatHexColor(this.currentTheme.background);
    if (this.surfaceBackgroundCss === nextBackground) {
      return;
    }

    this.surfaceBackgroundCss = nextBackground;
    if (this.canvas) {
      this.canvas.style.backgroundColor = nextBackground;
    }
    if (this.target?.container) {
      this.target.container.style.backgroundColor = nextBackground;
    }
  }

  private restoreBackgroundSurface(): void {
    if (this.target?.container && this.hostInlineBackgroundColor !== null) {
      this.target.container.style.backgroundColor = this.hostInlineBackgroundColor;
    }
    this.hostInlineBackgroundColor = null;
    this.surfaceBackgroundCss = null;
  }

  private installEventForwarding(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      terminalFabricCoordinator.noteFallback('Beamterm WebGL2 context lost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      terminalFabricCoordinator.noteContextRestore();
    });
  }
}

export const sameRenderableStyle = (left: TerminalFabricCell, right: TerminalFabricCell): boolean => (
  left.fg.r === right.fg.r
  && left.fg.g === right.fg.g
  && left.fg.b === right.fg.b
  && left.bg.r === right.bg.r
  && left.bg.g === right.bg.g
  && left.bg.b === right.bg.b
  && Boolean(left.attrs.bold) === Boolean(right.attrs.bold)
  && Boolean(left.attrs.italic) === Boolean(right.attrs.italic)
  && Boolean(left.attrs.underline) === Boolean(right.attrs.underline)
  && Boolean(left.attrs.strikethrough) === Boolean(right.attrs.strikethrough)
  && Boolean(left.attrs.inverse) === Boolean(right.attrs.inverse)
  && Boolean(left.attrs.invisible) === Boolean(right.attrs.invisible)
  && Boolean(left.attrs.faint) === Boolean(right.attrs.faint)
);

const readBeamtermGeometry = (
  renderer: BeamtermRendererInstance,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): TerminalFabricGeometry | null => {
  const cellSize = renderer.cellSize();
  const terminalSize = renderer.terminalSize();
  try {
    const cellWidth = Number(cellSize.width);
    const cellHeight = Number(cellSize.height);
    const cols = Math.floor(Number(terminalSize.cols));
    const rows = Math.floor(Number(terminalSize.rows));
    if (
      !Number.isFinite(cellWidth)
      || !Number.isFinite(cellHeight)
      || !Number.isFinite(cols)
      || !Number.isFinite(rows)
      || cellWidth <= 0
      || cellHeight <= 0
      || cols <= 0
      || rows <= 0
    ) {
      return null;
    }
    const scaleX = resolveBeamtermCellScale(cellWidth, cols, canvas.width, width);
    const scaleY = resolveBeamtermCellScale(cellHeight, rows, canvas.height, height);
    const cssCellWidth = cellWidth / scaleX;
    const cssCellHeight = cellHeight / scaleY;
    return {
      width,
      height,
      cellWidth: cssCellWidth,
      cellHeight: cssCellHeight,
      cols,
      rows,
    };
  } finally {
    cellSize.free();
    terminalSize.free();
  }
};

const resolveBeamtermCellScale = (
  cellSize: number,
  cellCount: number,
  backingExtent: number,
  cssExtent: number,
): number => {
  const backingScale = resolveCanvasBackingScale(backingExtent, cssExtent);
  if (backingScale <= 1) {
    return 1;
  }

  const gridExtent = cellSize * cellCount;
  const cssError = relativeExtentError(gridExtent, cssExtent);
  const backingError = relativeExtentError(gridExtent, backingExtent);
  return backingError < cssError ? backingScale : 1;
};

const relativeExtentError = (actual: number, expected: number): number => {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(actual - expected) / expected;
};

const resolveCanvasBackingScale = (backingSize: number, cssSize: number): number => {
  const scale = Number(backingSize) / Number(cssSize);
  if (Number.isFinite(scale) && scale > 0) {
    return scale;
  }

  const dpr = typeof window !== 'undefined' ? Number(window.devicePixelRatio) : 1;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
};

export const normalizeFontFamilies = (fontFamily: string): string[] => {
  const families = fontFamily
    .split(',')
    .map(part => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  return families.length > 0 ? families : ['monospace'];
};

const styleCacheKey = (
  fg: number,
  bg: number,
  attrs: TerminalFabricCell['attrs'],
): string => [
  fg,
  bg,
  attrs.bold ? 1 : 0,
  attrs.italic ? 1 : 0,
  attrs.underline ? 1 : 0,
  attrs.strikethrough ? 1 : 0,
  attrs.inverse ? 1 : 0,
  attrs.invisible ? 1 : 0,
  attrs.faint ? 1 : 0,
].join(':');
