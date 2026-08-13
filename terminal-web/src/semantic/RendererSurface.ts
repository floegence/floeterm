import type { SemanticPresentation } from './presentation.js';

export class RendererSurface {
  private lastSequence = 0;
  private latest: SemanticPresentation | null = null;
  constructor(private readonly canvas: HTMLCanvasElement) {}
  apply(presentation: SemanticPresentation): void {
    if (presentation.sequence < this.lastSequence) return;
    this.latest = presentation;
    this.render(presentation);
  }
  resize(): void {
    if (this.latest) this.render(this.latest);
  }
  private render(presentation: SemanticPresentation): void {
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('2D terminal renderer unavailable');
    const bounds = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, bounds.width || this.canvas.clientWidth || presentation.frame.width * 9);
    const cssHeight = Math.max(1, bounds.height || this.canvas.clientHeight || presentation.frame.height * 18);
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cellWidth = cssWidth / presentation.frame.width;
    const cellHeight = cssHeight / presentation.frame.height;
    context.clearRect(0, 0, cssWidth, cssHeight);
    context.fillStyle = '#0b0f14';
    context.fillRect(0, 0, cssWidth, cssHeight);
    context.font = `${Math.max(1, Math.floor(cellHeight * 0.78))}px monospace`;
    context.textBaseline = 'alphabetic';
    presentation.frame.rows.forEach((row, y) => row.cells.forEach((cell, x) => {
      const background = resolveColor(cell.style?.background, '#0b0f14');
      context.fillStyle = background;
      context.fillRect(x * cellWidth, y * cellHeight, cellWidth + 0.5, cellHeight + 0.5);
      if (cell.text) {
        context.fillStyle = resolveColor(cell.style?.foreground, '#e5e7eb');
        context.fillText(cell.text, x * cellWidth, (y + 0.82) * cellHeight);
      }
    }));
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
