import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalCore } from '../core/TerminalCore';
import { SequenceBuffer } from '../internal/SequenceBuffer';
import { concatChunks } from '../utils/history';
import { createTerminalError } from '../utils/errors';
import { getDefaultTerminalConfig, getThemeColors } from '../utils/config';
import { createConsoleLogger, noopLogger } from '../utils/logger';
import type {
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

enum LoadingState {
  IDLE = 'idle',
  INITIALIZING_TERMINAL = 'initializing_terminal',
  ATTACHING = 'attaching',
  PROCESSING_HISTORY = 'processing_history',
  READY = 'ready'
}

// useTerminalInstance creates and manages a single xterm instance.
export const useTerminalInstance = (options: TerminalManagerOptions): TerminalManagerReturn => {
  const {
    sessionId,
    isActive,
    transport,
    eventSource,
    themeName = 'dark',
    fontSize,
    onResize,
    onError,
    config: customConfig,
    logger: injectedLogger
  } = options;

  const logger = injectedLogger ?? createConsoleLogger();

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalCoreRef = useRef<TerminalCore | null>(null);
  const isInitializingRef = useRef(false);
  const historyLoadedRef = useRef(false);
  const sequenceBufferRef = useRef(new SequenceBuffer());

  const [loadingState, setLoadingState] = useState(LoadingState.IDLE);
  const [loadingMessage, setLoadingMessage] = useState('');

  const [connectionState, setConnectionState] = useState(ConnectionState.IDLE);
  const [connectionError, setConnectionError] = useState<TerminalError | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [state, setState] = useState<TerminalManagerState>({
    state: TerminalState.IDLE,
    error: undefined,
    dimensions: { cols: 80, rows: 24 }
  });

  const dataQueueRef = useRef<TerminalDataChunk[]>([]);
  const isProcessingRef = useRef(false);

  const updateState = useCallback((updates: Partial<TerminalManagerState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);

  const handleStateChange = useCallback((newState: TerminalState) => {
    updateState({ state: newState });
  }, [updateState]);

  const handleResize = useCallback(async (size: { cols: number; rows: number }) => {
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

  const waitForTerminalReady = useCallback(async (): Promise<void> => {
    while (terminalCoreRef.current) {
      const terminalState = terminalCoreRef.current.getState();
      if (terminalState === TerminalState.READY || terminalState === TerminalState.CONNECTED) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }, []);

  const loadHistoryAfterReady = useCallback(async (currentSessionId: string, retry = 0) => {
    const maxRetries = 2;
    const retryDelay = 1000;

    try {
      setLoadingState(LoadingState.PROCESSING_HISTORY);
      setLoadingMessage('Loading terminal history...');
      await waitForTerminalReady();

      const history = await transport.history(currentSessionId, 0, -1);
      if (history.length === 0) {
        setLoadingState(LoadingState.READY);
        setLoadingMessage('');
        return;
      }

      const sorted = [...history].sort((a, b) => a.sequence - b.sequence);
      const decodedChunks = sorted.map(chunk => chunk.data);
      const merged = concatChunks(decodedChunks);

      const container = containerRef.current;
      if (container) {
        container.style.visibility = 'hidden';
      }

      terminalCoreRef.current?.startHistoryReplay(5000);
      terminalCoreRef.current?.write(merged, () => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (container) {
              container.style.visibility = 'visible';
            }
          });
        });
      });

      setLoadingState(LoadingState.READY);
      setLoadingMessage('');
    } catch (error) {
      logger.warn('[useTerminalInstance] History load failed', { error, retry });
      if (retry < maxRetries) {
        setTimeout(() => {
          loadHistoryAfterReady(currentSessionId, retry + 1);
        }, retryDelay * Math.pow(2, retry));
      } else {
        setLoadingState(LoadingState.READY);
        setLoadingMessage('');
      }
    }
  }, [transport, waitForTerminalReady, logger]);

  const initializeTerminal = useCallback(async () => {
    if (!containerRef.current || isInitializingRef.current || terminalCoreRef.current) {
      return;
    }

    isInitializingRef.current = true;
    setLoadingState(LoadingState.INITIALIZING_TERMINAL);
    setLoadingMessage('Initializing terminal...');

    try {
      const configOverrides = { ...(customConfig ?? {}), ...(fontSize ? { fontSize } : {}) };
      const config = getDefaultTerminalConfig(themeName, configOverrides);

      terminalCoreRef.current = new TerminalCore(
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

      if (sessionId) {
        const dimensions = terminalCoreRef.current.getDimensions();
        await transport.resize(sessionId, dimensions.cols, dimensions.rows);
      }

      setLoadingState(LoadingState.READY);
      setLoadingMessage('');
    } catch (error) {
      handleError(error instanceof Error ? error : new Error(String(error)));
      setLoadingState(LoadingState.READY);
      setLoadingMessage('');
    } finally {
      isInitializingRef.current = false;
    }
  }, [customConfig, fontSize, themeName, handleUserInput, handleResize, handleStateChange, handleError, transport, sessionId, logger]);

  const cleanupTerminal = useCallback(() => {
    if (terminalCoreRef.current) {
      terminalCoreRef.current.dispose();
      terminalCoreRef.current = null;
    }
    dataQueueRef.current = [];
    isProcessingRef.current = false;
  }, []);

  const processDataQueue = useCallback(async () => {
    if (isProcessingRef.current || !terminalCoreRef.current || dataQueueRef.current.length === 0) {
      return;
    }

    const terminalState = terminalCoreRef.current.getState();
    if (terminalState !== TerminalState.READY && terminalState !== TerminalState.CONNECTED) {
      setTimeout(() => processDataQueue(), 100);
      return;
    }

    isProcessingRef.current = true;

    try {
      const batch = dataQueueRef.current.splice(0, 10);
      for (const chunk of batch) {
        terminalCoreRef.current.write(chunk.data);
      }

      if (dataQueueRef.current.length > 0) {
        requestAnimationFrame(() => processDataQueue());
      }
    } finally {
      isProcessingRef.current = false;
      if (dataQueueRef.current.length > 0) {
        requestAnimationFrame(() => processDataQueue());
      }
    }
  }, []);

  const addChunkToQueue = useCallback((chunk: TerminalDataChunk) => {
    const ready = sequenceBufferRef.current.push(chunk);
    if (ready.length === 0) {
      return;
    }

    dataQueueRef.current.push(...ready);
    if (!isProcessingRef.current) {
      requestAnimationFrame(() => processDataQueue());
    }
  }, [processDataQueue]);

  const connectToSession = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    setConnectionState(ConnectionState.CONNECTING);
    setConnectionError(null);
    setLoadingState(LoadingState.ATTACHING);
    setLoadingMessage('Attaching to session...');

    try {
      const dims = state.dimensions || { cols: 80, rows: 24 };
      await transport.attach(sessionId, dims.cols, dims.rows);
      setConnectionState(ConnectionState.CONNECTED);
      setRetryCount(0);
      setLoadingState(LoadingState.READY);
      setLoadingMessage('');
    } catch (error) {
      const terminalError = createTerminalError('transport', error);
      setConnectionState(ConnectionState.FAILED);
      setConnectionError(terminalError);
      setLoadingState(LoadingState.READY);
      setLoadingMessage('');
    }
  }, [sessionId, transport, state.dimensions]);

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

    const unsubscribe = eventSource.onTerminalData(sessionId, (payload: TerminalDataEvent) => {
      const chunk: TerminalDataChunk = {
        data: payload.data,
        sequence: payload.sequence ?? 0,
        timestampMs: payload.timestampMs ?? Date.now()
      };
      addChunkToQueue(chunk);
    });

    return () => {
      unsubscribe();
    };
  }, [eventSource, sessionId, addChunkToQueue]);

  useEffect(() => {
    if (!isActive || !terminalCoreRef.current || !sessionId) {
      return;
    }

    connectToSession();
  }, [isActive, sessionId, connectToSession]);

  useEffect(() => {
    if (!terminalCoreRef.current || !sessionId || historyLoadedRef.current) {
      return;
    }

    if (state.state === TerminalState.READY) {
      historyLoadedRef.current = true;
      loadHistoryAfterReady(sessionId);
    }
  }, [state.state, sessionId, loadHistoryAfterReady]);

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
        transport.clear(sessionId).catch(error => logger.warn('[useTerminalInstance] Clear failed', { error }));
      }
    },
    findNext: (term, options) => terminalCoreRef.current?.findNext(term, options) ?? false,
    findPrevious: (term, options) => terminalCoreRef.current?.findPrevious(term, options) ?? false,
    clearSearch: () => terminalCoreRef.current?.clearSearch(),
    serialize: () => terminalCoreRef.current?.serialize() ?? '',
    getSelectionText: () => terminalCoreRef.current?.getSelectionText() ?? '',
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
    reinitialize: async () => {
      cleanupTerminal();
      historyLoadedRef.current = false;
      await initializeTerminal();
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
