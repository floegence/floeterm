import { describe, expect, it } from 'vitest';

import { TerminalShellIntegrationParser } from './TerminalShellIntegrationParser';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('TerminalShellIntegrationParser', () => {
  it('strips lifecycle, cwd, and safe program markers while preserving ordered events', () => {
    const parser = new TerminalShellIntegrationParser();
    const result = parser.parse(encoder.encode(
      'left\x1b]633;P;FloetermProgram=top\u0007\x1b]633;C\u0007middle\x1b]633;D;0\u0007\x1b]633;A\u0007right',
    ));

    expect(decoder.decode(result.displayData)).toBe('leftmiddleright');
    expect(result.events).toEqual([
      { kind: 'program', displayName: 'top' },
      { kind: 'command-executed' },
      { kind: 'command-finished', exitCode: 0 },
      { kind: 'prompt-ready' },
    ]);
  });

  it('supports fragmented ST-terminated metadata without leaking control bytes', () => {
    const parser = new TerminalShellIntegrationParser();
    const first = parser.parse(encoder.encode('x\x1b]633;P;FloetermPro'));
    const second = parser.parse(encoder.encode('gram=sleep\x1b\\y'));

    expect(decoder.decode(first.displayData)).toBe('x');
    expect(first.events).toEqual([]);
    expect(decoder.decode(second.displayData)).toBe('y');
    expect(second.events).toEqual([{ kind: 'program', displayName: 'sleep' }]);
  });

  it('keeps an OSC introducer split between ESC and closing bracket', () => {
    const parser = new TerminalShellIntegrationParser();
    const first = parser.parse(encoder.encode('x\x1b'));
    const second = parser.parse(encoder.encode(']633;P;FloetermProgram=top\u0007y'));

    expect(decoder.decode(first.displayData)).toBe('x');
    expect(first.events).toEqual([]);
    expect(decoder.decode(second.displayData)).toBe('y');
    expect(second.events).toEqual([{ kind: 'program', displayName: 'top' }]);
  });

  it('rejects unsafe program tokens and keeps unknown OSC sequences intact', () => {
    const parser = new TerminalShellIntegrationParser();
    const result = parser.parse(encoder.encode(
      'a\x1b]633;P;FloetermProgram=top --secret\u0007b\x1b]633;P;Editor=ghostty\u0007c',
    ));

    expect(decoder.decode(result.displayData)).toBe('ab\x1b]633;P;Editor=ghostty\u0007c');
    expect(result.events).toEqual([]);
  });

  it('bounds unterminated OSC retention by flushing oversized fragments', () => {
    const parser = new TerminalShellIntegrationParser();
    const oversized = `\x1b]633;P;FloetermProgram=${'a'.repeat(5000)}`;
    const first = parser.parse(encoder.encode(oversized));
    const second = parser.parse(encoder.encode('\u0007tail'));

    expect(decoder.decode(first.displayData)).toBe(oversized);
    expect(decoder.decode(second.displayData)).toBe('\u0007tail');
    expect(first.events).toEqual([]);
    expect(second.events).toEqual([]);
  });

  it('returns ordinary output by identity on the no-OSC fast path', () => {
    const parser = new TerminalShellIntegrationParser();
    const chunk = encoder.encode('ordinary output\n'.repeat(4096));

    const result = parser.parse(chunk);

    expect(result.displayData).toBe(chunk);
    expect(result.events).toEqual([]);
  });

  it('preserves long cwd metadata within the bounded OSC budget', () => {
    const parser = new TerminalShellIntegrationParser();
    const workingDir = `/${'deep/'.repeat(100)}repo`;
    const result = parser.parse(encoder.encode(`\x1b]633;P;Cwd=${workingDir}\u0007`));

    expect(result.displayData).toHaveLength(0);
    expect(result.events).toEqual([{ kind: 'cwd-update', workingDir }]);
  });
});
