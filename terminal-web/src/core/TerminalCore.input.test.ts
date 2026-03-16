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

    constructor(opts: any) {
      this.cols = typeof opts?.cols === 'number' ? opts.cols : 80;
      this.rows = typeof opts?.rows === 'number' ? opts.rows : 24;
      this.options = { theme: opts?.theme ?? {}, fontSize: opts?.fontSize, fontFamily: opts?.fontFamily };
      this.buffer = { active: { length: 0 } };
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
      return '';
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
});
