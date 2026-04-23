import type {
  AgentWindowNode,
  AgentWindowStatus,
  BrowserNode,
  TerminalNode,
  TerminalRuntimeStatus,
} from '../types'

export type CanvasDirection = 'left' | 'right' | 'up' | 'down'

export interface CanvasWindow {
  id: string
  type: 'terminal' | 'browser' | 'agent'
  title: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  agent?: 'claude' | 'codex' | 'opencode' | 'pi' | null
  runtimeStatus?: TerminalRuntimeStatus | null
  agentWindowStatus?: AgentWindowStatus | null
  hasUnviewedCompletion?: boolean
  faviconUrl?: string
}

export interface CanvasRect {
  x: number
  y: number
  width: number
  height: number
}

export const STATUS_BAR_HEIGHT = 40

export function getCanvasWindows(
  terminals: TerminalNode[],
  browsers: BrowserNode[],
  agentWindows: AgentWindowNode[] = [],
): CanvasWindow[] {
  return [
    ...terminals.map((terminal, index) => ({
      id: terminal.id,
      type: 'terminal' as const,
      title: terminal.title,
      x: terminal.x,
      y: terminal.y,
      width: terminal.width,
      height: terminal.height,
      zIndex: terminal.zIndex ?? index + 1,
      agent: terminal.agent,
      runtimeStatus: terminal.runtimeStatus ?? null,
    })),
    // Pinned browsers live in their own native window and are removed from the
    // canvas render tree, so including them here creates "ghost" targets for
    // snap/overview logic.
    ...browsers
      .filter((browser) => !browser.pinned)
      .map((browser, index) => ({
        id: browser.id,
        type: 'browser' as const,
        title: browser.title || browser.url || 'New Tab',
        x: browser.x,
        y: browser.y,
        width: browser.width,
        height: browser.height,
        zIndex: browser.zIndex ?? index + 1,
        faviconUrl: browser.faviconUrl,
      })),
    ...agentWindows.map((agentWindow, index) => ({
      id: agentWindow.id,
      type: 'agent' as const,
      title: agentWindow.customTitle || agentWindow.title,
      x: agentWindow.x,
      y: agentWindow.y,
      width: agentWindow.width,
      height: agentWindow.height,
      zIndex: agentWindow.zIndex ?? index + 1,
      agent: agentWindow.agent,
      agentWindowStatus: agentWindow.status ?? 'idle',
      hasUnviewedCompletion: agentWindow.hasUnviewedCompletion ?? false,
    })),
  ]
}

export function getWindowCenter(window: Pick<CanvasWindow, 'x' | 'y' | 'width' | 'height'>) {
  return {
    x: window.x + window.width / 2,
    y: window.y + window.height / 2,
  }
}

export function getViewportRect(
  transform: { x: number; y: number; scale: number },
  viewWidth = window.innerWidth,
  viewHeight = window.innerHeight - STATUS_BAR_HEIGHT,
): CanvasRect {
  return {
    x: -transform.x / transform.scale,
    y: -transform.y / transform.scale,
    width: viewWidth / transform.scale,
    height: viewHeight / transform.scale,
  }
}

export function getViewportCenter(transform: { x: number; y: number; scale: number }) {
  const viewport = getViewportRect(transform)
  return {
    x: viewport.x + viewport.width / 2,
    y: viewport.y + viewport.height / 2,
  }
}

export function getCanvasBounds(
  rects: Array<Pick<CanvasRect, 'x' | 'y' | 'width' | 'height'>>,
): CanvasRect | null {
  if (rects.length === 0) return null

  const minX = Math.min(...rects.map((rect) => rect.x))
  const minY = Math.min(...rects.map((rect) => rect.y))
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width))
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height))

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

export function getOverviewTransform(
  rects: Array<Pick<CanvasRect, 'x' | 'y' | 'width' | 'height'>>,
  viewWidth: number,
  viewHeight: number,
  padding = 40,
) {
  const bounds = getCanvasBounds(rects)
  if (!bounds) return null

  const contentW = bounds.width + padding * 2
  const contentH = bounds.height + padding * 2
  const scale = Math.min(viewWidth / contentW, viewHeight / contentH, 1)
  const scaledW = contentW * scale
  const scaledH = contentH * scale
  const offsetX = (viewWidth - scaledW) / 2
  const offsetY = (viewHeight - scaledH) / 2

  return {
    x: offsetX - (bounds.x - padding) * scale,
    y: offsetY - (bounds.y - padding) * scale,
    scale,
  }
}

export function getClosestWindow(
  windows: CanvasWindow[],
  origin: { x: number; y: number },
  excludeId?: string | null,
) {
  let best: CanvasWindow | null = null
  let bestDistance = Infinity

  for (const window of windows) {
    if (window.id === excludeId) continue
    const center = getWindowCenter(window)
    const dx = center.x - origin.x
    const dy = center.y - origin.y
    const distance = dx * dx + dy * dy
    if (distance < bestDistance) {
      bestDistance = distance
      best = window
    }
  }

  return best
}

export function getDirectionalWindow(
  windows: CanvasWindow[],
  direction: CanvasDirection,
  origin: { x: number; y: number },
  excludeId?: string | null,
) {
  let best: CanvasWindow | null = null
  let bestScore = Infinity

  for (const window of windows) {
    if (window.id === excludeId) continue

    const center = getWindowCenter(window)
    const dx = center.x - origin.x
    const dy = center.y - origin.y

    const primary =
      direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy
    if (primary <= 24) continue

    const cross = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
    const score = Math.hypot(primary, cross) + cross * 0.75

    if (score < bestScore) {
      bestScore = score
      best = window
    }
  }

  return best
}

export function orderByRecent<T extends { id: string }>(
  items: T[],
  currentId: string | null,
  focusHistory: string[],
) {
  if (items.length === 0) return items

  const itemMap = new Map(items.map((item) => [item.id, item]))
  const ordered: T[] = []

  if (currentId && itemMap.has(currentId)) {
    ordered.push(itemMap.get(currentId)!)
    itemMap.delete(currentId)
  }

  for (let index = focusHistory.length - 1; index >= 0; index -= 1) {
    const id = focusHistory[index]
    if (!itemMap.has(id)) continue
    ordered.push(itemMap.get(id)!)
    itemMap.delete(id)
  }

  for (const item of items) {
    if (!itemMap.has(item.id)) continue
    ordered.push(item)
  }

  return ordered
}
