// @ts-expect-error Vitest executes this source-contract test in Node without app Node typings.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import appSource from './App.tsx?raw';

const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('reference app resize ownership', () => {
  it('gives semantic mode one canvas and one resize observer without legacy renderer mounting', () => {
    expect(appSource).not.toContain("addEventListener('resize'");
    expect(appSource).not.toContain("addEventListener('orientationchange'");
    expect(appSource).not.toContain('visualViewport');
    expect(appSource).not.toContain('scheduleResize');
    expect(appSource).toContain('new ResizeObserver');
    expect(appSource).toContain('createSemanticResizeController');
    expect(appSource).toContain('class="semanticTerminalSurface"');
    expect(appSource).toContain('const attached = await props.transport.attachWithHistoryBoundary(');
    expect(appSource).not.toContain('attachWithHistoryBoundary(props.sessionId, 199, 48)');
    expect(appSource).not.toContain('Beamterm WebGL2 unavailable');
    expect(appSource).not.toContain('<div class="terminalSurface" ref={terminal.mount} />\n\t\t  <canvas class="semanticTerminalSurface"');
  });

  it('does not scale retained canvas backing through container max dimensions', () => {
    expect(stylesSource).toMatch(
      /\.terminalPane canvas:not\(\.semanticTerminalSurface\),\s*\.tileTerminal canvas\s*\{[^}]*max-height:\s*none;[^}]*max-width:\s*none;/,
    );
  });
});
