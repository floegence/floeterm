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
    scrollbackLength = 0;
    dataEmitter = new MockEventEmitter<string>();
    resizeEmitter = new MockEventEmitter<{ cols: number; rows: number }>();
    scrollEmitter = new MockEventEmitter<number>();
    selectionChangeEmitter = new MockEventEmitter<void>();
    cursorMoveEmitter = { fire: vi.fn() };
    onData = this.dataEmitter.event;
    onResize = this.resizeEmitter.event;
    onScroll = this.scrollEmitter.event;
    onSelectionChange = this.selectionChangeEmitter.event;
    selectionRequestRenderSpy = vi.fn();
    selectionManager: any;
    renderer: any;
    renderSpy = vi.fn();
    renderLineSpy = vi.fn();
    setThemeSpy = vi.fn(function (this: any, theme: Record<string, string>) {
      this.theme = theme;
    });
    fitSpy = vi.fn();
    writes: Array<string | Uint8Array> = [];
    lines = [
      [cell(65), cell(66)],
      [cell(67), cell(68)],
    ];
    dirtyRows = new Set([0, 1]);
    wasmTerm: any;

    constructor(opts: any) {
      this.cols = typeof opts?.cols === 'number' ? opts.cols : 80;
      this.rows = typeof opts?.rows === 'number' ? opts.rows : 24;
      this.options = {
        theme: opts?.theme ?? {},
        fontSize: opts?.fontSize,
        fontFamily: opts?.fontFamily,
        cursorBlink: opts?.cursorBlink,
      };
      this.buffer = { active: { length: 0 } };
      this.wasmTerm = {
        getCursor: () => ({ y: this.cursorY }),
        getDimensions: () => ({ cols: 2, rows: 2 }),
        getLine: (row: number) => this.lines[row] ?? null,
        getScrollbackLength: () => this.scrollbackLength,
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
        cursorVisible: true,
        cursorBlink: opts?.cursorBlink ?? false,
        setCursorBlinkSpy: vi.fn(function (this: any, enabled: boolean) {
          this.cursorBlink = enabled;
          this.cursorVisible = true;
        }),
        render: this.renderSpy,
        renderLine: this.renderLineSpy,
        setHoveredHyperlinkId: vi.fn(),
        setHoveredLinkRange: vi.fn(),
        setTheme: this.setThemeSpy,
      };
      this.renderer.setCursorBlink = this.renderer.setCursorBlinkSpy;
      this.selectionManager = {
        requestRender: this.selectionRequestRenderSpy,
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
      this.writes.push(_data);
      if (this.cursorY >= this.rows - 1) {
        this.scrollbackLength += 1;
        this.cursorY = 0;
      } else {
        this.cursorY += 1;
      }
      cb?.();
    }

    getScrollbackLength() {
      return this.scrollbackLength;
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
    __terminal: MockTerminal | undefined;

    fit() {
      this.__terminal?.fitSpy();
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
    terminal.rows = 24;
    terminal.cursorY = 0;

    core.write('one');
    core.write('two');

    expect(terminal.renderSpy).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);
    expect(terminal.cursorMoveEmitter.fire).toHaveBeenCalled();

    core.dispose();
  });

  it('forces a full repaint when terminal output scrolls the viewport', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.rows = 2;
    terminal.cursorY = 1;
    terminal.scrollbackLength = 0;
    terminal.renderSpy.mockClear();

    core.write('\r');
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);
    expect(terminal.renderSpy.mock.calls[0]?.[1]).toBe(true);

    core.dispose();
  });

  it('forces a full repaint when a write returns the viewport to the bottom', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.viewportY = 3;
    terminal.renderSpy.mockClear();

    terminal.write = vi.fn(function (this: any, data: string | Uint8Array, cb?: () => void) {
      this.writes.push(data);
      this.viewportY = 0;
      cb?.();
    });

    core.write('bottom');
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);
    expect(terminal.renderSpy.mock.calls[0]?.[1]).toBe(true);

    core.dispose();
  });

  it('keeps writes flowing while visual rendering is suspended', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();

    const suspend = core.beginVisualSuspend({ reason: 'workbench_widget_drag' });

    core.write('one');
    core.write('two');
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.writes).toEqual(['one', 'two']);
    expect(terminal.renderSpy).not.toHaveBeenCalled();

    suspend.dispose();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);

    core.dispose();
  });

  it('keeps visual rendering suspended until the last nested handle is disposed', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();

    const first = core.beginVisualSuspend({ reason: 'workbench_zoom' });
    const second = core.beginVisualSuspend({ reason: 'workbench_widget_drag' });

    core.write('x');
    first.dispose();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).not.toHaveBeenCalled();

    second.dispose();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);

    core.dispose();
  });

  it('defers forced renders and resize work during visual suspension', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();
    terminal.fitSpy.mockClear();

    const suspend = core.beginVisualSuspend({ reason: 'workbench_window_fit' });

    core.forceResize();
    core.setFontSize(16);
    core.clear();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.fitSpy).not.toHaveBeenCalled();
    expect(terminal.renderSpy).not.toHaveBeenCalled();

    suspend.dispose();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.fitSpy).toHaveBeenCalledTimes(1);
    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);
    expect(terminal.renderSpy.mock.calls[0]?.[1]).toBe(true);

    core.dispose();
  });

  it('applies theme immediately but defers the expensive theme repaint while suspended', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();

    const suspend = core.beginVisualSuspend({ reason: 'workbench_zoom' });

    core.setTheme({ background: '#000000', foreground: '#ffffff' });
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.setThemeSpy).toHaveBeenCalledTimes(1);
    expect(terminal.renderSpy).not.toHaveBeenCalled();

    suspend.dispose();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);
    expect(terminal.renderSpy.mock.calls[0]?.[1]).toBe(true);

    core.dispose();
  });

  it('keeps the cursor visible in demand rendering after input writes', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;

    expect(terminal.options.cursorBlink).toBe(false);
    expect(terminal.renderer.setCursorBlinkSpy).toHaveBeenCalledWith(false);

    terminal.renderer.cursorVisible = false;
    terminal.renderSpy.mockClear();

    core.write('x');
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderer.cursorVisible).toBe(true);
    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);

    core.dispose();
  });

  it('renders when the selection manager requests a redraw without firing selection events', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();

    terminal.selectionManager.requestRender();

    expect(terminal.selectionRequestRenderSpy).toHaveBeenCalledTimes(1);
    expect(terminal.renderSpy).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);

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

  it('does not skip unchanged rows that currently contain the cursor', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.cursorY = 0;

    terminal.dirtyRows = new Set([0]);
    terminal.renderer.render(terminal.wasmTerm, true, terminal.viewportY, terminal, terminal.scrollbarOpacity);
    terminal.renderLineSpy.mockClear();

    terminal.dirtyRows = new Set([0]);
    terminal.renderer.render(terminal.wasmTerm, false, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(terminal.renderLineSpy).toHaveBeenCalledTimes(1);
    expect(terminal.renderLineSpy.mock.calls[0]?.[1]).toBe(0);

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

  it('updates runtime theme without writing unsupported OSC color sequences', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();
    terminal.renderLineSpy.mockClear();
    terminal.writes.length = 0;

    core.setTheme({
      background: '#ffffff',
      foreground: '#333333',
      cursor: '#333333',
      black: '#000000',
      red: '#cd3131',
    });

    expect(terminal.setThemeSpy).toHaveBeenCalledWith(expect.objectContaining({
      background: '#ffffff',
      foreground: '#333333',
    }));
    expect(terminal.writes).toEqual([]);
    expect(terminal.renderSpy).toHaveBeenCalledWith(
      terminal.wasmTerm,
      true,
      terminal.viewportY,
      terminal,
      terminal.scrollbarOpacity,
    );
    const renderedCells = terminal.renderLineSpy.mock.calls[0]?.[0];
    expect(renderedCells?.[0]).toEqual(expect.objectContaining({
      fg_r: 51,
      fg_g: 51,
      fg_b: 51,
    }));

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
