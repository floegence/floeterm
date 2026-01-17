import { describe, expect, it } from 'vitest';
import { getDefaultTerminalConfig, getThemeColors } from './config';

describe('config helpers', () => {
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
});
