// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalCore, preloadTerminalResources } from './TerminalCore';
import { TerminalState } from '../types';
import { getTerminalInitializationSchedulerStats } from '../internal/TerminalInitializationScheduler';

const moduleState = vi.hoisted(() => ({
  runtimeLoad: vi.fn<() => Promise<{ memory: WebAssembly.Memory }>>(),
  rendererMain: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  constructorFailures: 0,
  terminalOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('@floegence/beamterm-renderer', () => ({
  main: moduleState.rendererMain,
}));

vi.mock('ghostty-web', () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { length: 0 } };

    constructor(options: Record<string, unknown> = {}) {
      if (moduleState.constructorFailures > 0) {
        moduleState.constructorFailures -= 1;
        throw new Error('terminal construction failed');
      }
      this.options = options;
      moduleState.terminalOptions.push(options);
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

  class MockGhostty {
    readonly memory = new WebAssembly.Memory({ initial: 1 });
    static load = () => moduleState.runtimeLoad();
  }

  return {
    Terminal: MockTerminal,
    FitAddon: MockFitAddon,
    LinkDetector: class { registerProvider() {} },
    OSC8LinkProvider: class {},
    UrlRegexProvider: class {},
    Ghostty: MockGhostty,
    init: vi.fn(),
  };
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
    moduleState.runtimeLoad.mockReset();
    moduleState.runtimeLoad.mockImplementation(async () => ({
      memory: new WebAssembly.Memory({ initial: 1 }),
    }));
    moduleState.rendererMain.mockReset();
    moduleState.rendererMain.mockResolvedValue(undefined);
    moduleState.terminalOptions.length = 0;
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

  it('keeps a claimed preload load scheduled until it settles after abort and dispose', async () => {
    let resolveRuntime: ((runtime: { memory: WebAssembly.Memory }) => void) | undefined;
    moduleState.runtimeLoad.mockImplementationOnce(() => new Promise(resolve => {
      resolveRuntime = resolve;
    }));

    const callerAbort = new AbortController();
    const first = preloadTerminalResources({ signal: callerAbort.signal });
    const second = preloadTerminalResources();
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(moduleState.runtimeLoad).toHaveBeenCalledTimes(1));
    expect(moduleState.rendererMain).toHaveBeenCalledTimes(1);
    callerAbort.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    const core = new TerminalCore(createContainer());
    const coreInitialization = core.initialize({ priority: 'interactive' });
    await vi.runOnlyPendingTimersAsync();
    expect(getTerminalInitializationSchedulerStats()).toMatchObject({
      active: 2,
      activeBackground: 1,
    });
    core.dispose();
    expect(getTerminalInitializationSchedulerStats()).toMatchObject({ active: 2 });

    resolveRuntime?.({ memory: new WebAssembly.Memory({ initial: 1 }) });
    await expect(second).resolves.toBeUndefined();
    await expect(coreInitialization).rejects.toThrow('disposed TerminalCore');
    expect(getTerminalInitializationSchedulerStats()).toMatchObject({
      active: 0,
      activeBackground: 0,
    });
    expect(moduleState.terminalOptions).toHaveLength(0);
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

  it('rejects invalid scrollback and unsupported explicit columns before loading a runtime', () => {
    const invalidScrollback = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_001, '1000'];
    for (const value of invalidScrollback) {
      expect(() => new TerminalCore(createContainer(), { scrollback: value as number }))
        .toThrow(/scrollback.*integer.*1.*10000/i);
    }
    expect(() => new TerminalCore(createContainer(), { cols: 501 })).toThrow(/cols.*1.*500/i);
    expect(() => new TerminalCore(createContainer(), {
      fixedDimensions: { cols: 501, rows: 24 },
    })).toThrow(/fixedDimensions\.cols.*1.*500/i);
    expect(moduleState.runtimeLoad).not.toHaveBeenCalled();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('maps buffer rows for the pinned Ghostty version and prevents runtime overrides', async () => {
    const unsupportedOverride = { memory: new WebAssembly.Memory({ initial: 1 }) };
    const core = new TerminalCore(createContainer(), {
      scrollback: 10_000,
      ghostty: unsupportedOverride,
    });

    const initialization = core.initialize();
    await vi.runAllTimersAsync();
    await initialization;

    expect(moduleState.terminalOptions).toHaveLength(1);
    expect(moduleState.terminalOptions[0]?.scrollback).toBe(81_920_000);
    expect(moduleState.terminalOptions[0]?.ghostty).not.toBe(unsupportedOverride);
    core.dispose();
  });

  it('owns distinct WASM memories and reports only live runtime memory', async () => {
    const first = new TerminalCore(createContainer());
    const second = new TerminalCore(createContainer());
    const firstInitialization = first.initialize();
    const secondInitialization = second.initialize();
    await vi.runAllTimersAsync();
    await Promise.all([firstInitialization, secondInitialization]);

    const firstRuntime = moduleState.terminalOptions[0]?.ghostty as { memory: WebAssembly.Memory };
    const secondRuntime = moduleState.terminalOptions[1]?.ghostty as { memory: WebAssembly.Memory };
    expect(firstRuntime).not.toBe(secondRuntime);
    expect(firstRuntime.memory).not.toBe(secondRuntime.memory);
    expect(first.getResourceEstimate()).toMatchObject({
      wasmMemoryBytes: 65_536,
      estimatedBytes: 4 * 1024 * 1024 + 65_536,
    });

    first.dispose();
    expect(first.getResourceEstimate()).toMatchObject({
      bufferBytes: 0,
      cellCount: 0,
      wasmMemoryBytes: 0,
      estimatedBytes: 0,
    });
    second.dispose();
  });

  it('never exceeds the initialization scheduler limit during an abort storm', async () => {
    const pendingLoads: Array<(runtime: { memory: WebAssembly.Memory }) => void> = [];
    let activeLoads = 0;
    let peakLoads = 0;
    moduleState.runtimeLoad.mockImplementation(() => new Promise(resolve => {
      activeLoads += 1;
      peakLoads = Math.max(peakLoads, activeLoads);
      pendingLoads.push(runtime => {
        activeLoads -= 1;
        resolve(runtime);
      });
    }));

    const fixtures = Array.from({ length: 8 }, () => {
      const container = createContainer();
      return { container, core: new TerminalCore(container) };
    });
    const cores = fixtures.map(({ core }) => core);
    const controllers = cores.map(() => new AbortController());
    const waits = cores.map((core, index) => core.initialize({ signal: controllers[index]?.signal }));
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(moduleState.runtimeLoad).toHaveBeenCalledTimes(3));
    controllers.forEach(controller => controller.abort());
    await Promise.all(waits.map(wait => expect(wait).rejects.toMatchObject({ name: 'AbortError' })));

    pendingLoads.forEach(resolve => resolve({ memory: new WebAssembly.Memory({ initial: 1 }) }));
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(getTerminalInitializationSchedulerStats()).toMatchObject({
      active: 0,
      queued: 0,
    }));
    expect(peakLoads).toBe(3);

    cores.forEach(core => core.dispose());
    expect(document.querySelector('textarea')).toBeNull();
  });
});
