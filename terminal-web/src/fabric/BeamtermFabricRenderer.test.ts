// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeamtermFabricRenderer, formatHexColor } from './BeamtermFabricRenderer';
import type { Logger } from '../types';

const rendererState = vi.hoisted(() => ({
  main: vi.fn(),
  resize: vi.fn(),
  free: vi.fn(),
  render: vi.fn(),
  cellSizeFree: vi.fn(),
  terminalSizeFree: vi.fn(),
  terminalCols: 80,
  terminalRows: 20,
}));

vi.mock('@beamterm/renderer', () => {
  class CellStyle {
    fg() { return this; }
    bg() { return this; }
    bold() { return this; }
    italic() { return this; }
    underline() { return this; }
    strikethrough() { return this; }
  }

  class Cell {
    constructor(
      readonly symbol: string,
      readonly style: CellStyle,
    ) {}
  }

  class BeamtermRenderer {
    static withDynamicAtlas() {
      return new BeamtermRenderer();
    }

    free() {
      rendererState.free();
    }

    resize(width: number, height: number) {
      rendererState.resize(width, height);
    }

    cellSize() {
      return {
        width: 10,
        height: 20,
        free: rendererState.cellSizeFree,
      };
    }

    terminalSize() {
      return {
        cols: rendererState.terminalCols,
        rows: rendererState.terminalRows,
        free: rendererState.terminalSizeFree,
      };
    }

    batch() {
      return {
        clear: vi.fn(),
        cell: vi.fn(),
      };
    }

    render() {
      rendererState.render();
    }

    replaceWithDynamicAtlas() {}
  }

  return {
    main: rendererState.main,
    style: () => new CellStyle(),
    Cell,
    BeamtermRenderer,
  };
});

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('BeamtermFabricRenderer', () => {
  beforeEach(() => {
    rendererState.main.mockResolvedValue(undefined);
    rendererState.resize.mockReset();
    rendererState.free.mockClear();
    rendererState.render.mockClear();
    rendererState.cellSizeFree.mockClear();
    rendererState.terminalSizeFree.mockClear();
    rendererState.terminalCols = 80;
    rendererState.terminalRows = 20;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as RenderingContext);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('formats renderer colors as stable css hex values', () => {
    expect(formatHexColor(0x1a2b3c)).toBe('#1a2b3c');
    expect(formatHexColor(-1)).toBe('#000000');
    expect(formatHexColor(0xffffff + 1)).toBe('#ffffff');
  });

  it('keeps the full WebGL surface on the terminal theme background', async () => {
    const host = document.createElement('div');
    host.style.backgroundColor = 'rgb(1, 2, 3)';
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 401, configurable: true });
    document.body.appendChild(host);

    const renderer = new BeamtermFabricRenderer();
    await renderer.initialize({
      container: host,
      logger,
      fontFamily: 'monospace',
      fontSize: 12,
      theme: {
        background: '#0b0f14',
        foreground: '#c9d1d9',
      },
      getGhosttyCanvas: () => null,
      focusInputSurface: vi.fn(),
      forwardWheel: vi.fn(),
    });

    const canvas = host.querySelector('canvas');
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(host.style.backgroundColor).toBe('rgb(11, 15, 20)');
    expect(canvas?.style.backgroundColor).toBe('rgb(11, 15, 20)');

    renderer.setAppearance({
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
      },
    });

    expect(host.style.backgroundColor).toBe('rgb(26, 27, 38)');
    expect(canvas?.style.backgroundColor).toBe('rgb(26, 27, 38)');

    renderer.dispose();

    expect(host.style.backgroundColor).toBe('rgb(1, 2, 3)');
  });

  it('reports geometry in css pixels while Beamterm owns the HiDPI backing store', async () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });
    document.body.appendChild(host);

    rendererState.resize.mockImplementation((_width: number, _height: number) => {
      const canvas = host.querySelector('canvas');
      if (canvas) {
        canvas.width = 1600;
        canvas.height = 800;
      }
    });
    rendererState.terminalCols = 160;
    rendererState.terminalRows = 40;

    const renderer = new BeamtermFabricRenderer();
    await renderer.initialize({
      container: host,
      logger,
      fontFamily: 'monospace',
      fontSize: 12,
      theme: {
        background: '#0b0f14',
        foreground: '#c9d1d9',
      },
      getGhosttyCanvas: () => null,
      focusInputSurface: vi.fn(),
      forwardWheel: vi.fn(),
    });

    expect(renderer.getGeometry()).toMatchObject({
      width: 800,
      height: 400,
      cellWidth: 5,
      cellHeight: 10,
      cols: 160,
      rows: 40,
    });

    renderer.dispose();
  });
});
