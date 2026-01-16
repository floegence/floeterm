import type { Logger } from '../types';

export const createConsoleLogger = (): Logger => ({
  debug: (message, meta) => console.debug(message, meta ?? {}),
  info: (message, meta) => console.info(message, meta ?? {}),
  warn: (message, meta) => console.warn(message, meta ?? {}),
  error: (message, meta) => console.error(message, meta ?? {})
});

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};
