export { TerminalCore } from './core/TerminalCore';
export { useTerminalInstance } from './hooks/useTerminalInstance';
export { TerminalSessionsCoordinator } from './sessions/TerminalSessionsCoordinator';
export type { TerminalSessionsCoordinatorOptions } from './sessions/TerminalSessionsCoordinator';

export type {
  Logger,
  TerminalBufferCellPosition,
  TerminalBufferRange,
  TerminalClipboardConfig,
  TerminalConfig,
  TerminalResponsiveConfig,
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
  TerminalLink,
  TerminalLinkProvider,
  TerminalThemeName
} from './types';

export { getThemeColors, getDefaultTerminalConfig } from './utils/config';
export { filterXtermAutoResponses } from './utils/xtermAutoResponseFilter';
