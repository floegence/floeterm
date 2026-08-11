import type { Logger, TerminalResourcePreloadOptions } from '../types.js';
import { noopLogger } from '../utils/logger.js';
import { loadBeamtermModule } from './BeamtermResourceLoader.js';
import { EXPECTED_GHOSTTY_WEB_COMPAT_VERSION } from './GhosttyCompatibilityVersion.js';
import {
  terminalInitializationScheduler,
  type TerminalInitializationScheduler,
} from './TerminalInitializationScheduler.js';

export type GhosttyRuntimeInstance = InstanceType<typeof import('@floegence/ghostty-web').Ghostty>;

type GhosttyResourceModule = Pick<
  typeof import('@floegence/ghostty-web'),
  'Terminal' | 'FitAddon' | 'LinkDetector' | 'OSC8LinkProvider' | 'UrlRegexProvider' | 'Ghostty'
>;

type GhosttyModuleImporter = () => Promise<typeof import('@floegence/ghostty-web')>;
type GhosttyRuntimeScheduler = Pick<TerminalInitializationScheduler, 'request'>;
type GhosttyRuntimeReservation = {
  promise: Promise<GhosttyRuntimeInstance>;
};

const REQUIRED_GHOSTTY_EXPORTS = [
  'Terminal',
  'FitAddon',
  'LinkDetector',
  'OSC8LinkProvider',
  'UrlRegexProvider',
  'Ghostty',
] as const;

export const resolveGhosttyRuntime = (module: typeof import('@floegence/ghostty-web')): GhosttyResourceModule => {
  for (const exportName of REQUIRED_GHOSTTY_EXPORTS) {
    if (typeof module[exportName] !== 'function') {
      throw new Error(`@floegence/ghostty-web is missing the required ${exportName} export`);
    }
  }
  return module;
};

const abortError = (): Error => {
  if (typeof DOMException !== 'undefined') return new DOMException('Operation aborted', 'AbortError');
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
};

export const waitWithAbort = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

const runtimeMemoryCompatibilityError = (): Error => new Error(
  `@floegence/ghostty-web@${EXPECTED_GHOSTTY_WEB_COMPAT_VERSION} compatibility check failed: `
  + 'the owned Ghostty runtime does not expose a WebAssembly.Memory at "memory"; '
  + 'review or remove the version-bound compatibility adapters before changing @floegence/ghostty-web',
);

export const inspectGhosttyRuntimeMemory = (runtime: GhosttyRuntimeInstance): WebAssembly.Memory => {
  let memory: unknown;
  try {
    memory = Reflect.get(runtime, 'memory');
  } catch {
    throw runtimeMemoryCompatibilityError();
  }
  if (typeof WebAssembly === 'undefined' || !(memory instanceof WebAssembly.Memory)) {
    throw runtimeMemoryCompatibilityError();
  }
  return memory;
};

export class GhosttyResourceLoader {
  private module: GhosttyResourceModule | null = null;
  private modulePromise: Promise<GhosttyResourceModule> | null = null;
  private reservation: GhosttyRuntimeReservation | null = null;

  constructor(
    private readonly importModule: GhosttyModuleImporter = () => import('@floegence/ghostty-web'),
    private readonly scheduler: GhosttyRuntimeScheduler = terminalInitializationScheduler,
  ) {}

  async loadModules(logger: Logger, signal?: AbortSignal): Promise<void> {
    await waitWithAbort(this.loadModule(logger), signal);
  }

  async acquireRuntime(logger: Logger): Promise<GhosttyRuntimeInstance> {
    const reservation = this.reservation;
    if (reservation) {
      this.reservation = null;
      logger.debug('[TerminalCore] Consuming preloaded @floegence/ghostty-web WASM runtime');
      return reservation.promise;
    }

    const module = await this.loadModule(logger);
    logger.debug('[TerminalCore] Creating isolated @floegence/ghostty-web WASM runtime');
    return module.Ghostty.load();
  }

  preloadRuntime(logger: Logger): Promise<GhosttyRuntimeInstance> {
    if (this.reservation) return this.reservation.promise;

    const request = this.scheduler.request('background');
    const loadPromise = (async () => {
      const permit = await request.permit;
      if (!permit) {
        throw new Error('@floegence/ghostty-web runtime preload was cancelled before it started');
      }

      try {
        const module = await this.loadModule(logger);
        logger.debug('[TerminalCore] Preloading one isolated @floegence/ghostty-web WASM runtime');
        return await module.Ghostty.load();
      } finally {
        permit.release();
      }
    })();
    const promise = loadPromise.catch((error: unknown) => {
      if (this.reservation?.promise === promise) {
        this.reservation = null;
      }
      throw error;
    });
    const reservation: GhosttyRuntimeReservation = { promise };
    this.reservation = reservation;
    return reservation.promise;
  }

  getTerminalConstructor(): typeof import('@floegence/ghostty-web').Terminal | null {
    return this.module?.Terminal ?? null;
  }

  getFitAddonConstructor(): typeof import('@floegence/ghostty-web').FitAddon | null {
    return this.module?.FitAddon ?? null;
  }

  getLinkConstructors() {
    if (!this.module) {
      throw new Error('Required @floegence/ghostty-web link providers not loaded');
    }

    return {
      LinkDetector: this.module.LinkDetector,
      OSC8LinkProvider: this.module.OSC8LinkProvider,
      UrlRegexProvider: this.module.UrlRegexProvider,
    };
  }

  private loadModule(logger: Logger): Promise<GhosttyResourceModule> {
    if (typeof window === 'undefined') {
      return Promise.reject(new Error('@floegence/ghostty-web can only be loaded in a browser environment'));
    }
    if (this.module) return Promise.resolve(this.module);

    if (!this.modulePromise) {
      logger.debug('[TerminalCore] Loading @floegence/ghostty-web module');
      const modulePromise = this.importModule()
        .then(resolveGhosttyRuntime)
        .then(module => {
          this.module = module;
          return module;
        })
        .catch((error: unknown) => {
          this.module = null;
          if (this.modulePromise === modulePromise) this.modulePromise = null;
          throw error;
        });
      this.modulePromise = modulePromise;
    }

    return this.modulePromise;
  }
}

const ghosttyResourceLoader = new GhosttyResourceLoader();

export const loadGhosttyModules = (logger: Logger, signal?: AbortSignal): Promise<void> => (
  ghosttyResourceLoader.loadModules(logger, signal)
);

export const acquireGhosttyRuntime = (logger: Logger): Promise<GhosttyRuntimeInstance> => (
  ghosttyResourceLoader.acquireRuntime(logger)
);

export const getGhosttyTerminalConstructor = (): typeof import('@floegence/ghostty-web').Terminal | null => (
  ghosttyResourceLoader.getTerminalConstructor()
);

export const getGhosttyFitAddonConstructor = (): typeof import('@floegence/ghostty-web').FitAddon | null => (
  ghosttyResourceLoader.getFitAddonConstructor()
);

export const getGhosttyLinkConstructors = () => ghosttyResourceLoader.getLinkConstructors();

export const preloadTerminalResources = async (
  options: TerminalResourcePreloadOptions = {},
): Promise<void> => {
  const resources = Promise.all([
    ghosttyResourceLoader.preloadRuntime(options.logger ?? noopLogger),
    loadBeamtermModule(),
  ]).then(() => undefined);
  await waitWithAbort(resources, options.signal);
};
