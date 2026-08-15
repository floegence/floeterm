export {
  RendererSurface,
  SEMANTIC_CELL_HEIGHT_CSS_PX,
  SEMANTIC_CELL_WIDTH_CSS_PX,
  SEMANTIC_TERMINAL_FONT_FAMILY,
} from '../semantic/RendererSurface.js';
export { TerminalInputBridge } from '../core/TerminalInputBridge.js';
export { HistoryViewportController } from '../semantic/HistoryViewportController.js';
export type { HistoryViewportControllerOptions, HistoryViewportState } from '../semantic/HistoryViewportController.js';
export type { TerminalInputBridgeOptions, TerminalKeyInputIntent } from '../core/TerminalInputBridge.js';
export {
  assembleHistoryViewport,
  presentationAdvances,
  validateHistoryChunk,
  validateHistoryViewport,
  validatePresentation,
} from '../semantic/presentation.js';
export {
  getDefaultTerminalConfig,
  getTerminalThemeDefinition,
  getThemeColors,
  isTerminalThemeName,
  normalizeTerminalThemeName,
  TERMINAL_THEME_DEFINITIONS,
  TERMINAL_THEME_NAMES,
} from '../utils/config.js';
export type {
  SemanticTerminalCellMetrics,
  SemanticTerminalCursorRect,
  SemanticTerminalPalette,
  SemanticTerminalTypography,
} from '../semantic/RendererSurface.js';
export type {
  SemanticCell,
  SemanticFrame,
  SemanticHistoryChunk,
  SemanticHistoryChunkRequest,
  SemanticHistoryDirection,
  SemanticHistoryRequest,
  SemanticHistoryViewport,
  SemanticPresentation,
} from '../semantic/presentation.js';
export type {
  Logger,
  TerminalThemeColors,
  TerminalThemeDefinition,
  TerminalThemeName,
} from '../types.js';
