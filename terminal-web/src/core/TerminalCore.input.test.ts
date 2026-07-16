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
    canvas: HTMLCanvasElement | null = null;
    textarea: HTMLTextAreaElement | null = null;
    dataHandler: ((data: string) => void) | null = null;
    cursor = { x: 0, y: 0, visible: true };
    scrollHandler: (() => void) | null = null;
    renderer: any;
    wasmTerm: any;
    selectionManager: {
      copySpy: ReturnType<typeof vi.fn>;
      copyToClipboard: (text: string) => Promise<void>;
    };
    selectionText = '';

    constructor(opts: any) {
      this.cols = typeof opts?.cols === 'number' ? opts.cols : 80;
      this.rows = typeof opts?.rows === 'number' ? opts.rows : 24;
      this.options = { theme: opts?.theme ?? {}, fontSize: opts?.fontSize, fontFamily: opts?.fontFamily };
      this.buffer = { active: { length: 0 } };
      this.renderer = {
        metrics: { width: 10, height: 20, baseline: 16 },
        getCanvas: () => this.canvas,
        getMetrics: () => this.renderer.metrics,
        render: vi.fn(),
      };
      this.wasmTerm = {
        getCursor: () => this.cursor,
      };
      const copySpy = vi.fn().mockResolvedValue(undefined);
      this.selectionManager = {
        copySpy,
        copyToClipboard: (text: string) => copySpy(text),
      };
    }

    loadAddon(addon: any) {
      addon.__terminal = this;
    }

    open(container: HTMLElement) {
      container.tabIndex = 0;
      container.setAttribute('contenteditable', 'true');
      container.setAttribute('aria-label', 'Terminal input');
      container.setAttribute('role', 'textbox');
      this.element = container;
      const canvas = document.createElement('canvas');
      container.appendChild(canvas);
      this.canvas = canvas;
      const textarea = document.createElement('textarea');
      textarea.setAttribute('aria-label', 'Terminal input');
      container.appendChild(textarea);
      this.textarea = textarea;
      container.addEventListener('keydown', (event) => {
        let data = '';
        if (event.key === 'Enter') data = '\r';
        if (event.key === 'Backspace') data = '\x7f';
        if (event.ctrlKey && event.code === 'KeyC') data = '\x03';
        if (!data) return;
        event.preventDefault();
        event.stopPropagation();
        this.dataHandler?.(data);
      });
    }

    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
      return { dispose: () => {
        if (this.dataHandler === handler) this.dataHandler = null;
      } };
    }

    onResize(_handler: (size: { cols: number; rows: number }) => void) {
      return { dispose: () => {} };
    }

    onScroll(handler: () => void) {
      this.scrollHandler = handler;
      return { dispose: () => {
        if (this.scrollHandler === handler) this.scrollHandler = null;
      } };
    }

    write(_data: string | Uint8Array, cb?: () => void) {
      cb?.();
    }

    clear() {}
    getSelection() {
      return this.selectionText;
    }
    focus() {
      this.element?.focus();
      setTimeout(() => {
        this.element?.focus();
      }, 0);
    }
    dispose() {}
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

const createInputEvent = (
  type: string,
  init: { data?: string | null; inputType?: string; isComposing?: boolean } = {},
): InputEvent => {
  const event = new Event(type, { bubbles: true, cancelable: true }) as InputEvent;
  Object.defineProperty(event, 'data', { value: init.data ?? null });
  Object.defineProperty(event, 'inputType', { value: init.inputType ?? '' });
  Object.defineProperty(event, 'isComposing', { value: Boolean(init.isComposing) });
  return event;
};

const setCanvasRect = (
  canvas: HTMLCanvasElement,
  left: number,
  top: number,
  width: number,
  height: number,
  clientWidth = width,
  clientHeight = height,
) => {
  Object.defineProperty(canvas, 'clientWidth', { value: clientWidth, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    value: () => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }),
    configurable: true,
  });
};

const initializeCore = async (
  config: Record<string, unknown> = {},
  handlers: TerminalEventHandlers = {},
) => {
  const container = document.createElement('div');
  container.tabIndex = 0;
  document.body.appendChild(container);
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

  const core = new TerminalCore(container, config as any, handlers);
  const init = core.initialize();
  await vi.runAllTimersAsync();
  await init;

  const terminal = (core as unknown as { terminal?: any | null }).terminal;
  const textarea = terminal?.textarea as HTMLTextAreaElement | null;
  const canvas = terminal?.canvas as HTMLCanvasElement | null;
  expect(terminal).toBeTruthy();
  expect(textarea).toBeTruthy();
  expect(canvas).toBeTruthy();

  return {
    container,
    core,
    terminal: terminal!,
    textarea: textarea!,
    canvas: canvas!,
  };
};

describe('TerminalCore mobile input integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();

    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      return setTimeout(() => cb(Date.now()), 0) as unknown as number;
    };
    globalThis.cancelAnimationFrame = (id: number) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    };
    (globalThis as any).ResizeObserver = MockResizeObserver;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('bridges hidden textarea beforeinput to onData', async () => {
    const container = document.createElement('div');
    container.tabIndex = 0;
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const handlers: TerminalEventHandlers = { onData: vi.fn() };
    const core = new TerminalCore(container, {}, handlers);

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    const terminal = (core as unknown as { terminal?: { textarea?: HTMLTextAreaElement | null } | null }).terminal;
    const textarea = terminal?.textarea ?? null;
    expect(textarea).toBeTruthy();

    textarea!.dispatchEvent(createInputEvent('beforeinput', {
      data: 'x',
      inputType: 'insertText',
    }));

    expect(handlers.onData).toHaveBeenCalledTimes(1);
    expect(handlers.onData).toHaveBeenLastCalledWith('x');

    core.dispose();
  });

  it('bridges Enter keydown to terminal carriage return without beforeinput duplication', async () => {
    const container = document.createElement('div');
    container.tabIndex = 0;
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const handlers: TerminalEventHandlers = { onData: vi.fn() };
    const core = new TerminalCore(container, {}, handlers);

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    const terminal = (core as unknown as { terminal?: { textarea?: HTMLTextAreaElement | null } | null }).terminal;
    const textarea = terminal?.textarea ?? null;
    expect(textarea).toBeTruthy();

    const keydown = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    textarea!.dispatchEvent(keydown);
    textarea!.dispatchEvent(createInputEvent('beforeinput', {
      inputType: 'insertLineBreak',
    }));

    expect(keydown.defaultPrevented).toBe(true);
    expect(handlers.onData).toHaveBeenCalledTimes(1);
    expect(handlers.onData).toHaveBeenLastCalledWith('\r');

    core.dispose();
  });

  it('bridges Backspace keydown to terminal delete without beforeinput duplication', async () => {
    const container = document.createElement('div');
    container.tabIndex = 0;
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const handlers: TerminalEventHandlers = { onData: vi.fn() };
    const core = new TerminalCore(container, {}, handlers);

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    const terminal = (core as unknown as { terminal?: { textarea?: HTMLTextAreaElement | null } | null }).terminal;
    const textarea = terminal?.textarea ?? null;
    expect(textarea).toBeTruthy();

    const keydown = new KeyboardEvent('keydown', {
      key: 'Backspace',
      code: 'Backspace',
      bubbles: true,
      cancelable: true,
    });
    textarea!.dispatchEvent(keydown);
    textarea!.dispatchEvent(createInputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
    }));

    expect(keydown.defaultPrevented).toBe(true);
    expect(handlers.onData).toHaveBeenCalledTimes(1);
    expect(handlers.onData).toHaveBeenLastCalledWith('\x7f');

    core.dispose();
  });

  it('focuses the hidden textarea on touch-capable devices', async () => {
    const container = document.createElement('div');
    container.tabIndex = 0;
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(globalThis.navigator, 'maxTouchPoints', { value: 1, configurable: true });

    const core = new TerminalCore(container, {}, {});

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    const terminal = (core as unknown as { terminal?: { textarea?: HTMLTextAreaElement | null } | null }).terminal;
    const textarea = terminal?.textarea ?? null;
    expect(textarea).toBeTruthy();

    core.focus();

    expect(document.activeElement).toBe(textarea);

    core.dispose();
  });

  it('keeps the hidden textarea focused after desktop terminal focus handoff', async () => {
    Object.defineProperty(globalThis.navigator, 'maxTouchPoints', { value: 0, configurable: true });
    const { core, textarea } = await initializeCore();

    core.focus();

    expect(document.activeElement).toBe(textarea);

    await vi.runAllTimersAsync();

    expect(document.activeElement).toBe(textarea);

    core.dispose();
  });

  it('focuses terminal input surfaces without scrolling the terminal host', async () => {
    Object.defineProperty(globalThis.navigator, 'maxTouchPoints', { value: 0, configurable: true });
    let terminalHost: HTMLElement | null = null;
    let textareaElement: HTMLTextAreaElement | null = null;
    const focusCalls: Array<{ target: HTMLElement; options?: FocusOptions }> = [];
    const originalFocus = HTMLElement.prototype.focus;
    const focusSpy = vi
      .spyOn(HTMLElement.prototype, 'focus')
      .mockImplementation(function focus(this: HTMLElement, options?: FocusOptions) {
        focusCalls.push({ target: this, options });
        if (this === terminalHost && options?.preventScroll !== true) {
          terminalHost.scrollTop = 200;
        }
        if (this === textareaElement && options?.preventScroll !== true && terminalHost) {
          terminalHost.scrollTop = 300;
        }
        originalFocus.call(this);
      });
    const { core, terminal, textarea } = await initializeCore();
    terminalHost = terminal.element as HTMLElement;
    textareaElement = textarea;
    terminalHost.scrollTop = 42;

    core.focus();
    await vi.runAllTimersAsync();

    expect(terminalHost.scrollTop).toBe(42);
    expect(document.activeElement).toBe(textarea);
    expect(focusCalls.filter((call) => call.target === terminalHost).map((call) => call.options))
      .toEqual([{ preventScroll: true }, { preventScroll: true }]);
    expect(focusCalls.filter((call) => call.target === textarea).map((call) => call.options))
      .toEqual([{ preventScroll: true }, { preventScroll: true }]);

    focusSpy.mockRestore();
    core.dispose();
  });

  it('reclaims hidden textarea focus when ghostty contenteditable host receives focus directly', async () => {
    const { core, terminal, textarea } = await initializeCore();

    terminal.element.focus();
    expect(document.activeElement).toBe(terminal.element);

    await vi.runAllTimersAsync();

    expect(document.activeElement).toBe(textarea);

    core.dispose();
  });

  it('positions the hidden textarea at the terminal cursor for IME candidate anchoring', async () => {
    const { core, terminal, textarea, canvas } = await initializeCore();
    setCanvasRect(canvas, 40, 60, 800, 400);
    terminal.cursor = { x: 3, y: 2, visible: true };

    core.focus();

    expect(textarea.style.position).toBe('fixed');
    expect(textarea.style.left).toBe('70px');
    expect(textarea.style.top).toBe('100px');
    expect(textarea.style.width).toBe('10px');
    expect(textarea.style.height).toBe('20px');
    expect(textarea.style.lineHeight).toBe('20px');
    expect(textarea.style.clipPath).toBe('none');
    expect(textarea.parentElement).toBe(document.body);

    core.dispose();
  });

  it('uses visible cell geometry when an ancestor transform scales the terminal', async () => {
    const { core, terminal, textarea, canvas } = await initializeCore();
    setCanvasRect(canvas, 40, 60, 360, 180, 800, 400);
    terminal.cursor = { x: 3, y: 2, visible: true };

    core.focus();

    expect(textarea.style.left).toBe('53.5px');
    expect(textarea.style.top).toBe('78px');
    expect(textarea.style.width).toBe('4.5px');
    expect(textarea.style.height).toBe('9px');
    expect(textarea.style.lineHeight).toBe('9px');
    expect(textarea.parentElement).toBe(document.body);

    core.dispose();
  });

  it('removes the portaled input element when the core is disposed', async () => {
    const { core, textarea } = await initializeCore();

    expect(document.body.contains(textarea)).toBe(true);

    core.dispose();

    expect(document.body.contains(textarea)).toBe(false);
  });

  it('uses active fabric geometry for the IME anchor instead of stale ghostty metrics', async () => {
    const { core, terminal, textarea, canvas } = await initializeCore({ rendererType: 'webgl' });
    setCanvasRect(canvas, 10, 20, 800, 400);
    terminal.cursor = { x: 4, y: 1, visible: true };
    terminal.renderer.metrics = { width: 99, height: 99, baseline: 80 };
    (core as unknown as { fabricView: unknown }).fabricView = {
      viewId: 'test-view',
      sessionId: 'test-session',
      dispose: vi.fn(),
      renderer: {
        isActive: () => true,
        getGeometry: () => ({ cols: 120, rows: 30, cellWidth: 8, cellHeight: 18 }),
      },
    };

    core.focus();

    expect(textarea.style.left).toBe('42px');
    expect(textarea.style.top).toBe('38px');
    expect(textarea.style.width).toBe('8px');
    expect(textarea.style.height).toBe('18px');

    core.dispose();
  });

  it('updates the IME anchor after terminal scroll events', async () => {
    const { core, terminal, textarea, canvas } = await initializeCore();
    setCanvasRect(canvas, 100, 120, 800, 400);
    terminal.cursor = { x: 1, y: 1, visible: true };
    core.focus();
    expect(textarea.style.left).toBe('110px');
    expect(textarea.style.top).toBe('140px');

    terminal.cursor = { x: 5, y: 3, visible: true };
    terminal.scrollHandler?.();

    expect(textarea.style.left).toBe('150px');
    expect(textarea.style.top).toBe('180px');

    core.dispose();
  });

  it('does not overwrite transient native context-menu textarea placement', async () => {
    const { core, terminal, textarea, canvas } = await initializeCore();
    setCanvasRect(canvas, 40, 60, 800, 400);
    terminal.cursor = { x: 2, y: 2, visible: true };
    core.focus();

    textarea.style.pointerEvents = 'auto';
    textarea.style.zIndex = '1000';
    textarea.style.left = '321px';
    textarea.style.top = '654px';
    terminal.cursor = { x: 8, y: 8, visible: true };

    core.focus();
    await vi.runAllTimersAsync();

    expect(textarea.style.left).toBe('321px');
    expect(textarea.style.top).toBe('654px');

    core.dispose();
  });

  it('copies the active terminal selection through the standard copy event', async () => {
    const container = document.createElement('div');
    container.tabIndex = 0;
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const core = new TerminalCore(container, {}, {});

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    const terminal = (core as unknown as {
      terminal?: { selectionText: string; textarea?: HTMLTextAreaElement | null } | null;
    }).terminal;
    expect(terminal).toBeTruthy();
    terminal!.selectionText = '  pnpm test\n';

    const textarea = terminal?.textarea ?? null;
    expect(textarea).toBeTruthy();

    const setData = vi.fn();
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: { setData },
    });

    textarea!.dispatchEvent(event);

    expect(setData).toHaveBeenCalledWith('text/plain', '  pnpm test\n');

    core.dispose();
  });

  it('exposes semantic selection helpers for explicit copy commands', async () => {
    const container = document.createElement('div');
    container.tabIndex = 0;
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const core = new TerminalCore(container, {}, {});

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    const terminal = (core as unknown as { terminal?: { selectionText: string } | null }).terminal;
    expect(terminal).toBeTruthy();

    terminal!.selectionText = '';
    expect(core.hasSelection()).toBe(false);
    await expect(core.copySelection()).resolves.toEqual({
      copied: false,
      reason: 'empty_selection',
      source: 'command',
    });

    terminal!.selectionText = 'npm run lint';
    expect(core.hasSelection()).toBe(true);
    await expect(core.copySelection()).resolves.toEqual({
      copied: true,
      textLength: 'npm run lint'.length,
      source: 'command',
    });
    expect(writeText).toHaveBeenCalledWith('npm run lint');

    core.dispose();
  });

  it('copies the active terminal selection through the Cmd/Ctrl+C shortcut path', async () => {
    const container = document.createElement('div');
    container.tabIndex = 0;
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const core = new TerminalCore(container, {
      clipboard: {
        copyOnSelect: false,
      },
    }, {});

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    const terminal = (core as unknown as {
      terminal?: { element: HTMLElement; selectionText: string } | null;
    }).terminal;
    expect(terminal).toBeTruthy();
    terminal!.selectionText = 'pnpm test';

    terminal!.element.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));

    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    document.dispatchEvent(event);
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('pnpm test');
    expect(event.defaultPrevented).toBe(true);

    core.dispose();
  });

  it('disables copy-on-select side effects when configured', async () => {
    const container = document.createElement('div');
    container.tabIndex = 0;
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const core = new TerminalCore(container, {
      clipboard: {
        copyOnSelect: false,
      },
    }, {});

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    const terminal = (core as unknown as {
      terminal?: { selectionManager?: { copySpy: ReturnType<typeof vi.fn>; copyToClipboard: (text: string) => Promise<void> } } | null;
    }).terminal;
    expect(terminal?.selectionManager).toBeTruthy();

    await terminal!.selectionManager!.copyToClipboard('selected text');

    expect(terminal!.selectionManager!.copySpy).not.toHaveBeenCalled();

    core.dispose();
  });

  it('keeps copy-on-select behavior enabled by default', async () => {
    const container = document.createElement('div');
    container.tabIndex = 0;
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const core = new TerminalCore(container, {}, {});

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    const terminal = (core as unknown as {
      terminal?: { selectionManager?: { copySpy: ReturnType<typeof vi.fn>; copyToClipboard: (text: string) => Promise<void> } } | null;
    }).terminal;
    expect(terminal?.selectionManager).toBeTruthy();

    await terminal!.selectionManager!.copyToClipboard('selected text');

    expect(terminal!.selectionManager!.copySpy).toHaveBeenCalledWith('selected text');

    core.dispose();
  });
});
