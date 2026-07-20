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

const mockFabric = vi.hoisted(() => ({
  attachView: vi.fn(),
  startFrame: vi.fn(),
  writeRow: vi.fn(),
  finishFrame: vi.fn(() => ({
    rendered: true,
    renderedRows: 0,
    dirtyCells: 0,
  })),
  setAppearance: vi.fn(),
  setVisible: vi.fn(),
  dispose: vi.fn(),
  renderer: null as any,
}));

vi.mock('../fabric/TerminalLiveFabric', async importOriginal => {
  const actual = await importOriginal<typeof import('../fabric/TerminalLiveFabric')>();
  const renderer = {
    backend: 'beamterm_webgl2',
    renderPath: 'main_thread_webgl2',
    initialize: vi.fn(),
    isActive: vi.fn(() => true),
    startFrame: mockFabric.startFrame,
    writeRow: mockFabric.writeRow,
    finishFrame: mockFabric.finishFrame,
    resize: vi.fn(),
    getGeometry: vi.fn(() => null),
    setAppearance: mockFabric.setAppearance,
    setVisible: mockFabric.setVisible,
    loseContextForTest: vi.fn(),
    getDiagnostics: vi.fn(),
    dispose: mockFabric.dispose,
  };
  mockFabric.renderer = renderer;

  return {
    ...actual,
    terminalLiveFabric: {
      attachView: mockFabric.attachView.mockResolvedValue({
        viewId: 'mock-view',
        sessionId: 'mock-session',
        renderer,
        dispose: mockFabric.dispose,
      }),
    },
  };
});

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
    ghosttyCanvas = document.createElement('canvas');
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
        metrics: { width: 8, height: 16, baseline: 13 },
        cursorVisible: true,
        cursorBlink: opts?.cursorBlink ?? false,
        getCanvas: vi.fn(() => this.ghosttyCanvas),
        getMetrics: vi.fn(function (this: any) {
          return { ...this.metrics };
        }),
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
        hasSelection: vi.fn(() => Boolean(this.renderer.currentSelectionCoords)),
        getSelectionCoords: vi.fn(() => this.renderer.currentSelectionCoords),
      };
      mockState.lastTerminal = this;
    }

    loadAddon(addon: any) {
      addon.__terminal = this;
    }

    open(container: HTMLElement) {
      this.element = container;
      this.isOpen = true;
      const textarea = document.createElement('textarea');
      textarea.setAttribute('aria-label', 'Terminal input');
      container.appendChild(textarea);
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
    proposeDimensions?: () => { cols: number; rows: number } | undefined;

    fit() {
      const dims = this.proposeDimensions?.();
      if (dims && this.__terminal) {
        this.__terminal.cols = dims.cols;
        this.__terminal.rows = dims.rows;
        this.__terminal.resizeEmitter.fire(dims);
      }
      this.__terminal?.fitSpy();
    }
  }

  const init = vi.fn().mockResolvedValue(undefined);

  return {
    Terminal: MockTerminal,
    FitAddon: MockFitAddon,
    LinkDetector: class { registerProvider() {} },
    OSC8LinkProvider: class {},
    UrlRegexProvider: class {},
    init,
  };
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

const createWebGLCore = async (): Promise<TerminalCore> => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

  const core = new TerminalCore(container, { rendererType: 'webgl', sessionId: 'session-a' });
  const init = core.initialize();
  await vi.runAllTimersAsync();
  await init;
  core.setConnected(true);
  await vi.runAllTimersAsync();
  return core;
};

describe('TerminalCore demand rendering', () => {
  beforeEach(() => {
    vi.useFakeTimers();

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      scale: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      return setTimeout(() => cb(Date.now()), 0) as unknown as number;
    };
    globalThis.cancelAnimationFrame = (id: number) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    };
    (globalThis as any).ResizeObserver = MockResizeObserver;
    mockState.lastTerminal = null;
    Object.values(mockFabric).forEach(value => {
      if (typeof value === 'function' && 'mockClear' in value) {
        value.mockClear();
      }
    });
    mockFabric.finishFrame.mockReturnValue({
      rendered: true,
      renderedRows: 2,
      dirtyCells: 4,
    });
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

  it('reports each completed demand render to the host', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });
    const onRender = vi.fn();
    const core = new TerminalCore(container, {}, { onRender });
    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;
    onRender.mockClear();

    core.write('visible');
    await vi.runOnlyPendingTimersAsync();

    expect(onRender).toHaveBeenCalledTimes(1);
    expect(onRender).toHaveBeenCalledWith(expect.any(Number));
    expect(onRender.mock.calls[0]![0]).toBeGreaterThanOrEqual(0);

    core.dispose();
  });

  it('reports WebGL renders only after the active Beamterm frame commits', async () => {
    let resolveAttach!: (handle: any) => void;
    mockFabric.attachView.mockReturnValueOnce(new Promise(resolve => {
      resolveAttach = resolve;
    }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });
    const onRender = vi.fn();
    const core = new TerminalCore(
      container,
      { rendererType: 'webgl', sessionId: 'session-a' },
      { onRender },
    );
    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;
    onRender.mockClear();

    core.setConnected(true);
    await vi.runAllTimersAsync();
    expect(mockFabric.attachView).toHaveBeenCalledTimes(1);

    core.forceResize();
    await vi.runOnlyPendingTimersAsync();

    expect(mockState.lastTerminal.renderSpy).toHaveBeenCalled();
    expect(onRender).not.toHaveBeenCalled();

    mockFabric.startFrame.mockClear();
    mockFabric.writeRow.mockClear();
    mockFabric.finishFrame.mockClear();
    resolveAttach({
      viewId: 'mock-view',
      sessionId: 'mock-session',
      renderer: mockFabric.renderer,
      dispose: mockFabric.dispose,
    });
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();

    expect(mockFabric.startFrame).toHaveBeenCalledWith(
      expect.objectContaining({ forceAll: true }),
      expect.objectContaining({ rows: 2 }),
    );
    expect(mockFabric.writeRow).toHaveBeenCalledTimes(2);
    expect(mockFabric.finishFrame).toHaveBeenCalledTimes(1);
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(onRender).toHaveBeenCalledWith(expect.any(Number));

    core.dispose();
  });

  it('does not report a WebGL render when Beamterm declines the frame', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });
    const onRender = vi.fn();
    const core = new TerminalCore(
      container,
      { rendererType: 'webgl', sessionId: 'session-a' },
      { onRender },
    );
    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;
    core.setConnected(true);
    await vi.runAllTimersAsync();
    onRender.mockClear();
    mockFabric.finishFrame.mockReturnValue({ rendered: false, renderedRows: 0, dirtyCells: 0 });

    core.forceResize();
    await vi.runOnlyPendingTimersAsync();

    expect(mockFabric.finishFrame).toHaveBeenCalled();
    expect(onRender).not.toHaveBeenCalled();

    core.dispose();
  });

  it('parses and renders frame-owned output without scheduling another RAF', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();

    core.writeFrame('visible-now');

    expect(terminal.writes).toEqual(['visible-now']);
    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

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

  it('keeps terminal output live when legacy visual suspend handles are active', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();

    const suspend = core.beginVisualSuspend({ reason: 'workbench_widget_drag' });

    core.write('one');
    core.write('two');
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.writes).toEqual(['one', 'two']);
    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);

    suspend.dispose();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);

    core.dispose();
  });

  it('keeps terminal rendering live while nested legacy suspend handles are active', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();

    const first = core.beginVisualSuspend({ reason: 'workbench_zoom' });
    const second = core.beginVisualSuspend({ reason: 'workbench_widget_drag' });

    core.write('x');
    first.dispose();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);

    second.dispose();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);

    core.dispose();
  });

  it('keeps forced renders and resize work live when legacy suspend is active', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();
    terminal.fitSpy.mockClear();

    const suspend = core.beginVisualSuspend({ reason: 'workbench_window_fit' });

    core.forceResize();
    core.setFontSize(16);
    core.clear();
    await vi.runOnlyPendingTimersAsync();

    const fitCountBeforeDispose = terminal.fitSpy.mock.calls.length;
    const renderCountBeforeDispose = terminal.renderSpy.mock.calls.length;
    expect(fitCountBeforeDispose).toBeGreaterThan(0);
    expect(renderCountBeforeDispose).toBeGreaterThan(0);
    expect((terminal.renderSpy.mock.calls as unknown[][]).some(call => call[1] === true)).toBe(true);

    suspend.dispose();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.fitSpy).toHaveBeenCalledTimes(fitCountBeforeDispose);
    expect(terminal.renderSpy).toHaveBeenCalledTimes(renderCountBeforeDispose);

    core.dispose();
  });

  it('coalesces repeated forced resize renders into one scheduled frame', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();
    terminal.fitSpy.mockClear();

    core.forceResize();
    core.forceResize();
    core.forceResize();

    expect(terminal.fitSpy).toHaveBeenCalledTimes(3);
    expect(terminal.renderSpy).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(1);
    expect(terminal.renderSpy.mock.calls[0]?.[1]).toBe(true);

    core.dispose();
  });

  it('resizes the WebGL host even when the shared fixed grid is unchanged', async () => {
    const core = await createWebGLCore();
    const host = (core as any).renderHost as HTMLElement;
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });
    core.setFixedDimensions(core.getDimensions());
    await vi.runOnlyPendingTimersAsync();
    mockFabric.renderer.resize.mockClear();

    core.forceResize();

    expect(mockFabric.renderer.resize).toHaveBeenCalledTimes(1);

    core.dispose();
  });

  it('preserves the WebGL surface while a fixed-grid view has no visible host size', async () => {
    const core = await createWebGLCore();
    const host = (core as any).renderHost as HTMLElement;
    core.setFixedDimensions(core.getDimensions());
    await vi.runOnlyPendingTimersAsync();
    mockFabric.renderer.resize.mockClear();
    Object.defineProperty(host, 'clientWidth', { value: 0, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 0, configurable: true });

    core.forceResize();

    expect(mockFabric.renderer.resize).not.toHaveBeenCalled();

    Object.defineProperty(host, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 320, configurable: true });
    core.forceResize();

    expect(mockFabric.renderer.resize).toHaveBeenCalledWith(640, 320);
    core.dispose();
  });

  it('applies theme and repaints immediately when legacy suspend is active', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.renderSpy.mockClear();

    const suspend = core.beginVisualSuspend({ reason: 'workbench_zoom' });

    core.setTheme({ background: '#000000', foreground: '#ffffff' });
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.setThemeSpy).toHaveBeenCalledTimes(1);
    const renderCountBeforeDispose = terminal.renderSpy.mock.calls.length;
    expect(renderCountBeforeDispose).toBeGreaterThan(0);

    suspend.dispose();
    await vi.runOnlyPendingTimersAsync();

    expect(terminal.renderSpy).toHaveBeenCalledTimes(renderCountBeforeDispose);

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

  it('mirrors webgl render rows into the Beamterm live fabric path', async () => {
    const core = await createWebGLCore();
    const terminal = mockState.lastTerminal;

    expect(mockFabric.attachView).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-a',
      viewId: expect.stringMatching(/^floeterm-view-/),
    }));

    mockFabric.startFrame.mockClear();
    mockFabric.writeRow.mockClear();
    mockFabric.finishFrame.mockClear();
    terminal.dirtyRows = new Set([0, 1]);
    terminal.renderer.render(terminal.wasmTerm, true, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(mockFabric.startFrame).toHaveBeenCalledWith(
      expect.objectContaining({ forceAll: true }),
      expect.objectContaining({ cols: 2, rows: 2 }),
    );
    expect(mockFabric.writeRow).toHaveBeenCalledTimes(2);
    expect(mockFabric.writeRow).toHaveBeenNthCalledWith(
      1,
      terminal.renderer,
      0,
      expect.arrayContaining([
        expect.objectContaining({ codepoint: 65 }),
        expect.objectContaining({ codepoint: 66 }),
      ]),
      2,
      expect.objectContaining({ selection: null }),
    );
    expect(mockFabric.finishFrame).toHaveBeenCalledWith(expect.any(Object));

    core.dispose();
    expect(mockFabric.dispose).toHaveBeenCalled();
  });

  it('surfaces Beamterm initialization failure as an explicit terminal error', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });
    const onError = vi.fn();
    const onStateChange = vi.fn();
    const core = new TerminalCore(
      container,
      { rendererType: 'webgl', sessionId: 'session-error' },
      { onError, onStateChange },
    );
    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;
    mockFabric.attachView.mockRejectedValueOnce(new Error('WebGL2 unavailable'));

    core.setConnected(true);
    await vi.runAllTimersAsync();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'WebGL2 unavailable' }));
    expect(onStateChange).toHaveBeenLastCalledWith('error');
    expect(mockState.lastTerminal.ghosttyCanvas.style.opacity).toBe('0');

    core.dispose();
  });

  it('keeps Beamterm live fabric as the display owner during selection', async () => {
    const core = await createWebGLCore();
    const terminal = mockState.lastTerminal;

    mockFabric.writeRow.mockClear();
    terminal.renderLineSpy.mockClear();
    terminal.cursorY = 99;
    terminal.renderer.lastCursorPosition = { y: 99 };
    terminal.dirtyRows = new Set([0, 1]);

    terminal.renderer.render(terminal.wasmTerm, true, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(mockFabric.writeRow).toHaveBeenCalledTimes(2);
    expect(terminal.renderLineSpy).not.toHaveBeenCalled();

    mockFabric.writeRow.mockClear();
    terminal.renderer.currentSelectionCoords = { startCol: 0, startRow: 0, endCol: 1, endRow: 0 };
    terminal.dirtyRows = new Set([0]);
    terminal.renderer.render(terminal.wasmTerm, false, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(mockFabric.writeRow).toHaveBeenCalledTimes(1);
    expect(mockFabric.writeRow.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
      selection: expect.objectContaining({
        foreground: { r: 31, g: 35, b: 40 },
        background: { r: 245, g: 230, b: 179 },
      }),
    }));
    expect(terminal.renderLineSpy).not.toHaveBeenCalled();

    core.dispose();
  });

  it('syncs selection-manager redraws into the Beamterm fabric frame', async () => {
    const core = await createWebGLCore();
    const terminal = mockState.lastTerminal;
    terminal.cursorY = 99;
    terminal.renderer.lastCursorPosition = { y: 99 };

    mockFabric.writeRow.mockClear();
    terminal.renderer.currentSelectionCoords = { startCol: 0, startRow: 0, endCol: 1, endRow: 0 };
    terminal.selectionManager.requestRender();
    await vi.runOnlyPendingTimersAsync();

    expect(mockFabric.writeRow).toHaveBeenCalledWith(
      terminal.renderer,
      0,
      expect.arrayContaining([
        expect.objectContaining({ codepoint: 65 }),
      ]),
      2,
      expect.objectContaining({
        selection: expect.objectContaining({
          foreground: { r: 31, g: 35, b: 40 },
          background: { r: 245, g: 230, b: 179 },
        }),
      }),
    );

    core.dispose();
  });

  it('skips Beamterm-owned cursor rows without falling back to hidden canvas painting', async () => {
    const core = await createWebGLCore();
    const terminal = mockState.lastTerminal;

    mockFabric.writeRow.mockClear();
    terminal.renderLineSpy.mockClear();
    terminal.cursorY = 0;
    terminal.renderer.lastCursorPosition = { y: 0 };
    terminal.dirtyRows = new Set([0]);

    terminal.renderer.render(terminal.wasmTerm, false, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(mockFabric.writeRow).toHaveBeenCalledTimes(1);
    expect(terminal.renderLineSpy).not.toHaveBeenCalled();

    core.dispose();
  });

  it('does not block terminal readiness and waits for connection before attaching Beamterm live fabric', async () => {
    let resolveAttach!: (handle: any) => void;
    mockFabric.attachView.mockReturnValueOnce(new Promise(resolve => {
      resolveAttach = resolve;
    }));

    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const core = new TerminalCore(container, { rendererType: 'webgl', sessionId: 'session-a' });
    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    expect(core.getState()).toBe('ready');
    expect(mockFabric.attachView).not.toHaveBeenCalled();

    core.setConnected(true);
    await vi.runAllTimersAsync();

    expect(mockFabric.attachView).toHaveBeenCalled();

    resolveAttach({
      viewId: 'mock-view',
      sessionId: 'mock-session',
      renderer: {
        backend: 'beamterm_webgl2',
        renderPath: 'main_thread_webgl2',
        initialize: vi.fn(),
        isActive: vi.fn(() => true),
        startFrame: mockFabric.startFrame,
        writeRow: mockFabric.writeRow,
        finishFrame: mockFabric.finishFrame,
        resize: vi.fn(),
        getGeometry: vi.fn(() => null),
        setAppearance: mockFabric.setAppearance,
        setVisible: mockFabric.setVisible,
        loseContextForTest: vi.fn(),
        getDiagnostics: vi.fn(),
        dispose: mockFabric.dispose,
      },
      dispose: mockFabric.dispose,
    });
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();

    core.dispose();
  });

  it('fits the terminal grid from Beamterm geometry after the WebGL renderer attaches', async () => {
    const core = await createWebGLCore();
    vi.mocked(mockFabric.renderer.getGeometry).mockReturnValue({
      width: 800,
      height: 400,
      cellWidth: 9,
      cellHeight: 19,
      cols: 88,
      rows: 21,
    });

    core.forceResize();

    expect(core.getDimensions()).toEqual({ cols: 88, rows: 21 });

    core.dispose();
  });

  it('aligns the hidden ghostty selection canvas to Beamterm cell geometry', async () => {
    const core = await createWebGLCore();
    const terminal = mockState.lastTerminal;
    vi.mocked(mockFabric.renderer.getGeometry).mockReturnValue({
      width: 800,
      height: 401,
      cellWidth: 4.5,
      cellHeight: 9.5,
      cols: 177,
      rows: 42,
    });

    core.forceResize();

    expect(terminal.renderer.metrics).toMatchObject({
      width: 4.5,
      height: 9.5,
    });
    expect(terminal.ghosttyCanvas.style.width).toBe('796.5px');
    expect(terminal.ghosttyCanvas.style.height).toBe('399px');
    expect(terminal.ghosttyCanvas.style.maxWidth).toBe('none');
    expect(terminal.ghosttyCanvas.style.maxHeight).toBe('none');
    expect(terminal.ghosttyCanvas.style.position).toBe('absolute');
    expect(terminal.ghosttyCanvas.style.left).toBe('0px');
    expect(terminal.ghosttyCanvas.style.top).toBe('0px');

    core.dispose();
  });

  it('does not cache rows rendered under transient selection state', async () => {
    const core = await createCore();
    const terminal = mockState.lastTerminal;
    terminal.cursorY = 99;
    terminal.renderer.lastCursorPosition = { y: 99 };

    terminal.renderLineSpy.mockClear();
    terminal.renderer.currentSelectionCoords = { startCol: 0, startRow: 0, endCol: 1, endRow: 0 };
    terminal.dirtyRows = new Set([0]);
    terminal.renderer.render(terminal.wasmTerm, false, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(terminal.renderLineSpy).toHaveBeenCalledTimes(1);

    terminal.renderLineSpy.mockClear();
    terminal.dirtyRows = new Set([0]);
    terminal.renderer.render(terminal.wasmTerm, false, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(terminal.renderLineSpy).toHaveBeenCalledTimes(1);

    core.dispose();
  });

  it('forces Beamterm rows once after transient selection clears', async () => {
    const core = await createWebGLCore();
    const terminal = mockState.lastTerminal;
    terminal.cursorY = 99;
    terminal.renderer.lastCursorPosition = { y: 99 };

    terminal.renderer.currentSelectionCoords = { startRow: 0, endRow: 0 };
    terminal.dirtyRows = new Set([0]);
    terminal.renderer.render(terminal.wasmTerm, false, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    mockFabric.writeRow.mockClear();
    terminal.renderer.currentSelectionCoords = null;
    terminal.dirtyRows = new Set();
    terminal.renderer.render(terminal.wasmTerm, false, terminal.viewportY, terminal, terminal.scrollbarOpacity);

    expect(mockFabric.writeRow).toHaveBeenCalledTimes(2);

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
