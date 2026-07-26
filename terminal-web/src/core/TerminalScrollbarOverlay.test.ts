// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_SCROLLBAR_AUTO_HIDE_DELAY_MS,
  normalizeTerminalScrollbarOptions,
  TerminalScrollbarOverlay,
} from './TerminalScrollbarOverlay';
import { contrastRatio, parseThemeColor } from '../utils/themeColor';

const createRect = (width: number, height: number): DOMRect => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: width,
  bottom: height,
  width,
  height,
  toJSON: () => ({}),
});

const createHarness = (overrides: Record<string, unknown> = {}) => {
  const host = document.createElement('div');
  const input = document.createElement('textarea');
  document.body.append(host, input);
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 240 });
  Object.defineProperty(host, 'getBoundingClientRect', {
    configurable: true,
    value: () => createRect(800, 240),
  });
  const capturedPointers = new Set<number>();
  Object.defineProperties(host, {
    setPointerCapture: {
      configurable: true,
      value: vi.fn((pointerId: number) => capturedPointers.add(pointerId)),
    },
    hasPointerCapture: {
      configurable: true,
      value: vi.fn((pointerId: number) => capturedPointers.has(pointerId)),
    },
    releasePointerCapture: {
      configurable: true,
      value: vi.fn((pointerId: number) => capturedPointers.delete(pointerId)),
    },
  });

  let viewportY = 0;
  let scrollbackLength = 100;
  let alternate = false;
  const scrollToLine = vi.fn((line: number) => {
    viewportY = Math.max(0, Math.min(scrollbackLength, line));
  });
  const runtime = {
    get rows() {
      return 20;
    },
    getScrollbackLength: () => scrollbackLength,
    getViewportY: () => viewportY,
    isAlternateScreen: () => alternate,
    scrollToLine,
    scrollToTop: vi.fn(() => { viewportY = scrollbackLength; }),
    scrollToBottom: vi.fn(() => { viewportY = 0; }),
    scrollLines: vi.fn((amount: number) => {
      viewportY = Math.max(0, Math.min(scrollbackLength, viewportY - amount));
    }),
    scrollPages: vi.fn((amount: number) => {
      viewportY = Math.max(0, Math.min(scrollbackLength, viewportY - amount * 20));
    }),
    focusTerminal: vi.fn(() => input.focus()),
    ...overrides,
  };
  const overlay = new TerminalScrollbarOverlay(host, runtime, {
    visibility: 'persistent',
    minThumbPx: 24,
    ariaLabel: 'Terminal scrollback',
  });
  const control = host.querySelector<HTMLElement>('[role="scrollbar"]')!;
  const thumb = host.querySelector<HTMLElement>('[data-floeterm-scrollbar-thumb]')!;

  return {
    host,
    input,
    overlay,
    runtime,
    control,
    thumb,
    setViewportY: (value: number) => { viewportY = value; },
    setScrollbackLength: (value: number) => { scrollbackLength = value; },
    setAlternate: (value: boolean) => { alternate = value; },
  };
};

const pointerEvent = (
  type: string,
  values: { pointerId?: number; pointerType?: string; clientX: number; clientY: number },
): PointerEvent => {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId ?? 1 },
    pointerType: { value: values.pointerType ?? 'mouse' },
    clientX: { value: values.clientX },
    clientY: { value: values.clientY },
  });
  return event;
};

describe('TerminalScrollbarOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('rejects non-object options and non-number thumb sizes', () => {
    for (const invalid of [null, 'persistent', [], 24]) {
      expect(() => normalizeTerminalScrollbarOptions(invalid as never)).toThrow(/plain object/i);
    }
    for (const invalid of ['24', [24], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeTerminalScrollbarOptions({ minThumbPx: invalid as never })).toThrow(/minThumbPx/i);
    }
  });

  it('projects bottom, middle, and top using natural top-to-bottom ARIA coordinates', () => {
    const harness = createHarness();

    harness.overlay.sync();
    expect(harness.control.hidden).toBe(false);
    expect(harness.control.getAttribute('aria-valuemax')).toBe('100');
    expect(harness.control.getAttribute('aria-valuenow')).toBe('100');
    expect(harness.thumb.style.height).toBe('40px');
    expect(harness.thumb.style.transform).toBe('translateY(200px)');

    harness.setViewportY(50);
    harness.overlay.sync();
    expect(harness.control.getAttribute('aria-valuenow')).toBe('50');
    expect(harness.thumb.style.transform).toBe('translateY(100px)');

    harness.setViewportY(100);
    harness.overlay.sync();
    expect(harness.control.getAttribute('aria-valuenow')).toBe('0');
    expect(harness.thumb.style.transform).toBe('translateY(0px)');
  });

  it('uses public top, bottom, line, and page scrolling APIs for keyboard input', () => {
    const harness = createHarness();
    harness.overlay.sync();

    harness.control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(harness.runtime.scrollToTop).toHaveBeenCalledOnce();
    harness.control.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(harness.runtime.scrollToBottom).toHaveBeenCalledOnce();
    harness.control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(harness.runtime.scrollLines).toHaveBeenLastCalledWith(-1);
    harness.control.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(harness.runtime.scrollPages).toHaveBeenLastCalledWith(1);
  });

  it('removes hidden, empty, and alternate-screen controls from pointer, tab, and a11y access', () => {
    const harness = createHarness();

    harness.setScrollbackLength(0);
    harness.overlay.sync();
    expect(harness.control.hidden).toBe(true);
    expect(harness.control.tabIndex).toBe(-1);
    expect(harness.control.getAttribute('aria-hidden')).toBe('true');

    harness.setScrollbackLength(100);
    harness.setAlternate(true);
    harness.overlay.sync();
    expect(harness.control.hidden).toBe(true);

    harness.setAlternate(false);
    harness.overlay.setOptions({ visibility: 'hidden' });
    expect(harness.control.hidden).toBe(true);
  });

  it('updates a localized accessible name without changing viewport state', () => {
    const harness = createHarness();
    harness.setViewportY(40);
    harness.overlay.sync();

    harness.overlay.setOptions({ ariaLabel: '终端滚动历史' });
    expect(harness.control.getAttribute('aria-label')).toBe('终端滚动历史');
    expect(harness.runtime.getViewportY()).toBe(40);
    expect(() => harness.overlay.setOptions({ ariaLabel: '   ' })).toThrow(/ariaLabel/i);
    expect(harness.control.getAttribute('aria-label')).toBe('终端滚动历史');
  });

  it('clamps thumb geometry for zero and undersized tracks', () => {
    const harness = createHarness();

    for (const height of [0, 1, 15, 16]) {
      Object.defineProperty(harness.host, 'clientHeight', { configurable: true, value: height });
      harness.overlay.sync();
      const thumbHeight = Number.parseFloat(harness.thumb.style.height || '0');
      expect(Number.isFinite(thumbHeight)).toBe(true);
      expect(thumbHeight).toBeGreaterThanOrEqual(0);
      expect(thumbHeight).toBeLessThanOrEqual(height);
    }
  });

  it('keeps persistent visible and fades auto only after the idle delay', () => {
    const harness = createHarness();
    harness.overlay.sync();
    vi.advanceTimersByTime(2_000);
    expect(harness.control.dataset.visible).toBe('true');

    harness.overlay.setOptions({ visibility: 'auto' });
    harness.overlay.reveal();
    expect(harness.control.dataset.visible).toBe('true');
    vi.advanceTimersByTime(1_199);
    expect(harness.control.dataset.visible).toBe('true');
    vi.advanceTimersByTime(1);
    expect(harness.control.dataset.visible).toBe('false');

    harness.host.dispatchEvent(pointerEvent('pointermove', { clientX: 799, clientY: 100 }));
    expect(harness.control.dataset.visible).toBe('true');
    expect(harness.control.dataset.hovered).toBe('true');
    harness.host.dispatchEvent(pointerEvent('pointerleave', { clientX: 801, clientY: 100 }));
    expect(harness.control.dataset.hovered).toBe('false');
    vi.advanceTimersByTime(TERMINAL_SCROLLBAR_AUTO_HIDE_DELAY_MS);
    expect(harness.control.dataset.visible).toBe('false');
  });

  it('cancels pointer capture when the scrollbar becomes unavailable', () => {
    const harness = createHarness();
    harness.overlay.sync();
    harness.host.dispatchEvent(pointerEvent('pointerdown', { pointerId: 7, clientX: 799, clientY: 120 }));
    expect(harness.control.dataset.dragging).toBe('true');
    const callsDuringPointerDown = harness.runtime.scrollToLine.mock.calls.length;

    harness.setAlternate(true);
    harness.overlay.sync();
    expect(harness.control.hidden).toBe(true);
    expect(harness.control.dataset.dragging).toBe('false');
    expect(harness.host.releasePointerCapture).toHaveBeenCalledWith(7);

    harness.host.dispatchEvent(pointerEvent('pointermove', { pointerId: 7, clientX: 799, clientY: 30 }));
    expect(harness.runtime.scrollToLine).toHaveBeenCalledTimes(callsDuringPointerDown);
  });

  it('clears hover and fades after a captured drag ends outside the viewport', () => {
    const harness = createHarness();
    harness.overlay.setOptions({ visibility: 'auto' });
    harness.host.dispatchEvent(pointerEvent('pointermove', { clientX: 799, clientY: 220 }));
    harness.host.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 9,
      clientX: 799,
      clientY: 220,
    }));
    expect(harness.control.dataset.hovered).toBe('true');
    expect(harness.control.dataset.dragging).toBe('true');

    harness.host.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 9,
      clientX: 700,
      clientY: 120,
    }));
    harness.host.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 9,
      clientX: 700,
      clientY: 120,
    }));
    expect(harness.control.dataset.dragging).toBe('false');
    expect(harness.control.dataset.hovered).toBe('false');

    vi.advanceTimersByTime(TERMINAL_SCROLLBAR_AUTO_HIDE_DELAY_MS);
    expect(harness.control.dataset.visible).toBe('false');
  });

  it('maps physical pointer coordinates into a scaled scrollbar track', () => {
    const harness = createHarness();
    Object.defineProperty(harness.host, 'getBoundingClientRect', {
      configurable: true,
      value: () => createRect(800, 120),
    });
    harness.overlay.sync();

    harness.host.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 8,
      clientX: 799,
      clientY: 110,
    }));
    expect(harness.runtime.scrollToLine).not.toHaveBeenCalled();

    harness.host.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 8,
      clientX: 799,
      clientY: 0,
    }));
    expect(harness.runtime.getViewportY()).toBe(100);
    expect(harness.control.getAttribute('aria-valuenow')).toBe('0');
  });

  it('derives restrained contrast-safe colors for short hex and rgb themes', () => {
    const harness = createHarness();
    for (const background of ['#fff', 'rgb(250, 250, 250)', '#111827']) {
      harness.overlay.setBackgroundColor(background);
      const parsedBackground = parseThemeColor(background)!;
      const idle = parseThemeColor(harness.control.style.getPropertyValue('--floeterm-scrollbar-thumb-idle'))!;
      const hover = parseThemeColor(harness.control.style.getPropertyValue('--floeterm-scrollbar-thumb-hover'))!;
      const active = parseThemeColor(harness.control.style.getPropertyValue('--floeterm-scrollbar-thumb-active'))!;
      expect(contrastRatio(parsedBackground, idle)).toBeGreaterThanOrEqual(2.99);
      expect(contrastRatio(parsedBackground, hover)).toBeGreaterThanOrEqual(4.49);
      expect(contrastRatio(parsedBackground, active)).toBeGreaterThanOrEqual(6.99);
      expect(idle).not.toEqual({ r: 0, g: 0, b: 0 });
      expect(idle).not.toEqual({ r: 255, g: 255, b: 255 });
    }
  });

  it('passes touch through on pure coarse pointers and restores fine-pointer interaction when mixed', () => {
    const listeners = new Map<string, Set<() => void>>();
    const matches = new Map([
      ['(any-pointer: coarse)', true],
      ['(any-pointer: fine)', false],
    ]);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        get matches() { return matches.get(query) ?? false; },
        addEventListener: (_type: string, listener: () => void) => {
          const bucket = listeners.get(query) ?? new Set();
          bucket.add(listener);
          listeners.set(query, bucket);
        },
        removeEventListener: (_type: string, listener: () => void) => listeners.get(query)?.delete(listener),
      })),
    });
    const harness = createHarness();
    harness.overlay.sync();
    expect(harness.control.dataset.visible).toBe('false');

    const touch = pointerEvent('pointerdown', {
      pointerType: 'touch',
      clientX: 799,
      clientY: 100,
    });
    harness.host.dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(false);
    expect(harness.control.dataset.dragging).toBe('false');

    matches.set('(any-pointer: fine)', true);
    for (const listener of listeners.get('(any-pointer: fine)') ?? []) listener();
    expect(harness.control.dataset.visible).toBe('true');
    harness.host.dispatchEvent(pointerEvent('pointerdown', { clientX: 799, clientY: 100 }));
    expect(harness.control.dataset.dragging).toBe('true');
  });

  it('rebases timers and interaction state across visibility transitions', () => {
    const harness = createHarness();
    harness.overlay.setOptions({ visibility: 'auto' });
    harness.overlay.reveal();
    harness.host.dispatchEvent(pointerEvent('pointerdown', { pointerId: 8, clientX: 799, clientY: 100 }));
    expect(harness.control.dataset.dragging).toBe('true');

    harness.overlay.setOptions({ visibility: 'hidden' });
    expect(harness.control.hidden).toBe(true);
    expect(harness.control.dataset.dragging).toBe('false');
    expect(vi.getTimerCount()).toBe(0);

    harness.overlay.setOptions({ visibility: 'auto' });
    expect(harness.control.hidden).toBe(false);
    expect(harness.control.dataset.visible).toBe('false');
    vi.advanceTimersByTime(5_000);
    expect(harness.control.dataset.visible).toBe('false');
  });

  it('restores terminal focus before hiding a focused scrollbar', () => {
    const harness = createHarness();
    harness.control.focus();
    expect(document.activeElement).toBe(harness.control);

    harness.overlay.setOptions({ visibility: 'hidden' });
    expect(document.activeElement).toBe(harness.input);
    expect(harness.control.hidden).toBe(true);
    expect(harness.control.tabIndex).toBe(-1);
  });

  it('disposes DOM and pending fade work', () => {
    const harness = createHarness();
    harness.overlay.setOptions({ visibility: 'auto' });
    harness.overlay.reveal();
    harness.overlay.dispose();

    expect(harness.host.querySelector('[data-floeterm-scrollbar]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
