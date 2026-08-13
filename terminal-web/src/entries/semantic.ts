export {
  RendererSurface,
  SEMANTIC_CELL_HEIGHT_CSS_PX,
  SEMANTIC_CELL_WIDTH_CSS_PX,
} from '../semantic/RendererSurface.js';
export { presentationAdvances, validateHistoryPage, validatePresentation } from '../semantic/presentation.js';
export {
  getTerminalThemeDefinition,
  getThemeColors,
  isTerminalThemeName,
  TERMINAL_THEME_DEFINITIONS,
} from '../utils/config.js';
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
  TerminalThemeName,
} from '../types.js';
export { TerminalState } from '../types.js';
