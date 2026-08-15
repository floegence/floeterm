import type {
  SemanticHistoryChunk,
  SemanticHistoryChunkRequest,
  SemanticHistoryRequest,
  SemanticPresentation,
} from '@floegence/floeterm-terminal-web/semantic';
import type { TerminalID, TerminalSessionInfo } from '@floegence/floeterm-terminal-web/sessions';
import { validateHistoryChunk, validatePresentation } from '@floegence/floeterm-terminal-web/semantic';
import {
  StreamKind,
  createSemanticTerminalLiveTransport,
  type SemanticTerminalLiveTransport,
  type TerminalSemanticClearResult,
} from '@floegence/floeterm-terminal-web/live';
import { openBrowserWebSocketByteStream } from './terminalWebSocket';

type ApiSessionInfo = TerminalSessionInfo;

const MIN_TERMINAL_COLS = 20;
const MIN_TERMINAL_ROWS = 5;
const MAX_TERMINAL_COLS = 500;
const MAX_TERMINAL_ROWS = 200;

export const normalizeTerminalDimensions = (cols: number, rows: number): { cols: number; rows: number } => {
  const normalizedCols = Math.floor(Number.isFinite(cols) ? cols : 80);
  const normalizedRows = Math.floor(Number.isFinite(rows) ? rows : 24);
  return {
    cols: Math.max(MIN_TERMINAL_COLS, Math.min(MAX_TERMINAL_COLS, normalizedCols)),
    rows: Math.max(MIN_TERMINAL_ROWS, Math.min(MAX_TERMINAL_ROWS, normalizedRows)),
  };
};

const requestJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return await response.json() as T;
};

const requestNoContent = async (path: string, init?: RequestInit): Promise<void> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Request failed: ${response.status}`);
  }
};

export type AppTerminalTransport = SemanticTerminalLiveTransport & {
  listSessions: NonNullable<SemanticTerminalLiveTransport['listSessions']>;
  createSession: NonNullable<SemanticTerminalLiveTransport['createSession']>;
  deleteSession: NonNullable<SemanticTerminalLiveTransport['deleteSession']>;
  renameSession: NonNullable<SemanticTerminalLiveTransport['renameSession']>;
  clearSemanticContent: NonNullable<SemanticTerminalLiveTransport['clearSemanticContent']>;
  getPresentation: (sessionId: TerminalID) => Promise<SemanticPresentation>;
};

export const createTerminalRuntime = (connId: string) => {
  const bundle = createSemanticTerminalLiveTransport({
    connectionId: connId,
    openStream: async kind => {
      if (kind !== StreamKind) throw new Error(`unsupported terminal stream kind: ${kind}`);
      const url = new URL('/ws', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return await openBrowserWebSocketByteStream(url.toString());
    },
    control: {
      semanticHistory: async (
        sessionId: TerminalID,
        connectionId: string,
        transportGeneration: number,
        request: SemanticHistoryChunkRequest,
      ): Promise<SemanticHistoryChunk> => validateHistoryChunk(await requestJson<unknown>(
        `/api/sessions/${encodeURIComponent(sessionId)}/semantic-history`,
        {
          method: 'POST',
          body: JSON.stringify({ connectionId, transportGeneration, ...request }),
        },
      )),
      clearSemanticContent: async (
        sessionId: TerminalID,
        connectionId: string,
        transportGeneration: number,
      ): Promise<TerminalSemanticClearResult> => await requestJson<TerminalSemanticClearResult>(
        `/api/sessions/${encodeURIComponent(sessionId)}/semantic-clear`,
        {
          method: 'POST',
          body: JSON.stringify({ connectionId, transportGeneration }),
        },
      ),
      listSessions: async () => await requestJson<ApiSessionInfo[]>('/api/sessions', { method: 'GET' }),
      createSession: async (name, workingDir) => await requestJson<ApiSessionInfo>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name, workingDir }),
      }),
      deleteSession: async sessionId => {
        await requestNoContent(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      },
      renameSession: async (sessionId, newName) => {
        await requestNoContent(`/api/sessions/${encodeURIComponent(sessionId)}/rename`, {
          method: 'POST',
          body: JSON.stringify({ newName }),
        });
      },
    },
  });

  const transport: AppTerminalTransport = Object.assign(bundle.transport, {
    listSessions: bundle.transport.listSessions!,
    createSession: bundle.transport.createSession!,
    deleteSession: bundle.transport.deleteSession!,
    renameSession: bundle.transport.renameSession!,
	clearSemanticContent: bundle.transport.clearSemanticContent!,
	getPresentation: async (sessionId: TerminalID) => validatePresentation(await requestJson<unknown>(
		`/api/sessions/${encodeURIComponent(sessionId)}/presentation`, { method: 'GET' },
	)),
  });
  return { transport, eventSource: bundle.eventSource };
};

export const getOrCreateConnId = (): string => {
  const key = 'floeterm_conn_id';
  const existing = window.sessionStorage.getItem(key);
  if (existing) return existing;

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes).map(value => value.toString(16).padStart(2, '0')).join('');
  window.sessionStorage.setItem(key, id);
  return id;
};
