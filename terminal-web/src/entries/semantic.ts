export {
  RendererSurface,
  SEMANTIC_CELL_HEIGHT_CSS_PX,
  SEMANTIC_CELL_WIDTH_CSS_PX,
  SEMANTIC_TERMINAL_FONT_FAMILY,
} from '../semantic/RendererSurface.js';
export { TerminalInputBridge } from '../core/TerminalInputBridge.js';
export type { TerminalInputBridgeOptions, TerminalKeyInputIntent } from '../core/TerminalInputBridge.js';
export { presentationAdvances, validateHistoryPage, validatePresentation } from '../semantic/presentation.js';
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
  SemanticTerminalPalette,
  SemanticTerminalTypography,
} from '../semantic/RendererSurface.js';
export type {
  SemanticCell,
  SemanticFrame,
  SemanticHistoryDirection,
  SemanticHistoryPage,
  SemanticHistoryRequest,
  SemanticPresentation,
} from '../semantic/presentation.js';
export type {
  Logger,
  TerminalThemeColors,
  TerminalThemeDefinition,
  TerminalThemeName,
} from '../types.js';
