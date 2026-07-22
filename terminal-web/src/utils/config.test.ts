import { describe, expect, it } from 'vitest';
import type { TerminalThemeName } from '../types';
import {
  getDefaultTerminalConfig,
  getThemeColors,
  getTerminalThemeDefinition,
  isTerminalThemeName,
  normalizeTerminalThemeName,
  TERMINAL_THEME_DEFINITIONS,
  TERMINAL_THEME_NAMES,
} from './config';

describe('config helpers', () => {
  const themeNames = TERMINAL_THEME_DEFINITIONS.map(({ id }) => id);

  it('publishes a stable directory with at least twenty complete themes', () => {
    expect(TERMINAL_THEME_DEFINITIONS.length).toBeGreaterThanOrEqual(20);
    expect(TERMINAL_THEME_DEFINITIONS.length).toBe(20);
    expect(new Set(themeNames).size).toBe(themeNames.length);
    for (const definition of TERMINAL_THEME_DEFINITIONS) {
      expect(definition.label).toBeTruthy();
      expect(['dark', 'light']).toContain(definition.appearance);
      expect(Object.keys(definition.colors)).toEqual(expect.arrayContaining([
        'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground',
        'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
        'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
      ]));
    }
  });

  it('validates theme IDs, freezes the directory, and returns defensive color copies', () => {
    expect(isTerminalThemeName('polarVeil')).toBe(true);
    expect(isTerminalThemeName('unknown')).toBe(false);
    expect(normalizeTerminalThemeName('unknown')).toBe('dark');
    expect(normalizeTerminalThemeName('unknown', 'light')).toBe('light');
    expect(Object.isFrozen(TERMINAL_THEME_DEFINITIONS)).toBe(true);
    expect(Object.isFrozen(TERMINAL_THEME_NAMES)).toBe(true);
    expect(TERMINAL_THEME_DEFINITIONS.every((definition) => Object.isFrozen(definition))).toBe(true);
    expect(TERMINAL_THEME_DEFINITIONS.every((definition) => Object.isFrozen(definition.colors))).toBe(true);
    expect(() => (TERMINAL_THEME_NAMES as TerminalThemeName[]).push('dark')).toThrow(TypeError);
    expect(() => ((TERMINAL_THEME_DEFINITIONS[0]!.colors as Record<string, string>).background = '#000000')).toThrow(TypeError);
    const colors = getThemeColors('polarVeil');
    (colors as Record<string, string>).background = '#000000';
    expect(getTerminalThemeDefinition('polarVeil').colors.background).toBe('#10201f');
  });

  it('preserves every legacy color field and adds only the missing cursor accent', () => {
    expect(getThemeColors('dark')).toMatchSnapshot('dark legacy palette');
    expect(getThemeColors('tokyoNight')).toMatchSnapshot('tokyo night legacy palette');
    for (const theme of ['light', 'solarizedDark', 'monokai'] as const) {
      const { cursorAccent, ...legacyColors } = getThemeColors(theme);
      expect(cursorAccent).toBe(legacyColors.background);
      expect(legacyColors).toMatchSnapshot(`${theme} legacy palette`);
    }
  });

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

  it('uses a readable yellow selection style for every built-in theme', () => {
    for (const theme of themeNames) {
      const colors = getThemeColors(theme);
      expect(colors.selectionBackground).toBeTruthy();
      expect(colors.selectionForeground).toBeTruthy();
      expect('selection' in colors).toBe(false);
    }
  });

  it('keeps the default cursor stable for demand-driven rendering', () => {
    expect(getDefaultTerminalConfig('dark').cursorBlink).toBe(false);
  });
});
