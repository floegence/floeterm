import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalCore } from '../core/TerminalCore';
import { SequenceBuffer } from '../internal/SequenceBuffer';
import { createTerminalError } from '../utils/errors';
import { getDefaultTerminalConfig, getThemeColors } from '../utils/config';
import { createConsoleLogger, noopLogger } from '../utils/logger';
import { concatChunks } from '../utils/history';
import type {
  TerminalCoreLike,
  TerminalCoreConstructor,
  TerminalConnectionState,
  TerminalError,
  TerminalManagerActions,
  TerminalManagerOptions,
  TerminalManagerReturn,
  TerminalManagerState,
  TerminalDataChunk,
  TerminalDataEvent
} from '../types';
import { TerminalState } from '../types';

enum ConnectionState {
  IDLE = 'idle',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  RETRYING = 'retrying',
  FAILED = 'failed',
  ABORTED = 'aborted'
}

const MAX_WRITE_BATCH_CHUNKS = 64;
const MAX_WRITE_BATCH_BYTES = 256 * 1024;

enum LoadingState {
  IDLE = 'idle',
  INITIALIZING_TERMINAL = 'initializing_terminal',
  ATTACHING = 'attaching',
  PROCESSING_HISTORY = 'processing_history',
  READY = 'ready'
}

// useTerminalInstance creates and manages a single terminal instance.
export const useTerminalInstance = (options: TerminalManagerOptions): TerminalManagerReturn => {
  const {
    sessionId,
    isActive,
    transport,
    eventSource,
    themeName = 'dark',
    fontSize,
    presentationScale,
    autoFocus = false,
    onResize,
    onError,
    config: customConfig,
    logger: injectedLogger,
    coreConstructor
  } = options;

  const logger = injectedLogger ?? createConsoleLogger();

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalCoreRef = useRef<TerminalCoreLike | null>(null);
  const isInitializingRef = useRef(false);
  const terminalDataUnsubscribeRef = useRef<(() => void) | null>(null);
  const sequenceBufferRef = useRef(new SequenceBuffer());
  const replayCompleteReceivedRef = useRef(false);
  const isReplayActiveRef = useRef(false);
  const lastAppliedSequenceRef = useRef(0);

  const [loadingState, setLoadingState] = useState(LoadingState.IDLE);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [replaySubscriptionKey, setReplaySubscriptionKey] = useState(0);
  const [terminalReadyKey, setTerminalReadyKey] = useState(0);

  const [connectionState, setConnectionState] = useState(ConnectionState.IDLE);
  const [connectionError, setConnectionError] = useState<TerminalError | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [state, setState] = useState<TerminalManagerState>({
    state: TerminalState.IDLE,
    error: undefined,
    dimensions: { cols: 80, rows: 24 }
  });
  const dimensionsRef = useRef({ cols: 80, rows: 24 });

  const dataQueueRef = useRef<TerminalDataChunk[]>([]);
  const isProcessingRef = useRef(false);
  const queueGenerationRef = useRef(0);
  const flushRafRef = useRef<number | null>(null);
  const processDataQueueRef = useRef<() => void>(() => {});

  // Reset session-scoped state when switching sessions (important for ordering + history replay).
  useEffect(() => {
    queueGenerationRef.current += 1;
    sequenceBufferRef.current.reset(1);
    replayCompleteReceivedRef.current = false;
    isReplayActiveRef.current = false;
    lastAppliedSequenceRef.current = 0;
    dataQueueRef.current = [];
    isProcessingRef.current = false;
    if (flushRafRef.current !== null) {
      cancelAnimationFrame(flushRafRef.current);
      flushRafRef.current = null;
    }

    setConnectionState(ConnectionState.IDLE);
    setConnectionError(null);
    setRetryCount(0);
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, [sessionId]);

  const updateState = useCallback((updates: Partial<TerminalManagerState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);

  const handleStateChange = useCallback((newState: TerminalState) => {
    updateState({ state: newState });
  }, [updateState]);

  const handleResize = useCallback(async (size: { cols: number; rows: number }) => {
    dimensionsRef.current = size;
    updateState({ dimensions: size });
    onResize?.(size.cols, size.rows);

    if (!sessionId) {
      return;
    }

    try {
      await transport.resize(sessionId, size.cols, size.rows);
    } catch (error) {
      logger.warn('[useTerminalInstance] Resize request failed', { error });
    }
  }, [updateState, onResize, transport, sessionId, logger]);

  const handleError = useCallback((error: Error) => {
    updateState({ error, state: TerminalState.ERROR });
    onError?.(error);
  }, [updateState, onError]);

  const handleUserInput = useCallback((data: string) => {
    if (!sessionId) {
      return;
    }

    transport.sendInput(sessionId, data).catch(error => {
      logger.warn('[useTerminalInstance] sendInput failed', { error });
    });
  }, [transport, sessionId, logger]);

  const scheduleFocus = useCallback(() => {
    if (!autoFocus) {
      return;
    }
    // Defer focus until after the terminal is visible/opened and React has flushed updates.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        terminalCoreRef.current?.focus();
      });
    });
  }, [autoFocus]);

  const cleanupTerminal = useCallback(() => {
    if (terminalCoreRef.current) {
      terminalCoreRef.current.dispose();
      terminalCoreRef.current = null;
    }
    dataQueueRef.current = [];
    isProcessingRef.current = false;
  }, []);

  const finishReplayIfIdle = useCallback(() => {
    if (!replayCompleteReceivedRef.current || dataQueueRef.current.length > 0 || isProcessingRef.current) {
      return;
    }
    if (isReplayActiveRef.current) {
      terminalCoreRef.current?.endHistoryReplay?.();
      isReplayActiveRef.current = false;
    }
    setLoadingState(LoadingState.READY);
    setLoadingMessage('');
    scheduleFocus();
  }, [scheduleFocus]);

  const scheduleDataQueueFlush = useCallback(() => {
    if (flushRafRef.current !== null) {
      return;
    }

    const generation = queueGenerationRef.current;
    flushRafRef.current = requestAnimationFrame(() => {
      flushRafRef.current = null;
      if (queueGenerationRef.current !== generation) {
        return;
      }
      processDataQueueRef.current();
    });
  }, []);

  const processDataQueue = useCallback(async () => {
    const generation = queueGenerationRef.current;
    if (isProcessingRef.current || !terminalCoreRef.current || dataQueueRef.current.length === 0) {
      return;
    }

    const terminalState = terminalCoreRef.current.getState();
    if (terminalState !== TerminalState.READY && terminalState !== TerminalState.CONNECTED) {
      setTimeout(() => {
        if (queueGenerationRef.current !== generation) {
          return;
        }
        processDataQueue();
      }, 100);
      return;
    }

    isProcessingRef.current = true;

    try {
      let batchLength = 0;
      let batchBytes = 0;
      for (const chunk of dataQueueRef.current) {
        if (batchLength >= MAX_WRITE_BATCH_CHUNKS) {
          break;
        }
        if (batchLength > 0 && batchBytes + chunk.data.byteLength > MAX_WRITE_BATCH_BYTES) {
          break;
        }
        batchLength += 1;
        batchBytes += chunk.data.byteLength;
      }

      const batch = dataQueueRef.current.splice(0, Math.max(1, batchLength));
      if (queueGenerationRef.current !== generation) {
        return;
      }
      const payload = batch.length === 1 ? batch[0].data : concatChunks(batch.map(chunk => chunk.data));
      terminalCoreRef.current.write(payload);
      for (const chunk of batch) {
        if (queueGenerationRef.current !== generation) {
          return;
        }
        if (chunk.sequence > lastAppliedSequenceRef.current) {
          lastAppliedSequenceRef.current = chunk.sequence;
        }
      }

    } finally {
      isProcessingRef.current = false;
      if (dataQueueRef.current.length > 0) {
        scheduleDataQueueFlush();
      } else {
        finishReplayIfIdle();
      }
    }
  }, [finishReplayIfIdle, scheduleDataQueueFlush]);

  useEffect(() => {
    processDataQueueRef.current = processDataQueue;
  }, [processDataQueue]);

  const addChunkToQueue = useCallback((chunk: TerminalDataChunk) => {
    if (chunk.sequence > 0 && chunk.sequence <= lastAppliedSequenceRef.current) {
      return;
    }

    const ready = sequenceBufferRef.current.push(chunk);
    if (ready.length === 0) {
      return;
    }

    dataQueueRef.current.push(...ready);
    if (!isProcessingRef.current) {
      scheduleDataQueueFlush();
    }
  }, [scheduleDataQueueFlush]);

  const initializeTerminal = useCallback(async () => {
    if (!containerRef.current || isInitializingRef.current || terminalCoreRef.current) {
      return;
    }

    isInitializingRef.current = true;
    setLoadingState(LoadingState.INITIALIZING_TERMINAL);
    setLoadingMessage('Initializing terminal...');

    try {
      const configOverrides = {
        ...(customConfig ?? {}),
        ...(fontSize ? { fontSize } : {}),
        ...(presentationScale ? { presentationScale } : {}),
      };
      const config = getDefaultTerminalConfig(themeName, configOverrides);

      const CoreCtor: TerminalCoreConstructor = coreConstructor ?? TerminalCore;
      terminalCoreRef.current = new CoreCtor(
        containerRef.current,
        config,
        {
          onData: handleUserInput,
          onResize: handleResize,
          onStateChange: handleStateChange,
          onError: handleError
        },
        logger ?? noopLogger
      );

      await terminalCoreRef.current.initialize();
      setTerminalReadyKey(prev => prev + 1);
      if (isReplayActiveRef.current) {
        terminalCoreRef.current.startHistoryReplay(30000);
      }

      if (sessionId) {
        const dimensions = terminalCoreRef.current.getDimensions();
        await transport.resize(sessionId, dimensions.cols, dimensions.rows);
      }

      processDataQueue();

      if (!isReplayActiveRef.current || replayCompleteReceivedRef.current) {
        setLoadingState(LoadingState.READY);
        setLoadingMessage('');
      } else {
        setLoadingState(LoadingState.PROCESSING_HISTORY);
        setLoadingMessage('Restoring terminal...');
      }
    } catch (error) {
      handleError(error instanceof Error ? error : new Error(String(error)));
      setLoadingState(LoadingState.READY);
      setLoadingMessage('');
    } finally {
      isInitializingRef.current = false;
    }
  }, [customConfig, fontSize, presentationScale, themeName, handleUserInput, handleResize, handleStateChange, handleError, transport, sessionId, logger, processDataQueue]);

  const connectToSession = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    setConnectionState(ConnectionState.CONNECTING);
    setConnectionError(null);
    setLoadingState(LoadingState.ATTACHING);
    setLoadingMessage('Attaching to session...');

    try {
      const dims = terminalCoreRef.current?.getDimensions() ?? dimensionsRef.current;
      await transport.attach(sessionId, dims.cols, dims.rows);
      setConnectionState(ConnectionState.CONNECTED);
      setRetryCount(0);
      if (!isReplayActiveRef.current || replayCompleteReceivedRef.current) {
        setLoadingState(LoadingState.READY);
        setLoadingMessage('');
      } else {
        setLoadingState(LoadingState.PROCESSING_HISTORY);
        setLoadingMessage('Restoring terminal...');
      }
    } catch (error) {
      const terminalError = createTerminalError('transport', error);
      setConnectionState(ConnectionState.FAILED);
      setConnectionError(terminalError);
      setLoadingState(LoadingState.READY);
      setLoadingMessage('');
    }
  }, [sessionId, transport]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    if (!terminalCoreRef.current && !isInitializingRef.current) {
      const timeoutId = setTimeout(() => {
        initializeTerminal();
      }, 100);

      return () => clearTimeout(timeoutId);
    }
  }, [isActive, initializeTerminal]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    isReplayActiveRef.current = true;
    replayCompleteReceivedRef.current = false;
    terminalCoreRef.current?.startHistoryReplay(30000);
    setLoadingState(LoadingState.PROCESSING_HISTORY);
    setLoadingMessage('Restoring terminal...');

    const lastSeq = terminalCoreRef.current ? lastAppliedSequenceRef.current : 0;
    const unsubscribe = eventSource.onTerminalData(sessionId, (payload: TerminalDataEvent) => {
      if (payload.type === 'replay-complete') {
        replayCompleteReceivedRef.current = true;
        const ready = sequenceBufferRef.current.flushPending();
        if (ready.length > 0) {
          dataQueueRef.current.push(...ready);
          scheduleDataQueueFlush();
        } else if (
          typeof payload.sequence === 'number' &&
          payload.sequence > lastAppliedSequenceRef.current &&
          dataQueueRef.current.length === 0 &&
          !isProcessingRef.current
        ) {
          lastAppliedSequenceRef.current = payload.sequence;
          sequenceBufferRef.current.reset(payload.sequence + 1);
        }
        finishReplayIfIdle();
        return;
      }

      const chunk: TerminalDataChunk = {
        data: payload.data,
        sequence: payload.sequence ?? 0,
        timestampMs: payload.timestampMs ?? Date.now()
      };
      addChunkToQueue(chunk);
    }, { lastSeq });
    terminalDataUnsubscribeRef.current = unsubscribe;

    return () => {
      if (terminalDataUnsubscribeRef.current === unsubscribe) {
        terminalDataUnsubscribeRef.current = null;
      }
      unsubscribe();
    };
  }, [eventSource, sessionId, replaySubscriptionKey, addChunkToQueue, finishReplayIfIdle, scheduleDataQueueFlush]);

  useEffect(() => {
    if (!isActive || !terminalCoreRef.current || !sessionId) {
      return;
    }

    connectToSession();
  }, [isActive, sessionId, terminalReadyKey, connectToSession]);

  useEffect(() => {
    return () => {
      cleanupTerminal();
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, [cleanupTerminal]);

  useEffect(() => {
    if (connectionState !== ConnectionState.FAILED) {
      return;
    }

    const delay = Math.min(5000, 1000 * Math.pow(2, retryCount));
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
    }
    retryTimeoutRef.current = setTimeout(() => {
      setRetryCount(prev => prev + 1);
      setConnectionState(ConnectionState.RETRYING);
      connectToSession();
    }, delay);
  }, [connectionState, retryCount, connectToSession]);

  useEffect(() => {
    if (terminalCoreRef.current) {
      terminalCoreRef.current.setConnected(connectionState === ConnectionState.CONNECTED);
    }
  }, [connectionState]);

  useEffect(() => {
    terminalCoreRef.current?.setPresentationScale(presentationScale ?? 1);
  }, [presentationScale]);

  const actions: TerminalManagerActions = {
    write: data => {
      const chunk: TerminalDataChunk = {
        data: new TextEncoder().encode(data),
        sequence: 0,
        timestampMs: Date.now()
      };
      addChunkToQueue(chunk);
    },
    clear: () => {
      terminalCoreRef.current?.clear();
      dataQueueRef.current = [];
      if (sessionId) {
        // Use a best-effort sequence:
        // 1) clear server-side history so future reconnects don't replay old output
        // 2) send an "empty Enter" to the PTY so the shell redraws the prompt immediately
        transport.clear(sessionId)
          .catch(error => logger.warn('[useTerminalInstance] Clear history failed', { error }))
          .finally(() => {
            transport.sendInput(sessionId, '\r').catch(error => logger.warn('[useTerminalInstance] Clear redraw failed', { error }));
          });
      }
    },
    findNext: (term, options) => terminalCoreRef.current?.findNext(term, options) ?? false,
    findPrevious: (term, options) => terminalCoreRef.current?.findPrevious(term, options) ?? false,
    clearSearch: () => terminalCoreRef.current?.clearSearch(),
    serialize: () => terminalCoreRef.current?.serialize() ?? '',
    getSelectionText: () => terminalCoreRef.current?.getSelectionText() ?? '',
    hasSelection: () => terminalCoreRef.current?.hasSelection() ?? false,
    copySelection: source => terminalCoreRef.current?.copySelection(source) ?? Promise.resolve({
      copied: false,
      reason: 'empty_selection',
      source: source ?? 'command'
    }),
    setConnected: connected => terminalCoreRef.current?.setConnected(connected),
    forceResize: () => terminalCoreRef.current?.forceResize(),
    setSearchResultsCallback: callback => terminalCoreRef.current?.setSearchResultsCallback(callback),
    focus: () => terminalCoreRef.current?.focus(),
    getTerminalInfo: () => terminalCoreRef.current?.getTerminalInfo() ?? null,
    sendInput: data => handleUserInput(data),
    setTheme: theme => {
      const colors = getThemeColors(theme);
      terminalCoreRef.current?.setTheme(colors);
    },
    setFontSize: size => terminalCoreRef.current?.setFontSize(size),
    setPresentationScale: scale => terminalCoreRef.current?.setPresentationScale(scale),
    reinitialize: async () => {
      terminalDataUnsubscribeRef.current?.();
      terminalDataUnsubscribeRef.current = null;
      queueGenerationRef.current += 1;
      sequenceBufferRef.current.reset(1);
      replayCompleteReceivedRef.current = false;
      isReplayActiveRef.current = true;
      lastAppliedSequenceRef.current = 0;
      dataQueueRef.current = [];
      isProcessingRef.current = false;
      if (flushRafRef.current !== null) {
        cancelAnimationFrame(flushRafRef.current);
        flushRafRef.current = null;
      }
      setLoadingState(LoadingState.PROCESSING_HISTORY);
      setLoadingMessage('Restoring terminal...');
      cleanupTerminal();
      setReplaySubscriptionKey(prev => prev + 1);
      await initializeTerminal();
      if (isActive && sessionId) {
        await connectToSession();
      }
    }
  };

  const connection: TerminalConnectionState = {
    state: connectionState,
    error: connectionError,
    retryCount,
    connect: connectToSession,
    disconnect: () => setConnectionState(ConnectionState.ABORTED),
    retry: () => {
      setRetryCount(0);
      setConnectionError(null);
      setConnectionState(ConnectionState.IDLE);
      connectToSession();
    },
    clearError: () => setConnectionError(null)
  };

  return {
    containerRef,
    state: {
      ...state,
      get isReady() {
        return state.state === TerminalState.READY || state.state === TerminalState.CONNECTED;
      },
      get isConnected() {
        return state.state === TerminalState.CONNECTED;
      },
      get hasError() {
        return state.state === TerminalState.ERROR;
      },
      get isInitializing() {
        return state.state === TerminalState.INITIALIZING;
      },
      get isIdle() {
        return state.state === TerminalState.IDLE;
      }
    },
    actions,
    connection: {
      ...connection,
      get isConnecting() {
        return connection.state === 'connecting';
      },
      get isConnected() {
        return connection.state === 'connected';
      }
    },
    loadingState,
    loadingMessage
  };
};
