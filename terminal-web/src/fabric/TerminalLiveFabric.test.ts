import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../types';
import type { TerminalFabricRenderer } from './types';
import {
  cursorToFabricCursor,
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
    const logger = createLogger();
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
      logger,
      fontFamily: 'monospace',
      fontSize: 12,
      theme: { background: '#000000', foreground: '#ffffff' },
      getGhosttyCanvas: () => null,
      focusInputSurface: vi.fn(),
      forwardWheel: vi.fn(),
    })).rejects.toThrow('webgl unavailable');

    fabric.dispose();

    expect(dispose).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      '[TerminalLiveFabric] Beamterm renderer initialization failed',
      expect.objectContaining({ error: expect.any(Error) }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
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

});
