export const EXPECTED_GHOSTTY_WEB_SCROLLBACK_BUG_VERSION = '0.4.0-next.14.g6a1a50d';

export const MIN_TERMINAL_SCROLLBACK_ROWS = 1;
export const MAX_TERMINAL_SCROLLBACK_ROWS = 10_000;
export const GHOSTTY_SCROLLBACK_BYTES_PER_ROW = 8_192;
export const MAX_GHOSTTY_SCROLLBACK_BYTES = 81_920_000;
export const MAX_SUPPORTED_TERMINAL_COLUMNS = 500;

const scrollbackRangeDescription =
  `${MIN_TERMINAL_SCROLLBACK_ROWS} and ${MAX_TERMINAL_SCROLLBACK_ROWS} terminal buffer rows`;

/**
 * This conversion is a temporary compatibility boundary for the exact pinned
 * ghostty-web release. That release forwards its row-oriented scrollback option
 * to Ghostty's byte-oriented max_scrollback field.
 */
export function validateTerminalScrollbackRows(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < MIN_TERMINAL_SCROLLBACK_ROWS
    || value > MAX_TERMINAL_SCROLLBACK_ROWS
  ) {
    throw new RangeError(
      `scrollback must be an integer between ${scrollbackRangeDescription}; received ${String(value)}`,
    );
  }
  return value;
}

export function mapGhosttyScrollbackRowsForPinnedVersion(rows: unknown): number {
  const validatedRows = validateTerminalScrollbackRows(rows);
  return Math.min(
    validatedRows * GHOSTTY_SCROLLBACK_BYTES_PER_ROW,
    MAX_GHOSTTY_SCROLLBACK_BYTES,
  );
}

export function validateTerminalColumns(value: unknown, label = 'cols'): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < 1
    || value > MAX_SUPPORTED_TERMINAL_COLUMNS
  ) {
    throw new RangeError(
      `${label} must be an integer between 1 and ${MAX_SUPPORTED_TERMINAL_COLUMNS}; received ${String(value)}`,
    );
  }
  return value;
}

export function capAutoFitTerminalColumns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new RangeError(`auto-fit columns must be a finite positive number; received ${String(value)}`);
  }
  return Math.min(Math.floor(value), MAX_SUPPORTED_TERMINAL_COLUMNS);
}
