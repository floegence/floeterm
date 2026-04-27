// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalCore } from './TerminalCore';

type MockDisposable = { dispose: () => void };

class MockEventEmitter<T> {
  private readonly listeners = new Set<(arg: T) => void>();

  event = (handler: (arg: T) => void): MockDisposable => {
    this.listeners.add(handler);
    return {
      dispose: () => {
        this.listeners.delete(handler);
      },
    };
  };

  fire(arg: T): void {
    for (const listener of this.listeners) {
      listener(arg);
    }
  }
}

const mockState = vi.hoisted(() => ({
  lastTerminal: null as any,
}));

vi.mock('ghostty-web', () => {
  class MockTerminal {
    cols: number;
    rows: number;
    options: any;
    buffer: any;
    element: HTMLElement | null = null;
    isOpen = false;
    isDisposed = false;
    animationFrameId: number | undefined;
    viewportY = 0;
    scrollbarOpacity = 0;
    lastCursorY = 0;
    cursorY = 0;
    dataEmitter = new MockEventEmitter<string>();
    resizeEmitter = new MockEventEmitter<{ cols: number; rows: number }>();
    scrollEmitter = new MockEventEmitter<number>();
    selectionChangeEmitter = new MockEventEmitter<void>();
    cursorMoveEmitter = { fire: vi.fn() };
    onData = this.dataEmitter.event;
    onResize = this.resizeEmitter.event;
    onScroll = this.scrollEmitter.event;
    onSelectionChange = this.selectionChangeEmitter.event;
    renderer = {
      render: vi.fn(),
      setHoveredHyperlinkId: vi.fn(),
      setHoveredLinkRange: vi.fn(),
    };
    wasmTerm = {
      getCursor: () => ({ y: this.cursorY }),
    };

    constructor(opts: any) {
      this.cols = typeof opts?.cols === 'number' ? opts.cols : 80;
      this.rows = typeof opts?.rows === 'number' ? opts.rows : 24;
      this.options = { theme: opts?.theme ?? {}, fontSize: opts?.fontSize, fontFamily: opts?.fontFamily };
      this.buffer = { active: { length: 0 } };
      mockState.lastTerminal = this;
    }

    loadAddon(addon: any) {
      addon.__terminal = this;
    }

    open(container: HTMLElement) {
      this.element = container;
      this.isOpen = true;
      this.renderer.render(this.wasmTerm, true, this.viewportY, this, this.scrollbarOpacity);
      this.startRenderLoop();
    }

    startRenderLoop() {
      const loop = () => {
        if (!this.isDisposed && this.isOpen) {
          this.renderer.render(this.wasmTerm, false, this.viewportY, this, this.scrollbarOpacity);
          this.animationFrameId = requestAnimationFrame(loop);
        }
      };
      loop();
    }

    write(_data: string | Uint8Array, cb?: () => void) {
      this.cursorY += 1;
      cb?.();
    }

    scrollLines(amount: number) {
      this.viewportY += amount;
      this.scrollEmitter.fire(this.viewportY);
    }

    emitSelectionChange() {
      this.selectionChangeEmitter.fire(undefined);
    }

    clear() {}
    getSelection() {
      return '';
    }
    focus() {}
    dispose() {
      this.isDisposed = true;
      this.isOpen = false;
      if (this.animationFrameId !== undefined) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = undefined;
      }
    }
  }

  class MockFitAddon {
    fit() {
      // noop
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

const createCore = async (): Promise<TerminalCore> => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

  const core = new TerminalCore(container, {});
  const init = core.initialize();
  await vi.runAllTimersAsync();
  await init;
  return core;
};

describe('TerminalCore demand rendering', () => {
  beforeEach(() => {
    vi.useFakeTimers();

    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      return setTimeout(() => cb(Date.now()), 0) as unknown as number;
    };
    globalThis.cancelAnimationFrame = (id: number) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    };
    (globalThis as any).ResizeObserver = MockResizeObserver;
    mockState.lastTerminal = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('does not keep ghostty-web rendering while the terminal is idle', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;

    const renderCountAfterInit = terminal.renderer.render.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);

    expect(terminal.animationFrameId).toBeUndefined();
    expect(terminal.renderer.render).toHaveBeenCalledTimes(renderCountAfterInit);

    core.dispose();
  });

  it('renders once for terminal output and coalesces writes on one frame', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderer.render.mockClear();

    core.write('one');
    core.write('two');

    expect(terminal.renderer.render).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderer.render).toHaveBeenCalledTimes(1);
    expect(terminal.cursorMoveEmitter.fire).toHaveBeenCalled();

    core.dispose();
  });

  it('renders for scroll, selection, and hover invalidations', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderer.render.mockClear();

    terminal.scrollLines(1);
    terminal.emitSelectionChange();
    terminal.renderer.setHoveredHyperlinkId(42);
    terminal.renderer.setHoveredLinkRange({ startX: 0, startY: 0, endX: 4, endY: 0 });

    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderer.render).toHaveBeenCalledTimes(1);

    core.dispose();
  });

  it('cancels a queued demand render on dispose', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderer.render.mockClear();

    core.write('pending');
    core.dispose();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderer.render).not.toHaveBeenCalled();
  });
});
