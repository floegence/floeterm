import { presentationAdvances, type SemanticFrame, type SemanticPresentation } from './presentation.js';

export const SEMANTIC_CELL_WIDTH_CSS_PX = 9;
export const SEMANTIC_CELL_HEIGHT_CSS_PX = 18;

export class RendererSurface {
  private latest: SemanticPresentation | null = null;
  private viewportFrame: SemanticFrame | null = null;
  private animationFrame: number | null = null;
  private selectionAnchor: { row: number; col: number } | null = null;
  private selectionFocus: { row: number; col: number } | null = null;
  private renderGeneration = 0;
  private failed = false;
  private context: CanvasRenderingContext2D | null | undefined;
  private cursorBlinkTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorBlinkPhaseVisible = true;
  private readonly graphicBitmaps = new Map<string, ImageBitmap>();
  private readonly visibilityHandler = (): void => {
    if (this.failed) return;
    this.cursorBlinkPhaseVisible = true;
    this.syncCursorBlinkTimer();
    this.scheduleRender();
  };
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onError: (error: Error) => void = () => {},
  ) {
    globalThis.document?.addEventListener('visibilitychange', this.visibilityHandler);
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
    this.latest = presentation;
    this.viewportFrame = null;
    if (cursorChanged) {
      this.cursorBlinkPhaseVisible = true;
      this.syncCursorBlinkTimer();
    }
    this.scheduleRender();
  }
  project(frame: SemanticFrame | null): void {
    if (frame && this.latest && (frame.width !== this.latest.frame.width || frame.height !== this.latest.frame.height)) {
      throw new Error('semantic history frame does not match the current presentation geometry');
    }
    this.viewportFrame = frame;
    this.clearSelection();
    this.syncCursorBlinkTimer();
    this.scheduleRender();
  }
  beginSelection(clientX: number, clientY: number): void {
    const point = this.pointFromClient(clientX, clientY);
    if (!point) return;
    this.selectionAnchor = point;
    this.selectionFocus = point;
    this.scheduleRender();
  }
  updateSelection(clientX: number, clientY: number): void {
    if (!this.selectionAnchor) return;
    const point = this.pointFromClient(clientX, clientY);
    if (!point) return;
    this.selectionFocus = point;
    this.scheduleRender();
  }
  endSelection(clientX: number, clientY: number): void {
    this.updateSelection(clientX, clientY);
  }
  clearSelection(): void {
    if (!this.selectionAnchor && !this.selectionFocus) return;
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
  resize(): void {
    if (this.failed) return;
    // Never assign width/height here: that clears the visible bitmap before
    // the browser reaches the next paint. The RAF below changes the backing,
    // fills every pixel, and draws the latest immutable Presentation in one
    // JavaScript task, so no empty backing can be composited between them.
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.background = '#0b0f14';
    this.scheduleRender();
  }
  dispose(): void {
    this.renderGeneration += 1;
    if (this.animationFrame !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.animationFrame);
    }
    this.animationFrame = null;
    this.clearCursorBlinkTimer();
    this.clearGraphicBitmaps();
    globalThis.document?.removeEventListener('visibilitychange', this.visibilityHandler);
    this.latest = null;
    this.viewportFrame = null;
    this.selectionAnchor = null;
    this.selectionFocus = null;
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
    const renderGeneration = ++this.renderGeneration;
    const frame = this.viewportFrame ?? presentation.frame;
    const context = this.getContext();
    // The canvas owns its backing store, but its containing pane owns the
    // layout bounds. Reading the canvas rect after writing inline dimensions
    // would make a resize self-referential and preserve the old viewport.
    const { cssWidth, cssHeight, dpr } = this.syncBackingStore(presentation);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The engine grid is authoritative. A view may be larger or smaller than
    // that grid, so preserve one CSS cell metric and crop/pad locally instead
    // of stretching the shared frame to fit an observer viewport.
    const cellWidth = SEMANTIC_CELL_WIDTH_CSS_PX;
    const cellHeight = SEMANTIC_CELL_HEIGHT_CSS_PX;
    context.clearRect(0, 0, cssWidth, cssHeight);
    context.fillStyle = '#0b0f14';
    context.fillRect(0, 0, cssWidth, cssHeight);
    context.font = `${Math.max(1, Math.floor(cellHeight * 0.78))}px monospace`;
    context.textBaseline = 'alphabetic';
    frame.rows.forEach((row, y) => {
      row.cells.forEach((cell, x) => {
        const background = this.isCellSelected(y, x)
          ? '#315c3d'
          : resolveColor(cell.style?.background, '#0b0f14');
        context.fillStyle = background;
        context.fillRect(x * cellWidth, y * cellHeight, cellWidth + 0.5, cellHeight + 0.5);
      });
      row.cells.forEach((cell, x) => {
        if (!cell.text) return;
        const foreground = this.isCellSelected(y, x)
          ? '#ffffff'
          : resolveColor(cell.style?.foreground, '#e5e7eb');
        this.paintCellText(context, cell, x, y, cellWidth, cellHeight, foreground);
      });
    });
    this.paintCursor(context, frame, frame.cursor, cellWidth, cellHeight);
    void this.paintGraphics(context, frame, cellWidth, cellHeight, renderGeneration)
      .catch(error => this.fail(error));
  }

  private paintCursor(
    context: CanvasRenderingContext2D,
    frame: SemanticFrame,
    cursor: SemanticFrame['cursor'],
    cellWidth: number,
    cellHeight: number,
  ): void {
    if (!cursor.visible || (cursor.blinking && !this.cursorBlinkPhaseVisible)) return;
    const x = Math.max(0, Math.min(frame.width - 1, cursor.x));
    const y = Math.max(0, Math.min(frame.height - 1, cursor.y));
    const foreground = resolveColor(cursor.color, '#e5e7eb');
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
      const inverseForeground = this.isCellSelected(y, x)
        ? '#315c3d'
        : resolveColor(cell?.style?.background, '#0b0f14');
      context.fillRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);
      if (cell?.text) {
        this.paintCellText(context, cell, x, y, cellWidth, cellHeight, inverseForeground);
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
      const inkWidth = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
      if (inkWidth > 0) {
        const horizontalPadding = Math.min(1, cellWidth * 0.08);
        const targetInkWidth = Math.max(1, cellWidth * cell.width - horizontalPadding * 2);
        const scaleX = targetInkWidth / inkWidth;
        context.save();
        context.translate(x * cellWidth + horizontalPadding, 0);
        context.scale(scaleX, 1);
        context.fillText(cell.text, metrics.actualBoundingBoxLeft, baseline);
        context.restore();
        return;
      }
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
    const background = this.isCellSelected(y, x)
      ? '#315c3d'
      : resolveColor(cell?.style?.background, '#0b0f14');
    context.fillStyle = background;
    context.fillRect(x * SEMANTIC_CELL_WIDTH_CSS_PX, y * SEMANTIC_CELL_HEIGHT_CSS_PX, SEMANTIC_CELL_WIDTH_CSS_PX + 0.5, SEMANTIC_CELL_HEIGHT_CSS_PX + 0.5);
    if (cell?.text) {
      const foreground = this.isCellSelected(y, x)
        ? '#ffffff'
        : resolveColor(cell.style?.foreground, '#e5e7eb');
      this.paintCellText(context, cell, x, y, SEMANTIC_CELL_WIDTH_CSS_PX, SEMANTIC_CELL_HEIGHT_CSS_PX, foreground);
    }
    this.paintCursor(context, frame, frame.cursor, SEMANTIC_CELL_WIDTH_CSS_PX, SEMANTIC_CELL_HEIGHT_CSS_PX);
  }

  private async paintGraphics(context: CanvasRenderingContext2D, frame: SemanticFrame, cellWidth: number, cellHeight: number, renderGeneration: number): Promise<void> {
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
    this.paintCursor(context, frame, frame.cursor, cellWidth, cellHeight);
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

  private currentFrame(): SemanticFrame | null {
    return this.viewportFrame ?? this.latest?.frame ?? null;
  }

  private pointFromClient(clientX: number, clientY: number): { row: number; col: number } | null {
    const frame = this.currentFrame();
    if (!frame) return null;
    const bounds = this.canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      col: Math.max(0, Math.min(frame.width - 1, Math.floor((clientX - bounds.left) / SEMANTIC_CELL_WIDTH_CSS_PX))),
      row: Math.max(0, Math.min(frame.height - 1, Math.floor((clientY - bounds.top) / SEMANTIC_CELL_HEIGHT_CSS_PX))),
    };
  }

  private selectionRange(): { start: { row: number; col: number }; end: { row: number; col: number } } | null {
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

  private syncBackingStore(presentation = this.latest): { cssWidth: number; cssHeight: number; dpr: number } {
    const host = this.canvas.parentElement;
    const cssWidth = Math.max(1, host?.clientWidth || this.canvas.clientWidth || (presentation?.frame.width ?? 1) * 9);
    const cssHeight = Math.max(1, host?.clientHeight || this.canvas.clientHeight || (presentation?.frame.height ?? 1) * 18);
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
    const backingWidth = Math.round(cssWidth * dpr);
    const backingHeight = Math.round(cssHeight * dpr);
    // Backing assignments clear old pixels. Deduplicate exact observer repeats
    // so a drag does not continually recreate the drawing surface.
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.background = '#0b0f14';
    return { cssWidth, cssHeight, dpr };
  }
}

const ANSI16 = ['#000000', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf', '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];

function resolveColor(value: string | undefined, fallback: string): string {
  if (!value || value === 'default') return fallback;
  if (value.startsWith('rgb:')) return `#${value.slice(4)}`;
  if (value.startsWith('indexed:')) {
    const index = Number(value.slice(8));
    return ANSI16[index] ?? fallback;
  }
  return fallback;
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
