import { For } from 'solid-js';
import {
  getTerminalThemeDefinition,
  getThemeColors,
  TERMINAL_THEME_DEFINITIONS,
  type TerminalThemeName,
} from '@floegence/floeterm-terminal-web';

export function applyTerminalThemeShell(root: HTMLElement, theme: TerminalThemeName): void {
  const definition = getTerminalThemeDefinition(theme);
  const colors = getThemeColors(theme);
  root.dataset.theme = theme;
  root.dataset.themeAppearance = definition.appearance;
  root.style.setProperty('--surface-0', colors.background);
  root.style.setProperty('--text', colors.foreground);
  root.style.setProperty('--accent', colors.blue);
  root.style.setProperty('--accent-strong', colors.cyan);
}

export function ThemeSelector(props: {
  themeName: TerminalThemeName;
  disabled?: boolean;
  onThemeChange: (theme: TerminalThemeName) => void;
}) {
  return (
    <select
      aria-label="Terminal theme"
      value={props.themeName}
      onChange={(event) => props.onThemeChange(event.currentTarget.value as TerminalThemeName)}
      disabled={props.disabled}
    >
      <For each={TERMINAL_THEME_DEFINITIONS}>
        {(theme) => <option value={theme.id}>{theme.label}</option>}
      </For>
    </select>
  );
}
