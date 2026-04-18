import type { CanvasTransform } from '@/types'

export interface CanvasSelectableWindow {
  id: string
  x: number
  y: number
  width: number
  height: number
  kind?: 'terminal' | 'browser' | 'agent'
}

export interface CanvasSelectionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SelectionOrigin {
  x: number
  y: number
  kind: 'terminal' | 'browser' | 'agent'
}

export function screenPointsToCanvasRect(
  start: { x: number; y: number },
  end: { x: number; y: number },
  transform: CanvasTransform,
): CanvasSelectionRect {
  const left = Math.min(start.x, end.x)
  const top = Math.min(start.y, end.y)
  const right = Math.max(start.x, end.x)
  const bottom = Math.max(start.y, end.y)

  return {
    x: (left - transform.x) / transform.scale,
    y: (top - transform.y) / transform.scale,
    width: (right - left) / transform.scale,
    height: (bottom - top) / transform.scale,
  }
}

export function getIntersectingWindowIds(
  windows: CanvasSelectableWindow[],
  rect: CanvasSelectionRect,
): string[] {
  return windows.filter((window) => rectsIntersect(window, rect)).map((window) => window.id)
}

export function createSelectionOrigins(
  windows: CanvasSelectableWindow[],
  selectedIds: string[],
): Record<string, SelectionOrigin> {
  const selectedSet = new Set(selectedIds)
  return windows.reduce<Record<string, SelectionOrigin>>((accumulator, window) => {
    if (!selectedSet.has(window.id)) return accumulator
    accumulator[window.id] = {
      x: window.x,
      y: window.y,
      kind: window.kind ?? 'terminal',
    }
    return accumulator
  }, {})
}

export function applySelectionDelta(
  origins: Record<string, SelectionOrigin>,
  dx: number,
  dy: number,
): Record<string, SelectionOrigin> {
  return Object.fromEntries(
    Object.entries(origins).map(([id, origin]) => [
      id,
      { x: origin.x + dx, y: origin.y + dy, kind: origin.kind },
    ]),
  )
}

function rectsIntersect(window: CanvasSelectableWindow, rect: CanvasSelectionRect) {
  return !(
    window.x + window.width < rect.x ||
    window.x > rect.x + rect.width ||
    window.y + window.height < rect.y ||
    window.y > rect.y + rect.height
  )
}
