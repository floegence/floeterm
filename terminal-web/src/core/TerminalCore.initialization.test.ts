// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalCore, preloadTerminalResources } from './TerminalCore';
import { TerminalState } from '../types';
import { getTerminalInitializationSchedulerStats } from '../internal/TerminalInitializationScheduler';

const moduleState = vi.hoisted(() => ({
  init: vi.fn<() => Promise<void>>(),
  rendererMain: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  constructorFailures: 0,
}));

vi.mock('@beamterm/renderer', () => ({
  main: moduleState.rendererMain,
}));

vi.mock('ghostty-web', () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { length: 0 } };

    constructor() {
      if (moduleState.constructorFailures > 0) {
        moduleState.constructorFailures -= 1;
        throw new Error('terminal construction failed');
      }
    }

    loadAddon(addon: { __terminal?: MockTerminal }) { addon.__terminal = this; }
    open(container: HTMLElement) {
      const textarea = document.createElement('textarea');
      textarea.setAttribute('aria-label', 'Terminal input');
      container.appendChild(textarea);
    }
    onData() { return { dispose: () => {} }; }
    onResize() { return { dispose: () => {} }; }
    write(_data: string | Uint8Array, callback?: () => void) { callback?.(); }
    clear() {}
    getSelection() { return ''; }
    focus() {}
    dispose() {}
  }

  class MockFitAddon {
    fit() {}
  }

  return { Terminal: MockTerminal, FitAddon: MockFitAddon, init: moduleState.init };
});

class MockResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  disconnect() {}
}

const createContainer = (): HTMLDivElement => {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true });
  document.body.appendChild(container);
  return container;
};

describe('TerminalCore initialization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.requestAnimationFrame = callback => (
      setTimeout(() => callback(Date.now()), 0) as unknown as number
    );
    globalThis.cancelAnimationFrame = handle => {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
    (globalThis as typeof globalThis & { ResizeObserver: typeof ResizeObserver }).ResizeObserver = (
      MockResizeObserver as unknown as typeof ResizeObserver
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('shares resource preload work and retries after the real initialization fails', async () => {
    let rejectInitialization: ((error: Error) => void) | undefined;
    let rejectRendererInitialization: ((error: Error) => void) | undefined;
    moduleState.init.mockReset();
    moduleState.rendererMain.mockReset();
    moduleState.init.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectInitialization = reject;
    }));
    moduleState.rendererMain.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectRendererInitialization = reject;
    }));

    const callerAbort = new AbortController();
    const first = preloadTerminalResources({ signal: callerAbort.signal });
    const second = preloadTerminalResources();
    await vi.waitFor(() => expect(moduleState.init).toHaveBeenCalledTimes(1));
    expect(moduleState.rendererMain).toHaveBeenCalledTimes(1);
    callerAbort.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    const core = new TerminalCore(createContainer());
    const coreInitialization = core.initialize({ priority: 'background' });
    await vi.runOnlyPendingTimersAsync();
    expect(getTerminalInitializationSchedulerStats()).toMatchObject({
      active: 1,
      activeBackground: 1,
    });
    core.dispose();
    await expect(coreInitialization).rejects.toMatchObject({ name: 'AbortError' });
    expect(getTerminalInitializationSchedulerStats()).toMatchObject({
      active: 0,
      activeBackground: 0,
    });

    rejectInitialization?.(new Error('wasm failed'));
    rejectRendererInitialization?.(new Error('renderer wasm failed'));

    await expect(second).rejects.toThrow('wasm failed');

    moduleState.init.mockResolvedValueOnce(undefined);
    moduleState.rendererMain.mockResolvedValueOnce(undefined);
    await expect(preloadTerminalResources()).resolves.toBeUndefined();
    expect(moduleState.init).toHaveBeenCalledTimes(2);
    expect(moduleState.rendererMain).toHaveBeenCalledTimes(2);
  });

  it('keeps duplicate initialize callers pending until the core is ready', async () => {
    const states: TerminalState[] = [];
    const core = new TerminalCore(createContainer(), {}, {
      onStateChange: state => states.push(state),
    });

    const background = core.initialize({ priority: 'background' });
    const interactive = core.initialize({ priority: 'interactive' });
    let backgroundReady = false;
    let interactiveReady = false;
    void background.then(() => { backgroundReady = true; });
    void interactive.then(() => { interactiveReady = true; });
    await Promise.resolve();

    expect(backgroundReady).toBe(false);
    expect(interactiveReady).toBe(false);
    expect(states).toEqual([TerminalState.INITIALIZING]);

    await vi.runAllTimersAsync();
    await Promise.all([background, interactive]);
    expect(backgroundReady).toBe(true);
    expect(interactiveReady).toBe(true);
    expect(states).toContain(TerminalState.READY);
    core.dispose();
  });

  it('rejects through the promise without queuing work when state publication throws', async () => {
    const core = new TerminalCore(createContainer(), {}, {
      onStateChange: () => {
        throw new Error('state listener failed');
      },
    });

    const initialization = core.initialize();
    await expect(initialization).rejects.toThrow('state listener failed');
    expect(getTerminalInitializationSchedulerStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('cancels a queued caller without preventing a later retry', async () => {
    const states: TerminalState[] = [];
    const controller = new AbortController();
    const core = new TerminalCore(createContainer(), {}, {
      onStateChange: state => states.push(state),
    });

    const cancelled = core.initialize({ priority: 'background', signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(states[states.length - 1]).toBe(TerminalState.IDLE);

    const retry = core.initialize({ priority: 'interactive' });
    await vi.runAllTimersAsync();
    await expect(retry).resolves.toBeUndefined();
    expect(states[states.length - 1]).toBe(TerminalState.READY);
    core.dispose();
  });

  it('cancels queued initialization when the core is disposed', async () => {
    const core = new TerminalCore(createContainer());
    const initializing = core.initialize({ priority: 'background' });

    core.dispose();
    await expect(initializing).rejects.toThrow('disposed TerminalCore');
    await vi.runAllTimersAsync();
  });

  it('cleans up a partial failure and allows the same core to retry', async () => {
    moduleState.constructorFailures = 1;
    const states: TerminalState[] = [];
    const core = new TerminalCore(createContainer(), {}, {
      onStateChange: state => states.push(state),
    });

    const first = core.initialize();
    const firstFailure = expect(first).rejects.toThrow('terminal construction failed');
    await vi.runAllTimersAsync();
    await firstFailure;
    expect(states[states.length - 1]).toBe(TerminalState.IDLE);

    const retry = core.initialize();
    await vi.runAllTimersAsync();
    await expect(retry).resolves.toBeUndefined();
    expect(states[states.length - 1]).toBe(TerminalState.READY);
    core.dispose();
  });
});
