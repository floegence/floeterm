export const StreamKind = 'terminal/live_v1';
export const FRAME_HEADER_BYTES = 8;
export const MAX_FRAME_PAYLOAD_BYTES = 256 * 1024;
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_IDENTIFIER_BYTES = 256;

export enum TerminalLiveFrameType {
  Attach = 0x01,
  Input = 0x02,
  Resize = 0x03,
  Detach = 0x04,
  InputIntent = 0x05,
  Activate = 0x06,
  Attached = 0x81,
  ResizeApplied = 0x83,
  SessionClosed = 0x84,
  GeometryChanged = 0x85,
  Presentation = 0x86,
  Activated = 0x87,
  ControllerChanged = 0x88,
  ActivationRejected = 0x89,
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
export type InputIntent = Readonly<{
  sequence: bigint;
  code: string;
  text: string;
  action: 'press' | 'repeat' | 'release';
  modifiers: number;
}>;
export type Resize = Readonly<{ sequence: bigint; cols: number; rows: number }>;
export type Activate = Readonly<{
  sequence: bigint;
  controllerEpoch: bigint;
  cols: number;
  rows: number;
}>;
export type Attached = Readonly<{
  presentationSequence: bigint;
  geometryGeneration: bigint;
  controllerEpoch: bigint;
  cols: number;
  rows: number;
  isController: boolean;
}>;
export type ResizeApplied = Readonly<{
  sequence: bigint;
  geometryGeneration: bigint;
  presentationSequence: bigint;
  cols: number;
  rows: number;
}>;
export type GeometryChanged = Readonly<{
  generation: bigint;
  presentationSequence: bigint;
  cols: number;
  rows: number;
}>;
export type Activated = Readonly<{
  sequence: bigint;
  controllerEpoch: bigint;
  geometryGeneration: bigint;
  presentationSequence: bigint;
  cols: number;
  rows: number;
}>;
export type ControllerChanged = Readonly<{ epoch: bigint; isController: boolean }>;
export type ActivationRejected = Readonly<{
  sequence: bigint;
  controllerEpoch: bigint;
  isController: boolean;
}>;
export type Presentation = Readonly<{ value: unknown }>;
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

const keyActionValue = (action: InputIntent['action']): number => {
  switch (action) {
    case 'press': return 1;
    case 'repeat': return 2;
    case 'release': return 3;
    default: throw new Error('invalid terminal live input intent action');
  }
};

const decodeKeyAction = (value: number): InputIntent['action'] => {
  switch (value) {
    case 1: return 'press';
    case 2: return 'repeat';
    case 3: return 'release';
    default: throw new Error('invalid terminal live input intent action');
  }
};

export const encodeInputIntent = (value: InputIntent): Uint8Array => {
  assertPositiveUint64(value.sequence, 'sequence');
  const code = encoder.encode(value.code);
  const text = encoder.encode(value.text);
  if (code.byteLength === 0 || code.byteLength > MAX_IDENTIFIER_BYTES || text.byteLength > MAX_INPUT_BYTES
    || !Number.isSafeInteger(value.modifiers) || value.modifiers < 0 || (value.modifiers & ~0x3f) !== 0
    || 16 + code.byteLength + text.byteLength > MAX_INPUT_BYTES) {
    throw new Error('terminal live input intent payload is invalid');
  }
  const payload = new Uint8Array(16 + code.byteLength + text.byteLength);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, value.sequence, false);
  payload[8] = keyActionValue(value.action);
  view.setUint16(10, value.modifiers, false);
  view.setUint16(12, code.byteLength, false);
  view.setUint16(14, text.byteLength, false);
  payload.set(code, 16);
  payload.set(text, 16 + code.byteLength);
  return frame(TerminalLiveFrameType.InputIntent, payload);
};

export const decodeInputIntent = (value: TerminalLiveFrame): InputIntent => {
  if (value.type !== TerminalLiveFrameType.InputIntent) throw new Error('unexpected terminal live frame type');
  if (value.payload.byteLength < 17 || value.payload.byteLength > MAX_INPUT_BYTES || value.payload[9] !== 0) {
    throw new Error('invalid terminal live input intent payload');
  }
  const view = new DataView(value.payload.buffer, value.payload.byteOffset);
  const sequence = view.getBigUint64(0, false);
  const modifiers = view.getUint16(10, false);
  const codeLength = view.getUint16(12, false);
  const textLength = view.getUint16(14, false);
  assertPositiveUint64(sequence, 'sequence');
  if (codeLength === 0 || codeLength > MAX_IDENTIFIER_BYTES || (modifiers & ~0x3f) !== 0
    || 16 + codeLength + textLength !== value.payload.byteLength) {
    throw new Error('invalid terminal live input intent payload');
  }
  return {
    sequence,
    code: decoder.decode(value.payload.subarray(16, 16 + codeLength)),
    text: decoder.decode(value.payload.subarray(16 + codeLength)),
    action: decodeKeyAction(value.payload[8]!),
    modifiers,
  };
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

export const encodeActivate = (value: Activate): Uint8Array => {
  assertPositiveUint64(value.sequence, 'sequence');
  assertPositiveUint64(value.controllerEpoch, 'controllerEpoch');
  assertPositiveUint32(value.cols, 'cols');
  assertPositiveUint32(value.rows, 'rows');
  const payload = new Uint8Array(24);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, value.sequence, false);
  view.setBigUint64(8, value.controllerEpoch, false);
  view.setUint32(16, value.cols, false);
  view.setUint32(20, value.rows, false);
  return frame(TerminalLiveFrameType.Activate, payload);
};

export const decodeActivate = (value: TerminalLiveFrame): Activate => {
  if (value.type !== TerminalLiveFrameType.Activate || value.payload.byteLength !== 24) {
    throw new Error('invalid terminal live activate payload');
  }
  const view = new DataView(value.payload.buffer, value.payload.byteOffset);
  const result = {
    sequence: view.getBigUint64(0, false),
    controllerEpoch: view.getBigUint64(8, false),
    cols: view.getUint32(16, false),
    rows: view.getUint32(20, false),
  };
  assertPositiveUint64(result.sequence, 'sequence');
  assertPositiveUint64(result.controllerEpoch, 'controllerEpoch');
  assertPositiveUint32(result.cols, 'cols');
  assertPositiveUint32(result.rows, 'rows');
  return result;
};

export const encodeAttached = (value: Attached): Uint8Array => {
  assertPositiveUint64(value.presentationSequence, 'presentationSequence');
  assertPositiveUint64(value.geometryGeneration, 'geometryGeneration');
  assertPositiveUint64(value.controllerEpoch, 'controllerEpoch');
  assertPositiveUint32(value.cols, 'cols');
  assertPositiveUint32(value.rows, 'rows');
  const payload = new Uint8Array(40);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, value.presentationSequence, false);
  view.setBigUint64(8, value.geometryGeneration, false);
  view.setBigUint64(16, value.controllerEpoch, false);
  view.setUint32(24, value.cols, false);
  view.setUint32(28, value.rows, false);
  payload[32] = value.isController ? 1 : 0;
  return frame(TerminalLiveFrameType.Attached, payload);
};

export const decodeAttached = (value: TerminalLiveFrame): Attached => {
  if (value.type !== TerminalLiveFrameType.Attached) throw new Error('unexpected terminal live frame type');
  if (value.payload.byteLength !== 40 || value.payload[32]! > 1
    || value.payload.subarray(33).some(byte => byte !== 0)) {
    throw new Error('invalid terminal live attached payload');
  }
  const view = new DataView(value.payload.buffer, value.payload.byteOffset);
  const attached = {
    presentationSequence: view.getBigUint64(0, false),
    geometryGeneration: view.getBigUint64(8, false),
    controllerEpoch: view.getBigUint64(16, false),
    cols: view.getUint32(24, false),
    rows: view.getUint32(28, false),
    isController: value.payload[32] === 1,
  };
  assertPositiveUint64(attached.presentationSequence, 'presentationSequence');
  assertPositiveUint64(attached.geometryGeneration, 'geometryGeneration');
  assertPositiveUint64(attached.controllerEpoch, 'controllerEpoch');
  assertPositiveUint32(attached.cols, 'cols');
  assertPositiveUint32(attached.rows, 'rows');
  return attached;
};

export const encodeActivated = (value: Activated): Uint8Array => {
  assertPositiveUint64(value.sequence, 'sequence');
  assertPositiveUint64(value.controllerEpoch, 'controllerEpoch');
  assertPositiveUint64(value.geometryGeneration, 'geometryGeneration');
  assertPositiveUint64(value.presentationSequence, 'presentationSequence');
  assertPositiveUint32(value.cols, 'cols');
  assertPositiveUint32(value.rows, 'rows');
  const payload = new Uint8Array(40);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, value.sequence, false);
  view.setBigUint64(8, value.controllerEpoch, false);
  view.setBigUint64(16, value.geometryGeneration, false);
  view.setBigUint64(24, value.presentationSequence, false);
  view.setUint32(32, value.cols, false);
  view.setUint32(36, value.rows, false);
  return frame(TerminalLiveFrameType.Activated, payload);
};

export const decodeActivated = (value: TerminalLiveFrame): Activated => {
  if (value.type !== TerminalLiveFrameType.Activated || value.payload.byteLength !== 40) {
    throw new Error('invalid terminal live activated payload');
  }
  const view = new DataView(value.payload.buffer, value.payload.byteOffset);
  const result = {
    sequence: view.getBigUint64(0, false),
    controllerEpoch: view.getBigUint64(8, false),
    geometryGeneration: view.getBigUint64(16, false),
    presentationSequence: view.getBigUint64(24, false),
    cols: view.getUint32(32, false),
    rows: view.getUint32(36, false),
  };
  assertPositiveUint64(result.sequence, 'sequence');
  assertPositiveUint64(result.controllerEpoch, 'controllerEpoch');
  assertPositiveUint64(result.geometryGeneration, 'geometryGeneration');
  assertPositiveUint64(result.presentationSequence, 'presentationSequence');
  assertPositiveUint32(result.cols, 'cols');
  assertPositiveUint32(result.rows, 'rows');
  return result;
};

export const encodeControllerChanged = (value: ControllerChanged): Uint8Array => {
  assertPositiveUint64(value.epoch, 'controllerEpoch');
  const payload = new Uint8Array(16);
  new DataView(payload.buffer).setBigUint64(0, value.epoch, false);
  payload[8] = value.isController ? 1 : 0;
  return frame(TerminalLiveFrameType.ControllerChanged, payload);
};

export const decodeControllerChanged = (value: TerminalLiveFrame): ControllerChanged => {
  if (value.type !== TerminalLiveFrameType.ControllerChanged || value.payload.byteLength !== 16
    || value.payload[8]! > 1 || value.payload.subarray(9).some(byte => byte !== 0)) {
    throw new Error('invalid terminal live controller payload');
  }
  const epoch = new DataView(value.payload.buffer, value.payload.byteOffset).getBigUint64(0, false);
  assertPositiveUint64(epoch, 'controllerEpoch');
  return { epoch, isController: value.payload[8] === 1 };
};

export const encodeActivationRejected = (value: ActivationRejected): Uint8Array => {
  assertPositiveUint64(value.sequence, 'activation sequence');
  assertPositiveUint64(value.controllerEpoch, 'controllerEpoch');
  const payload = new Uint8Array(24);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, value.sequence, false);
  view.setBigUint64(8, value.controllerEpoch, false);
  payload[16] = value.isController ? 1 : 0;
  return frame(TerminalLiveFrameType.ActivationRejected, payload);
};

export const decodeActivationRejected = (value: TerminalLiveFrame): ActivationRejected => {
  if (value.type !== TerminalLiveFrameType.ActivationRejected || value.payload.byteLength !== 24
    || (value.payload[16] ?? 2) > 1 || value.payload.slice(17).some(byte => byte !== 0)) {
    throw new Error('invalid terminal live activation rejection');
  }
  const view = new DataView(value.payload.buffer, value.payload.byteOffset, value.payload.byteLength);
  const result = {
    sequence: view.getBigUint64(0, false),
    controllerEpoch: view.getBigUint64(8, false),
    isController: value.payload[16] === 1,
  };
  assertPositiveUint64(result.sequence, 'activation sequence');
  assertPositiveUint64(result.controllerEpoch, 'controllerEpoch');
  return result;
};

export const encodeResizeApplied = (value: ResizeApplied): Uint8Array => {
  assertPositiveUint64(value.sequence, 'sequence');
  assertPositiveUint64(value.geometryGeneration, 'geometryGeneration');
  assertPositiveUint64(value.presentationSequence, 'presentationSequence');
  assertPositiveUint32(value.cols, 'cols');
  assertPositiveUint32(value.rows, 'rows');
  const payload = new Uint8Array(32);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, value.sequence, false);
  view.setBigUint64(8, value.geometryGeneration, false);
  view.setBigUint64(16, value.presentationSequence, false);
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
  const presentationSequence = view.getBigUint64(16, false);
  const cols = view.getUint32(24, false);
  const rows = view.getUint32(28, false);
  assertPositiveUint64(sequence, 'sequence');
  assertPositiveUint64(geometryGeneration, 'geometryGeneration');
  assertPositiveUint64(presentationSequence, 'presentationSequence');
  assertPositiveUint32(cols, 'cols');
  assertPositiveUint32(rows, 'rows');
  return { sequence, geometryGeneration, presentationSequence, cols, rows };
};

export const encodeGeometryChanged = (value: GeometryChanged): Uint8Array => {
  assertPositiveUint64(value.generation, 'geometryGeneration');
  assertPositiveUint64(value.presentationSequence, 'presentationSequence');
  assertPositiveUint32(value.cols, 'cols');
  assertPositiveUint32(value.rows, 'rows');
  const payload = new Uint8Array(24);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, value.generation, false);
  view.setBigUint64(8, value.presentationSequence, false);
  view.setUint32(16, value.cols, false);
  view.setUint32(20, value.rows, false);
  return frame(TerminalLiveFrameType.GeometryChanged, payload);
};

export const decodeGeometryChanged = (value: TerminalLiveFrame): GeometryChanged => {
  if (value.type !== TerminalLiveFrameType.GeometryChanged) throw new Error('unexpected terminal live frame type');
  if (value.payload.byteLength !== 24) throw new Error('invalid terminal live geometry payload');
  const view = new DataView(value.payload.buffer, value.payload.byteOffset);
  const generation = view.getBigUint64(0, false);
  const presentationSequence = view.getBigUint64(8, false);
  const cols = view.getUint32(16, false);
  const rows = view.getUint32(20, false);
  assertPositiveUint64(generation, 'geometryGeneration');
  assertPositiveUint64(presentationSequence, 'presentationSequence');
  assertPositiveUint32(cols, 'cols');
  assertPositiveUint32(rows, 'rows');
  return { generation, presentationSequence, cols, rows };
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

export const decodePresentation = (value: TerminalLiveFrame): unknown => {
  if (value.type !== TerminalLiveFrameType.Presentation) throw new Error('unexpected terminal live presentation frame');
  if (value.payload.byteLength === 0 || value.payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) throw new Error('invalid terminal live presentation payload');
  const wire = JSON.parse(decoder.decode(value.payload)) as any;
  if (wire?.v !== 1 || !Array.isArray(wire.frame?.styles) || !Array.isArray(wire.frame?.rows)) throw new Error('invalid terminal live presentation wire');
  const styleInverses = wire.frame.styleInverses;
  if (styleInverses !== undefined && (!Array.isArray(styleInverses)
    || styleInverses.length !== wire.frame.styles.length
    || styleInverses.some((inverse: unknown) => typeof inverse !== 'boolean'))) {
    throw new Error('invalid terminal live presentation inverse styles');
  }
  const styles = wire.frame.styles.map((style: unknown, index: number) => {
    if (!Array.isArray(style) || (style.length !== 5 && style.length !== 6)) throw new Error('invalid terminal live presentation style');
    return { foreground: style[0], background: style[1], bold: style[2], italic: style[3], underline: style[4], inverse: style[5] ?? styleInverses?.[index] ?? false };
  });
  const graphics = decodePresentationGraphics(wire.frame.graphics);
  return {
    sequence: wire.sequence, geometry: wire.geometry, state: wire.state,
    frame: {
      width: wire.frame.width, height: wire.frame.height, bufferKind: wire.frame.bufferKind, cursor: wire.frame.cursor, history: wire.frame.history, graphics,
      rows: wire.frame.rows.map((row: unknown) => {
        if (!Array.isArray(row)) throw new Error('invalid terminal live presentation row');
        return { cells: row.map((cell: unknown) => {
          if (!Array.isArray(cell) || cell.length !== 4 || !Number.isInteger(cell[2]) || !styles[cell[2]]) throw new Error('invalid terminal live presentation cell');
          return { text: cell[0], width: cell[1], style: styles[cell[2]], ...(cell[3] ? { hyperlink: cell[3] } : {}) };
        }) };
      }),
    },
  };
};

function decodePresentationGraphics(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) throw new Error('invalid terminal live presentation graphics');
  const graphics = value as any;
  if (!Array.isArray(graphics.images) || !Array.isArray(graphics.placements)) throw new Error('invalid terminal live presentation graphics');
  return {
    generation: graphics.generation,
    images: graphics.images.map((image: any) => ({ ...image, pixels: decodeBase64Bytes(image?.pixels) })),
    placements: graphics.placements,
  };
}

function decodeBase64Bytes(value: unknown): Uint8Array {
  if (typeof value !== 'string') throw new Error('invalid terminal live presentation graphic pixels');
  try {
    if (typeof globalThis.atob === 'function') {
      const decoded = globalThis.atob(value);
      return Uint8Array.from(decoded, character => character.charCodeAt(0));
    }
    return Uint8Array.from((globalThis as any).Buffer.from(value, 'base64'));
  } catch {
    throw new Error('invalid terminal live presentation graphic pixels');
  }
}

export const decodeUtf8 = (value: Uint8Array): string => decoder.decode(value);
