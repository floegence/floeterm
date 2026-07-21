import type {
  TerminalAtomicAttachResult,
  TerminalAtomicTransport,
  TerminalDataChunk,
  TerminalDataEvent,
  TerminalEventSource,
  TerminalID,
  TerminalForegroundCommandUpdateEvent,
  TerminalOutputActivityUpdateEvent,
  TerminalNameUpdateEvent,
  TerminalSessionInfo,
  TerminalHistoryPage,
  TerminalGeometryEvent,
} from '../types.js';
import {
  connectTerminalLive,
  type ConnectTerminalLiveOptions,
  type TerminalByteStream,
  type TerminalLiveConnection,
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
  listSessions?(): Promise<TerminalSessionInfo[]>;
  createSession?(name?: string, workingDir?: string, cols?: number, rows?: number): Promise<TerminalSessionInfo>;
  deleteSession?(sessionId: TerminalID): Promise<void>;
  renameSession?(sessionId: TerminalID, newName: string): Promise<void>;
}>;

export type TerminalLiveAttachResult = TerminalAtomicAttachResult & Readonly<{
  runtimeAttachGeneration: number;
}>;

export type TerminalLiveTransport = Omit<TerminalAtomicTransport, 'attachWithHistoryBoundary'> & Readonly<{
  attachWithHistoryBoundary(sessionId: TerminalID, cols: number, rows: number): Promise<TerminalLiveAttachResult>;
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

export type TerminalLiveTransportBundle = Readonly<{
  transport: TerminalLiveTransport;
  eventSource: TerminalEventSource;
}>;

type LiveEntry = {
  generation: number;
  connection: TerminalLiveConnection;
};

const textEncoder = new TextEncoder();

export const createTerminalLiveTransport = (options: CreateTerminalLiveTransportOptions): TerminalLiveTransportBundle => {
  const listeners = new Map<string, Set<(event: TerminalDataEvent) => void>>();
  const deletionListeners = new Map<string, Set<() => void>>();
  const geometryListeners = new Map<string, Set<(event: TerminalGeometryEvent) => void>>();
  const entries = new Map<string, LiveEntry>();
  const attachEpochs = new Map<string, number>();
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

  const closeEntry = (sessionId: string): void => {
    const entry = entries.get(sessionId);
    if (!entry) return;
    entries.delete(sessionId);
    void entry.connection.close();
  };

  const attachWithHistoryBoundary = async (sessionId: string, cols: number, rows: number): Promise<TerminalLiveAttachResult> => {
    if (disposed) throw new Error('terminal live transport is disposed');
    const epoch = (attachEpochs.get(sessionId) ?? 0) + 1;
    attachEpochs.set(sessionId, epoch);
    closeEntry(sessionId);
    nextGeneration += 1;
    const generation = nextGeneration;
    const connection = await connectTerminalLive({
      openStream: options.openStream,
      attach: {
        sessionId,
        connectionId: options.connectionId,
        attachGeneration: generation,
        cols,
        rows,
      },
      onOutputBatch: records => {
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
          });
        }
      },
      onGeometry: geometry => emitGeometry(sessionId, geometry),
      onClosed: reason => {
        const current = entries.get(sessionId);
        if (!current || current.generation !== generation) return;
        entries.delete(sessionId);
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
        options.onError?.(sessionId, error);
        const current = entries.get(sessionId);
        if (current?.generation === generation) entries.delete(sessionId);
        emit(sessionId, { sessionId, type: 'error', data: new Uint8Array(), error: error.message });
      },
    });
    if (disposed || attachEpochs.get(sessionId) !== epoch) {
      await connection.close();
      const error = new Error('terminal live attach was superseded');
      error.name = 'AbortError';
      throw error;
    }
    entries.set(sessionId, { generation, connection });
    return {
      ...connection.attached,
      runtimeAttachGeneration: generation,
    };
  };

  const transport: TerminalLiveTransport = {
    attach: async (sessionId, cols, rows) => {
      await attachWithHistoryBoundary(sessionId, cols, rows);
    },
    attachWithHistoryBoundary,
    resize: async (sessionId, cols, rows) => {
      const entry = entries.get(sessionId);
      if (!entry) throw new Error('terminal live session is not attached');
      await entry.connection.resize(cols, rows);
    },
    sendInput: async (sessionId, input) => {
      const entry = entries.get(sessionId);
      if (!entry) throw new Error('terminal live session is not attached');
      await entry.connection.sendInput(textEncoder.encode(String(input ?? '')));
    },
    history: options.control.history,
    historyPage: options.control.historyPage,
    clear: options.control.clear,
    listSessions: options.control.listSessions,
    createSession: options.control.createSession,
    deleteSession: options.control.deleteSession ? async sessionId => {
      await options.control.deleteSession!(sessionId);
      closeEntry(sessionId);
      emitDeleted(sessionId);
    } : undefined,
    renameSession: options.control.renameSession,
    forgetSession: closeEntry,
    syncConnectionEpoch: key => {
      if (connectionEpochKey === undefined) {
        connectionEpochKey = key;
        return;
      }
      if (connectionEpochKey === key) return;
      connectionEpochKey = key;
      for (const sessionId of Array.from(entries.keys())) closeEntry(sessionId);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const sessionId of Array.from(entries.keys())) closeEntry(sessionId);
      listeners.clear();
      deletionListeners.clear();
      geometryListeners.clear();
    },
  };

  const eventSource: TerminalEventSource = {
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
    onTerminalGeometry: (sessionId, handler) => {
      const set = geometryListeners.get(sessionId) ?? new Set();
      set.add(handler);
      geometryListeners.set(sessionId, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) geometryListeners.delete(sessionId);
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

export type OpenTerminalLiveStream = (
  kind: typeof StreamKind,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<TerminalByteStream>;
