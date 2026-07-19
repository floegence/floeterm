import type { Logger, TerminalResourcePreloadOptions } from '../types.js';
import { noopLogger } from '../utils/logger.js';
import { loadBeamtermModule } from './BeamtermResourceLoader.js';

let TerminalCtor: typeof import('ghostty-web').Terminal | null = null;
let FitAddonCtor: typeof import('ghostty-web').FitAddon | null = null;
let LinkDetectorCtor: typeof import('ghostty-web').LinkDetector | null = null;
let OSC8LinkProviderCtor: typeof import('ghostty-web').OSC8LinkProvider | null = null;
let UrlRegexProviderCtor: typeof import('ghostty-web').UrlRegexProvider | null = null;
let ghosttyResourcesPromise: Promise<void> | null = null;

type GhosttyRuntime = Pick<
  typeof import('ghostty-web'),
  'Terminal' | 'FitAddon' | 'LinkDetector' | 'OSC8LinkProvider' | 'UrlRegexProvider' | 'init'
>;

const REQUIRED_GHOSTTY_EXPORTS = [
  'Terminal',
  'FitAddon',
  'LinkDetector',
  'OSC8LinkProvider',
  'UrlRegexProvider',
  'init',
] as const;

export const resolveGhosttyRuntime = (module: typeof import('ghostty-web')): GhosttyRuntime => {
  for (const exportName of REQUIRED_GHOSTTY_EXPORTS) {
    if (typeof module[exportName] !== 'function') {
      throw new Error(`ghostty-web is missing the required ${exportName} export`);
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

export const loadGhosttyModules = async (logger: Logger, signal?: AbortSignal): Promise<void> => {
  if (typeof window === 'undefined') {
    throw new Error('ghostty-web can only be loaded in a browser environment');
  }

  if (
    TerminalCtor
    && FitAddonCtor
    && LinkDetectorCtor
    && OSC8LinkProviderCtor
    && UrlRegexProviderCtor
  ) return;

  if (!ghosttyResourcesPromise) {
    logger.debug('[TerminalCore] Initializing ghostty-web WASM');
    ghosttyResourcesPromise = (async () => {
      const runtime = resolveGhosttyRuntime(await import('ghostty-web'));
      await runtime.init();
      TerminalCtor = runtime.Terminal;
      FitAddonCtor = runtime.FitAddon;
      LinkDetectorCtor = runtime.LinkDetector;
      OSC8LinkProviderCtor = runtime.OSC8LinkProvider;
      UrlRegexProviderCtor = runtime.UrlRegexProvider;
    })().catch((error: unknown) => {
      TerminalCtor = null;
      FitAddonCtor = null;
      LinkDetectorCtor = null;
      OSC8LinkProviderCtor = null;
      UrlRegexProviderCtor = null;
      ghosttyResourcesPromise = null;
      throw error;
    });
  }

  await waitWithAbort(ghosttyResourcesPromise, signal);
};

export const getGhosttyTerminalConstructor = (): typeof import('ghostty-web').Terminal | null => TerminalCtor;

export const getGhosttyFitAddonConstructor = (): typeof import('ghostty-web').FitAddon | null => FitAddonCtor;

export const getGhosttyLinkConstructors = () => {
  if (!LinkDetectorCtor || !OSC8LinkProviderCtor || !UrlRegexProviderCtor) {
    throw new Error('Required ghostty-web link providers not loaded');
  }

  return {
    LinkDetector: LinkDetectorCtor,
    OSC8LinkProvider: OSC8LinkProviderCtor,
    UrlRegexProvider: UrlRegexProviderCtor,
  };
};

export const preloadTerminalResources = async (
  options: TerminalResourcePreloadOptions = {},
): Promise<void> => {
  const resources = Promise.all([
    loadGhosttyModules(options.logger ?? noopLogger),
    loadBeamtermModule(),
  ]).then(() => undefined);
  await waitWithAbort(resources, options.signal);
};
