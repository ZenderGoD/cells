export interface TerminalTheme {
  name: string
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  selectionForeground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export const terminalThemes: Record<string, TerminalTheme> = {
  ghost: {
    name: 'Ghost',
    background: '#19191e',
    foreground: '#d4d4d8',
    cursor: '#d4d4d8',
    selectionBackground: '#3f3f46',
    selectionForeground: '#fafafa',
    black: '#18181b',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#d4d4d8',
    brightBlack: '#52525b',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#fafafa',
  },
  midnight: {
    name: 'Midnight',
    background: '#0f0f17',
    foreground: '#c8c8d4',
    cursor: '#c8c8d4',
    selectionBackground: '#2a2a3d',
    selectionForeground: '#ffffff',
    black: '#0f0f17',
    red: '#ff6b6b',
    green: '#69db7c',
    yellow: '#ffd43b',
    blue: '#74c0fc',
    magenta: '#b197fc',
    cyan: '#66d9e8',
    white: '#c8c8d4',
    brightBlack: '#4a4a5e',
    brightRed: '#ff8787',
    brightGreen: '#8ce99a',
    brightYellow: '#ffe066',
    brightBlue: '#a5d8ff',
    brightMagenta: '#d0bfff',
    brightCyan: '#99e9f2',
    brightWhite: '#ffffff',
  },
  rosePine: {
    name: 'Rosé Pine',
    background: '#191724',
    foreground: '#e0def4',
    cursor: '#e0def4',
    selectionBackground: '#403d52',
    selectionForeground: '#e0def4',
    black: '#26233a',
    red: '#eb6f92',
    green: '#9ccfd8',
    yellow: '#f6c177',
    blue: '#31748f',
    magenta: '#c4a7e7',
    cyan: '#ebbcba',
    white: '#e0def4',
    brightBlack: '#6e6a86',
    brightRed: '#eb6f92',
    brightGreen: '#9ccfd8',
    brightYellow: '#f6c177',
    brightBlue: '#31748f',
    brightMagenta: '#c4a7e7',
    brightCyan: '#ebbcba',
    brightWhite: '#e0def4',
  },
  tokyoNight: {
    name: 'Tokyo Night',
    background: '#1a1b26',
    foreground: '#a9b1d6',
    cursor: '#c0caf5',
    selectionBackground: '#33467c',
    selectionForeground: '#c0caf5',
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
    brightWhite: '#c0caf5',
  },
  catppuccin: {
    name: 'Catppuccin',
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selectionBackground: '#45475a',
    selectionForeground: '#cdd6f4',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
  vitesse: {
    name: 'Vitesse',
    background: '#121212',
    foreground: '#dbd7ca',
    cursor: '#dbd7ca',
    selectionBackground: '#333333',
    selectionForeground: '#dbd7ca',
    black: '#121212',
    red: '#cb7676',
    green: '#4d9375',
    yellow: '#e6cc77',
    blue: '#6394bf',
    magenta: '#d9739f',
    cyan: '#5eaab5',
    white: '#dbd7ca',
    brightBlack: '#555555',
    brightRed: '#cb7676',
    brightGreen: '#4d9375',
    brightYellow: '#e6cc77',
    brightBlue: '#6394bf',
    brightMagenta: '#d9739f',
    brightCyan: '#5eaab5',
    brightWhite: '#dbd7ca',
  },
}

export const DEFAULT_THEME = 'ghost'

export function getTerminalTheme(name: string): TerminalTheme {
  return terminalThemes[name] ?? terminalThemes[DEFAULT_THEME]
}
