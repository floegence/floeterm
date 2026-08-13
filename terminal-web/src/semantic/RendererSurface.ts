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
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onError: (error: Error) => void = () => {},
  ) {}
  apply(presentation: SemanticPresentation): void {
    if (this.failed) return;
    try {
      if (!presentationAdvances(this.latest, presentation)) return;
    } catch (error) {
      this.fail(error);
      return;
    }
    this.latest = presentation;
    this.viewportFrame = null;
    this.scheduleRender();
  }
  project(frame: SemanticFrame | null): void {
    if (frame && this.latest && (frame.width !== this.latest.frame.width || frame.height !== this.latest.frame.height)) {
      throw new Error('semantic history frame does not match the current presentation geometry');
    }
    this.viewportFrame = frame;
    this.clearSelection();
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
    // ResizeObserver runs after layout. Update the backing store immediately
    // from the host content box so the browser never stretches an old bitmap
    // across the new pane while the full paint waits for the next frame.
    this.renderGeneration += 1;
    this.syncBackingStore();
    this.scheduleRender();
  }
  dispose(): void {
    this.renderGeneration += 1;
    if (this.animationFrame !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.animationFrame);
    }
    this.animationFrame = null;
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
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('2D terminal renderer unavailable');
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
        context.fillStyle = this.isCellSelected(y, x)
          ? '#ffffff'
          : resolveColor(cell.style?.foreground, '#e5e7eb');
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
      });
    });
    void this.paintGraphics(context, frame, cellWidth, cellHeight, renderGeneration)
      .catch(error => this.fail(error));
  }

  private async paintGraphics(context: CanvasRenderingContext2D, frame: SemanticFrame, cellWidth: number, cellHeight: number, renderGeneration: number): Promise<void> {
    if (frame.graphics.images.length === 0 || frame.graphics.placements.length === 0) return;
    const bitmaps = new Map<number, ImageBitmap>();
    try {
      await Promise.all(frame.graphics.images.map(async image => {
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
        bitmaps.set(image.id, await createImageBitmap(imageData));
      }));
      if (renderGeneration !== this.renderGeneration) return;
      for (const placement of [...frame.graphics.placements].sort((left, right) => left.z - right.z)) {
        if (!placement.visible) continue;
        const bitmap = bitmaps.get(placement.imageId);
        if (!bitmap) continue;
        context.drawImage(bitmap, placement.viewportColumn * cellWidth, placement.viewportRow * cellHeight, placement.gridColumns * cellWidth, placement.gridRows * cellHeight);
      }
    } finally {
      for (const bitmap of bitmaps.values()) bitmap.close();
    }
  }

  private fail(cause: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.renderGeneration += 1;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.onError(error);
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
