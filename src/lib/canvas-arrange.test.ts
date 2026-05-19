import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasArrangeItem, CanvasArrangeSectionItem } from './canvas-arrange'

const {
  filterUnsectionedArrangeItems,
  getExclusiveSectionAssignments,
  getGridArrangePositions,
  getTopLevelArrangeItems,
} = await import(new URL('./canvas-arrange.ts', import.meta.url).href)

test('getTopLevelArrangeItems treats sections as blocks and excludes their child windows', () => {
  const windows: CanvasArrangeItem[] = [
    { id: 'terminal-1', type: 'terminal', x: 10, y: 10, width: 200, height: 120 },
    { id: 'browser-1', type: 'browser', x: 240, y: 10, width: 300, height: 180 },
    { id: 'agent-1', type: 'agent', x: 580, y: 10, width: 260, height: 180 },
  ]
  const sections: CanvasArrangeSectionItem[] = [
    {
      id: 'section-1',
      type: 'section',
      x: 0,
      y: 0,
      width: 560,
      height: 260,
      windowIds: ['terminal-1', 'browser-1'],
    },
  ]

  const topLevelItems = getTopLevelArrangeItems([...windows], [...sections]) as Array<{
    id: string
  }>
  const unsectionedItems = filterUnsectionedArrangeItems([...windows], [...sections]) as Array<{
    id: string
  }>

  assert.deepEqual(
    topLevelItems.map((item) => item.id),
    ['section-1', 'agent-1'],
  )
  assert.deepEqual(
    unsectionedItems.map((item) => item.id),
    ['agent-1'],
  )
})

test('getGridArrangePositions preserves rows while centering the arranged grid', () => {
  const positions = getGridArrangePositions(
    [
      { id: 'a', x: 0, y: 0, width: 100, height: 100 },
      { id: 'b', x: 180, y: 20, width: 100, height: 100 },
      { id: 'c', x: 10, y: 220, width: 100, height: 100 },
    ],
    20,
  )

  assert.deepEqual(
    [...positions.entries()].map(([id, position]) => [
      id,
      { x: Number(position.x.toFixed(3)), y: Number(position.y.toFixed(3)) },
    ]),
    [
      ['a', { x: 3.333, y: 20 }],
      ['b', { x: 123.333, y: 20 }],
      ['c', { x: 63.333, y: 140 }],
    ],
  )
})

test('getExclusiveSectionAssignments assigns a dragged window to only one section', () => {
  const assignments = getExclusiveSectionAssignments(
    [{ id: 'terminal-1', x: 80, y: 80, width: 80, height: 80 }],
    [
      { id: 'section-1', type: 'section', x: 0, y: 0, width: 180, height: 180, windowIds: [] },
      { id: 'section-2', type: 'section', x: 60, y: 60, width: 180, height: 180, windowIds: [] },
    ],
  )

  assert.deepEqual([...assignments.entries()], [['terminal-1', 'section-2']])
})
