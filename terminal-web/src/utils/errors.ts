import type { TerminalError } from '../types';

export const createTerminalError = (type: TerminalError['type'], error: unknown): TerminalError => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    type,
    message,
    retryable: true,
    timestamp: Date.now(),
    details: error instanceof Error ? { stack: error.stack } : undefined
  };
};
