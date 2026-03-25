import { useState, useRef, useCallback, useEffect, type MouseEvent } from 'react'
import { EyeOff, Globe, WifiOff } from 'lucide-react'
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
  selectionMode: boolean
  isSelected: boolean
  isFocused: boolean
  onDragStart: (
    id: string,
    kind: 'terminal' | 'browser',
    startX: number,
    startY: number,
  ) => void
}

export function BrowserNode({
  browser,
  scale,
  selectionMode,
  isSelected,
  isFocused,
  onDragStart,
}: BrowserNodeProps) {
  const {
    resizeBrowser,
    moveBrowser,
    updateBrowserUrl,
    updateBrowserTitle,
    addBrowserWithUrl,
  } = useStore()
  const activeProjectId = useStore((s) => s.activeProjectId)
  const overlayOpen = useStore((s) => s.overlayOpen)
  const canvas = useStore((s) => s.canvas)
  const dragModeActive = selectionMode

  const [isResizing, setIsResizing] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [viewReady, setViewReady] = useState(false)
  const [offline, setOffline] = useState(!navigator.onLine)
  const [overscroll, setOverscroll] = useState<{
    progress: number
    direction: 'back' | 'forward' | null
  }>({ progress: 0, direction: null })
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [transitionHidden, setTransitionHidden] = useState(false)
  const prevFocusedRef = useRef(isFocused)
  const contentRef = useRef<HTMLDivElement>(null)
  const createdRef = useRef(false)
  const lastBoundsRef = useRef({ x: 0, y: 0, width: 0, height: 0 })

  // Snapshot url/history into refs so the create effect doesn't re-fire on navigation
  const initialUrlRef = useRef(browser.url)
  const initialHistoryRef = useRef(browser.history)
  useEffect(() => {
    initialUrlRef.current = browser.url
  }, [browser.url])
  useEffect(() => {
    initialHistoryRef.current = browser.history
  }, [browser.history])

  // Create or unpark WebContentsView on mount, park on unmount
  useEffect(() => {
    if (!activeProjectId || createdRef.current) return
    createdRef.current = true
    const url = initialUrlRef.current
    const history = initialHistoryRef.current
    window.cells.browser
      .create(browser.id, activeProjectId, history ?? undefined)
      .then((result: any) => {
        setViewReady(true)
        // Only navigate on fresh creation, not when unparking (live page is preserved)
        if (!result?.unparked && url) {
          window.cells.browser.navigate(browser.id, url, useStore.getState().searchEngine)
        }
      })
    return () => {
      createdRef.current = false
      setViewReady(false)
      // Park instead of destroy — keeps the view alive for project switching
      window.cells.browser.park(browser.id)
    }
  }, [browser.id, activeProjectId])

  // Detect network loss — hide native view and auto-reload when back online
  useEffect(() => {
    const goOffline = () => setOffline(true)
    const goOnline = () => {
      setOffline(false)
      window.cells.browser.reload(browser.id)
    }
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
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
    const unsubNav = window.cells.browser.onNavState((id, back, forward) => {
      if (id === browser.id) {
        setCanGoBack(back)
        setCanGoForward(forward)
      }
    })
    return () => {
      unsubTitle()
      unsubUrl()
      unsubNewWindow()
      unsubLoading()
      unsubNav()
    }
  }, [browser.id, updateBrowserTitle, updateBrowserUrl, addBrowserWithUrl])

  // Listen for overscroll gesture progress
  useEffect(() => {
    const unsub = window.cells.browser.onOverscroll((id, progress, direction) => {
      if (id !== browser.id) return
      if (progress <= 0 || !direction) {
        setOverscroll({ progress: 0, direction: null })
      } else {
        setOverscroll({ progress, direction: direction as 'back' | 'forward' })
      }
    })
    return unsub
  }, [browser.id])

  // Hide native view briefly when focus transitions in, so the spring animation is visible
  useEffect(() => {
    if (isFocused && !prevFocusedRef.current && viewReady) {
      const frame = window.requestAnimationFrame(() => {
        setTransitionHidden(true)
      })
      const timer = window.setTimeout(() => setTransitionHidden(false), 250)
      prevFocusedRef.current = isFocused
      return () => {
        window.cancelAnimationFrame(frame)
        window.clearTimeout(timer)
      }
    }
    prevFocusedRef.current = isFocused
  }, [isFocused, viewReady])

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

    const shouldBeVisible =
      !overlayOpen &&
      !offline &&
      !dragModeActive &&
      !transitionHidden &&
      bounds.width >= 20 &&
      bounds.height >= 20
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
    dragModeActive,
    isFocused,
    offline,
    overlayOpen,
    transitionHidden,
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
      if (!selectionMode) return
      e.preventDefault()
      e.stopPropagation()
      onDragStart(browser.id, 'browser', e.clientX, e.clientY)
    },
    [selectionMode, browser.id, onDragStart],
  )

  const zBase = browser.pinned ? 10000 : 0
  const z = zBase + (browser.zIndex ?? 0)

  return (
    <div
      data-browser-id={browser.id}
      className={cn(
        'browser-node absolute',
        isResizing && 'pointer-events-none',
        dragModeActive && 'cursor-grab',
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
      {dragModeActive && <div className="absolute inset-0 z-10 cursor-grab" />}

      {/* Content area — WebContentsView covers this when focused.
          Always dark bg so hiding the native view (popover/overlay) doesn't flash white. */}
      <div
        ref={contentRef}
        className={cn(
          'w-full h-full rounded-lg overflow-hidden bg-background relative',
          isFocused ? 'ring-1 ring-white/10' : 'ring-1 ring-border/20',
          isSelected && 'ring-2 ring-primary/70 ring-offset-1 ring-offset-background',
        )}
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
        {/* Placeholder shown when native view is hidden */}
        {(!isFocused || !viewReady || overlayOpen || offline || dragModeActive || transitionHidden) && (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2">
            {offline ? (
              <WifiOff className="w-8 h-8 text-muted-foreground/30" />
            ) : dragModeActive && isFocused ? (
              <EyeOff className="w-6 h-6 text-muted-foreground/25" />
            ) : isFocused && !viewReady ? (
              <div className="w-5 h-5 border-2 border-muted-foreground/20 border-t-muted-foreground/60 rounded-full animate-spin" />
            ) : (
              <Globe className="w-8 h-8 text-muted-foreground/20" />
            )}
            <span className="text-[11px] text-muted-foreground/30 truncate max-w-[80%] text-center">
              {offline
                ? 'No internet connection — will reload automatically'
                : selectionMode && isFocused
                ? 'Selection mode active — drag to move this panel'
                  : isFocused && !viewReady
                    ? 'Loading...'
                    : browser.title || browser.url || 'New Tab'}
            </span>
            {dragModeActive && isFocused && (
              <span className="text-[10px] text-muted-foreground/20 mt-1">
                {selectionMode
                  ? 'Hold Cmd and drag on the canvas to marquee select multiple panels'
                  : 'Swipe left or right at the edge to navigate back/forward'}
              </span>
            )}
          </div>
        )}

        {/* Overscroll gesture indicators — bottom edge corner glows */}
        {overscroll.direction === 'back' && overscroll.progress > 0 && canGoBack && (
          <div
            className="absolute inset-x-0 bottom-0 z-20 pointer-events-none rounded-b-lg"
            style={{
              height: 80,
              opacity: 0.2 + Math.min(overscroll.progress, 1.1) * 0.6,
              background:
                'radial-gradient(ellipse 55% 130% at 0% 100%, oklch(0.72 0.16 220) 0%, transparent 100%)',
            }}
          />
        )}
        {overscroll.direction === 'forward' && overscroll.progress > 0 && canGoForward && (
          <div
            className="absolute inset-x-0 bottom-0 z-20 pointer-events-none rounded-b-lg"
            style={{
              height: 80,
              opacity: 0.2 + Math.min(overscroll.progress, 1.1) * 0.6,
              background:
                'radial-gradient(ellipse 55% 130% at 100% 100%, oklch(0.78 0.15 85) 0%, transparent 100%)',
            }}
          />
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
