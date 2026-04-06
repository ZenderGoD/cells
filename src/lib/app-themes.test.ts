import assert from 'node:assert/strict'
import test from 'node:test'

const {
  DEFAULT_APP_DARK_THEME,
  DEFAULT_APP_LIGHT_THEME,
  buildAppThemeVariables,
  getActiveAppThemeKey,
  normalizeAppThemeKey,
  resolveAppColorScheme,
} = await import(new URL('./app-themes.ts', import.meta.url).href)

test('resolveAppColorScheme respects explicit selections', () => {
  assert.equal(resolveAppColorScheme('dark', false), 'dark')
  assert.equal(resolveAppColorScheme('light', true), 'light')
})

test('resolveAppColorScheme resolves system mode against the OS preference', () => {
  assert.equal(resolveAppColorScheme('system', true), 'dark')
  assert.equal(resolveAppColorScheme('system', false), 'light')
})

test('normalizeAppThemeKey falls back when the saved theme is missing or mismatched', () => {
  assert.equal(normalizeAppThemeKey(undefined, 'dark'), DEFAULT_APP_DARK_THEME)
  assert.equal(normalizeAppThemeKey('ghost', 'light'), DEFAULT_APP_LIGHT_THEME)
})

test('getActiveAppThemeKey resolves the correct preset for the active scheme', () => {
  assert.equal(
    getActiveAppThemeKey(
      {
        colorScheme: 'system',
        appDarkTheme: 'tokyoNight',
        appLightTheme: 'tokyoDay',
      },
      true,
    ),
    'tokyoNight',
  )

  assert.equal(
    getActiveAppThemeKey(
      {
        colorScheme: 'system',
        appDarkTheme: 'tokyoNight',
        appLightTheme: 'tokyoDay',
      },
      false,
    ),
    'tokyoDay',
  )
})

test('buildAppThemeVariables derives shadcn tokens and shell variables from a terminal theme', () => {
  const vars = buildAppThemeVariables('matrix')

  assert.equal(vars['--background'], '#030b05')
  assert.equal(vars['--color-terminal-bg'], '#030b05')
  assert.match(
    vars['--app-shell-background'],
    /^rgb\(\d+ \d+ \d+ \/ var\(--window-surface-opacity\)\)$/,
  )
  assert.match(vars['--color-canvas'], /^rgb\(\d+ \d+ \d+ \/ var\(--canvas-surface-opacity\)\)$/)
  assert.equal(vars['--primary'], '#c8ffd2')
  assert.equal(vars['--primary-foreground'], '#111827')
})
