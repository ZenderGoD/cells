import assert from 'node:assert/strict'
import test from 'node:test'

const { SETTINGS_SHEET_CLASSNAMES } = await import(
  new URL('./settings-layout.ts', import.meta.url).href
)

test('settings sidebar is a separate left rail attached to the viewport edge', () => {
  assert.match(SETTINGS_SHEET_CLASSNAMES.sidebarPanel, /\bfixed\b/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.sidebarPanel, /\bleft-6\b/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.sidebarPanel, /\binset-y-6\b/)
  assert.doesNotMatch(
    SETTINGS_SHEET_CLASSNAMES.sidebarPanel,
    /left-1\/2|-translate-x-1\/2|-translate-y-1\/2/,
  )
})

test('settings content remains a separate centered panel with its own scroll area', () => {
  assert.match(SETTINGS_SHEET_CLASSNAMES.contentPanel, /left-1\/2/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.contentPanel, /-translate-x-1\/2/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.contentPanel, /min-w-\[680px\]/)
  assert.match(SETTINGS_SHEET_CLASSNAMES.contentScroll, /overflow-y-auto/)
})
