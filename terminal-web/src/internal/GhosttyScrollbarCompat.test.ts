// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import {
  suppressPinnedGhosttyScrollbarBeforeOpen,
  suppressPinnedGhosttyScrollbarRenderer,
  installPinnedGhosttyAlternateScreenProjection,
  installPinnedGhosttyOutputViewportPolicy,
  isPinnedGhosttyOutputWriteActive,
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
  scrollToLine: vi.fn((_line: number) => {}),
  scrollToTop: vi.fn(),
  scrollToBottom: vi.fn(),
  scrollLines: vi.fn(),
  scrollPages: vi.fn(),
  onScroll: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn((_data?: unknown) => {}),
  wasmTerm: { isAlternateScreen: vi.fn(() => false) },
});

const createOutputTerminal = (initialViewportY = 12, initialScrollbackLength = 100) => {
  let viewportY = initialViewportY;
  let scrollbackLength = initialScrollbackLength;
  let alternateScreen = false;
  const terminal = createTerminal();
  terminal.getViewportY.mockImplementation(() => viewportY);
  terminal.getScrollbackLength.mockImplementation(() => scrollbackLength);
  terminal.isAlternateScreen.mockImplementation(() => alternateScreen);
  terminal.scrollToBottom.mockImplementation(() => { viewportY = 0; });
  const nativeScrollToBottom = terminal.scrollToBottom;
  terminal.scrollToLine.mockImplementation((line: number) => {
    viewportY = Math.max(0, Math.min(scrollbackLength, line));
  });
  terminal.write.mockImplementation((rawOperation?: unknown) => {
    const operation = rawOperation as {
      appendRows?: number;
      scrollbackLength?: number;
      alternateScreen?: boolean;
      nested?: boolean;
      fail?: boolean;
    } | undefined;
    if (operation?.appendRows) scrollbackLength += operation.appendRows;
    if (operation?.scrollbackLength !== undefined) scrollbackLength = operation.scrollbackLength;
    if (operation?.alternateScreen !== undefined) alternateScreen = operation.alternateScreen;
    if (operation?.nested) terminal.write({ appendRows: 2 });
    terminal.scrollToBottom();
    if (operation?.fail) throw new Error('write failed');
  });
  return {
    terminal,
    nativeScrollToBottom,
    getViewportY: () => viewportY,
    getScrollbackLength: () => scrollbackLength,
    setViewportY: (value: number) => { viewportY = value; },
  };
};

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

  it('keeps the current output following while preserving an explicit scrollback anchor', () => {
    const following = createOutputTerminal(0, 100);
    installPinnedGhosttyOutputViewportPolicy(following.terminal);
    following.terminal.write({ appendRows: 3 });
    expect(following.getViewportY()).toBe(0);

    const reviewing = createOutputTerminal(12, 100);
    installPinnedGhosttyOutputViewportPolicy(reviewing.terminal);
    reviewing.terminal.write({ appendRows: 3 });
    expect(reviewing.getScrollbackLength()).toBe(103);
    expect(reviewing.getViewportY()).toBe(15);
    expect(reviewing.nativeScrollToBottom).not.toHaveBeenCalled();
    expect(reviewing.terminal.scrollToLine).toHaveBeenLastCalledWith(15);

    reviewing.terminal.write({ appendRows: 4 });
    expect(reviewing.getViewportY()).toBe(19);
    expect(reviewing.terminal.scrollToLine).toHaveBeenLastCalledWith(19);
  });

  it('clamps preserved output anchors when retained scrollback shrinks', () => {
    const harness = createOutputTerminal(90, 100);
    installPinnedGhosttyOutputViewportPolicy(harness.terminal);
    harness.terminal.write({ scrollbackLength: 40 });
    expect(harness.getViewportY()).toBe(40);
  });

  it('restores bottom behavior outside writes and after nested or failed writes', () => {
    const harness = createOutputTerminal(8, 100);
    installPinnedGhosttyOutputViewportPolicy(harness.terminal);
    harness.terminal.write({ appendRows: 3, nested: true });
    expect(harness.getViewportY()).toBe(13);
    expect(isPinnedGhosttyOutputWriteActive(harness.terminal)).toBe(false);

    harness.setViewportY(7);
    expect(() => harness.terminal.write({ fail: true })).toThrow('write failed');
    expect(isPinnedGhosttyOutputWriteActive(harness.terminal)).toBe(false);
    expect(harness.getViewportY()).toBe(7);

    harness.terminal.scrollToBottom();
    expect(harness.getViewportY()).toBe(0);
  });

  it('uses bottom semantics instead of restoring stale anchors across alternate-screen changes', () => {
    const harness = createOutputTerminal(10, 100);
    installPinnedGhosttyOutputViewportPolicy(harness.terminal);
    harness.terminal.write({ alternateScreen: true });
    expect(harness.getViewportY()).toBe(0);

    harness.setViewportY(6);
    harness.terminal.write({ alternateScreen: false });
    expect(harness.getViewportY()).toBe(0);
  });

  it('fails closed when a pinned method shape is missing', () => {
    const terminal = createTerminal();
    delete (terminal as Partial<typeof terminal>).handleMouseDown;
    expect(() => suppressPinnedGhosttyScrollbarBeforeOpen(terminal)).toThrow(/exact pinned ghostty-web/i);
    expect(() => suppressPinnedGhosttyScrollbarRenderer({})).toThrow(/exact pinned ghostty-web/i);
  });

  it('fails closed when the pinned output viewport shape is missing', () => {
    const terminal = createTerminal();
    delete (terminal as Partial<typeof terminal>).write;
    expect(() => installPinnedGhosttyOutputViewportPolicy(terminal)).toThrow(/Terminal\.write/);
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
