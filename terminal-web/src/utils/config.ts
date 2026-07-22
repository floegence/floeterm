import type {
  TerminalConfig,
  TerminalThemeDefinition,
  TerminalThemeName,
  TerminalThemeColors,
} from '../types.js';
import { BUILT_IN_TERMINAL_THEME_DATA } from './themeData.js';

const freezeColors = (colors: TerminalThemeColors): TerminalThemeColors => (
  Object.freeze({ ...colors })
);

const freezeDefinition = (definition: {
  id: TerminalThemeName;
  label: string;
  appearance: 'dark' | 'light';
  colors: TerminalThemeColors;
}): TerminalThemeDefinition => Object.freeze({
  id: definition.id,
  label: definition.label,
  appearance: definition.appearance,
  colors: freezeColors(definition.colors),
});

export const TERMINAL_THEME_DEFINITIONS: readonly TerminalThemeDefinition[] = Object.freeze(
  BUILT_IN_TERMINAL_THEME_DATA.map((definition) => freezeDefinition({
    id: definition.id,
    label: definition.label,
    appearance: definition.appearance,
    colors: definition.colors,
  })),
);

export const TERMINAL_THEME_NAMES: readonly TerminalThemeName[] = Object.freeze(
  TERMINAL_THEME_DEFINITIONS.map(({ id }) => id),
);

const terminalThemeDefinitionById = new Map<TerminalThemeName, TerminalThemeDefinition>(
  TERMINAL_THEME_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export const isTerminalThemeName = (value: unknown): value is TerminalThemeName => (
  typeof value === 'string' && terminalThemeDefinitionById.has(value as TerminalThemeName)
);

export const normalizeTerminalThemeName = (
  value: unknown,
  fallback: TerminalThemeName = 'dark',
): TerminalThemeName => {
  if (isTerminalThemeName(value)) return value;
  return isTerminalThemeName(fallback) ? fallback : 'dark';
};

export const getTerminalThemeDefinition = (theme: TerminalThemeName): TerminalThemeDefinition => (
  terminalThemeDefinitionById.get(normalizeTerminalThemeName(theme))
    ?? terminalThemeDefinitionById.get('dark')!
);

export const getThemeColors = (theme: TerminalThemeName): TerminalThemeColors => ({
  ...getTerminalThemeDefinition(theme).colors,
});

export const getDefaultTerminalConfig = (theme: TerminalThemeName, overrides: TerminalConfig = {}): TerminalConfig => ({
  cols: 80,
  rows: 24,
  theme: getThemeColors(theme),
  fontSize: 12,
  fontFamily: '"JetBrains Mono", "Berkeley Mono", "SF Mono", Menlo, Monaco, "Cascadia Mono", "Cascadia Code", Consolas, "Roboto Mono", monospace',
  cursorBlink: false,
  scrollback: 10000,
  allowTransparency: true,
  convertEol: true,
  allowProposedApi: true,
  disableStdin: false,
  screenReaderMode: false,
  windowsMode: false,
  bellStyle: 'none',
  rightClickSelectsWord: false,
  cursorStyle: 'block',
  cursorWidth: 1,
  logLevel: 'warn',
  tabStopWidth: 8,
  minimumContrastRatio: 1,
  ...overrides,
});
