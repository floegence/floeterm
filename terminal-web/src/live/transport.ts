import type {
  TerminalAtomicAttachResult,
  TerminalAtomicTransport,
  TerminalDataChunk,
  TerminalDataEvent,
  TerminalEventSource,
  TerminalID,
  TerminalForegroundCommandUpdateEvent,
  TerminalOutputActivityUpdateEvent,
  TerminalExecutionContextUpdateEvent,
  TerminalWorkStateUpdateEvent,
  TerminalNameUpdateEvent,
  TerminalSessionInfo,
  TerminalHistoryPage,
  TerminalHistoryCheckpoint,
  TerminalGeometryEvent,
} from '../types.js';
import type { SemanticHistoryPage, SemanticHistoryRequest } from '../semantic/presentation.js';
import {
  connectTerminalLive,
  type ConnectTerminalLiveOptions,
  type TerminalByteStream,
  type TerminalLiveConnection,
  type TerminalLiveResizeResult,
} from './client.js';
import { StreamKind } from './codec.js';

export type TerminalLiveControlPlane = Readonly<{
  history(sessionId: TerminalID, startSeq: number, endSeq: number): Promise<TerminalDataChunk[]>;
  historyPage(
    sessionId: TerminalID,
    startSequence: number,
    endSequence: number,
    historyGeneration: number,
  ): Promise<TerminalHistoryPage>;
  clear(sessionId: TerminalID): Promise<void>;
  semanticHistory(
    sessionId: TerminalID,
    connectionId: string,
    transportGeneration: number,
    request: SemanticHistoryRequest,
  ): Promise<SemanticHistoryPage>;
  commitHistoryCheckpoint?(sessionId: TerminalID, checkpoint: TerminalHistoryCheckpoint): Promise<void>;
  listSessions?(): Promise<TerminalSessionInfo[]>;
  createSession?(name?: string, workingDir?: string, cols?: number, rows?: number): Promise<TerminalSessionInfo>;
  deleteSession?(sessionId: TerminalID): Promise<void>;
  renameSession?(sessionId: TerminalID, newName: string): Promise<void>;
}>;

export type SemanticTerminalLiveControlPlane = Readonly<{
  clear(sessionId: TerminalID): Promise<void>;
  semanticHistory(
    sessionId: TerminalID,
    connectionId: string,
    transportGeneration: number,
    request: SemanticHistoryRequest,
  ): Promise<SemanticHistoryPage>;
  listSessions?(): Promise<TerminalSessionInfo[]>;
  createSession?(name?: string, workingDir?: string, cols?: number, rows?: number): Promise<TerminalSessionInfo>;
  deleteSession?(sessionId: TerminalID): Promise<void>;
  renameSession?(sessionId: TerminalID, newName: string): Promise<void>;
}>;

export type TerminalLiveAttachResult = TerminalAtomicAttachResult & Readonly<{
  runtimeAttachGeneration: number;
}>;

export type TerminalLiveResizeAppliedResult = TerminalLiveResizeResult & Readonly<{
  runtimeAttachGeneration: number;
}>;

export type TerminalLiveAttachmentCloseReason =
  | 'superseded'
  | 'stream_ended'
  | 'session_closed'
  | 'error'
  | 'detached'
  | 'session_deleted'
  | 'connection_epoch_changed'
  | 'disposed';

export type TerminalLiveAttachmentLifecycleEvent = Readonly<{
  sessionId: TerminalID;
  runtimeAttachGeneration: number;
  state: 'attached' | 'closed';
  reason?: TerminalLiveAttachmentCloseReason;
}>;

export interface TerminalLiveEventSource extends TerminalEventSource {
  onTerminalLiveAttachmentLifecycle(
    sessionId: TerminalID,
    handler: (event: TerminalLiveAttachmentLifecycleEvent) => void,
  ): () => void;
}

export type TerminalLiveTransport = Omit<TerminalAtomicTransport, 'attachWithHistoryBoundary'> & Readonly<{
  attachWithHistoryBoundary(sessionId: TerminalID, cols: number, rows: number): Promise<TerminalLiveAttachResult>;
  resizeWithEffectiveGeometry(
    sessionId: TerminalID,
    cols: number,
    rows: number,
  ): Promise<TerminalLiveResizeAppliedResult>;
  semanticHistory(sessionId: TerminalID, request: SemanticHistoryRequest): Promise<SemanticHistoryPage>;
  forgetSession(sessionId: string): void;
  syncConnectionEpoch(key: object | null): void;
  dispose(): void;
}>;

export type SemanticTerminalLiveTransport = Readonly<{
  attach(sessionId: TerminalID, cols: number, rows: number): Promise<void>;
  attachWithHistoryBoundary(sessionId: TerminalID, cols: number, rows: number): Promise<TerminalLiveAttachResult>;
  resize(sessionId: TerminalID, cols: number, rows: number): Promise<void>;
  resizeWithEffectiveGeometry(
    sessionId: TerminalID,
    cols: number,
    rows: number,
  ): Promise<TerminalLiveResizeAppliedResult>;
  sendInput(sessionId: TerminalID, input: string): Promise<void>;
  clear(sessionId: TerminalID): Promise<void>;
  semanticHistory(sessionId: TerminalID, request: SemanticHistoryRequest): Promise<SemanticHistoryPage>;
  listSessions?(): Promise<TerminalSessionInfo[]>;
  createSession?(name?: string, workingDir?: string, cols?: number, rows?: number): Promise<TerminalSessionInfo>;
  deleteSession?(sessionId: TerminalID): Promise<void>;
  renameSession?(sessionId: TerminalID, newName: string): Promise<void>;
  forgetSession(sessionId: string): void;
  syncConnectionEpoch(key: object | null): void;
  dispose(): void;
}>;

export type CreateTerminalLiveTransportOptions = Readonly<{
  connectionId: string;
  openStream: ConnectTerminalLiveOptions['openStream'];
  control: TerminalLiveControlPlane;
  controlEvents?: TerminalEventSource;
  onError?: (sessionId: string, error: Error) => void;
}>;

export type CreateSemanticTerminalLiveTransportOptions = Readonly<{
  connectionId: string;
  openStream: ConnectTerminalLiveOptions['openStream'];
  control: SemanticTerminalLiveControlPlane;
  controlEvents?: TerminalEventSource;
  onError?: (sessionId: string, error: Error) => void;
}>;

export type TerminalLiveTransportBundle = Readonly<{
  transport: TerminalLiveTransport;
  eventSource: TerminalLiveEventSource;
}>;

export type SemanticTerminalLiveTransportBundle = Readonly<{
  transport: SemanticTerminalLiveTransport;
  eventSource: TerminalLiveEventSource;
}>;

type LiveEntry = {
  generation: number;
  connection: TerminalLiveConnection;
};

const textEncoder = new TextEncoder();

export const createSemanticTerminalLiveTransport = (
  options: CreateSemanticTerminalLiveTransportOptions,
): SemanticTerminalLiveTransportBundle => {
  const listeners = new Map<string, Set<(event: TerminalDataEvent) => void>>();
  const deletionListeners = new Map<string, Set<() => void>>();
  const geometryListeners = new Map<string, Set<(event: TerminalGeometryEvent) => void>>();
  const presentationListeners = new Map<string, Set<(presentation: unknown) => void>>();
  const lifecycleListeners = new Map<string, Set<(event: TerminalLiveAttachmentLifecycleEvent) => void>>();
  const entries = new Map<string, LiveEntry>();
  const activeGenerations = new Map<string, number>();
  let connectionEpochKey: object | null | undefined;
  let nextGeneration = 0;
  let disposed = false;

  const emit = (sessionId: string, event: TerminalDataEvent) => {
    for (const listener of listeners.get(sessionId) ?? []) listener(event);
  };

  const emitDeleted = (sessionId: string) => {
    for (const listener of deletionListeners.get(sessionId) ?? []) listener();
  };

  const emitGeometry = (sessionId: string, geometry: Readonly<{
    generation: number;
    outputSequenceBoundary: number;
    cols: number;
    rows: number;
  }>) => {
    const event: TerminalGeometryEvent = { sessionId, ...geometry };
    for (const listener of geometryListeners.get(sessionId) ?? []) listener(event);
  };
  const emitPresentation = (sessionId: string, presentation: unknown) => {
    for (const listener of presentationListeners.get(sessionId) ?? []) listener(presentation);
  };

  const emitLifecycle = (event: TerminalLiveAttachmentLifecycleEvent): void => {
    for (const listener of lifecycleListeners.get(event.sessionId) ?? []) listener(event);
  };

  const isCurrentGeneration = (sessionId: string, generation: number): boolean => (
    !disposed && activeGenerations.get(sessionId) === generation
  );

  const closeEntry = (sessionId: string, reason: TerminalLiveAttachmentCloseReason): void => {
    const generation = activeGenerations.get(sessionId);
    if (generation === undefined) return;
    activeGenerations.delete(sessionId);
    const entry = entries.get(sessionId);
    if (entry?.generation === generation) {
      entries.delete(sessionId);
      void entry.connection.close();
    }
    emitLifecycle({ sessionId, runtimeAttachGeneration: generation, state: 'closed', reason });
  };

  const attachWithHistoryBoundary = async (sessionId: string, cols: number, rows: number): Promise<TerminalLiveAttachResult> => {
    if (disposed) throw new Error('terminal live transport is disposed');
    closeEntry(sessionId, 'superseded');
    nextGeneration += 1;
    const generation = nextGeneration;
    activeGenerations.set(sessionId, generation);
    const connection = await connectTerminalLive({
      openStream: options.openStream,
      attach: {
        sessionId,
        connectionId: options.connectionId,
        attachGeneration: generation,
        cols,
        rows,
      },
      onOutputBatch: (records, geometry) => {
        if (!isCurrentGeneration(sessionId, generation)) return;
        for (const record of records) {
          const sequence = Number(record.sequence);
          const timestampMs = Number(record.timestampMs);
          if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(timestampMs)) {
            const error = new Error('terminal live output metadata exceeds JavaScript safe integer range');
            options.onError?.(sessionId, error);
            emit(sessionId, { sessionId, type: 'error', data: new Uint8Array(), error: error.message });
            return;
          }
          emit(sessionId, {
            sessionId,
            type: 'data',
            data: record.data,
            sequence,
            timestampMs,
            liveBatchSize: records.length,
            geometryGeneration: geometry.generation,
            cols: geometry.cols,
            rows: geometry.rows,
          });
        }
      },
      onPresentation: presentation => {
        if (!isCurrentGeneration(sessionId, generation)) return;
        emitPresentation(sessionId, presentation);
      },
      onGeometry: geometry => {
        if (!isCurrentGeneration(sessionId, generation)) return;
        emitGeometry(sessionId, geometry);
      },
      onClosed: reason => {
        if (!isCurrentGeneration(sessionId, generation)) return;
        activeGenerations.delete(sessionId);
        if (entries.get(sessionId)?.generation === generation) entries.delete(sessionId);
        emitLifecycle({ sessionId, runtimeAttachGeneration: generation, state: 'closed', reason });
        if (reason === 'session_closed') {
          emitDeleted(sessionId);
          return;
        }
        emit(sessionId, {
          sessionId,
          type: 'error',
          data: new Uint8Array(),
          error: 'terminal live stream closed',
        });
      },
      onError: error => {
        if (!isCurrentGeneration(sessionId, generation)) return;
        options.onError?.(sessionId, error);
        activeGenerations.delete(sessionId);
        if (entries.get(sessionId)?.generation === generation) entries.delete(sessionId);
        emitLifecycle({ sessionId, runtimeAttachGeneration: generation, state: 'closed', reason: 'error' });
        emit(sessionId, { sessionId, type: 'error', data: new Uint8Array(), error: error.message });
      },
    });
    if (!isCurrentGeneration(sessionId, generation)) {
      await connection.close();
      const error = new Error('terminal live attach was superseded');
      error.name = 'AbortError';
      throw error;
    }
    entries.set(sessionId, { generation, connection });
    emitLifecycle({ sessionId, runtimeAttachGeneration: generation, state: 'attached' });
    return {
      ...connection.attached,
      runtimeAttachGeneration: generation,
    };
  };

  const resizeWithEffectiveGeometry = async (
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<TerminalLiveResizeAppliedResult> => {
    const entry = entries.get(sessionId);
    if (!entry || !isCurrentGeneration(sessionId, entry.generation)) {
      throw new Error('terminal live session is not attached');
    }
    const result = await entry.connection.resizeWithEffectiveGeometry(cols, rows);
    if (!isCurrentGeneration(sessionId, entry.generation)) {
      const error = new Error('terminal live resize was superseded');
      error.name = 'AbortError';
      throw error;
    }
    return { ...result, runtimeAttachGeneration: entry.generation };
  };

  const transport: SemanticTerminalLiveTransport = {
    attach: async (sessionId, cols, rows) => {
      await attachWithHistoryBoundary(sessionId, cols, rows);
    },
    attachWithHistoryBoundary,
    resize: async (sessionId, cols, rows) => {
      await resizeWithEffectiveGeometry(sessionId, cols, rows);
    },
    resizeWithEffectiveGeometry,
    sendInput: async (sessionId, input) => {
      const entry = entries.get(sessionId);
      if (!entry) throw new Error('terminal live session is not attached');
      await entry.connection.sendInput(textEncoder.encode(String(input ?? '')));
    },
    clear: options.control.clear,
    semanticHistory: async (sessionId, request) => {
      const entry = entries.get(sessionId);
      if (!entry || !isCurrentGeneration(sessionId, entry.generation)) {
        throw new Error('terminal live session is not attached');
      }
      const page = await options.control.semanticHistory(
        sessionId, options.connectionId, entry.generation, request,
      );
      if (!isCurrentGeneration(sessionId, entry.generation)) {
        const error = new Error('terminal semantic history request was superseded');
        error.name = 'AbortError';
        throw error;
      }
      return page;
    },
    listSessions: options.control.listSessions,
    createSession: options.control.createSession,
    deleteSession: options.control.deleteSession ? async sessionId => {
      await options.control.deleteSession!(sessionId);
      closeEntry(sessionId, 'session_deleted');
      emitDeleted(sessionId);
    } : undefined,
    renameSession: options.control.renameSession,
    forgetSession: sessionId => closeEntry(sessionId, 'detached'),
    syncConnectionEpoch: key => {
      if (connectionEpochKey === undefined) {
        connectionEpochKey = key;
        return;
      }
      if (connectionEpochKey === key) return;
      connectionEpochKey = key;
      for (const sessionId of Array.from(activeGenerations.keys())) closeEntry(sessionId, 'connection_epoch_changed');
    },
    dispose: () => {
      if (disposed) return;
      for (const sessionId of Array.from(activeGenerations.keys())) closeEntry(sessionId, 'disposed');
      disposed = true;
      listeners.clear();
      deletionListeners.clear();
      geometryListeners.clear();
      presentationListeners.clear();
      lifecycleListeners.clear();
    },
  };

  const eventSource: TerminalLiveEventSource = {
    onTerminalData: (sessionId, handler) => {
      const set = listeners.get(sessionId) ?? new Set();
      set.add(handler);
      listeners.set(sessionId, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) listeners.delete(sessionId);
      };
    },
    onTerminalNameUpdate: options.controlEvents?.onTerminalNameUpdate
      ? (sessionId: TerminalID, handler: (event: TerminalNameUpdateEvent) => void) => (
        options.controlEvents!.onTerminalNameUpdate!(sessionId, handler)
      )
      : undefined,
    onTerminalForegroundCommandUpdate: options.controlEvents?.onTerminalForegroundCommandUpdate
      ? (sessionId: TerminalID, handler: (event: TerminalForegroundCommandUpdateEvent) => void) => (
        options.controlEvents!.onTerminalForegroundCommandUpdate!(sessionId, handler)
      )
      : undefined,
    onTerminalOutputActivityUpdate: options.controlEvents?.onTerminalOutputActivityUpdate
      ? (sessionId: TerminalID, handler: (event: TerminalOutputActivityUpdateEvent) => void) => (
        options.controlEvents!.onTerminalOutputActivityUpdate!(sessionId, handler)
      )
      : undefined,
    onTerminalExecutionContextUpdate: options.controlEvents?.onTerminalExecutionContextUpdate
      ? (sessionId: TerminalID, handler: (event: TerminalExecutionContextUpdateEvent) => void) => (
        options.controlEvents!.onTerminalExecutionContextUpdate!(sessionId, handler)
      )
      : undefined,
    onTerminalWorkStateUpdate: options.controlEvents?.onTerminalWorkStateUpdate
      ? (sessionId: TerminalID, handler: (event: TerminalWorkStateUpdateEvent) => void) => (
        options.controlEvents!.onTerminalWorkStateUpdate!(sessionId, handler)
      )
      : undefined,
    onTerminalGeometry: (sessionId, handler) => {
      const set = geometryListeners.get(sessionId) ?? new Set();
      set.add(handler);
      geometryListeners.set(sessionId, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) geometryListeners.delete(sessionId);
      };
    },
    onTerminalPresentation: (sessionId, handler) => {
      const set = presentationListeners.get(sessionId) ?? new Set();
      set.add(handler); presentationListeners.set(sessionId, set);
      return () => { set.delete(handler); if (set.size === 0) presentationListeners.delete(sessionId); };
    },
    onTerminalLiveAttachmentLifecycle: (sessionId, handler) => {
      const set = lifecycleListeners.get(sessionId) ?? new Set();
      set.add(handler);
      lifecycleListeners.set(sessionId, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) lifecycleListeners.delete(sessionId);
      };
    },
    onSessionDeleted: (sessionId, handler) => {
      const set = deletionListeners.get(sessionId) ?? new Set();
      set.add(handler);
      deletionListeners.set(sessionId, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) deletionListeners.delete(sessionId);
      };
    },
  };

  return { transport, eventSource };
};

export const createTerminalLiveTransport = (
  options: CreateTerminalLiveTransportOptions,
): TerminalLiveTransportBundle => {
  const semantic = createSemanticTerminalLiveTransport(options);
  const transport: TerminalLiveTransport = Object.assign(semantic.transport, {
    history: options.control.history,
    historyPage: options.control.historyPage,
    commitHistoryCheckpoint: options.control.commitHistoryCheckpoint,
  });
  return { transport, eventSource: semantic.eventSource };
};

export type OpenTerminalLiveStream = (
  kind: typeof StreamKind,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<TerminalByteStream>;
