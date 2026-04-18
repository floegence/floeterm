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
    textarea: HTMLTextAreaElement | null = null;
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
      this.element = container;
      const canvas = document.createElement('canvas');
      container.appendChild(canvas);
      const textarea = document.createElement('textarea');
      textarea.setAttribute('aria-label', 'Terminal input');
      container.appendChild(textarea);
      this.textarea = textarea;
      container.tabIndex = 0;
    }

    onData(_handler: (data: string) => void) {
      return { dispose: () => {} };
    }

    onResize(_handler: (size: { cols: number; rows: number }) => void) {
      return { dispose: () => {} };
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

    const textarea = container.querySelector('textarea[aria-label="Terminal input"]') as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();

    textarea!.dispatchEvent(createInputEvent('beforeinput', {
      data: 'x',
      inputType: 'insertText',
    }));

    expect(handlers.onData).toHaveBeenCalledTimes(1);
    expect(handlers.onData).toHaveBeenLastCalledWith('x');

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

    const textarea = container.querySelector('textarea[aria-label="Terminal input"]') as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();

    core.focus();

    expect(document.activeElement).toBe(textarea);

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

    const terminal = (core as unknown as { terminal?: { selectionText: string } | null }).terminal;
    expect(terminal).toBeTruthy();
    terminal!.selectionText = '  pnpm test\n';

    const textarea = container.querySelector('textarea[aria-label="Terminal input"]') as HTMLTextAreaElement | null;
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

    const terminal = (core as unknown as { terminal?: { selectionText: string } | null }).terminal;
    expect(terminal).toBeTruthy();
    terminal!.selectionText = 'pnpm test';

    container.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));

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
