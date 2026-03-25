import assert from 'node:assert/strict'
import test from 'node:test'

const {
  DEFAULT_WINDOW_APPEARANCE,
  buildWindowAppearanceStyle,
  normalizeWindowAppearance,
} = await import(new URL('./window-appearance.ts', import.meta.url).href)

test('normalizeWindowAppearance clamps stored values into the supported slider range', () => {
  const normalized = normalizeWindowAppearance({
    windowOpacity: 120,
    windowBlurRadius: -4,
  })

  assert.deepEqual(normalized, {
    windowOpacity: 100,
    windowBlurRadius: 0,
  })
})

test('normalizeWindowAppearance preserves a fully transparent window opacity', () => {
  const normalized = normalizeWindowAppearance({
    windowOpacity: 0,
    windowBlurRadius: 18,
  })

  assert.deepEqual(normalized, {
    windowOpacity: 0,
    windowBlurRadius: 18,
  })
})

test('normalizeWindowAppearance falls back to defaults when settings are missing', () => {
  assert.deepEqual(normalizeWindowAppearance({}), DEFAULT_WINDOW_APPEARANCE)
})

test('buildWindowAppearanceStyle exposes CSS variables for the app shell', () => {
  assert.deepEqual(buildWindowAppearanceStyle({ windowOpacity: 70, windowBlurRadius: 31 }), {
    '--window-surface-opacity': '0.7',
    '--window-backdrop-blur': '22px',
    '--canvas-surface-opacity': '0.28',
    '--canvas-grid-opacity': '0.21',
  })
})

test('buildWindowAppearanceStyle disables blur when opacity is fully transparent', () => {
  assert.deepEqual(buildWindowAppearanceStyle({ windowOpacity: 0, windowBlurRadius: 31 }), {
    '--window-surface-opacity': '0',
    '--window-backdrop-blur': '0px',
    '--canvas-surface-opacity': '0',
    '--canvas-grid-opacity': '0',
  })
})
