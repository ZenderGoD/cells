import test from 'node:test'
import assert from 'node:assert/strict'

const imported = (await import(
  new URL('./stable-list.ts', import.meta.url).href
)) as typeof import('./stable-list')

const { computeStableList, createEmptyStableListState } = imported

test('computeStableList reuses unchanged entries by id', () => {
  const first = [
    { id: 'a', value: 1 },
    { id: 'b', value: 2 },
  ]
  const initial = computeStableList(first, createEmptyStableListState(), {
    getId: (item) => item.id,
    isUnchanged: (previous, next) => previous.value === next.value,
  })

  const second = [
    { id: 'a', value: 1 },
    { id: 'b', value: 2 },
  ]
  const repeated = computeStableList(second, initial, {
    getId: (item) => item.id,
    isUnchanged: (previous, next) => previous.value === next.value,
  })

  assert.equal(repeated, initial)
  assert.equal(repeated.result[0], initial.result[0])
  assert.equal(repeated.result[1], initial.result[1])
})

test('computeStableList only replaces changed entries', () => {
  const first = [
    { id: 'a', value: 1 },
    { id: 'b', value: 2 },
  ]
  const initial = computeStableList(first, createEmptyStableListState(), {
    getId: (item) => item.id,
    isUnchanged: (previous, next) => previous.value === next.value,
  })

  const second = [
    { id: 'a', value: 1 },
    { id: 'b', value: 3 },
  ]
  const next = computeStableList(second, initial, {
    getId: (item) => item.id,
    isUnchanged: (previous, next) => previous.value === next.value,
  })

  assert.equal(next.result[0], initial.result[0])
  assert.notEqual(next.result[1], initial.result[1])
  assert.equal(next.result[1]?.value, 3)
})
