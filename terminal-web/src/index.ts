export { TerminalCore, preloadTerminalResources } from './core/TerminalCore';
export { TerminalState } from './types';
export {
  createTerminalInstance,
  FrameworkNeutralTerminalInstanceController,
} from './manager/TerminalInstanceController';
export {
  getTerminalRenderSchedulerStats,
  resetTerminalRenderSchedulerStats,
} from './core/TerminalRenderScheduler';
export { getTerminalInitializationSchedulerStats } from './internal/TerminalInitializationScheduler';
export { createTerminalOutputPipeline } from './core/TerminalOutputPipeline';
export {
  createPagedTerminalOutputCoordinator,
  preparePagedTerminalHistory,
} from './core/PagedTerminalOutputCoordinator';
export {
  getTerminalFabricDiagnostics,
  resetTerminalFabricDiagnostics,
} from './fabric/TerminalFabricCoordinator';
export { TerminalSessionsCoordinator } from './sessions/TerminalSessionsCoordinator';
export type { TerminalSessionsCoordinatorOptions } from './sessions/TerminalSessionsCoordinator';
export type { TerminalRenderSchedulerStats } from './core/TerminalRenderScheduler';
export type { TerminalInitializationSchedulerSnapshot } from './internal/TerminalInitializationScheduler';
export type {
  TerminalOutputPipelineCatchUpReason,
  TerminalOutputPipelineCatchUpRequest,
  TerminalOutputPipelineChunk,
  TerminalOutputPipelineDrainState,
  TerminalOutputPipelineHandle,
  TerminalOutputPipelineOptions,
  TerminalOutputPipelinePolicy,
  TerminalOutputPipelineResetOptions,
  TerminalOutputPipelineScheduler,
  TerminalOutputPipelineStats,
} from './core/TerminalOutputPipeline';
export type {
  AtomicPagedTerminalOutputCoordinatorHandle,
  PagedTerminalCompleteAttachOptions,
  PagedTerminalHistoryPage,
  PagedTerminalHistoryRequest,
  PagedTerminalHistoryTruncationReason,
  PagedTerminalOutputFailure,
  PagedTerminalOutputFailureCode,
  PagedTerminalOutputCoordinatorHandle,
  PagedTerminalOutputCoordinatorOptions,
  PagedTerminalOutputPolicy,
  PagedTerminalOutputScheduler,
  PagedTerminalOutputSnapshot,
  PagedTerminalOutputState,
  PreparedPagedTerminalHistory,
  PreparePagedTerminalHistoryOptions,
} from './core/PagedTerminalOutputCoordinator';
export type {
  TerminalFabricBackend,
  TerminalFabricDiagnostics,
  TerminalFabricRenderPath,
  TerminalFabricStats,
} from './fabric/types';

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
  TerminalRestorableSnapshot,
  TerminalRestorableSnapshotOptions,
  TerminalResourceEstimate,
  TerminalResourcePreloadOptions,
  TerminalEventHandlers,
  TerminalFocusOptions,
  TerminalInitializationOptions,
  TerminalInitializationPriority,
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
