import type { TerminalConfig, TerminalThemeName } from '../types';

const DARK_THEME: Record<string, string> = {
  background: '#0b0f14',
  foreground: '#c9d1d9',
  cursor: '#c9d1d9',
  cursorAccent: '#0b0f14',
  selectionBackground: 'rgba(124, 156, 255, 0.25)',
  black: '#0b0f14',
  red: '#ff5c57',
  green: '#5af78e',
  yellow: '#f3f99d',
  blue: '#57c7ff',
  magenta: '#ff6ac1',
  cyan: '#9aedfe',
  white: '#c9d1d9',
  brightBlack: '#545d68',
  brightRed: '#ff5c57',
  brightGreen: '#5af78e',
  brightYellow: '#f3f99d',
  brightBlue: '#57c7ff',
  brightMagenta: '#ff6ac1',
  brightCyan: '#9aedfe',
  brightWhite: '#ffffff'
};

const LIGHT_THEME: Record<string, string> = {
  background: '#ffffff',
  foreground: '#333333',
  cursor: '#333333',
  selection: '#add6ff',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5'
};

const SOLARIZED_DARK_THEME: Record<string, string> = {
  background: '#002b36',
  foreground: '#93a1a1',
  cursor: '#93a1a1',
  selection: '#073642',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#002b36',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3'
};

const MONOKAI_THEME: Record<string, string> = {
  background: '#272822',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  selectionBackground: '#49483e',
  black: '#272822',
  red: '#f92672',
  green: '#a6e22e',
  yellow: '#f4bf75',
  blue: '#66d9ef',
  magenta: '#ae81ff',
  cyan: '#a1efe4',
  white: '#f8f8f2',
  brightBlack: '#75715e',
  brightRed: '#f92672',
  brightGreen: '#a6e22e',
  brightYellow: '#f4bf75',
  brightBlue: '#66d9ef',
  brightMagenta: '#ae81ff',
  brightCyan: '#a1efe4',
  brightWhite: '#f9f8f5'
};

const TOKYO_NIGHT_THEME: Record<string, string> = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: 'rgba(122, 162, 247, 0.25)',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5'
};

export const getThemeColors = (theme: TerminalThemeName): Record<string, string> => {
  switch (theme) {
    case 'light':
      return LIGHT_THEME;
    case 'solarizedDark':
      return SOLARIZED_DARK_THEME;
    case 'monokai':
      return MONOKAI_THEME;
    case 'tokyoNight':
      return TOKYO_NIGHT_THEME;
    case 'dark':
    default:
      return DARK_THEME;
  }
};

export const getDefaultTerminalConfig = (theme: TerminalThemeName, overrides: TerminalConfig = {}): TerminalConfig => {
  return {
    cols: 80,
    rows: 24,
    theme: getThemeColors(theme),
    fontSize: 12,
    fontFamily: '"JetBrains Mono", "Berkeley Mono", "SF Mono", Menlo, Monaco, "Cascadia Mono", "Cascadia Code", Consolas, "Roboto Mono", monospace',
    cursorBlink: true,
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
    ...overrides
  };
};
