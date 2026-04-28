import { describe, expect, it } from 'vitest';
import { getDefaultTerminalConfig, getThemeColors } from './config';

describe('config helpers', () => {
  const themeNames = ['dark', 'light', 'solarizedDark', 'monokai', 'tokyoNight'] as const;

  it('returns theme colors for known themes', () => {
    expect(getThemeColors('dark').background).toBeDefined();
    expect(getThemeColors('light').background).toBeDefined();
    expect(getThemeColors('solarizedDark').background).toBeDefined();
    expect(getThemeColors('monokai').background).toBeDefined();
    expect(getThemeColors('tokyoNight').background).toBeDefined();
  });

  it('builds default config with overrides', () => {
    const config = getDefaultTerminalConfig('dark', { fontSize: 16 });
    expect(config.fontSize).toBe(16);
    expect(config.theme).toBeDefined();
  });

  it('uses a readable beige selection style for every built-in theme', () => {
    for (const theme of themeNames) {
      const colors = getThemeColors(theme);
      expect(colors.selectionBackground).toBe('#f5e6b3');
      expect(colors.selectionForeground).toBe('#1f2328');
      expect(colors.selection).toBeUndefined();
    }
  });

  it('keeps the default cursor stable for demand-driven rendering', () => {
    expect(getDefaultTerminalConfig('dark').cursorBlink).toBe(false);
  });
});
