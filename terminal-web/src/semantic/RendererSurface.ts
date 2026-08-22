import { presentationAdvances, type SemanticFrame, type SemanticPresentation } from './presentation.js';
import { getThemeColors } from '../utils/config.js';
import { contrastRatio, deriveContrastingThemeColor, formatThemeColor, parseThemeColor, type RgbColor } from '../utils/themeColor.js';
import type { TerminalThemeColors } from '../types.js';

export const SEMANTIC_CELL_WIDTH_CSS_PX = 9;
export const SEMANTIC_CELL_HEIGHT_CSS_PX = 18;
export const SEMANTIC_TERMINAL_FONT_FAMILY = '"JetBrains Mono", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans Mono CJK SC", monospace';

export type SemanticTerminalPalette = TerminalThemeColors;
type SemanticDebugTraceEvent = Readonly<Record<string, unknown>>;

function emitSemanticDebugTrace(event: SemanticDebugTraceEvent): void {
  const target = globalThis as typeof globalThis & {
    __floetermSemanticTrace?: (event: SemanticDebugTraceEvent) => void;
  };
  target.__floetermSemanticTrace?.(event);
}
export type SemanticTerminalTypography = Readonly<{
  fontSizeCssPx: number;
  fontFamily: string;
  lineHeightCssPx?: number;
}>;
export type SemanticTerminalLabels = Readonly<{
  historyLoading: string;
}>;
export type SemanticTerminalCellMetrics = Readonly<{
  cellWidthCssPx: number;
  cellHeightCssPx: number;
}>;
export type SemanticTerminalRenderMetrics = Readonly<{
  startedAt: number;
  completedAt: number;
  durationMs: number;
  sequence: number;
  projected: boolean;
  projectionChanged: boolean;
  rows: number;
  cols: number;
}>;
export type SemanticTerminalCursorRect = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;
export type SemanticTerminalSearchDecoration = Readonly<{
  row: number;
  startColumn: number;
  endColumnExclusive: number;
  active: boolean;
  matchId: string;
}>;

type CanvasCoordinateSpace = Readonly<{
  bounds: DOMRect;
  layoutWidth: number;
  layoutHeight: number;
  scaleX: number;
  scaleY: number;
}>;

type SemanticSelectionPoint = Readonly<{ row: number; col: number }>;
type SemanticSelectionRange = Readonly<{
  start: SemanticSelectionPoint;
  end: SemanticSelectionPoint;
}>;
type SemanticSelectionGranularity = 'cell' | 'word' | 'line';

const SELECTION_DRAG_THRESHOLD_CSS_PX = 3;

const PALETTE_KEYS = [
  'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const satisfies readonly (keyof SemanticTerminalPalette)[];

export class RendererSurface {
  private latest: SemanticPresentation | null = null;
  private viewportFrame: SemanticFrame | null = null;
  private animationFrame: number | null = null;
  private selectionAnchor: { row: number; col: number } | null = null;
  private selectionFocus: { row: number; col: number } | null = null;
  private selectionGesture: {
    clientX: number;
    clientY: number;
    base: SemanticSelectionRange;
    granularity: SemanticSelectionGranularity;
    active: boolean;
  } | null = null;
  private searchDecorations: readonly SemanticTerminalSearchDecoration[] = Object.freeze([]);
  private searchDecorationCells = new Map<number, SemanticTerminalSearchDecoration>();
  private renderGeneration = 0;
  private projectionGeneration = 0;
  private renderedProjectionGeneration = 0;
  private failed = false;
  private context: CanvasRenderingContext2D | null | undefined;
  private cursorBlinkTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorBlinkPhaseVisible = true;
  private palette: SemanticTerminalPalette = Object.freeze(getThemeColors('dark'));
  private typography: Required<SemanticTerminalTypography> = Object.freeze({
    fontSizeCssPx: 14,
    fontFamily: SEMANTIC_TERMINAL_FONT_FAMILY,
    lineHeightCssPx: SEMANTIC_CELL_HEIGHT_CSS_PX,
  });
  private cellMetrics: SemanticTerminalCellMetrics = Object.freeze({
    cellWidthCssPx: SEMANTIC_CELL_WIDTH_CSS_PX,
    cellHeightCssPx: SEMANTIC_CELL_HEIGHT_CSS_PX,
  });
  private typographyConfigured = false;
  private labels: SemanticTerminalLabels = Object.freeze({ historyLoading: 'Loading history...' });
  private dprMediaQuery: MediaQueryList | null = null;
  private readonly fontSet: FontFaceSet | undefined;
  private disposed = false;
  private viewVisible = true;
  private readonly graphicBitmaps = new Map<string, ImageBitmap>();
  private readonly visibilityHandler = (): void => {
    if (this.failed) return;
    this.cursorBlinkPhaseVisible = true;
    this.syncCursorBlinkTimer();
    this.scheduleRender();
  };
  private readonly dprChangeHandler = (): void => {
    if (this.failed) return;
    this.bindDprChangeListener();
    this.resize();
  };
  private readonly fontLoadingDoneHandler = (): void => {
    if (this.disposed || this.failed) return;
    try {
      if (this.typographyConfigured) this.refreshCellMetrics();
      this.scheduleRender();
    } catch (error) {
      this.fail(error);
    }
  };
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onError: (error: Error) => void = () => {},
    private readonly onRender: (metrics: SemanticTerminalRenderMetrics) => void = () => {},
  ) {
    this.canvas.style.visibility = 'hidden';
    this.canvas.style.background = this.palette.background;
    globalThis.document?.addEventListener('visibilitychange', this.visibilityHandler);
    this.fontSet = globalThis.document?.fonts;
    this.fontSet?.addEventListener?.('loadingdone', this.fontLoadingDoneHandler);
    void this.fontSet?.ready.then(() => this.fontLoadingDoneHandler());
    this.bindDprChangeListener();
  }
  apply(presentation: SemanticPresentation): void {
    if (this.failed) return;
    try {
      if (!presentationAdvances(this.latest, presentation)) return;
    } catch (error) {
      this.fail(error);
      return;
    }
    const cursorChanged = !this.latest || !sameCursor(this.latest.frame.cursor, presentation.frame.cursor);
    const wasShowingLive = this.viewportFrame === null;
    const contentChanged = this.latest !== null
      && (this.latest.state.contentEpoch ?? 0) !== (presentation.state.contentEpoch ?? 0);
    const geometryChanged = this.latest !== null && (
      this.latest.geometry.generation !== presentation.geometry.generation
      || this.latest.geometry.cols !== presentation.geometry.cols
      || this.latest.geometry.rows !== presentation.geometry.rows
    );
    this.latest = presentation;
    if (contentChanged || geometryChanged) {
      this.viewportFrame = null;
      this.selectionAnchor = null;
      this.selectionFocus = null;
      this.selectionGesture = null;
      this.searchDecorations = Object.freeze([]);
      this.searchDecorationCells.clear();
    } else if (wasShowingLive) {
      this.searchDecorations = Object.freeze([]);
      this.searchDecorationCells.clear();
    }
    if (cursorChanged) {
      this.cursorBlinkPhaseVisible = true;
      this.syncCursorBlinkTimer();
    }
    this.scheduleRender();
  }
  setPalette(palette: SemanticTerminalPalette): void {
    if (this.failed || samePalette(this.palette, palette)) return;
    this.palette = Object.freeze({ ...palette });
    this.renderGeneration += 1;
    this.canvas.style.background = this.palette.background;
    this.scheduleRender();
  }
  setTypography(typography: SemanticTerminalTypography): SemanticTerminalCellMetrics {
    if (this.failed) return this.getCellMetrics();
    const fontSizeCssPx = Number(typography.fontSizeCssPx);
    const fontFamily = String(typography.fontFamily ?? '').trim();
    const lineHeightCssPx = typography.lineHeightCssPx === undefined
      ? Math.ceil(fontSizeCssPx * 1.5)
      : Number(typography.lineHeightCssPx);
    if (!Number.isFinite(fontSizeCssPx) || fontSizeCssPx < 6 || fontSizeCssPx > 96) {
      throw new Error('semantic terminal font size must be between 6 and 96 CSS pixels');
    }
    if (!fontFamily || fontFamily.length > 1024 || /[\r\n\0]/u.test(fontFamily)) {
      throw new Error('semantic terminal font family is invalid');
    }
    if (!Number.isFinite(lineHeightCssPx) || lineHeightCssPx < fontSizeCssPx || lineHeightCssPx > 192) {
      throw new Error('semantic terminal line height is invalid');
    }
    this.typography = Object.freeze({ fontSizeCssPx, fontFamily, lineHeightCssPx });
    this.typographyConfigured = true;
    const metrics = this.refreshCellMetrics();
    this.cursorBlinkPhaseVisible = true;
    this.scheduleRender();
    return metrics;
  }
  setLabels(labels: Partial<SemanticTerminalLabels>): void {
    if (this.failed || this.disposed) return;
    if (labels.historyLoading === undefined) return;
    const historyLoading = String(labels.historyLoading);
    if (!historyLoading || historyLoading.length > 128 || /[\r\n\0]/u.test(historyLoading)) {
      throw new Error('semantic terminal history loading label is invalid');
    }
    if (historyLoading === this.labels.historyLoading) return;
    this.labels = Object.freeze({ ...this.labels, historyLoading });
    this.scheduleRender();
  }
  getCellMetrics(): SemanticTerminalCellMetrics {
    return { ...this.cellMetrics };
  }
  project(frame: SemanticFrame | null): void {
    this.updateProjection(frame);
    this.scheduleRender();
  }
  projectInCurrentAnimationFrame(frame: SemanticFrame | null): void {
    this.updateProjection(frame);
    if (this.failed || !this.latest) return;
    if (this.animationFrame !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    try {
      this.render(this.latest);
    } catch (error) {
      this.fail(error);
    }
  }
  private updateProjection(frame: SemanticFrame | null): void {
    if (frame && (!this.latest
      || frame.width !== this.latest.frame.width
      || frame.height !== this.latest.frame.height
      || frame.rows.length !== this.latest.frame.height)) {
      throw new Error('semantic history frame does not match the current presentation geometry');
    }
    this.viewportFrame = frame;
    this.projectionGeneration += 1;
    emitSemanticDebugTrace({
      kind: 'history-project',
      at: performance.now(),
      projected: frame !== null,
    });
    this.clearSelection();
    this.clearSearchDecorations();
    this.syncCursorBlinkTimer();
  }
  setSearchDecorations(decorations: readonly SemanticTerminalSearchDecoration[]): void {
    if (this.failed || this.disposed) return;
    const frame = this.currentFrame();
    if (!frame && decorations.length > 0) throw new Error('semantic search decorations require a visible frame');
    const width = frame?.width ?? 0;
    const height = frame?.height ?? 0;
    const normalized = decorations.map(decoration => {
      if (!Number.isInteger(decoration.row) || decoration.row < 0 || decoration.row >= height
        || !Number.isInteger(decoration.startColumn) || !Number.isInteger(decoration.endColumnExclusive)
        || decoration.startColumn < 0 || decoration.endColumnExclusive <= decoration.startColumn
        || decoration.endColumnExclusive > width || typeof decoration.active !== 'boolean'
        || typeof decoration.matchId !== 'string' || decoration.matchId.length === 0) {
        throw new Error('semantic search decoration is invalid for the visible frame');
      }
      return Object.freeze({ ...decoration });
    });
    const cells = new Map<number, SemanticTerminalSearchDecoration>();
    for (const decoration of normalized) {
      for (let column = decoration.startColumn; column < decoration.endColumnExclusive; column += 1) {
        const key = decoration.row * 1_000_000 + column;
        if (decoration.active || !cells.has(key)) cells.set(key, decoration);
      }
    }
    this.searchDecorations = Object.freeze(normalized);
    this.searchDecorationCells = cells;
    this.scheduleRender();
  }
  clearSearchDecorations(): void {
    if (this.searchDecorations.length === 0) return;
    this.searchDecorations = Object.freeze([]);
    this.searchDecorationCells.clear();
    this.scheduleRender();
  }
  beginSelection(clientX: number, clientY: number, clickCount = 1): void {
    const point = this.pointFromClient(clientX, clientY);
    if (!point) {
      this.clearSelection();
      return;
    }
    const normalizedClickCount = Number.isFinite(clickCount) ? Math.max(1, Math.floor(clickCount)) : 1;
    const granularity: SemanticSelectionGranularity = normalizedClickCount >= 3
      ? 'line'
      : normalizedClickCount === 2 ? 'word' : 'cell';
    const frame = this.currentFrame();
    const base = frame ? this.selectionRangeAt(frame, point, granularity) : null;
    const hadSelection = this.selectionAnchor !== null || this.selectionFocus !== null;
    this.selectionAnchor = null;
    this.selectionFocus = null;
    this.selectionGesture = base ? { clientX, clientY, base, granularity, active: false } : null;
    if (base && granularity !== 'cell') {
      this.selectionAnchor = base.start;
      this.selectionFocus = base.end;
      this.scheduleRender();
      return;
    }
    if (!hadSelection) return;
    this.scheduleRender();
  }
  updateSelection(clientX: number, clientY: number): void {
    const gesture = this.selectionGesture;
    if (!gesture) return;
    const point = this.pointFromClient(clientX, clientY);
    if (!point) return;
    if (!gesture.active) {
      const deltaX = clientX - gesture.clientX;
      const deltaY = clientY - gesture.clientY;
      if ((deltaX * deltaX) + (deltaY * deltaY) < SELECTION_DRAG_THRESHOLD_CSS_PX ** 2) return;
      gesture.active = true;
    }
    const frame = this.currentFrame();
    const target = frame ? this.selectionRangeAt(frame, point, gesture.granularity) : null;
    if (!target) return;
    if (compareSelectionPoints(target.end, gesture.base.start) < 0) {
      this.selectionAnchor = gesture.base.end;
      this.selectionFocus = target.start;
    } else if (compareSelectionPoints(target.start, gesture.base.end) > 0) {
      this.selectionAnchor = gesture.base.start;
      this.selectionFocus = target.end;
    } else {
      this.selectionAnchor = gesture.base.start;
      this.selectionFocus = gesture.base.end;
    }
    this.scheduleRender();
  }
  endSelection(clientX: number, clientY: number): void {
    if (!this.selectionGesture) return;
    this.updateSelection(clientX, clientY);
    this.selectionGesture = null;
  }
  clearSelection(): void {
    const changed = this.selectionAnchor !== null || this.selectionFocus !== null;
    this.selectionGesture = null;
    if (!changed) return;
    this.selectionAnchor = null;
    this.selectionFocus = null;
    this.scheduleRender();
  }
  hasSelection(): boolean {
    return this.getSelectionText().length > 0;
  }
  getSelectionText(): string {
    const frame = this.currentFrame();
    const range = this.selectionRange();
    if (!frame || !range) return '';
    const lines: string[] = [];
    for (let row = range.start.row; row <= range.end.row; row += 1) {
      const cells = frame.rows[row]?.cells ?? [];
      const startCol = row === range.start.row ? range.start.col : 0;
      const endCol = row === range.end.row ? range.end.col : frame.width - 1;
      lines.push(cells.slice(startCol, endCol + 1).map(cell => cell.text).join('').trimEnd());
    }
    return lines.join('\n').replace(/\n+$/, '');
  }
  getCursorLayoutRect(): SemanticTerminalCursorRect | null {
    const frame = this.latest?.frame;
    if (!frame) return null;
    const coordinates = this.measureCoordinateSpace();
    if (!coordinates) return null;
    return this.cursorLayoutRect(frame, coordinates);
  }
  getCursorClientRect(): SemanticTerminalCursorRect | null {
    const frame = this.latest?.frame;
    if (!frame) return null;
    const coordinates = this.measureCoordinateSpace();
    if (!coordinates) return null;
    const layoutRect = this.cursorLayoutRect(frame, coordinates);
    return {
      left: coordinates.bounds.left + layoutRect.left * coordinates.scaleX,
      top: coordinates.bounds.top + layoutRect.top * coordinates.scaleY,
      width: layoutRect.width * coordinates.scaleX,
      height: layoutRect.height * coordinates.scaleY,
    };
  }
  private cursorLayoutRect(frame: SemanticFrame, coordinates: CanvasCoordinateSpace): SemanticTerminalCursorRect {
    const cursorX = Math.max(0, Math.min(frame.width - 1, frame.cursor.x));
    const cursorY = Math.max(0, Math.min(frame.height - 1, frame.cursor.y));
    const { cellWidthCssPx, cellHeightCssPx } = this.cellMetrics;
    const width = Math.min(cellWidthCssPx, coordinates.layoutWidth);
    const height = Math.min(cellHeightCssPx, coordinates.layoutHeight);
    const left = Math.max(0, Math.min(cursorX * cellWidthCssPx, coordinates.layoutWidth - width));
    const top = Math.max(0, Math.min(cursorY * cellHeightCssPx, coordinates.layoutHeight - height));
    return { left, top, width, height };
  }
  resize(): void {
    if (this.failed) return;
    // Never assign width/height here: that clears the visible bitmap before
    // the browser reaches the next paint. The RAF below changes the backing,
    // fills every pixel, and draws the latest immutable Presentation in one
    // JavaScript task, so no empty backing can be composited between them.
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.background = this.palette.background;
    const viewport = this.measureViewport();
    if (!this.viewVisible || !viewport
      || this.canvas.width !== Math.round(viewport.cssWidth * viewport.dpr)
      || this.canvas.height !== Math.round(viewport.cssHeight * viewport.dpr)) {
      this.canvas.style.visibility = 'hidden';
    }
    this.scheduleRender();
  }
  setVisible(visible: boolean): void {
    if (this.disposed || this.failed) return;
    this.viewVisible = visible;
    if (!visible || !this.latest) {
      this.canvas.style.visibility = 'hidden';
      return;
    }
    if (this.animationFrame !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    try {
      this.render(this.latest);
    } catch (error) {
      this.fail(error);
    }
  }
  dispose(): void {
    this.disposed = true;
    this.renderGeneration += 1;
    if (this.animationFrame !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.animationFrame);
    }
    this.animationFrame = null;
    this.clearCursorBlinkTimer();
    this.clearGraphicBitmaps();
    this.unbindDprChangeListener();
    this.fontSet?.removeEventListener?.('loadingdone', this.fontLoadingDoneHandler);
    globalThis.document?.removeEventListener('visibilitychange', this.visibilityHandler);
    this.latest = null;
    this.viewportFrame = null;
    this.selectionAnchor = null;
    this.selectionFocus = null;
    this.selectionGesture = null;
    this.searchDecorations = Object.freeze([]);
    this.searchDecorationCells.clear();
    this.canvas.style.visibility = 'hidden';
  }
  private scheduleRender(): void {
    if (this.failed || !this.latest || this.animationFrame !== null) return;
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      try {
        this.render(this.latest);
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    this.animationFrame = globalThis.requestAnimationFrame(() => {
      this.animationFrame = null;
      if (!this.latest || this.failed) return;
      try {
        this.render(this.latest);
      } catch (error) {
        this.fail(error);
      }
    });
  }
  private render(presentation: SemanticPresentation): void {
    const startedAt = performance.now();
    const viewport = this.measureViewport();
    if (!this.viewVisible || !viewport) {
      this.canvas.style.visibility = 'hidden';
      return;
    }
    const renderGeneration = ++this.renderGeneration;
    const projectionGeneration = this.projectionGeneration;
    const frame = this.viewportFrame ?? presentation.frame;
    const palette = this.palette;
    const context = this.getContext();
    // The canvas owns its backing store, but its containing pane owns the
    // layout bounds. Reading the canvas rect after writing inline dimensions
    // would make a resize self-referential and preserve the old viewport.
    const { dpr } = this.syncBackingStore(viewport);
    // Fill the exact integer backing extent before applying the CSS-pixel DPR
    // transform. A fractional CSS*dpr edge would otherwise leave the last
    // physical pixel only partially covered and expose transparency.
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = palette.background;
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The engine grid is authoritative. A view may be larger or smaller than
    // that grid, so preserve one CSS cell metric and crop/pad locally instead
    // of stretching the shared frame to fit an observer viewport.
    const { cellWidthCssPx: cellWidth, cellHeightCssPx: cellHeight } = this.cellMetrics;
    const searchColors = resolveSearchColors(palette);
    context.font = `${this.typography.fontSizeCssPx}px ${this.typography.fontFamily}`;
    context.textBaseline = 'alphabetic';
    if (frame.history.pending) {
      this.paintPendingHistory(context, frame, cellWidth, cellHeight, palette);
      this.paintHistoryLoadingIndicator(context, frame, cellWidth, cellHeight, palette);
    } else {
      frame.rows.forEach((row, y) => {
        row.cells.forEach((cell, x) => {
          const { background } = resolveCellColors(cell, this.isCellSelected(y, x), this.searchDecorationAt(y, x), palette, searchColors);
          context.fillStyle = background;
          context.fillRect(x * cellWidth, y * cellHeight, cellWidth + 0.5, cellHeight + 0.5);
        });
        row.cells.forEach((cell, x) => {
          if (!cell.text || cell.width === 0) return;
          const { foreground } = resolveCellColors(cell, this.isCellSelected(y, x), this.searchDecorationAt(y, x), palette, searchColors);
          this.paintCellText(context, cell, x, y, cellWidth, cellHeight, foreground);
        });
      });
    }
    this.paintCursor(context, frame, frame.cursor, cellWidth, cellHeight, palette);
    void this.paintGraphics(context, frame, cellWidth, cellHeight, renderGeneration, palette)
      .catch(error => this.fail(error));
    this.canvas.style.visibility = 'visible';
    const completedAt = performance.now();
    const metrics: SemanticTerminalRenderMetrics = Object.freeze({
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      sequence: presentation.sequence,
      projected: this.viewportFrame !== null,
      projectionChanged: projectionGeneration !== this.renderedProjectionGeneration,
      rows: frame.height,
      cols: frame.width,
    });
    this.renderedProjectionGeneration = projectionGeneration;
    emitSemanticDebugTrace({
      kind: 'render',
      at: completedAt,
      ...metrics,
    });
    try {
      this.onRender(metrics);
    } catch {
      // Measurement consumers must never be able to fail the terminal renderer.
    }
  }

  private paintCursor(
    context: CanvasRenderingContext2D,
    frame: SemanticFrame,
    cursor: SemanticFrame['cursor'],
    cellWidth: number,
    cellHeight: number,
    palette: SemanticTerminalPalette,
  ): void {
    if (!cursor.visible || (cursor.blinking && !this.cursorBlinkPhaseVisible)) return;
    const x = Math.max(0, Math.min(frame.width - 1, cursor.x));
    const y = Math.max(0, Math.min(frame.height - 1, cursor.y));
    const foreground = resolveColor(cursor.color, palette.cursor, palette);
    context.fillStyle = foreground;
    if (cursor.shape === 'bar') {
      context.fillRect(x * cellWidth, y * cellHeight, Math.max(2, Math.round(cellWidth * 0.16)), cellHeight);
    } else if (cursor.shape === 'underline') {
      context.fillRect(x * cellWidth, (y + 1) * cellHeight - 2, cellWidth, 2);
    } else if (cursor.shape === 'hollow') {
      const thickness = Math.max(1, Math.round(Math.min(cellWidth, cellHeight) * 0.1));
      context.fillRect(x * cellWidth, y * cellHeight, cellWidth, thickness);
      context.fillRect(x * cellWidth, (y + 1) * cellHeight - thickness, cellWidth, thickness);
      context.fillRect(x * cellWidth, y * cellHeight, thickness, cellHeight);
      context.fillRect((x + 1) * cellWidth - thickness, y * cellHeight, thickness, cellHeight);
    } else {
      const cell = frame.rows[y]?.cells[x];
      context.fillRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);
      if (cell?.text) {
        this.paintCellText(context, cell, x, y, cellWidth, cellHeight, palette.cursorAccent);
      }
    }
  }

  private paintCellText(
    context: CanvasRenderingContext2D,
    cell: SemanticFrame['rows'][number]['cells'][number],
    x: number,
    y: number,
    cellWidth: number,
    cellHeight: number,
    color: string,
  ): void {
    context.fillStyle = color;
    const baseline = (y + 0.82) * cellHeight;
    if (cell.width > 1) {
      const metrics = context.measureText(cell.text);
      const spanWidth = cellWidth * cell.width;
      const textX = x * cellWidth + Math.max(0, (spanWidth - metrics.width) / 2);
      context.save();
      context.beginPath();
      context.rect(x * cellWidth, y * cellHeight, spanWidth, cellHeight);
      context.clip();
      context.fillText(cell.text, textX, baseline);
      context.restore();
      return;
    }
    context.fillText(cell.text, x * cellWidth, baseline);
  }

  private repaintCursorCell(): void {
    const frame = this.currentFrame();
    if (!frame || !frame.cursor.visible) return;
    if (frame.graphics.placements.some(placement => placement.visible)) {
      this.scheduleRender();
      return;
    }
    const x = Math.max(0, Math.min(frame.width - 1, frame.cursor.x));
    const y = Math.max(0, Math.min(frame.height - 1, frame.cursor.y));
    const cell = frame.rows[y]?.cells[x];
    const context = this.getContext();
    const palette = this.palette;
    const { background, foreground } = resolveCellColors(cell, this.isCellSelected(y, x), this.searchDecorationAt(y, x), palette, resolveSearchColors(palette));
    context.fillStyle = background;
    const { cellWidthCssPx, cellHeightCssPx } = this.cellMetrics;
    context.fillRect(x * cellWidthCssPx, y * cellHeightCssPx, cellWidthCssPx + 0.5, cellHeightCssPx + 0.5);
    if (cell?.text) {
      this.paintCellText(context, cell, x, y, cellWidthCssPx, cellHeightCssPx, foreground);
    }
    this.paintCursor(context, frame, frame.cursor, cellWidthCssPx, cellHeightCssPx, palette);
  }

  private async paintGraphics(context: CanvasRenderingContext2D, frame: SemanticFrame, cellWidth: number, cellHeight: number, renderGeneration: number, palette: SemanticTerminalPalette): Promise<void> {
    if (frame.graphics.images.length === 0 || frame.graphics.placements.length === 0) {
      this.clearGraphicBitmaps();
      return;
    }
    const requestedKeys = new Set<string>();
    const bitmaps = new Map<number, ImageBitmap>();
    const pending: Array<Promise<{ id: number; key: string; bitmap: ImageBitmap }>> = [];
    for (const image of frame.graphics.images) {
      const key = `${image.id}:${image.generation}:${image.format}:${image.width}x${image.height}`;
      requestedKeys.add(key);
      const cached = this.graphicBitmaps.get(key);
      if (cached) {
        bitmaps.set(image.id, cached);
      } else {
        pending.push((async () => {
        const imageData = context.createImageData(image.width, image.height);
        const target = imageData.data;
        for (let source = 0, destination = 0; source < image.pixels.length; destination += 4) {
          if (image.format === 0) {
            target[destination] = image.pixels[source++]!; target[destination + 1] = image.pixels[source++]!; target[destination + 2] = image.pixels[source++]!; target[destination + 3] = 255;
          } else if (image.format === 1) {
            target[destination] = image.pixels[source++]!; target[destination + 1] = image.pixels[source++]!; target[destination + 2] = image.pixels[source++]!; target[destination + 3] = image.pixels[source++]!;
          } else if (image.format === 3) {
            const gray = image.pixels[source++]!; target[destination] = gray; target[destination + 1] = gray; target[destination + 2] = gray; target[destination + 3] = image.pixels[source++]!;
          } else {
            const gray = image.pixels[source++]!; target[destination] = gray; target[destination + 1] = gray; target[destination + 2] = gray; target[destination + 3] = 255;
          }
        }
          return { id: image.id, key, bitmap: await createImageBitmap(imageData) };
        })());
      }
    }
    const created = pending.length > 0 ? await Promise.all(pending) : [];
    if (renderGeneration !== this.renderGeneration) {
      for (const item of created) item.bitmap.close();
      return;
    }
    for (const item of created) {
      this.graphicBitmaps.get(item.key)?.close();
      this.graphicBitmaps.set(item.key, item.bitmap);
      bitmaps.set(item.id, item.bitmap);
    }
    for (const [key, bitmap] of this.graphicBitmaps) {
      if (!requestedKeys.has(key)) {
        bitmap.close();
        this.graphicBitmaps.delete(key);
      }
    }
    for (const placement of [...frame.graphics.placements].sort((left, right) => left.z - right.z)) {
      if (!placement.visible) continue;
      const bitmap = bitmaps.get(placement.imageId);
      if (!bitmap) continue;
      context.drawImage(bitmap, placement.viewportColumn * cellWidth, placement.viewportRow * cellHeight, placement.gridColumns * cellWidth, placement.gridRows * cellHeight);
    }
    this.paintCursor(context, frame, frame.cursor, cellWidth, cellHeight, palette);
  }

  private fail(cause: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.renderGeneration += 1;
    this.clearCursorBlinkTimer();
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.onError(error);
  }

  private getContext(): CanvasRenderingContext2D {
    if (this.context === undefined) this.context = this.canvas.getContext('2d');
    if (!this.context) throw new Error('2D terminal renderer unavailable');
    return this.context;
  }

  private refreshCellMetrics(): SemanticTerminalCellMetrics {
    const context = this.getContext();
    context.font = `${this.typography.fontSizeCssPx}px ${this.typography.fontFamily}`;
    const measuredWidth = typeof context.measureText === 'function'
      ? context.measureText('M').width
      : this.typography.fontSizeCssPx * (SEMANTIC_CELL_WIDTH_CSS_PX / 14);
    const effectiveWidth = Number.isFinite(measuredWidth) && measuredWidth > 0
      ? measuredWidth
      : this.typography.fontSizeCssPx * (SEMANTIC_CELL_WIDTH_CSS_PX / 14);
    const cellWidthCssPx = Math.max(1, Math.min(128, Math.ceil(effectiveWidth)));
    const cellHeightCssPx = Math.max(1, Math.min(192, Math.ceil(this.typography.lineHeightCssPx)));
    if (
      cellWidthCssPx !== this.cellMetrics.cellWidthCssPx
      || cellHeightCssPx !== this.cellMetrics.cellHeightCssPx
    ) {
      this.cellMetrics = Object.freeze({ cellWidthCssPx, cellHeightCssPx });
    }
    return { ...this.cellMetrics };
  }

  private syncCursorBlinkTimer(): void {
    this.clearCursorBlinkTimer();
    const cursor = this.currentFrame()?.cursor;
    if (!cursor?.visible || !cursor.blinking || globalThis.document?.hidden) {
      this.cursorBlinkPhaseVisible = true;
      return;
    }
    this.cursorBlinkTimer = globalThis.setTimeout(() => {
      this.cursorBlinkTimer = null;
      const current = this.currentFrame()?.cursor;
      if (!current?.visible || !current.blinking || globalThis.document?.hidden) {
        this.cursorBlinkPhaseVisible = true;
        return;
      }
      this.cursorBlinkPhaseVisible = !this.cursorBlinkPhaseVisible;
      try {
        this.repaintCursorCell();
      } catch (error) {
        this.fail(error);
      }
      if (!this.failed) this.syncCursorBlinkTimer();
    }, 600);
  }

  private clearCursorBlinkTimer(): void {
    if (this.cursorBlinkTimer !== null) globalThis.clearTimeout(this.cursorBlinkTimer);
    this.cursorBlinkTimer = null;
  }

  private clearGraphicBitmaps(): void {
    for (const bitmap of this.graphicBitmaps.values()) bitmap.close();
    this.graphicBitmaps.clear();
  }

  private bindDprChangeListener(): void {
    this.unbindDprChangeListener();
    if (typeof globalThis.matchMedia !== 'function') return;
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
    this.dprMediaQuery = globalThis.matchMedia(`(resolution: ${dpr}dppx)`);
    if (typeof this.dprMediaQuery.addEventListener === 'function') {
      this.dprMediaQuery.addEventListener('change', this.dprChangeHandler);
    } else {
      this.dprMediaQuery.addListener(this.dprChangeHandler);
    }
  }

  private unbindDprChangeListener(): void {
    if (!this.dprMediaQuery) return;
    if (typeof this.dprMediaQuery.removeEventListener === 'function') {
      this.dprMediaQuery.removeEventListener('change', this.dprChangeHandler);
    } else {
      this.dprMediaQuery.removeListener(this.dprChangeHandler);
    }
    this.dprMediaQuery = null;
  }

  private currentFrame(): SemanticFrame | null {
    return this.viewportFrame ?? this.latest?.frame ?? null;
  }

  private pointFromClient(clientX: number, clientY: number): { row: number; col: number } | null {
    const frame = this.currentFrame();
    if (!frame) return null;
    const coordinates = this.measureCoordinateSpace();
    if (!coordinates) return null;
    const logicalX = (clientX - coordinates.bounds.left) / coordinates.scaleX;
    const logicalY = (clientY - coordinates.bounds.top) / coordinates.scaleY;
    if (logicalX < 0 || logicalY < 0
      || logicalX >= frame.width * this.cellMetrics.cellWidthCssPx
      || logicalY >= frame.height * this.cellMetrics.cellHeightCssPx) return null;
    const col = Math.floor(logicalX / this.cellMetrics.cellWidthCssPx);
    const row = Math.floor(logicalY / this.cellMetrics.cellHeightCssPx);
    return { row, col: this.selectionLeadingColumn(frame, row, col) };
  }

  private selectionLeadingColumn(frame: SemanticFrame, row: number, col: number): number {
    if (frame.rows[row]?.cells[col]?.width !== 0) return col;
    for (let candidate = col - 1; candidate >= 0; candidate -= 1) {
      const width = frame.rows[row]?.cells[candidate]?.width ?? 0;
      if (width > 0) return candidate + width > col ? candidate : col;
    }
    return col;
  }

  private selectionRangeAt(
    frame: SemanticFrame,
    point: SemanticSelectionPoint,
    granularity: SemanticSelectionGranularity,
  ): SemanticSelectionRange | null {
    if (granularity === 'cell') return { start: point, end: point };
    const cells = frame.rows[point.row]?.cells;
    if (!cells) return null;
    if (granularity === 'line') {
      let endColumn = -1;
      cells.forEach((cell, column) => {
        if (cell.width > 0 && cell.text.length > 0) {
          endColumn = Math.min(frame.width - 1, column + cell.width - 1);
        }
      });
      return endColumn < 0
        ? null
        : { start: { row: point.row, col: 0 }, end: { row: point.row, col: endColumn } };
    }

    const segments: Array<Readonly<{ start: number; end: number; kind: string }>> = [];
    cells.forEach((cell, column) => {
      if (cell.width === 0) return;
      segments.push({
        start: column,
        end: Math.min(frame.width - 1, column + Math.max(1, cell.width) - 1),
        kind: semanticSelectionCellKind(cell.text),
      });
    });
    const selectedIndex = segments.findIndex(segment => point.col >= segment.start && point.col <= segment.end);
    const selected = segments[selectedIndex];
    if (!selected || selected.kind === 'empty') return null;
    let first = selectedIndex;
    let last = selectedIndex;
    while (first > 0
      && segments[first - 1]!.end + 1 === segments[first]!.start
      && segments[first - 1]!.kind === selected.kind) first -= 1;
    while (last + 1 < segments.length
      && segments[last]!.end + 1 === segments[last + 1]!.start
      && segments[last + 1]!.kind === selected.kind) last += 1;
    return {
      start: { row: point.row, col: segments[first]!.start },
      end: { row: point.row, col: segments[last]!.end },
    };
  }

  private paintPendingHistory(
    context: CanvasRenderingContext2D,
    frame: SemanticFrame,
    cellWidth: number,
    cellHeight: number,
    palette: SemanticTerminalPalette,
  ): void {
    // Keep the terminal background untouched. A few static, theme-aware text
    // baselines communicate that the target is pending without producing the
    // full-surface color flash caused by treating the skeleton as cell fill.
    context.save();
    context.globalAlpha = 0.11;
    context.fillStyle = palette.foreground;
    const widthRatios = [0.58, 0.76, 0.44, 0.67, 0.51, 0.72, 0.39, 0.63];
    const pendingOffset = frame.history.pendingOffset ?? frame.history.screenStartOffset;
    for (let row = 0; row < frame.height; row += 1) {
      // Key the quiet line pattern to the absolute target row. As the wheel
      // target advances, the same rows move through the viewport instead of
      // repainting an identical placeholder pattern in place.
      const patternRow = positiveModulo(pendingOffset + row, widthRatios.length);
      const ratio = widthRatios[patternRow] ?? 0.58;
      const width = Math.max(cellWidth, Math.floor(frame.width * cellWidth * ratio));
      const baseline = Math.round(row * cellHeight + cellHeight * 0.72);
      context.fillRect(0, baseline, width, 1);
    }
    context.restore();
  }

  private paintHistoryLoadingIndicator(
    context: CanvasRenderingContext2D,
    frame: SemanticFrame,
    cellWidth: number,
    cellHeight: number,
    palette: SemanticTerminalPalette,
  ): void {
    const label = this.labels.historyLoading;
    if (!label) return;
    const centerX = frame.width * cellWidth / 2;
    const centerY = frame.height * cellHeight / 2;
    const maxWidth = Math.max(cellWidth, frame.width * cellWidth - cellWidth * 2);
    const measuredWidth = context.measureText(label).width;
    const paddingX = Math.max(6, Math.round(cellWidth * 0.75));
    const panelWidth = Math.min(maxWidth, measuredWidth + paddingX * 2);
    const panelHeight = Math.max(cellHeight, Math.round(cellHeight * 1.35));
    context.save();
    // A quiet backing plate keeps the message legible over the placeholder
    // baselines without introducing a bright animated badge.
    context.globalAlpha = 0.78;
    context.fillStyle = palette.background;
    context.fillRect(centerX - panelWidth / 2, centerY - panelHeight / 2, panelWidth, panelHeight);
    context.globalAlpha = 0.62;
    context.fillStyle = palette.foreground;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, centerX, centerY, maxWidth);
    context.restore();
  }

  private measureCoordinateSpace(): CanvasCoordinateSpace | null {
    const bounds = this.canvas.getBoundingClientRect();
    const layoutWidth = this.canvas.clientWidth;
    const layoutHeight = this.canvas.clientHeight;
    if (bounds.width <= 0 || bounds.height <= 0 || layoutWidth <= 0 || layoutHeight <= 0) return null;
    const scaleX = bounds.width / layoutWidth;
    const scaleY = bounds.height / layoutHeight;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return null;
    return { bounds, layoutWidth, layoutHeight, scaleX, scaleY };
  }

  private selectionRange(): SemanticSelectionRange | null {
    if (!this.selectionAnchor || !this.selectionFocus) return null;
    const anchorIndex = this.selectionAnchor.row * 1_000_000 + this.selectionAnchor.col;
    const focusIndex = this.selectionFocus.row * 1_000_000 + this.selectionFocus.col;
    return anchorIndex <= focusIndex
      ? { start: this.selectionAnchor, end: this.selectionFocus }
      : { start: this.selectionFocus, end: this.selectionAnchor };
  }

  private isCellSelected(row: number, col: number): boolean {
    const range = this.selectionRange();
    if (!range || row < range.start.row || row > range.end.row) return false;
    if (range.start.row === range.end.row) return col >= range.start.col && col <= range.end.col;
    if (row === range.start.row) return col >= range.start.col;
    if (row === range.end.row) return col <= range.end.col;
    return true;
  }

  private searchDecorationAt(row: number, col: number): SemanticTerminalSearchDecoration | null {
    return this.searchDecorationCells.get(row * 1_000_000 + col) ?? null;
  }

  private measureViewport(): { cssWidth: number; cssHeight: number; dpr: number } | null {
    const host = this.canvas.parentElement;
    const cssWidth = host?.clientWidth || this.canvas.clientWidth || 0;
    const cssHeight = host?.clientHeight || this.canvas.clientHeight || 0;
    if (cssWidth <= 0 || cssHeight <= 0) return null;
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
    return { cssWidth, cssHeight, dpr };
  }

  private syncBackingStore(viewport: { cssWidth: number; cssHeight: number; dpr: number }): { cssWidth: number; cssHeight: number; dpr: number } {
    const { cssWidth, cssHeight, dpr } = viewport;
    const backingWidth = Math.round(cssWidth * dpr);
    const backingHeight = Math.round(cssHeight * dpr);
    // Backing assignments clear old pixels. Deduplicate exact observer repeats
    // so a drag does not continually recreate the drawing surface.
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.background = this.palette.background;
    return { cssWidth, cssHeight, dpr };
  }
}

function resolveColor(value: string | undefined, fallback: string, palette: SemanticTerminalPalette): string {
  if (!value || value === 'default') return fallback;
  if (value.startsWith('rgb:')) return `#${value.slice(4)}`;
  if (value.startsWith('indexed:')) {
    const index = Number(value.slice(8));
    return resolveIndexedColor(index, palette) ?? fallback;
  }
  return fallback;
}

function compareSelectionPoints(left: SemanticSelectionPoint, right: SemanticSelectionPoint): number {
  return left.row === right.row ? left.col - right.col : left.row - right.row;
}

function semanticSelectionCellKind(text: string): string {
  if (text.length === 0) return 'empty';
  if (/^\s+$/u.test(text)) return 'space';
  if (/\p{Script=Han}/u.test(text)) return 'word-han';
  if (/\p{Script=Hiragana}/u.test(text)) return 'word-hiragana';
  if (/\p{Script=Katakana}/u.test(text)) return 'word-katakana';
  if (/\p{Script=Hangul}/u.test(text)) return 'word-hangul';
  if (/[\p{Letter}\p{Mark}\p{Number}_]/u.test(text) || /^[-./~:@%+=]+$/u.test(text)) return 'word';
  if (/\p{Extended_Pictographic}/u.test(text)) return 'symbol';
  return 'punctuation';
}

function resolveCellColors(
  cell: SemanticFrame['rows'][number]['cells'][number] | undefined,
  selected: boolean,
  decoration: SemanticTerminalSearchDecoration | null,
  palette: SemanticTerminalPalette,
  searchColors: ReturnType<typeof resolveSearchColors>,
): Readonly<{ background: string; foreground: string }> {
  if (selected) {
    return {
      background: palette.selectionBackground,
      foreground: palette.selectionForeground,
    };
  }
  if (decoration) {
    return decoration.active ? searchColors.active : searchColors.ordinary;
  }
  if (cell?.style?.inverse) {
    return {
      background: resolveColor(cell.style.foreground, palette.foreground, palette),
      foreground: resolveColor(cell.style.background, palette.background, palette),
    };
  }
  return {
    background: resolveColor(cell?.style?.background, palette.background, palette),
    foreground: resolveColor(cell?.style?.foreground, palette.foreground, palette),
  };
}

function resolveSearchColors(palette: SemanticTerminalPalette): Readonly<{
  ordinary: { background: string; foreground: string };
  active: { background: string; foreground: string };
}> {
  const background = parseThemeColor(palette.background) ?? { r: 0, g: 0, b: 0 };
  const selection = parseThemeColor(palette.selectionBackground) ?? background;
  const foreground = parseThemeColor(palette.foreground) ?? { r: 255, g: 255, b: 255 };
  let ordinaryBackground = mixRgb(background, selection, 0.5);
  let activeBackground = selection;
  if (sameRgb(ordinaryBackground, activeBackground)) {
    ordinaryBackground = mixRgb(background, foreground, 0.35);
  }
  if (sameRgb(activeBackground, background)) {
    activeBackground = mixRgb(background, foreground, 0.65);
  }
  const ordinaryForeground = deriveContrastingThemeColor(ordinaryBackground, 4.5);
  const activeSelection = parseThemeColor(palette.selectionForeground) ?? foreground;
  const activeForeground = contrastRatio(activeSelection, activeBackground) >= 4.5
    ? activeSelection
    : deriveContrastingThemeColor(activeBackground, 4.5);
  return {
    ordinary: { background: formatThemeColor(ordinaryBackground), foreground: formatThemeColor(ordinaryForeground) },
    active: { background: formatThemeColor(activeBackground), foreground: formatThemeColor(activeForeground) },
  };
}

function mixRgb(source: RgbColor, target: RgbColor, amount: number): RgbColor {
  const channel = (left: number, right: number): number => Math.round(left + ((right - left) * amount));
  return { r: channel(source.r, target.r), g: channel(source.g, target.g), b: channel(source.b, target.b) };
}

function sameRgb(left: RgbColor, right: RgbColor): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b;
}

function resolveIndexedColor(index: number, palette: SemanticTerminalPalette): string | undefined {
  const ansi16 = [
    palette.black, palette.red, palette.green, palette.yellow,
    palette.blue, palette.magenta, palette.cyan, palette.white,
    palette.brightBlack, palette.brightRed, palette.brightGreen, palette.brightYellow,
    palette.brightBlue, palette.brightMagenta, palette.brightCyan, palette.brightWhite,
  ];
  if (index >= 0 && index < ansi16.length) return ansi16[index];
  if (index >= 16 && index <= 231) {
    const offset = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    return rgbHex(levels[Math.floor(offset / 36)]!, levels[Math.floor(offset / 6) % 6]!, levels[offset % 6]!);
  }
  if (index >= 232 && index <= 255) {
    const level = 8 + (index - 232) * 10;
    return rgbHex(level, level, level);
  }
  return undefined;
}

function rgbHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

function samePalette(left: SemanticTerminalPalette, right: SemanticTerminalPalette): boolean {
  return PALETTE_KEYS.every(key => left[key] === right[key]);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function sameCursor(left: SemanticFrame['cursor'], right: SemanticFrame['cursor']): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.visible === right.visible
    && left.shape === right.shape
    && left.blinking === right.blinking
    && left.wideTail === right.wideTail
    && left.color === right.color;
}
