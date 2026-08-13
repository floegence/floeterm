export type SemanticCell = { text: string; hyperlink?: string; width: number; style?: { foreground?: string; background?: string; bold?: boolean; italic?: boolean; underline?: boolean } };
export type SemanticFrame = {
  width: number;
  height: number;
  bufferKind: string;
  rows: Array<{ cells: SemanticCell[] }>;
  cursor: { x: number; y: number; visible: boolean };
  history: { revision: number; totalRows: number; screenStartOffset: number };
  graphics: SemanticGraphics;
};
export type SemanticGraphicImage = { id: number; width: number; height: number; format: 0 | 1 | 3 | 4; generation: number; pixels: Uint8Array };
export type SemanticGraphicPlacement = { imageId: number; placementId: number; z: number; viewportColumn: number; viewportRow: number; gridColumns: number; gridRows: number; visible: boolean; virtual: boolean };
export type SemanticGraphics = { generation: number; images: SemanticGraphicImage[]; placements: SemanticGraphicPlacement[] };

export type SemanticPresentation = {
  sequence: number;
  geometry: { generation: number; cols: number; rows: number };
  state: { sequence: number; title?: string; bell?: number };
  frame: SemanticFrame;
};

export type SemanticHistoryDirection = 'start' | 'end' | 'forward' | 'backward';
export type SemanticHistoryRequest = Readonly<{
  expectedRevision?: number;
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
  if (!Number.isInteger(p.geometry?.cols) || !Number.isInteger(p.geometry?.rows) || p.geometry.cols < 1 || p.geometry.rows < 1 || p.geometry.cols > MAX_COLS || p.geometry.rows > MAX_ROWS) throw new Error('invalid presentation geometry');
  if (p.frame?.width !== p.geometry.cols || p.frame?.height !== p.geometry.rows || !Array.isArray(p.frame.rows) || p.frame.rows.length !== p.frame.height) throw new Error('presentation frame does not match geometry');
  if (p.frame.history?.revision !== p.sequence || !Number.isSafeInteger(p.frame.history?.totalRows) || p.frame.history.totalRows < p.frame.height || !Number.isSafeInteger(p.frame.history?.screenStartOffset) || p.frame.history.screenStartOffset !== p.frame.history.totalRows - p.frame.height) throw new Error('invalid presentation history summary');
  for (const row of p.frame.rows) {
    if (!Array.isArray(row.cells) || row.cells.length !== p.frame.width) throw new Error('invalid semantic row width');
    for (const cell of row.cells) {
      if (typeof cell.text !== 'string' || cell.text.length > 64 || !Number.isInteger(cell.width) || cell.width < 0 || cell.width > 2) throw new Error('invalid semantic cell');
      for (const color of [cell.style?.foreground, cell.style?.background]) {
        if (color !== undefined && !/^(default|indexed:\d{1,3}|rgb:[0-9a-fA-F]{6})$/.test(color)) throw new Error('invalid semantic color');
      }
    }
  }
  validateGraphics(p.frame.graphics, p.frame.width, p.frame.height);
  return p;
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
  if (page.frame?.history?.revision !== page.revision || page.frame.history.totalRows !== page.totalRows || page.frame.history.screenStartOffset !== page.screenStartOffset) {
    throw new Error('semantic history page summary does not match its frame');
  }
  validatePresentation({
    sequence: Math.max(1, page.revision),
    geometry: { generation: 1, cols: page.frame?.width, rows: page.frame?.height },
    state: { sequence: Math.max(1, page.revision) },
    frame: page.frame,
  });
  return page;
}
