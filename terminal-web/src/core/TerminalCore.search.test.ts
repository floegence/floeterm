// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { TerminalCore } from './TerminalCore';

type fake_line = { translateToString: (trimRight?: boolean) => string };

const makeFakeTerminal = (lines: string[]) => {
  return {
    buffer: {
      active: {
        length: lines.length,
        getLine: (y: number): fake_line | undefined => {
          const value = lines[y];
          if (typeof value !== 'string') return undefined;
          return {
            translateToString: () => value,
          };
        },
      },
    },
  };
};

describe('TerminalCore search scanning', () => {
  it('splits fuzzy search tokens by whitespace and matches in-order spans', () => {
    const core = new TerminalCore(document.createElement('div'));
    (core as any).terminal = makeFakeTerminal(['foo   bar']);

    const matches = (core as any).scanTerminalMatches('foo bar');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ row: 0, col: 0, len: 9 });
  });

  it('reads buffer lines through a public safe API', () => {
    const core = new TerminalCore(document.createElement('div'));
    (core as any).terminal = makeFakeTerminal(['alpha', 'beta']);

    expect(core.readBufferLine(1)).toBe('beta');
    expect(core.readBufferLine(-1)).toBe('');
    expect(core.readBufferLines(0, 1)).toEqual([
      { row: 0, text: 'alpha' },
      { row: 1, text: 'beta' },
    ]);
  });

  it('returns safe empty values when buffer access fails during remount races', () => {
    const core = new TerminalCore(document.createElement('div'));
    (core as any).terminal = {
      buffer: {
        active: {
          getLine: () => {
            throw new Error('disposed');
          },
        },
      },
    };

    expect(core.readBufferLine(0)).toBe('');
    expect(core.readBufferLines(0, 0)).toEqual([]);
  });

  it('exposes touch scroll operations without requiring consumers to access internals', () => {
    const core = new TerminalCore(document.createElement('div'));
    const scrollLines = vi.fn();
    const input = vi.fn();
    (core as any).terminal = {
      scrollLines,
      getScrollbackLength: () => 42,
      isAlternateScreen: () => true,
      input,
    };

    const runtime = core.getTouchScrollRuntime();

    expect(runtime?.getScrollbackLength()).toBe(42);
    expect(runtime?.isAlternateScreen()).toBe(true);
    expect(runtime?.scrollLines(3)).toBe(true);
    runtime?.sendAlternateScreenInput('\x1B[A');
    expect(scrollLines).toHaveBeenCalledWith(3);
    expect(input).toHaveBeenCalledWith('\x1B[A', true);
  });
});
