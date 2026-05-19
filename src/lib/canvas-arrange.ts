export type CanvasArrangeItemType = 'terminal' | 'browser' | 'agent' | 'editor' | 'section'

export interface CanvasArrangeItem {
  id: string
  type: CanvasArrangeItemType
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasArrangeSectionItem extends CanvasArrangeItem {
  type: 'section'
  windowIds: string[]
}

export interface CanvasArrangeWindowPosition {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export function getSectionWindowIds(sections: Array<{ windowIds: string[] }>) {
  return new Set(sections.flatMap((section) => section.windowIds))
}

export function filterUnsectionedArrangeItems<T extends { id: string }>(
  items: T[],
  sections: Array<{ windowIds: string[] }>,
) {
  const sectionWindowIds = getSectionWindowIds(sections)
  return items.filter((item) => !sectionWindowIds.has(item.id))
}

export function getTopLevelArrangeItems<T extends CanvasArrangeItem>(
  items: T[],
  sections: CanvasArrangeSectionItem[],
): Array<T | CanvasArrangeSectionItem> {
  return [...sections, ...filterUnsectionedArrangeItems(items, sections)]
}

export function getExclusiveSectionAssignments(
  items: CanvasArrangeWindowPosition[],
  sections: Array<Pick<CanvasArrangeSectionItem, 'id' | 'x' | 'y' | 'width' | 'height'>>,
) {
  const assignments = new Map<string, string>()

  for (const item of items) {
    const centerX = item.x + item.width / 2
    const centerY = item.y + item.height / 2
    for (let index = sections.length - 1; index >= 0; index -= 1) {
      const section = sections[index]
      if (
        centerX >= section.x &&
        centerX <= section.x + section.width &&
        centerY >= section.y &&
        centerY <= section.y + section.height
      ) {
        assignments.set(item.id, section.id)
        break
      }
    }
  }

  return assignments
}

export function getGridArrangePositions(
  items: Array<Pick<CanvasArrangeItem, 'id' | 'x' | 'y' | 'width' | 'height'>>,
  gap: number,
) {
  const positions = new Map<string, { x: number; y: number }>()
  if (items.length === 0) return positions

  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  const maxHeight = Math.max(...items.map((item) => item.height))
  const rowThreshold = maxHeight * 0.5
  const rows: Array<typeof sorted> = []
  let currentRow: typeof sorted = [sorted[0]]

  for (let index = 1; index < sorted.length; index++) {
    const rowCenterY = currentRow.reduce((sum, item) => sum + item.y, 0) / currentRow.length
    if (Math.abs(sorted[index].y - rowCenterY) <= rowThreshold) {
      currentRow.push(sorted[index])
    } else {
      rows.push(currentRow)
      currentRow = [sorted[index]]
    }
  }
  rows.push(currentRow)

  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
  }

  const centroidX = items.reduce((sum, item) => sum + item.x + item.width / 2, 0) / items.length
  const centroidY = items.reduce((sum, item) => sum + item.y + item.height / 2, 0) / items.length

  const totalHeight =
    rows.reduce((sum, row) => sum + Math.max(...row.map((item) => item.height)), 0) +
    (rows.length - 1) * gap
  let currentY = centroidY - totalHeight / 2

  for (const row of rows) {
    const rowHeight = Math.max(...row.map((item) => item.height))
    const totalWidth = row.reduce((sum, item) => sum + item.width, 0) + (row.length - 1) * gap
    let currentX = centroidX - totalWidth / 2

    for (const item of row) {
      positions.set(item.id, { x: currentX, y: currentY })
      currentX += item.width + gap
    }
    currentY += rowHeight + gap
  }

  return positions
}
