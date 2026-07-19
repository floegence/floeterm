import { describe, expect, it } from 'vitest';
import { UrlRegexProvider } from 'ghostty-web';
import { createUnicodeSafeUrlProviderTerminal } from './UnicodeSafeUrlProvider';

const terminalWithCodepoints = (codepoints: number[]) => ({
  buffer: {
    active: {
      getLine: (row: number) => row === 8192
        ? {
            length: codepoints.length,
            getCell: (column: number) => {
              const codepoint = codepoints[column];
              return codepoint === undefined ? undefined : { getCodepoint: () => codepoint };
            },
          }
        : undefined,
    },
  },
});

describe('createUnicodeSafeUrlProviderTerminal', () => {
  it('preserves one-cell Unicode values and maps supplementary scalars to one code unit', () => {
    const safeTerminal = createUnicodeSafeUrlProviderTerminal(
      terminalWithCodepoints([0, 31, 0x61, 0x1f600, 0x10ffff]),
    );
    const line = safeTerminal.buffer.active.getLine(8192);

    expect(Array.from({ length: line?.length ?? 0 }, (_, column) => line?.getCell(column)?.getCodepoint()))
      .toEqual([0, 31, 0x61, 0xfffd, 0xfffd]);
  });

  it.each([0xd800, 0x110000, 0xffffffff, Number.NaN])(
    'maps invalid Unicode scalar %s to an empty cell',
    (codepoint) => {
      const safeTerminal = createUnicodeSafeUrlProviderTerminal(terminalWithCodepoints([codepoint]));

      expect(safeTerminal.buffer.active.getLine(8192)?.getCell(0)?.getCodepoint()).toBe(0);
    },
  );

  it('keeps URL detection operational after an invalid raw cell', () => {
    const url = 'https://example.com/path';
    const provider = new UrlRegexProvider(createUnicodeSafeUrlProviderTerminal(
      terminalWithCodepoints([0xffffffff, ...Array.from(url, character => character.codePointAt(0)!)]),
    ));
    let providedLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    expect(() => provider.provideLinks(8192, links => { providedLinks = links; })).not.toThrow();
    expect(providedLinks).toHaveLength(1);
    expect(providedLinks?.[0]).toMatchObject({
      text: url,
      range: {
        start: { x: 1, y: 8192 },
        end: { x: url.length, y: 8192 },
      },
    });
  });

  it('keeps URL ranges aligned after a supplementary Unicode cell', () => {
    const url = 'https://example.com';
    const provider = new UrlRegexProvider(createUnicodeSafeUrlProviderTerminal(
      terminalWithCodepoints([0x1f600, ...Array.from(url, character => character.codePointAt(0)!)]),
    ));
    let providedLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(8192, links => { providedLinks = links; });

    expect(providedLinks?.[0]?.range).toEqual({
      start: { x: 1, y: 8192 },
      end: { x: url.length, y: 8192 },
    });
  });
});
