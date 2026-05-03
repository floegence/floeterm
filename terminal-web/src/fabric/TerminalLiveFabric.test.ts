import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../types';
import type { TerminalFabricRenderer } from './types';
import {
  cursorToFabricCursor,
  mapGhosttyRowToFabricCells,
  TerminalLiveFabric,
  themeToFabricTheme,
} from './TerminalLiveFabric';
import { createStyle, type BeamtermModule } from './BeamtermFabricRenderer';

const createLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const createRenderer = (overrides: Partial<TerminalFabricRenderer> = {}): TerminalFabricRenderer => ({
  backend: 'beamterm_webgl2',
  renderPath: 'main_thread_webgl2',
  initialize: vi.fn().mockResolvedValue(undefined),
  isActive: vi.fn(() => true),
  startFrame: vi.fn(),
  writeRow: vi.fn(),
  finishFrame: vi.fn(() => ({ rendered: true, renderedRows: 1, dirtyCells: 1 })),
  resize: vi.fn(),
  getGeometry: vi.fn(() => null),
  setAppearance: vi.fn(),
  setVisible: vi.fn(),
  loseContextForTest: vi.fn(),
  getDiagnostics: vi.fn(),
  dispose: vi.fn(),
  ...overrides,
});

describe('TerminalLiveFabric mapping helpers', () => {
  it('maps ghostty cells into Beamterm-ready fabric cells', () => {
    const cells = mapGhosttyRowToFabricCells(
      {
        currentBuffer: {
          getGraphemeString: (_row, col) => (col === 1 ? '中' : ''),
        },
      },
      4,
      [
        {
          codepoint: 65,
          fg_r: 10,
          fg_g: 20,
          fg_b: 30,
          bg_r: 1,
          bg_g: 2,
          bg_b: 3,
          flags: 1 | 4,
          width: 1,
          grapheme_len: 0,
        },
        {
          codepoint: 32,
          fg_r: 200,
          fg_g: 210,
          fg_b: 220,
          bg_r: 40,
          bg_g: 50,
          bg_b: 60,
          flags: 2,
          width: 2,
          grapheme_len: 1,
        },
      ],
      3,
    );

    expect(cells).toHaveLength(3);
    expect(cells[0]).toMatchObject({
      symbol: 'A',
      width: 1,
      fg: { r: 10, g: 20, b: 30 },
      bg: { r: 1, g: 2, b: 3 },
      attrs: { bold: true, underline: true },
    });
    expect(cells[1]).toMatchObject({
      symbol: '中',
      width: 2,
      fg: { r: 200, g: 210, b: 220 },
      bg: { r: 40, g: 50, b: 60 },
      attrs: { italic: true },
    });
    expect(cells[2]).toMatchObject({
      symbol: ' ',
      width: 1,
      fg: { r: 255, g: 255, b: 255 },
      bg: { r: 0, g: 0, b: 0 },
    });
  });

  it('normalizes theme colors and cursor payloads', () => {
    expect(themeToFabricTheme({ background: '#123', foreground: '#aabbcc' })).toEqual({
      background: 0x112233,
      foreground: 0xaabbcc,
    });
    expect(cursorToFabricCursor({ x: 2, y: 5, visible: false })).toEqual({
      x: 2,
      y: 5,
      visible: false,
    });
    expect(cursorToFabricCursor({ x: 2 })).toBeNull();
  });

  it('does not retain failed attach attempts as live sessions', async () => {
    const dispose = vi.fn();
    const fabric = new TerminalLiveFabric({
      createRenderer: () => createRenderer({
        initialize: vi.fn().mockRejectedValue(new Error('webgl unavailable')),
        dispose,
      }),
    });

    await expect(fabric.attachView({
      sessionId: 'session-a',
      viewId: 'view-a',
      container: { closest: vi.fn(() => null) } as unknown as HTMLElement,
      logger: createLogger(),
      fontFamily: 'monospace',
      fontSize: 12,
      theme: { background: '#000000', foreground: '#ffffff' },
      getGhosttyCanvas: () => null,
      focusInputSurface: vi.fn(),
      forwardWheel: vi.fn(),
    })).rejects.toThrow('webgl unavailable');

    fabric.dispose();

    expect(dispose).not.toHaveBeenCalled();
  });

  it('reuses Beamterm style objects for equivalent cells', () => {
    const styleFactory = vi.fn(() => ({
      fg: vi.fn(function fg(this: unknown) { return this; }),
      bg: vi.fn(function bg(this: unknown) { return this; }),
      bold: vi.fn(function bold(this: unknown) { return this; }),
      italic: vi.fn(function italic(this: unknown) { return this; }),
      underline: vi.fn(function underline(this: unknown) { return this; }),
      strikethrough: vi.fn(function strikethrough(this: unknown) { return this; }),
    }));
    const module = {
      style: styleFactory,
    } as unknown as BeamtermModule;
    const cache = new Map<string, ReturnType<BeamtermModule['style']>>();
    const cell = {
      symbol: 'A',
      width: 1,
      fg: { r: 10, g: 20, b: 30 },
      bg: { r: 1, g: 2, b: 3 },
      attrs: { bold: true },
    };

    const first = createStyle(module, cell, { background: 0, foreground: 0xffffff }, cache);
    const second = createStyle(module, { ...cell, symbol: 'B' }, { background: 0, foreground: 0xffffff }, cache);

    expect(second).toBe(first);
    expect(styleFactory).toHaveBeenCalledTimes(1);
  });

  it('projects selection and hyperlink hover styling into fabric cells', () => {
    const [selected, hovered] = mapGhosttyRowToFabricCells(
      {},
      1,
      [
        {
          codepoint: 65,
          fg_r: 10,
          fg_g: 20,
          fg_b: 30,
          bg_r: 1,
          bg_g: 2,
          bg_b: 3,
          flags: 16,
          width: 1,
          grapheme_len: 0,
        },
        {
          codepoint: 66,
          fg_r: 80,
          fg_g: 90,
          fg_b: 100,
          bg_r: 4,
          bg_g: 5,
          bg_b: 6,
          flags: 0,
          width: 1,
          grapheme_len: 0,
          hyperlink_id: 7,
        },
      ],
      2,
      {
        selection: {
          startCol: 0,
          startRow: 1,
          endCol: 0,
          endRow: 1,
          foreground: { r: 31, g: 35, b: 40 },
          background: { r: 245, g: 230, b: 179 },
        },
        hover: {
          hyperlinkId: 7,
          range: null,
        },
      },
    );

    expect(selected).toMatchObject({
      fg: { r: 31, g: 35, b: 40 },
      bg: { r: 245, g: 230, b: 179 },
      attrs: { inverse: false },
    });
    expect(hovered).toMatchObject({
      fg: { r: 80, g: 90, b: 100 },
      bg: { r: 4, g: 5, b: 6 },
      attrs: { underline: true },
    });
  });
});
