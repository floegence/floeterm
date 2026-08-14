export type TerminalID = string;

export type TerminalDimensions = Readonly<{
  cols: number;
  rows: number;
}>;

export interface TerminalFocusOptions {
  preventScroll?: boolean;
}

export type TerminalCopySelectionSource = 'shortcut' | 'command' | 'copy_event';

export type TerminalCopySelectionResult =
  | {
    copied: true;
    textLength: number;
    source: TerminalCopySelectionSource;
  }
  | {
    copied: false;
    reason: 'empty_selection' | 'clipboard_unavailable';
    source: TerminalCopySelectionSource;
  };

export interface Logger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface TerminalConfig {
  cols?: number;
  rows?: number;
  theme?: Record<string, unknown>;
  fontSize?: number;
  fontFamily?: string;
  cursorBlink?: boolean;
  scrollback?: number;
  allowTransparency?: boolean;
  [key: string]: unknown;
}

export interface TerminalSessionInfo {
  id: TerminalID;
  name: string;
  workingDir: string;
  createdAtMs: number;
  lastActiveAtMs: number;
  isActive: boolean;
  foregroundCommand?: TerminalForegroundCommandInfo;
  outputActivity?: TerminalOutputActivityInfo;
  executionContext?: TerminalExecutionContextInfo;
  workState?: TerminalWorkStateInfo;
}

export type TerminalForegroundCommandPhase = 'unknown' | 'idle' | 'running';

export interface TerminalForegroundCommandInfo {
  phase: TerminalForegroundCommandPhase;
  displayName: string;
  revision: number;
  updatedAtMs: number;
}

export type TerminalOutputActivityPhase = 'unknown' | 'streaming' | 'settled';

export interface TerminalOutputActivityInfo {
  phase: TerminalOutputActivityPhase;
  revision: number;
  updatedAtMs: number;
}

export type TerminalLocationKind = 'unknown' | 'local' | 'remote';
export type TerminalLocationPhase = 'unknown' | 'opening' | 'ready';
export type TerminalContextSource =
  | 'unknown'
  | 'shell_integration'
  | 'osc7'
  | 'osc_title'
  | 'foreground_candidate';
export type TerminalApplicationKind = 'unknown' | 'shell' | 'agent_cli' | 'interactive_app';

export interface TerminalLocationInfo {
  kind: TerminalLocationKind;
  phase: TerminalLocationPhase;
  label: string;
  authority: string;
  workingDirectory: string;
  source: TerminalContextSource;
}

export interface TerminalApplicationInfo {
  kind: TerminalApplicationKind;
  identity: string;
  displayName: string;
}

export interface TerminalExecutionContextInfo {
  location: TerminalLocationInfo;
  application: TerminalApplicationInfo;
  revision: number;
  updatedAtMs: number;
}

export type TerminalWorkPhase = 'unknown' | 'idle' | 'working' | 'waiting_user';

export interface TerminalWorkStateInfo {
  phase: TerminalWorkPhase;
  source: '' | 'semantic';
  contextRevision: number;
  foregroundCommandRevision: number;
  revision: number;
  updatedAtMs: number;
}

export interface TerminalNameUpdateEvent {
  sessionId: TerminalID;
  newName: string;
  workingDir: string;
}

export interface TerminalForegroundCommandUpdateEvent {
  sessionId: TerminalID;
  foregroundCommand: TerminalForegroundCommandInfo;
}

export interface TerminalOutputActivityUpdateEvent {
  sessionId: TerminalID;
  outputActivity: TerminalOutputActivityInfo;
}

export interface TerminalExecutionContextUpdateEvent {
  sessionId: TerminalID;
  executionContext: TerminalExecutionContextInfo;
}

export interface TerminalWorkStateUpdateEvent {
  sessionId: TerminalID;
  workState: TerminalWorkStateInfo;
}

export interface TerminalGeometryEvent {
  sessionId: TerminalID;
  generation: number;
  presentationSequence: number;
  cols: number;
  rows: number;
}

export interface TerminalTransport {
  listSessions?(): Promise<TerminalSessionInfo[]>;
  createSession?(
    name?: string,
    workingDir?: string,
    cols?: number,
    rows?: number,
  ): Promise<TerminalSessionInfo>;
  deleteSession?(sessionId: TerminalID): Promise<void>;
  renameSession?(sessionId: TerminalID, newName: string): Promise<void>;
}

export type TerminalThemeName =
  | 'dark'
  | 'light'
  | 'solarizedDark'
  | 'monokai'
  | 'tokyoNight'
  | 'polarVeil'
  | 'copperCircuit'
  | 'violetDusk'
  | 'cedarGrove'
  | 'midnightInk'
  | 'velvetOrchid'
  | 'blueQuarry'
  | 'studioPaper'
  | 'softLinen'
  | 'mintGlass'
  | 'roseDawn'
  | 'openSky'
  | 'highContrastDark'
  | 'highContrastLight'
  | 'signalSafeDark';

export type TerminalThemeAppearance = 'dark' | 'light';

export type TerminalThemeColors = Readonly<{
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}>;

export type TerminalThemeDefinition = Readonly<{
  id: TerminalThemeName;
  label: string;
  appearance: TerminalThemeAppearance;
  colors: TerminalThemeColors;
}>;
