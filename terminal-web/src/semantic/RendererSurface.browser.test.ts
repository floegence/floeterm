import { afterEach, describe, expect, it } from 'vitest';

import { TerminalInputBridge } from '../core/TerminalInputBridge.js';
import { getThemeColors } from '../utils/config.js';
import { RendererSurface } from './RendererSurface.js';
import { validatePresentation, type SemanticPresentation } from './presentation.js';

const nextPaint = async (): Promise<void> => {
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
};

const presentation = (): SemanticPresentation => validatePresentation({
  sequence: 1,
  geometry: { generation: 1, cols: 2, rows: 1 },
  state: { sequence: 1 },
  frame: {
    width: 2,
    height: 1,
    bufferKind: 'normal',
    history: { revision: 1, totalRows: 1, screenStartOffset: 0 },
    graphics: { generation: 0, images: [], placements: [] },
    rows: [{ cells: [
      { text: 'A', width: 1, style: { foreground: 'default', background: 'default' } },
      { text: '', width: 1 },
    ] }],
    cursor: { x: 1, y: 0, visible: true, shape: 'bar', blinking: false },
  },
});

const selectionPresentation = (): SemanticPresentation => validatePresentation({
  sequence: 1,
  geometry: { generation: 1, cols: 8, rows: 2 },
  state: { sequence: 1 },
  frame: {
    width: 8,
    height: 2,
    bufferKind: 'normal',
    history: { revision: 1, totalRows: 2, screenStartOffset: 0 },
    graphics: { generation: 0, images: [], placements: [] },
    rows: [
      { cells: [
        { text: 'A', width: 1 },
        { text: '中', width: 2 },
        { text: '', width: 0 },
        { text: 'e\u0301', width: 1 },
        { text: '👩‍💻', width: 2 },
        { text: '', width: 0 },
        { text: 'B', width: 1 },
        { text: 'C', width: 1 },
      ] },
      { cells: 'DEFGHIJK'.split('').map(text => ({ text, width: 1 })) },
    ],
    cursor: { x: 4, y: 1, visible: true, shape: 'bar', blinking: false },
  },
});

const hexToRgb = (hex: string): number[] => {
  const value = hex.replace(/^#/, '');
  return [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16));
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('semantic terminal browser surface', () => {
  it('paints every search occurrence and distinguishes the active occurrence', async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;width:180px;height:90px';
    const canvas = document.createElement('canvas');
    host.append(canvas);
    document.body.append(host);
    const renderer = new RendererSurface(canvas);
    renderer.apply(selectionPresentation());
    renderer.setSearchDecorations([
      { row: 0, startColumn: 0, endColumnExclusive: 1, active: false, matchId: 'ordinary' },
      { row: 0, startColumn: 3, endColumnExclusive: 5, active: true, matchId: 'active' },
    ]);
    await nextPaint();

    const context = canvas.getContext('2d')!;
    const metrics = renderer.getCellMetrics();
    const backingScaleX = canvas.width / canvas.clientWidth;
    const backingScaleY = canvas.height / canvas.clientHeight;
    const sample = (column: number) => context.getImageData(
      Math.floor((column * metrics.cellWidthCssPx + 1) * backingScaleX),
      Math.floor(metrics.cellHeightCssPx * 0.1 * backingScaleY),
      1,
      1,
    ).data;
    const native = sample(1);
    const ordinary = sample(0);
    const active = sample(3);
    expect(Array.from(ordinary)).not.toEqual(Array.from(native));
    expect(Array.from(active)).not.toEqual(Array.from(ordinary));

    const bounds = canvas.getBoundingClientRect();
    renderer.beginSelection(bounds.left + 1, bounds.top + 4);
    renderer.updateSelection(bounds.left + 7, bounds.top + 9);
    renderer.endSelection(bounds.left + 7, bounds.top + 9);
    await nextPaint();
    expect(renderer.getSelectionText()).toBe('A');
    expect(Array.from(sample(0).slice(0, 3))).toEqual(hexToRgb(getThemeColors('dark').selectionBackground));

    renderer.clearSelection();
    await nextPaint();
    expect(Array.from(sample(0))).toEqual(Array.from(ordinary));

    renderer.setPalette(getThemeColors('light'));
    await nextPaint();
    const lightNative = sample(1);
    const lightOrdinary = sample(0);
    const lightActive = sample(3);
    expect(Array.from(lightOrdinary)).not.toEqual(Array.from(lightNative));
    expect(Array.from(lightActive)).not.toEqual(Array.from(lightOrdinary));

    renderer.setPalette({
      ...getThemeColors('dark'),
      background: '#123456',
      foreground: '#f4f7fb',
      selectionBackground: '#d64a7f',
      selectionForeground: '#ffffff',
    });
    await nextPaint();
    const customNative = sample(1);
    const customOrdinary = sample(0);
    const customActive = sample(3);
    expect(Array.from(customOrdinary)).not.toEqual(Array.from(customNative));
    expect(Array.from(customActive)).not.toEqual(Array.from(customOrdinary));

    renderer.clearSearchDecorations();
    await nextPaint();
    expect(Array.from(sample(0))).toEqual(Array.from(sample(1)));

    renderer.dispose();
  });

  it('keeps history decorations during live output and drops stale live decorations', async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;width:180px;height:90px';
    const canvas = document.createElement('canvas');
    host.append(canvas);
    document.body.append(host);
    const renderer = new RendererSurface(canvas);
    const live = presentation();
    renderer.apply(live);
    renderer.setSearchDecorations([
      { row: 0, startColumn: 0, endColumnExclusive: 1, active: true, matchId: 'live' },
    ]);
    await nextPaint();

    const context = canvas.getContext('2d')!;
    const metrics = renderer.getCellMetrics();
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    const pixel = () => Array.from(context.getImageData(
      Math.floor(scaleX),
      Math.floor(metrics.cellHeightCssPx * 0.1 * scaleY),
      1,
      1,
    ).data);
    const decorated = pixel();

    const advancedLive = structuredClone(live);
    advancedLive.sequence = 2;
    advancedLive.state.sequence = 2;
    advancedLive.frame.history.revision = 2;
    advancedLive.frame.rows[0]!.cells[0]!.text = 'B';
    renderer.apply(validatePresentation(advancedLive));
    await nextPaint();
    expect(pixel()).not.toEqual(decorated);

    const history = structuredClone(advancedLive.frame);
    history.rows[0]!.cells[0]!.text = 'H';
    renderer.project(history);
    renderer.setSearchDecorations([
      { row: 0, startColumn: 0, endColumnExclusive: 1, active: false, matchId: 'history' },
    ]);
    await nextPaint();
    const historyDecorated = pixel();

    const nextLive = structuredClone(advancedLive);
    nextLive.sequence = 3;
    nextLive.state.sequence = 3;
    nextLive.frame.history.revision = 3;
    nextLive.frame.rows[0]!.cells[0]!.text = 'C';
    renderer.apply(validatePresentation(nextLive));
    await nextPaint();
    expect(pixel()).toEqual(historyDecorated);

    renderer.dispose();
  });

  it('keeps one canvas while DPR backing and view-local palette repaint atomically', async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;width:180px;height:90px';
    const canvas = document.createElement('canvas');
    host.append(canvas);
    document.body.append(host);
    const renderer = new RendererSurface(canvas);

    const dark = getThemeColors('dark');
    renderer.setPalette(dark);
    renderer.apply(presentation());
    await nextPaint();

    const bounds = host.getBoundingClientRect();
    expect(host.querySelectorAll('canvas')).toHaveLength(1);
    expect(canvas.width).toBe(Math.round(bounds.width * devicePixelRatio));
    expect(canvas.height).toBe(Math.round(bounds.height * devicePixelRatio));
    const context = canvas.getContext('2d');
    expect(context).not.toBeNull();
    const darkPixel = context!.getImageData(canvas.width - 1, canvas.height - 1, 1, 1).data;
    expect(Array.from(darkPixel.slice(0, 3))).toEqual(hexToRgb(dark.background));
    expect(darkPixel[3]).toBe(255);

    const light = getThemeColors('light');
    renderer.setPalette(light);
    await nextPaint();

    expect(host.querySelectorAll('canvas')).toHaveLength(1);
    expect(host.firstElementChild).toBe(canvas);
    expect(canvas.width).toBe(Math.round(bounds.width * devicePixelRatio));
    expect(canvas.height).toBe(Math.round(bounds.height * devicePixelRatio));
    const lightPixel = context!.getImageData(canvas.width - 1, canvas.height - 1, 1, 1).data;
    expect(Array.from(lightPixel.slice(0, 3))).toEqual(hexToRgb(light.background));
    expect(lightPixel[3]).toBe(255);

    renderer.dispose();
  });

  it('rejects a short history frame instead of exposing a partial viewport', async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;width:180px;height:90px';
    const canvas = document.createElement('canvas');
    host.append(canvas);
    document.body.append(host);
    const renderer = new RendererSurface(canvas);
    const palette = getThemeColors('dark');
    renderer.setPalette(palette);
    const live = presentation();
    live.geometry.rows = 2;
    live.frame.height = 2;
    live.frame.history = { revision: 1, totalRows: 2, screenStartOffset: 0 };
    live.frame.rows.push(structuredClone(live.frame.rows[0]!));
    renderer.apply(validatePresentation(live));
    await nextPaint();

    const history = structuredClone(presentation().frame);
    history.rows[0]!.cells[0]!.text = 'H';
    expect(() => renderer.project(history)).toThrow(/geometry/i);

    renderer.dispose();
  });

  it('keeps an immutable full history viewport while newer live presentations advance', async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;width:180px;height:90px';
    const canvas = document.createElement('canvas');
    host.append(canvas);
    document.body.append(host);
    const renderer = new RendererSurface(canvas);
    const live = presentation();
    live.geometry.rows = 2;
    live.frame.height = 2;
    live.frame.history = { revision: 1, totalRows: 2, screenStartOffset: 0 };
    live.frame.rows.push(structuredClone(live.frame.rows[0]!));
    renderer.apply(validatePresentation(live));

    const history = structuredClone(live.frame);
    history.rows[0]!.cells[0]!.text = 'H';
    renderer.project(history);

    const advanced = structuredClone(live);
    advanced.sequence = 2;
    advanced.state.sequence = 2;
    advanced.frame.history.revision = 2;
    advanced.frame.rows[0]!.cells[0]!.text = 'L';
    renderer.apply(validatePresentation(advanced));
    await nextPaint();

    const current = (renderer as unknown as { currentFrame(): typeof history }).currentFrame();
    expect(current.rows[0]!.cells[0]!.text).toBe('H');

    renderer.dispose();
  });

  it('preserves inverse cell colors when cursor blink repaints one cell', async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;width:180px;height:90px';
    const canvas = document.createElement('canvas');
    host.append(canvas);
    document.body.append(host);
    const renderer = new RendererSurface(canvas);
    const palette = getThemeColors('dark');
    renderer.setPalette(palette);
    const inverse = presentation();
    inverse.frame.rows[0]!.cells[0] = {
      text: 'A',
      width: 1,
      style: { foreground: 'default', background: 'default', inverse: true },
    };
    inverse.frame.cursor = { x: 0, y: 0, visible: true, shape: 'bar', blinking: true };
    renderer.apply(inverse);
    await nextPaint();

    const context = canvas.getContext('2d')!;
    const metrics = renderer.getCellMetrics();
    context.fillStyle = palette.background;
    context.fillRect(0, 0, metrics.cellWidthCssPx, metrics.cellHeightCssPx);
    (renderer as unknown as { repaintCursorCell(): void }).repaintCursorCell();

    const sampleX = Math.max(2, Math.floor(metrics.cellWidthCssPx) - 1);
    const pixel = context.getImageData(sampleX, 1, 1, 1).data;
    expect(Array.from(pixel.slice(0, 3))).toEqual(hexToRgb(palette.foreground));

    renderer.dispose();
  });

  it('anchors a real editable bridge at the semantic cursor and commits IME once', async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;width:180px;height:90px;transform-origin:0 0;transform:translate(23px, 17px) scale(0.35, 0.5)';
    const canvas = document.createElement('canvas');
    const input = document.createElement('textarea');
    input.setAttribute('aria-label', 'Terminal input');
    input.style.cssText = 'position:absolute;width:1px;height:18px;padding:0;border:0;opacity:0';
    host.append(canvas, input);
    document.body.append(host);
    const renderer = new RendererSurface(canvas);
    const metrics = renderer.setTypography({
      fontSizeCssPx: 16,
      fontFamily: 'monospace',
      lineHeightCssPx: 24,
    });
    renderer.apply(presentation());
    await nextPaint();

    const syncInputGeometry = (): void => {
      const cursor = renderer.getCursorLayoutRect();
      if (!cursor) return;
      input.style.left = `${cursor.left}px`;
      input.style.top = `${cursor.top}px`;
      input.style.width = `${cursor.width}px`;
      input.style.height = `${cursor.height}px`;
    };
    const emitted: string[] = [];
    const bridge = new TerminalInputBridge({ inputHost: host, inputElement: input, onData: data => emitted.push(data), syncInputGeometry });
    bridge.focus();

    const cursor = renderer.getCursorClientRect();
    const anchor = input.getBoundingClientRect();
    expect(cursor).not.toBeNull();
    expect(Math.abs(anchor.left - cursor!.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(anchor.top - cursor!.top)).toBeLessThanOrEqual(1);
    expect(cursor!.width).toBeCloseTo(metrics.cellWidthCssPx * 0.35, 3);
    expect(cursor!.height).toBeCloseTo(metrics.cellHeightCssPx * 0.5, 3);
    expect(host.querySelectorAll('canvas')).toHaveLength(1);

    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: 'zhong', inputType: 'insertCompositionText', isComposing: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: '中', inputType: 'insertText' }));
    input.value = '中';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中', inputType: 'insertText' }));

    expect(emitted).toEqual(['中']);
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);

    bridge.dispose();
    renderer.dispose();
  });

  it('never exposes a stale backing store while keep-mounted views become visible', async () => {
    const originalDpr = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
    const views = Array.from({ length: 3 }, () => {
      const host = document.createElement('div');
      host.style.cssText = 'display:none;position:relative;width:0;height:0';
      const canvas = document.createElement('canvas');
      host.append(canvas);
      document.body.append(host);
      const renderer = new RendererSurface(canvas);
      renderer.setVisible(false);
      renderer.apply(presentation());
      return { host, canvas, renderer };
    });
    await nextPaint();
    const metrics = views.map(view => view.renderer.getCellMetrics());
    const background = hexToRgb(getThemeColors('dark').background);

    try {
      for (let iteration = 0; iteration < 50; iteration += 1) {
        const dpr = [1, 1.5, 2][iteration % 3]!;
        Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: dpr });
        const activeIndex = iteration % views.length;
        views.forEach((view, index) => {
          const active = index === activeIndex;
          view.host.style.display = active ? 'block' : 'none';
          view.host.style.width = active ? `${360 + iteration}px` : '0';
          view.host.style.height = active ? `${180 + iteration}px` : '0';
          view.renderer.setVisible(active);
        });
        const active = views[activeIndex]!;
        const bounds = active.host.getBoundingClientRect();
        const canvasBounds = active.canvas.getBoundingClientRect();
        expect(active.canvas.style.visibility).toBe('visible');
        expect(canvasBounds.width).toBe(bounds.width);
        expect(canvasBounds.height).toBe(bounds.height);
        expect(active.canvas.width).toBe(Math.round(bounds.width * dpr));
        expect(active.canvas.height).toBe(Math.round(bounds.height * dpr));
        expect(active.renderer.getCellMetrics()).toEqual(metrics[activeIndex]);
        const pixel = active.canvas.getContext('2d')!.getImageData(
          active.canvas.width - 1, active.canvas.height - 1, 1, 1,
        ).data;
        expect(Array.from(pixel)).toEqual([...background, 255]);
        for (const [index, view] of views.entries()) {
          if (index !== activeIndex) expect(view.canvas.style.visibility).toBe('hidden');
        }
      }
    } finally {
      if (originalDpr) Object.defineProperty(globalThis, 'devicePixelRatio', originalDpr);
      else delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
    }

    views.forEach(view => view.renderer.dispose());
  });

  it('paints no selection for a click and preserves an intentional one-cell drag', async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;width:180px;height:90px';
    const canvas = document.createElement('canvas');
    host.append(canvas);
    document.body.append(host);
    const renderer = new RendererSurface(canvas);
    renderer.apply(presentation());
    await nextPaint();

    const bounds = canvas.getBoundingClientRect();
    renderer.beginSelection(bounds.left + 2, bounds.top + 4);
    renderer.endSelection(bounds.left + 2, bounds.top + 4);
    await nextPaint();
    expect(renderer.getSelectionText()).toBe('');

    renderer.beginSelection(bounds.left + 2, bounds.top + 4);
    renderer.updateSelection(bounds.left + 7, bounds.top + 9);
    renderer.endSelection(bounds.left + 7, bounds.top + 9);
    await nextPaint();
    expect(renderer.getSelectionText()).toBe('A');
    const pixel = canvas.getContext('2d')!.getImageData(1, 1, 1, 1).data;
    expect(Array.from(pixel.slice(0, 3))).toEqual(hexToRgb(getThemeColors('dark').selectionBackground));

    renderer.dispose();
  });

  it('maps transformed visual coordinates to logical cells and cursor anchors across DPR values', async () => {
    const originalDpr = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
    const transforms = [
      { value: 'translate(37px, 23px) scale(0.25)', scaleX: 0.25, scaleY: 0.25 },
      { value: 'translate(11px, 17px) scale(0.35)', scaleX: 0.35, scaleY: 0.35 },
      { value: 'translate(29px, 13px) scale(0.5)', scaleX: 0.5, scaleY: 0.5 },
      { value: 'translate(19px, 31px) scale(0.35, 0.5)', scaleX: 0.35, scaleY: 0.5 },
      { value: 'translate(7px, 5px) scale(1)', scaleX: 1, scaleY: 1 },
    ];

    try {
      for (const [index, transform] of transforms.entries()) {
        const dpr = [1, 1.5, 2][index % 3]!;
        Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: dpr });
        const host = document.createElement('div');
        host.style.cssText = `position:relative;width:180px;height:90px;transform-origin:0 0;transform:${transform.value}`;
        const canvas = document.createElement('canvas');
        host.append(canvas);
        document.body.append(host);
        const renderer = new RendererSurface(canvas);
        renderer.apply(selectionPresentation());
        await nextPaint();

        const bounds = canvas.getBoundingClientRect();
        const metrics = renderer.getCellMetrics();
        const scaleX = bounds.width / canvas.clientWidth;
        const scaleY = bounds.height / canvas.clientHeight;
        expect(scaleX).toBeCloseTo(transform.scaleX, 4);
        expect(scaleY).toBeCloseTo(transform.scaleY, 4);
        expect(canvas.width).toBe(Math.round(canvas.clientWidth * dpr));
        expect(canvas.height).toBe(Math.round(canvas.clientHeight * dpr));

        const point = (col: number, row: number, xFraction = 0.5, yFraction = 0.5) => ({
          x: bounds.left + ((col + xFraction) * metrics.cellWidthCssPx * scaleX),
          y: bounds.top + ((row + yFraction) * metrics.cellHeightCssPx * scaleY),
        });

        const reverseStart = point(6, 0);
        const reverseEnd = point(1, 0);
        renderer.beginSelection(reverseStart.x, reverseStart.y);
        renderer.updateSelection(reverseEnd.x, reverseEnd.y);
        renderer.endSelection(reverseEnd.x, reverseEnd.y);
        expect(renderer.getSelectionText()).toBe('中e\u0301👩‍💻B');

        renderer.clearSelection();
        const continuationStart = point(2, 0, 0.1, 0.1);
        const continuationEnd = point(2, 0, 0.9, 0.9);
        renderer.beginSelection(continuationStart.x, continuationStart.y);
        renderer.updateSelection(continuationEnd.x, continuationEnd.y);
        renderer.endSelection(continuationEnd.x, continuationEnd.y);
        expect(renderer.getSelectionText()).toBe('中');

        const padding = {
          x: bounds.left + (canvas.clientWidth - 1) * scaleX,
          y: bounds.top + metrics.cellHeightCssPx * 0.5 * scaleY,
        };
        renderer.beginSelection(padding.x, padding.y);
        renderer.updateSelection(padding.x + 4, padding.y);
        renderer.endSelection(padding.x + 4, padding.y);
        expect(renderer.getSelectionText()).toBe('');

        const cursor = renderer.getCursorClientRect();
        expect(cursor).not.toBeNull();
        expect(cursor!.left).toBeCloseTo(bounds.left + 4 * metrics.cellWidthCssPx * scaleX, 3);
        expect(cursor!.top).toBeCloseTo(bounds.top + metrics.cellHeightCssPx * scaleY, 3);
        expect(cursor!.width).toBeCloseTo(metrics.cellWidthCssPx * scaleX, 3);
        expect(cursor!.height).toBeCloseTo(metrics.cellHeightCssPx * scaleY, 3);

        renderer.dispose();
        host.remove();
      }
    } finally {
      if (originalDpr) Object.defineProperty(globalThis, 'devicePixelRatio', originalDpr);
      else delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
    }
  });
});
