import type {
  TerminalFabricCell,
  TerminalFabricCursor,
  TerminalFabricDiagnostics,
  TerminalFabricFrame,
  TerminalFabricFrameRenderResult,
  TerminalFabricGeometry,
  TerminalFabricRenderer,
  TerminalFabricRendererTarget,
  TerminalFabricRowRenderHints,
  TerminalFabricSourceCell,
  TerminalFabricSourceRenderer,
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
type BeamtermBatch = ReturnType<BeamtermRendererInstance['batch']>;

type SourceGridCoverage = {
  cols: number;
  rows: number;
};

type ResolvedFabricCell = {
  symbol: string;
  width: number;
  styleKey: string;
  style: BeamtermCellStyle | null;
  simple: boolean;
  blank: boolean;
};

const createResolvedFabricCell = (): ResolvedFabricCell => ({
  symbol: ' ',
  width: 1,
  styleKey: '',
  style: null,
  simple: true,
  blank: true,
});

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
  canvas: HTMLCanvasElement,
  fontFamilies: string[],
  fontSize: number,
): BeamtermRendererInstance => module.BeamtermRenderer.withDynamicAtlasCanvas(
  canvas,
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
  private frameBatch: BeamtermBatch | null = null;
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
  private sourceGridCoverage: SourceGridCoverage | null = null;
  private surfaceCoverageKey = '';
  private pendingFullClearCoverage: SourceGridCoverage | null = null;
  private readonly resolvedCell = createResolvedFabricCell();
  private readonly resolvedLookahead = createResolvedFabricCell();

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
        backend: 'beamterm_webgl2',
        renderPath: 'main_thread_webgl2',
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
      this.fontFamilies = normalizeFontFamilies(target.fontFamily);
      this.fontSize = target.fontSize;
      this.renderer = createBeamtermRenderer(this.module, canvas, this.fontFamilies, this.fontSize);
      this.renderer.setCanvasPaddingColor(this.currentTheme.background);
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
      terminalFabricCoordinator.noteRendererError(error);
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
    if (options.theme.background !== this.currentTheme.background) {
      this.renderer.setCanvasPaddingColor(options.theme.background);
    }
    this.currentTheme = options.theme;
    this.syncBackgroundSurface();
    this.lastRenderedRows = 0;
    this.lastDirtyCells = 0;
    this.frameBatch?.free();
    this.frameBatch = this.renderer.batch();
    if (frame.forceAll) {
      this.pendingFullClearCoverage = { cols: options.cols, rows: options.rows };
    } else {
      this.pendingFullClearCoverage = null;
      this.paintOutsideSourceGrid(this.frameBatch, options.cols, options.rows, options.theme.background);
    }
  }

  writeRow(
    sourceRenderer: TerminalFabricSourceRenderer,
    row: number,
    cells: readonly TerminalFabricSourceCell[],
    cols: number,
    hints: TerminalFabricRowRenderHints = {},
  ): void {
    const batch = this.frameBatch;
    if (!batch || !this.module || !this.visible) {
      return;
    }
    if (this.pendingFullClearCoverage) {
      const coverage = this.pendingFullClearCoverage;
      this.pendingFullClearCoverage = null;
      batch.clear(this.currentTheme.background);
      this.recordSurfaceCoverage(coverage.cols, coverage.rows, this.currentTheme.background);
    }

    let col = 0;
    while (col < cols) {
      resolveSourceCell(
        this.module,
        sourceRenderer,
        cells[col] ?? {},
        row,
        col,
        hints,
        this.currentTheme,
        this.styleCache,
        this.resolvedCell,
      );
      const current = this.resolvedCell;
      if (!current.style) {
        col += 1;
        continue;
      }

      if (!current.simple) {
        batch.cell(col, row, createCell(this.module, current.symbol, current.style));
        const renderedWidth = Math.max(1, Math.min(cols - col, Math.floor(current.width)));
        this.lastDirtyCells += renderedWidth;
        col += renderedWidth;
        continue;
      }

      const runStart = col;
      const runStyleKey = current.styleKey;
      const runStyle = current.style;
      const blankRun = current.blank;
      let text = blankRun ? '' : current.symbol;
      col += 1;
      while (col < cols) {
        resolveSourceCell(
          this.module,
          sourceRenderer,
          cells[col] ?? {},
          row,
          col,
          hints,
          this.currentTheme,
          this.styleCache,
          this.resolvedLookahead,
        );
        const next = this.resolvedLookahead;
        if (!next.simple || next.blank !== blankRun || next.styleKey !== runStyleKey) break;
        if (!blankRun) text += next.symbol;
        col += 1;
      }
      const runLength = col - runStart;
      if (blankRun) {
        batch.fill(runStart, row, runLength, 1, createCell(this.module, ' ', runStyle));
      } else {
        batch.text(runStart, row, text, runStyle);
      }
      this.lastDirtyCells += runLength;
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
    const batch = this.frameBatch;
    if (cursor?.visible && this.module && batch) {
      batch.cell(
        Math.max(0, cursor.x),
        Math.max(0, cursor.y),
        createCell(this.module, ' ', this.module.style().fg(this.currentTheme.background).bg(this.currentTheme.foreground)),
      );
    }
    try {
      this.renderer.render();
      return {
        rendered: true,
        renderedRows: this.lastRenderedRows,
        dirtyCells: this.lastDirtyCells,
      };
    } finally {
      batch?.free();
      this.frameBatch = null;
      this.pendingFullClearCoverage = null;
    }
  }

  finishSubmittedFrame(): void {
    const gl = this.canvas?.getContext('webgl2');
    if (!this.renderer || !this.visible || !gl) {
      throw new Error('Cannot finish a Beamterm frame without an active WebGL2 renderer');
    }
    gl.finish();
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
    this.surfaceCoverageKey = '';
    if (this.sourceGridCoverage && this.module) {
      const batch = this.renderer.batch();
      try {
        this.paintOutsideSourceGrid(
          batch,
          this.sourceGridCoverage.cols,
          this.sourceGridCoverage.rows,
          this.currentTheme.background,
        );
      } finally {
        batch.free();
      }
    }
    this.renderer.render();
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
      this.renderer?.setCanvasPaddingColor(this.currentTheme.background);
      this.styleCache.clear();
    }
    if (!this.renderer || (!appearance.fontFamily && typeof appearance.fontSize !== 'number')) {
      return;
    }
    const family = appearance.fontFamily ? normalizeFontFamilies(appearance.fontFamily) : this.fontFamilies;
    const size = typeof appearance.fontSize === 'number' ? appearance.fontSize : this.fontSize;
    const familyChanged = family.length !== this.fontFamilies.length
      || family.some((value, index) => value !== this.fontFamilies[index]);
    if (!familyChanged && size === this.fontSize) {
      return;
    }
    try {
      this.renderer.replaceWithDynamicAtlas(family, size);
      this.fontFamilies = family;
      this.fontSize = size;
      this.styleCache.clear();
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
    this.frameBatch?.free();
    this.frameBatch = null;
    this.renderer?.free();
    this.renderer = null;
    this.module = null;
    this.initialized = false;
    this.geometry = null;
    this.sourceGridCoverage = null;
    this.surfaceCoverageKey = '';
    this.pendingFullClearCoverage = null;
    const wasVisible = this.visible;
    this.visible = false;
    this.styleCache.clear();
    this.canvas?.remove();
    this.canvas = null;
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

  private paintOutsideSourceGrid(
    batch: BeamtermBatch,
    sourceCols: number,
    sourceRows: number,
    background: number,
  ): void {
    if (!this.renderer || !this.module) {
      return;
    }

    const terminalSize = this.renderer.terminalSize();
    const rendererCols = Math.max(0, Math.floor(terminalSize.cols));
    const rendererRows = Math.max(0, Math.floor(terminalSize.rows));
    terminalSize.free();
    const cols = Math.max(0, Math.min(rendererCols, Math.floor(sourceCols)));
    const rows = Math.max(0, Math.min(rendererRows, Math.floor(sourceRows)));
    const coverageKey = `${rendererCols}:${rendererRows}:${cols}:${rows}:${background}`;
    this.sourceGridCoverage = { cols, rows };
    if (coverageKey === this.surfaceCoverageKey) {
      return;
    }
    this.surfaceCoverageKey = coverageKey;

    const backgroundCell = createCell(
      this.module,
      ' ',
      this.module.style().fg(background).bg(background),
    );
    if (cols < rendererCols && rows > 0) {
      batch.fill(cols, 0, rendererCols - cols, rows, backgroundCell);
    }
    if (rows < rendererRows) {
      batch.fill(0, rows, rendererCols, rendererRows - rows, backgroundCell);
    }
  }

  private recordSurfaceCoverage(sourceCols: number, sourceRows: number, background: number): void {
    if (!this.renderer) {
      return;
    }
    const terminalSize = this.renderer.terminalSize();
    const rendererCols = Math.max(0, Math.floor(terminalSize.cols));
    const rendererRows = Math.max(0, Math.floor(terminalSize.rows));
    terminalSize.free();
    const cols = Math.max(0, Math.min(rendererCols, Math.floor(sourceCols)));
    const rows = Math.max(0, Math.min(rendererRows, Math.floor(sourceRows)));
    this.sourceGridCoverage = { cols, rows };
    this.surfaceCoverageKey = `${rendererCols}:${rendererRows}:${cols}:${rows}:${background}`;
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
      const error = new Error('Beamterm WebGL2 context lost');
      terminalFabricCoordinator.noteRendererError(error);
      this.target?.onRendererError(error);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      terminalFabricCoordinator.noteContextRestore();
    });
  }
}

const resolveSourceCell = (
  module: BeamtermModule,
  sourceRenderer: TerminalFabricSourceRenderer,
  cell: TerminalFabricSourceCell,
  row: number,
  col: number,
  hints: TerminalFabricRowRenderHints,
  theme: TerminalFabricTheme,
  cache: Map<string, BeamtermCellStyle>,
  target: ResolvedFabricCell,
): void => {
  const flags = Number(cell.flags ?? 0);
  const selected = isCellInSelection(row, col, hints.selection);
  const hovered = isCellHovered(row, col, cell, hints.hover);
  const inverse = !selected && (flags & 16) !== 0;
  const foreground = inverse
    ? theme.background
    : selected
      ? packColor(hints.selection!.foreground.r, hints.selection!.foreground.g, hints.selection!.foreground.b, theme.foreground)
      : packColor(cell.fg_r, cell.fg_g, cell.fg_b, theme.foreground);
  const background = inverse
    ? theme.foreground
    : selected
      ? packColor(hints.selection!.background.r, hints.selection!.background.g, hints.selection!.background.b, theme.background)
      : packColor(cell.bg_r, cell.bg_g, cell.bg_b, theme.background);
  const bold = (flags & 1) !== 0;
  const italic = (flags & 2) !== 0;
  const underline = (flags & 4) !== 0 || hovered;
  const strikethrough = (flags & 8) !== 0;
  const styleKey = [
    foreground,
    background,
    bold ? 1 : 0,
    italic ? 1 : 0,
    underline ? 1 : 0,
    strikethrough ? 1 : 0,
  ].join(':');
  let style = cache.get(styleKey);
  if (!style) {
    style = module.style().fg(foreground).bg(background);
    if (bold) style = style.bold();
    if (italic) style = style.italic();
    if (underline) style = style.underline();
    if (strikethrough) style = style.strikethrough();
    if (cache.size >= MAX_STYLE_CACHE_ENTRIES) cache.clear();
    cache.set(styleKey, style);
  }

  const graphemeLength = Number(cell.grapheme_len ?? 0);
  const invisible = (flags & 32) !== 0;
  const symbol = invisible ? ' ' : resolveSourceSymbol(sourceRenderer, cell, row, col);
  const width = Number(cell.width ?? 1) || 1;
  target.symbol = symbol;
  target.width = width;
  target.styleKey = styleKey;
  target.style = style;
  target.simple = graphemeLength <= 0 && width === 1;
  target.blank = symbol === ' ';
};

const resolveSourceSymbol = (
  renderer: TerminalFabricSourceRenderer,
  cell: TerminalFabricSourceCell,
  row: number,
  col: number,
): string => {
  if ((cell.grapheme_len ?? 0) > 0) {
    const grapheme = renderer.currentBuffer?.getGraphemeString?.(row, col);
    if (grapheme) return grapheme;
  }
  const codepoint = Number(cell.codepoint ?? 32);
  if (!Number.isFinite(codepoint) || codepoint <= 0) return ' ';
  try {
    return String.fromCodePoint(codepoint);
  } catch {
    return ' ';
  }
};

const packColor = (red: unknown, green: unknown, blue: unknown, fallback: number): number => {
  const r = Number(red);
  const g = Number(green);
  const b = Number(blue);
  if (![r, g, b].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) return fallback;
  return (r << 16) | (g << 8) | b;
};

const isCellInSelection = (
  row: number,
  col: number,
  selection: TerminalFabricRowRenderHints['selection'],
): boolean => {
  if (!selection) return false;
  if (selection.startRow === selection.endRow) {
    return row === selection.startRow && col >= selection.startCol && col <= selection.endCol;
  }
  if (row === selection.startRow) return col >= selection.startCol;
  if (row === selection.endRow) return col <= selection.endCol;
  return row > selection.startRow && row < selection.endRow;
};

const isCellHovered = (
  row: number,
  col: number,
  cell: TerminalFabricSourceCell,
  hover: TerminalFabricRowRenderHints['hover'],
): boolean => {
  if (!hover) return false;
  const hoverId = Number(hover.hyperlinkId ?? 0);
  if (hoverId > 0 && Number(cell.hyperlink_id ?? 0) === hoverId) return true;
  const range = hover.range;
  if (!range) return false;
  if (row === range.startY && row === range.endY) return col >= range.startX && col <= range.endX;
  if (row === range.startY) return col >= range.startX;
  if (row === range.endY) return col <= range.endX;
  return row > range.startY && row < range.endY;
};

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
