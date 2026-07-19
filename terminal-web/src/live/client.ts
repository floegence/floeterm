import {
  MAX_INPUT_BYTES,
  StreamKind,
  TerminalLiveDecoder,
  TerminalLiveFrameType,
  decodeAttached,
  decodeGeometryChanged,
  decodeOutputBatch,
  decodeProtocolError,
  decodeResizeApplied,
  encodeAttach,
  encodeInput,
  encodeResize,
  type Attached,
  type OutputRecord,
  type TerminalLiveFrame,
} from './codec.js';

export const MAX_QUEUED_INPUT_BYTES = 8 * 1024 * 1024;

export enum TerminalLiveErrorCode {
  ProtocolViolation = 1,
  PermissionDenied = 2,
  SessionNotFound = 3,
  ActivationFailed = 4,
  SlowConsumer = 5,
  Internal = 6,
}

export class TerminalLiveServerError extends Error {
  readonly code: number;
  readonly serverMessage: string;

  constructor(code: number, serverMessage: string) {
    super(`terminal live server error ${code}: ${serverMessage}`);
    this.name = 'TerminalLiveServerError';
    this.code = code;
    this.serverMessage = serverMessage;
  }
}

export type TerminalLiveCloseReason = 'stream_ended' | 'session_closed';

export interface TerminalByteStream {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void> | void;
  reset?(error?: Error): Promise<void> | void;
}

export type TerminalLiveAttachRequest = Readonly<{
  sessionId: string;
  connectionId: string;
  attachGeneration: number;
  cols: number;
  rows: number;
}>;

export type TerminalLiveAttached = Readonly<{
  historyBoundarySequence: number;
  historyGeneration: number;
  historyStartSequence: number;
  geometryGeneration: number;
  cols: number;
  rows: number;
}>;

export type TerminalLiveGeometry = Readonly<{
  generation: number;
  outputSequenceBoundary: number;
  cols: number;
  rows: number;
}>;

export type TerminalLiveConnection = Readonly<{
  attached: TerminalLiveAttached;
  sendInput(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}>;

export type ConnectTerminalLiveOptions = Readonly<{
  openStream: (kind: typeof StreamKind, options?: Readonly<{ signal?: AbortSignal }>) => Promise<TerminalByteStream>;
  attach: TerminalLiveAttachRequest;
  onOutputBatch: (records: readonly OutputRecord[]) => void;
  onGeometry?: (geometry: TerminalLiveGeometry) => void;
  onClosed?: (reason: TerminalLiveCloseReason) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
}>;

class FrameReader {
  private readonly decoder = new TerminalLiveDecoder();
  private pending: TerminalLiveFrame[] = [];

  constructor(private readonly stream: TerminalByteStream) {}

  async read(): Promise<TerminalLiveFrame | null> {
    while (this.pending.length === 0) {
      const chunk = await this.stream.read();
      if (chunk == null) return null;
      this.pending = this.decoder.push(chunk);
    }
    return this.pending.shift() ?? null;
  }
}

const toSafeNumber = (value: bigint, name: string): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} exceeds JavaScript safe integer range`);
  return number;
};

type PendingGeometry = Readonly<{
  geometry: TerminalLiveGeometry;
  outputSequenceBoundary: bigint;
  resizeSequence?: bigint;
}>;

class TerminalLiveConnectionImpl implements TerminalLiveConnection {
  readonly attached: TerminalLiveAttached;
  private inputSequence = 0n;
  private resizeSequence = 0n;
  private queuedInputBytes = 0;
  private nextOutputSequence: bigint;
  private lastOutputSequence: bigint;
  private pendingGeometries: PendingGeometry[] = [];
  private writeTail: Promise<void> = Promise.resolve();
  private readonly resizeWaiters = new Map<bigint, { resolve: () => void; reject: (error: Error) => void }>();
  private geometry: TerminalLiveGeometry;
  private closed = false;
  private failed = false;

  constructor(
    private readonly stream: TerminalByteStream,
    private readonly reader: FrameReader,
    attached: Attached,
    private readonly onOutputBatch: (records: readonly OutputRecord[]) => void,
    private readonly onGeometry: ((geometry: TerminalLiveGeometry) => void) | undefined,
    private readonly onClosed: ((reason: TerminalLiveCloseReason) => void) | undefined,
    private readonly onError: ((error: Error) => void) | undefined,
  ) {
    this.attached = {
      historyBoundarySequence: toSafeNumber(attached.historyBoundarySequence, 'historyBoundarySequence'),
      historyGeneration: toSafeNumber(attached.historyGeneration, 'historyGeneration'),
      historyStartSequence: toSafeNumber(attached.historyStartSequence, 'historyStartSequence'),
      geometryGeneration: toSafeNumber(attached.geometryGeneration, 'geometryGeneration'),
      cols: attached.cols,
      rows: attached.rows,
    };
    this.geometry = {
      generation: this.attached.geometryGeneration,
      outputSequenceBoundary: this.attached.historyBoundarySequence,
      cols: this.attached.cols,
      rows: this.attached.rows,
    };
    this.nextOutputSequence = attached.historyBoundarySequence + 1n;
    this.lastOutputSequence = attached.historyBoundarySequence;
    this.onGeometry?.(this.geometry);
  }

  start(): void {
    void this.readLoop();
  }

  async sendInput(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('terminal live connection is closed');
    if (data.byteLength === 0) return;
    if (data.byteLength > MAX_QUEUED_INPUT_BYTES || this.queuedInputBytes + data.byteLength > MAX_QUEUED_INPUT_BYTES) {
      throw new Error('terminal live input queue limit exceeded');
    }

    const frameCount = Math.ceil(data.byteLength / MAX_INPUT_BYTES);
    const firstSequence = this.inputSequence + 1n;
    this.inputSequence += BigInt(frameCount);
    this.queuedInputBytes += data.byteLength;
    try {
      await this.enqueueWrite(async () => {
        // Encode one frame at a time only when the byte stream is ready for it.
        // A maximum-size paste therefore retains the caller's byte buffer plus
        // one 64 KiB wire frame instead of another full paste-sized frame set.
        for (let frameIndex = 0, offset = 0; offset < data.byteLength; frameIndex += 1, offset += MAX_INPUT_BYTES) {
          const encoded = encodeInput({
            sequence: firstSequence + BigInt(frameIndex),
            data: data.subarray(offset, Math.min(data.byteLength, offset + MAX_INPUT_BYTES)),
          });
          await this.stream.write(encoded);
        }
      });
    } finally {
      this.queuedInputBytes -= data.byteLength;
    }
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.closed) throw new Error('terminal live connection is closed');
    this.resizeSequence += 1n;
    const sequence = this.resizeSequence;
    const applied = new Promise<void>((resolve, reject) => {
      this.resizeWaiters.set(sequence, { resolve, reject });
    });
    try {
      await this.enqueueWrite(() => this.stream.write(encodeResize({ sequence, cols, rows })));
    } catch (error) {
      this.resizeWaiters.delete(sequence);
      throw error;
    }
    return await applied;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('terminal live connection is closed');
    this.rejectResizeWaiters(error);
    await this.stream.close();
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const run = this.writeTail.then(operation);
    this.writeTail = run.catch(() => undefined);
    return run;
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.closed) {
        const frame = await this.reader.read();
        if (frame == null) {
          this.closed = true;
          this.rejectResizeWaiters(new Error('terminal live stream ended'));
          this.onClosed?.('stream_ended');
          return;
        }
        switch (frame.type) {
          case TerminalLiveFrameType.OutputBatch:
          {
            const batch = decodeOutputBatch(frame);
            const records = batch.records;
            for (const record of records) {
              if (record.sequence !== this.nextOutputSequence) {
                throw new Error(
                  `expected output sequence ${this.nextOutputSequence}, received ${record.sequence}`,
                );
              }
              this.nextOutputSequence += 1n;
            }
            this.applyGeometry({
              generation: toSafeNumber(batch.geometryGeneration, 'geometryGeneration'),
              outputSequenceBoundary: toSafeNumber(records[0]!.sequence - 1n, 'outputSequenceBoundary'),
              cols: batch.cols,
              rows: batch.rows,
            });
            this.onOutputBatch(records);
            if (records.length > 0) this.lastOutputSequence = records[records.length - 1]!.sequence;
            this.flushPendingGeometries();
            break;
          }
          case TerminalLiveFrameType.ResizeApplied: {
            const applied = decodeResizeApplied(frame);
            const waiter = this.resizeWaiters.get(applied.sequence);
            if (!waiter) throw new Error('unexpected terminal live resize acknowledgement');
            this.queueGeometry({
              generation: toSafeNumber(applied.geometryGeneration, 'geometryGeneration'),
              outputSequenceBoundary: toSafeNumber(applied.outputSequenceBoundary, 'outputSequenceBoundary'),
              cols: applied.cols,
              rows: applied.rows,
            }, applied.outputSequenceBoundary, applied.sequence);
            break;
          }
          case TerminalLiveFrameType.GeometryChanged: {
            const geometry = decodeGeometryChanged(frame);
            this.queueGeometry({
              generation: toSafeNumber(geometry.generation, 'geometryGeneration'),
              outputSequenceBoundary: toSafeNumber(geometry.outputSequenceBoundary, 'outputSequenceBoundary'),
              cols: geometry.cols,
              rows: geometry.rows,
            }, geometry.outputSequenceBoundary);
            break;
          }
          case TerminalLiveFrameType.SessionClosed:
            if (frame.payload.byteLength !== 0) throw new Error('invalid terminal live session closed payload');
            this.closed = true;
            this.rejectResizeWaiters(new Error('terminal session closed'));
            this.onClosed?.('session_closed');
            await this.stream.close();
            return;
          case TerminalLiveFrameType.Error: {
            const protocolError = decodeProtocolError(frame);
            throw new TerminalLiveServerError(protocolError.code, protocolError.message);
          }
          default:
            throw new Error(`invalid terminal live server frame: 0x${frame.type.toString(16)}`);
        }
      }
    } catch (value) {
      const error = value instanceof Error ? value : new Error(String(value));
      await this.fail(error);
    }
  }

  private rejectResizeWaiters(error: Error): void {
    for (const waiter of this.resizeWaiters.values()) waiter.reject(error);
    this.resizeWaiters.clear();
    this.pendingGeometries = [];
  }

  private queueGeometry(
    geometry: TerminalLiveGeometry,
    outputSequenceBoundary: bigint,
    resizeSequence?: bigint,
  ): void {
    this.pendingGeometries.push({ geometry, outputSequenceBoundary, resizeSequence });
    this.flushPendingGeometries();
  }

  private flushPendingGeometries(): void {
    if (this.pendingGeometries.length === 0) return;
    const ready: PendingGeometry[] = [];
    const waiting: PendingGeometry[] = [];
    for (const pending of this.pendingGeometries) {
      (pending.outputSequenceBoundary <= this.lastOutputSequence ? ready : waiting).push(pending);
    }
    this.pendingGeometries = waiting;
    ready.sort((left, right) => (
      left.outputSequenceBoundary === right.outputSequenceBoundary
        ? left.geometry.generation - right.geometry.generation
        : left.outputSequenceBoundary < right.outputSequenceBoundary ? -1 : 1
    ));
    for (const pending of ready) {
      this.applyGeometry(pending.geometry);
      if (pending.resizeSequence !== undefined) {
        const waiter = this.resizeWaiters.get(pending.resizeSequence);
        if (!waiter) continue;
        this.resizeWaiters.delete(pending.resizeSequence);
        waiter.resolve();
      }
    }
  }

  private applyGeometry(next: TerminalLiveGeometry): void {
    if (next.generation < this.geometry.generation) return;
    if (next.generation === this.geometry.generation) {
      if (next.cols !== this.geometry.cols || next.rows !== this.geometry.rows) {
        throw new Error('terminal live geometry changed without advancing its generation');
      }
      if (next.outputSequenceBoundary > this.geometry.outputSequenceBoundary) {
        this.geometry = next;
      }
      return;
    }
    this.geometry = next;
    this.onGeometry?.(next);
  }

  private async fail(error: Error): Promise<void> {
    if (this.failed) return;
    this.failed = true;
    this.closed = true;
    this.rejectResizeWaiters(error);
    this.onError?.(error);
    try {
      if (this.stream.reset) await this.stream.reset(error);
      else await this.stream.close();
    } catch {
      // The original protocol error is authoritative.
    }
  }
}

export const connectTerminalLive = async (options: ConnectTerminalLiveOptions): Promise<TerminalLiveConnection> => {
  let stream: TerminalByteStream | null = null;
  try {
    stream = await options.openStream(StreamKind, options.signal ? { signal: options.signal } : undefined);
    await stream.write(encodeAttach({
      sessionId: options.attach.sessionId,
      connectionId: options.attach.connectionId,
      attachGeneration: BigInt(options.attach.attachGeneration),
      cols: options.attach.cols,
      rows: options.attach.rows,
    }));
    const reader = new FrameReader(stream);
    const first = await reader.read();
    if (first == null) throw new Error('terminal live stream ended before attach acknowledgement');
    if (first.type === TerminalLiveFrameType.Error) {
      const protocolError = decodeProtocolError(first);
      throw new TerminalLiveServerError(protocolError.code, protocolError.message);
    }
    if (first.type !== TerminalLiveFrameType.Attached) {
      throw new Error(`invalid terminal live server frame before attach: 0x${first.type.toString(16)}`);
    }
    const connection = new TerminalLiveConnectionImpl(
      stream,
      reader,
      decodeAttached(first),
      options.onOutputBatch,
      options.onGeometry,
      options.onClosed,
      options.onError,
    );
    connection.start();
    return connection;
  } catch (value) {
    const error = value instanceof Error ? value : new Error(String(value));
    options.onError?.(error);
    if (stream) {
      try {
        if (stream.reset) await stream.reset(error);
        else await stream.close();
      } catch {
        // The attach error is authoritative.
      }
    }
    throw error;
  }
};
