import type React from 'react';

// TerminalState tracks the lifecycle of the terminal instance.
export enum TerminalState {
  IDLE = 'idle',
  INITIALIZING = 'initializing',
  READY = 'ready',
  CONNECTED = 'connected',
  ERROR = 'error',
  DISPOSED = 'disposed'
}

// TerminalConfig mirrors the terminal options that consumers commonly customize.
export interface TerminalConfig {
  cols?: number;
  rows?: number;
  theme?: Record<string, unknown>;
  fontSize?: number;
  fontFamily?: string;
  cursorBlink?: boolean;
  scrollback?: number;
  rendererType?: 'canvas' | 'webgl' | 'dom';
  allowTransparency?: boolean;
  convertEol?: boolean;
  allowProposedApi?: boolean;
  [key: string]: unknown;
}

// Logger is a lightweight interface for capturing terminal diagnostics.
export interface Logger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

// TerminalEventHandlers connects terminal callbacks to the hook layer.
export interface TerminalEventHandlers {
  onData?: (data: string) => void;
  onResize?: (size: { cols: number; rows: number }) => void;
  onStateChange?: (state: TerminalState) => void;
  onError?: (error: Error) => void;
}

// TerminalCoreLike describes the subset of TerminalCore behaviour that the hook needs.
// It allows injecting a lightweight implementation for tests or non-browser runtimes.
export interface TerminalCoreLike {
  initialize(): Promise<void>;
  dispose(): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  clear(): void;
  serialize(): string;
  getSelectionText(): string;
  getState(): TerminalState;
  getDimensions(): { cols: number; rows: number };
  getTerminalInfo(): { rows: number; cols: number; bufferLength: number } | null;
  findNext(term: string, options?: SearchOptions): boolean;
  findPrevious(term: string, options?: SearchOptions): boolean;
  clearSearch(): void;
  setSearchResultsCallback(callback: ((results: { resultIndex: number; resultCount: number; matchPositions?: number[] }) => void) | null): void;
  focus(): void;
  setConnected(isConnected: boolean): void;
  forceResize(): void;
  setTheme(theme: Record<string, string>): void;
  setFontSize(size: number): void;
  startHistoryReplay(duration?: number): void;
}

export interface TerminalCoreConstructor {
  new (
    container: HTMLElement,
    config?: TerminalConfig,
    eventHandlers?: TerminalEventHandlers,
    logger?: Logger
  ): TerminalCoreLike;
}

export type TerminalID = string;

export interface TerminalSessionInfo {
  id: TerminalID;
  name: string;
  workingDir: string;
  createdAtMs: number;
  lastActiveAtMs: number;
  isActive: boolean;
}

export interface TerminalDataChunk {
  sequence: number;
  data: Uint8Array;
  timestampMs: number;
}

export interface TerminalDataEvent {
  sessionId: TerminalID;
  data: Uint8Array;
  sequence?: number;
  timestampMs?: number;
  echoOfInput?: boolean;
  originalSource?: string;
}

export interface TerminalNameUpdateEvent {
  sessionId: TerminalID;
  newName: string;
  workingDir: string;
}

// TerminalTransport is a neutral interface that defines request-style APIs.
export interface TerminalTransport {
  attach(sessionId: TerminalID, cols: number, rows: number): Promise<void>;
  resize(sessionId: TerminalID, cols: number, rows: number): Promise<void>;
  sendInput(sessionId: TerminalID, input: string, sourceConnId?: string): Promise<void>;
  history(sessionId: TerminalID, startSeq: number, endSeq: number): Promise<TerminalDataChunk[]>;
  clear(sessionId: TerminalID): Promise<void>;
  listSessions?(): Promise<TerminalSessionInfo[]>;
  createSession?(name?: string, workingDir?: string, cols?: number, rows?: number): Promise<TerminalSessionInfo>;
  deleteSession?(sessionId: TerminalID): Promise<void>;
  renameSession?(sessionId: TerminalID, newName: string): Promise<void>;
}

// TerminalEventSource exposes streaming event subscriptions.
export interface TerminalEventSource {
  onTerminalData(sessionId: TerminalID, handler: (event: TerminalDataEvent) => void): () => void;
  onTerminalNameUpdate?(sessionId: TerminalID, handler: (event: TerminalNameUpdateEvent) => void): () => void;
  onSessionDeleted?(sessionId: TerminalID, handler: () => void): () => void;
}

export interface TerminalManagerState {
  state: TerminalState;
  error?: Error;
  dimensions: { cols: number; rows: number };
}

export const computeTerminalState = (state: TerminalManagerState) => ({
  ...state,
  get isReady(): boolean {
    return state.state === TerminalState.READY || state.state === TerminalState.CONNECTED;
  },
  get isConnected(): boolean {
    return state.state === TerminalState.CONNECTED;
  },
  get hasError(): boolean {
    return state.state === TerminalState.ERROR;
  },
  get isInitializing(): boolean {
    return state.state === TerminalState.INITIALIZING;
  },
  get isIdle(): boolean {
    return state.state === TerminalState.IDLE;
  }
});

export type TerminalManagerStateWithComputed = ReturnType<typeof computeTerminalState>;

export interface TerminalError {
  type: 'connection' | 'session' | 'transport' | 'timeout';
  message: string;
  retryable: boolean;
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface TerminalManagerActions {
  write: (data: string) => void;
  clear: () => void;
  findNext: (term: string, options?: SearchOptions) => boolean;
  findPrevious: (term: string, options?: SearchOptions) => boolean;
  clearSearch: () => void;
  serialize: () => string;
  getSelectionText: () => string;
  setConnected: (connected: boolean) => void;
  forceResize: () => void;
  setSearchResultsCallback: (callback: ((results: { resultIndex: number; resultCount: number; matchPositions?: number[] }) => void) | null) => void;
  focus: () => void;
  getTerminalInfo: () => { rows: number; cols: number; bufferLength: number } | null;
  sendInput: (data: string) => void;
  setTheme: (theme: TerminalThemeName) => void;
  setFontSize: (size: number) => void;
  reinitialize?: () => Promise<void> | void;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface TerminalManagerOptions {
  sessionId: TerminalID;
  isActive: boolean;
  transport: TerminalTransport;
  eventSource: TerminalEventSource;
  themeName?: TerminalThemeName;
  fontSize?: number;
  // When true, automatically focus the terminal after it finishes initializing
  // and any initial history replay is completed.
  autoFocus?: boolean;
  logger?: Logger;
  onResize?: (cols: number, rows: number) => void;
  onError?: (error: Error) => void;
  config?: TerminalConfig;
  coreConstructor?: TerminalCoreConstructor;
}

export interface TerminalConnectionState {
  state: string;
  error: TerminalError | null;
  retryCount: number;
  connect: () => void;
  disconnect: () => void;
  retry: () => void;
  clearError: () => void;
}

export const computeConnectionState = (connection: TerminalConnectionState) => ({
  ...connection,
  get isConnecting(): boolean {
    return connection.state === 'connecting';
  },
  get isConnected(): boolean {
    return connection.state === 'connected';
  }
});

export type TerminalConnectionStateWithComputed = ReturnType<typeof computeConnectionState>;

export interface TerminalManagerReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  state: TerminalManagerStateWithComputed;
  actions: TerminalManagerActions;
  connection: TerminalConnectionStateWithComputed;
  loadingState: string;
  loadingMessage: string;
}

export type TerminalThemeName = 'dark' | 'light' | 'solarizedDark' | 'monokai';
