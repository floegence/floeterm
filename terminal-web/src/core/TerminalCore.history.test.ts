// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalCore } from './TerminalCore';

let terminalInstance: MockTerminal | null = null;
let pendingWriteCallback: (() => void) | null = null;

class MockTerminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown> = {};
  buffer = { active: { length: 0 } };
  element?: HTMLElement;
  renderer = { render: vi.fn(), getMetrics: () => ({ width: 8, height: 16 }) };
  wasmTerm = { isAlternateScreen: () => false };
  private dataHandler: ((data: string) => void) | null = null;

  handleMouseDown() {}
  showScrollbar() {}
  hideScrollbar() {}
  fadeInScrollbar() {}
  fadeOutScrollbar() {}
  animateScroll() {}
  targetViewportY = 0;
  getViewportY() { return 0; }
  getScrollbackLength() { return 0; }
  isAlternateScreen() { return false; }
  scrollToLine(_line: number) {}
  scrollToTop() {}
  scrollToBottom() {}
  scrollLines(_amount: number) {}
  scrollPages(_amount: number) {}
  onScroll() { return { dispose: () => {} }; }

  constructor() {
    terminalInstance = this;
  }

  loadAddon(addon: { __terminal?: MockTerminal }) { addon.__terminal = this; }
  open(container: HTMLElement) {
    this.element = container;
    const textarea = document.createElement('textarea');
    textarea.setAttribute('aria-label', 'Terminal input');
    container.appendChild(textarea);
  }
  onData(handler: (data: string) => void) {
    this.dataHandler = handler;
    return { dispose: () => { this.dataHandler = null; } };
  }
  onResize() { return { dispose: () => {} }; }
  write(data: string | Uint8Array, callback?: () => void) {
    if (data instanceof Uint8Array && data[0] === 1) {
      this.emitData('\x1b[12;34R');
      pendingWriteCallback = callback ?? null;
      return;
    }
    callback?.();
  }
  emitData(data: string) { this.dataHandler?.(data); }
  clear() {}
  getSelection() { return ''; }
  focus() {}
  dispose() {}
}

vi.mock('@floegence/ghostty-web', () => {
  class MockGhostty {
    readonly memory = new WebAssembly.Memory({ initial: 1 });
    static load = vi.fn(async () => new MockGhostty());
  }
  return {
    Terminal: MockTerminal,
    FitAddon: class { fit() {} },
    LinkDetector: class { registerProvider() {} },
    OSC8LinkProvider: class {},
    UrlRegexProvider: class {},
    Ghostty: MockGhostty,
    init: vi.fn().mockResolvedValue(undefined),
  };
});

class MockResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  disconnect() {}
}

describe('TerminalCore history writes', () => {
  beforeEach(() => {
    terminalInstance = null;
    pendingWriteCallback = null;
    globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0) as unknown as number;
    globalThis.cancelAnimationFrame = handle => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    (globalThis as typeof globalThis & { ResizeObserver: typeof ResizeObserver }).ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('filters only terminal auto-responses emitted by a history write', async () => {
    const onData = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800 });
    Object.defineProperty(container, 'clientHeight', { value: 400 });
    const core = new TerminalCore(container, {}, { onData });
    await core.initialize();

    const historyWrite = new Promise<void>(resolve => {
      core.writeHistory(new Uint8Array([1]), resolve);
    });
    expect(onData).not.toHaveBeenCalled();

    terminalInstance?.emitData('\x1b[12;34R');
    expect(onData).not.toHaveBeenCalled();
    pendingWriteCallback?.();
    await historyWrite;

    terminalInstance?.emitData('\x1b[12;34R');
    expect(onData).toHaveBeenCalledWith('\x1b[12;34R');
    core.dispose();
  });
});
