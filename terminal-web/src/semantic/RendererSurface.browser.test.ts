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
});
