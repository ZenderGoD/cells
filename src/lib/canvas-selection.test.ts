import assert from 'node:assert/strict'
import test from 'node:test'

const {
  applySelectionDelta,
  createSelectionOrigins,
  getIntersectingWindowIds,
  screenPointsToCanvasRect,
} = await import(new URL('./canvas-selection.ts', import.meta.url).href)

test('screenPointsToCanvasRect converts a marquee drag into canvas coordinates', () => {
  assert.deepEqual(
    screenPointsToCanvasRect({ x: 180, y: 160 }, { x: 80, y: 60 }, { x: 20, y: 10, scale: 2 }),
    { x: 30, y: 25, width: 50, height: 50 },
  )
})

test('getIntersectingWindowIds returns every window touched by the marquee', () => {
  const ids = getIntersectingWindowIds(
    [
      { id: 'term-1', x: 20, y: 20, width: 80, height: 80 },
      { id: 'browser-1', x: 160, y: 40, width: 120, height: 100 },
      { id: 'term-2', x: 340, y: 40, width: 120, height: 100 },
    ],
    { x: 40, y: 10, width: 260, height: 180 },
  )

  assert.deepEqual(ids, ['term-1', 'browser-1'])
})

test('applySelectionDelta keeps per-window origins so grouped drags stay aligned', () => {
  const origins = createSelectionOrigins(
    [
      { id: 'term-1', x: 20, y: 20, width: 80, height: 80, kind: 'terminal' },
      { id: 'browser-1', x: 160, y: 40, width: 120, height: 100, kind: 'browser' },
      { id: 'term-2', x: 340, y: 40, width: 120, height: 100, kind: 'terminal' },
    ],
    ['term-1', 'browser-1'],
  )

  assert.deepEqual(applySelectionDelta(origins, 32, -18), {
    'term-1': { x: 52, y: 2, kind: 'terminal' },
    'browser-1': { x: 192, y: 22, kind: 'browser' },
  })
})
