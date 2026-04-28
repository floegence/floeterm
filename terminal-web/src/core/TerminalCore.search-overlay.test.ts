// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalCore } from './TerminalCore';

describe('TerminalCore search overlay metrics', () => {
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      scale: vi.fn(),
      setTransform: vi.fn(),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('sizes the overlay in terminal-local pixels when an ancestor transform scales the canvas rect', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 1055, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 607, configurable: true });
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 474.75,
        bottom: 273.15,
        width: 474.75,
        height: 273.15,
        toJSON: () => undefined,
      }),
    });

    const termCanvas = document.createElement('canvas');
    termCanvas.width = 2080;
    termCanvas.height = 1190;
    termCanvas.style.width = '1040px';
    termCanvas.style.height = '595px';
    container.appendChild(termCanvas);
    Object.defineProperty(termCanvas, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 468,
        bottom: 267.75,
        width: 468,
        height: 267.75,
        toJSON: () => undefined,
      }),
    });

    const core = new TerminalCore(container, {});
    (core as unknown as {
      terminal: { renderer: { getCanvas: () => HTMLCanvasElement } };
    }).terminal = {
      renderer: {
        getCanvas: () => termCanvas,
      },
    };

    const overlay = (core as unknown as {
      ensureSearchOverlay: () => {
        canvas: HTMLCanvasElement;
        cssWidth: number;
        cssHeight: number;
        dpr: number;
      } | null;
    }).ensureSearchOverlay();

    expect(overlay).not.toBeNull();
    expect(overlay?.cssWidth).toBeCloseTo(1040, 3);
    expect(overlay?.cssHeight).toBeCloseTo(595, 3);
    expect(overlay?.dpr).toBeCloseTo(2, 3);
    expect(overlay?.canvas.style.width).toBe(`${overlay?.cssWidth}px`);
    expect(overlay?.canvas.style.height).toBe(`${overlay?.cssHeight}px`);
    expect(overlay?.canvas.width).toBe(2080);
    expect(overlay?.canvas.height).toBe(1190);
  });
});
