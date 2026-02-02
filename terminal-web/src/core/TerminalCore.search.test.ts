// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
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
});

