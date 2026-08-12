import { describe, expect, it } from 'vitest';
import appSource from './App.tsx?raw';

describe('reference app resize ownership', () => {
  it('leaves layout resize observation to TerminalCore', () => {
    expect(appSource).not.toContain("addEventListener('resize'");
    expect(appSource).not.toContain("addEventListener('orientationchange'");
    expect(appSource).not.toContain('visualViewport');
    expect(appSource).not.toContain('scheduleResize');
    expect(appSource).toContain('forceResize: () => terminal.actions().forceResize()');
  });
});
