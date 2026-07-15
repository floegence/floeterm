import type { Logger } from '../types.js';

export type TerminalFabricBackend = 'beamterm_webgl2' | 'main_thread_canvas_live';
export type TerminalFabricRenderPath = 'main_thread_webgl2' | 'canvas_live_fallback';

export type TerminalFabricVisibility = 'visible' | 'occluded' | 'offscreen';

export type TerminalFabricColor = {
  r: number;
  g: number;
  b: number;
};

export type TerminalFabricCellAttrs = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  invisible?: boolean;
  faint?: boolean;
};

export type TerminalFabricCell = {
  symbol: string;
  width: number;
  fg: TerminalFabricColor;
  bg: TerminalFabricColor;
  attrs: TerminalFabricCellAttrs;
};

export type TerminalFabricCursor = {
  x: number;
  y: number;
  visible: boolean;
};

export type TerminalFabricTheme = {
  background: number;
  foreground: number;
};

export type TerminalFabricGeometry = {
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
};

export type TerminalFabricFrameReason =
  | 'initial'
  | 'write'
  | 'resize'
  | 'theme'
  | 'font'
  | 'selection'
  | 'scroll'
  | 'interaction'
  | 'context_restore'
  | 'external';

export type TerminalFabricFrame = {
  id: number;
  forceAll: boolean;
  reason: TerminalFabricFrameReason;
  startedAtMs: number;
};

export type TerminalFabricFrameRenderResult = {
  rendered: boolean;
  renderedRows: number;
  dirtyCells: number;
};

export type TerminalFabricStats = {
  backend: TerminalFabricBackend;
  renderPath: TerminalFabricRenderPath;
  activeRendererCount: number;
  visibleViewCount: number;
  offscreenViewCount: number;
  frameCount: number;
  renderedFrameCount: number;
  lastFrameDurationMs: number;
  lastFrameRenderedRows: number;
  lastFrameDirtyCells: number;
  fullRepaintCount: number;
  contextRestoreCount: number;
  fallbackCount: number;
  workerRestartCount: number;
  pendingDeltaCount: number;
  coalescedFrameCount: number;
};

export type TerminalFabricDiagnostics = TerminalFabricStats & {
  webgl2Supported: boolean;
  beamtermLoaded: boolean;
  lastError: string;
};

export type TerminalFabricRendererTarget = {
  container: HTMLElement;
  logger: Logger;
  fontFamily: string;
  fontSize: number;
  theme: Record<string, string>;
  getGhosttyCanvas: () => HTMLCanvasElement | null;
  focusInputSurface: () => void;
  forwardWheel: (event: WheelEvent) => void;
};

export type TerminalFabricRenderer = {
  readonly backend: TerminalFabricBackend;
  readonly renderPath: TerminalFabricRenderPath;
  initialize(target: TerminalFabricRendererTarget): Promise<void>;
  isActive(): boolean;
  startFrame(frame: TerminalFabricFrame, options: {
    cols: number;
    rows: number;
    theme: TerminalFabricTheme;
  }): void;
  writeRow(row: number, cells: TerminalFabricCell[], cols: number): void;
  finishFrame(cursor: TerminalFabricCursor | null): TerminalFabricFrameRenderResult;
  resize(width: number, height: number): void;
  getGeometry(): TerminalFabricGeometry | null;
  setAppearance(appearance: {
    fontFamily?: string;
    fontSize?: number;
    theme?: Record<string, string>;
  }): void;
  setVisible(visible: boolean): void;
  loseContextForTest(): void;
  getDiagnostics(): TerminalFabricDiagnostics;
  dispose(): void;
};
