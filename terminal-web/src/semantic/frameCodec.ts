import type { SemanticFrame } from './presentation.js';

export function decodeSemanticFrameWire(value: unknown): SemanticFrame {
  const wire = value as any;
  if (!wire || !Array.isArray(wire.styles) || !Array.isArray(wire.rows)) {
    throw new Error('invalid semantic frame wire');
  }
  const styleInverses = wire.styleInverses;
  if (styleInverses !== undefined && (!Array.isArray(styleInverses)
    || styleInverses.length !== wire.styles.length
    || styleInverses.some((inverse: unknown) => typeof inverse !== 'boolean'))) {
    throw new Error('invalid semantic frame inverse styles');
  }
  const styles = wire.styles.map((style: unknown, index: number) => {
    if (!Array.isArray(style) || (style.length !== 5 && style.length !== 6)) {
      throw new Error('invalid semantic frame style');
    }
    return {
      foreground: style[0], background: style[1], bold: style[2], italic: style[3],
      underline: style[4], inverse: style[5] ?? styleInverses?.[index] ?? false,
    };
  });
  return {
    width: wire.width,
    height: wire.height,
    bufferKind: wire.bufferKind,
    cursor: wire.cursor,
    history: wire.history,
    graphics: decodeGraphics(wire.graphics),
    rows: wire.rows.map((row: unknown) => {
      if (!Array.isArray(row)) throw new Error('invalid semantic frame row');
      return {
        cells: row.map((cell: unknown) => {
          if (!Array.isArray(cell) || cell.length !== 4 || !Number.isInteger(cell[2]) || !styles[cell[2]]) {
            throw new Error('invalid semantic frame cell');
          }
          return {
            text: cell[0], width: cell[1], style: styles[cell[2]],
            ...(cell[3] ? { hyperlink: cell[3] } : {}),
          };
        }),
      };
    }),
  } as SemanticFrame;
}

function decodeGraphics(value: unknown): SemanticFrame['graphics'] {
  if (typeof value !== 'object' || value === null) throw new Error('invalid semantic frame graphics');
  const graphics = value as any;
  if (!Array.isArray(graphics.images) || !Array.isArray(graphics.placements)) {
    throw new Error('invalid semantic frame graphics');
  }
  return {
    generation: graphics.generation,
    images: graphics.images.map((image: any) => ({ ...image, pixels: decodeBase64Bytes(image?.pixels) })),
    placements: graphics.placements,
  };
}

function decodeBase64Bytes(value: unknown): Uint8Array {
  if (typeof value !== 'string') throw new Error('invalid semantic frame graphic pixels');
  try {
    if (typeof globalThis.atob === 'function') {
      const decoded = globalThis.atob(value);
      return Uint8Array.from(decoded, character => character.charCodeAt(0));
    }
    return Uint8Array.from((globalThis as any).Buffer.from(value, 'base64'));
  } catch {
    throw new Error('invalid semantic frame graphic pixels');
  }
}
