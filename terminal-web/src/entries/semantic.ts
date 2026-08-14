export {
  RendererSurface,
  SEMANTIC_CELL_HEIGHT_CSS_PX,
  SEMANTIC_CELL_WIDTH_CSS_PX,
  SEMANTIC_TERMINAL_FONT_FAMILY,
} from '../semantic/RendererSurface.js';
export { TerminalInputBridge } from '../core/TerminalInputBridge.js';
export type { TerminalInputBridgeOptions } from '../core/TerminalInputBridge.js';
export { presentationAdvances, validateHistoryPage, validatePresentation } from '../semantic/presentation.js';
export {
  getTerminalThemeDefinition,
  getThemeColors,
  isTerminalThemeName,
  TERMINAL_THEME_DEFINITIONS,
} from '../utils/config.js';
export type {
  SemanticTerminalPalette,
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
  TerminalDataChunk,
  TerminalHistoryPage,
  TerminalID,
  TerminalInstanceSnapshot,
  TerminalSessionInfo,
  TerminalThemeColors,
  TerminalThemeName,
} from '../types.js';
export { TerminalState } from '../types.js';
