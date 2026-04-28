// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalCore } from './TerminalCore';

const mockState = vi.hoisted(() => ({
  fontLoadCalls: [] as string[],
  constructorLoadCallCounts: [] as number[],
  remeasureFont: vi.fn(),
}));

vi.mock('ghostty-web', () => {
  class MockTerminal {
    cols: number;
    rows: number;
    options: any;
    buffer: any;
    element: HTMLElement | null = null;
    renderer = {
      getMetrics: () => ({ width: 8, height: 16 }),
      remeasureFont: mockState.remeasureFont,
    };
    private resizeHandler: ((size: { cols: number; rows: number }) => void) | null = null;

    constructor(opts: any) {
      mockState.constructorLoadCallCounts.push(mockState.fontLoadCalls.length);
      this.cols = typeof opts?.cols === 'number' ? opts.cols : 80;
      this.rows = typeof opts?.rows === 'number' ? opts.rows : 24;
      this.options = { theme: opts?.theme ?? {}, fontSize: opts?.fontSize, fontFamily: opts?.fontFamily };
      this.buffer = { active: { length: 0 } };
    }

    loadAddon(addon: any) {
      addon.__terminal = this;
      addon.activate?.(this);
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
    __terminal: MockTerminal | null = null;
    proposeDimensions?: () => { cols: number; rows: number } | undefined;

    activate(terminal: MockTerminal) {
      this.__terminal = terminal;
    }

    fit() {
      const dims = this.proposeDimensions?.();
      if (!dims || !this.__terminal) return;
      this.__terminal.__applyFit(dims.cols, dims.rows);
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

describe('TerminalCore geometry stability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.fontLoadCalls.length = 0;
    mockState.constructorLoadCallCounts.length = 0;
    mockState.remeasureFont.mockClear();

    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => (
      setTimeout(() => cb(Date.now()), 0) as unknown as number
    );
    globalThis.cancelAnimationFrame = (id: number) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    };
    (globalThis as any).ResizeObserver = MockResizeObserver;
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        load: vi.fn(async (font: string) => {
          mockState.fontLoadCalls.push(font);
          return [];
        }),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    delete (document as unknown as { fonts?: unknown }).fonts;
  });

  it('loads the configured terminal font before ghostty measures it', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const core = new TerminalCore(container, {
      fontFamily: '"Iosevka", "SF Mono", monospace',
      fontSize: 12,
    });

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    expect(mockState.fontLoadCalls[0]).toBe('12px "Iosevka", "SF Mono", monospace');
    expect(mockState.constructorLoadCallCounts[0]).toBeGreaterThanOrEqual(1);

    core.dispose();
  });

  it('uses a configurable scrollbar reserve when proposing fitted dimensions', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const core = new TerminalCore(container, {
      fit: {
        scrollbarReservePx: 0,
      },
    });

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;
    await vi.runAllTimersAsync();

    expect(core.getDimensions()).toEqual({ cols: 100, rows: 25 });

    core.dispose();
  });

  it('preserves ghostty-web scrollbar reserve by default', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const core = new TerminalCore(container, {});

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;
    await vi.runAllTimersAsync();

    expect(core.getDimensions()).toEqual({ cols: 98, rows: 25 });

    core.dispose();
  });
});
