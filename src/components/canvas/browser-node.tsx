import { useState, useRef, useCallback, useEffect, type MouseEvent } from 'react'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import type { BrowserNode as BrowserNodeType } from '@/types'

const MIN_W = 400
const MIN_H = 300
const HANDLE = 6
const BORDER_W = 3 // px inset for focus ring visibility
const STATUS_BAR_H = 40 // must match toolbar height

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface BrowserNodeProps {
  browser: BrowserNodeType
  scale: number
  cmdHeld: boolean
  isFocused: boolean
  onDragStart: (id: string, startX: number, startY: number) => void
}

export function BrowserNode({ browser, scale, cmdHeld, isFocused, onDragStart }: BrowserNodeProps) {
  const {
    resizeBrowser,
    moveBrowser,
    updateBrowserUrl,
    updateBrowserTitle,
    focusBrowser,
    addBrowserWithUrl,
  } = useStore()
  const activeProjectId = useStore((s) => s.activeProjectId)
  const overlayOpen = useStore((s) => s.overlayOpen)
  const canvas = useStore((s) => s.canvas)

  const [isResizing, setIsResizing] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [viewReady, setViewReady] = useState(false)
  const [overscroll, setOverscroll] = useState<{
    progress: number
    direction: 'back' | 'forward'
  } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const createdRef = useRef(false)
  const lastBoundsRef = useRef({ x: 0, y: 0, width: 0, height: 0 })

  // Create or unpark WebContentsView on mount, park on unmount
  useEffect(() => {
    if (!activeProjectId || createdRef.current) return
    createdRef.current = true
    window.cells.browser
      .create(browser.id, activeProjectId, browser.history ?? undefined)
      .then((result: any) => {
        setViewReady(true)
        // Only navigate on fresh creation, not when unparking (live page is preserved)
        if (!result?.unparked && browser.url) {
          window.cells.browser.navigate(browser.id, browser.url, useStore.getState().searchEngine)
        }
      })
    return () => {
      createdRef.current = false
      setViewReady(false)
      // Park instead of destroy — keeps the view alive for project switching
      window.cells.browser.park(browser.id)
    }
  }, [browser.id, browser.url, browser.history, activeProjectId])

  // Listen for overscroll gestures (swipe back/forward)
  useEffect(() => {
    const unsub = window.cells.browser.onOverscroll((id, progress, direction) => {
      if (id !== browser.id) return
      if (progress <= 0 || !direction) {
        setOverscroll(null)
      } else {
        setOverscroll({ progress, direction: direction as 'back' | 'forward' })
      }
    })
    return unsub
  }, [browser.id])

  // Listen for title/URL updates and new-window requests
  useEffect(() => {
    const unsubTitle = window.cells.browser.onTitleUpdated((id, title) => {
      if (id === browser.id) updateBrowserTitle(id, title)
    })
    const unsubUrl = window.cells.browser.onUrlChanged((id, url) => {
      if (id === browser.id) updateBrowserUrl(id, url)
    })
    const unsubNewWindow = window.cells.browser.onNewWindow((id, url) => {
      if (id === browser.id) {
        addBrowserWithUrl(url)
      }
    })
    const unsubLoading = window.cells.browser.onLoading((id, loading) => {
      if (id === browser.id) setIsLoading(loading)
    })
    return () => {
      unsubTitle()
      unsubUrl()
      unsubNewWindow()
      unsubLoading()
    }
  }, [browser.id, updateBrowserTitle, updateBrowserUrl, addBrowserWithUrl])

  // Track window size so browser bounds update on resize
  const [windowHeight, setWindowHeight] = useState(window.innerHeight)
  useEffect(() => {
    const onResize = () => setWindowHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Position and show the WebContentsView when focused, driven by prop/state changes.
  const lastVisibleRef = useRef(false)
  const lastZoomRef = useRef(-1)

  useEffect(() => {
    if (!viewReady || !isFocused) {
      if (lastVisibleRef.current) {
        window.cells.browser.setVisible(browser.id, false)
        lastVisibleRef.current = false
      }
      return
    }

    // Compute screen-space bounds mathematically from known positions
    // (getBoundingClientRect is unreliable during canvas spring animations)
    const s = canvas.scale
    const screenX = browser.x * s + canvas.x
    const screenY = browser.y * s + canvas.y
    const screenW = browser.width * s
    const screenH = browser.height * s

    const inset = BORDER_W * s
    const maxBottom = windowHeight - STATUS_BAR_H
    const bx = screenX + inset
    const by = screenY + inset
    const bw = screenW - inset * 2
    const bh = Math.min(screenH - inset * 2, maxBottom - by)
    const bounds = {
      x: Math.round(bx),
      y: Math.round(by),
      width: Math.round(Math.max(0, bw)),
      height: Math.round(Math.max(0, bh)),
    }
    const last = lastBoundsRef.current
    if (
      bounds.x !== last.x ||
      bounds.y !== last.y ||
      bounds.width !== last.width ||
      bounds.height !== last.height
    ) {
      lastBoundsRef.current = bounds
      window.cells.browser.updateBounds(browser.id, bounds)
    }

    const roundedZoom = Math.round(s * 100) / 100
    if (roundedZoom !== lastZoomRef.current) {
      lastZoomRef.current = roundedZoom
      window.cells.browser.setZoomFactor(browser.id, roundedZoom)
    }

    const shouldBeVisible = !overlayOpen && bounds.width >= 20 && bounds.height >= 20
    if (shouldBeVisible !== lastVisibleRef.current) {
      lastVisibleRef.current = shouldBeVisible
      window.cells.browser.setVisible(browser.id, shouldBeVisible)
    }
  }, [
    browser.id,
    browser.x,
    browser.y,
    browser.width,
    browser.height,
    canvas.x,
    canvas.y,
    canvas.scale,
    isFocused,
    overlayOpen,
    viewReady,
    windowHeight,
  ])

  const handleEdgeMouseDown = useCallback(
    (edge: Edge, e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsResizing(true)

      const startX = e.clientX
      const startY = e.clientY
      const startW = browser.width
      const startH = browser.height
      const startBx = browser.x
      const startBy = browser.y

      const movesLeft = edge.includes('w')
      const movesRight = edge.includes('e')
      const movesTop = edge.includes('n')
      const movesBottom = edge.includes('s')

      const handleMouseMove = (ev: globalThis.MouseEvent) => {
        const dx = (ev.clientX - startX) / scale
        const dy = (ev.clientY - startY) / scale
        let newW = startW,
          newH = startH,
          newX = startBx,
          newY = startBy
        if (movesRight) newW = Math.max(MIN_W, startW + dx)
        if (movesBottom) newH = Math.max(MIN_H, startH + dy)
        if (movesLeft) {
          newW = Math.max(MIN_W, startW - dx)
          newX = startBx + (startW - newW)
        }
        if (movesTop) {
          newH = Math.max(MIN_H, startH - dy)
          newY = startBy + (startH - newH)
        }
        resizeBrowser(browser.id, newW, newH)
        if (movesLeft || movesTop) moveBrowser(browser.id, newX, newY)
      }

      const handleMouseUp = () => {
        setIsResizing(false)
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [
      browser.id,
      browser.width,
      browser.height,
      browser.x,
      browser.y,
      scale,
      resizeBrowser,
      moveBrowser,
    ],
  )

  const handleNodeMouseDown = useCallback(
    (e: MouseEvent) => {
      focusBrowser(browser.id)
      if (!cmdHeld) return
      e.preventDefault()
      e.stopPropagation()
      onDragStart(browser.id, e.clientX, e.clientY)
    },
    [cmdHeld, browser.id, onDragStart, focusBrowser],
  )

  const zBase = browser.pinned ? 10000 : 0
  const z = zBase + (browser.zIndex ?? 0)

  return (
    <div
      data-browser-id={browser.id}
      className={cn(
        'browser-node absolute',
        isResizing && 'pointer-events-none',
        cmdHeld && 'cursor-grab',
      )}
      style={{
        left: browser.x,
        top: browser.y,
        width: browser.width,
        height: browser.height,
        zIndex: z,
      }}
      onMouseDown={handleNodeMouseDown}
    >
      {cmdHeld && <div className="absolute inset-0 z-10 cursor-grab" />}

      {/* Content area — WebContentsView covers this when focused.
          Always dark bg so hiding the native view (popover/overlay) doesn't flash white. */}
      <div
        ref={contentRef}
        className={cn(
          'w-full h-full rounded-lg overflow-hidden bg-background relative',
          !overscroll && (isFocused ? 'ring-1 ring-white/10' : 'ring-1 ring-border/20'),
        )}
        style={
          overscroll
            ? {
                boxShadow:
                  overscroll.direction === 'back'
                    ? `inset ${3 + overscroll.progress * 3}px 0 0 0 ${overscroll.progress >= 1 ? 'oklch(0.7 0.15 220 / 0.9)' : `oklch(0.6 0.12 220 / ${0.2 + overscroll.progress * 0.5})`}, 0 0 ${overscroll.progress * 16}px ${overscroll.direction === 'back' ? '-2px' : '2px'} oklch(0.6 0.15 220 / ${overscroll.progress * 0.3})`
                    : `inset -${3 + overscroll.progress * 3}px 0 0 0 ${overscroll.progress >= 1 ? 'oklch(0.7 0.15 220 / 0.9)' : `oklch(0.6 0.12 220 / ${0.2 + overscroll.progress * 0.5})`}, 0 0 ${overscroll.progress * 16}px ${overscroll.direction === 'forward' ? '2px' : '-2px'} oklch(0.6 0.15 220 / ${overscroll.progress * 0.3})`,
              }
            : undefined
        }
      >
        {/* Loading indicator — traces entire border starting from bottom-left */}
        {isLoading && (
          <svg
            className="absolute inset-0 z-30 pointer-events-none animate-border-trace"
            style={{ width: '100%', height: '100%' }}
            viewBox={`0 0 ${browser.width} ${browser.height}`}
            preserveAspectRatio="none"
          >
            <rect
              x="1"
              y="1"
              width={browser.width - 2}
              height={browser.height - 2}
              rx="8"
              ry="8"
              fill="none"
              stroke="oklch(0.65 0.18 250)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              pathLength="1"
              strokeDasharray="0.25 0.75"
              strokeDashoffset="0"
              style={{ filter: 'drop-shadow(0 0 4px oklch(0.65 0.18 250 / 0.5))' }}
            />
          </svg>
        )}
        {/* Placeholder shown when native view is hidden (not focused, not ready, or overlay open) */}
        {(!isFocused || !viewReady || overlayOpen) && (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2">
            {isFocused && !viewReady ? (
              <div className="w-5 h-5 border-2 border-muted-foreground/20 border-t-muted-foreground/60 rounded-full animate-spin" />
            ) : (
              <Globe className="w-8 h-8 text-muted-foreground/20" />
            )}
            <span className="text-[11px] text-muted-foreground/30 truncate max-w-[80%] text-center">
              {isFocused && !viewReady ? 'Loading...' : browser.title || browser.url || 'New Tab'}
            </span>
          </div>
        )}
      </div>

      {/* Resize handles — edges */}
      <div
        className="absolute z-30 cursor-n-resize"
        style={{ top: -HANDLE / 2, left: HANDLE, right: HANDLE, height: HANDLE }}
        onMouseDown={(e) => handleEdgeMouseDown('n', e)}
      />
      <div
        className="absolute z-30 cursor-s-resize"
        style={{ bottom: -HANDLE / 2, left: HANDLE, right: HANDLE, height: HANDLE }}
        onMouseDown={(e) => handleEdgeMouseDown('s', e)}
      />
      <div
        className="absolute z-30 cursor-w-resize"
        style={{ left: -HANDLE / 2, top: HANDLE, bottom: HANDLE, width: HANDLE }}
        onMouseDown={(e) => handleEdgeMouseDown('w', e)}
      />
      <div
        className="absolute z-30 cursor-e-resize"
        style={{ right: -HANDLE / 2, top: HANDLE, bottom: HANDLE, width: HANDLE }}
        onMouseDown={(e) => handleEdgeMouseDown('e', e)}
      />

      {/* Resize handles — corners */}
      <div
        className="absolute z-30 cursor-nw-resize"
        style={{ top: -HANDLE / 2, left: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 }}
        onMouseDown={(e) => handleEdgeMouseDown('nw', e)}
      />
      <div
        className="absolute z-30 cursor-ne-resize"
        style={{ top: -HANDLE / 2, right: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 }}
        onMouseDown={(e) => handleEdgeMouseDown('ne', e)}
      />
      <div
        className="absolute z-30 cursor-sw-resize"
        style={{ bottom: -HANDLE / 2, left: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 }}
        onMouseDown={(e) => handleEdgeMouseDown('sw', e)}
      />
      <div
        className="absolute z-30 cursor-se-resize"
        style={{ bottom: -HANDLE / 2, right: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 }}
        onMouseDown={(e) => handleEdgeMouseDown('se', e)}
      />
    </div>
  )
}
