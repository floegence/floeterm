import type {
  Logger, TerminalExecutionContextInfo, TerminalForegroundCommandInfo, TerminalOutputActivityInfo,
  TerminalSessionInfo, TerminalTransport, TerminalWorkStateInfo,
} from '../types.js';
import { noopLogger } from '../utils/logger.js';
import { normalizeTerminalForegroundCommandDisplayName } from './TerminalForegroundCommandMetadata.js';
import { normalizeTerminalRemoteAuthority, normalizeTerminalRemotePath } from './TerminalExecutionContextMetadata.js';

export type TerminalSessionsCoordinatorOptions = {
  transport: TerminalTransport;
  // When > 0 and listSessions is supported, periodically reconcile sessions via listSessions().
  // This is a best-effort mechanism to keep UI tabs in sync with server-side session lifecycle
  // (e.g. sessions auto-removed when the PTY process exits).
  pollMs?: number;
  logger?: Logger;
};

type sessions_listener = (sessions: TerminalSessionInfo[]) => void;

type refresh_in_flight = {
  mutationRevision: number;
  promise: Promise<void>;
};

const normalizeForegroundCommand = (
  value: TerminalSessionInfo['foregroundCommand'],
): TerminalForegroundCommandInfo => {
  return validateForegroundCommandUpdate(value) ?? {
    phase: 'unknown',
    displayName: '',
    revision: 0,
    updatedAtMs: 0,
  };
};

const validateForegroundCommandUpdate = (value: unknown): TerminalForegroundCommandInfo | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const phase = candidate.phase;
  const displayName = candidate.displayName;
  const revision = candidate.revision;
  const updatedAtMs = candidate.updatedAtMs;
  if (phase !== 'unknown' && phase !== 'idle' && phase !== 'running') return null;
  if (typeof displayName !== 'string') return null;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) return null;
  if (!Number.isSafeInteger(updatedAtMs) || Number(updatedAtMs) < 0) return null;
  const normalizedDisplayName = normalizeTerminalForegroundCommandDisplayName(displayName);
  if (displayName && normalizedDisplayName !== displayName) return null;
  if (phase !== 'running' && displayName !== '') return null;
  return {
    phase,
    displayName: phase === 'running' ? normalizedDisplayName : '',
    revision: Number(revision),
    updatedAtMs: Number(updatedAtMs),
  };
};

const normalizeOutputActivity = (
  value: TerminalSessionInfo['outputActivity'],
): TerminalOutputActivityInfo => validateOutputActivityUpdate(value) ?? {
  phase: 'unknown',
  revision: 0,
  updatedAtMs: 0,
};

const validateOutputActivityUpdate = (value: unknown): TerminalOutputActivityInfo | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const phase = candidate.phase;
  const revision = candidate.revision;
  const updatedAtMs = candidate.updatedAtMs;
  if (phase !== 'unknown' && phase !== 'streaming' && phase !== 'settled') return null;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) return null;
  if (!Number.isSafeInteger(updatedAtMs) || Number(updatedAtMs) < 0) return null;
  return { phase, revision: Number(revision), updatedAtMs: Number(updatedAtMs) };
};

const unknownExecutionContext = (): TerminalExecutionContextInfo => ({
  location: { kind: 'unknown', phase: 'unknown', label: '', authority: '', workingDirectory: '', source: 'unknown' },
  application: { kind: 'unknown', identity: '', displayName: '' },
  revision: 0,
  updatedAtMs: 0,
});

// An equal revision with different context payloads is not a safe local-path authority.
// Keep the revision fence while the authoritative list refresh resolves the contradiction.
const conflictedExecutionContext = (
  context: TerminalExecutionContextInfo,
): TerminalExecutionContextInfo => ({
  ...unknownExecutionContext(),
  revision: context.revision,
  updatedAtMs: context.updatedAtMs,
});

const validRemoteLocationLabel = (label: string, authority: string): boolean => {
  if (!label || label === authority) return true;
  if (!authority || !label.endsWith(`@${authority}`)) return false;
  const user = label.slice(0, -(authority.length + 1));
  return /^[A-Za-z0-9._-]{1,64}$/.test(user);
};

const validRemoteOpeningTitle = (label: string): boolean => {
  if (!label) return false;
  const separator = label.indexOf('@');
  const user = separator >= 0 ? label.slice(0, separator) : '';
  const authority = separator >= 0 ? label.slice(separator + 1) : label;
  if (separator >= 0 && (!/^[A-Za-z0-9._-]{1,64}$/.test(user) || authority.includes('@'))) return false;
  return normalizeTerminalRemoteAuthority(authority) === authority;
};

const validSSHOpeningCandidateLabel = (label: string): boolean => {
  if (!label || new TextEncoder().encode(label).byteLength > 128) return false;
  const separator = label.indexOf('@');
  const user = separator >= 0 ? label.slice(0, separator) : '';
  const host = separator >= 0 ? label.slice(separator + 1) : label;
  if (separator >= 0 && (!/^[A-Za-z0-9._-]{1,64}$/.test(user) || host.includes('@'))) return false;
  if (/^\[[0-9a-f:]+\]$/.test(host)) {
    try {
      const parsed = new URL(`http://${host}/`);
      return !parsed.port && parsed.hostname === host && !/^\[::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}\]$/.test(host);
    } catch {
      return false;
    }
  }
  if (host.includes(':') || host !== host.toLowerCase() || host.endsWith('.') || host.length > 128) return false;
  if (/^[0-9.]+$/.test(host) && host.includes('.')) {
    const parts = host.split('.');
    return parts.length === 4 && parts.every(part => /^\d+$/.test(part)
      && String(Number(part)) === part && Number(part) >= 0 && Number(part) <= 255);
  }
  return host.split('.').every(part => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(part));
};

export const normalizeTerminalExecutionContextInfo = (
  value: TerminalSessionInfo['executionContext'],
): TerminalExecutionContextInfo => validateExecutionContextUpdate(value) ?? unknownExecutionContext();
const normalizeExecutionContext = normalizeTerminalExecutionContextInfo;

const validateExecutionContextUpdate = (value: unknown): TerminalExecutionContextInfo | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const location = candidate.location as Record<string, unknown> | undefined;
  const application = candidate.application as Record<string, unknown> | undefined;
  if (!location || !application) return null;
  if (!['unknown', 'local', 'remote'].includes(String(location.kind))) return null;
  if (!['unknown', 'opening', 'ready'].includes(String(location.phase))) return null;
  if (!['unknown', 'shell_integration', 'osc7', 'osc_title', 'foreground_candidate'].includes(String(location.source))) return null;
  if (!['unknown', 'shell', 'agent_cli', 'interactive_app'].includes(String(application.kind))) return null;
  for (const field of ['label', 'authority', 'workingDirectory'] as const) {
    if (typeof location[field] !== 'string') return null;
    if (/\p{Cc}|\p{Cf}/u.test(location[field] as string)) return null;
  }
  for (const field of ['identity', 'displayName'] as const) {
    if (typeof application[field] !== 'string') return null;
    if (/\p{Cc}|\p{Cf}/u.test(application[field] as string)) return null;
  }
  if (!Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 0) return null;
  if (!Number.isSafeInteger(candidate.updatedAtMs) || Number(candidate.updatedAtMs) < 0) return null;
  if (new TextEncoder().encode(String(location.label)).byteLength > 128) return null;
  const locationKind = String(location.kind);
  const locationPhase = String(location.phase);
  const authority = String(location.authority);
  const label = String(location.label);
  const workingDirectory = String(location.workingDirectory);
  const applicationKind = String(application.kind);
  const identity = String(application.identity);
  const displayName = String(application.displayName);
  const locationSource = String(location.source);
  if (locationKind === 'unknown' && (
    locationPhase !== 'unknown' || locationSource !== 'unknown' || label || authority || workingDirectory
  )) return null;
  if (locationKind === 'local' && (
    locationPhase !== 'ready' || locationSource !== 'shell_integration' || label || authority
  )) return null;
  if (locationKind === 'remote') {
    if (locationPhase === 'opening') {
      if (authority) return null;
      if (locationSource === 'foreground_candidate') {
        if ((label !== 'SSH' && !validSSHOpeningCandidateLabel(label)) || workingDirectory) return null;
      } else if (locationSource === 'shell_integration') {
        if ((!workingDirectory || normalizeTerminalRemotePath(workingDirectory) !== workingDirectory)
          || (label !== 'SSH' && !validRemoteOpeningTitle(label))) return null;
      } else if (locationSource === 'osc_title') {
        if (!validRemoteOpeningTitle(label)) return null;
      } else {
        return null;
      }
    } else if (locationPhase === 'ready') {
      if (!['shell_integration', 'osc7', 'osc_title'].includes(locationSource)
        || !authority || normalizeTerminalRemoteAuthority(authority) !== authority
        || !validRemoteLocationLabel(label, authority)) return null;
    } else {
      return null;
    }
  }
  if (workingDirectory && normalizeTerminalRemotePath(workingDirectory) !== workingDirectory) return null;
  if (applicationKind === 'unknown' && (identity || displayName)) return null;
  if (applicationKind === 'shell' && (identity || displayName)) return null;
  if (applicationKind === 'agent_cli' && AGENT_CONTEXT_DISPLAY_NAMES.get(identity) !== displayName) return null;
  if (applicationKind !== 'agent_cli' && identity) return null;
  if (new TextEncoder().encode(displayName).byteLength > 128) return null;
  return {
    location: {
      kind: location.kind as TerminalExecutionContextInfo['location']['kind'],
      phase: location.phase as TerminalExecutionContextInfo['location']['phase'],
      label: String(location.label), authority: String(location.authority),
      workingDirectory: String(location.workingDirectory),
      source: location.source as TerminalExecutionContextInfo['location']['source'],
    },
    application: {
      kind: application.kind as TerminalExecutionContextInfo['application']['kind'],
      identity: String(application.identity), displayName: String(application.displayName),
    },
    revision: Number(candidate.revision), updatedAtMs: Number(candidate.updatedAtMs),
  };
};

const AGENT_CONTEXT_DISPLAY_NAMES = new Map<string, string>([
  ['codex', 'Codex'], ['claude', 'Claude Code'], ['opencode', 'OpenCode'], ['kimi', 'Kimi'],
  ['gemini', 'Gemini'], ['qwen', 'Qwen'], ['copilot', 'Copilot'], ['cline', 'Cline'],
  ['roo', 'Roo'], ['vibe', 'Vibe'], ['cursor', 'Cursor'], ['junie', 'Junie'],
  ['kiro', 'Kiro'], ['openhands', 'OpenHands'], ['trae', 'Trae'], ['kilo', 'Kilo Code'],
]);


const unknownWorkState = (): TerminalWorkStateInfo => ({
  phase: 'unknown', source: '', contextRevision: 0, foregroundCommandRevision: 0,
  revision: 0, updatedAtMs: 0,
});

export const normalizeTerminalWorkStateInfo = (value: TerminalSessionInfo['workState']): TerminalWorkStateInfo => (
  validateWorkStateUpdate(value) ?? unknownWorkState()
);
const normalizeWorkState = normalizeTerminalWorkStateInfo;

const validateWorkStateUpdate = (value: unknown): TerminalWorkStateInfo | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (!['unknown', 'idle', 'working', 'waiting_user'].includes(String(candidate.phase))) return null;
  if (candidate.source !== '' && candidate.source !== 'semantic') return null;
  for (const field of ['contextRevision', 'foregroundCommandRevision', 'revision', 'updatedAtMs'] as const) {
    if (!Number.isSafeInteger(candidate[field]) || Number(candidate[field]) < 0) return null;
  }
  if (candidate.phase === 'unknown' && (candidate.source !== '' || candidate.contextRevision !== 0 || candidate.foregroundCommandRevision !== 0)) return null;
  if (candidate.phase !== 'unknown' && candidate.source !== 'semantic') return null;
  return {
    phase: candidate.phase as TerminalWorkStateInfo['phase'], source: candidate.source as TerminalWorkStateInfo['source'],
    contextRevision: Number(candidate.contextRevision), foregroundCommandRevision: Number(candidate.foregroundCommandRevision),
    revision: Number(candidate.revision), updatedAtMs: Number(candidate.updatedAtMs),
  };
};

const projectWorkState = (
  work: TerminalWorkStateInfo,
  context: TerminalExecutionContextInfo,
  command: TerminalForegroundCommandInfo,
): TerminalWorkStateInfo => {
  if (work.phase === 'unknown' || (
    work.contextRevision === context.revision
    && work.foregroundCommandRevision === command.revision
  )) return work;
  return { ...work, phase: 'unknown', source: '', contextRevision: 0, foregroundCommandRevision: 0 };
};

const workMatchesFences = (
  work: TerminalWorkStateInfo,
  context: TerminalExecutionContextInfo,
  command: TerminalForegroundCommandInfo,
): boolean => work.phase === 'unknown' || (
  work.contextRevision === context.revision
  && work.foregroundCommandRevision === command.revision
);

const normalizeSession = (raw: TerminalSessionInfo): TerminalSessionInfo => {
  const foregroundCommand = normalizeForegroundCommand(raw?.foregroundCommand);
  const executionContext = normalizeExecutionContext(raw?.executionContext);
  const candidateWork = normalizeWorkState(raw?.workState);
  const workState = workMatchesFences(candidateWork, executionContext, foregroundCommand)
    ? candidateWork : unknownWorkState();
  return {
    ...raw,
    id: String(raw?.id ?? '').trim(),
    foregroundCommand,
    outputActivity: normalizeOutputActivity(raw?.outputActivity),
    executionContext,
    workState,
  };
};

const normalizeSessions = (list: TerminalSessionInfo[]): TerminalSessionInfo[] => {
  const byId = new Map<string, TerminalSessionInfo>();
  for (const raw of list) {
    const id = String(raw?.id ?? '').trim();
    if (!id) continue;
    byId.set(id, normalizeSession({ ...raw, id }));
  }

  return [...byId.values()].sort((a, b) => {
    const t = (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0);
    if (t !== 0) return t;
    return a.id.localeCompare(b.id);
  });
};

const preferCurrentSessionMetadata = (
  current: TerminalSessionInfo | undefined,
  incoming: TerminalSessionInfo,
  authoritative = false,
): TerminalSessionInfo => {
  if (!current) return incoming;
  const currentCommand = normalizeForegroundCommand(current.foregroundCommand);
  const incomingCommand = normalizeForegroundCommand(incoming.foregroundCommand);
  const currentOutput = normalizeOutputActivity(current.outputActivity);
  const incomingOutput = normalizeOutputActivity(incoming.outputActivity);
  const currentContext = normalizeExecutionContext(current.executionContext);
  const incomingContext = normalizeExecutionContext(incoming.executionContext);
  const currentWork = normalizeWorkState(current.workState);
  const incomingWork = normalizeWorkState(incoming.workState);
  const foregroundCommand = incomingCommand.revision <= currentCommand.revision ? currentCommand : incomingCommand;
  const conflictingContext = incomingContext.revision === currentContext.revision
    && JSON.stringify(incomingContext) !== JSON.stringify(currentContext);
  const executionContext = conflictingContext && !authoritative
    ? conflictedExecutionContext(currentContext)
    : incomingContext.revision > currentContext.revision
      || (authoritative && incomingContext.revision === currentContext.revision)
      ? incomingContext
      : currentContext;
  const currentWorkForFences = projectWorkState(currentWork, executionContext, foregroundCommand);
  const incomingWorkMatches = workMatchesFences(incomingWork, executionContext, foregroundCommand);
  const selectedWork = incomingWorkMatches && incomingWork.revision > currentWorkForFences.revision
    ? incomingWork : currentWorkForFences;
  return {
    ...incoming,
    foregroundCommand,
    outputActivity: incomingOutput.revision <= currentOutput.revision
      ? currentOutput
      : incomingOutput,
    executionContext,
    workState: selectedWork,
  };
};

const mergeCurrentSessionMetadata = (
  current: TerminalSessionInfo[],
  incoming: TerminalSessionInfo[],
): TerminalSessionInfo[] => {
  const currentById = new Map(current.map(session => [session.id, session]));
  return incoming.map(session => preferCurrentSessionMetadata(currentById.get(session.id), session, true));
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
    const ca = normalizeForegroundCommand(sa.foregroundCommand);
    const cb = normalizeForegroundCommand(sb.foregroundCommand);
    if (ca.phase !== cb.phase) return false;
    if (ca.displayName !== cb.displayName) return false;
    if (ca.revision !== cb.revision) return false;
    if (ca.updatedAtMs !== cb.updatedAtMs) return false;
    const oa = normalizeOutputActivity(sa.outputActivity);
    const ob = normalizeOutputActivity(sb.outputActivity);
    if (oa.phase !== ob.phase) return false;
    if (oa.revision !== ob.revision) return false;
    if (oa.updatedAtMs !== ob.updatedAtMs) return false;
    const xa = normalizeExecutionContext(sa.executionContext);
    const xb = normalizeExecutionContext(sb.executionContext);
    if (JSON.stringify(xa) !== JSON.stringify(xb)) return false;
    const wa = normalizeWorkState(sa.workState);
    const wb = normalizeWorkState(sb.workState);
    if (JSON.stringify(wa) !== JSON.stringify(wb)) return false;
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
  private refreshInFlight: refresh_in_flight | null = null;
  private refreshSeq = 0;
  private lastAppliedRefreshSeq = 0;
  private lastAppliedMutationRevision = -1;
  private mutationRevision = 0;

  private pendingDeletions = new Set<string>();
  private disposed = false;
  private metadataConflictKeys = new Set<string>();
  private metadataReconcileQueued = false;
  private metadataConflictOverflowLogged = false;

  constructor(opts: TerminalSessionsCoordinatorOptions) {
    this.transport = opts.transport;
    this.pollMs = opts.pollMs === 0
      ? 0
      : typeof opts.pollMs === 'number' && opts.pollMs > 0
        ? opts.pollMs
        : 10_000;
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
    this.metadataConflictKeys.clear();
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

  private setSessions(next: TerminalSessionInfo[]): boolean {
    if (this.disposed) return false;
    if (sessionsEqual(this.sessions, next)) return false;
    this.sessions = next;
    this.emit(next);
    return true;
  }

  private reportEqualRevisionConflicts(current: TerminalSessionInfo | undefined, incoming: TerminalSessionInfo): void {
    if (!current) return;
    const currentCommand = normalizeForegroundCommand(current.foregroundCommand);
    const incomingCommand = normalizeForegroundCommand(incoming.foregroundCommand);
    const foregroundCommand = incomingCommand.revision > currentCommand.revision ? incomingCommand : currentCommand;
    const currentContext = normalizeExecutionContext(current.executionContext);
    const incomingContext = normalizeExecutionContext(incoming.executionContext);
    const executionContext = incomingContext.revision > currentContext.revision ? incomingContext : currentContext;
    const currentWork = projectWorkState(normalizeWorkState(current.workState), executionContext, foregroundCommand);
    const candidateIncomingWork = normalizeWorkState(incoming.workState);
    const incomingWork = workMatchesFences(candidateIncomingWork, executionContext, foregroundCommand)
      ? candidateIncomingWork : currentWork;
    const dimensions = [
      ['foreground', currentCommand, incomingCommand],
      ['output', normalizeOutputActivity(current.outputActivity), normalizeOutputActivity(incoming.outputActivity)],
      ['context', currentContext, incomingContext],
      ['work', currentWork, incomingWork],
    ] as const;
    for (const [kind, left, right] of dimensions) {
      if (left.revision !== right.revision || JSON.stringify(left) === JSON.stringify(right)) continue;
      const key = `${incoming.id}:${kind}:${left.revision}`;
      if (this.metadataConflictKeys.has(key)) continue;
      if (this.metadataConflictKeys.size >= 64) {
        if (!this.metadataConflictOverflowLogged) {
          this.metadataConflictOverflowLogged = true;
          this.logger.warn('[TerminalSessionsCoordinator] metadata conflict reconciliation limit reached', {
            code: 'terminal_metadata_conflict_limit_reached',
          });
        }
        continue;
      }
      this.metadataConflictKeys.add(key);
      this.logger.warn('[TerminalSessionsCoordinator] metadata revision conflict', {
        code: 'terminal_metadata_equal_revision_conflict', kind,
      });
      this.scheduleMetadataReconcile();
    }
  }

  private scheduleMetadataReconcile(): void {
    if (this.metadataReconcileQueued || !this.transport.listSessions || this.disposed) return;
    this.metadataReconcileQueued = true;
    queueMicrotask(async () => {
      try {
        if (this.refreshInFlight) await this.refreshInFlight.promise.catch(() => undefined);
        if (!this.disposed) await this.runRefresh(false);
      } catch {
        // The normal polling path may retry; conflicts never create a refresh loop.
      } finally {
        this.metadataReconcileQueued = false;
        this.metadataConflictKeys.clear();
        this.metadataConflictOverflowLogged = false;
      }
    });
  }

  private applyLocalSessions(next: TerminalSessionInfo[]): boolean {
    if (this.disposed) return false;
    if (sessionsEqual(this.sessions, next)) return false;
    this.mutationRevision += 1;
    return this.setSessions(next);
  }

  private markLocalMutation(): void {
    if (this.disposed) return;
    this.mutationRevision += 1;
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

  refresh(): Promise<void> {
    return this.runRefresh(false);
  }

  private runRefresh(force: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.transport.listSessions) {
      return Promise.reject(new Error('Terminal transport does not support listSessions()'));
    }

    const mutationRevision = this.mutationRevision;
    if (
      !force
      && this.refreshInFlight
      && this.refreshInFlight.mutationRevision === mutationRevision
    ) {
      return this.refreshInFlight.promise;
    }

    const seq = ++this.refreshSeq;
    const promise = (async () => {
      const list = await this.transport.listSessions?.();
      if (this.disposed) return;
      if (mutationRevision !== this.mutationRevision) {
        if (this.lastAppliedMutationRevision !== this.mutationRevision) {
          await this.runRefresh(false);
        }
        return;
      }
      if (seq < this.lastAppliedRefreshSeq) return;

      const normalized = normalizeSessions(Array.isArray(list) ? list : []);
      const filtered = this.pendingDeletions.size > 0
        ? normalized.filter((s) => !this.pendingDeletions.has(s.id))
        : normalized;

      const currentByID = new Map(this.sessions.map(session => [session.id, session]));
      for (const session of filtered) this.reportEqualRevisionConflicts(currentByID.get(session.id), session);

      this.setSessions(mergeCurrentSessionMetadata(this.sessions, filtered));
      this.lastAppliedRefreshSeq = seq;
      this.lastAppliedMutationRevision = mutationRevision;
    })();

    let inFlight: refresh_in_flight;
    const trackedPromise = promise.finally(() => {
      if (this.refreshInFlight === inFlight) {
        this.refreshInFlight = null;
      }
    });
    inFlight = { mutationRevision, promise: trackedPromise };

    this.refreshInFlight = inFlight;
    return inFlight.promise;
  }

  upsertSession(session: TerminalSessionInfo): TerminalSessionInfo {
    const id = String(session?.id ?? '').trim();
    if (!id) {
      throw new Error('Invalid terminal session: missing id');
    }

    const normalized = normalizeSession({ ...session, id });
    if (this.disposed) return normalized;

    const existing = this.sessions.find((item) => item.id === id);
    this.reportEqualRevisionConflicts(existing, normalized);
    const accepted = preferCurrentSessionMetadata(existing, normalized);

    const merged = normalizeSessions([...this.sessions, accepted]);
    const filtered = this.pendingDeletions.size > 0
      ? merged.filter((item) => !this.pendingDeletions.has(item.id))
      : merged;
    this.applyLocalSessions(filtered);
    return accepted;
  }

  removeSession(sessionId: string): boolean {
    const id = String(sessionId ?? '').trim();
    if (!id || this.disposed) return false;

    const existed = this.sessions.some((session) => session.id === id);
    this.applyLocalSessions(this.sessions.filter((session) => session.id !== id));
    return existed;
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

    return this.upsertSession({ ...session, id });
  }

  updateSessionMeta(
    sessionId: string,
    patch: {
      name?: string;
      workingDir?: string;
      lastActiveAtMs?: number;
      isActive?: boolean;
      foregroundCommand?: TerminalForegroundCommandInfo;
      outputActivity?: TerminalOutputActivityInfo;
      executionContext?: TerminalExecutionContextInfo;
      workState?: TerminalWorkStateInfo;
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
      const currentCommand = normalizeForegroundCommand(s.foregroundCommand);
      const incomingCommand = patch?.foregroundCommand
        ? validateForegroundCommandUpdate(patch.foregroundCommand)
        : null;
      if (incomingCommand && incomingCommand.revision === currentCommand.revision
        && JSON.stringify(incomingCommand) !== JSON.stringify(currentCommand)) {
        this.reportEqualRevisionConflicts(s, { ...s, foregroundCommand: incomingCommand });
      }
      const foregroundCommand = incomingCommand && incomingCommand.revision > currentCommand.revision
        ? incomingCommand
        : currentCommand;
      const currentOutput = normalizeOutputActivity(s.outputActivity);
      const incomingOutput = patch?.outputActivity
        ? validateOutputActivityUpdate(patch.outputActivity)
        : null;
      if (incomingOutput && incomingOutput.revision === currentOutput.revision
        && JSON.stringify(incomingOutput) !== JSON.stringify(currentOutput)) {
        this.reportEqualRevisionConflicts(s, { ...s, outputActivity: incomingOutput });
      }
      const outputActivity = incomingOutput && incomingOutput.revision > currentOutput.revision
        ? incomingOutput
        : currentOutput;
      const currentContext = normalizeExecutionContext(s.executionContext);
      const incomingContext = patch?.executionContext ? validateExecutionContextUpdate(patch.executionContext) : null;
      const conflictingContext = Boolean(incomingContext
        && incomingContext.revision === currentContext.revision
        && JSON.stringify(incomingContext) !== JSON.stringify(currentContext));
      if (conflictingContext && incomingContext) {
        this.reportEqualRevisionConflicts(s, { ...s, executionContext: incomingContext });
      }
      const executionContext = conflictingContext
        ? conflictedExecutionContext(currentContext)
        : incomingContext && incomingContext.revision > currentContext.revision
          ? incomingContext
          : currentContext;
      const currentWork = normalizeWorkState(s.workState);
      const incomingWork = patch?.workState ? validateWorkStateUpdate(patch.workState) : null;
      const currentWorkForFences = projectWorkState(currentWork, executionContext, foregroundCommand);
      const incomingWorkMatches = incomingWork
        ? workMatchesFences(incomingWork, executionContext, foregroundCommand) : false;
      if (incomingWork && incomingWorkMatches && incomingWork.revision === currentWorkForFences.revision
        && JSON.stringify(incomingWork) !== JSON.stringify(currentWorkForFences)) {
        this.reportEqualRevisionConflicts(
          { ...s, executionContext, foregroundCommand, workState: currentWorkForFences },
          { ...s, executionContext, foregroundCommand, workState: incomingWork },
        );
      }
      const workState = incomingWork && incomingWorkMatches && incomingWork.revision > currentWorkForFences.revision
        ? incomingWork : currentWorkForFences;

      return {
        ...s,
        name,
        workingDir,
        lastActiveAtMs,
        isActive,
        foregroundCommand,
        outputActivity,
        executionContext,
        workState,
      };
    });

    this.applyLocalSessions(next);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.transport.deleteSession) {
      throw new Error('Terminal transport does not support deleteSession()');
    }

    const id = String(sessionId ?? '').trim();
    if (!id) return;

    if (!this.pendingDeletions.has(id)) {
      this.pendingDeletions.add(id);
      this.markLocalMutation();
    }
    this.applyLocalSessions(this.sessions.filter((s) => s.id !== id));

    try {
      await this.transport.deleteSession(id);
      this.pendingDeletions.delete(id);
      this.markLocalMutation();

      // Best-effort reconcile to reflect any server-side changes (ordering, active flags, etc.).
      void this.refresh().catch(() => undefined);
    } catch (error) {
      // Remove the pending marker first so refresh can re-include the session if it still exists.
      this.pendingDeletions.delete(id);
      this.markLocalMutation();

      try {
        await this.runRefresh(true);
      } catch (refreshError) {
        this.logger.debug('[TerminalSessionsCoordinator] refresh failed after delete error', { refreshError });
      }

      throw error;
    }
  }
}
