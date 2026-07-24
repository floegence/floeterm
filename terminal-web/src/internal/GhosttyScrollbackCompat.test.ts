import { describe, expect, it } from 'vitest';

import {
  EXPECTED_GHOSTTY_WEB_SCROLLBACK_BUG_VERSION,
  GHOSTTY_SCROLLBACK_BYTES_PER_ROW,
  MAX_GHOSTTY_SCROLLBACK_BYTES,
  MAX_SUPPORTED_TERMINAL_COLUMNS,
  capAutoFitTerminalColumns,
  mapGhosttyScrollbackRowsForPinnedVersion,
  validateTerminalColumns,
  validateTerminalScrollbackRows,
} from './GhosttyScrollbackCompat';

describe('GhosttyScrollbackCompat', () => {
  it('binds the byte conversion to the exact affected ghostty-web version', () => {
    expect(EXPECTED_GHOSTTY_WEB_SCROLLBACK_BUG_VERSION).toBe('0.4.0-next.14.g6a1a50d');
    expect(GHOSTTY_SCROLLBACK_BYTES_PER_ROW).toBe(8_192);
    expect(MAX_GHOSTTY_SCROLLBACK_BYTES).toBe(81_920_000);
  });

  it.each([1, 1_000, 10_000])('accepts %s terminal buffer rows', (rows) => {
    expect(validateTerminalScrollbackRows(rows)).toBe(rows);
  });

  it.each([
    0,
    -1,
    1.5,
    10_001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '1000',
    null,
    undefined,
  ])('rejects unsupported scrollback value %s', (value) => {
    expect(() => validateTerminalScrollbackRows(value)).toThrow(/scrollback.*integer.*1.*10000/i);
  });

  it('maps rows to the validated byte budget without exceeding the hard cap', () => {
    expect(mapGhosttyScrollbackRowsForPinnedVersion(1)).toBe(8_192);
    expect(mapGhosttyScrollbackRowsForPinnedVersion(1_000)).toBe(8_192_000);
    expect(mapGhosttyScrollbackRowsForPinnedVersion(10_000)).toBe(81_920_000);
  });

  it('validates explicit terminal columns against the supported geometry', () => {
    expect(MAX_SUPPORTED_TERMINAL_COLUMNS).toBe(500);
    expect(validateTerminalColumns(1)).toBe(1);
    expect(validateTerminalColumns(500, 'fixedDimensions.cols')).toBe(500);
    expect(() => validateTerminalColumns(501, 'fixedDimensions.cols')).toThrow(
      /fixedDimensions\.cols.*1.*500/i,
    );
    expect(() => validateTerminalColumns(12.5)).toThrow(/cols.*integer.*1.*500/i);
  });

  it('caps positive auto-fit measurements at 500 columns', () => {
    expect(capAutoFitTerminalColumns(166.9)).toBe(166);
    expect(capAutoFitTerminalColumns(500)).toBe(500);
    expect(capAutoFitTerminalColumns(999)).toBe(500);
    expect(() => capAutoFitTerminalColumns(0)).toThrow(/finite positive/i);
    expect(() => capAutoFitTerminalColumns(Number.NaN)).toThrow(/finite positive/i);
  });
});
