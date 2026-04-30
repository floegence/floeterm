export { TerminalCore } from './core/TerminalCore';
export { useTerminalInstance } from './hooks/useTerminalInstance';
export { TerminalSessionsCoordinator } from './sessions/TerminalSessionsCoordinator';
export type { TerminalSessionsCoordinatorOptions } from './sessions/TerminalSessionsCoordinator';

export type {
  Logger,
  TerminalBufferCellPosition,
  TerminalBufferRange,
  TerminalClipboardConfig,
  TerminalAppearance,
  TerminalConfig,
  TerminalCopySelectionResult,
  TerminalCopySelectionSource,
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
  TerminalManagerAppearance,
  TerminalManagerState,
  TerminalError,
  TerminalLink,
  TerminalLinkProvider,
  TerminalSelectionSnapshot,
  TerminalVisualSuspendHandle,
  TerminalVisualSuspendOptions,
  TerminalVisualSuspendReason,
  TerminalThemeName
} from './types';

export { getThemeColors, getDefaultTerminalConfig } from './utils/config';
export { filterXtermAutoResponses } from './utils/xtermAutoResponseFilter';
