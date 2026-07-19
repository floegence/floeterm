export { TerminalCore } from './core/TerminalCore.js';
export { preloadTerminalResources } from './internal/TerminalResourceLoader.js';
export { TerminalState } from './types.js';
export {
  createTerminalInstance,
  FrameworkNeutralTerminalInstanceController,
} from './manager/TerminalInstanceController.js';
export {
  getTerminalRenderSchedulerStats,
  resetTerminalRenderSchedulerStats,
} from './core/TerminalRenderScheduler.js';
export { getTerminalInitializationSchedulerStats } from './internal/TerminalInitializationScheduler.js';
export { createTerminalOutputPipeline } from './core/TerminalOutputPipeline.js';
export {
  createPagedTerminalOutputCoordinator,
  preparePagedTerminalHistory,
} from './core/PagedTerminalOutputCoordinator.js';
export {
  getTerminalFabricDiagnostics,
  resetTerminalFabricDiagnostics,
} from './fabric/TerminalFabricCoordinator.js';
export { TerminalSessionsCoordinator } from './sessions/TerminalSessionsCoordinator.js';
export type { TerminalSessionsCoordinatorOptions } from './sessions/TerminalSessionsCoordinator.js';
export type { TerminalRenderSchedulerStats } from './core/TerminalRenderScheduler.js';
export type { TerminalInitializationSchedulerSnapshot } from './internal/TerminalInitializationScheduler.js';
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
} from './core/TerminalOutputPipeline.js';
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
  PagedTerminalPreparedHistoryOutcome,
  PagedTerminalPreparedHistoryStatus,
  PreparedPagedTerminalHistory,
  PreparePagedTerminalHistoryOptions,
} from './core/PagedTerminalOutputCoordinator.js';
export type {
  TerminalFabricBackend,
  TerminalFabricDiagnostics,
  TerminalFabricRenderPath,
  TerminalFabricStats,
} from './fabric/types.js';

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
  TerminalHistoryPage,
  TerminalAtomicAttachResult,
  TerminalAtomicTransport,
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
} from './types.js';

export { getThemeColors, getDefaultTerminalConfig } from './utils/config.js';
export { filterXtermAutoResponses } from './utils/xtermAutoResponseFilter.js';
