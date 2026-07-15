import type { Logger } from '../types.js';
import { BeamtermFabricRenderer } from './BeamtermFabricRenderer.js';
import {
  getTerminalFabricDiagnostics,
  terminalFabricCoordinator,
} from './TerminalFabricCoordinator.js';
import type {
  TerminalFabricCell,
  TerminalFabricColor,
  TerminalFabricCursor,
  TerminalFabricDiagnostics,
  TerminalFabricFrameReason,
  TerminalFabricRenderer,
  TerminalFabricTheme,
} from './types.js';

type GhosttyCellLike = {
  codepoint?: number;
  fg_r?: number;
  fg_g?: number;
  fg_b?: number;
  bg_r?: number;
  bg_g?: number;
  bg_b?: number;
  flags?: number;
  width?: number;
  grapheme_len?: number;
  hyperlink_id?: number;
};

type GhosttyRendererLike = {
  currentBuffer?: {
    getGraphemeString?: (row: number, col: number) => string;
  } | null;
};

type TerminalFabricSelectionRange = {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
};

type TerminalFabricHoverRange = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

export type TerminalFabricRowRenderHints = {
  selection?: (TerminalFabricSelectionRange & {
    foreground: TerminalFabricColor;
    background: TerminalFabricColor;
  }) | null;
  hover?: {
    hyperlinkId?: number;
    range?: TerminalFabricHoverRange | null;
  } | null;
};

type TerminalLiveFabricSession = {
  sessionId: string;
  refCount: number;
};

type TerminalLiveFabricView = {
  viewId: string;
  sessionId: string;
  renderer: TerminalFabricRenderer;
};

export type TerminalLiveFabricRendererFactory = (request: {
  viewId: string;
}) => TerminalFabricRenderer;

export type TerminalLiveFabricAttachRequest = {
  sessionId: string;
  viewId: string;
  container: HTMLElement;
  logger: Logger;
  fontFamily: string;
  fontSize: number;
  theme: Record<string, string>;
  getGhosttyCanvas: () => HTMLCanvasElement | null;
  focusInputSurface: () => void;
  forwardWheel: (event: WheelEvent) => void;
};

export type TerminalLiveFabricOptions = {
  createRenderer?: TerminalLiveFabricRendererFactory;
};

export type TerminalLiveFabricViewHandle = {
  viewId: string;
  sessionId: string;
  renderer: TerminalFabricRenderer;
  dispose(): void;
};

export class TerminalLiveFabric {
  private readonly sessions = new Map<string, TerminalLiveFabricSession>();
  private readonly views = new Map<string, TerminalLiveFabricView>();
  private readonly createRenderer: TerminalLiveFabricRendererFactory;

  constructor(options: TerminalLiveFabricOptions = {}) {
    this.createRenderer = options.createRenderer ?? defaultRendererFactory;
  }

  async attachView(request: TerminalLiveFabricAttachRequest): Promise<TerminalLiveFabricViewHandle> {
    const session = this.sessions.get(request.sessionId) ?? {
      sessionId: request.sessionId,
      refCount: 0,
    };
    session.refCount += 1;
    this.sessions.set(session.sessionId, session);

    const renderer = this.createRenderer({ viewId: request.viewId });
    try {
      await renderer.initialize({
        container: request.container,
        logger: request.logger,
        fontFamily: request.fontFamily,
        fontSize: request.fontSize,
        theme: request.theme,
        getGhosttyCanvas: request.getGhosttyCanvas,
        focusInputSurface: request.focusInputSurface,
        forwardWheel: request.forwardWheel,
      });
    } catch (error) {
      this.releaseSession(session.sessionId);
      terminalFabricCoordinator.noteFallback(error);
      request.logger.warn('[TerminalLiveFabric] Beamterm renderer unavailable; keeping live canvas fallback', { error });
      throw error;
    }

    const view = {
      viewId: request.viewId,
      sessionId: request.sessionId,
      renderer,
    };
    this.views.set(view.viewId, view);

    return {
      viewId: view.viewId,
      sessionId: view.sessionId,
      renderer,
      dispose: () => {
        this.detachView(view.viewId);
      },
    };
  }

  detachView(viewId: string): void {
    const view = this.views.get(viewId);
    if (!view) {
      return;
    }
    this.views.delete(viewId);
    view.renderer.dispose();
    this.releaseSession(view.sessionId);
  }

  private releaseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.refCount -= 1;
    if (session.refCount <= 0) {
      this.sessions.delete(session.sessionId);
    }
  }

  getDiagnostics(): TerminalFabricDiagnostics {
    return getTerminalFabricDiagnostics();
  }

  dispose(): void {
    for (const viewId of Array.from(this.views.keys())) {
      this.detachView(viewId);
    }
    this.sessions.clear();
  }
}

export const terminalLiveFabric = new TerminalLiveFabric();

function defaultRendererFactory({ viewId }: {
  viewId: string;
}): TerminalFabricRenderer {
  void viewId;
  return new BeamtermFabricRenderer();
}

export const mapGhosttyRowToFabricCells = (
  renderer: GhosttyRendererLike,
  row: number,
  cells: GhosttyCellLike[],
  cols: number,
  hints: TerminalFabricRowRenderHints = {},
): TerminalFabricCell[] => {
  const mapped: TerminalFabricCell[] = [];
  for (let col = 0; col < cols; col += 1) {
    const cell = cells[col] ?? {};
    const selected = isCellInSelection(row, col, hints.selection);
    const hovered = isCellHovered(row, col, cell, hints.hover);
    const attrs = {
      bold: hasFlag(cell, 1),
      italic: hasFlag(cell, 2),
      underline: hasFlag(cell, 4) || hovered,
      strikethrough: hasFlag(cell, 8),
      inverse: selected ? false : hasFlag(cell, 16),
      invisible: hasFlag(cell, 32),
      faint: hasFlag(cell, 128),
    };
    mapped[col] = {
      symbol: resolveCellSymbol(renderer, cell, row, col),
      width: Number(cell.width ?? 1) || 1,
      fg: selected
        ? hints.selection!.foreground
        : colorFromCell(cell, 'fg', { r: 255, g: 255, b: 255 }),
      bg: selected
        ? hints.selection!.background
        : colorFromCell(cell, 'bg', { r: 0, g: 0, b: 0 }),
      attrs,
    };
  }
  return mapped;
};

export const themeToFabricTheme = (theme: Record<string, string>): TerminalFabricTheme => ({
  background: parseThemeColor(theme.background, 0x000000),
  foreground: parseThemeColor(theme.foreground, 0xffffff),
});

export const cursorToFabricCursor = (value: unknown): TerminalFabricCursor | null => {
  const raw = value as Partial<TerminalFabricCursor> | null | undefined;
  if (!raw || typeof raw.x !== 'number' || typeof raw.y !== 'number') {
    return null;
  }
  return {
    x: raw.x,
    y: raw.y,
    visible: raw.visible !== false,
  };
};

export const renderReasonFromForce = (forceAll: boolean): TerminalFabricFrameReason => (
  forceAll ? 'external' : 'write'
);

const resolveCellSymbol = (
  renderer: GhosttyRendererLike,
  cell: GhosttyCellLike,
  row: number,
  col: number,
): string => {
  if ((cell.grapheme_len ?? 0) > 0) {
    const grapheme = renderer.currentBuffer?.getGraphemeString?.(row, col);
    if (grapheme) {
      return grapheme;
    }
  }
  const codepoint = Number(cell.codepoint ?? 32);
  if (!Number.isFinite(codepoint) || codepoint <= 0) {
    return ' ';
  }
  try {
    return String.fromCodePoint(codepoint);
  } catch {
    return ' ';
  }
};

const colorFromCell = (
  cell: GhosttyCellLike,
  prefix: 'fg' | 'bg',
  fallback: TerminalFabricColor,
): TerminalFabricColor => {
  const r = Number(cell[`${prefix}_r`]);
  const g = Number(cell[`${prefix}_g`]);
  const b = Number(cell[`${prefix}_b`]);
  if (![r, g, b].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return fallback;
  }
  return { r, g, b };
};

const hasFlag = (cell: GhosttyCellLike, flag: number): boolean => (
  (Number(cell.flags ?? 0) & flag) !== 0
);

const isCellInSelection = (
  row: number,
  col: number,
  selection: TerminalFabricRowRenderHints['selection'],
): boolean => {
  if (!selection) {
    return false;
  }
  if (selection.startRow === selection.endRow) {
    return row === selection.startRow && col >= selection.startCol && col <= selection.endCol;
  }
  if (row === selection.startRow) {
    return col >= selection.startCol;
  }
  if (row === selection.endRow) {
    return col <= selection.endCol;
  }
  return row > selection.startRow && row < selection.endRow;
};

const isCellHovered = (
  row: number,
  col: number,
  cell: GhosttyCellLike,
  hover: TerminalFabricRowRenderHints['hover'],
): boolean => {
  if (!hover) {
    return false;
  }
  const hoverId = Number(hover.hyperlinkId ?? 0);
  if (hoverId > 0 && Number(cell.hyperlink_id ?? 0) === hoverId) {
    return true;
  }
  const range = hover.range;
  if (!range) {
    return false;
  }
  if (row === range.startY && row === range.endY) {
    return col >= range.startX && col <= range.endX;
  }
  if (row === range.startY) {
    return col >= range.startX;
  }
  if (row === range.endY) {
    return col <= range.endX;
  }
  return row > range.startY && row < range.endY;
};

const parseThemeColor = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const trimmed = value.trim();
  const shortHex = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortHex) {
    const [r, g, b] = shortHex[1].split('');
    return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  const longHex = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (longHex) {
    return Number.parseInt(longHex[1], 16);
  }
  return fallback;
};
