import { describe, expect, it } from 'vitest';

import { normalizeTerminalForegroundCommandDisplayName } from './TerminalForegroundCommand';

describe('normalizeTerminalForegroundCommandDisplayName', () => {
  it('keeps a safe basename without depending on the shell parser module', () => {
    expect(normalizeTerminalForegroundCommandDisplayName('top')).toBe('top');
    expect(normalizeTerminalForegroundCommandDisplayName('/usr/bin/top')).toBe('');
    expect(normalizeTerminalForegroundCommandDisplayName('x'.repeat(65))).toBe('');
  });
});
