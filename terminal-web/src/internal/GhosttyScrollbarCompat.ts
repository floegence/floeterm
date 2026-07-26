import { EXPECTED_GHOSTTY_WEB_SCROLLBACK_BUG_VERSION } from './GhosttyScrollbackCompat.js';

type pinned_ghostty_scrollbar_terminal = Record<string, unknown>;

type pinned_ghostty_renderer = {
  render?: (...args: unknown[]) => unknown;
  __floetermScrollbarSuppressed?: boolean;
};

const TERMINAL_METHODS = [
  'handleMouseDown',
  'showScrollbar',
  'hideScrollbar',
  'fadeInScrollbar',
  'fadeOutScrollbar',
  'getViewportY',
  'getScrollbackLength',
  'scrollToLine',
  'scrollToTop',
  'scrollToBottom',
  'scrollLines',
  'scrollPages',
  'onScroll',
] as const;

const SCROLL_NAVIGATION_METHODS = [
  'scrollToLine',
  'scrollToTop',
  'scrollToBottom',
  'scrollLines',
  'scrollPages',
] as const;

function pinnedShapeError(detail: string): Error {
  return new Error(
    `The exact pinned ghostty-web ${EXPECTED_GHOSTTY_WEB_SCROLLBACK_BUG_VERSION} `
    + `scrollbar compatibility shape is unavailable (${detail}). `
    + 'Review and remove or update GhosttyScrollbarCompat before changing ghostty-web.',
  );
}

function cancelPinnedSmoothScroll(terminal: pinned_ghostty_scrollbar_terminal): void {
  const animationFrame = terminal.scrollAnimationFrame;
  if (animationFrame !== undefined) {
    if (typeof animationFrame !== 'number' || typeof globalThis.cancelAnimationFrame !== 'function') {
      throw pinnedShapeError('Terminal.scrollAnimationFrame');
    }
    globalThis.cancelAnimationFrame(animationFrame);
  }
  terminal.scrollAnimationFrame = undefined;
  terminal.scrollAnimationStartTime = undefined;
  terminal.scrollAnimationStartY = undefined;
  terminal.targetViewportY = (terminal.getViewportY as () => unknown).call(terminal);
}

export function suppressPinnedGhosttyScrollbarBeforeOpen(
  terminal: pinned_ghostty_scrollbar_terminal,
): void {
  for (const method of TERMINAL_METHODS) {
    if (typeof terminal[method] !== 'function') {
      throw pinnedShapeError(`Terminal.${method}`);
    }
  }
  if (typeof terminal.animateScroll !== 'function') {
    throw pinnedShapeError('Terminal.animateScroll');
  }
  if (typeof terminal.targetViewportY !== 'number' || !Number.isFinite(terminal.targetViewportY)) {
    throw pinnedShapeError('Terminal.targetViewportY');
  }

  for (const method of SCROLL_NAVIGATION_METHODS) {
    const original = terminal[method] as (...args: unknown[]) => unknown;
    terminal[method] = (...args: unknown[]) => {
      cancelPinnedSmoothScroll(terminal);
      return original.apply(terminal, args);
    };
  }

  const noOp = () => {};
  terminal.handleMouseDown = noOp;
  terminal.showScrollbar = noOp;
  terminal.hideScrollbar = noOp;
  terminal.fadeInScrollbar = noOp;
  terminal.fadeOutScrollbar = noOp;
}

export function suppressPinnedGhosttyScrollbarRenderer(renderer: pinned_ghostty_renderer): void {
  if (renderer.__floetermScrollbarSuppressed) return;
  if (typeof renderer.render !== 'function') {
    throw pinnedShapeError('renderer.render');
  }
  const originalRender = renderer.render.bind(renderer);
  renderer.render = (...args: unknown[]) => {
    const nextArgs = [...args];
    while (nextArgs.length < 5) nextArgs.push(undefined);
    nextArgs[4] = 0;
    return originalRender(...nextArgs);
  };
  renderer.__floetermScrollbarSuppressed = true;
}

export function installPinnedGhosttyAlternateScreenProjection(
  terminal: pinned_ghostty_scrollbar_terminal,
): void {
  if (!(terminal.element instanceof HTMLElement)) {
    throw pinnedShapeError('Terminal.element');
  }
  const wasmTerm = terminal.wasmTerm as Record<string, unknown> | undefined;
  if (!wasmTerm || typeof wasmTerm.isAlternateScreen !== 'function') {
    throw pinnedShapeError('Terminal.wasmTerm.isAlternateScreen');
  }
  terminal.isAlternateScreen = () => Boolean(
    (wasmTerm.isAlternateScreen as () => unknown).call(wasmTerm),
  );
}
