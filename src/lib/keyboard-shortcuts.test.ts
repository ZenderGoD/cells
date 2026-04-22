import assert from 'node:assert/strict'
import test from 'node:test'

const {
  getAltModifierLabel,
  getPrimaryModifierLabel,
  hasPrimaryModifier,
  isMacPlatform,
  isPrimaryModifierKey,
} = await import(new URL('./keyboard-shortcuts.ts', import.meta.url).href)

test('isMacPlatform recognizes Apple platform identifiers', () => {
  assert.equal(isMacPlatform('MacIntel'), true)
  assert.equal(isMacPlatform('iPhone'), true)
  assert.equal(isMacPlatform('Win32'), false)
})

test('hasPrimaryModifier uses Command on macOS', () => {
  assert.equal(hasPrimaryModifier({ metaKey: true, ctrlKey: false }, 'MacIntel'), true)
  assert.equal(hasPrimaryModifier({ metaKey: false, ctrlKey: true }, 'MacIntel'), false)
})

test('hasPrimaryModifier uses Control on non-macOS platforms', () => {
  assert.equal(hasPrimaryModifier({ metaKey: false, ctrlKey: true }, 'Win32'), true)
  assert.equal(hasPrimaryModifier({ metaKey: true, ctrlKey: false }, 'Win32'), false)
})

test('isPrimaryModifierKey tracks the platform-specific modifier key', () => {
  assert.equal(isPrimaryModifierKey('Meta', 'MacIntel'), true)
  assert.equal(isPrimaryModifierKey('Control', 'MacIntel'), false)
  assert.equal(isPrimaryModifierKey('Control', 'Win32'), true)
  assert.equal(isPrimaryModifierKey('Meta', 'Win32'), false)
})

test('modifier labels match the detected platform', () => {
  assert.equal(getPrimaryModifierLabel('MacIntel'), '⌘')
  assert.equal(getPrimaryModifierLabel('Win32'), 'Ctrl')
  assert.equal(getAltModifierLabel('MacIntel'), '⌥')
  assert.equal(getAltModifierLabel('Win32'), 'Alt')
})
