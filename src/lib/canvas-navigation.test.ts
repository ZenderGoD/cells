import assert from 'node:assert/strict'
import test from 'node:test'

const { getCanvasViewportSize, getOverviewTransform, getWindowSnapTransform } = await import(
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

test('getWindowSnapTransform centers a fitted window', () => {
  const transform = getWindowSnapTransform({ x: 100, y: 50, width: 500, height: 300 }, 1000, 800, {
    basePadding: 8,
    mode: 'fill',
  })

  assert.equal(transform.scale, 1)
  assert.equal(transform.x, 150)
  assert.equal(transform.y, 200)
})

test('getWindowSnapTransform peek mode leaves extra surrounding canvas visible', () => {
  const fill = getWindowSnapTransform({ x: 0, y: 0, width: 984, height: 784 }, 1000, 800, {
    basePadding: 8,
    mode: 'fill',
  })
  const peek = getWindowSnapTransform({ x: 0, y: 0, width: 984, height: 784 }, 1000, 800, {
    basePadding: 8,
    mode: 'peek',
  })

  assert.equal(fill.scale, 1)
  assert.ok(peek.scale < fill.scale)
  assert.equal(peek.x.toFixed(3), '96.721')
  assert.equal(peek.y.toFixed(3), '78.689')
})

test('getCanvasViewportSize prefers the rendered canvas stage over window fallback', () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1000, innerHeight: 800 },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: (selector: string) =>
        selector === '.canvas-stage'
          ? { getBoundingClientRect: () => ({ width: 640, height: 360 }) }
          : null,
    },
  })

  try {
    assert.deepEqual(getCanvasViewportSize({ titleBarHidden: false }), {
      width: 640,
      height: 360,
    })
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    })
  }
})
