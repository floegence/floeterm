import type {
  TerminalDataChunk,
  TerminalDataEvent,
  TerminalEventSource,
  TerminalID,
  TerminalSessionInfo,
  TerminalTransport
} from '@floegence/floeterm-terminal-web';

type ApiSessionInfo = TerminalSessionInfo;

type ApiSessionStats = {
  history: {
    totalBytes: number;
  };
};

type ApiHistoryChunk = {
  sequence: number;
  data: string; // base64
  timestampMs: number;
};

type WsEvent =
  | {
      type: 'data';
      sessionId: TerminalID;
      data: string; // base64
      sequence?: number;
      timestampMs?: number;
      echoOfInput?: boolean;
      originalSource?: string;
    }
  | {
      type: 'name';
      sessionId: TerminalID;
      newName: string;
      workingDir: string;
      timestampMs?: number;
    }
  | { type: 'error'; sessionId: TerminalID; error: string; timestampMs?: number };

const decodeBase64 = (input: string): Uint8Array => {
  const binary = atob(input);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
};

const requestJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {})
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Request failed: ${res.status}`);
  }

  return (await res.json()) as T;
};

const requestNoContent = async (path: string, init?: RequestInit): Promise<void> => {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {})
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Request failed: ${res.status}`);
  }
};

export type AppTerminalTransport = Omit<TerminalTransport, 'listSessions' | 'createSession' | 'deleteSession' | 'renameSession'> & {
  listSessions: NonNullable<TerminalTransport['listSessions']>;
  createSession: NonNullable<TerminalTransport['createSession']>;
  deleteSession: NonNullable<TerminalTransport['deleteSession']>;
  renameSession: NonNullable<TerminalTransport['renameSession']>;
  getSessionStats: (sessionId: TerminalID) => Promise<ApiSessionStats>;
};

export const createTransport = (connId: string): AppTerminalTransport => {
  return {
    attach: async (sessionId, cols, rows) => {
      await requestNoContent(`/api/sessions/${encodeURIComponent(sessionId)}/attach`, {
        method: 'POST',
        body: JSON.stringify({ connId, cols, rows })
      });
    },
    resize: async (sessionId, cols, rows) => {
      await requestNoContent(`/api/sessions/${encodeURIComponent(sessionId)}/resize`, {
        method: 'POST',
        body: JSON.stringify({ connId, cols, rows })
      });
    },
    sendInput: async (sessionId, input) => {
      await requestNoContent(`/api/sessions/${encodeURIComponent(sessionId)}/input`, {
        method: 'POST',
        body: JSON.stringify({ connId, input })
      });
    },
    history: async (sessionId, startSeq, endSeq) => {
      const qs = new URLSearchParams();
      qs.set('startSeq', String(startSeq));
      qs.set('endSeq', String(endSeq));

      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/history?${qs.toString()}`);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `History request failed: ${res.status}`);
      }

      const chunks = (await res.json()) as ApiHistoryChunk[];
      return chunks.map(
        (chunk): TerminalDataChunk => ({
          sequence: chunk.sequence,
          timestampMs: chunk.timestampMs,
          data: decodeBase64(chunk.data)
        })
      );
    },
    clear: async sessionId => {
      await requestNoContent(`/api/sessions/${encodeURIComponent(sessionId)}/clear`, { method: 'POST' });
    },
    listSessions: async () => {
      return await requestJson<ApiSessionInfo[]>(`/api/sessions`, { method: 'GET' });
    },
    createSession: async (name, workingDir, cols = 80, rows = 24) => {
      return await requestJson<ApiSessionInfo>(`/api/sessions`, {
        method: 'POST',
        body: JSON.stringify({ name, workingDir, cols, rows })
      });
    },
    deleteSession: async sessionId => {
      await requestNoContent(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    },
    renameSession: async (sessionId, newName) => {
      await requestNoContent(`/api/sessions/${encodeURIComponent(sessionId)}/rename`, {
        method: 'POST',
        body: JSON.stringify({ newName })
      });
    },
    getSessionStats: async sessionId => {
      return await requestJson<ApiSessionStats>(`/api/sessions/${encodeURIComponent(sessionId)}/stats`, { method: 'GET' });
    }
  };
};

export const createEventSource = (connId: string): TerminalEventSource => {
  return {
    onTerminalData: (sessionId, handler) => {
      const url = new URL('/ws', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('sessionId', sessionId);
      url.searchParams.set('connId', connId);

      const ws = new WebSocket(url);
      ws.onmessage = evt => {
        let parsed: WsEvent | null = null;
        try {
          parsed = JSON.parse(evt.data as string) as WsEvent;
        } catch {
          return;
        }

        if (!parsed || parsed.type !== 'data' || parsed.sessionId !== sessionId) {
          return;
        }

        const payload: TerminalDataEvent = {
          sessionId,
          data: decodeBase64(parsed.data),
          sequence: parsed.sequence,
          timestampMs: parsed.timestampMs,
          echoOfInput: parsed.echoOfInput,
          originalSource: parsed.originalSource
        };

        handler(payload);
      };

      return () => {
        ws.close();
      };
    }
  };
};

export const getOrCreateConnId = (): string => {
  const key = 'floeterm_conn_id';
  const existing = window.sessionStorage.getItem(key);
  if (existing) {
    return existing;
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  window.sessionStorage.setItem(key, id);
  return id;
};
