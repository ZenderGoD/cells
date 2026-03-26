import assert from 'node:assert/strict'
import test from 'node:test'

const { getOverviewTransform } = await import(
  new URL('./canvas-navigation.ts', import.meta.url).href
)

test('getOverviewTransform zooms out to fit all windows into the viewport', () => {
  const transform = getOverviewTransform(
    [
      { x: 100, y: 100, width: 300, height: 220 },
      { x: 1200, y: 400, width: 300, height: 200 },
    ],
    1000,
    800,
  )

  assert.ok(transform)
  assert.ok(transform.scale < 1)
  assert.equal(transform.scale.toFixed(3), '0.676')
  assert.equal(transform.x.toFixed(3), '-40.541')
  assert.equal(transform.y.toFixed(3), '163.514')
})

test('getOverviewTransform returns null when there is nothing to frame', () => {
  assert.equal(getOverviewTransform([], 1000, 800), null)
})
