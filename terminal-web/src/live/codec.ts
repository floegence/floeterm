export const StreamKind = 'terminal/live_v1';
export const FRAME_HEADER_BYTES = 8;
export const MAX_FRAME_PAYLOAD_BYTES = 256 * 1024;
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_OUTPUT_BATCH_BYTES = 64 * 1024;
export const MAX_OUTPUT_BATCH_CHUNKS = 256;
export const MAX_IDENTIFIER_BYTES = 256;

export enum TerminalLiveFrameType {
  Attach = 0x01,
  Input = 0x02,
  Resize = 0x03,
  Detach = 0x04,
  Attached = 0x81,
  OutputBatch = 0x82,
  ResizeApplied = 0x83,
  SessionClosed = 0x84,
  GeometryChanged = 0x85,
  Error = 0xff,
}

export type TerminalLiveFrame = Readonly<{
  type: TerminalLiveFrameType;
  flags: number;
  payload: Uint8Array;
}>;

export type Attach = Readonly<{
  attachGeneration: bigint;
  cols: number;
  rows: number;
  sessionId: string;
  connectionId: string;
}>;

export type Input = Readonly<{ sequence: bigint; data: Uint8Array }>;
export type Resize = Readonly<{ sequence: bigint; cols: number; rows: number }>;
export type Attached = Readonly<{
  historyBoundarySequence: bigint;
  historyGeneration: bigint;
  historyStartSequence: bigint;
  geometryGeneration: bigint;
  cols: number;
  rows: number;
}>;
export type ResizeApplied = Readonly<{
  sequence: bigint;
  geometryGeneration: bigint;
  outputSequenceBoundary: bigint;
  cols: number;
  rows: number;
}>;
export type OutputRecord = Readonly<{ sequence: bigint; timestampMs: bigint; data: Uint8Array }>;
export type OutputBatch = Readonly<{
  geometryGeneration: bigint;
  cols: number;
  rows: number;
  records: readonly OutputRecord[];
}>;
export type GeometryChanged = Readonly<{
  generation: bigint;
  outputSequenceBoundary: bigint;
  cols: number;
  rows: number;
}>;
export type ProtocolError = Readonly<{ code: number; message: string }>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const isFrameType = (value: number): value is TerminalLiveFrameType => Object.values(TerminalLiveFrameType)
  .some(candidate => typeof candidate === 'number' && candidate === value);

const frame = (type: TerminalLiveFrameType, payload: Uint8Array): Uint8Array => {
  if (!isFrameType(type)) throw new Error('unknown terminal live frame type');
  if (payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) throw new Error('terminal live frame payload is too large');
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  out[0] = type;
  view.setUint32(4, payload.byteLength, false);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
};

export class TerminalLiveDecoder {
  private buffer = new Uint8Array();

  push(chunk: Uint8Array): TerminalLiveFrame[] {
    if (chunk.byteLength > 0) {
      const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
      joined.set(this.buffer);
      joined.set(chunk, this.buffer.byteLength);
      this.buffer = joined;
    }
    const frames: TerminalLiveFrame[] = [];
    let offset = 0;
    while (this.buffer.byteLength - offset >= FRAME_HEADER_BYTES) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset);
      const type = this.buffer[offset];
      if (!isFrameType(type)) throw new Error('unknown terminal live frame type');
      if (this.buffer[offset + 1] !== 0 || view.getUint16(2, false) !== 0) {
        throw new Error('terminal live frame reserved bits are non-zero');
      }
      const payloadLength = view.getUint32(4, false);
      if (payloadLength > MAX_FRAME_PAYLOAD_BYTES) throw new Error('terminal live frame payload is too large');
      const frameLength = FRAME_HEADER_BYTES + payloadLength;
      if (this.buffer.byteLength - offset < frameLength) break;
      frames.push({
        type,
        flags: 0,
        payload: this.buffer.slice(offset + FRAME_HEADER_BYTES, offset + frameLength),
      });
      offset += frameLength;
    }
    this.buffer = offset === this.buffer.byteLength ? new Uint8Array() : this.buffer.slice(offset);
    return frames;
  }
}

const assertPositiveUint32 = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new Error(`${name} must be a positive uint32`);
  }
};

const assertPositiveUint64 = (value: bigint, name: string): void => {
  if (value <= 0n || value > 0xffffffffffffffffn) throw new Error(`${name} must be a positive uint64`);
};

const assertUint64 = (value: bigint, name: string): void => {
  if (value < 0n || value > 0xffffffffffffffffn) throw new Error(`${name} must be a uint64`);
};

const writeString = (value: string): Uint8Array => {
  const encoded = encoder.encode(value);
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_IDENTIFIER_BYTES) {
    throw new Error('terminal live identifier has an invalid length');
  }
  const out = new Uint8Array(2 + encoded.byteLength);
  new DataView(out.buffer).setUint16(0, encoded.byteLength, false);
  out.set(encoded, 2);
  return out;
};

const readString = (payload: Uint8Array, offset: number): Readonly<{ value: string; nextOffset: number }> => {
  if (offset < 0 || offset + 2 > payload.byteLength) {
    throw new Error('invalid terminal live identifier payload');
  }
  const length = new DataView(payload.buffer, payload.byteOffset + offset, 2).getUint16(0, false);
  if (length === 0 || length > MAX_IDENTIFIER_BYTES || offset + 2 + length > payload.byteLength) {
    throw new Error('terminal live identifier has an invalid length');
  }
  const nextOffset = offset + 2 + length;
  return { value: decoder.decode(payload.subarray(offset + 2, nextOffset)), nextOffset };
};

export const encodeAttach = (value: Attach): Uint8Array => {
  assertPositiveUint64(value.attachGeneration, 'attachGeneration');
  assertPositiveUint32(value.cols, 'cols');
  assertPositiveUint32(value.rows, 'rows');
  const session = writeString(value.sessionId);
  const connection = writeString(value.connectionId);
  const payload = new Uint8Array(16 + session.byteLength + connection.byteLength);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, value.attachGeneration, false);
  view.setUint32(8, value.cols, false);
  view.setUint32(12, value.rows, false);
  payload.set(session, 16);
  payload.set(connection, 16 + session.byteLength);
  return frame(TerminalLiveFrameType.Attach, payload);
};

export const decodeAttach = (value: TerminalLiveFrame): Attach => {
  if (value.type !== TerminalLiveFrameType.Attach) throw new Error('unexpected terminal live frame type');
  if (value.payload.byteLength < 22) throw new Error('invalid terminal live attach payload');
  const view = new DataView(value.payload.buffer, value.payload.byteOffset);
  const attachGeneration = view.getBigUint64(0, false);
  const cols = view.getUint32(8, false);
  const rows = view.getUint32(12, false);
  assertPositiveUint64(attachGeneration, 'attachGeneration');
  assertPositiveUint32(cols, 'cols');
  assertPositiveUint32(rows, 'rows');
  const session = readString(value.payload, 16);
  const connection = readString(value.payload, session.nextOffset);
  if (connection.nextOffset !== value.payload.byteLength) throw new Error('invalid terminal live attach payload');
  return {
    attachGeneration,
    cols,
    rows,
    sessionId: session.value,
    connectionId: connection.value,
  };
};

export const encodeInput = (value: Input): Uint8Array => {
  assertPositiveUint64(value.sequence, 'sequence');
  if (value.data.byteLength === 0 || value.data.byteLength > MAX_INPUT_BYTES) {
    throw new Error('terminal live input payload has an invalid length');
  }
  const payload = new Uint8Array(8 + value.data.byteLength);
  new DataView(payload.buffer).setBigUint64(0, value.sequence, false);
  payload.set(value.data, 8);
  return frame(TerminalLiveFrameType.Input, payload);
};

export const decodeInput = (value: TerminalLiveFrame): Input => {
  if (value.type !== TerminalLiveFrameType.Input) throw new Error('unexpected terminal live frame type');
  if (value.payload.byteLength <= 8 || value.payload.byteLength - 8 > MAX_INPUT_BYTES) {
    throw new Error('invalid terminal live input payload');
  }
  const sequence = new DataView(value.payload.buffer, value.payload.byteOffset).getBigUint64(0, false);
  assertPositiveUint64(sequence, 'sequence');
  return { sequence, data: value.payload.slice(8) };
};

export const encodeResize = (value: Resize): Uint8Array => {
  assertPositiveUint64(value.sequence, 'sequence');
  assertPositiveUint32(value.cols, 'cols');
  assertPositiveUint32(value.rows, 'rows');
  const payload = new Uint8Array(16);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, value.sequence, false);
  view.setUint32(8, value.cols, false);
  view.setUint32(12, value.rows, false);
  return frame(TerminalLiveFrameType.Resize, payload);
};

export const decodeResize = (value: TerminalLiveFrame): Resize => {
  if (value.type !== TerminalLiveFrameType.Resize) throw new Error('unexpected terminal live frame type');
  if (value.payload.byteLength !== 16) throw new Error('invalid terminal live resize payload');
  const view = new DataView(value.payload.buffer, value.payload.byteOffset);
  const sequence = view.getBigUint64(0, false);
  const cols = view.getUint32(8, false);
  const rows = view.getUint32(12, false);
  assertPositiveUint64(sequence, 'sequence');
  assertPositiveUint32(cols, 'cols');
  assertPositiveUint32(rows, 'rows');
  return { sequence, cols, rows };
};

export const encodeAttached = (value: Attached): Uint8Array => {
  assertPositiveUint64(value.historyGeneration, 'historyGeneration');
  assertPositiveUint64(value.historyStartSequence, 'historyStartSequence');
  assertPositiveUint64(value.geometryGeneration, 'geometryGeneration');
  assertPositiveUint32(value.cols, 'cols');
  assertPositiveUint32(value.rows, 'rows');
  if (value.historyStartSequence > value.historyBoundarySequence + 1n) {
    throw new Error('historyStartSequence exceeds the attached history boundary');
  }
  const payload = new Uint8Array(40);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, value.historyBoundarySequence, false);
  view.setBigUint64(8, value.historyGeneration, false);
  view.setBigUint64(16, value.historyStartSequence, false);
  view.setBigUint64(24, value.geometryGeneration, false);
  view.setUint32(32, value.cols, false);
  view.setUint32(36, value.rows, false);
  return frame(TerminalLiveFrameType.Attached, payload);
};

export const decodeAttached = (value: TerminalLiveFrame): Attached => {
  if (value.type !== TerminalLiveFrameType.Attached) throw new Error('unexpected terminal live frame type');
  if (value.payload.byteLength !== 40) throw new Error('invalid terminal live attached payload');
  const view = new DataView(value.payload.buffer, value.payload.byteOffset);
  const attached = {
    historyBoundarySequence: view.getBigUint64(0, false),
    historyGeneration: view.getBigUint64(8, false),
    historyStartSequence: view.getBigUint64(16, false),
    geometryGeneration: view.getBigUint64(24, false),
    cols: view.getUint32(32, false),
    rows: view.getUint32(36, false),
  };
  assertPositiveUint64(attached.historyGeneration, 'historyGeneration');
  assertPositiveUint64(attached.historyStartSequence, 'historyStartSequence');
  assertPositiveUint64(attached.geometryGeneration, 'geometryGeneration');
  assertPositiveUint32(attached.cols, 'cols');
  assertPositiveUint32(attached.rows, 'rows');
  if (attached.historyStartSequence > attached.historyBoundarySequence + 1n) {
    throw new Error('historyStartSequence exceeds the attached history boundary');
  }
  return attached;
};

export const encodeResizeApplied = (value: ResizeApplied): Uint8Array => {
  assertPositiveUint64(value.sequence, 'sequence');
  assertPositiveUint64(value.geometryGeneration, 'geometryGeneration');
  assertUint64(value.outputSequenceBoundary, 'outputSequenceBoundary');
  assertPositiveUint32(value.cols, 'cols');
  assertPositiveUint32(value.rows, 'rows');
  const payload = new Uint8Array(32);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, value.sequence, false);
  view.setBigUint64(8, value.geometryGeneration, false);
  view.setBigUint64(16, value.outputSequenceBoundary, false);
  view.setUint32(24, value.cols, false);
  view.setUint32(28, value.rows, false);
  return frame(TerminalLiveFrameType.ResizeApplied, payload);
};

export const decodeResizeApplied = (value: TerminalLiveFrame): ResizeApplied => {
  if (value.type !== TerminalLiveFrameType.ResizeApplied) throw new Error('unexpected terminal live frame type');
  if (value.payload.byteLength !== 32) throw new Error('invalid terminal live resize applied payload');
  const view = new DataView(value.payload.buffer, value.payload.byteOffset);
  const sequence = view.getBigUint64(0, false);
  const geometryGeneration = view.getBigUint64(8, false);
  const outputSequenceBoundary = view.getBigUint64(16, false);
  const cols = view.getUint32(24, false);
  const rows = view.getUint32(28, false);
  assertPositiveUint64(sequence, 'sequence');
  assertPositiveUint64(geometryGeneration, 'geometryGeneration');
  assertUint64(outputSequenceBoundary, 'outputSequenceBoundary');
  assertPositiveUint32(cols, 'cols');
  assertPositiveUint32(rows, 'rows');
  return { sequence, geometryGeneration, outputSequenceBoundary, cols, rows };
};

export const encodeGeometryChanged = (value: GeometryChanged): Uint8Array => {
  assertPositiveUint64(value.generation, 'geometryGeneration');
  assertUint64(value.outputSequenceBoundary, 'outputSequenceBoundary');
  assertPositiveUint32(value.cols, 'cols');
  assertPositiveUint32(value.rows, 'rows');
  const payload = new Uint8Array(24);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, value.generation, false);
  view.setBigUint64(8, value.outputSequenceBoundary, false);
  view.setUint32(16, value.cols, false);
  view.setUint32(20, value.rows, false);
  return frame(TerminalLiveFrameType.GeometryChanged, payload);
};

export const decodeGeometryChanged = (value: TerminalLiveFrame): GeometryChanged => {
  if (value.type !== TerminalLiveFrameType.GeometryChanged) throw new Error('unexpected terminal live frame type');
  if (value.payload.byteLength !== 24) throw new Error('invalid terminal live geometry payload');
  const view = new DataView(value.payload.buffer, value.payload.byteOffset);
  const generation = view.getBigUint64(0, false);
  const outputSequenceBoundary = view.getBigUint64(8, false);
  const cols = view.getUint32(16, false);
  const rows = view.getUint32(20, false);
  assertPositiveUint64(generation, 'geometryGeneration');
  assertUint64(outputSequenceBoundary, 'outputSequenceBoundary');
  assertPositiveUint32(cols, 'cols');
  assertPositiveUint32(rows, 'rows');
  return { generation, outputSequenceBoundary, cols, rows };
};

export const encodeOutputBatch = (value: OutputBatch): Uint8Array => {
  assertPositiveUint64(value.geometryGeneration, 'geometryGeneration');
  assertPositiveUint32(value.cols, 'cols');
  assertPositiveUint32(value.rows, 'rows');
  if (value.records.length === 0 || value.records.length > MAX_OUTPUT_BATCH_CHUNKS) {
    throw new Error('invalid terminal live output record count');
  }
  let dataBytes = 0;
  let payloadBytes = 18;
  for (const record of value.records) {
    assertPositiveUint64(record.sequence, 'sequence');
    if (record.data.byteLength === 0) throw new Error('invalid terminal live output data');
    dataBytes += record.data.byteLength;
    payloadBytes += 20 + record.data.byteLength;
  }
  if (dataBytes > MAX_OUTPUT_BATCH_BYTES) throw new Error('terminal live output batch is too large');
  const payload = new Uint8Array(payloadBytes);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, value.geometryGeneration, false);
  view.setUint32(8, value.cols, false);
  view.setUint32(12, value.rows, false);
  view.setUint16(16, value.records.length, false);
  let offset = 18;
  for (const record of value.records) {
    view.setBigUint64(offset, record.sequence, false);
    view.setBigUint64(offset + 8, record.timestampMs, false);
    view.setUint32(offset + 16, record.data.byteLength, false);
    payload.set(record.data, offset + 20);
    offset += 20 + record.data.byteLength;
  }
  return frame(TerminalLiveFrameType.OutputBatch, payload);
};

export const decodeOutputBatch = (value: TerminalLiveFrame): OutputBatch => {
  if (value.type !== TerminalLiveFrameType.OutputBatch) throw new Error('unexpected terminal live frame type');
  if (value.payload.byteLength < 18) throw new Error('invalid terminal live output payload');
  const view = new DataView(value.payload.buffer, value.payload.byteOffset);
  const geometryGeneration = view.getBigUint64(0, false);
  const cols = view.getUint32(8, false);
  const rows = view.getUint32(12, false);
  assertPositiveUint64(geometryGeneration, 'geometryGeneration');
  assertPositiveUint32(cols, 'cols');
  assertPositiveUint32(rows, 'rows');
  const count = view.getUint16(16, false);
  if (count === 0 || count > MAX_OUTPUT_BATCH_CHUNKS) throw new Error('invalid terminal live output record count');
  const records: OutputRecord[] = [];
  let offset = 18;
  let dataBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (value.payload.byteLength - offset < 20) throw new Error('invalid terminal live output payload');
    const size = view.getUint32(offset + 16, false);
    if (size === 0 || size > value.payload.byteLength - offset - 20) throw new Error('invalid terminal live output payload');
    dataBytes += size;
    if (dataBytes > MAX_OUTPUT_BATCH_BYTES) throw new Error('terminal live output batch is too large');
    const sequence = view.getBigUint64(offset, false);
    assertPositiveUint64(sequence, 'sequence');
    records.push({
      sequence,
      timestampMs: view.getBigUint64(offset + 8, false),
      data: value.payload.slice(offset + 20, offset + 20 + size),
    });
    offset += 20 + size;
  }
  if (offset !== value.payload.byteLength) throw new Error('invalid terminal live output payload');
  return { geometryGeneration, cols, rows, records };
};

export const decodeProtocolError = (value: TerminalLiveFrame): ProtocolError => {
  if (value.type !== TerminalLiveFrameType.Error) throw new Error('unexpected terminal live frame type');
  if (value.payload.byteLength < 4) throw new Error('invalid terminal live error payload');
  const view = new DataView(value.payload.buffer, value.payload.byteOffset);
  const code = view.getUint16(0, false);
  const size = view.getUint16(2, false);
  if (code === 0 || size === 0 || size > MAX_IDENTIFIER_BYTES || size !== value.payload.byteLength - 4) {
    throw new Error('invalid terminal live error payload');
  }
  return { code, message: decodeUtf8(value.payload.subarray(4)) };
};

export const decodeUtf8 = (value: Uint8Array): string => decoder.decode(value);
