import assert from 'node:assert/strict'
import test from 'node:test'

const { DEFAULT_WINDOW_APPEARANCE, buildWindowAppearanceStyle, normalizeWindowAppearance } =
  await import(new URL('./window-appearance.ts', import.meta.url).href)

test('normalizeWindowAppearance clamps stored values into the supported slider range', () => {
  const normalized = normalizeWindowAppearance({
    windowOpacity: 120,
  })

  assert.deepEqual(normalized, {
    windowOpacity: 100,
  })
})

test('normalizeWindowAppearance preserves a fully transparent window opacity', () => {
  const normalized = normalizeWindowAppearance({
    windowOpacity: 0,
  })

  assert.deepEqual(normalized, {
    windowOpacity: 0,
  })
})

test('normalizeWindowAppearance falls back to defaults when settings are missing', () => {
  assert.deepEqual(normalizeWindowAppearance({}), DEFAULT_WINDOW_APPEARANCE)
})

test('buildWindowAppearanceStyle exposes CSS variables for the app shell', () => {
  assert.deepEqual(buildWindowAppearanceStyle({ windowOpacity: 70 }), {
    '--window-surface-opacity': '0.57',
    '--canvas-surface-opacity': '0.23',
    '--canvas-grid-opacity': '0.18',
  })
})

test('buildWindowAppearanceStyle disables all background surfaces when opacity is fully transparent', () => {
  assert.deepEqual(buildWindowAppearanceStyle({ windowOpacity: 0 }), {
    '--window-surface-opacity': '0',
    '--canvas-surface-opacity': '0',
    '--canvas-grid-opacity': '0',
  })
})
