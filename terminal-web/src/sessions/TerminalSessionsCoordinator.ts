import type { Logger, TerminalSessionInfo, TerminalTransport } from '../types';
import { noopLogger } from '../utils/logger';

export type TerminalSessionsCoordinatorOptions = {
  transport: TerminalTransport;
  // When > 0 and listSessions is supported, periodically reconcile sessions via listSessions().
  // This is a best-effort mechanism to keep UI tabs in sync with server-side session lifecycle
  // (e.g. sessions auto-removed when the PTY process exits).
  pollMs?: number;
  logger?: Logger;
};

type sessions_listener = (sessions: TerminalSessionInfo[]) => void;

const normalizeSessions = (list: TerminalSessionInfo[]): TerminalSessionInfo[] => {
  const byId = new Map<string, TerminalSessionInfo>();
  for (const raw of list) {
    const id = String(raw?.id ?? '').trim();
    if (!id) continue;
    byId.set(id, { ...raw, id });
  }

  return [...byId.values()].sort((a, b) => {
    const t = (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0);
    if (t !== 0) return t;
    return a.id.localeCompare(b.id);
  });
};

const sessionsEqual = (a: TerminalSessionInfo[], b: TerminalSessionInfo[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const sa = a[i];
    const sb = b[i];
    // Shallow compare the fields we rely on for UI: id + commonly displayed metadata.
    if (sa.id !== sb.id) return false;
    if ((sa.name ?? '') !== (sb.name ?? '')) return false;
    if ((sa.workingDir ?? '') !== (sb.workingDir ?? '')) return false;
    if ((sa.createdAtMs ?? 0) !== (sb.createdAtMs ?? 0)) return false;
    if ((sa.lastActiveAtMs ?? 0) !== (sb.lastActiveAtMs ?? 0)) return false;
    if (Boolean(sa.isActive) !== Boolean(sb.isActive)) return false;
  }
  return true;
};

export class TerminalSessionsCoordinator {
  private transport: TerminalTransport;
  private pollMs: number;
  private logger: Logger;

  private sessions: TerminalSessionInfo[] = [];
  private listeners = new Set<sessions_listener>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private refreshSeq = 0;
  private lastAppliedRefreshSeq = 0;

  private pendingDeletions = new Set<string>();
  private disposed = false;

  constructor(opts: TerminalSessionsCoordinatorOptions) {
    this.transport = opts.transport;
    this.pollMs = typeof opts.pollMs === 'number' && opts.pollMs > 0 ? opts.pollMs : 10_000;
    this.logger = opts.logger ?? noopLogger;
  }

  getSnapshot(): TerminalSessionInfo[] {
    // Protect internal state from accidental external mutations.
    return [...this.sessions];
  }

  subscribe(listener: sessions_listener): () => void {
    this.listeners.add(listener);

    // Emit current snapshot immediately so subscribers can render synchronously.
    try {
      listener(this.getSnapshot());
    } catch (error) {
      this.logger.warn('[TerminalSessionsCoordinator] listener threw on subscribe', { error });
    }

    if (this.listeners.size === 1) {
      this.ensurePolling();
      // Best-effort initial reconcile.
      void this.refresh().catch(() => undefined);
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stopPolling();
      }
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPolling();
    this.listeners.clear();
    this.sessions = [];
    this.pendingDeletions.clear();
  }

  private emit(next: TerminalSessionInfo[]): void {
    for (const listener of this.listeners) {
      try {
        listener([...next]);
      } catch (error) {
        this.logger.warn('[TerminalSessionsCoordinator] listener threw', { error });
      }
    }
  }

  private setSessions(next: TerminalSessionInfo[]): void {
    if (this.disposed) return;
    if (sessionsEqual(this.sessions, next)) return;
    this.sessions = next;
    this.emit(next);
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    if (this.pollMs <= 0) return;
    if (!this.transport.listSessions) return;
    if (this.disposed) return;
    if (this.listeners.size === 0) return;

    this.pollTimer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, this.pollMs);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async refresh(): Promise<void> {
    return this.runRefresh(false);
  }

  private runRefresh(force: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.transport.listSessions) {
      return Promise.reject(new Error('Terminal transport does not support listSessions()'));
    }

    if (!force && this.refreshInFlight) {
      return this.refreshInFlight;
    }

    const seq = ++this.refreshSeq;
    const promise = (async () => {
      const list = await this.transport.listSessions?.();
      if (this.disposed) return;
      if (seq < this.lastAppliedRefreshSeq) return;

      const normalized = normalizeSessions(Array.isArray(list) ? list : []);
      const filtered = this.pendingDeletions.size > 0
        ? normalized.filter((s) => !this.pendingDeletions.has(s.id))
        : normalized;

      this.setSessions(filtered);
      this.lastAppliedRefreshSeq = seq;
    })();

    let inFlight: Promise<void>;
    inFlight = promise.finally(() => {
      if (this.refreshInFlight === inFlight) {
        this.refreshInFlight = null;
      }
    });

    this.refreshInFlight = inFlight;
    return inFlight;
  }

  async createSession(
    name?: string,
    workingDir?: string,
    cols?: number,
    rows?: number
  ): Promise<TerminalSessionInfo> {
    if (!this.transport.createSession) {
      throw new Error('Terminal transport does not support createSession()');
    }

    const session = await this.transport.createSession(name, workingDir, cols, rows);
    const id = String(session?.id ?? '').trim();
    if (!id) {
      throw new Error('Invalid createSession response: missing id');
    }

    const merged = normalizeSessions([...this.sessions, { ...session, id }]);
    const filtered = this.pendingDeletions.size > 0
      ? merged.filter((s) => !this.pendingDeletions.has(s.id))
      : merged;
    this.setSessions(filtered);

    return { ...session, id };
  }

  updateSessionMeta(
    sessionId: string,
    patch: {
      name?: string;
      workingDir?: string;
      lastActiveAtMs?: number;
      isActive?: boolean;
    }
  ): void {
    const id = String(sessionId ?? '').trim();
    if (!id) return;
    if (this.pendingDeletions.has(id)) return;
    if (this.sessions.length === 0) return;

    const next = this.sessions.map((s) => {
      if (s.id !== id) return s;

      const name = typeof patch?.name === 'string' && patch.name.trim() ? patch.name : s.name;
      const workingDir = typeof patch?.workingDir === 'string' && patch.workingDir.trim() ? patch.workingDir : s.workingDir;
      const lastActiveAtMs = typeof patch?.lastActiveAtMs === 'number' && patch.lastActiveAtMs > 0
        ? patch.lastActiveAtMs
        : s.lastActiveAtMs;
      const isActive = typeof patch?.isActive === 'boolean' ? patch.isActive : s.isActive;

      return {
        ...s,
        name,
        workingDir,
        lastActiveAtMs,
        isActive,
      };
    });

    this.setSessions(next);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.transport.deleteSession) {
      throw new Error('Terminal transport does not support deleteSession()');
    }

    const id = String(sessionId ?? '').trim();
    if (!id) return;

    this.pendingDeletions.add(id);
    this.setSessions(this.sessions.filter((s) => s.id !== id));

    try {
      await this.transport.deleteSession(id);
      this.pendingDeletions.delete(id);

      // Best-effort reconcile to reflect any server-side changes (ordering, active flags, etc.).
      void this.refresh().catch(() => undefined);
    } catch (error) {
      // Remove the pending marker first so refresh can re-include the session if it still exists.
      this.pendingDeletions.delete(id);

      try {
        await this.runRefresh(true);
      } catch (refreshError) {
        this.logger.debug('[TerminalSessionsCoordinator] refresh failed after delete error', { refreshError });
      }

      throw error;
    }
  }
}
