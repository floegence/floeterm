export type SemanticCell = { text: string; hyperlink?: string; width: number; style?: { foreground?: string; background?: string; bold?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean } };
export type SemanticCursorShape = 'bar' | 'block' | 'underline' | 'hollow';
export type SemanticFrame = {
  width: number;
  height: number;
  bufferKind: string;
  rows: Array<{ cells: SemanticCell[] }>;
  cursor: { x: number; y: number; visible: boolean; shape: SemanticCursorShape; blinking: boolean; wideTail?: boolean; color?: string };
  history: { revision: number; totalRows: number; screenStartOffset: number };
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
export type SemanticHistoryRequest = Readonly<{
  anchor?: string;
  direction: SemanticHistoryDirection;
  limit: number;
}>;
export type SemanticHistoryPage = Readonly<{
  revision: number;
  anchor: string;
  firstAvailable: string;
  lastAvailable: string;
  screenStart: string;
  offset: number;
  totalRows: number;
  screenStartOffset: number;
  hasPrevious: boolean;
  hasNext: boolean;
  frame: SemanticFrame;
}>;

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

export function validatePresentation(value: unknown): SemanticPresentation {
  if (typeof value !== 'object' || value === null) throw new Error('invalid terminal presentation');
  const p = value as SemanticPresentation;
  if (!Number.isSafeInteger(p.sequence) || p.sequence <= 0 || p.state?.sequence !== p.sequence) throw new Error('invalid presentation sequence');
  if (p.state.contentEpoch !== undefined && (!Number.isSafeInteger(p.state.contentEpoch) || p.state.contentEpoch < 0)) throw new Error('invalid presentation content epoch');
  if (!Number.isInteger(p.geometry?.cols) || !Number.isInteger(p.geometry?.rows) || p.geometry.cols < 1 || p.geometry.rows < 1 || p.geometry.cols > MAX_COLS || p.geometry.rows > MAX_ROWS) throw new Error('invalid presentation geometry');
  if (p.frame?.width !== p.geometry.cols || p.frame?.height !== p.geometry.rows || !Array.isArray(p.frame.rows) || p.frame.rows.length !== p.frame.height) throw new Error('presentation frame does not match geometry');
  validateFrame(p.frame);
  if (p.frame.history.revision !== p.sequence || p.frame.history.screenStartOffset !== p.frame.history.totalRows - p.frame.height) throw new Error('invalid presentation history summary');
  return p;
}

function validateFrame(frame: SemanticFrame): void {
  if (!Number.isInteger(frame?.width) || !Number.isInteger(frame?.height) || frame.width < 1 || frame.height < 1 || frame.width > MAX_COLS || frame.height > MAX_ROWS || !Array.isArray(frame.rows) || frame.rows.length !== frame.height) throw new Error('invalid semantic frame geometry');
  const cursor = frame.cursor;
  if (!cursor || !Number.isInteger(cursor.x) || !Number.isInteger(cursor.y) || cursor.x < 0 || cursor.x >= frame.width || cursor.y < 0 || cursor.y >= frame.height || typeof cursor.visible !== 'boolean' || !['bar', 'block', 'underline', 'hollow'].includes(cursor.shape) || typeof cursor.blinking !== 'boolean' || (cursor.wideTail !== undefined && typeof cursor.wideTail !== 'boolean') || (cursor.color !== undefined && !/^rgb:[0-9a-fA-F]{6}$/.test(cursor.color))) throw new Error('invalid semantic cursor');
  if (!Number.isSafeInteger(frame.history?.revision) || frame.history.revision < 0 || !Number.isSafeInteger(frame.history?.totalRows) || frame.history.totalRows < frame.height || !Number.isSafeInteger(frame.history?.screenStartOffset) || frame.history.screenStartOffset < 0 || frame.history.screenStartOffset >= frame.history.totalRows) throw new Error('invalid semantic history summary');
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

export function validateHistoryPage(value: unknown): SemanticHistoryPage {
  if (typeof value !== 'object' || value === null) throw new Error('invalid semantic history page');
  const page = value as SemanticHistoryPage;
  for (const [name, number] of Object.entries({ revision: page.revision, offset: page.offset, totalRows: page.totalRows, screenStartOffset: page.screenStartOffset })) {
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid semantic history ${name}`);
  }
  for (const anchor of [page.anchor, page.firstAvailable, page.lastAvailable, page.screenStart]) {
    if (typeof anchor !== 'string' || anchor.length === 0 || anchor.length > 128) throw new Error('invalid semantic history anchor');
  }
  if (page.totalRows <= 0 || page.offset >= page.totalRows || page.screenStartOffset >= page.totalRows || typeof page.hasPrevious !== 'boolean' || typeof page.hasNext !== 'boolean') {
    throw new Error('invalid semantic history bounds');
  }
  validateFrame(page.frame);
  if (page.offset + page.frame.height > page.totalRows) throw new Error('invalid semantic history page geometry');
  if (page.frame?.history?.revision !== page.revision || page.frame.history.totalRows !== page.totalRows || page.frame.history.screenStartOffset !== page.screenStartOffset) {
    throw new Error('semantic history page summary does not match its frame');
  }
  return page;
}
