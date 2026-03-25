import assert from 'node:assert/strict'
import test from 'node:test'

const { SETTINGS_SHEET_CLASSNAMES } = await import(
  new URL('./settings-layout.ts', import.meta.url).href
)

test('settings sidebar classname is still exported for backwards compat', () => {
  assert.ok(SETTINGS_SHEET_CLASSNAMES.sidebarPanel)
  assert.match(SETTINGS_SHEET_CLASSNAMES.sidebarPanel, /\bfixed\b/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.sidebarPanel, /\bleft-6\b/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.sidebarPanel, /\binset-y-6\b/)
})

test('settings dialog is a centered panel with a scrollable content area', () => {
  assert.match(SETTINGS_SHEET_CLASSNAMES.contentPanel, /left-1\/2/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.contentPanel, /-translate-x-1\/2/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.contentPanel, /min-w-\[680px\]/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.contentScroll, /overflow-y-auto/)
})
