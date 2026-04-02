// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalCore } from './TerminalCore';
import type { TerminalEventHandlers, TerminalLink, TerminalLinkProvider } from '../types';

const fitSpy = vi.fn();

vi.mock('ghostty-web', () => {
  class MockTerminal {
    cols: number;
    rows: number;
    options: any;
    buffer: any;
    registeredLinkProviders: TerminalLinkProvider[] = [];
    private bellHandlers = new Set<() => void>();
    private titleHandlers = new Set<(title: string) => void>();

    constructor(opts: any) {
      this.cols = typeof opts?.cols === 'number' ? opts.cols : 80;
      this.rows = typeof opts?.rows === 'number' ? opts.rows : 24;
      this.options = { theme: opts?.theme ?? {}, fontSize: opts?.fontSize, fontFamily: opts?.fontFamily };
      this.buffer = { active: { length: 0 } };
    }

    loadAddon(addon: any) {
      addon.__terminal = this;
    }

    open(_container: HTMLElement) {
      // noop
    }

    onData(_handler: (data: string) => void) {
      return { dispose: () => {} };
    }

    onResize(_handler: (size: { cols: number; rows: number }) => void) {
      return { dispose: () => {} };
    }

    onBell(handler: () => void) {
      this.bellHandlers.add(handler);
      return {
        dispose: () => {
          this.bellHandlers.delete(handler);
        },
      };
    }

    onTitleChange(handler: (title: string) => void) {
      this.titleHandlers.add(handler);
      return {
        dispose: () => {
          this.titleHandlers.delete(handler);
        },
      };
    }

    registerLinkProvider(provider: TerminalLinkProvider) {
      this.registeredLinkProviders.push(provider);
    }

    emitBell() {
      for (const handler of this.bellHandlers) {
        handler();
      }
    }

    emitTitle(title: string) {
      for (const handler of this.titleHandlers) {
        handler(title);
      }
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

describe('TerminalCore extended events and link APIs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fitSpy.mockReset();

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

  it('registers link providers queued before initialization and avoids duplicate registration', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const providerA: TerminalLinkProvider = {
      provideLinks: vi.fn((y: number, callback: (links: TerminalLink[] | undefined) => void) => {
        void y;
        callback(undefined);
      }),
    };
    const providerB: TerminalLinkProvider = {
      provideLinks: vi.fn((y: number, callback: (links: TerminalLink[] | undefined) => void) => {
        void y;
        callback(undefined);
      }),
    };

    const core = new TerminalCore(container, {}, {});
    core.registerLinkProvider(providerA);

    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    const terminal = (core as unknown as { terminal?: { registeredLinkProviders?: TerminalLinkProvider[] } | null }).terminal;
    expect(terminal?.registeredLinkProviders).toEqual([providerA]);

    core.registerLinkProvider(providerA);
    core.registerLinkProvider(providerB);

    expect(terminal?.registeredLinkProviders).toEqual([providerA, providerB]);

    core.dispose();
  });

  it('forwards bell and title change events through TerminalEventHandlers', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const handlers: TerminalEventHandlers = {
      onBell: vi.fn(),
      onTitleChange: vi.fn(),
    };

    const core = new TerminalCore(container, {}, handlers);
    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    const terminal = (core as unknown as {
      terminal?: { emitBell: () => void; emitTitle: (title: string) => void } | null;
    }).terminal;
    expect(terminal).toBeTruthy();

    terminal!.emitBell();
    terminal!.emitTitle('build finished');

    expect(handlers.onBell).toHaveBeenCalledTimes(1);
    expect(handlers.onTitleChange).toHaveBeenCalledWith('build finished');

    core.dispose();
  });

  it('sets font family through an explicit API instead of raw option mutation', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });

    const core = new TerminalCore(container, {}, {});
    const init = core.initialize();
    await vi.runAllTimersAsync();
    await init;

    fitSpy.mockReset();
    core.setFontFamily('"Iosevka Term", monospace');

    const terminal = (core as unknown as {
      terminal?: { options?: { fontFamily?: string } } | null;
    }).terminal;

    expect(terminal?.options?.fontFamily).toBe('"Iosevka Term", monospace');
    expect(fitSpy).toHaveBeenCalled();

    core.dispose();
  });
});
