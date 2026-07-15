import type { Logger, TerminalResourcePreloadOptions } from '../types.js';
import { noopLogger } from '../utils/logger.js';
import { loadBeamtermModule } from './BeamtermResourceLoader.js';

let TerminalCtor: typeof import('ghostty-web').Terminal | null = null;
let FitAddonCtor: typeof import('ghostty-web').FitAddon | null = null;
let ghosttyResourcesPromise: Promise<void> | null = null;

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

export const loadGhosttyModules = async (logger: Logger, signal?: AbortSignal): Promise<void> => {
  if (typeof window === 'undefined') {
    throw new Error('ghostty-web can only be loaded in a browser environment');
  }

  if (TerminalCtor && FitAddonCtor) return;

  if (!ghosttyResourcesPromise) {
    logger.debug('[TerminalCore] Initializing ghostty-web WASM');
    ghosttyResourcesPromise = (async () => {
      const { Terminal, FitAddon, init } = await import('ghostty-web');
      await init();
      TerminalCtor = Terminal;
      FitAddonCtor = FitAddon;
    })().catch((error: unknown) => {
      TerminalCtor = null;
      FitAddonCtor = null;
      ghosttyResourcesPromise = null;
      throw error;
    });
  }

  await waitWithAbort(ghosttyResourcesPromise, signal);
};

export const getGhosttyTerminalConstructor = (): typeof import('ghostty-web').Terminal | null => TerminalCtor;

export const getGhosttyFitAddonConstructor = (): typeof import('ghostty-web').FitAddon | null => FitAddonCtor;

export const preloadTerminalResources = async (
  options: TerminalResourcePreloadOptions = {},
): Promise<void> => {
  const resources = Promise.all([
    loadGhosttyModules(options.logger ?? noopLogger),
    loadBeamtermModule(),
  ]).then(() => undefined);
  await waitWithAbort(resources, options.signal);
};
