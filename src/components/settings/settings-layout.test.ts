import assert from 'node:assert/strict'
import test from 'node:test'

const { SETTINGS_SHEET_CLASSNAMES } = await import(new URL('./settings-layout.ts', import.meta.url).href)

test('settings panel is docked to the left edge as a sheet instead of a centered dialog card', () => {
  assert.match(SETTINGS_SHEET_CLASSNAMES.panel, /\bleft-0\b/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.panel, /\btop-0\b/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.panel, /\bh-full\b/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.panel, /\brounded-r-2xl\b/)
  assert.doesNotMatch(SETTINGS_SHEET_CLASSNAMES.panel, /top-1\/2|left-1\/2|translate-x-\[-?1\/2\]|-translate-x-1\/2|-translate-y-1\/2/)
})

test('settings layout keeps the navigation rail separate from the content pane', () => {
  assert.match(SETTINGS_SHEET_CLASSNAMES.frame, /grid-cols-\[264px_minmax\(0,1fr\)\]/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.sidebar, /border-r/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.contentScroll, /overflow-y-auto/)
})
