// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeamtermFabricRenderer, formatHexColor } from './BeamtermFabricRenderer';
import type { Logger } from '../types';

const rendererState = vi.hoisted(() => ({
  main: vi.fn(),
  resize: vi.fn(),
  free: vi.fn(),
  render: vi.fn(),
  withDynamicAtlasCanvas: vi.fn(),
  batch: vi.fn(),
  batchClear: vi.fn(),
  batchText: vi.fn(),
  batchFill: vi.fn(),
  batchCell: vi.fn(),
  batchFree: vi.fn(),
  cellSizeFree: vi.fn(),
  terminalSizeFree: vi.fn(),
  replaceWithDynamicAtlas: vi.fn(),
  setCanvasPaddingColor: vi.fn(),
  terminalCols: 80,
  terminalRows: 20,
}));

vi.mock('@floegence/beamterm-renderer', () => {
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

    static withDynamicAtlasCanvas(...args: unknown[]) {
      rendererState.withDynamicAtlasCanvas(...args);
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
      rendererState.batch();
      return {
        clear: rendererState.batchClear,
        text: rendererState.batchText,
        fill: rendererState.batchFill,
        cell: rendererState.batchCell,
        free: rendererState.batchFree,
      };
    }

    render() {
      rendererState.render();
    }

    replaceWithDynamicAtlas(...args: unknown[]) {
      rendererState.replaceWithDynamicAtlas(...args);
    }

    setCanvasPaddingColor(color: number) {
      rendererState.setCanvasPaddingColor(color);
    }
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

const finishSubmittedGpuWork = vi.fn();

describe('BeamtermFabricRenderer', () => {
  beforeEach(() => {
    rendererState.main.mockResolvedValue(undefined);
    rendererState.resize.mockReset();
    rendererState.free.mockClear();
    rendererState.render.mockClear();
    rendererState.withDynamicAtlasCanvas.mockClear();
    rendererState.batch.mockClear();
    rendererState.batchClear.mockClear();
    rendererState.batchText.mockClear();
    rendererState.batchFill.mockClear();
    rendererState.batchCell.mockClear();
    rendererState.batchFree.mockClear();
    rendererState.cellSizeFree.mockClear();
    rendererState.terminalSizeFree.mockClear();
    rendererState.replaceWithDynamicAtlas.mockClear();
    rendererState.setCanvasPaddingColor.mockClear();
    rendererState.terminalCols = 80;
    rendererState.terminalRows = 20;
    finishSubmittedGpuWork.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      finish: finishSubmittedGpuWork,
    } as unknown as RenderingContext);
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

  it('finishes submitted WebGL work only when explicitly requested', async () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });
    document.body.appendChild(host);
    const renderer = new BeamtermFabricRenderer();
    await renderer.initialize({
      container: host,
      logger,
      fontFamily: 'monospace',
      fontSize: 12,
      theme: { background: '#0b0f14', foreground: '#c9d1d9' },
      getGhosttyCanvas: () => null,
      focusInputSurface: vi.fn(),
      forwardWheel: vi.fn(),
      onRendererError: vi.fn(),
    });

    expect(finishSubmittedGpuWork).not.toHaveBeenCalled();
    renderer.finishSubmittedFrame();
    expect(finishSubmittedGpuWork).toHaveBeenCalledTimes(1);
    renderer.dispose();
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
      onRendererError: vi.fn(),
    });

    const canvas = host.querySelector('canvas');
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(rendererState.withDynamicAtlasCanvas).toHaveBeenCalledWith(
      canvas,
      ['monospace'],
      12,
      false,
    );
    expect(rendererState.setCanvasPaddingColor).toHaveBeenLastCalledWith(0x0b0f14);
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
    expect(rendererState.setCanvasPaddingColor).toHaveBeenLastCalledWith(0x1a1b26);

    renderer.dispose();

    expect(host.style.backgroundColor).toBe('rgb(1, 2, 3)');
  });

  it('paints renderer cells outside a smaller shared source grid with the theme background', async () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });
    document.body.appendChild(host);
    rendererState.terminalCols = 80;
    rendererState.terminalRows = 20;

    const renderer = new BeamtermFabricRenderer();
    await renderer.initialize({
      container: host,
      logger,
      fontFamily: 'monospace',
      fontSize: 12,
      theme: { background: '#0b0f14', foreground: '#c9d1d9' },
      getGhosttyCanvas: () => null,
      focusInputSurface: vi.fn(),
      forwardWheel: vi.fn(),
      onRendererError: vi.fn(),
    });
    rendererState.batchFill.mockClear();

    renderer.startFrame({ id: 1, forceAll: false, reason: 'write', startedAtMs: 0 }, {
      cols: 60,
      rows: 10,
      theme: { background: 0x0b0f14, foreground: 0xc9d1d9 },
    });

    expect(rendererState.batchFill).toHaveBeenCalledTimes(2);
    expect(rendererState.batchFill).toHaveBeenNthCalledWith(1, 60, 0, 20, 10, expect.objectContaining({ symbol: ' ' }));
    expect(rendererState.batchFill).toHaveBeenNthCalledWith(2, 0, 10, 80, 10, expect.objectContaining({ symbol: ' ' }));
    renderer.finishFrame(null);

    rendererState.batchFill.mockClear();
    renderer.startFrame({ id: 2, forceAll: false, reason: 'write', startedAtMs: 1 }, {
      cols: 60,
      rows: 10,
      theme: { background: 0x0b0f14, foreground: 0xc9d1d9 },
    });
    expect(rendererState.batchFill).not.toHaveBeenCalled();
    renderer.finishFrame(null);

    rendererState.batchFill.mockClear();
    renderer.resize(900, 500);
    expect(rendererState.batchFill).toHaveBeenCalledTimes(2);

    rendererState.batchFill.mockClear();
    renderer.startFrame({ id: 3, forceAll: false, reason: 'resize', startedAtMs: 2 }, {
      cols: 60,
      rows: 10,
      theme: { background: 0x0b0f14, foreground: 0xc9d1d9 },
    });
    expect(rendererState.batchFill).not.toHaveBeenCalled();
    renderer.finishFrame(null);
    renderer.dispose();
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
      onRendererError: vi.fn(),
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

  it('repaints the retained grid immediately after canvas resize', async () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });
    document.body.appendChild(host);

    const renderer = new BeamtermFabricRenderer();
    await renderer.initialize({
      container: host,
      logger,
      fontFamily: 'monospace',
      fontSize: 12,
      theme: { background: '#0b0f14', foreground: '#c9d1d9' },
      getGhosttyCanvas: () => null,
      focusInputSurface: vi.fn(),
      forwardWheel: vi.fn(),
      onRendererError: vi.fn(),
    });
    rendererState.resize.mockClear();
    rendererState.render.mockClear();

    renderer.resize(640, 320);

    expect(rendererState.resize).toHaveBeenCalledWith(640, 320);
    expect(rendererState.render).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });

  it('does not clear retained content when a force frame produces no source rows', async () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });
    document.body.appendChild(host);

    const renderer = new BeamtermFabricRenderer();
    await renderer.initialize({
      container: host,
      logger,
      fontFamily: 'monospace',
      fontSize: 12,
      theme: { background: '#0b0f14', foreground: '#c9d1d9' },
      getGhosttyCanvas: () => null,
      focusInputSurface: vi.fn(),
      forwardWheel: vi.fn(),
      onRendererError: vi.fn(),
    });
    rendererState.batchClear.mockClear();

    renderer.startFrame({ id: 1, forceAll: true, reason: 'resize', startedAtMs: 0 }, {
      cols: 80,
      rows: 20,
      theme: { background: 0x0b0f14, foreground: 0xc9d1d9 },
    });
    renderer.finishFrame(null);

    expect(rendererState.batchClear).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('keeps repeated activation appearance updates idempotent', async () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });
    document.body.appendChild(host);

    const renderer = new BeamtermFabricRenderer();
    await renderer.initialize({
      container: host,
      logger,
      fontFamily: '"Iosevka", monospace',
      fontSize: 12,
      theme: { background: '#000000', foreground: '#ffffff' },
      getGhosttyCanvas: () => null,
      focusInputSurface: vi.fn(),
      forwardWheel: vi.fn(),
      onRendererError: vi.fn(),
    });

    renderer.setAppearance({ fontFamily: '"Iosevka", monospace', fontSize: 12 });
    expect(rendererState.replaceWithDynamicAtlas).not.toHaveBeenCalled();

    renderer.setAppearance({ fontFamily: '"Iosevka", monospace', fontSize: 14 });
    expect(rendererState.replaceWithDynamicAtlas).toHaveBeenCalledTimes(1);
    expect(rendererState.replaceWithDynamicAtlas).toHaveBeenLastCalledWith(['Iosevka', 'monospace'], 14);

    renderer.setAppearance({ fontFamily: '"Iosevka", monospace', fontSize: 14 });
    expect(rendererState.replaceWithDynamicAtlas).toHaveBeenCalledTimes(1);

    renderer.dispose();
  });

  it('uses one batch per frame with text runs, blank fills, and complex cells', async () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });
    document.body.appendChild(host);
    const renderer = new BeamtermFabricRenderer();
    await renderer.initialize({
      container: host,
      logger,
      fontFamily: 'monospace',
      fontSize: 12,
      theme: { background: '#000000', foreground: '#ffffff' },
      getGhosttyCanvas: () => null,
      focusInputSurface: vi.fn(),
      forwardWheel: vi.fn(),
      onRendererError: vi.fn(),
    });
    rendererState.render.mockClear();

    renderer.startFrame({ id: 1, forceAll: true, reason: 'write', startedAtMs: 0 }, {
      cols: 5,
      rows: 1,
      theme: { background: 0x112233, foreground: 0xffffff },
    });
    renderer.writeRow({
      currentBuffer: { getGraphemeString: () => '中' },
    }, 0, [
      { codepoint: 65, width: 1, fg_r: 255, fg_g: 255, fg_b: 255, bg_r: 0, bg_g: 0, bg_b: 0 },
      { codepoint: 66, width: 1, fg_r: 255, fg_g: 255, fg_b: 255, bg_r: 0, bg_g: 0, bg_b: 0 },
      { codepoint: 32, width: 1, fg_r: 255, fg_g: 255, fg_b: 255, bg_r: 0, bg_g: 0, bg_b: 0 },
      { codepoint: 32, width: 1, fg_r: 255, fg_g: 255, fg_b: 255, bg_r: 0, bg_g: 0, bg_b: 0 },
      { codepoint: 0, width: 2, grapheme_len: 1, fg_r: 255, fg_g: 255, fg_b: 255, bg_r: 0, bg_g: 0, bg_b: 0 },
    ], 5);
    renderer.finishFrame(null);

    expect(rendererState.batch).toHaveBeenCalledTimes(1);
    expect(rendererState.setCanvasPaddingColor).toHaveBeenLastCalledWith(0x112233);
    expect(rendererState.batchClear).toHaveBeenCalledWith(0x112233);
    expect(rendererState.batchText).toHaveBeenCalledWith(0, 0, 'AB', expect.anything());
    expect(rendererState.batchFill).toHaveBeenCalledWith(2, 0, 2, 1, expect.anything());
    expect(rendererState.batchCell).toHaveBeenCalledWith(4, 0, expect.objectContaining({ symbol: '中' }));
    expect(rendererState.render).toHaveBeenCalledTimes(1);
    expect(rendererState.batchFree).toHaveBeenCalledTimes(1);

    renderer.dispose();
  });

  it('preserves both halves of adjacent wide glyphs without painting their continuation cells', async () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });
    document.body.appendChild(host);
    const renderer = new BeamtermFabricRenderer();
    await renderer.initialize({
      container: host,
      logger,
      fontFamily: 'monospace',
      fontSize: 12,
      theme: { background: '#000000', foreground: '#ffffff' },
      getGhosttyCanvas: () => null,
      focusInputSurface: vi.fn(),
      forwardWheel: vi.fn(),
      onRendererError: vi.fn(),
    });

    renderer.startFrame({ id: 1, forceAll: true, reason: 'write', startedAtMs: 0 }, {
      cols: 6,
      rows: 1,
      theme: { background: 0x000000, foreground: 0xffffff },
    });
    renderer.writeRow({
      currentBuffer: {
        getGraphemeString: (_row, col) => ({ 1: '中', 3: '文' })[col] ?? '',
      },
    }, 0, [
      { codepoint: 65, width: 1, fg_r: 255, fg_g: 255, fg_b: 255, bg_r: 0, bg_g: 0, bg_b: 0 },
      { codepoint: 0, width: 2, grapheme_len: 1, fg_r: 255, fg_g: 255, fg_b: 255, bg_r: 0, bg_g: 0, bg_b: 0 },
      { codepoint: 0, width: 0, fg_r: 255, fg_g: 255, fg_b: 255, bg_r: 0, bg_g: 0, bg_b: 0 },
      { codepoint: 0, width: 2, grapheme_len: 1, fg_r: 255, fg_g: 255, fg_b: 255, bg_r: 0, bg_g: 0, bg_b: 0 },
      { codepoint: 0, width: 0, fg_r: 255, fg_g: 255, fg_b: 255, bg_r: 0, bg_g: 0, bg_b: 0 },
      { codepoint: 66, width: 1, fg_r: 255, fg_g: 255, fg_b: 255, bg_r: 0, bg_g: 0, bg_b: 0 },
    ], 6);
    renderer.finishFrame(null);

    expect(rendererState.batchCell).toHaveBeenCalledTimes(2);
    expect(rendererState.batchCell).toHaveBeenNthCalledWith(1, 1, 0, expect.objectContaining({ symbol: '中' }));
    expect(rendererState.batchCell).toHaveBeenNthCalledWith(2, 3, 0, expect.objectContaining({ symbol: '文' }));
    expect(rendererState.batchFill).not.toHaveBeenCalled();
    expect(rendererState.batchText).toHaveBeenNthCalledWith(1, 0, 0, 'A', expect.anything());
    expect(rendererState.batchText).toHaveBeenNthCalledWith(2, 5, 0, 'B', expect.anything());

    renderer.dispose();
  });
});
