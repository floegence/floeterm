import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { TerminalCore } from './TerminalCore';

const cores: TerminalCore[] = [];

const createHost = (): HTMLDivElement => {
  const host = document.createElement('div');
  Object.assign(host.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '800px',
    height: '400px',
  });
  document.body.appendChild(host);
  return host;
};

const write = (core: TerminalCore, data: string): Promise<void> => new Promise(resolve => {
  core.writeHistory(data, resolve);
});

const historyFixture = (count: number): string => Array.from(
  { length: count },
  (_, index) => `scrollbar-marker-${String(index).padStart(4, '0')}\r\n`,
).join('');

const nextFrame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));
const settleFrames = async (count = 3): Promise<void> => {
  for (let index = 0; index < count; index += 1) await nextFrame();
};

const pointerEvent = (
  type: string,
  values: { pointerId?: number; clientX: number; clientY: number },
): PointerEvent => new PointerEvent(type, {
  bubbles: true,
  cancelable: true,
  pointerId: values.pointerId ?? 1,
  pointerType: 'mouse',
  clientX: values.clientX,
  clientY: values.clientY,
});

afterEach(() => {
  for (const core of cores.splice(0)) core.dispose();
  document.body.replaceChildren();
});

describe('TerminalCore real scrollbar projection', () => {
  for (const rendererType of ['canvas', 'webgl'] as const) {
    it(`keeps one interactive DOM scrollbar in ${rendererType} mode`, async () => {
      const host = createHost();
      const core = new TerminalCore(host, {
        rendererType,
        fixedDimensions: { cols: 80, rows: 24 },
        scrollback: 1_000,
        smoothScrollDuration: 0,
        fit: { scrollbarReservePx: 15 },
        scrollbar: {
          visibility: 'persistent',
          ariaLabel: 'Terminal history',
        },
      });
      cores.push(core);
      await core.initialize();
      core.setConnected(true);
      await write(core, historyFixture(240));
      await core.forceResizeAndWaitForPresentation();

      const scrollbar = host.querySelector<HTMLElement>('[role="scrollbar"]');
      const thumb = host.querySelector<HTMLElement>('[data-floeterm-scrollbar-thumb]');
      expect(scrollbar).not.toBeNull();
      expect(thumb).not.toBeNull();
      expect(scrollbar?.hidden).toBe(false);
      expect(scrollbar?.dataset.visible).toBe('true');
      expect(scrollbar?.getAttribute('aria-label')).toBe('Terminal history');
      expect(Number(scrollbar?.getAttribute('aria-valuemax'))).toBeGreaterThan(0);
      expect(scrollbar?.getAttribute('aria-valuenow')).toBe(scrollbar?.getAttribute('aria-valuemax'));
      expect(scrollbar!.getBoundingClientRect().right).toBeLessThanOrEqual(host.getBoundingClientRect().right);
      expect(thumb!.getBoundingClientRect().height).toBeGreaterThan(0);

      const terminal = (core as unknown as { terminal: {
        element: HTMLElement;
        getViewportY(): number;
        getScrollbackLength(): number;
        onScroll(listener: () => void): { dispose(): void };
      } }).terminal;
      let scrollEvents = 0;
      const scrollListener = terminal.onScroll(() => { scrollEvents += 1; });

      await page.elementLocator(terminal.element).wheel({ direction: 'up', times: 2 });
      await settleFrames();
      expect(terminal.getViewportY()).toBeGreaterThan(0);
      expect(scrollEvents).toBeGreaterThan(0);

      scrollbar!.focus();
      const beforeHomeEvents = scrollEvents;
      scrollbar!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
      await settleFrames();
      expect(terminal.getViewportY()).toBe(terminal.getScrollbackLength());
      expect(scrollbar?.getAttribute('aria-valuenow')).toBe('0');
      expect(scrollEvents - beforeHomeEvents).toBe(1);

      scrollbar!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
      await settleFrames();
      expect(terminal.getViewportY()).toBe(0);
      expect(scrollbar?.getAttribute('aria-valuenow')).toBe(scrollbar?.getAttribute('aria-valuemax'));

      const hostRect = host.getBoundingClientRect();
      const beforeTrackEvents = scrollEvents;
      terminal.element.dispatchEvent(pointerEvent('pointerdown', {
        pointerId: 11,
        clientX: hostRect.right - 1,
        clientY: hostRect.top + 20,
      }));
      terminal.element.dispatchEvent(pointerEvent('pointerup', {
        pointerId: 11,
        clientX: hostRect.right - 1,
        clientY: hostRect.top + 20,
      }));
      await settleFrames();
      expect(terminal.getViewportY()).toBeGreaterThan(0);
      expect(scrollEvents - beforeTrackEvents).toBe(1);

      const thumbRect = thumb!.getBoundingClientRect();
      terminal.element.dispatchEvent(pointerEvent('pointerdown', {
        pointerId: 12,
        clientX: hostRect.right - 1,
        clientY: thumbRect.top + thumbRect.height / 2,
      }));
      expect(scrollbar?.dataset.dragging).toBe('true');
      terminal.element.dispatchEvent(pointerEvent('pointermove', {
        pointerId: 12,
        clientX: hostRect.right - 1,
        clientY: hostRect.bottom - 2,
      }));
      terminal.element.dispatchEvent(pointerEvent('pointerup', {
        pointerId: 12,
        clientX: hostRect.right - 1,
        clientY: hostRect.bottom - 2,
      }));
      await settleFrames();
      expect(terminal.getViewportY()).toBe(0);
      expect(scrollbar?.dataset.dragging).toBe('false');
      expect(document.activeElement).toBe((core as unknown as { inputElement: HTMLElement }).inputElement);

      core.setScrollbarOptions({ ariaLabel: 'Localized terminal history' });
      expect(scrollbar?.getAttribute('aria-label')).toBe('Localized terminal history');

      const latestThumbRect = thumb!.getBoundingClientRect();
      terminal.element.dispatchEvent(pointerEvent('pointerdown', {
        pointerId: 13,
        clientX: hostRect.right - 1,
        clientY: latestThumbRect.top + latestThumbRect.height / 2,
      }));
      expect(scrollbar?.dataset.dragging).toBe('true');
      await new Promise<void>(resolve => core.write('\x1b[?1049h', resolve));
      await nextFrame();
      expect(scrollbar?.hidden).toBe(true);
      expect(scrollbar?.dataset.dragging).toBe('false');
      const alternateViewportY = terminal.getViewportY();
      terminal.element.dispatchEvent(pointerEvent('pointermove', {
        pointerId: 13,
        clientX: hostRect.right - 1,
        clientY: hostRect.top + 10,
      }));
      expect(scrollbar?.dataset.dragging).toBe('false');
      expect(terminal.getViewportY()).toBe(alternateViewportY);
      await new Promise<void>(resolve => core.write('\x1b[?1049l', resolve));
      await nextFrame();
      expect(scrollbar?.hidden).toBe(false);

      core.dispose();
      scrollListener.dispose();
      cores.splice(cores.indexOf(core), 1);
      expect(host.querySelector('[data-floeterm-scrollbar]')).toBeNull();
    }, 30_000);
  }

  it('keeps a 15px visible gutter while presentation scale changes', async () => {
    const host = createHost();
    const core = new TerminalCore(host, {
      rendererType: 'webgl',
      fit: { scrollbarReservePx: 15 },
      scrollbar: { visibility: 'persistent' },
    });
    cores.push(core);
    await core.initialize();
    core.setConnected(true);
    await write(core, historyFixture(80));
    await core.forceResizeAndWaitForPresentation();
    await settleFrames();
    const assertGeometry = (scale: number) => {
      const state = core as unknown as {
        fabricView: { renderer: { getGeometry(): { cellWidth: number } } };
      };
      const cellWidth = state.fabricView.renderer.getGeometry().cellWidth;
      const expectedCols = Math.floor((host.clientWidth - 15) / (cellWidth / scale));
      const actualCols = core.getDimensions().cols;
      expect(actualCols, JSON.stringify({ scale, cellWidth, expectedCols, actualCols })).toBe(expectedCols);
      const visibleGridRight = actualCols * (cellWidth / scale);
      expect(visibleGridRight).toBeLessThanOrEqual(host.clientWidth - 15);
      expect(visibleGridRight + (cellWidth / scale)).toBeGreaterThan(host.clientWidth - 15);
      expect(host.clientWidth - visibleGridRight).toBeGreaterThanOrEqual(15);
    };

    for (const scale of [1, 1.5, 2, 1]) {
      core.setPresentationScale(scale);
      await settleFrames(4);
      await core.forceResizeAndWaitForPresentation();
      await settleFrames(2);
      assertGeometry(scale);
    }
    expect(host.querySelector<HTMLElement>('[role="scrollbar"]')?.getBoundingClientRect().width).toBe(12);
  }, 30_000);

  it('fades and rediscovers auto mode at the fine-pointer edge without intercepting touch', async () => {
    const host = createHost();
    const core = new TerminalCore(host, {
      rendererType: 'canvas',
      fixedDimensions: { cols: 80, rows: 24 },
      scrollback: 1_000,
      smoothScrollDuration: 0,
      scrollbar: { visibility: 'auto' },
    });
    cores.push(core);
    await core.initialize();
    await write(core, historyFixture(120));
    const scrollbar = host.querySelector<HTMLElement>('[role="scrollbar"]')!;
    const terminal = (core as unknown as { terminal: { element: HTMLElement } }).terminal;
    const rect = host.getBoundingClientRect();

    terminal.element.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -120,
    }));
    expect(scrollbar.dataset.visible).toBe('true');
    await new Promise(resolve => setTimeout(resolve, 1_400));
    expect(scrollbar.dataset.visible).toBe('false');

    terminal.element.dispatchEvent(pointerEvent('pointermove', {
      clientX: rect.right - 1,
      clientY: rect.top + 100,
    }));
    expect(scrollbar.dataset.visible).toBe('true');
    expect(scrollbar.style.pointerEvents).toBe('none');

    const touch = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 31,
      pointerType: 'touch',
      clientX: rect.right - 1,
      clientY: rect.top + 100,
    });
    const reachedTerminal = terminal.element.dispatchEvent(touch);
    expect(reachedTerminal).toBe(true);
    expect(touch.defaultPrevented).toBe(false);
    expect(scrollbar.dataset.dragging).toBe('false');
  }, 30_000);

  it('projects distinct contrast-safe idle, hover, focus, and drag states in Chromium', async () => {
    const host = createHost();
    const core = new TerminalCore(host, {
      rendererType: 'canvas',
      fixedDimensions: { cols: 80, rows: 24 },
      theme: { background: 'rgb(250, 250, 250)', foreground: '#111827' },
      scrollbar: { visibility: 'persistent' },
    });
    cores.push(core);
    await core.initialize();
    await write(core, historyFixture(120));
    const scrollbar = host.querySelector<HTMLElement>('[role="scrollbar"]')!;
    const thumb = host.querySelector<HTMLElement>('[data-floeterm-scrollbar-thumb]')!;
    const terminal = (core as unknown as { terminal: { element: HTMLElement } }).terminal;
    const rect = host.getBoundingClientRect();
    const idle = getComputedStyle(thumb).backgroundColor;

    terminal.element.dispatchEvent(pointerEvent('pointermove', {
      clientX: rect.right - 1,
      clientY: rect.top + 80,
    }));
    const hover = getComputedStyle(thumb).backgroundColor;
    expect(hover).not.toBe(idle);

    scrollbar.focus();
    expect(document.activeElement).toBe(scrollbar);
    expect(getComputedStyle(thumb).backgroundColor).toBe(hover);

    terminal.element.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 41,
      clientX: rect.right - 1,
      clientY: rect.top + 80,
    }));
    const active = getComputedStyle(thumb).backgroundColor;
    expect(active).not.toBe(hover);
    expect(scrollbar.dataset.dragging).toBe('true');
    terminal.element.dispatchEvent(pointerEvent('pointercancel', {
      pointerId: 41,
      clientX: rect.right - 1,
      clientY: rect.top + 80,
    }));
    expect(scrollbar.dataset.dragging).toBe('false');

    const styleText = host.querySelector<HTMLStyleElement>('[data-floeterm-scrollbar-style]')?.textContent ?? '';
    expect(styleText).toContain('prefers-reduced-motion: reduce');
    expect(styleText).toContain('forced-colors: active');
  }, 30_000);
});
