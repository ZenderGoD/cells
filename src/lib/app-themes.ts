import {
  DEFAULT_LIGHT_THEME,
  DEFAULT_THEME,
  getTerminalTheme,
  hexToRgb,
  terminalThemes,
  type TerminalTheme,
} from './terminal-themes.ts'

export type AppColorScheme = 'light' | 'dark' | 'system'

export interface AppThemeSettings {
  colorScheme: AppColorScheme
  appDarkTheme: string
  appLightTheme: string
}

type AppThemeCssVar =
  | '--app-shell-background'
  | '--background'
  | '--foreground'
  | '--card'
  | '--card-foreground'
  | '--popover'
  | '--popover-foreground'
  | '--primary'
  | '--primary-foreground'
  | '--secondary'
  | '--secondary-foreground'
  | '--muted'
  | '--muted-foreground'
  | '--accent'
  | '--accent-foreground'
  | '--destructive'
  | '--border'
  | '--input'
  | '--ring'
  | '--chart-1'
  | '--chart-2'
  | '--chart-3'
  | '--chart-4'
  | '--chart-5'
  | '--sidebar'
  | '--sidebar-foreground'
  | '--sidebar-primary'
  | '--sidebar-primary-foreground'
  | '--sidebar-accent'
  | '--sidebar-accent-foreground'
  | '--sidebar-border'
  | '--sidebar-ring'
  | '--color-canvas'
  | '--color-canvas-grid'
  | '--color-terminal-bg'
  | '--color-terminal-header'
  | '--color-terminal-border'
  | '--color-terminal-active'
  | '--scrollbar-thumb'
  | '--scrollbar-thumb-hover'

export type AppThemeVariables = Record<AppThemeCssVar, string>

export const DEFAULT_APP_DARK_THEME = DEFAULT_THEME
export const DEFAULT_APP_LIGHT_THEME = DEFAULT_LIGHT_THEME

const LIGHT_TEXT = '#fafafa'
const DARK_TEXT = '#111827'

export function getSystemPrefersDark() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveAppColorScheme(
  scheme: AppColorScheme,
  prefersDark = getSystemPrefersDark(),
): 'light' | 'dark' {
  if (scheme === 'system') return prefersDark ? 'dark' : 'light'
  return scheme
}

export function normalizeAppThemeKey(
  value: string | null | undefined,
  scheme: 'light' | 'dark',
): string {
  const fallback = scheme === 'dark' ? DEFAULT_APP_DARK_THEME : DEFAULT_APP_LIGHT_THEME
  if (!value) return fallback
  const theme = terminalThemes[value]
  if (!theme || theme.scheme !== scheme) return fallback
  return value
}

export function getActiveAppThemeKey(
  settings: AppThemeSettings,
  prefersDark = getSystemPrefersDark(),
) {
  const resolvedScheme = resolveAppColorScheme(settings.colorScheme, prefersDark)
  return resolvedScheme === 'dark'
    ? normalizeAppThemeKey(settings.appDarkTheme, 'dark')
    : normalizeAppThemeKey(settings.appLightTheme, 'light')
}

export function buildAppThemeVariables(themeOrName: string | TerminalTheme): AppThemeVariables {
  const theme = typeof themeOrName === 'string' ? getTerminalTheme(themeOrName) : themeOrName
  const isDark = theme.scheme === 'dark'

  const background = theme.background
  const foreground = theme.foreground
  const primary = pickPrimary(theme)
  const primaryForeground = getReadableText(primary)
  const card = blend(background, theme.selectionBackground, isDark ? 0.5 : 0.34)
  const popover = blend(background, theme.selectionBackground, isDark ? 0.58 : 0.42)
  const secondary = blend(background, foreground, isDark ? 0.07 : 0.04)
  const muted = blend(background, theme.selectionBackground, isDark ? 0.32 : 0.5)
  const mutedForeground = blend(foreground, background, isDark ? 0.38 : 0.28)
  const accent = blend(background, primary, isDark ? 0.16 : 0.12)
  const border = blend(background, foreground, isDark ? 0.14 : 0.12)
  const input = blend(background, foreground, isDark ? 0.11 : 0.09)
  const sidebar = blend(
    background,
    isDark ? theme.black : theme.selectionBackground,
    isDark ? 0.3 : 0.38,
  )
  const sidebarAccent = blend(sidebar, primary, isDark ? 0.18 : 0.13)
  const terminalHeader = blend(background, theme.selectionBackground, isDark ? 0.28 : 0.34)
  const terminalBorder = blend(background, foreground, isDark ? 0.18 : 0.15)
  const canvas = blend(
    background,
    isDark ? theme.black : theme.selectionBackground,
    isDark ? 0.22 : 0.18,
  )
  const canvasGrid = blend(background, foreground, isDark ? 0.2 : 0.16)
  const appShell = blend(background, isDark ? theme.black : theme.selectionBackground, 0.12)
  const scrollbarThumb = blend(background, foreground, isDark ? 0.24 : 0.3)
  const scrollbarThumbHover = blend(background, foreground, isDark ? 0.34 : 0.4)

  return {
    '--app-shell-background': withAlphaVar(appShell, '--window-surface-opacity'),
    '--background': background,
    '--foreground': foreground,
    '--card': card,
    '--card-foreground': foreground,
    '--popover': popover,
    '--popover-foreground': foreground,
    '--primary': primary,
    '--primary-foreground': primaryForeground,
    '--secondary': secondary,
    '--secondary-foreground': foreground,
    '--muted': muted,
    '--muted-foreground': mutedForeground,
    '--accent': accent,
    '--accent-foreground': foreground,
    '--destructive': theme.red,
    '--border': border,
    '--input': input,
    '--ring': primary,
    '--chart-1': primary,
    '--chart-2': theme.green,
    '--chart-3': theme.yellow,
    '--chart-4': theme.magenta,
    '--chart-5': theme.cyan,
    '--sidebar': sidebar,
    '--sidebar-foreground': foreground,
    '--sidebar-primary': primary,
    '--sidebar-primary-foreground': primaryForeground,
    '--sidebar-accent': sidebarAccent,
    '--sidebar-accent-foreground': foreground,
    '--sidebar-border': border,
    '--sidebar-ring': primary,
    '--color-canvas': withAlphaVar(canvas, '--canvas-surface-opacity'),
    '--color-canvas-grid': withAlphaVar(canvasGrid, '--canvas-grid-opacity'),
    '--color-terminal-bg': background,
    '--color-terminal-header': terminalHeader,
    '--color-terminal-border': terminalBorder,
    '--color-terminal-active': primary,
    '--scrollbar-thumb': scrollbarThumb,
    '--scrollbar-thumb-hover': scrollbarThumbHover,
  }
}

function pickPrimary(theme: TerminalTheme) {
  if (
    colorDistance(theme.cursor, theme.foreground) > 28 &&
    contrastRatio(theme.cursor, theme.background) > 2.4
  ) {
    return theme.cursor
  }

  return [theme.blue, theme.brightBlue, theme.cyan, theme.magenta, theme.green].reduce(
    (best, candidate) =>
      contrastRatio(candidate, theme.background) > contrastRatio(best, theme.background)
        ? candidate
        : best,
    theme.blue,
  )
}

function withAlphaVar(
  color: string,
  alphaVar: '--window-surface-opacity' | '--canvas-surface-opacity' | '--canvas-grid-opacity',
) {
  const rgb = hexToRgb(color)
  if (!rgb) return color
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b} / var(${alphaVar}))`
}

function blend(base: string, tint: string, tintAmount: number) {
  const baseRgb = hexToRgb(base)
  const tintRgb = hexToRgb(tint)
  if (!baseRgb || !tintRgb) return base

  return toHex({
    r: baseRgb.r + (tintRgb.r - baseRgb.r) * tintAmount,
    g: baseRgb.g + (tintRgb.g - baseRgb.g) * tintAmount,
    b: baseRgb.b + (tintRgb.b - baseRgb.b) * tintAmount,
  })
}

function toHex({ r, g, b }: { r: number; g: number; b: number }) {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`
}

function toHexByte(channel: number) {
  return Math.max(0, Math.min(255, Math.round(channel)))
    .toString(16)
    .padStart(2, '0')
}

function getReadableText(background: string) {
  return contrastRatio(background, DARK_TEXT) >= contrastRatio(background, LIGHT_TEXT)
    ? DARK_TEXT
    : LIGHT_TEXT
}

function colorDistance(left: string, right: string) {
  const a = hexToRgb(left)
  const b = hexToRgb(right)
  if (!a || !b) return 0
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2)
}

function contrastRatio(left: string, right: string) {
  const a = relativeLuminance(left)
  const b = relativeLuminance(right)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

function relativeLuminance(color: string) {
  const rgb = hexToRgb(color)
  if (!rgb) return 0

  const channels = [rgb.r, rgb.g, rgb.b].map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })

  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)
}
