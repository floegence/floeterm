import { describe, expect, it } from 'vitest';

import { normalizeTerminalForegroundCommandDisplayName } from './TerminalForegroundCommandMetadata';

describe('normalizeTerminalForegroundCommandDisplayName', () => {
  it('keeps a safe basename in the lightweight sessions metadata boundary', () => {
    expect(normalizeTerminalForegroundCommandDisplayName('top')).toBe('top');
    expect(normalizeTerminalForegroundCommandDisplayName('/usr/bin/top')).toBe('');
    expect(normalizeTerminalForegroundCommandDisplayName('x'.repeat(65))).toBe('');
  });
});
