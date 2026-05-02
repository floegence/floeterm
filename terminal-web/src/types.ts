// TerminalState tracks the lifecycle of the terminal instance.
export enum TerminalState {
  IDLE = 'idle',
  INITIALIZING = 'initializing',
  READY = 'ready',
  CONNECTED = 'connected',
  ERROR = 'error',
  DISPOSED = 'disposed'
}

export interface TerminalResponsiveConfig {
  /**
   * When true, perform a fit() after the terminal receives focus/pointer interaction.
   * This helps keep the terminal responsive when switching between multiple panes/tabs.
   */
  fitOnFocus?: boolean;

  /**
   * When true, emit a resize notification when the terminal receives focus, even if the
   * measured cols/rows did not change since the last notification.
   *
   * This is useful for "remote PTY sync" scenarios where another view might have resized
   * the remote session while this view was inactive.
   */
  emitResizeOnFocus?: boolean;

  /**
   * When true, suppress resize notifications unless the terminal is focused.
   * This avoids inactive/hidden terminals overriding remote cols/rows.
   */
  notifyResizeOnlyWhenFocused?: boolean;
}

export type TerminalDimensions = {
  cols: number;
  rows: number;
};

export interface TerminalFitConfig {
  /**
   * Extra horizontal space reserved before computing terminal columns.
   * ghostty-web reserves 15px for a scrollbar by default; hosts with overlay
   * scrollbars can set this to 0 so the terminal grid matches its surface.
   */
  scrollbarReservePx?: number;
}

export interface TerminalClipboardConfig {
  /**
   * When true, mouse selection follows the upstream terminal default and copies
   * the selected text immediately. Consumers that want standard explicit copy
   * commands only should set this to false.
   */
  copyOnSelect?: boolean;
}

export type TerminalCopySelectionSource = 'shortcut' | 'command' | 'copy_event';

export interface TerminalSelectionSnapshot {
  text: string;
  hasSelection: boolean;
}

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

export interface TerminalBufferCellPosition {
  x: number;
  y: number;
}

export interface TerminalBufferRange {
  start: TerminalBufferCellPosition;
  end: TerminalBufferCellPosition;
}

export interface TerminalLink {
  text: string;
  range: TerminalBufferRange;
  activate: (event: MouseEvent) => void;
  hover?: (isHovered: boolean) => void;
  dispose?: () => void;
}

export interface TerminalLinkProvider {
  provideLinks: (y: number, callback: (links: TerminalLink[] | undefined) => void) => void;
  dispose?: () => void;
}

// TerminalConfig mirrors the terminal options that consumers commonly customize.
export interface TerminalConfig {
  cols?: number;
  rows?: number;
  /**
   * When provided, TerminalCore renders at these terminal dimensions instead of
   * fitting to the container. This is useful for passive mirrors of a remote PTY
   * whose geometry is owned by another surface.
   */
  fixedDimensions?: TerminalDimensions | null;
  theme?: Record<string, unknown>;
  clipboard?: TerminalClipboardConfig;
  fontSize?: number;
  fontFamily?: string;
  fit?: TerminalFitConfig;
  presentationScale?: number;
  cursorBlink?: boolean;
  scrollback?: number;
  rendererType?: 'canvas' | 'webgl' | 'dom';
  allowTransparency?: boolean;
  convertEol?: boolean;
  allowProposedApi?: boolean;
  responsive?: TerminalResponsiveConfig;
  [key: string]: unknown;
}

export interface TerminalAppearance {
  theme?: Record<string, unknown>;
  fontSize?: number;
  fontFamily?: string;
  presentationScale?: number;
}

export type TerminalVisualSuspendReason =
  | 'workbench_pan'
  | 'workbench_zoom'
  | 'workbench_widget_drag'
  | 'workbench_widget_resize'
  | 'workbench_layer_switch'
  | 'workbench_window_fit'
  | 'workbench_widget_create'
  | 'workbench_widget_close'
  | 'external';

export interface TerminalVisualSuspendOptions {
  reason?: TerminalVisualSuspendReason;
}

export interface TerminalVisualSuspendHandle {
  readonly id: number;
  readonly reason: TerminalVisualSuspendReason;
  dispose(): void;
}

export interface TerminalRuntimeLineSnapshot {
  row: number;
  text: string;
}

export interface TerminalTouchScrollRuntime {
  scrollLines(amount: number): boolean;
  getScrollbackLength(): number;
  isAlternateScreen(): boolean;
  sendAlternateScreenInput(data: string): void;
}

// Logger is a lightweight interface for capturing terminal diagnostics.
export interface Logger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

// TerminalEventHandlers connects terminal callbacks to controllers or direct hosts.
export interface TerminalEventHandlers {
  onData?: (data: string) => void;
  onResize?: (size: { cols: number; rows: number }) => void;
  onBell?: () => void;
  onTitleChange?: (title: string) => void;
  onStateChange?: (state: TerminalState) => void;
  onError?: (error: Error) => void;
}

// TerminalCoreLike describes the subset of TerminalCore behaviour the managed controller needs.
// It allows injecting a lightweight implementation for tests or non-browser runtimes.
export interface TerminalCoreLike {
  initialize(): Promise<void>;
  dispose(): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  clear(): void;
  serialize(): string;
  getSelectionText(): string;
  hasSelection(): boolean;
  copySelection(source?: TerminalCopySelectionSource): Promise<TerminalCopySelectionResult>;
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
  setFixedDimensions(dimensions: TerminalDimensions | null): void;
  setAppearance?(appearance: TerminalAppearance): void;
  setTheme(theme: Record<string, unknown>): void;
  setFontSize(size: number): void;
  setPresentationScale(scale: number): void;
  setFontFamily?(family: string): void;
  beginVisualSuspend?(options?: TerminalVisualSuspendOptions): TerminalVisualSuspendHandle;
  registerLinkProvider?(provider: TerminalLinkProvider): void;
  startHistoryReplay(duration?: number): void;
  endHistoryReplay?(): void;
  readBufferLine?(row: number, options?: { trimRight?: boolean }): string;
  readBufferLines?(startRow: number, endRowInclusive: number, options?: { trimRight?: boolean }): TerminalRuntimeLineSnapshot[];
  getTouchScrollRuntime?(): TerminalTouchScrollRuntime | null;
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
  type?: 'data' | 'replay-complete';
  data: Uint8Array;
  sequence?: number;
  timestampMs?: number;
  echoOfInput?: boolean;
  originalSource?: string;
}

export interface TerminalDataSubscriptionOptions {
  lastSeq?: number;
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
  onTerminalData(
    sessionId: TerminalID,
    handler: (event: TerminalDataEvent) => void,
    options?: TerminalDataSubscriptionOptions
  ): () => void;
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
  hasSelection: () => boolean;
  copySelection: (source?: TerminalCopySelectionSource) => Promise<TerminalCopySelectionResult>;
  setConnected: (connected: boolean) => void;
  forceResize: () => void;
  setSearchResultsCallback: (callback: ((results: { resultIndex: number; resultCount: number; matchPositions?: number[] }) => void) | null) => void;
  focus: () => void;
  getTerminalInfo: () => { rows: number; cols: number; bufferLength: number } | null;
  sendInput: (data: string) => void;
  setAppearance: (appearance: TerminalManagerAppearance) => void;
  setTheme: (theme: TerminalThemeName) => void;
  setFontSize: (size: number) => void;
  setPresentationScale: (scale: number) => void;
  reinitialize?: () => Promise<void> | void;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export type TerminalLoadingState =
  | 'idle'
  | 'initializing_terminal'
  | 'attaching'
  | 'processing_history'
  | 'ready';

export interface TerminalManagerOptions {
  sessionId: TerminalID;
  isActive: boolean;
  transport: TerminalTransport;
  eventSource: TerminalEventSource;
  themeName?: TerminalThemeName;
  fontSize?: number;
  presentationScale?: number;
  // When true, automatically focus the terminal after it finishes initializing
  // and any initial history replay is completed.
  autoFocus?: boolean;
  logger?: Logger;
  onResize?: (cols: number, rows: number) => void;
  onError?: (error: Error) => void;
  config?: TerminalConfig;
  coreConstructor?: TerminalCoreConstructor;
  scheduler?: TerminalInstanceScheduler;
}

export interface TerminalManagerAppearance {
  themeName?: TerminalThemeName;
  fontSize?: number;
  fontFamily?: string;
  presentationScale?: number;
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

export type TerminalConnectionController = TerminalConnectionStateWithComputed;

export type TerminalInstanceOptions = TerminalManagerOptions;

export type TerminalInstanceMutableOptions = Partial<Omit<TerminalInstanceOptions, 'transport' | 'eventSource' | 'coreConstructor' | 'scheduler'>>;

export interface TerminalInstanceScheduler {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(id: ReturnType<typeof setTimeout>): void;
}

export interface TerminalInstanceSnapshot {
  state: TerminalManagerStateWithComputed;
  connection: TerminalConnectionStateWithComputed;
  loadingState: TerminalLoadingState;
  loadingMessage: string;
}

export type TerminalInstanceListener = (snapshot: TerminalInstanceSnapshot) => void;

export interface TerminalInstanceController {
  mount(container: HTMLElement): Promise<void>;
  unmount(): void;
  dispose(): void;
  updateOptions(options: TerminalInstanceMutableOptions): void;
  getSnapshot(): TerminalInstanceSnapshot;
  subscribe(listener: TerminalInstanceListener): () => void;
  getCore(): TerminalCoreLike | null;
  readonly actions: TerminalManagerActions;
  readonly connection: TerminalConnectionController;
}

export interface TerminalManagerReturn extends TerminalInstanceSnapshot {
  actions: TerminalManagerActions;
}

export type TerminalThemeName = 'dark' | 'light' | 'solarizedDark' | 'monokai' | 'tokyoNight';
