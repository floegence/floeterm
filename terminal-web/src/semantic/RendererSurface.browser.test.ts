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

const hexToRgb = (hex: string): number[] => {
  const value = hex.replace(/^#/, '');
  return [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16));
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('semantic terminal browser surface', () => {
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

  it('anchors a real editable bridge at the semantic cursor and commits IME once', async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;width:180px;height:90px';
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
      const cursor = renderer.getCursorClientRect();
      const bounds = host.getBoundingClientRect();
      if (!cursor) return;
      input.style.left = `${cursor.left - bounds.left}px`;
      input.style.top = `${cursor.top - bounds.top}px`;
    };
    const emitted: string[] = [];
    const bridge = new TerminalInputBridge({ inputHost: host, inputElement: input, onData: data => emitted.push(data), syncInputGeometry });
    bridge.focus();

    const cursor = renderer.getCursorClientRect();
    const anchor = input.getBoundingClientRect();
    expect(cursor).not.toBeNull();
    expect(Math.abs(anchor.left - cursor!.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(anchor.top - cursor!.top)).toBeLessThanOrEqual(1);
    expect(cursor).toMatchObject({ width: metrics.cellWidthCssPx, height: metrics.cellHeightCssPx });
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
});
