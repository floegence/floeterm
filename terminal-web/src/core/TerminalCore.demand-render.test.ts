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
  const cell = (codepoint: number) => ({
    codepoint,
    fg_r: 255,
    fg_g: 255,
    fg_b: 255,
    bg_r: 0,
    bg_g: 0,
    bg_b: 0,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
  });

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
    renderer: any;
    renderSpy = vi.fn();
    renderLineSpy = vi.fn();
    lines = [
      [cell(65), cell(66)],
      [cell(67), cell(68)],
    ];
    dirtyRows = new Set([0, 1]);
    wasmTerm: any;

    constructor(opts: any) {
      this.cols = typeof opts?.cols === 'number' ? opts.cols : 80;
      this.rows = typeof opts?.rows === 'number' ? opts.rows : 24;
      this.options = { theme: opts?.theme ?? {}, fontSize: opts?.fontSize, fontFamily: opts?.fontFamily };
      this.buffer = { active: { length: 0 } };
      this.wasmTerm = {
        getCursor: () => ({ y: this.cursorY }),
        getDimensions: () => ({ cols: 2, rows: 2 }),
        getLine: (row: number) => this.lines[row] ?? null,
        isRowDirty: (row: number) => this.dirtyRows.has(row),
        clearDirty: () => {
          this.dirtyRows.clear();
        },
      };
      this.renderSpy = vi.fn(function (this: any, buffer: any, forceAll = false) {
        this.currentBuffer = buffer;
        const dimensions = buffer.getDimensions();
        for (let row = 0; row < dimensions.rows; row += 1) {
          if (forceAll || buffer.isRowDirty(row)) {
            this.renderLine(buffer.getLine(row), row, dimensions.cols);
          }
        }
        buffer.clearDirty();
      });
      this.renderLineSpy = vi.fn();
      this.renderer = {
        render: this.renderSpy,
        renderLine: this.renderLineSpy,
        setHoveredHyperlinkId: vi.fn(),
        setHoveredLinkRange: vi.fn(),
      };
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

    const renderCountAfterInit = terminal.renderSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);

    expect(terminal.animationFrameId).toBeUndefined();
    expect(terminal.renderSpy).toHaveBeenCalledTimes(renderCountAfterInit);

    core.dispose();
  });

  it('renders once for terminal output and coalesces writes on one frame', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();

    core.write('one');
    core.write('two');

    expect(terminal.renderSpy).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);
    expect(terminal.cursorMoveEmitter.fire).toHaveBeenCalled();

    core.dispose();
  });

  it('skips dirty rows whose rendered cell content is unchanged', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.cursorY = 99;
    terminal.renderer.lastCursorPosition = { y: 99 };

    terminal.dirtyRows = new Set([0, 1]);
    terminal.renderer.render(terminal.wasmTerm, true, terminal.viewportY, terminal, terminal.scrollbarOpacity);
    terminal.renderLineSpy.mockClear();

    terminal.dirtyRows = new Set([0, 1]);
    terminal.renderer.render(terminal.wasmTerm, false, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(terminal.renderLineSpy).not.toHaveBeenCalled();

    terminal.lines[1] = [
      { ...terminal.lines[1][0], codepoint: 69 },
      terminal.lines[1][1],
    ];
    terminal.dirtyRows = new Set([0, 1]);
    terminal.renderer.render(terminal.wasmTerm, false, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(terminal.renderLineSpy).toHaveBeenCalledTimes(1);
    expect(terminal.renderLineSpy.mock.calls[0]?.[1]).toBe(1);

    core.dispose();
  });

  it('delegates changed rows to ghostty-web native line rendering', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.cursorY = 99;
    terminal.renderer.lastCursorPosition = { y: 99 };

    terminal.renderLineSpy.mockClear();

    terminal.lines[0] = [
      { ...terminal.lines[0][0], codepoint: 65, bg_r: 32, bg_g: 32, bg_b: 32 },
      { ...terminal.lines[0][1], codepoint: 69, bg_r: 32, bg_g: 32, bg_b: 32 },
    ];
    terminal.dirtyRows = new Set([0]);
    terminal.renderer.render(terminal.wasmTerm, false, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(terminal.renderLineSpy).toHaveBeenCalledTimes(1);
    expect(terminal.renderLineSpy).toHaveBeenNthCalledWith(1, terminal.lines[0], 0, 2);

    core.dispose();
  });

  it('does not cache rows rendered under transient selection state', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.cursorY = 99;
    terminal.renderer.lastCursorPosition = { y: 99 };

    terminal.renderLineSpy.mockClear();
    terminal.renderer.currentSelectionCoords = { startRow: 0, endRow: 0 };
    terminal.dirtyRows = new Set([0]);
    terminal.renderer.render(terminal.wasmTerm, false, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(terminal.renderLineSpy).toHaveBeenCalledTimes(1);

    terminal.renderLineSpy.mockClear();
    terminal.renderer.currentSelectionCoords = null;
    terminal.dirtyRows = new Set([0]);
    terminal.renderer.render(terminal.wasmTerm, false, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(terminal.renderLineSpy).toHaveBeenCalledTimes(1);

    terminal.renderLineSpy.mockClear();
    terminal.dirtyRows = new Set([0]);
    terminal.renderer.render(terminal.wasmTerm, false, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(terminal.renderLineSpy).not.toHaveBeenCalled();

    core.dispose();
  });

  it('renders for scroll, selection, and hover invalidations', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();

    terminal.scrollLines(1);
    terminal.emitSelectionChange();
    terminal.renderer.setHoveredHyperlinkId(42);
    terminal.renderer.setHoveredLinkRange({ startX: 0, startY: 0, endX: 4, endY: 0 });

    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);

    core.dispose();
  });

  it('cancels a queued demand render on dispose', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();

    core.write('pending');
    core.dispose();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).not.toHaveBeenCalled();
  });
});
