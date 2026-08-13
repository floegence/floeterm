import type { SemanticPresentation } from './presentation.js';

export class RendererSurface {
  private lastSequence = 0;
  private latest: SemanticPresentation | null = null;
  private animationFrame: number | null = null;
  constructor(private readonly canvas: HTMLCanvasElement) {}
  apply(presentation: SemanticPresentation): void {
    if (presentation.sequence < Math.max(this.lastSequence, this.latest?.sequence ?? 0)) return;
    this.latest = presentation;
    this.scheduleRender();
  }
  resize(): void {
    this.scheduleRender();
  }
  dispose(): void {
    if (this.animationFrame !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.animationFrame);
    }
    this.animationFrame = null;
    this.latest = null;
  }
  private scheduleRender(): void {
    if (!this.latest || this.animationFrame !== null) return;
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      this.render(this.latest);
      return;
    }
    this.animationFrame = globalThis.requestAnimationFrame(() => {
      this.animationFrame = null;
      if (this.latest) this.render(this.latest);
    });
  }
  private render(presentation: SemanticPresentation): void {
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('2D terminal renderer unavailable');
    // The canvas owns its backing store, but its containing pane owns the
    // layout bounds. Reading the canvas rect after writing inline dimensions
    // would make a resize self-referential and preserve the old viewport.
    const host = this.canvas.parentElement;
    const cssWidth = Math.max(1, host?.clientWidth || this.canvas.clientWidth || presentation.frame.width * 9);
    const cssHeight = Math.max(1, host?.clientHeight || this.canvas.clientHeight || presentation.frame.height * 18);
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
    const backingWidth = Math.round(cssWidth * dpr);
    const backingHeight = Math.round(cssHeight * dpr);
    // Assigning a backing dimension clears the canvas and may recreate its
    // graphics resources. ResizeObserver can repeat the same size while the
    // browser window is being dragged, so only reallocate on a real change.
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;
    // Layout remains percentage-based so the browser can resize the visible
    // surface before ResizeObserver schedules the next backing-store update.
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cellWidth = cssWidth / presentation.frame.width;
    const cellHeight = cssHeight / presentation.frame.height;
    context.clearRect(0, 0, cssWidth, cssHeight);
    context.fillStyle = '#0b0f14';
    context.fillRect(0, 0, cssWidth, cssHeight);
    context.font = `${Math.max(1, Math.floor(cellHeight * 0.78))}px monospace`;
    context.textBaseline = 'alphabetic';
    presentation.frame.rows.forEach((row, y) => {
      row.cells.forEach((cell, x) => {
        const background = resolveColor(cell.style?.background, '#0b0f14');
        context.fillStyle = background;
        context.fillRect(x * cellWidth, y * cellHeight, cellWidth + 0.5, cellHeight + 0.5);
      });
      row.cells.forEach((cell, x) => {
        if (!cell.text) return;
        context.fillStyle = resolveColor(cell.style?.foreground, '#e5e7eb');
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
    this.lastSequence = presentation.sequence;
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
