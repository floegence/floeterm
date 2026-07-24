// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { TerminalInitializationScheduler } from './TerminalInitializationScheduler';
import {
  GhosttyResourceLoader,
  inspectGhosttyRuntimeMemory,
  resolveGhosttyRuntime,
  waitWithAbort,
} from './TerminalResourceLoader';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const runtimeModule = () => ({
  Terminal: class {},
  FitAddon: class {},
  LinkDetector: class {},
  OSC8LinkProvider: class {},
  UrlRegexProvider: class {},
  Ghostty: class {
    static load = vi.fn().mockResolvedValue({});
  },
  init: vi.fn().mockResolvedValue(undefined),
});

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const createSchedulerHarness = (maxConcurrent = 3) => {
  const turns: Array<() => void> = [];
  const scheduler = new TerminalInitializationScheduler(maxConcurrent, callback => {
    turns.push(callback);
  }, 1);
  return {
    scheduler,
    runTurn: () => turns.shift()?.(),
  };
};

describe('resolveGhosttyRuntime', () => {
  it('returns a complete runtime export set without initializing the shared singleton', () => {
    const runtime = runtimeModule();

    expect(resolveGhosttyRuntime(runtime as never)).toEqual(runtime);
    expect(runtime.init).not.toHaveBeenCalled();
  });

  it.each(['Terminal', 'FitAddon', 'LinkDetector', 'OSC8LinkProvider', 'UrlRegexProvider', 'Ghostty'] as const)(
    'rejects a module without the %s export before it is cached',
    (missingExport) => {
      const runtime = runtimeModule();
      Reflect.deleteProperty(runtime, missingExport);

      expect(() => resolveGhosttyRuntime(runtime as never))
        .toThrow(`ghostty-web is missing the required ${missingExport} export`);
    },
  );
});

describe('GhosttyResourceLoader', () => {
  it('imports and validates the immutable module once without calling init', async () => {
    const runtime = runtimeModule();
    const importModule = vi.fn().mockResolvedValue(runtime);
    const loader = new GhosttyResourceLoader(importModule as never);

    await Promise.all([loader.loadModules(logger), loader.loadModules(logger)]);

    expect(importModule).toHaveBeenCalledTimes(1);
    expect(runtime.init).not.toHaveBeenCalled();
    expect(loader.getTerminalConstructor()).toBe(runtime.Terminal);
  });

  it('does not cache an import or export-validation failure', async () => {
    const incomplete = runtimeModule();
    Reflect.deleteProperty(incomplete, 'Ghostty');
    const complete = runtimeModule();
    const importModule = vi.fn()
      .mockResolvedValueOnce(incomplete)
      .mockResolvedValueOnce(complete);
    const loader = new GhosttyResourceLoader(importModule as never);

    await expect(loader.loadModules(logger)).rejects.toThrow('required Ghostty export');
    await expect(loader.loadModules(logger)).resolves.toBeUndefined();

    expect(importModule).toHaveBeenCalledTimes(2);
    expect(loader.getTerminalConstructor()).toBe(complete.Terminal);
  });

  it('creates a distinct Ghostty runtime for every ordinary acquisition', async () => {
    const runtime = runtimeModule();
    const first = { id: 1 };
    const second = { id: 2 };
    runtime.Ghostty.load.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const loader = new GhosttyResourceLoader(vi.fn().mockResolvedValue(runtime) as never);

    await expect(loader.acquireRuntime(logger)).resolves.toBe(first);
    await expect(loader.acquireRuntime(logger)).resolves.toBe(second);
    expect(runtime.Ghostty.load).toHaveBeenCalledTimes(2);
  });

  it('lets exactly one acquisition atomically claim an in-flight preload reservation', async () => {
    const harness = createSchedulerHarness();
    const runtime = runtimeModule();
    const firstLoad = deferred<object>();
    const firstRuntime = { id: 1 };
    const secondRuntime = { id: 2 };
    runtime.Ghostty.load
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValueOnce(secondRuntime);
    const loader = new GhosttyResourceLoader(
      vi.fn().mockResolvedValue(runtime) as never,
      harness.scheduler,
    );

    const firstPreload = loader.preloadRuntime(logger);
    const duplicatePreload = loader.preloadRuntime(logger);
    expect(duplicatePreload).toBe(firstPreload);
    harness.runTurn();
    await vi.waitFor(() => expect(runtime.Ghostty.load).toHaveBeenCalledTimes(1));
    expect(harness.scheduler.getSnapshot()).toMatchObject({ active: 1, activeBackground: 1 });

    const claimed = loader.acquireRuntime(logger);
    const independent = loader.acquireRuntime(logger);
    await expect(independent).resolves.toBe(secondRuntime);
    firstLoad.resolve(firstRuntime);

    await expect(claimed).resolves.toBe(firstRuntime);
    await expect(firstPreload).resolves.toBe(firstRuntime);
    expect(runtime.Ghostty.load).toHaveBeenCalledTimes(2);
    expect(harness.scheduler.getSnapshot()).toMatchObject({ active: 0, activeBackground: 0 });
  });

  it('keeps the scheduler permit until a started load settles after the caller aborts waiting', async () => {
    const harness = createSchedulerHarness(1);
    const runtime = runtimeModule();
    const load = deferred<object>();
    runtime.Ghostty.load.mockImplementationOnce(() => load.promise);
    const loader = new GhosttyResourceLoader(
      vi.fn().mockResolvedValue(runtime) as never,
      harness.scheduler,
    );
    const preload = loader.preloadRuntime(logger);
    harness.runTurn();
    await vi.waitFor(() => expect(runtime.Ghostty.load).toHaveBeenCalledTimes(1));

    const abortController = new AbortController();
    const callerWait = waitWithAbort(preload, abortController.signal);
    abortController.abort();
    await expect(callerWait).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.scheduler.getSnapshot()).toMatchObject({ active: 1, activeBackground: 1 });

    const ownedRuntime = { id: 1 };
    load.resolve(ownedRuntime);
    await expect(preload).resolves.toBe(ownedRuntime);
    expect(harness.scheduler.getSnapshot()).toMatchObject({ active: 0, activeBackground: 0 });
    await expect(loader.acquireRuntime(logger)).resolves.toBe(ownedRuntime);
  });

  it('clears a failed reservation so a later preload can retry', async () => {
    const harness = createSchedulerHarness();
    const runtime = runtimeModule();
    const expected = { id: 2 };
    runtime.Ghostty.load
      .mockRejectedValueOnce(new Error('wasm failed'))
      .mockResolvedValueOnce(expected);
    const loader = new GhosttyResourceLoader(
      vi.fn().mockResolvedValue(runtime) as never,
      harness.scheduler,
    );

    const first = loader.preloadRuntime(logger);
    harness.runTurn();
    await expect(first).rejects.toThrow('wasm failed');
    const second = loader.preloadRuntime(logger);
    harness.runTurn();
    await expect(second).resolves.toBe(expected);
    expect(runtime.Ghostty.load).toHaveBeenCalledTimes(2);
  });
});

describe('inspectGhosttyRuntimeMemory', () => {
  it('returns the private WebAssembly memory exposed by the pinned runtime', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });

    expect(inspectGhosttyRuntimeMemory({ memory } as never)).toBe(memory);
  });

  it.each([undefined, new ArrayBuffer(8), {}])(
    'fails closed for an incompatible memory value %#',
    (memory) => {
      expect(() => inspectGhosttyRuntimeMemory({ memory } as never))
        .toThrow(/ghostty-web@0\.4\.0-next\.14\.g6a1a50d compatibility check failed/);
    },
  );

  it('normalizes a throwing memory accessor into the actionable compatibility error', () => {
    const runtime = Object.defineProperty({}, 'memory', {
      get: () => { throw new Error('private layout changed'); },
    });

    expect(() => inspectGhosttyRuntimeMemory(runtime as never))
      .toThrow(/review or remove the version-bound scrollback adapter/);
  });
});
