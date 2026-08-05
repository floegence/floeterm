import { EXPECTED_GHOSTTY_WEB_COMPAT_VERSION } from './GhosttyCompatibilityVersion.js';

type pinned_ghostty_scrollbar_terminal = Record<string, unknown>;

type pinned_ghostty_renderer = {
  render?: (...args: unknown[]) => unknown;
  __floetermScrollbarSuppressed?: boolean;
};

type pinned_output_viewport_state = {
  writeDepth: number;
};

const outputViewportStates = new WeakMap<object, pinned_output_viewport_state>();

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
    `The exact pinned ghostty-web ${EXPECTED_GHOSTTY_WEB_COMPAT_VERSION} `
    + `scrollbar compatibility shape is unavailable (${detail}). `
    + 'Review and remove or update GhosttyScrollbarCompat before changing ghostty-web.',
  );
}

const readPinnedViewportValue = (
  terminal: pinned_ghostty_scrollbar_terminal,
  method: 'getViewportY' | 'getScrollbackLength',
): number => {
  const value = Number((terminal[method] as () => unknown).call(terminal));
  if (!Number.isFinite(value) || value < 0) {
    throw pinnedShapeError(`Terminal.${method}`);
  }
  return value;
};

const readPinnedAlternateScreen = (terminal: pinned_ghostty_scrollbar_terminal): boolean => {
  if (typeof terminal.isAlternateScreen !== 'function') {
    throw pinnedShapeError('Terminal.isAlternateScreen');
  }
  return Boolean((terminal.isAlternateScreen as () => unknown).call(terminal));
};

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

export function installPinnedGhosttyOutputViewportPolicy(
  terminal: pinned_ghostty_scrollbar_terminal,
): void {
  if (outputViewportStates.has(terminal)) return;
  for (const method of ['write', 'getViewportY', 'getScrollbackLength', 'scrollToBottom', 'scrollToLine'] as const) {
    if (typeof terminal[method] !== 'function') {
      throw pinnedShapeError(`Terminal.${method}`);
    }
  }
  readPinnedAlternateScreen(terminal);

  const state: pinned_output_viewport_state = { writeDepth: 0 };
  const originalWrite = terminal.write as (...args: unknown[]) => unknown;
  const originalScrollToBottom = terminal.scrollToBottom as (...args: unknown[]) => unknown;
  const scrollToLine = terminal.scrollToLine as (line: number) => unknown;
  outputViewportStates.set(terminal, state);

  terminal.scrollToBottom = (...args: unknown[]) => {
    if (state.writeDepth > 0) return undefined;
    return originalScrollToBottom.apply(terminal, args);
  };

  terminal.write = (...args: unknown[]) => {
    if (state.writeDepth > 0) {
      return originalWrite.apply(terminal, args);
    }

    const beforeViewportY = readPinnedViewportValue(terminal, 'getViewportY');
    const beforeScrollbackLength = readPinnedViewportValue(terminal, 'getScrollbackLength');
    const beforeAlternateScreen = readPinnedAlternateScreen(terminal);
    let completed = false;
    state.writeDepth += 1;
    try {
      const result = originalWrite.apply(terminal, args);
      completed = true;
      return result;
    } finally {
      state.writeDepth = Math.max(0, state.writeDepth - 1);
      if (completed && state.writeDepth === 0) {
        const afterAlternateScreen = readPinnedAlternateScreen(terminal);
        if (beforeAlternateScreen !== afterAlternateScreen || afterAlternateScreen) {
          originalScrollToBottom.call(terminal);
        } else if (beforeViewportY > 0) {
          const afterScrollbackLength = readPinnedViewportValue(terminal, 'getScrollbackLength');
          const appendedRows = Math.max(0, afterScrollbackLength - beforeScrollbackLength);
          scrollToLine.call(
            terminal,
            Math.min(afterScrollbackLength, beforeViewportY + appendedRows),
          );
        }
      }
    }
  };
}

export function isPinnedGhosttyOutputWriteActive(
  terminal: pinned_ghostty_scrollbar_terminal,
): boolean {
  return (outputViewportStates.get(terminal)?.writeDepth ?? 0) > 0;
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
