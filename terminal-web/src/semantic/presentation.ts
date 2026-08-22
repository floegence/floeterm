import { decodeSemanticFrameWire } from './frameCodec.js';

export type SemanticCell = { text: string; hyperlink?: string; width: number; style?: { foreground?: string; background?: string; bold?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean } };
export type SemanticCursorShape = 'bar' | 'block' | 'underline' | 'hollow';
export type SemanticFrame = {
  width: number;
  height: number;
  bufferKind: string;
  rows: Array<{ cells: SemanticCell[] }>;
  cursor: { x: number; y: number; visible: boolean; shape: SemanticCursorShape; blinking: boolean; wideTail?: boolean; color?: string };
  history: {
    revision: number;
    totalRows: number;
    screenStartOffset: number;
    historyEpoch?: number;
    firstRowOrdinal?: number;
    screenStartRowOrdinal?: number;
  };
  graphics: SemanticGraphics;
};
export type SemanticGraphicImage = { id: number; width: number; height: number; format: 0 | 1 | 3 | 4; generation: number; pixels: Uint8Array };
export type SemanticGraphicPlacement = { imageId: number; placementId: number; z: number; viewportColumn: number; viewportRow: number; gridColumns: number; gridRows: number; visible: boolean; virtual: boolean };
export type SemanticGraphics = { generation: number; images: SemanticGraphicImage[]; placements: SemanticGraphicPlacement[] };

export type SemanticPresentation = {
  sequence: number;
  geometry: { generation: number; cols: number; rows: number };
  state: { sequence: number; contentEpoch?: number; title?: string; bell?: number };
  frame: SemanticFrame;
};

export type SemanticHistoryDirection = 'start' | 'end' | 'forward' | 'backward';
export type SemanticHistoryLane = 'viewport' | 'search';

export type SemanticHistoryErrorKind =
  | 'anchor_invalid'
  | 'transport_stale'
  | 'session_detached'
  | 'attachment_invalid'
  | 'snapshot_superseded'
  | 'malformed_snapshot';

export class SemanticHistoryError extends Error {
  readonly kind: SemanticHistoryErrorKind;

  constructor(kind: SemanticHistoryErrorKind, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'SemanticHistoryError';
    this.kind = kind;
    if (options && 'cause' in options) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

export function isStructuralSemanticHistoryError(error: unknown): error is SemanticHistoryError {
  return error instanceof SemanticHistoryError && (
    error.kind === 'anchor_invalid'
    || error.kind === 'transport_stale'
    || error.kind === 'session_detached'
    || error.kind === 'attachment_invalid'
    || error.kind === 'snapshot_superseded'
  );
}

export type SemanticHistoryRequest = Readonly<{
  /** Stable client request identity used for cancellation, tracing, and isolated prefetch views. */
  requestId?: string;
  /** Demand requests outrank background prefetch; omitted means demand. */
  priority?: 'demand' | 'prefetch';
  /** Local cancellation only; never serialized onto the history wire. */
  signal?: AbortSignal;
  lane?: SemanticHistoryLane;
  anchor?: string;
  snapshotId?: string;
  direction: SemanticHistoryDirection;
  offset?: number;
  scrollDeltaRows?: number;
  targetOffset?: number;
  viewportRows: number;
  /** Internal fast-path marker. The wire request uses viewportRows for the window size. */
  windowRows?: number;
}>;
export type SemanticHistoryChunkRequest = SemanticHistoryRequest | Readonly<{
  continuation: string;
  lane?: SemanticHistoryLane;
  requestId?: string;
  priority?: 'demand' | 'prefetch';
  signal?: AbortSignal;
}>;
export type SemanticHistoryChunk = Readonly<{
  snapshotId: string;
  continuation?: string;
  lane?: SemanticHistoryLane;
  chunkIndex: number;
  chunkCount: number;
  payloadBytes: number;
  payloadSha256: string;
  payload: Uint8Array;
  revision: number;
  transportGeneration: number;
  contentEpoch: number;
  geometryGeneration: number;
  cols: number;
  rows: number;
  anchor: string;
  firstAvailable: string;
  lastAvailable: string;
  screenStart: string;
  offset: number;
  totalRows: number;
  screenStartOffset: number;
  historyEpoch?: number;
  firstRowOrdinal?: number;
  screenStartRowOrdinal?: number;
  hasPrevious: boolean;
  hasNext: boolean;
}>;
export type SemanticHistoryViewport = Readonly<{
  snapshotId: string;
  lane?: SemanticHistoryLane;
  revision: number;
  transportGeneration: number;
  contentEpoch: number;
  geometryGeneration: number;
  cols: number;
  rows: number;
  anchor: string;
  firstAvailable: string;
  lastAvailable: string;
  screenStart: string;
  offset: number;
  totalRows: number;
  screenStartOffset: number;
  historyEpoch?: number;
  firstRowOrdinal?: number;
  screenStartRowOrdinal?: number;
  hasPrevious: boolean;
  hasNext: boolean;
  frame: SemanticFrame;
  window?: boolean;
}>;

export type SemanticHistoryWindow = SemanticHistoryViewport & Readonly<{ window: true }>;

export function presentationAdvances(
  current: SemanticPresentation | null,
  next: SemanticPresentation,
): boolean {
  if (!current) return true;
  if (next.sequence <= current.sequence) return false;
  if ((next.state.contentEpoch ?? 0) < (current.state.contentEpoch ?? 0)) {
    throw new Error('terminal presentation content epoch regressed');
  }
  if (next.geometry.generation < current.geometry.generation) {
    throw new Error('terminal presentation geometry generation regressed');
  }
  if (
    next.geometry.generation === current.geometry.generation
    && (next.geometry.cols !== current.geometry.cols || next.geometry.rows !== current.geometry.rows)
  ) {
    throw new Error('terminal presentation changed geometry without advancing its generation');
  }
  return true;
}

const MAX_COLS = 1000;
const MAX_ROWS = 1000;
export const SEMANTIC_HISTORY_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const SEMANTIC_HISTORY_MAX_CHUNK_BYTES = 60 * 1024;
export const SEMANTIC_HISTORY_MAX_CHUNKS = Math.ceil(
  SEMANTIC_HISTORY_MAX_SNAPSHOT_BYTES / SEMANTIC_HISTORY_MAX_CHUNK_BYTES,
);

export function validatePresentation(value: unknown): SemanticPresentation {
  if (typeof value !== 'object' || value === null) throw new Error('invalid terminal presentation');
  const p = value as SemanticPresentation;
  if (!Number.isSafeInteger(p.sequence) || p.sequence <= 0 || p.state?.sequence !== p.sequence) throw new Error('invalid presentation sequence');
  if (p.state.contentEpoch !== undefined && (!Number.isSafeInteger(p.state.contentEpoch) || p.state.contentEpoch < 0)) throw new Error('invalid presentation content epoch');
  if (!Number.isInteger(p.geometry?.cols) || !Number.isInteger(p.geometry?.rows) || p.geometry.cols < 1 || p.geometry.rows < 1 || p.geometry.cols > MAX_COLS || p.geometry.rows > MAX_ROWS) throw new Error('invalid presentation geometry');
  if (p.frame?.width !== p.geometry.cols || p.frame?.height !== p.geometry.rows || !Array.isArray(p.frame.rows) || p.frame.rows.length !== p.frame.height) throw new Error('presentation frame does not match geometry');
  validateFrame(p.frame);
  validateHistoryIdentity(p.frame.history);
  if (p.frame.history.revision !== p.sequence || p.frame.history.screenStartOffset !== p.frame.history.totalRows - p.frame.height) throw new Error('invalid presentation history summary');
  return p;
}

export function validateFrame(frame: SemanticFrame): void {
  if (!Number.isInteger(frame?.width) || !Number.isInteger(frame?.height) || frame.width < 1 || frame.height < 1 || frame.width > MAX_COLS || frame.height > MAX_ROWS || !Array.isArray(frame.rows) || frame.rows.length !== frame.height) throw new Error('invalid semantic frame geometry');
  const cursor = frame.cursor;
  if (!cursor || !Number.isInteger(cursor.x) || !Number.isInteger(cursor.y) || cursor.x < 0 || cursor.x >= frame.width || cursor.y < 0 || cursor.y >= frame.height || typeof cursor.visible !== 'boolean' || !['bar', 'block', 'underline', 'hollow'].includes(cursor.shape) || typeof cursor.blinking !== 'boolean' || (cursor.wideTail !== undefined && typeof cursor.wideTail !== 'boolean') || (cursor.color !== undefined && !/^rgb:[0-9a-fA-F]{6}$/.test(cursor.color))) throw new Error('invalid semantic cursor');
  if (!Number.isSafeInteger(frame.history?.revision) || frame.history.revision < 0 || !Number.isSafeInteger(frame.history?.totalRows) || frame.history.totalRows < frame.height || !Number.isSafeInteger(frame.history?.screenStartOffset) || frame.history.screenStartOffset < 0 || frame.history.screenStartOffset >= frame.history.totalRows) throw new Error('invalid semantic history summary');
  validateHistoryIdentity(frame.history);
  for (const row of frame.rows) {
    if (!Array.isArray(row.cells) || row.cells.length !== frame.width) throw new Error('invalid semantic row width');
    for (const cell of row.cells) {
      if (typeof cell.text !== 'string' || cell.text.length > 64 || !Number.isInteger(cell.width) || cell.width < 0 || cell.width > 2) throw new Error('invalid semantic cell');
      for (const color of [cell.style?.foreground, cell.style?.background]) {
        if (color === undefined) continue;
        const indexed = /^indexed:(\d{1,3})$/.exec(color);
        if (color !== 'default' && !/^rgb:[0-9a-fA-F]{6}$/.test(color)
          && !(indexed && Number(indexed[1]) <= 255)) throw new Error('invalid semantic color');
      }
      if (cell.style?.inverse !== undefined && typeof cell.style.inverse !== 'boolean') throw new Error('invalid semantic inverse style');
    }
  }
  validateGraphics(frame.graphics, frame.width, frame.height);
}

function validateGraphics(graphics: SemanticGraphics, frameWidth: number, frameHeight: number): void {
  if (!graphics || !Number.isSafeInteger(graphics.generation) || graphics.generation < 0 || !Array.isArray(graphics.images) || !Array.isArray(graphics.placements)) {
    throw new Error('invalid semantic graphics inventory');
  }
  const images = new Map<number, SemanticGraphicImage>();
  for (const image of graphics.images) {
    if (!Number.isInteger(image.id) || image.id <= 0 || images.has(image.id) || !Number.isInteger(image.width) || image.width <= 0 || !Number.isInteger(image.height) || image.height <= 0 || !Number.isSafeInteger(image.generation) || image.generation < 0) {
      throw new Error('invalid semantic graphic image');
    }
    const channels = image.format === 0 ? 3 : image.format === 1 ? 4 : image.format === 3 ? 2 : image.format === 4 ? 1 : 0;
    if (channels === 0) throw new Error('invalid semantic graphic format');
    const expected = image.width * image.height * channels;
    if (!Number.isSafeInteger(expected) || !(image.pixels instanceof Uint8Array) || image.pixels.byteLength !== expected) throw new Error('invalid semantic graphic pixels');
    images.set(image.id, image);
  }
  for (const placement of graphics.placements) {
    const right = placement.viewportColumn + placement.gridColumns;
    const bottom = placement.viewportRow + placement.gridRows;
    if (!images.has(placement.imageId) || !Number.isInteger(placement.placementId) || placement.placementId < 0 || !Number.isInteger(placement.z) || !Number.isInteger(placement.viewportColumn) || !Number.isInteger(placement.viewportRow) || !Number.isInteger(placement.gridColumns) || placement.gridColumns <= 0 || !Number.isInteger(placement.gridRows) || placement.gridRows <= 0 || typeof placement.visible !== 'boolean' || typeof placement.virtual !== 'boolean' || (placement.visible && (right <= 0 || bottom <= 0 || placement.viewportColumn >= frameWidth || placement.viewportRow >= frameHeight))) {
      throw new Error('invalid semantic graphic placement');
    }
  }
}

export function validateHistoryChunk(value: unknown): SemanticHistoryChunk {
  if (typeof value !== 'object' || value === null) throw new Error('invalid semantic history chunk');
  const wire = value as any;
  const payload = decodeHistoryPayload(wire.payload);
  const chunk = { ...wire, lane: wire.lane ?? 'viewport', payload } as SemanticHistoryChunk;
  for (const identifier of [chunk.snapshotId, chunk.anchor, chunk.firstAvailable, chunk.lastAvailable, chunk.screenStart]) {
    if (typeof identifier !== 'string' || identifier.length === 0 || identifier.length > 192) {
      throw new Error('invalid semantic history anchor');
    }
  }
  if (chunk.continuation !== undefined && (typeof chunk.continuation !== 'string' || chunk.continuation.length === 0 || chunk.continuation.length > 192)) {
    throw new Error('invalid semantic history continuation');
  }
  if (chunk.lane !== 'viewport' && chunk.lane !== 'search') {
    throw new Error('invalid semantic history lane');
  }
  for (const [name, number] of Object.entries({
    revision: chunk.revision,
    transportGeneration: chunk.transportGeneration,
    contentEpoch: chunk.contentEpoch,
    geometryGeneration: chunk.geometryGeneration,
    cols: chunk.cols,
    rows: chunk.rows,
    chunkIndex: chunk.chunkIndex,
    chunkCount: chunk.chunkCount,
    payloadBytes: chunk.payloadBytes,
    offset: chunk.offset,
    totalRows: chunk.totalRows,
    screenStartOffset: chunk.screenStartOffset,
  })) {
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid semantic history ${name}`);
  }
  if (chunk.transportGeneration <= 0 || chunk.geometryGeneration <= 0
    || chunk.cols <= 0 || chunk.cols > MAX_COLS || chunk.rows <= 0 || chunk.rows > MAX_ROWS
    || chunk.chunkCount <= 0 || chunk.chunkCount > SEMANTIC_HISTORY_MAX_CHUNKS || chunk.chunkIndex >= chunk.chunkCount
    || chunk.payloadBytes <= 0 || chunk.payloadBytes > SEMANTIC_HISTORY_MAX_SNAPSHOT_BYTES
    || payload.byteLength <= 0 || payload.byteLength > SEMANTIC_HISTORY_MAX_CHUNK_BYTES
    || typeof chunk.payloadSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(chunk.payloadSha256)) {
    throw new Error('invalid semantic history chunk metadata');
  }
  if (chunk.totalRows < chunk.rows || chunk.offset + chunk.rows > chunk.totalRows
    || chunk.screenStartOffset !== chunk.totalRows - chunk.rows
    || typeof chunk.hasPrevious !== 'boolean' || typeof chunk.hasNext !== 'boolean'
    || chunk.hasPrevious !== (chunk.offset > 0)
    || chunk.hasNext !== (chunk.offset < chunk.screenStartOffset)
    || (chunk.chunkIndex + 1 < chunk.chunkCount) !== Boolean(chunk.continuation)) {
    throw new Error('invalid semantic history bounds');
  }
  validateHistoryIdentity(chunk);
  return chunk;
}

export async function assembleHistoryViewport(chunks: readonly SemanticHistoryChunk[]): Promise<SemanticHistoryViewport> {
  return validateHistoryViewport(await assembleHistorySnapshot(chunks));
}

export async function assembleHistoryWindow(chunks: readonly SemanticHistoryChunk[]): Promise<SemanticHistoryWindow> {
  return validateHistoryWindow(await assembleHistorySnapshot(chunks));
}

async function assembleHistorySnapshot(chunks: readonly SemanticHistoryChunk[]): Promise<SemanticHistoryViewport> {
  if (chunks.length === 0) throw new Error('semantic history snapshot has no chunks');
  const first = chunks[0]!;
  if (first.chunkIndex !== 0 || first.chunkCount > SEMANTIC_HISTORY_MAX_CHUNKS || chunks.length !== first.chunkCount) throw new Error('semantic history snapshot is incomplete');
  const signature = historyChunkSignature(first);
  let size = 0;
  const continuations = new Set<string>();
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    if (chunk.chunkIndex !== index || historyChunkSignature(chunk) !== signature) {
      throw new Error('semantic history snapshot chunks do not match');
    }
    if (chunk.continuation && continuations.has(chunk.continuation)) throw new Error('semantic history snapshot continuation repeated');
    if (chunk.continuation) continuations.add(chunk.continuation);
    size += chunk.payload.byteLength;
    if (size > SEMANTIC_HISTORY_MAX_SNAPSHOT_BYTES || size > first.payloadBytes) throw new Error('semantic history snapshot exceeds its declared size');
  }
  if (size !== first.payloadBytes) throw new Error('semantic history snapshot size does not match');
  const payload = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk.payload, offset);
    offset += chunk.payload.byteLength;
  }
  const digest = await sha256Hex(payload);
  if (digest !== first.payloadSha256) throw new Error('semantic history snapshot integrity check failed');
  const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) as any;
  if (decoded?.v !== 1) throw new Error('invalid semantic history snapshot wire');
  return {
    snapshotId: first.snapshotId,
    lane: first.lane,
    revision: first.revision,
    transportGeneration: first.transportGeneration,
    contentEpoch: first.contentEpoch,
    geometryGeneration: first.geometryGeneration,
    cols: first.cols,
    rows: first.rows,
    anchor: first.anchor,
    firstAvailable: first.firstAvailable,
    lastAvailable: first.lastAvailable,
    screenStart: first.screenStart,
    offset: first.offset,
    totalRows: first.totalRows,
    screenStartOffset: first.screenStartOffset,
    historyEpoch: first.historyEpoch,
    firstRowOrdinal: first.firstRowOrdinal,
    screenStartRowOrdinal: first.screenStartRowOrdinal,
    hasPrevious: first.hasPrevious,
    hasNext: first.hasNext,
    frame: decodeSemanticFrameWire(decoded.frame),
  };
}

export function validateHistoryViewport(value: unknown): SemanticHistoryViewport {
  if (typeof value !== 'object' || value === null) throw new Error('invalid semantic history viewport');
  const wire = value as SemanticHistoryViewport;
  const viewport = { ...wire, lane: wire.lane ?? 'viewport' } as SemanticHistoryViewport;
  if (viewport.window === true) throw new Error('semantic history window requires window validation');
  if (viewport.lane !== 'viewport' && viewport.lane !== 'search') {
    throw new Error('invalid semantic history viewport lane');
  }
  for (const identifier of [viewport.snapshotId, viewport.anchor, viewport.firstAvailable, viewport.lastAvailable, viewport.screenStart]) {
    if (typeof identifier !== 'string' || identifier.length === 0 || identifier.length > 192) {
      throw new Error('invalid semantic history viewport anchor');
    }
  }
  for (const [name, number] of Object.entries({
    revision: viewport.revision,
    transportGeneration: viewport.transportGeneration,
    contentEpoch: viewport.contentEpoch,
    geometryGeneration: viewport.geometryGeneration,
    cols: viewport.cols,
    rows: viewport.rows,
    offset: viewport.offset,
    totalRows: viewport.totalRows,
    screenStartOffset: viewport.screenStartOffset,
  })) {
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid semantic history viewport ${name}`);
  }
  if (viewport.transportGeneration <= 0 || viewport.geometryGeneration <= 0
    || viewport.cols < 1 || viewport.cols > MAX_COLS || viewport.rows < 1 || viewport.rows > MAX_ROWS
    || viewport.totalRows < viewport.rows || viewport.offset + viewport.rows > viewport.totalRows
    || viewport.screenStartOffset !== viewport.totalRows - viewport.rows
    || typeof viewport.hasPrevious !== 'boolean' || typeof viewport.hasNext !== 'boolean'
    || viewport.hasPrevious !== (viewport.offset > 0)
    || viewport.hasNext !== (viewport.offset < viewport.screenStartOffset)) {
    throw new Error('invalid semantic history viewport bounds');
  }
  validateHistoryIdentity(viewport);
  validateFrame(viewport.frame);
  if (viewport.frame.width !== viewport.cols || viewport.frame.height !== viewport.rows
    || viewport.frame.rows.length !== viewport.rows
    || viewport.frame.history.revision !== viewport.revision
    || viewport.frame.history.totalRows !== viewport.totalRows
    || viewport.frame.history.screenStartOffset !== viewport.screenStartOffset) {
    throw new Error('semantic history viewport geometry does not match its frame');
  }
  return viewport;
}

export function validateHistoryWindow(value: unknown): SemanticHistoryWindow {
  if (typeof value !== 'object' || value === null) throw new Error('invalid semantic history window');
  const wire = value as SemanticHistoryWindow;
  const window = { ...wire, lane: wire.lane ?? 'viewport', window: true } as SemanticHistoryWindow;
  if (window.lane !== 'viewport' && window.lane !== 'search') throw new Error('invalid semantic history window lane');
  for (const identifier of [window.snapshotId, window.anchor, window.firstAvailable, window.lastAvailable, window.screenStart]) {
    if (typeof identifier !== 'string' || identifier.length === 0 || identifier.length > 192) throw new Error('invalid semantic history window anchor');
  }
  for (const [name, number] of Object.entries({
    revision: window.revision,
    transportGeneration: window.transportGeneration,
    contentEpoch: window.contentEpoch,
    geometryGeneration: window.geometryGeneration,
    cols: window.cols,
    rows: window.rows,
    offset: window.offset,
    totalRows: window.totalRows,
    screenStartOffset: window.screenStartOffset,
  })) {
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid semantic history window ${name}`);
  }
  if (window.transportGeneration <= 0 || window.geometryGeneration <= 0
    || window.cols < 1 || window.cols > MAX_COLS || window.rows < 1 || window.rows > MAX_ROWS
    || window.totalRows < window.rows || window.offset + window.rows > window.totalRows
    || window.screenStartOffset !== window.totalRows - window.rows
    || typeof window.hasPrevious !== 'boolean' || typeof window.hasNext !== 'boolean'
    || window.hasPrevious !== (window.offset > 0)
    || window.hasNext !== (window.offset < window.screenStartOffset)) {
    throw new Error('invalid semantic history window bounds');
  }
  validateHistoryIdentity(window);
  validateFrame(window.frame);
  if (window.frame.width !== window.cols || window.frame.height !== window.rows
    || window.frame.rows.length !== window.rows
    || window.frame.history.revision !== window.revision
    || window.frame.history.totalRows !== window.totalRows
    || window.frame.history.screenStartOffset !== window.screenStartOffset) {
    throw new Error('semantic history window geometry does not match its frame');
  }
  return window;
}

function decodeHistoryPayload(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0 || value.byteLength > SEMANTIC_HISTORY_MAX_CHUNK_BYTES) {
      throw new Error('invalid semantic history chunk payload');
    }
    return value.slice();
  }
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid semantic history chunk payload');
  const maxBase64Length = Math.ceil(SEMANTIC_HISTORY_MAX_CHUNK_BYTES / 3) * 4;
  if (value.length > maxBase64Length) throw new Error('invalid semantic history chunk payload');
  try {
    if (typeof globalThis.atob === 'function') {
      const decoded = globalThis.atob(value);
      return Uint8Array.from(decoded, character => character.charCodeAt(0));
    }
    return Uint8Array.from((globalThis as any).Buffer.from(value, 'base64'));
  } catch {
    throw new Error('invalid semantic history chunk payload');
  }
}

function historyChunkSignature(chunk: SemanticHistoryChunk): string {
  return JSON.stringify([
    chunk.snapshotId, chunk.lane ?? 'viewport', chunk.chunkCount, chunk.payloadBytes, chunk.payloadSha256,
    chunk.revision, chunk.transportGeneration, chunk.contentEpoch, chunk.geometryGeneration,
    chunk.cols, chunk.rows, chunk.anchor, chunk.firstAvailable, chunk.lastAvailable,
    chunk.screenStart, chunk.offset, chunk.totalRows, chunk.screenStartOffset,
    chunk.historyEpoch, chunk.firstRowOrdinal, chunk.screenStartRowOrdinal,
    chunk.hasPrevious, chunk.hasNext,
  ]);
}

function validateHistoryIdentity(value: Readonly<{
  historyEpoch?: number;
  firstRowOrdinal?: number;
  screenStartRowOrdinal?: number;
  totalRows: number;
  screenStartOffset: number;
}>): void {
  const fields = [value.historyEpoch, value.firstRowOrdinal, value.screenStartRowOrdinal];
  if (fields.every(field => field === undefined)) return;
  if (fields.some(field => !Number.isSafeInteger(field) || (field as number) < 0)
    || value.historyEpoch === 0
    || value.screenStartRowOrdinal !== (value.firstRowOrdinal as number) + value.screenStartOffset
    || (value.firstRowOrdinal as number) + value.totalRows > Number.MAX_SAFE_INTEGER) {
    throw new Error('invalid semantic history identity');
  }
}

async function sha256Hex(payload: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable for semantic history validation');
  const source = payload.slice().buffer;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', source));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
