import { normalizeTerminalForegroundCommandDisplayName } from './TerminalForegroundCommandMetadata.js';

export type TerminalAgentCliIdentity =
  | 'codex'
  | 'claude'
  | 'opencode'
  | 'kimi'
  | 'gemini'
  | 'qwen'
  | 'copilot'
  | 'cline'
  | 'roo'
  | 'vibe'
  | 'cursor'
  | 'junie'
  | 'kiro'
  | 'openhands'
  | 'trae'
  | 'kilo';

const AGENT_CLI_BY_COMMAND = new Map<string, TerminalAgentCliIdentity>([
  ['codex', 'codex'],
  ['claude', 'claude'],
  ['opencode', 'opencode'],
  ['kimi', 'kimi'],
  ['kimi-cli', 'kimi'],
  ['gemini', 'gemini'],
  ['qwen', 'qwen'],
  ['copilot', 'copilot'],
  ['cline', 'cline'],
  ['roo', 'roo'],
  ['vibe', 'vibe'],
  ['cursor-agent', 'cursor'],
  ['junie', 'junie'],
  ['kiro-cli', 'kiro'],
  ['openhands', 'openhands'],
  ['trae-cli', 'trae'],
  ['kilocode', 'kilo'],
]);

const WINDOWS_EXECUTABLE_SUFFIXES = ['.exe', '.cmd', '.bat'] as const;

export function classifyTerminalAgentCli(displayName: unknown): TerminalAgentCliIdentity | null {
  const normalized = normalizeTerminalForegroundCommandDisplayName(displayName);
  if (!normalized) return null;
  let command = normalized.toLowerCase();
  for (const suffix of WINDOWS_EXECUTABLE_SUFFIXES) {
    if (command.endsWith(suffix)) {
      command = command.slice(0, -suffix.length);
      break;
    }
  }
  return AGENT_CLI_BY_COMMAND.get(command) ?? null;
}
