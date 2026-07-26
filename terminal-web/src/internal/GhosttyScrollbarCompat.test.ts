// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import {
  suppressPinnedGhosttyScrollbarBeforeOpen,
  suppressPinnedGhosttyScrollbarRenderer,
  installPinnedGhosttyAlternateScreenProjection,
} from './GhosttyScrollbarCompat';

const createTerminal = () => ({
  element: document.createElement('div'),
  handleMouseDown: vi.fn(),
  showScrollbar: vi.fn(),
  hideScrollbar: vi.fn(),
  fadeInScrollbar: vi.fn(),
  fadeOutScrollbar: vi.fn(),
  animateScroll: vi.fn(),
  targetViewportY: 0,
  scrollAnimationFrame: undefined as number | undefined,
  scrollAnimationStartTime: undefined as number | undefined,
  scrollAnimationStartY: undefined as number | undefined,
  getViewportY: vi.fn(() => 0),
  getScrollbackLength: vi.fn(() => 10),
  isAlternateScreen: vi.fn(() => false),
  scrollToLine: vi.fn(),
  scrollToTop: vi.fn(),
  scrollToBottom: vi.fn(),
  scrollLines: vi.fn(),
  scrollPages: vi.fn(),
  onScroll: vi.fn(() => ({ dispose: vi.fn() })),
  wasmTerm: { isAlternateScreen: vi.fn(() => false) },
});

describe('GhosttyScrollbarCompat', () => {
  it('neutralizes only the pinned native scrollbar entrypoints before open', () => {
    const terminal = createTerminal();
    const nativeMouseDown = terminal.handleMouseDown;
    const nativeShow = terminal.showScrollbar;
    suppressPinnedGhosttyScrollbarBeforeOpen(terminal);

    terminal.handleMouseDown();
    terminal.showScrollbar();
    terminal.hideScrollbar();
    terminal.fadeInScrollbar();
    terminal.fadeOutScrollbar();
    expect(nativeMouseDown).not.toHaveBeenCalled();
    expect(nativeShow).not.toHaveBeenCalled();
    expect(terminal.getViewportY()).toBe(0);
  });

  it('cancels a pinned smooth-scroll frame before explicit scrollbar navigation', () => {
    const terminal = createTerminal();
    const nativeScrollToTop = terminal.scrollToTop;
    const cancelAnimationFrame = vi.spyOn(globalThis, 'cancelAnimationFrame');
    terminal.getViewportY.mockReturnValue(7);
    suppressPinnedGhosttyScrollbarBeforeOpen(terminal);
    terminal.scrollAnimationFrame = 42;
    terminal.scrollAnimationStartTime = 1;
    terminal.scrollAnimationStartY = 2;
    terminal.targetViewportY = 3;

    terminal.scrollToTop();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(terminal.scrollAnimationFrame).toBeUndefined();
    expect(terminal.scrollAnimationStartTime).toBeUndefined();
    expect(terminal.scrollAnimationStartY).toBeUndefined();
    expect(terminal.targetViewportY).toBe(7);
    expect(nativeScrollToTop).toHaveBeenCalledOnce();
  });

  it('forces native scrollbar opacity to zero without changing other render arguments', () => {
    const render = vi.fn();
    const renderer = { render };
    suppressPinnedGhosttyScrollbarRenderer(renderer);

    renderer.render('buffer', true, 9, 'provider', 0.75);
    expect(render).toHaveBeenCalledWith('buffer', true, 9, 'provider', 0);
  });

  it('projects the pinned WASM alternate-screen reader onto the internal runtime shape', () => {
    const terminal = createTerminal();
    installPinnedGhosttyAlternateScreenProjection(terminal);
    expect(terminal.isAlternateScreen()).toBe(false);
    terminal.wasmTerm.isAlternateScreen.mockReturnValue(true);
    expect(terminal.isAlternateScreen()).toBe(true);
  });

  it('fails closed when a pinned method shape is missing', () => {
    const terminal = createTerminal();
    delete (terminal as Partial<typeof terminal>).handleMouseDown;
    expect(() => suppressPinnedGhosttyScrollbarBeforeOpen(terminal)).toThrow(/exact pinned ghostty-web/i);
    expect(() => suppressPinnedGhosttyScrollbarRenderer({})).toThrow(/exact pinned ghostty-web/i);
  });

  it('fails closed before DOM mounting when keyboard scrolling methods are missing', () => {
    const terminal = createTerminal();
    delete (terminal as Partial<typeof terminal>).scrollPages;
    expect(() => suppressPinnedGhosttyScrollbarBeforeOpen(terminal)).toThrow(/Terminal\.scrollPages/);
  });

  it('fails closed when the pinned smooth-scroll shape changes', () => {
    const terminal = createTerminal();
    delete (terminal as Partial<typeof terminal>).animateScroll;
    expect(() => suppressPinnedGhosttyScrollbarBeforeOpen(terminal)).toThrow(/Terminal\.animateScroll/);
  });
});
