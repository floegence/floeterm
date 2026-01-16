export { TerminalCore } from './core/TerminalCore';
export { useTerminalInstance } from './hooks/useTerminalInstance';

export type {
  Logger,
  TerminalConfig,
  TerminalEventHandlers,
  TerminalState,
  TerminalID,
  TerminalSessionInfo,
  TerminalDataChunk,
  TerminalDataEvent,
  TerminalNameUpdateEvent,
  TerminalTransport,
  TerminalEventSource,
  TerminalManagerOptions,
  TerminalManagerReturn,
  TerminalManagerActions,
  TerminalManagerState,
  TerminalError,
  TerminalThemeName
} from './types';

export { getThemeColors, getDefaultTerminalConfig } from './utils/config';
export { filterXtermAutoResponses } from './utils/xtermAutoResponseFilter';
