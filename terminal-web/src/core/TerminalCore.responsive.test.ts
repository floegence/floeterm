// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalCore } from './TerminalCore';
import type { TerminalEventHandlers } from '../types';

vi.mock('ghostty-web', () => {
  class MockTerminal {
    cols: number;
    rows: number;
    options: any;
    buffer: any;
    private resizeHandler: ((size: { cols: number; rows: number }) => void) | null = null;

    constructor(opts: any) {
      this.cols = typeof opts?.cols === 'number' ? opts.cols : 80;
      this.rows = typeof opts?.rows === 'number' ? opts.rows : 24;
      this.options = { theme: opts?.theme ?? {}, fontSize: opts?.fontSize, fontFamily: opts?.fontFamily };
      this.buffer = { active: { length: 0 } };
    }

    loadAddon(addon: any) {
      // Allow the addon to access the terminal instance.
      addon.__terminal = this;
    }

    open(_container: HTMLElement) {
      // noop
    }

    onData(_handler: (data: string) => void) {
      return { dispose: () => {} };
    }

    onResize(handler: (size: { cols: number; rows: number }) => void) {
      this.resizeHandler = handler;
      return { dispose: () => {} };
    }

    // FitAddon mock does not call resizeHandler to simulate "no onResize emitted".
    __applyFit(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      void this.resizeHandler;
    }

    write(_data: string | Uint8Array, cb?: () => void) {
      cb?.();
    }

    clear() {}
    getSelection() {
      return '';
    }
    focus() {}
    dispose() {}
  }

  class MockFitAddon {
    fit() {
      const term: any = (this as any).__terminal;
      if (!term) return;
      term.__applyFit(120, 30);
    }
  }

  const init = vi.fn().mockResolvedValue(undefined);

  return { Terminal: MockTerminal, FitAddon: MockFitAddon, init };
});

class MockResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe(_target: Element) {}
  disconnect() {}
}

describe('TerminalCore responsive resize notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();

    // Minimal rAF polyfill for deterministic tests.
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      return setTimeout(() => cb(Date.now()), 0) as unknown as number;
    };
    globalThis.cancelAnimationFrame = (id: number) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    };

    // jsdom does not ship ResizeObserver.
    (globalThis as any).ResizeObserver = MockResizeObserver;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses resize notifications until focused and re-emits on focus even when size is unchanged', async () => {
    const container = document.createElement('div');
    container.tabIndex = 0;
    document.body.appendChild(container);

    // jsdom does not compute layout, so fake a non-zero size.
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const onResize = vi.fn();
    const handlers: TerminalEventHandlers = { onResize };

    const core = new TerminalCore(container, {
      responsive: {
        fitOnFocus: true,
        emitResizeOnFocus: true,
        notifyResizeOnlyWhenFocused: true,
      },
    }, handlers);

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    // Post-init fit is suppressed because the terminal is not focused.
    expect(onResize).toHaveBeenCalledTimes(0);

    // Focus triggers a resize notification.
    container.focus();
    await vi.runAllTimersAsync();
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith({ cols: 120, rows: 30 });

    // Blur by moving focus elsewhere.
    const other = document.createElement('button');
    other.tabIndex = 0;
    document.body.appendChild(other);
    other.focus();
    await vi.runAllTimersAsync();

    // Focus again: size is unchanged, but we still emit to allow remote PTY resync.
    container.focus();
    await vi.runAllTimersAsync();
    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenLastCalledWith({ cols: 120, rows: 30 });

    core.dispose();
  });
});

