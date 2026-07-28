import { describe, expect, it } from 'vitest';

import vectors from '../../../protocol/shell_integration_activity_vectors.json';
import contextVectors from '../../../protocol/terminal_context_v1_vectors.json';
import { TerminalShellIntegrationParser } from './TerminalShellIntegrationParser';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('TerminalShellIntegrationParser', () => {
  it('matches the shared terminal context v1 acceptance vectors', () => {
    for (const vector of contextVectors.cases) {
      const parser = new TerminalShellIntegrationParser();
      const result = parser.parse(encoder.encode(`\x1b]${vector.payload}\u0007`));
      const accepted = result.events.some(event => (
        vector.kind === 'work' ? event.kind === 'work-marker' : event.kind === 'context-marker'
      ));
      expect(accepted, vector.name).toBe(vector.valid);
      expect(result.displayData, vector.name).toHaveLength(0);
      if ('canonicalAuthority' in vector && vector.canonicalAuthority) {
        expect(result.events, vector.name).toContainEqual(expect.objectContaining({
          kind: 'context-marker',
          marker: expect.objectContaining({ authority: vector.canonicalAuthority }),
        }));
      }
    }
  });

  it('accepts every payload in the shared context state sequences', () => {
    for (const vector of contextVectors.stateCases) {
      for (const payload of vector.payloads) {
        const parser = new TerminalShellIntegrationParser();
        const result = parser.parse(encoder.encode(`\x1b]${payload}\u0007`));
        expect(result.events, `${vector.name}: ${payload}`).toHaveLength(1);
      }
    }
    for (const vector of contextVectors.transitionCases) {
      for (const step of vector.steps) {
        if (!('payload' in step) || !step.payload) continue;
        const parser = new TerminalShellIntegrationParser();
        const result = parser.parse(encoder.encode(`\x1b]${step.payload}\u0007`));
        expect(result.events, `${vector.name}: ${step.payload}`).toHaveLength(1);
      }
    }
  });

  it('does not infer the PTY hostname from the browser page origin', () => {
    const previousLocation = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { hostname: 'host.example' },
    });
    try {
      const parser = new TerminalShellIntegrationParser();
      const result = parser.parse(encoder.encode(
        '\x1b]633;P;FloetermContext=v1;action=push;frame_id=remote;location=remote;authority=host.example;application=shell\u0007',
      ));
      expect(result.events).toHaveLength(1);
    } finally {
      Object.defineProperty(globalThis, 'location', { configurable: true, value: previousLocation });
    }
  });

  it('parses private metadata across every byte split with BEL and ST', () => {
    for (const terminator of ['\u0007', '\x1b\\']) {
      const sequence = encoder.encode(`\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=working${terminator}`);
      for (let split = 1; split < sequence.byteLength; split += 1) {
        const parser = new TerminalShellIntegrationParser();
        const first = parser.parse(sequence.subarray(0, split));
        const second = parser.parse(sequence.subarray(split));
        expect(first.displayData, `${terminator}:${split}:first`).toHaveLength(0);
        expect(second.displayData, `${terminator}:${split}:second`).toHaveLength(0);
        expect([...first.events, ...second.events], `${terminator}:${split}`).toEqual([
          { kind: 'work-marker', marker: { frameId: 'agent-1', phase: 'working' } },
        ]);
      }
    }
  });

  it('matches the shared ordered activity vectors', () => {
    for (const vector of vectors.cases) {
      const parser = new TerminalShellIntegrationParser();
      const tokens: string[] = [];
      for (const chunk of vector.chunks) {
        const result = parser.parse(encoder.encode(chunk));
        for (const token of result.tokens) {
          if (token.kind === 'display') {
            tokens.push(`display:${decoder.decode(token.data)}`);
            continue;
          }
          const event = token.event;
          const kind = event.kind === 'context-marker' ? 'context' : event.kind === 'work-marker' ? 'work' : event.kind;
          tokens.push(`signal:${kind}${event.kind === 'program' ? `:${event.displayName}` : ''}`);
        }
      }
      const expectedTokens = 'terminalWebTokens' in vector ? vector.terminalWebTokens : vector.tokens;
      expect(tokens, vector.name).toEqual(expectedTokens);
    }
  });

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

  it('strips SSH target metadata without exposing a browser event', () => {
    const parser = new TerminalShellIntegrationParser();
    const result = parser.parse(encoder.encode(
      'a\x1b]633;P;FloetermSshTarget=v1;target=root@host.example\u0007b',
    ));

    expect(decoder.decode(result.displayData)).toBe('ab');
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

  it('drops oversized private SSH target metadata without retaining its contents', () => {
    const parser = new TerminalShellIntegrationParser();
    const result = parser.parse(encoder.encode(
      `left\x1b]633;P;FloetermSshTarget=${'private-target'.repeat(500)}\u0007right`,
    ));

    expect(decoder.decode(result.displayData)).toBe('leftright');
    expect(result.events).toEqual([]);
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

  it('filters strict context/work metadata and preserves standard OSC controls', () => {
    const parser = new TerminalShellIntegrationParser();
    const input = 'a\x1b]2;root@host.example\u0007'
      + '\x1b]7;file://host.example/root\u0007'
      + '\x1b]633;P;FloetermContext=v1;action=push;frame_id=agent-1;application=agent_cli;identity=codex\u0007'
      + '\x1b]633;P;FloetermWork=v1;frame_id=agent-1;phase=waiting_user\u0007b';
    const result = parser.parse(encoder.encode(input));
    expect(decoder.decode(result.displayData)).toBe('a\x1b]2;root@host.example\u0007\x1b]7;file://host.example/root\u0007b');
    expect(result.events.slice(-2)).toEqual([
      { kind: 'context-marker', marker: { action: 'push', frameId: 'agent-1', application: 'agent_cli', identity: 'codex' } },
      { kind: 'work-marker', marker: { frameId: 'agent-1', phase: 'waiting_user' } },
    ]);
  });

  it('fails closed for duplicate, unknown, and malformed context fields', () => {
    const parser = new TerminalShellIntegrationParser();
    const inputs = [
      '\x1b]633;P;FloetermContext=v1;action=push;frame_id=x;frame_id=x;application=shell\u0007',
      '\x1b]633;P;FloetermContext=v1;action=push;frame_id=x;application=shell;extra=x\u0007',
      '\x1b]633;P;FloetermContext=v1;action=push;frame_id=x;location=remote;authority=host%ZZ\u0007',
      '\x1b]633;P;FloetermContext=v1;action=push;frame_id=x;application=shell;cwd=%2Ftmp\u0007',
      '\x1b]633;P;FloetermContext=v1;action=push;frame_id=x;application=shell;identity=\u0007',
    ];
    for (const input of inputs) {
      const result = parser.parse(encoder.encode(input));
      expect(result.displayData).toHaveLength(0);
      expect(result.events).toEqual([]);
    }
  });
});
