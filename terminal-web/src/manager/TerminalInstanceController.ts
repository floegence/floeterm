import { TerminalCore } from '../core/TerminalCore.js';
import { SequenceBuffer } from '../internal/SequenceBuffer.js';
import { createTerminalError } from '../utils/errors.js';
import { getDefaultTerminalConfig, getThemeColors } from '../utils/config.js';
import { createConsoleLogger, noopLogger } from '../utils/logger.js';
import { concatChunks } from '../utils/history.js';
import {
  TerminalState,
  computeConnectionState,
  computeTerminalState,
  type Logger,
  type TerminalConnectionController,
  type TerminalConnectionState,
  type TerminalCoreConstructor,
  type TerminalCoreLike,
  type TerminalAtomicTransport,
  type TerminalDataChunk,
  type TerminalDataEvent,
  type TerminalError,
  type TerminalInstanceController,
  type TerminalInstanceListener,
  type TerminalInstanceMutableOptions,
  type TerminalInstanceOptions,
  type TerminalInstanceScheduler,
  type TerminalInstanceSnapshot,
  type TerminalHistoryPage,
  type TerminalGeometryEvent,
  type TerminalLoadingState,
  type TerminalManagerActions,
  type TerminalManagerAppearance,
  type TerminalManagerState,
} from '../types.js';

enum ConnectionState {
  IDLE = 'idle',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  RETRYING = 'retrying',
  FAILED = 'failed',
  ABORTED = 'aborted'
}

const MAX_WRITE_BATCH_CHUNKS = 2048;
const MAX_WRITE_BATCH_BYTES = 512 * 1024;
const MAX_IMMEDIATE_LIVE_BATCH_BYTES = 256;

const isAtomicTransport = (transport: TerminalInstanceOptions['transport']): transport is TerminalAtomicTransport => (
  typeof (transport as Partial<TerminalAtomicTransport>).attachWithHistoryBoundary === 'function'
  && typeof (transport as Partial<TerminalAtomicTransport>).historyPage === 'function'
);

const createDefaultScheduler = (): TerminalInstanceScheduler => ({
  requestFrame: callback => {
    if (typeof requestAnimationFrame === 'function') {
      return requestAnimationFrame(callback);
    }
    return setTimeout(() => callback(Date.now()), 0) as unknown as number;
  },
  cancelFrame: id => {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(id);
      return;
    }
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  },
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: id => clearTimeout(id),
});

export class FrameworkNeutralTerminalInstanceController implements TerminalInstanceController {
  private options: TerminalInstanceOptions;
  private readonly logger: Logger;
  private readonly scheduler: TerminalInstanceScheduler;
  private readonly listeners = new Set<TerminalInstanceListener>();

  private container: HTMLElement | null = null;
  private terminalCore: TerminalCoreLike | null = null;
  private isInitializing = false;
  private terminalDataUnsubscribe: (() => void) | null = null;
  private terminalGeometryUnsubscribe: (() => void) | null = null;
  private lastGeometryGeneration = 0;
  private pendingGeometryEvents: TerminalGeometryEvent[] = [];
  private sequenceBuffer = new SequenceBuffer();
  private replayCompleteReceived = false;
  private isReplayActive = false;
  private lastAppliedSequence = 0;

  private loadingState: TerminalLoadingState = 'idle';
  private loadingMessage = '';
  private connectionState: ConnectionState = ConnectionState.IDLE;
  private connectionError: TerminalError | null = null;
  private retryCount = 0;
  private connectGeneration = 0;
  private resizeGeneration = 0;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private initializationAbortController: AbortController | null = null;
  private queueRetryTimeout: ReturnType<typeof setTimeout> | null = null;

  private state: TerminalManagerState = {
    state: TerminalState.IDLE,
    error: undefined,
    dimensions: { cols: 80, rows: 24 }
  };
  private dimensions = { cols: 80, rows: 24 };

  private dataQueue: TerminalDataChunk[] = [];
  private isProcessing = false;
  private queueGeneration = 0;
  private flushRaf: number | null = null;
  private flushMicrotaskScheduled = false;
  private flushMicrotaskGeneration = 0;
  private immediateFlushEligible = false;
  private disposed = false;

  readonly actions: TerminalManagerActions = {
    write: data => {
      const chunk: TerminalDataChunk = {
        data: new TextEncoder().encode(data),
        sequence: 0,
        timestampMs: Date.now()
      };
      this.addChunkToQueue(chunk);
    },
    clear: () => {
      this.terminalCore?.clear();
      this.dataQueue = [];
      const sessionId = this.options.sessionId;
      if (!sessionId) {
        return;
      }
      this.options.transport.clear(sessionId)
        .catch(error => this.logger.warn('[TerminalInstanceController] Clear history failed', { error }))
        .finally(() => {
          this.options.transport.sendInput(sessionId, '\r')
            .catch(error => this.logger.warn('[TerminalInstanceController] Clear redraw failed', { error }));
        });
    },
    findNext: (term, options) => this.terminalCore?.findNext(term, options) ?? false,
    findPrevious: (term, options) => this.terminalCore?.findPrevious(term, options) ?? false,
    clearSearch: () => this.terminalCore?.clearSearch(),
    serialize: () => this.terminalCore?.serialize() ?? '',
    getSelectionText: () => this.terminalCore?.getSelectionText() ?? '',
    hasSelection: () => this.terminalCore?.hasSelection() ?? false,
    copySelection: source => this.terminalCore?.copySelection(source) ?? Promise.resolve({
      copied: false,
      reason: 'empty_selection',
      source: source ?? 'command'
    }),
    setConnected: connected => this.terminalCore?.setConnected(connected),
    forceResize: () => this.terminalCore?.forceResize(),
    setSearchResultsCallback: callback => this.terminalCore?.setSearchResultsCallback(callback),
    focus: options => this.terminalCore?.focus(options),
    getTerminalInfo: () => this.terminalCore?.getTerminalInfo() ?? null,
    sendInput: data => this.handleUserInput(data),
    setAppearance: appearance => this.applyCoreAppearance(appearance),
    setTheme: theme => this.applyCoreAppearance({ themeName: theme }),
    setFontSize: size => this.applyCoreAppearance({ fontSize: size }),
    setPresentationScale: scale => this.applyCoreAppearance({ presentationScale: scale }),
    reinitialize: () => this.reinitialize(),
  };

  constructor(options: TerminalInstanceOptions) {
    this.options = { ...options };
    this.logger = options.logger ?? createConsoleLogger();
    this.scheduler = options.scheduler ?? createDefaultScheduler();
    this.subscribeToTerminalData();
    this.subscribeToTerminalGeometry();
  }

  get connection(): TerminalConnectionController {
    return computeConnectionState(this.createConnectionState());
  }

  async mount(container: HTMLElement): Promise<void> {
    if (this.disposed) {
      throw new Error('Cannot mount a disposed TerminalInstanceController');
    }
    this.container = container;
    this.scheduleInitialize();
  }

  unmount(): void {
    this.initializationAbortController?.abort();
    this.initializationAbortController = null;
    this.cleanupTerminal();
    this.container = null;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.connectGeneration += 1;
    this.initializationAbortController?.abort();
    this.initializationAbortController = null;
    this.clearRetryTimeout();
    this.clearQueueRetryTimeout();
    this.cancelDataQueueFlush();
    this.terminalDataUnsubscribe?.();
    this.terminalDataUnsubscribe = null;
    this.terminalGeometryUnsubscribe?.();
    this.terminalGeometryUnsubscribe = null;
    this.cleanupTerminal();
    this.updateState({ state: TerminalState.DISPOSED });
    this.listeners.clear();
  }

  updateOptions(options: TerminalInstanceMutableOptions): void {
    if (this.disposed) {
      return;
    }

    const previousSessionId = this.options.sessionId;
    const previousIsActive = this.options.isActive;
    const previousTheme = this.options.themeName;
    const previousFontSize = this.options.fontSize;
    const previousFontFamily = this.options.config?.fontFamily;
    const previousPresentationScale = this.options.presentationScale;
    const previousSharedGeometry = Boolean(this.options.config?.responsive?.reportHostDimensionsWithFixedGrid);

    this.options = {
      ...this.options,
      ...options,
      config: options.config !== undefined ? options.config : this.options.config,
    };

    if (options.sessionId !== undefined && options.sessionId !== previousSessionId) {
      this.resetSessionState();
      this.subscribeToTerminalData();
      this.subscribeToTerminalGeometry();
      if (this.terminalCore) {
        void this.reinitialize();
      }
      return;
    }

    const nextSharedGeometry = Boolean(this.options.config?.responsive?.reportHostDimensionsWithFixedGrid);
    if (previousSharedGeometry !== nextSharedGeometry) {
      this.lastGeometryGeneration = 0;
      this.pendingGeometryEvents = [];
      if (!nextSharedGeometry) this.terminalCore?.setFixedDimensions(null);
      this.subscribeToTerminalGeometry();
    }

    if (options.isActive !== undefined && options.isActive !== previousIsActive) {
      if (this.options.isActive) {
        this.scheduleInitialize();
        if (this.terminalCore && this.options.sessionId) {
          void this.connectToSession();
        }
      } else {
        this.terminalCore?.setConnected(false);
      }
    }

    const nextFontFamily = this.options.config?.fontFamily;
    if (
      previousTheme !== this.options.themeName
      || previousFontSize !== this.options.fontSize
      || previousFontFamily !== nextFontFamily
      || previousPresentationScale !== this.options.presentationScale
    ) {
      this.applyCoreAppearance({
        themeName: this.options.themeName,
        ...(typeof this.options.fontSize === 'number' ? { fontSize: this.options.fontSize } : {}),
        ...(typeof nextFontFamily === 'string' ? { fontFamily: nextFontFamily } : {}),
        presentationScale: this.options.presentationScale ?? 1
      });
    }
  }

  getSnapshot(): TerminalInstanceSnapshot {
    return {
      state: computeTerminalState(this.state),
      connection: computeConnectionState(this.createConnectionState()),
      loadingState: this.loadingState,
      loadingMessage: this.loadingMessage,
    };
  }

  subscribe(listener: TerminalInstanceListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getCore(): TerminalCoreLike | null {
    return this.terminalCore;
  }

  private emit(): void {
    if (this.disposed) {
      return;
    }
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private updateState(updates: Partial<TerminalManagerState>): void {
    this.state = { ...this.state, ...updates };
    this.emit();
  }

  private setLoading(state: TerminalLoadingState, message: string): void {
    this.loadingState = state;
    this.loadingMessage = message;
    this.emit();
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.terminalCore?.setConnected(state === ConnectionState.CONNECTED);
    this.emit();
  }

  private setConnectionError(error: TerminalError | null): void {
    this.connectionError = error;
    this.emit();
  }

  private createConnectionState(): TerminalConnectionState {
    return {
      state: this.connectionState,
      error: this.connectionError,
      retryCount: this.retryCount,
      connect: () => void this.connectToSession(),
      disconnect: () => {
        this.clearRetryTimeout();
        this.connectGeneration += 1;
        this.setConnectionState(ConnectionState.ABORTED);
      },
      retry: () => {
        this.clearRetryTimeout();
        this.retryCount = 0;
        this.setConnectionError(null);
        this.setConnectionState(ConnectionState.IDLE);
        void this.connectToSession();
      },
      clearError: () => this.setConnectionError(null),
    };
  }

  private resetSessionState(): void {
    this.queueGeneration += 1;
    this.connectGeneration += 1;
    this.sequenceBuffer.reset(1);
    this.replayCompleteReceived = false;
    this.isReplayActive = false;
    this.lastAppliedSequence = 0;
    this.lastGeometryGeneration = 0;
    this.pendingGeometryEvents = [];
    this.terminalCore?.setFixedDimensions(null);
    this.dataQueue = [];
    this.isProcessing = false;
    this.cancelDataQueueFlush();
    this.clearQueueRetryTimeout();
    this.setConnectionState(ConnectionState.IDLE);
    this.setConnectionError(null);
    this.retryCount = 0;
    this.clearRetryTimeout();
  }

  private handleStateChange = (newState: TerminalState): void => {
    this.updateState({ state: newState });
  };

  private handleResize = async (size: { cols: number; rows: number }): Promise<void> => {
    const resizeGeneration = this.resizeGeneration;
    this.dimensions = size;
    this.updateState({ dimensions: size });
    this.options.onResize?.(size.cols, size.rows);

    const sessionId = this.options.sessionId;
    if (!sessionId) {
      return;
    }
    if (isAtomicTransport(this.options.transport) && this.connectionState !== ConnectionState.CONNECTED) {
      return;
    }

    try {
      await this.options.transport.resize(sessionId, size.cols, size.rows);
    } catch (error) {
      if (this.disposed || resizeGeneration !== this.resizeGeneration) {
        return;
      }
      this.logger.warn('[TerminalInstanceController] Resize request failed', { error });
    }
  };

  private handleError = (error: Error): void => {
    this.updateState({ error, state: TerminalState.ERROR });
    this.options.onError?.(error);
  };

  private handleUserInput(data: string): void {
    const sessionId = this.options.sessionId;
    if (!sessionId) {
      return;
    }

    this.options.transport.sendInput(sessionId, data).catch(error => {
      this.logger.warn('[TerminalInstanceController] sendInput failed', { error });
      this.handleError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private scheduleFocus(): void {
    if (!this.options.autoFocus) {
      return;
    }
    this.scheduler.requestFrame(() => {
      this.scheduler.requestFrame(() => {
        this.terminalCore?.focus();
      });
    });
  }

  private cleanupTerminal(): void {
    this.resizeGeneration += 1;
    this.initializationAbortController?.abort();
    this.initializationAbortController = null;
    this.isInitializing = false;
    if (this.terminalCore) {
      this.terminalCore.dispose();
      this.terminalCore = null;
    }
    this.dataQueue = [];
    this.isProcessing = false;
  }

  private finishReplayIfIdle(): void {
    if (!this.replayCompleteReceived || this.dataQueue.length > 0 || this.isProcessing) {
      return;
    }
    if (this.isReplayActive) {
      this.terminalCore?.endHistoryReplay?.();
      this.isReplayActive = false;
    }
    this.setLoading('ready', '');
    this.scheduleFocus();
  }

  private scheduleDataQueueFlush(allowImmediate = false): void {
    if (this.flushRaf !== null) {
      this.immediateFlushEligible = false;
      return;
    }

    this.immediateFlushEligible = allowImmediate;
    const generation = this.queueGeneration;
    this.flushRaf = this.scheduler.requestFrame(() => {
      this.flushRaf = null;
      if (this.queueGeneration !== generation) {
        return;
      }
      void this.processDataQueue();
    });

    if (!allowImmediate || this.isReplayActive || this.flushMicrotaskScheduled) {
      return;
    }
    this.flushMicrotaskScheduled = true;
    const microtaskGeneration = ++this.flushMicrotaskGeneration;
    queueMicrotask(() => {
      if (microtaskGeneration !== this.flushMicrotaskGeneration) {
        return;
      }
      this.flushMicrotaskScheduled = false;
      if (this.disposed || this.queueGeneration !== generation || this.isReplayActive || this.isProcessing) {
        return;
      }
      if (
        !this.immediateFlushEligible
        || this.dataQueue.length !== 1
        || this.dataQueue[0]!.data.byteLength > MAX_IMMEDIATE_LIVE_BATCH_BYTES
      ) {
        return;
      }
      this.cancelDataQueueFlush();
      void this.processDataQueue();
    });
  }

  private cancelDataQueueFlush(): void {
    this.immediateFlushEligible = false;
    this.flushMicrotaskScheduled = false;
    this.flushMicrotaskGeneration += 1;
    if (this.flushRaf === null) {
      return;
    }
    this.scheduler.cancelFrame(this.flushRaf);
    this.flushRaf = null;
  }

  private async processDataQueue(): Promise<void> {
    const generation = this.queueGeneration;
    if (this.isProcessing || !this.terminalCore) {
      return;
    }

    this.applyPendingGeometryEvents();
    if (this.dataQueue.length === 0) return;

    const terminalState = this.terminalCore.getState();
    if (terminalState !== TerminalState.READY && terminalState !== TerminalState.CONNECTED) {
      this.clearQueueRetryTimeout();
      this.queueRetryTimeout = this.scheduler.setTimer(() => {
        this.queueRetryTimeout = null;
        if (this.queueGeneration !== generation) {
          return;
        }
        void this.processDataQueue();
      }, 100);
      return;
    }

    this.isProcessing = true;

    try {
      let batchLength = 0;
      let batchBytes = 0;
      const geometryBoundary = this.pendingGeometryEvents[0]?.outputSequenceBoundary;
      for (const chunk of this.dataQueue) {
        if (batchLength >= MAX_WRITE_BATCH_CHUNKS) {
          break;
        }
        if (
          geometryBoundary !== undefined
          && chunk.sequence > 0
          && chunk.sequence > geometryBoundary
        ) {
          break;
        }
        if (batchLength > 0 && batchBytes + chunk.data.byteLength > MAX_WRITE_BATCH_BYTES) {
          break;
        }
        batchLength += 1;
        batchBytes += chunk.data.byteLength;
      }

      if (batchLength === 0) {
        return;
      }
      const batch = this.dataQueue.splice(0, batchLength);
      if (this.queueGeneration !== generation) {
        return;
      }
      const payload = batch.length === 1 ? batch[0]!.data : concatChunks(batch.map(chunk => chunk.data));
      this.terminalCore.writeFrame(payload);
      for (const chunk of batch) {
        if (this.queueGeneration !== generation) {
          return;
        }
        if (chunk.sequence > this.lastAppliedSequence) {
          this.lastAppliedSequence = chunk.sequence;
        }
      }
      this.applyPendingGeometryEvents();
    } finally {
      this.isProcessing = false;
      if (this.dataQueue.length > 0) {
        this.scheduleDataQueueFlush();
      } else {
        this.finishReplayIfIdle();
      }
    }
  }

  private addChunkToQueue(chunk: TerminalDataChunk, allowImmediate = false): void {
    if (chunk.sequence > 0 && chunk.sequence <= this.lastAppliedSequence) {
      return;
    }

    const ready = this.sequenceBuffer.push(chunk);
    if (ready.length === 0) {
      return;
    }

    const queueWasEmpty = this.dataQueue.length === 0;
    this.dataQueue.push(...ready);
    if (!this.isProcessing) {
      this.scheduleDataQueueFlush(queueWasEmpty && ready.length === 1 && allowImmediate);
    }
  }

  private applyCoreAppearance(appearance: TerminalManagerAppearance): void {
    const core = this.terminalCore;
    if (!core) {
      return;
    }

    const theme = appearance.themeName ? getThemeColors(appearance.themeName) : undefined;
    if (core.setAppearance) {
      core.setAppearance({
        ...(theme ? { theme } : {}),
        ...(typeof appearance.fontSize === 'number' ? { fontSize: appearance.fontSize } : {}),
        ...(typeof appearance.fontFamily === 'string' ? { fontFamily: appearance.fontFamily } : {}),
        ...(typeof appearance.presentationScale === 'number' ? { presentationScale: appearance.presentationScale } : {})
      });
      return;
    }

    if (theme) {
      core.setTheme(theme);
    }
    if (typeof appearance.fontSize === 'number') {
      core.setFontSize(appearance.fontSize);
    }
    if (typeof appearance.fontFamily === 'string') {
      core.setFontFamily?.(appearance.fontFamily);
    }
    if (typeof appearance.presentationScale === 'number') {
      core.setPresentationScale(appearance.presentationScale);
    }
  }

  private scheduleInitialize(): void {
    if (!this.options.isActive || !this.container || this.terminalCore || this.isInitializing) {
      return;
    }
    void this.initializeTerminal();
  }

  private async initializeTerminal(): Promise<void> {
    if (!this.container || this.isInitializing || this.terminalCore || this.disposed) {
      return;
    }

    this.isInitializing = true;
    const abortController = new AbortController();
    this.initializationAbortController = abortController;
    this.setLoading('initializing_terminal', 'Initializing terminal...');

    try {
      const configOverrides = {
        ...(this.options.config ?? {}),
        sessionId: this.options.sessionId,
        ...(this.options.fontSize ? { fontSize: this.options.fontSize } : {}),
        ...(this.options.presentationScale ? { presentationScale: this.options.presentationScale } : {}),
      };
      const config = getDefaultTerminalConfig(this.options.themeName ?? 'dark', configOverrides);

      const CoreCtor: TerminalCoreConstructor = this.options.coreConstructor ?? TerminalCore;
      const terminalCore = new CoreCtor(
        this.container,
        config,
        {
          onData: data => this.handleUserInput(data),
          onResize: size => void this.handleResize(size),
          onStateChange: this.handleStateChange,
          onError: this.handleError,
          onRender: durationMs => this.options.onRender?.(durationMs),
        },
        this.logger ?? noopLogger
      );
      this.terminalCore = terminalCore;

      await terminalCore.initialize({ priority: 'interactive', signal: abortController.signal });
      if (
        abortController.signal.aborted
        || this.disposed
        || !this.container
        || this.terminalCore !== terminalCore
      ) {
        return;
      }
      if (this.isReplayActive) {
        terminalCore.startHistoryReplay(30000);
      }

      const sessionId = this.options.sessionId;
      if (sessionId && !isAtomicTransport(this.options.transport)) {
        const dimensions = terminalCore.getDimensions();
        await this.options.transport.resize(sessionId, dimensions.cols, dimensions.rows);
      }

      void this.processDataQueue();

      if (!this.isReplayActive || this.replayCompleteReceived) {
        this.setLoading('ready', '');
      } else {
        this.setLoading('processing_history', 'Restoring terminal...');
      }

      if (this.options.isActive && sessionId) {
        await this.connectToSession();
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }
      this.handleError(error instanceof Error ? error : new Error(String(error)));
      this.setLoading('ready', '');
    } finally {
      if (this.initializationAbortController === abortController) {
        this.initializationAbortController = null;
        this.isInitializing = false;
      }
    }
  }

  private async connectToSession(): Promise<void> {
    const sessionId = this.options.sessionId;
    if (!sessionId || this.disposed) {
      return;
    }

    this.clearRetryTimeout();
    this.setConnectionState(ConnectionState.CONNECTING);
    this.setConnectionError(null);
    this.setLoading('attaching', 'Attaching to session...');
    const connectGeneration = ++this.connectGeneration;

    try {
      const dims = this.terminalCore?.getDimensions() ?? this.dimensions;
      if (isAtomicTransport(this.options.transport)) {
        const attached = await this.options.transport.attachWithHistoryBoundary(sessionId, dims.cols, dims.rows);
        if (connectGeneration !== this.connectGeneration || this.disposed) return;
        await this.recoverAtomicHistory(sessionId, attached);
      } else {
        await this.options.transport.attach(sessionId, dims.cols, dims.rows);
      }
      if (connectGeneration !== this.connectGeneration || this.disposed) return;
      this.setConnectionState(ConnectionState.CONNECTED);
      this.retryCount = 0;
      this.emit();
      if (!this.isReplayActive || this.replayCompleteReceived) {
        this.setLoading('ready', '');
      } else {
        this.setLoading('processing_history', 'Restoring terminal...');
      }
    } catch (error) {
      if (connectGeneration !== this.connectGeneration || this.disposed) return;
      const terminalError = createTerminalError('transport', error);
      this.setConnectionState(ConnectionState.FAILED);
      this.setConnectionError(terminalError);
      this.setLoading('ready', '');
      this.scheduleConnectionRetry();
    }
  }

  private async recoverAtomicHistory(
    sessionId: string,
    attachment: { historyBoundarySequence: number; historyGeneration: number; historyStartSequence: number },
  ): Promise<void> {
    const boundary = attachment.historyBoundarySequence;
    const historyGeneration = attachment.historyGeneration;
    const historyStartSequence = attachment.historyStartSequence;
    if (!Number.isSafeInteger(boundary) || boundary < 0) {
      throw new Error('terminal live history boundary is invalid');
    }
    if (!Number.isSafeInteger(historyGeneration) || historyGeneration < 1) {
      throw new Error('terminal live history generation is invalid');
    }
    if (
      !Number.isSafeInteger(historyStartSequence)
      || historyStartSequence < 1
      || historyStartSequence > boundary + 1
    ) {
      throw new Error('terminal live history start sequence is invalid');
    }
    if (!isAtomicTransport(this.options.transport)) {
      throw new Error('terminal atomic history page transport is required');
    }

    this.lastAppliedSequence = Math.max(this.lastAppliedSequence, historyStartSequence - 1);
    this.applyPendingGeometryEvents();
    let queuedHistoryOutput = false;
    let startSequence = Math.max(this.lastAppliedSequence + 1, historyStartSequence);
    while (startSequence <= boundary) {
      const page: TerminalHistoryPage = await this.options.transport.historyPage(
        sessionId,
        startSequence,
        boundary,
        historyGeneration,
      );
      if (page.historyGeneration !== historyGeneration || page.historyReset) {
        throw new Error('terminal history generation changed during atomic replay');
      }
      if (page.snapshotEndSequence !== boundary) {
        throw new Error('terminal history snapshot boundary does not match live attachment');
      }
      if (page.historyTruncated) {
        throw new Error('terminal history was truncated before the acknowledged live boundary');
      }
      if (
        !Number.isSafeInteger(page.coveredThroughSequence)
        || page.coveredThroughSequence < startSequence - 1
        || page.coveredThroughSequence > boundary
      ) {
        throw new Error('terminal history page coverage is invalid');
      }

      let expectedSequence = startSequence;
      for (const chunk of page.chunks) {
        if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence !== expectedSequence) {
          throw new Error(`missing terminal output sequence ${expectedSequence} before replay boundary ${boundary}`);
        }
        if (chunk.sequence > page.coveredThroughSequence) {
          throw new Error('terminal history chunk exceeded its page coverage');
        }
        this.addChunkToQueue(chunk);
        queuedHistoryOutput = true;
        expectedSequence += 1;
      }
      const explicitlyCleared = page.chunks.length === 0 && page.totalBytes === 0;
      if (page.coveredThroughSequence >= expectedSequence && !explicitlyCleared) {
        throw new Error(`missing terminal output sequence ${expectedSequence} before replay boundary ${boundary}`);
      }

      if (!page.hasMore) {
        if (page.coveredThroughSequence !== boundary) {
          throw new Error('terminal history did not cover the acknowledged live boundary');
        }
        startSequence = boundary + 1;
        break;
      }
      if (
        !Number.isSafeInteger(page.nextStartSequence)
        || page.nextStartSequence !== page.coveredThroughSequence + 1
      ) {
        throw new Error('terminal history page cursor is invalid');
      }
      startSequence = page.nextStartSequence;
    }

    const ready = this.sequenceBuffer.coverThrough(boundary);
    if (ready.length > 0) {
      this.dataQueue.push(...ready);
      this.scheduleDataQueueFlush();
    }
    if (!queuedHistoryOutput) {
      this.lastAppliedSequence = Math.max(this.lastAppliedSequence, boundary);
      this.applyPendingGeometryEvents();
    }
    this.replayCompleteReceived = true;
    this.finishReplayIfIdle();
  }

  private scheduleConnectionRetry(): void {
    if (this.connectionState !== ConnectionState.FAILED || this.disposed) {
      return;
    }

    const delay = Math.min(5000, 1000 * Math.pow(2, this.retryCount));
    this.clearRetryTimeout();
    this.retryTimeout = this.scheduler.setTimer(() => {
      this.retryTimeout = null;
      this.retryCount += 1;
      this.setConnectionState(ConnectionState.RETRYING);
      void this.connectToSession();
    }, delay);
  }

  private clearRetryTimeout(): void {
    if (!this.retryTimeout) {
      return;
    }
    this.scheduler.clearTimer(this.retryTimeout);
    this.retryTimeout = null;
  }

  private clearQueueRetryTimeout(): void {
    if (!this.queueRetryTimeout) {
      return;
    }
    this.scheduler.clearTimer(this.queueRetryTimeout);
    this.queueRetryTimeout = null;
  }

  private subscribeToTerminalData(): void {
    this.terminalDataUnsubscribe?.();
    this.terminalDataUnsubscribe = null;

    const sessionId = this.options.sessionId;
    if (!sessionId) {
      return;
    }

    this.isReplayActive = true;
    this.replayCompleteReceived = false;
    this.terminalCore?.startHistoryReplay(30000);
    this.setLoading('processing_history', 'Restoring terminal...');

    const lastSeq = this.terminalCore ? this.lastAppliedSequence : 0;
    const unsubscribe = this.options.eventSource.onTerminalData(sessionId, (payload: TerminalDataEvent) => {
      try {
        if (payload.type === 'error') {
          throw new Error(payload.error || 'Terminal stream failed');
        }

        if (payload.type === 'replay-complete') {
          const boundary = payload.sequence ?? this.lastAppliedSequence;
          this.sequenceBuffer.assertCoveredThrough(boundary);
          this.replayCompleteReceived = true;
          const ready = this.sequenceBuffer.flushPending();
          if (ready.length > 0) {
            this.dataQueue.push(...ready);
            this.scheduleDataQueueFlush();
          }
          this.finishReplayIfIdle();
          return;
        }

        const chunk: TerminalDataChunk = {
          data: payload.data,
          sequence: payload.sequence ?? 0,
          timestampMs: payload.timestampMs ?? Date.now()
        };
        this.addChunkToQueue(chunk, payload.liveBatchSize === 1);
      } catch (value) {
        const error = value instanceof Error ? value : new Error(String(value));
        const terminalError = createTerminalError('connection', error);
        this.setConnectionState(ConnectionState.FAILED);
        this.setConnectionError(terminalError);
        this.setLoading('ready', '');
        this.updateState({ error, state: TerminalState.ERROR });
        this.options.onError?.(error);
        this.scheduleConnectionRetry();
      }
    }, { lastSeq });

    this.terminalDataUnsubscribe = unsubscribe;
  }

  private subscribeToTerminalGeometry(): void {
    this.terminalGeometryUnsubscribe?.();
    this.terminalGeometryUnsubscribe = null;
    if (!this.options.config?.responsive?.reportHostDimensionsWithFixedGrid) {
      return;
    }
    const sessionId = this.options.sessionId;
    const subscribe = this.options.eventSource.onTerminalGeometry;
    if (!sessionId || !subscribe) {
      return;
    }
    this.terminalGeometryUnsubscribe = subscribe(sessionId, (event: TerminalGeometryEvent) => {
      if (!Number.isSafeInteger(event.generation) || event.generation <= 0 ||
        !Number.isSafeInteger(event.outputSequenceBoundary) || event.outputSequenceBoundary < 0 ||
        !Number.isSafeInteger(event.cols) || event.cols <= 0 ||
        !Number.isSafeInteger(event.rows) || event.rows <= 0) {
        this.handleError(new Error('terminal live geometry is invalid'));
        return;
      }
      if (event.generation <= this.lastGeometryGeneration) {
        return;
      }
      const duplicate = this.pendingGeometryEvents.find(pending => pending.generation === event.generation);
      if (duplicate) {
        if (
          duplicate.outputSequenceBoundary !== event.outputSequenceBoundary
          || duplicate.cols !== event.cols
          || duplicate.rows !== event.rows
        ) {
          this.handleError(new Error('terminal live geometry generation is inconsistent'));
        }
        return;
      }
      this.pendingGeometryEvents.push(event);
      this.pendingGeometryEvents.sort((left, right) => left.generation - right.generation);
      this.applyPendingGeometryEvents();
    });
  }

  private applyPendingGeometryEvents(): void {
    if (!this.terminalCore) return;
    while (this.pendingGeometryEvents.length > 0) {
      const event = this.pendingGeometryEvents[0]!;
      if (event.generation <= this.lastGeometryGeneration) {
        this.pendingGeometryEvents.shift();
        continue;
      }
      if (event.outputSequenceBoundary > this.lastAppliedSequence) return;
      this.pendingGeometryEvents.shift();
      this.lastGeometryGeneration = event.generation;
      this.terminalCore.setFixedDimensions({ cols: event.cols, rows: event.rows });
    }
  }

  private async reinitialize(): Promise<void> {
    this.terminalDataUnsubscribe?.();
    this.terminalDataUnsubscribe = null;
    this.queueGeneration += 1;
    this.sequenceBuffer.reset(1);
    this.replayCompleteReceived = false;
    this.isReplayActive = true;
    this.lastAppliedSequence = 0;
    this.lastGeometryGeneration = 0;
    this.pendingGeometryEvents = [];
    this.dataQueue = [];
    this.isProcessing = false;
    this.cancelDataQueueFlush();
    this.clearQueueRetryTimeout();
    this.setLoading('processing_history', 'Restoring terminal...');
    this.cleanupTerminal();
    this.subscribeToTerminalData();
    this.subscribeToTerminalGeometry();
    await this.initializeTerminal();
  }
}

export const createTerminalInstance = (options: TerminalInstanceOptions): TerminalInstanceController => {
  return new FrameworkNeutralTerminalInstanceController(options);
};
