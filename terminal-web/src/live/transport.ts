import {
  assembleHistoryViewport,
  type SemanticHistoryChunk,
  type SemanticHistoryChunkRequest,
  type SemanticHistoryRequest,
  type SemanticHistoryViewport,
  validateHistoryChunk,
} from '../semantic/presentation.js';
import type { TerminalKeyInputIntent } from '../core/TerminalInputBridge.js';
import type {
  TerminalExecutionContextUpdateEvent,
  TerminalForegroundCommandUpdateEvent,
  TerminalGeometryEvent,
  TerminalID,
  TerminalNameUpdateEvent,
  TerminalOutputActivityUpdateEvent,
  TerminalSessionInfo,
  TerminalWorkStateUpdateEvent,
} from '../types.js';
import {
  connectTerminalLive,
  type ConnectTerminalLiveOptions,
  type TerminalByteStream,
  type TerminalLiveConnection,
  type TerminalLiveActivationResult,
  type TerminalLiveResizeResult,
} from './client.js';
import { StreamKind } from './codec.js';

export type SemanticTerminalLiveControlPlane = Readonly<{
  semanticHistory(
    sessionId: TerminalID,
    connectionId: string,
    transportGeneration: number,
    request: SemanticHistoryChunkRequest,
  ): Promise<SemanticHistoryChunk>;
  clearSemanticContent?(
    sessionId: TerminalID,
    connectionId: string,
    transportGeneration: number,
  ): Promise<TerminalSemanticClearResult>;
  listSessions?(): Promise<TerminalSessionInfo[]>;
  createSession?(name?: string, workingDir?: string, cols?: number, rows?: number): Promise<TerminalSessionInfo>;
  deleteSession?(sessionId: TerminalID): Promise<void>;
  renameSession?(sessionId: TerminalID, newName: string): Promise<void>;
}>;

export type TerminalSemanticClearResult = Readonly<{
  presentationSequence: number;
  contentEpoch: number;
}>;

export type TerminalLiveAttachResult = Readonly<{
  presentationSequence: number;
  geometryGeneration: number;
  cols: number;
  rows: number;
  runtimeAttachGeneration: number;
  controllerEpoch: number;
  isController: boolean;
}>;

export type TerminalLiveResizeAppliedResult = TerminalLiveResizeResult & Readonly<{
  runtimeAttachGeneration: number;
}>;

export type TerminalLiveActivationAppliedResult = TerminalLiveActivationResult & Readonly<{
  runtimeAttachGeneration: number;
}>;

export type TerminalControllerEvent = Readonly<{
  sessionId: TerminalID;
  epoch: number;
  isController: boolean;
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

export type SemanticTerminalLiveEventSource = Readonly<{
  onTerminalPresentation(sessionId: TerminalID, handler: (presentation: unknown) => void): () => void;
  onTerminalGeometry(sessionId: TerminalID, handler: (event: TerminalGeometryEvent) => void): () => void;
  onTerminalController(sessionId: TerminalID, handler: (event: TerminalControllerEvent) => void): () => void;
  onTerminalLiveAttachmentLifecycle(
    sessionId: TerminalID,
    handler: (event: TerminalLiveAttachmentLifecycleEvent) => void,
  ): () => void;
  onSessionDeleted(sessionId: TerminalID, handler: () => void): () => void;
  onTerminalNameUpdate?(
    sessionId: TerminalID,
    handler: (event: TerminalNameUpdateEvent) => void,
  ): () => void;
  onTerminalForegroundCommandUpdate?(
    sessionId: TerminalID,
    handler: (event: TerminalForegroundCommandUpdateEvent) => void,
  ): () => void;
  onTerminalOutputActivityUpdate?(
    sessionId: TerminalID,
    handler: (event: TerminalOutputActivityUpdateEvent) => void,
  ): () => void;
  onTerminalExecutionContextUpdate?(
    sessionId: TerminalID,
    handler: (event: TerminalExecutionContextUpdateEvent) => void,
  ): () => void;
  onTerminalWorkStateUpdate?(
    sessionId: TerminalID,
    handler: (event: TerminalWorkStateUpdateEvent) => void,
  ): () => void;
}>;

export type SemanticTerminalLiveTransport = Readonly<{
  attach(sessionId: TerminalID, cols: number, rows: number): Promise<void>;
  attachWithPresentation(sessionId: TerminalID, cols: number, rows: number): Promise<TerminalLiveAttachResult>;
  resize(sessionId: TerminalID, cols: number, rows: number): Promise<void>;
  resizeWithEffectiveGeometry(
    sessionId: TerminalID,
    cols: number,
    rows: number,
  ): Promise<TerminalLiveResizeAppliedResult>;
  activate(sessionId: TerminalID, cols: number, rows: number): Promise<TerminalLiveActivationAppliedResult>;
  sendInput(sessionId: TerminalID, input: string): Promise<void>;
  sendInputIntent(sessionId: TerminalID, input: TerminalKeyInputIntent): Promise<void>;
  semanticHistory(sessionId: TerminalID, request: SemanticHistoryRequest): Promise<SemanticHistoryViewport>;
  clearSemanticContent?(sessionId: TerminalID): Promise<TerminalSemanticClearResult>;
  listSessions?(): Promise<TerminalSessionInfo[]>;
  createSession?(name?: string, workingDir?: string, cols?: number, rows?: number): Promise<TerminalSessionInfo>;
  deleteSession?(sessionId: TerminalID): Promise<void>;
  renameSession?(sessionId: TerminalID, newName: string): Promise<void>;
  forgetSession(sessionId: string): void;
  syncConnectionEpoch(key: object | null): void;
  dispose(): void;
}>;

type MetadataEventSource = Pick<SemanticTerminalLiveEventSource,
  | 'onTerminalNameUpdate'
  | 'onTerminalForegroundCommandUpdate'
  | 'onTerminalOutputActivityUpdate'
  | 'onTerminalExecutionContextUpdate'
  | 'onTerminalWorkStateUpdate'>;

export type CreateSemanticTerminalLiveTransportOptions = Readonly<{
  connectionId: string;
  openStream: ConnectTerminalLiveOptions['openStream'];
  control: SemanticTerminalLiveControlPlane;
  controlEvents?: MetadataEventSource;
  onError?: (sessionId: string, error: Error) => void;
}>;

export type SemanticTerminalLiveTransportBundle = Readonly<{
  transport: SemanticTerminalLiveTransport;
  eventSource: SemanticTerminalLiveEventSource;
}>;

type LiveEntry = { generation: number; connection: TerminalLiveConnection };
const textEncoder = new TextEncoder();

export const createSemanticTerminalLiveTransport = (
  options: CreateSemanticTerminalLiveTransportOptions,
): SemanticTerminalLiveTransportBundle => {
  const deletionListeners = new Map<string, Set<() => void>>();
  const geometryListeners = new Map<string, Set<(event: TerminalGeometryEvent) => void>>();
  const controllerListeners = new Map<string, Set<(event: TerminalControllerEvent) => void>>();
  const presentationListeners = new Map<string, Set<(presentation: unknown) => void>>();
  const lifecycleListeners = new Map<string, Set<(event: TerminalLiveAttachmentLifecycleEvent) => void>>();
  const entries = new Map<string, LiveEntry>();
  const activeGenerations = new Map<string, number>();
  let connectionEpochKey: object | null | undefined;
  let nextGeneration = 0;
  let disposed = false;

  const emitDeleted = (sessionId: string): void => {
    for (const listener of deletionListeners.get(sessionId) ?? []) listener();
  };
  const emitGeometry = (sessionId: string, geometry: Omit<TerminalGeometryEvent, 'sessionId'>): void => {
    for (const listener of geometryListeners.get(sessionId) ?? []) listener({ sessionId, ...geometry });
  };
  const emitPresentation = (sessionId: string, presentation: unknown): void => {
    for (const listener of presentationListeners.get(sessionId) ?? []) listener(presentation);
  };
  const emitController = (sessionId: string, controller: Omit<TerminalControllerEvent, 'sessionId'>): void => {
    for (const listener of controllerListeners.get(sessionId) ?? []) listener({ sessionId, ...controller });
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

  const attachWithPresentation = async (
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<TerminalLiveAttachResult> => {
    if (disposed) throw new Error('terminal live transport is disposed');
    closeEntry(sessionId, 'superseded');
    const generation = ++nextGeneration;
    activeGenerations.set(sessionId, generation);
    const connection = await connectTerminalLive({
      openStream: options.openStream,
      attach: { sessionId, connectionId: options.connectionId, attachGeneration: generation, cols, rows },
      onPresentation: presentation => {
        if (isCurrentGeneration(sessionId, generation)) emitPresentation(sessionId, presentation);
      },
      onGeometry: geometry => {
        if (isCurrentGeneration(sessionId, generation)) emitGeometry(sessionId, geometry);
      },
      onController: controller => {
        if (isCurrentGeneration(sessionId, generation)) emitController(sessionId, controller);
      },
      onClosed: reason => {
        if (!isCurrentGeneration(sessionId, generation)) return;
        activeGenerations.delete(sessionId);
        if (entries.get(sessionId)?.generation === generation) entries.delete(sessionId);
        emitLifecycle({ sessionId, runtimeAttachGeneration: generation, state: 'closed', reason });
        if (reason === 'session_closed') emitDeleted(sessionId);
      },
      onError: error => {
        if (!isCurrentGeneration(sessionId, generation)) return;
        options.onError?.(sessionId, error);
        activeGenerations.delete(sessionId);
        if (entries.get(sessionId)?.generation === generation) entries.delete(sessionId);
        emitLifecycle({ sessionId, runtimeAttachGeneration: generation, state: 'closed', reason: 'error' });
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
    return { ...connection.attached, runtimeAttachGeneration: generation };
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

  const activate = async (
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<TerminalLiveActivationAppliedResult> => {
    const entry = entries.get(sessionId);
    if (!entry || !isCurrentGeneration(sessionId, entry.generation)) {
      throw new Error('terminal live session is not attached');
    }
    const result = await entry.connection.activateWithEffectiveGeometry(cols, rows);
    if (!isCurrentGeneration(sessionId, entry.generation)) {
      const error = new Error('terminal live activation was superseded');
      error.name = 'AbortError';
      throw error;
    }
    return { ...result, runtimeAttachGeneration: entry.generation };
  };

  const transport: SemanticTerminalLiveTransport = {
    attach: async (sessionId, cols, rows) => { await attachWithPresentation(sessionId, cols, rows); },
    attachWithPresentation,
    resize: async (sessionId, cols, rows) => { await resizeWithEffectiveGeometry(sessionId, cols, rows); },
    resizeWithEffectiveGeometry,
    activate,
    sendInput: async (sessionId, input) => {
      const entry = entries.get(sessionId);
      if (!entry || !isCurrentGeneration(sessionId, entry.generation)) throw new Error('terminal live session is not attached');
      await entry.connection.sendInput(textEncoder.encode(String(input ?? '')));
    },
    sendInputIntent: async (sessionId, input) => {
      const entry = entries.get(sessionId);
      if (!entry || !isCurrentGeneration(sessionId, entry.generation)) {
        throw new Error('terminal live session is not attached');
      }
      const modifiers = (input.modifiers.shift ? 1 : 0)
        | (input.modifiers.control ? 2 : 0)
        | (input.modifiers.alt ? 4 : 0)
        | (input.modifiers.super ? 8 : 0)
        | (input.modifiers.capsLock ? 16 : 0)
        | (input.modifiers.numLock ? 32 : 0);
      await entry.connection.sendInputIntent({
        code: input.code,
        text: input.text,
        action: input.action,
        modifiers,
      });
    },
    semanticHistory: async (sessionId, request) => {
      const entry = entries.get(sessionId);
      if (!entry || !isCurrentGeneration(sessionId, entry.generation)) {
        throw new Error('terminal live session is not attached');
      }
      const chunks: SemanticHistoryChunk[] = [];
      let chunkRequest: SemanticHistoryChunkRequest = request;
      for (;;) {
        const chunk = validateHistoryChunk(await options.control.semanticHistory(
          sessionId, options.connectionId, entry.generation, chunkRequest,
        ));
        if (!isCurrentGeneration(sessionId, entry.generation) || chunk.transportGeneration !== entry.generation) {
          const error = new Error('terminal semantic history request was superseded');
          error.name = 'AbortError';
          throw error;
        }
        chunks.push(chunk);
        if (!chunk.continuation) break;
        chunkRequest = { continuation: chunk.continuation };
      }
      return assembleHistoryViewport(chunks);
    },
    clearSemanticContent: options.control.clearSemanticContent ? async sessionId => {
      const entry = entries.get(sessionId);
      if (!entry || !isCurrentGeneration(sessionId, entry.generation)) {
        throw new Error('terminal live session is not attached');
      }
      const result = await options.control.clearSemanticContent!(
        sessionId, options.connectionId, entry.generation,
      );
      if (!isCurrentGeneration(sessionId, entry.generation)) {
        const error = new Error('terminal semantic clear request was superseded');
        error.name = 'AbortError';
        throw error;
      }
      if (!Number.isSafeInteger(result.presentationSequence) || result.presentationSequence <= 0
        || !Number.isSafeInteger(result.contentEpoch) || result.contentEpoch <= 0) {
        throw new Error('invalid terminal semantic clear settlement');
      }
      return result;
    } : undefined,
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
      } else if (connectionEpochKey !== key) {
        connectionEpochKey = key;
        for (const sessionId of [...activeGenerations.keys()]) closeEntry(sessionId, 'connection_epoch_changed');
      }
    },
    dispose: () => {
      if (disposed) return;
      for (const sessionId of [...activeGenerations.keys()]) closeEntry(sessionId, 'disposed');
      disposed = true;
      deletionListeners.clear();
      geometryListeners.clear();
      controllerListeners.clear();
      presentationListeners.clear();
      lifecycleListeners.clear();
    },
  };

  const eventSource: SemanticTerminalLiveEventSource = {
    onTerminalPresentation: (sessionId, handler) => subscribe(presentationListeners, sessionId, handler),
    onTerminalGeometry: (sessionId, handler) => subscribe(geometryListeners, sessionId, handler),
    onTerminalController: (sessionId, handler) => subscribe(controllerListeners, sessionId, handler),
    onTerminalLiveAttachmentLifecycle: (sessionId, handler) => subscribe(lifecycleListeners, sessionId, handler),
    onSessionDeleted: (sessionId, handler) => subscribe(deletionListeners, sessionId, handler),
    onTerminalNameUpdate: options.controlEvents?.onTerminalNameUpdate,
    onTerminalForegroundCommandUpdate: options.controlEvents?.onTerminalForegroundCommandUpdate,
    onTerminalOutputActivityUpdate: options.controlEvents?.onTerminalOutputActivityUpdate,
    onTerminalExecutionContextUpdate: options.controlEvents?.onTerminalExecutionContextUpdate,
    onTerminalWorkStateUpdate: options.controlEvents?.onTerminalWorkStateUpdate,
  };

  return { transport, eventSource };
};

const subscribe = <T>(
  listeners: Map<string, Set<(event: T) => void>>,
  sessionId: string,
  handler: (event: T) => void,
): (() => void) => {
  const set = listeners.get(sessionId) ?? new Set();
  set.add(handler);
  listeners.set(sessionId, set);
  return () => {
    set.delete(handler);
    if (set.size === 0) listeners.delete(sessionId);
  };
};

export type OpenTerminalLiveStream = (
  kind: typeof StreamKind,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<TerminalByteStream>;
