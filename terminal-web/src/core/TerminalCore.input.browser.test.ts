import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

import { TerminalCore } from './TerminalCore.js';

const settleFrames = async (count = 3): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
};

const writeTerminal = (core: TerminalCore, data: string): Promise<void> => (
  new Promise<void>((resolve) => core.write(data, resolve))
);

describe('TerminalCore transformed-host input integration', () => {
  let core: TerminalCore | null = null;

  afterEach(() => {
    core?.dispose();
    core = null;
    document.body.replaceChildren();
  });

  it('keeps canvas focus from scrolling a transformed terminal host', async () => {
    const frame = document.createElement('div');
    frame.style.position = 'fixed';
    frame.style.left = '48px';
    frame.style.top = '48px';
    frame.style.width = '480px';
    frame.style.height = '360px';
    frame.style.overflow = 'hidden';

    const projection = document.createElement('div');
    projection.style.width = '824px';
    projection.style.height = '667px';
    projection.style.transform = 'scale(0.45)';
    projection.style.transformOrigin = 'top left';

    const container = document.createElement('div');
    container.style.width = '824px';
    container.style.height = '667px';

    projection.appendChild(container);
    frame.appendChild(projection);
    document.body.appendChild(frame);

    const onData = vi.fn();
    core = new TerminalCore(
      container,
      {
        cols: 103,
        rows: 47,
        fixedDimensions: { cols: 103, rows: 47 },
        fontSize: 12,
        rendererType: 'canvas',
      },
      { onData },
    );
    await core.initialize();
    await writeTerminal(core, [
      '\x1b[2J\x1b[H',
      'top - 12:00:00 up 1 day,  load average: 0.10, 0.08, 0.05\r\n',
      'Tasks: 120 total, 1 running, 119 sleeping\r\n',
      '%Cpu(s): 2.0 us, 1.0 sy, 97.0 id\r\n',
      'MiB Mem : 16384 total, 8192 free, 4096 used, 4096 buff/cache',
      '\x1b[41;91H',
    ].join(''));
    core.focus();
    await settleFrames();

    const textarea = document.querySelector('textarea[aria-label="Terminal input"]');
    const canvas = container.querySelector('canvas');
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    if (!(textarea instanceof HTMLTextAreaElement) || !(canvas instanceof HTMLCanvasElement)) return;

    const renderHost = canvas.parentElement;
    expect(renderHost).toBeInstanceOf(HTMLElement);
    if (!(renderHost instanceof HTMLElement)) return;

    const dimensions = core.getDimensions();
    const canvasRect = canvas.getBoundingClientRect();
    const inputRect = textarea.getBoundingClientRect();
    const expectedCellWidth = canvasRect.width / dimensions.cols;
    const expectedCellHeight = canvasRect.height / dimensions.rows;
    const expectedLeft = canvasRect.left + 90 * expectedCellWidth;
    const expectedTop = canvasRect.top + 40 * expectedCellHeight;

    expect(textarea.parentElement).toBe(document.body);
    expect(Math.abs(inputRect.left - expectedLeft)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(inputRect.top - expectedTop)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(inputRect.width - expectedCellWidth)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(inputRect.height - expectedCellHeight)).toBeLessThanOrEqual(0.5);
    expect(renderHost.scrollWidth).toBe(renderHost.clientWidth);
    expect(renderHost.scrollHeight).toBe(renderHost.clientHeight);

    renderHost.scrollTo(0, 0);
    const containerRectBefore = container.getBoundingClientRect();
    const canvasRectBefore = canvas.getBoundingClientRect();
    const canvasOffsetBefore = {
      left: canvasRectBefore.left - containerRectBefore.left,
      top: canvasRectBefore.top - containerRectBefore.top,
    };
    const canvasSizeBefore = {
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
      width: canvas.width,
      height: canvas.height,
    };

    await page.elementLocator(canvas).click();
    await settleFrames();

    const containerRectAfter = container.getBoundingClientRect();
    const canvasRectAfter = canvas.getBoundingClientRect();
    expect(document.activeElement).toBe(textarea);
    expect(renderHost.scrollLeft).toBe(0);
    expect(renderHost.scrollTop).toBe(0);
    expect(canvasRectAfter.left - containerRectAfter.left).toBeCloseTo(canvasOffsetBefore.left, 3);
    expect(canvasRectAfter.top - containerRectAfter.top).toBeCloseTo(canvasOffsetBefore.top, 3);
    expect(canvasRectAfter.left - containerRectAfter.left).toBeGreaterThanOrEqual(0);
    expect(canvasRectAfter.top - containerRectAfter.top).toBeGreaterThanOrEqual(0);
    expect({
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
      width: canvas.width,
      height: canvas.height,
    }).toEqual(canvasSizeBefore);

    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea.value = '你';
    textarea.dispatchEvent(new CompositionEvent('compositionend', {
      bubbles: true,
      data: '你',
    }));
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenLastCalledWith('你');

    const contextClientX = canvasRectAfter.left + 80;
    const contextClientY = canvasRectAfter.top + 70;
    canvas.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: contextClientX,
      clientY: contextClientY,
    }));

    const transientRect = textarea.getBoundingClientRect();
    expect(textarea.style.pointerEvents).toBe('auto');
    expect(textarea.style.zIndex).toBe('1000');
    expect(Math.abs(transientRect.left - contextClientX)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(transientRect.top - contextClientY)).toBeLessThanOrEqual(0.5);
    expect(renderHost.scrollLeft).toBe(0);
    expect(renderHost.scrollTop).toBe(0);
  });
});
