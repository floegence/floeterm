export { TerminalCore } from './core/TerminalCore';
export { TerminalState } from './types';
export {
  createTerminalInstance,
  FrameworkNeutralTerminalInstanceController,
} from './manager/TerminalInstanceController';
export {
  getTerminalRenderSchedulerStats,
  resetTerminalRenderSchedulerStats,
} from './core/TerminalRenderScheduler';
export { TerminalSessionsCoordinator } from './sessions/TerminalSessionsCoordinator';
export type { TerminalSessionsCoordinatorOptions } from './sessions/TerminalSessionsCoordinator';
export type { TerminalRenderSchedulerStats } from './core/TerminalRenderScheduler';

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
  TerminalRuntimeLineSnapshot,
  TerminalEventHandlers,
  TerminalInstanceController,
  TerminalInstanceListener,
  TerminalInstanceMutableOptions,
  TerminalInstanceOptions,
  TerminalInstanceScheduler,
  TerminalInstanceSnapshot,
  TerminalLoadingState,
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
  TerminalTouchScrollRuntime,
  TerminalVisualSuspendHandle,
  TerminalVisualSuspendOptions,
  TerminalVisualSuspendReason,
  TerminalThemeName
} from './types';

export { getThemeColors, getDefaultTerminalConfig } from './utils/config';
export { filterXtermAutoResponses } from './utils/xtermAutoResponseFilter';
