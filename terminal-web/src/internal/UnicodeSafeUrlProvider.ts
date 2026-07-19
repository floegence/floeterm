type UrlProviderCell = {
  getCodepoint(): number;
};

type UrlProviderLine = {
  readonly length: number;
  getCell(column: number): UrlProviderCell | undefined;
};

export type UrlProviderTerminal = {
  readonly buffer: {
    readonly active: {
      getLine(row: number): UrlProviderLine | undefined;
    };
  };
};

const isUnicodeScalar = (codepoint: number): boolean => (
  Number.isInteger(codepoint)
  && codepoint >= 0
  && codepoint <= 0x10ffff
  && (codepoint < 0xd800 || codepoint > 0xdfff)
);

export const createUnicodeSafeUrlProviderTerminal = (
  terminal: UrlProviderTerminal,
): UrlProviderTerminal => ({
  buffer: {
    active: {
      getLine(row) {
        const line = terminal.buffer.active.getLine(row);
        if (!line) return undefined;

        return {
          length: line.length,
          getCell(column) {
            const cell = line.getCell(column);
            if (!cell) return undefined;

            return {
              getCodepoint() {
                const codepoint = cell.getCodepoint();
                if (!isUnicodeScalar(codepoint)) return 0;
                return codepoint <= 0xffff ? codepoint : 0xfffd;
              },
            };
          },
        };
      },
    },
  },
});
