export type SemanticCell = { text: string; hyperlink?: string; width: number; style?: { foreground?: string; background?: string; bold?: boolean; italic?: boolean; underline?: boolean } };
export type SemanticPresentation = {
  sequence: number;
  geometry: { generation: number; cols: number; rows: number };
  state: { sequence: number; title?: string; bell?: number };
  frame: { width: number; height: number; bufferKind: string; rows: Array<{ cells: SemanticCell[] }>; cursor: { x: number; y: number; visible: boolean } };
};

const MAX_COLS = 1000;
const MAX_ROWS = 1000;

export function validatePresentation(value: unknown): SemanticPresentation {
  if (typeof value !== 'object' || value === null) throw new Error('invalid terminal presentation');
  const p = value as SemanticPresentation;
  if (!Number.isSafeInteger(p.sequence) || p.sequence <= 0 || p.state?.sequence !== p.sequence) throw new Error('invalid presentation sequence');
  if (!Number.isInteger(p.geometry?.cols) || !Number.isInteger(p.geometry?.rows) || p.geometry.cols < 1 || p.geometry.rows < 1 || p.geometry.cols > MAX_COLS || p.geometry.rows > MAX_ROWS) throw new Error('invalid presentation geometry');
  if (p.frame?.width !== p.geometry.cols || p.frame?.height !== p.geometry.rows || !Array.isArray(p.frame.rows) || p.frame.rows.length !== p.frame.height) throw new Error('presentation frame does not match geometry');
  for (const row of p.frame.rows) {
    if (!Array.isArray(row.cells) || row.cells.length !== p.frame.width) throw new Error('invalid semantic row width');
    for (const cell of row.cells) {
      if (typeof cell.text !== 'string' || cell.text.length > 64 || !Number.isInteger(cell.width)) throw new Error('invalid semantic cell');
      for (const color of [cell.style?.foreground, cell.style?.background]) {
        if (color !== undefined && !/^(default|indexed:\d{1,3}|rgb:[0-9a-fA-F]{6})$/.test(color)) throw new Error('invalid semantic color');
      }
    }
  }
  return p;
}
