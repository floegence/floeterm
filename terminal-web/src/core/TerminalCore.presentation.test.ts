// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalCore } from './TerminalCore';
import type { TerminalEventHandlers } from '../types';

const fitSpy = vi.fn();

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
      addon.__terminal = this;
    }

    open(_container: HTMLElement) {}

    onData(_handler: (data: string) => void) {
      return { dispose: () => {} };
    }

    onResize(handler: (size: { cols: number; rows: number }) => void) {
      this.resizeHandler = handler;
      return { dispose: () => {} };
    }

    __applyFit(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.resizeHandler?.({ cols, rows });
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
      fitSpy();
      const term = (this as any).__terminal;
      term?.__applyFit(120, 30);
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

describe('TerminalCore presentation scale', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fitSpy.mockReset();

    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => (
      setTimeout(() => cb(Date.now()), 0) as unknown as number
    );
    globalThis.cancelAnimationFrame = (id: number) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    };
    (globalThis as any).ResizeObserver = MockResizeObserver;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('scales the inner render host and suppresses remote resize notifications', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const handlers: TerminalEventHandlers = {
      onResize: vi.fn(),
    };

    const core = new TerminalCore(container, {}, handlers);
    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    vi.clearAllMocks();
    fitSpy.mockReset();

    core.setPresentationScale(2);
    await vi.runAllTimersAsync();

    const state = core as unknown as {
      renderHost?: HTMLDivElement | null;
      terminal?: { options?: { fontSize?: number } } | null;
    };

    expect(state.renderHost?.style.width).toBe('200%');
    expect(state.renderHost?.style.height).toBe('200%');
    expect(state.renderHost?.style.transform).toBe('scale(0.5)');
    expect(state.terminal?.options?.fontSize).toBe(24);
    expect(fitSpy).toHaveBeenCalled();
    expect(handlers.onResize).not.toHaveBeenCalled();

    core.dispose();
  });
});
