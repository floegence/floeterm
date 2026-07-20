export type TerminalShellIntegrationEvent =
  | { kind: 'prompt-ready' }
  | { kind: 'command-start' }
  | { kind: 'command-executed' }
  | { kind: 'command-finished'; exitCode: number | null }
  | { kind: 'cwd-update'; workingDir: string }
  | { kind: 'program'; displayName: string };

export type TerminalShellIntegrationParseResult = {
  displayData: Uint8Array;
  events: TerminalShellIntegrationEvent[];
};

const ESC = 0x1b;
const OSC = 0x5d;
const BEL = 0x07;
const ST = 0x5c;
const MAX_PENDING_BYTES = 4096;
const MAX_METADATA_PAYLOAD_BYTES = 4092;
const MAX_PROGRAM_BYTES = 64;
const textDecoder = new TextDecoder();

type OscTerminator = { payloadEnd: number; nextIndex: number };
type ParsedPayload = { recognized: boolean; event: TerminalShellIntegrationEvent | null };

export class TerminalShellIntegrationParser {
  private pending = new Uint8Array(0);

  parse(chunk: Uint8Array): TerminalShellIntegrationParseResult {
    if (this.pending.byteLength === 0 && !containsOscStart(chunk)) {
      if (chunk.byteLength > 0 && chunk[chunk.byteLength - 1] === ESC) {
        this.pending = chunk.subarray(chunk.byteLength - 1).slice();
        return { displayData: chunk.subarray(0, chunk.byteLength - 1), events: [] };
      }
      return { displayData: chunk, events: [] };
    }
    const data = concatUint8Arrays(this.pending, chunk);
    const displaySegments: Uint8Array[] = [];
    const events: TerminalShellIntegrationEvent[] = [];
    this.pending = new Uint8Array(0);

    let index = 0;
    while (index < data.length) {
      const start = findOscStart(data, index);
      if (start < 0) {
        if (data.byteLength > index && data[data.byteLength - 1] === ESC) {
          appendSegment(displaySegments, data.subarray(index, data.byteLength - 1));
          this.pending = data.subarray(data.byteLength - 1).slice();
        } else {
          appendSegment(displaySegments, data.subarray(index));
        }
        break;
      }
      appendSegment(displaySegments, data.subarray(index, start));
      if (data[start] === ESC && start + 1 < data.length && data[start + 1] === OSC) {
        const terminator = findOscTerminator(data, start + 2);
        if (!terminator) {
          const fragment = data.subarray(start);
          if (fragment.byteLength > MAX_PENDING_BYTES) {
            appendSegment(displaySegments, fragment);
          } else {
            this.pending = fragment.slice();
          }
          break;
        }

        const payload = data.subarray(start + 2, terminator.payloadEnd);
        const parsed = parseShellIntegrationPayload(payload);
        if (parsed.recognized) {
          if (parsed.event) events.push(parsed.event);
        } else {
          appendSegment(displaySegments, data.subarray(start, terminator.nextIndex));
        }
        index = terminator.nextIndex;
        continue;
      }
    }

    return { displayData: concatSegments(displaySegments), events };
  }

  reset(): void {
    this.pending = new Uint8Array(0);
  }
}

export function normalizeTerminalForegroundCommandDisplayName(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  if (!text || encodedByteLength(text) > MAX_PROGRAM_BYTES) return '';
  return /^[A-Za-z0-9._+@-]+$/.test(text) ? text : '';
}

function parseShellIntegrationPayload(payload: Uint8Array): ParsedPayload {
  const oversized = payload.byteLength > MAX_METADATA_PAYLOAD_BYTES;
  const text = oversized ? decodePayloadPrefix(payload) : textDecoder.decode(payload);
  const protocol = text.startsWith('633;') ? '633' : text.startsWith('133;') ? '133' : null;
  if (!protocol) return { recognized: false, event: null };
  const body = text.slice(4);

  if (oversized) {
    return body.startsWith('P;FloetermProgram=')
      ? { recognized: true, event: null }
      : { recognized: false, event: null };
  }
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
  return { recognized: false, event: null };
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

function appendSegment(target: Uint8Array[], source: Uint8Array): void {
  if (source.byteLength > 0) target.push(source);
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

function encodedByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodePayloadPrefix(payload: Uint8Array): string {
  return textDecoder.decode(payload.subarray(0, Math.min(payload.byteLength, MAX_METADATA_PAYLOAD_BYTES)));
}
