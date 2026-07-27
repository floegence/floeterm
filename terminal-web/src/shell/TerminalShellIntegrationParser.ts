import { normalizeTerminalForegroundCommandDisplayName } from '../sessions/TerminalForegroundCommandMetadata.js';
import {
  normalizeTerminalRemoteAuthority,
  normalizeTerminalRemotePath,
} from '../sessions/TerminalExecutionContextMetadata.js';

export type TerminalShellIntegrationEvent =
  | { kind: 'prompt-ready' }
  | { kind: 'command-start' }
  | { kind: 'command-executed' }
  | { kind: 'command-finished'; exitCode: number | null }
  | { kind: 'cwd-update'; workingDir: string }
  | { kind: 'program'; displayName: string }
  | { kind: 'context-marker'; marker: TerminalContextMarker }
  | { kind: 'work-marker'; marker: TerminalWorkMarker };

export type TerminalContextMarker = {
  action: 'push' | 'replace' | 'pop';
  frameId: string;
  location?: 'local' | 'remote';
  authority?: string;
  user?: string;
  cwd?: string;
  application?: 'shell' | 'agent_cli';
  identity?: string;
};

export type TerminalWorkMarker = {
  frameId: string;
  phase: 'idle' | 'working' | 'waiting_user';
};

export type TerminalShellIntegrationParserOptions = {
  localHostname?: string;
};

export type TerminalShellIntegrationParseResult = {
  displayData: Uint8Array;
  events: TerminalShellIntegrationEvent[];
  tokens?: TerminalShellIntegrationToken[];
};

export type TerminalShellIntegrationToken =
  | { kind: 'display'; data: Uint8Array }
  | { kind: 'event'; event: TerminalShellIntegrationEvent };

export type TerminalShellIntegrationOrderedParseResult =
  Omit<TerminalShellIntegrationParseResult, 'tokens'> & {
    tokens: TerminalShellIntegrationToken[];
  };

const ESC = 0x1b;
const OSC = 0x5d;
const BEL = 0x07;
const ST = 0x5c;
const MAX_PENDING_BYTES = 4096;
const MAX_METADATA_PAYLOAD_BYTES = 4092;
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const AGENT_IDENTITIES = new Set([
  'codex', 'claude', 'opencode', 'kimi', 'gemini', 'qwen', 'copilot', 'cline',
  'roo', 'vibe', 'cursor', 'junie', 'kiro', 'openhands', 'trae', 'kilo',
]);

type OscTerminator = { payloadEnd: number; nextIndex: number };
type ParsedPayload = { recognized: boolean; event: TerminalShellIntegrationEvent | null };

export class TerminalShellIntegrationParser {
  private pending = new Uint8Array(0);
  private readonly localHostname: string;

  constructor(options: TerminalShellIntegrationParserOptions = {}) {
    this.localHostname = options.localHostname?.toLowerCase().replace(/\.$/, '') ?? '';
  }

  parse(chunk: Uint8Array): TerminalShellIntegrationOrderedParseResult {
    if (this.pending.byteLength === 0 && !containsOscStart(chunk)) {
      if (chunk.byteLength > 0 && chunk[chunk.byteLength - 1] === ESC) {
        this.pending = chunk.subarray(chunk.byteLength - 1).slice();
        const displayData = chunk.subarray(0, chunk.byteLength - 1);
        return { displayData, events: [], tokens: displayData.byteLength > 0 ? [{ kind: 'display', data: displayData }] : [] };
      }
      return { displayData: chunk, events: [], tokens: chunk.byteLength > 0 ? [{ kind: 'display', data: chunk }] : [] };
    }
    const data = concatUint8Arrays(this.pending, chunk);
    const displaySegments: Uint8Array[] = [];
    const events: TerminalShellIntegrationEvent[] = [];
    const tokens: TerminalShellIntegrationToken[] = [];
    this.pending = new Uint8Array(0);

    let index = 0;
    while (index < data.length) {
      const start = findOscStart(data, index);
      if (start < 0) {
        if (data.byteLength > index && data[data.byteLength - 1] === ESC) {
          appendDisplaySegment(displaySegments, tokens, data.subarray(index, data.byteLength - 1));
          this.pending = data.subarray(data.byteLength - 1).slice();
        } else {
          appendDisplaySegment(displaySegments, tokens, data.subarray(index));
        }
        break;
      }
      appendDisplaySegment(displaySegments, tokens, data.subarray(index, start));
      if (data[start] === ESC && start + 1 < data.length && data[start + 1] === OSC) {
        const terminator = findOscTerminator(data, start + 2);
        if (!terminator) {
          const fragment = data.subarray(start);
          if (fragment.byteLength > MAX_PENDING_BYTES) {
            appendDisplaySegment(displaySegments, tokens, fragment);
          } else {
            this.pending = fragment.slice();
          }
          break;
        }

        const payload = data.subarray(start + 2, terminator.payloadEnd);
        const parsed = parseShellIntegrationPayload(payload, this.localHostname);
        if (parsed.recognized) {
          if (parsed.event) {
            events.push(parsed.event);
            tokens.push({ kind: 'event', event: parsed.event });
          }
        } else {
          appendDisplaySegment(displaySegments, tokens, data.subarray(start, terminator.nextIndex));
        }
        index = terminator.nextIndex;
        continue;
      }
    }

    return { displayData: concatSegments(displaySegments), events, tokens };
  }

  reset(): void {
    this.pending = new Uint8Array(0);
  }
}

function parseShellIntegrationPayload(payload: Uint8Array, localHostname: string): ParsedPayload {
  const oversized = payload.byteLength > MAX_METADATA_PAYLOAD_BYTES;
  if (oversized) {
    return isPrivateMetadataPayload(payload)
      ? { recognized: true, event: null }
      : { recognized: false, event: null };
  }
  let text: string;
  try {
    text = textDecoder.decode(payload);
  } catch {
    return isPrivateMetadataPayload(payload)
      ? { recognized: true, event: null }
      : { recognized: false, event: null };
  }
  const protocol = text.startsWith('633;') ? '633' : text.startsWith('133;') ? '133' : null;
  if (!protocol) return { recognized: false, event: null };
  const body = text.slice(4);

  if (body === 'A') return { recognized: true, event: { kind: 'prompt-ready' } };
  if (body === 'B') return { recognized: true, event: { kind: 'command-start' } };
  if (body === 'C') return { recognized: true, event: { kind: 'command-executed' } };
  if (body === 'D') return { recognized: true, event: { kind: 'command-finished', exitCode: null } };
  if (body.startsWith('D;')) {
    const exitCode = Number(body.slice(2).trim());
    return {
      recognized: true,
      event: { kind: 'command-finished', exitCode: Number.isFinite(exitCode) ? exitCode : null },
    };
  }
  if (protocol === '633' && body.startsWith('P;Cwd=')) {
    const workingDir = body.slice('P;Cwd='.length);
    return { recognized: true, event: workingDir ? { kind: 'cwd-update', workingDir } : null };
  }
  if (protocol === '633' && body.startsWith('P;FloetermProgram=')) {
    const displayName = normalizeTerminalForegroundCommandDisplayName(body.slice('P;FloetermProgram='.length));
    return { recognized: true, event: displayName ? { kind: 'program', displayName } : null };
  }
  if (protocol === '633' && body.startsWith('P;FloetermLifecycle=')) {
    // Lifecycle authentication is owned by terminal-go. The browser strips the
    // private marker but must never turn an unverified nonce into a state event.
    return { recognized: true, event: null };
  }
  if (protocol === '633' && body.startsWith('P;FloetermContext=')) {
    const marker = parseContextMarker(`633;${body}`, localHostname);
    return { recognized: true, event: marker ? { kind: 'context-marker', marker } : null };
  }
  if (protocol === '633' && body.startsWith('P;FloetermWork=')) {
    const marker = parseWorkMarker(`633;${body}`);
    return { recognized: true, event: marker ? { kind: 'work-marker', marker } : null };
  }
  return { recognized: false, event: null };
}

function parseContextMarker(payload: string, localHostname: string): TerminalContextMarker | null {
  const fields = parseMarkerFields(payload, '633;P;FloetermContext=v1', new Set([
    'action', 'frame_id', 'location', 'authority', 'user', 'cwd', 'application', 'identity',
  ]));
  if (!fields || !validFrameId(fields.frame_id)) return null;
  const action = fields.action;
  if (action !== 'push' && action !== 'replace' && action !== 'pop') return null;
  if (action === 'pop') {
    return Object.keys(fields).length === 2 ? { action, frameId: fields.frame_id } : null;
  }
  if (!fields.location && !fields.application) return null;
  const hasAuthority = 'authority' in fields;
  const hasUser = 'user' in fields;
  const hasCwd = 'cwd' in fields;
  const hasIdentity = 'identity' in fields;
  if (!fields.location && (hasAuthority || hasUser || hasCwd)) return null;
  if (fields.location && fields.location !== 'local' && fields.location !== 'remote') return null;
  const normalizedAuthority = hasAuthority ? normalizeTerminalRemoteAuthority(fields.authority, localHostname) : '';
  if (fields.location === 'remote' && (!hasAuthority || !normalizedAuthority)) return null;
  if (fields.location === 'remote' && hasUser && fields.user && !/^[A-Za-z0-9._-]{1,64}$/.test(fields.user)) return null;
  const normalizedCwd = hasCwd ? normalizeTerminalRemotePath(fields.cwd) : '';
  if (fields.location === 'remote' && hasCwd && !normalizedCwd) return null;
  if (fields.location === 'local' && (hasAuthority || hasUser || hasCwd)) return null;
  if (fields.application && fields.application !== 'shell' && fields.application !== 'agent_cli') return null;
  if (!fields.application && hasIdentity) return null;
  if (fields.application === 'agent_cli' && (!hasIdentity || !AGENT_IDENTITIES.has(fields.identity))) return null;
  if (fields.application === 'shell' && hasIdentity) return null;
  return {
    action,
    frameId: fields.frame_id,
    ...(fields.location ? { location: fields.location as 'local' | 'remote' } : {}),
    ...(normalizedAuthority ? { authority: normalizedAuthority } : {}),
    ...(fields.user ? { user: fields.user } : {}),
    ...(normalizedCwd ? { cwd: normalizedCwd } : {}),
    ...(fields.application ? { application: fields.application as 'shell' | 'agent_cli' } : {}),
    ...(fields.identity ? { identity: fields.identity } : {}),
  };
}

function parseWorkMarker(payload: string): TerminalWorkMarker | null {
  const fields = parseMarkerFields(payload, '633;P;FloetermWork=v1', new Set(['frame_id', 'phase']));
  if (!fields || Object.keys(fields).length !== 2 || !validFrameId(fields.frame_id)) return null;
  if (fields.phase !== 'idle' && fields.phase !== 'working' && fields.phase !== 'waiting_user') return null;
  return { frameId: fields.frame_id, phase: fields.phase };
}

function parseMarkerFields(payload: string, prefix: string, allowed: Set<string>): Record<string, string> | null {
  if (!payload.startsWith(`${prefix};`)) return null;
  const fields: Record<string, string> = {};
  for (const part of payload.slice(prefix.length + 1).split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const name = part.slice(0, separator);
    if (!/^[a-z_]+$/.test(name) || !allowed.has(name) || name in fields) return null;
    try {
      const value = decodeURIComponent(part.slice(separator + 1));
      if (/\p{Cc}|\p{Cf}/u.test(value)) return null;
      fields[name] = value;
    } catch {
      return null;
    }
  }
  return fields;
}

function validFrameId(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

function isPrivateMetadataPayload(payload: Uint8Array): boolean {
  return [
    '633;P;FloetermProgram=', '633;P;FloetermLifecycle=', '633;P;FloetermContext=',
    '633;P;FloetermWork=', '633;P;Cwd=',
  ].some(prefix => hasAsciiPrefix(payload, prefix));
}

function hasAsciiPrefix(payload: Uint8Array, prefix: string): boolean {
  if (payload.byteLength < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (payload[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

function findOscTerminator(data: Uint8Array, start: number): OscTerminator | null {
  for (let index = start; index < data.length; index += 1) {
    if (data[index] === BEL) return { payloadEnd: index, nextIndex: index + 1 };
    if (data[index] === ESC) {
      if (index + 1 >= data.length) return null;
      if (data[index + 1] === ST) return { payloadEnd: index, nextIndex: index + 2 };
    }
  }
  return null;
}

function containsOscStart(data: Uint8Array): boolean {
  return findOscStart(data, 0) >= 0;
}

function findOscStart(data: Uint8Array, start: number): number {
  let index = data.indexOf(ESC, start);
  while (index >= 0) {
    if (index + 1 < data.byteLength && data[index + 1] === OSC) return index;
    index = data.indexOf(ESC, index + 1);
  }
  return -1;
}

function concatUint8Arrays(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function appendDisplaySegment(
  displaySegments: Uint8Array[],
  tokens: TerminalShellIntegrationToken[],
  source: Uint8Array,
): void {
  if (source.byteLength === 0) return;
  displaySegments.push(source);
  tokens.push({ kind: 'display', data: source });
}

function concatSegments(segments: Uint8Array[]): Uint8Array {
  if (segments.length === 0) return new Uint8Array(0);
  if (segments.length === 1) return segments[0]!;
  const byteLength = segments.reduce((total, segment) => total + segment.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const segment of segments) {
    result.set(segment, offset);
    offset += segment.byteLength;
  }
  return result;
}
