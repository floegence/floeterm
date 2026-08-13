import type { SemanticPresentation } from './presentation.js';

export class RendererSurface {
  private lastSequence = 0;
  constructor(private readonly canvas: HTMLCanvasElement) {}
  apply(presentation: SemanticPresentation): void {
    if (presentation.sequence <= this.lastSequence) return;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('2D terminal renderer unavailable');
    const cellWidth = 9, cellHeight = 18;
    this.canvas.width = presentation.frame.width * cellWidth;
    this.canvas.height = presentation.frame.height * cellHeight;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.font = '14px monospace'; context.textBaseline = 'top'; context.fillStyle = '#e5e7eb';
    presentation.frame.rows.forEach((row, y) => row.cells.forEach((cell, x) => { if (cell.text) context.fillText(cell.text, x * cellWidth, y * cellHeight); }));
    this.lastSequence = presentation.sequence;
  }
}
