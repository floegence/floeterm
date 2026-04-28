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
    element: HTMLElement | null = null;
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

    open(container: HTMLElement) {
      this.element = container;
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
      const element = term.element as HTMLElement | null;
      const measured = (element?.clientWidth ?? 0) > 0
        ? element
        : ((element?.parentElement?.clientWidth ?? 0) > 0 ? element?.parentElement : element?.parentElement?.parentElement);
      const cols = Math.max(2, Math.floor((measured?.clientWidth ?? 0) / 8));
      const rows = Math.max(1, Math.floor((measured?.clientHeight ?? 0) / 16));
      term.__applyFit(cols, rows);
    }
  }

  const init = vi.fn().mockResolvedValue(undefined);

  return { Terminal: MockTerminal, FitAddon: MockFitAddon, init };
});

const resizeObservers: MockResizeObserver[] = [];

class MockResizeObserver {
  readonly observed: Element[] = [];

  constructor(private readonly cb: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  disconnect() {
    this.observed.length = 0;
  }

  trigger(target: Element = this.observed[0]) {
    this.cb([{
      target,
      contentRect: {
        width: (target as HTMLElement).clientWidth ?? 0,
        height: (target as HTMLElement).clientHeight ?? 0,
      },
    } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

describe('TerminalCore responsive resize notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resizeObservers.length = 0;

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
    vi.unstubAllGlobals();
    document.body.replaceChildren();
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
    expect(onResize).toHaveBeenLastCalledWith({ cols: 100, rows: 25 });

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
    expect(onResize).toHaveBeenLastCalledWith({ cols: 100, rows: 25 });

    core.dispose();
  });

  it('fits promptly when the component or its parent width changes', async () => {
    const parent = document.createElement('div');
    const container = document.createElement('div');
    parent.appendChild(container);
    document.body.appendChild(parent);

    Object.defineProperty(parent, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(parent, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const onResize = vi.fn();
    const core = new TerminalCore(container, {}, { onResize });
    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;
    await vi.runAllTimersAsync();

    const observer = resizeObservers[0];
    expect(observer).toBeDefined();
    expect(observer.observed).toContain(container);
    expect(observer.observed).toContain(parent);

    onResize.mockClear();
    Object.defineProperty(container, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(parent, 'clientWidth', { value: 640, configurable: true });

    observer.trigger(parent);
    expect(onResize).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(onResize).toHaveBeenCalledWith({ cols: 80, rows: 25 });

    onResize.mockClear();
    Object.defineProperty(container, 'clientWidth', { value: 704, configurable: true });
    Object.defineProperty(parent, 'clientWidth', { value: 704, configurable: true });

    observer.trigger(container);
    await vi.runOnlyPendingTimersAsync();

    expect(onResize).toHaveBeenCalledWith({ cols: 88, rows: 25 });

    core.dispose();
  });
});
