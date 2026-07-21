import { describe, expect, it } from 'vitest';

import { classifyTerminalAgentCli } from './TerminalAgentCliMetadata';

describe('classifyTerminalAgentCli', () => {
  it.each([
    ['codex', 'codex'],
    ['CODEX.EXE', 'codex'],
    ['claude', 'claude'],
    ['Claude.cmd', 'claude'],
    ['opencode', 'opencode'],
    ['OpenCode.BAT', 'opencode'],
    ['kimi', 'kimi'],
    ['KIMI.exe', 'kimi'],
  ] as const)('classifies exact agent CLI basename %s', (displayName, expected) => {
    expect(classifyTerminalAgentCli(displayName)).toBe(expected);
  });

  it.each([
    '',
    'my-codex',
    'claude-helper',
    'opencode-dev',
    'kimi-cli',
    'kimicode',
    '/usr/bin/codex',
    'codex --help',
    'codex.sh',
    '工具',
    'x'.repeat(65),
    null,
    undefined,
  ])('does not guess an agent identity from %j', (displayName) => {
    expect(classifyTerminalAgentCli(displayName)).toBeNull();
  });
});
