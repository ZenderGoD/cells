import assert from 'node:assert/strict'
import test from 'node:test'

import {
  UNICODE_REPLACEMENT_CHAR,
  isRenderableCodePoint,
  safeCodePointsString,
  safeCodePointString,
} from './terminal-codepoints.ts'

test('safeCodePointString renders valid code points', () => {
  assert.equal(safeCodePointString(0x41), 'A')
  assert.equal(safeCodePointString(0x1f680), String.fromCodePoint(0x1f680))
})

test('safeCodePointString replaces invalid code points instead of throwing', () => {
  assert.equal(isRenderableCodePoint(1596872), false)
  assert.equal(safeCodePointString(1596872), UNICODE_REPLACEMENT_CHAR)
  assert.equal(safeCodePointString(0xd800), UNICODE_REPLACEMENT_CHAR)
})

test('safeCodePointsString sanitizes grapheme arrays', () => {
  assert.equal(safeCodePointsString([0x41, 1596872, 0x42]), `A${UNICODE_REPLACEMENT_CHAR}B`)
  assert.equal(safeCodePointsString([]), ' ')
  assert.equal(safeCodePointsString(null), ' ')
})
