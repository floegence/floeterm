// @ts-expect-error Vitest executes this source-contract test in Node without app Node typings.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import appSource from './App.tsx?raw';

const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('reference app resize ownership', () => {
  it('leaves layout resize observation to TerminalCore', () => {
    expect(appSource).not.toContain("addEventListener('resize'");
    expect(appSource).not.toContain("addEventListener('orientationchange'");
    expect(appSource).not.toContain('visualViewport');
    expect(appSource).not.toContain('scheduleResize');
    expect(appSource).toContain('forceResize: () => terminal.actions().forceResize()');
  });

  it('does not scale retained canvas backing through container max dimensions', () => {
    expect(stylesSource).toMatch(
      /\.terminalPane canvas,\s*\.tileTerminal canvas\s*\{[^}]*max-height:\s*none;[^}]*max-width:\s*none;/,
    );
  });
});
