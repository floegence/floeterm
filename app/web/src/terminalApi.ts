import type {
  TerminalDataChunk,
  TerminalHistoryPage,
  TerminalID,
  TerminalSessionInfo,
} from '@floegence/floeterm-terminal-web';
import {
  StreamKind,
  createTerminalLiveTransport,
  type TerminalLiveTransport,
} from '@floegence/floeterm-terminal-web/live';
import { openBrowserWebSocketByteStream } from './terminalWebSocket';

type ApiSessionInfo = TerminalSessionInfo;

type ApiSessionStats = {
  history: {
    totalBytes: number;
  };
};

type ApiHistoryChunk = {
  sequence: number;
  data: string;
  timestampMs: number;
};

type ApiHistoryPage = Omit<TerminalHistoryPage, 'chunks'> & {
  chunks: ApiHistoryChunk[];
};

const decodeBase64 = (input: string): Uint8Array => {
  const binary = atob(input);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

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

export type AppTerminalTransport = TerminalLiveTransport & {
  listSessions: NonNullable<TerminalLiveTransport['listSessions']>;
  createSession: NonNullable<TerminalLiveTransport['createSession']>;
  deleteSession: NonNullable<TerminalLiveTransport['deleteSession']>;
  renameSession: NonNullable<TerminalLiveTransport['renameSession']>;
  getSessionStats: (sessionId: TerminalID) => Promise<ApiSessionStats>;
};

export const createTerminalRuntime = (connId: string) => {
  const historyPage = async (
    sessionId: TerminalID,
    startSequence: number,
    endSequence: number,
    historyGeneration: number,
  ): Promise<TerminalHistoryPage> => {
    const query = new URLSearchParams({
      startSeq: String(startSequence),
      endSeq: String(endSequence),
      historyGeneration: String(historyGeneration),
      maxBytes: String(512 * 1024),
    });
    const page = await requestJson<ApiHistoryPage>(
      `/api/sessions/${encodeURIComponent(sessionId)}/history?${query.toString()}`,
      { method: 'GET' },
    );
    return {
      ...page,
      chunks: page.chunks.map(chunk => ({
        sequence: chunk.sequence,
        timestampMs: chunk.timestampMs,
        data: decodeBase64(chunk.data),
      })),
    };
  };

  const history = async (sessionId: TerminalID, startSeq: number, endSeq: number): Promise<TerminalDataChunk[]> => {
    const chunks: TerminalDataChunk[] = [];
    let cursor = startSeq;
    let generation = 0;
    while (endSeq <= 0 || cursor <= endSeq) {
      const page = await historyPage(sessionId, cursor, endSeq, generation);
      if (page.historyReset) {
        generation = page.historyGeneration;
        cursor = page.firstRetainedSequence || endSeq + 1;
        chunks.length = 0;
        continue;
      }
      generation = page.historyGeneration;
      chunks.push(...page.chunks);
      if (!page.hasMore) break;
      cursor = page.nextStartSequence;
    }
    return chunks;
  };

  const bundle = createTerminalLiveTransport({
    connectionId: connId,
    openStream: async kind => {
      if (kind !== StreamKind) throw new Error(`unsupported terminal stream kind: ${kind}`);
      const url = new URL('/ws', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return await openBrowserWebSocketByteStream(url.toString());
    },
    control: {
      history,
      historyPage,
      clear: async sessionId => {
        await requestNoContent(`/api/sessions/${encodeURIComponent(sessionId)}/clear`, { method: 'POST' });
      },
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
    getSessionStats: async (sessionId: TerminalID) => await requestJson<ApiSessionStats>(
      `/api/sessions/${encodeURIComponent(sessionId)}/stats`,
      { method: 'GET' },
    ),
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
