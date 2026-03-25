import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type MouseEvent,
  type WheelEvent,
} from 'react'
import { motion, useMotionValue, useSpring } from 'motion/react'
import { useHotkey } from '@tanstack/react-hotkeys'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import { STATUS_BAR_HEIGHT, getCanvasWindows, getViewportRect } from '@/lib/canvas-navigation'
import {
  applySelectionDelta,
  createSelectionOrigins,
  getIntersectingWindowIds,
  screenPointsToCanvasRect,
  type CanvasSelectableWindow,
} from '@/lib/canvas-selection'
import { TerminalNode } from './terminal-node'
import { BrowserNode } from './browser-node'

const MIN_ZOOM = 0.15
const MAX_ZOOM = 1.5
const SNAP_DELAY_MIN = 80 // snap almost instantly when terminal fills view
const SNAP_DELAY_MAX = 400 // slow snap when terminal is barely visible
const SNAP_DISABLE_ZOOM = 0.5

const SPRING_NORMAL = { stiffness: 300, damping: 30 }
const SPRING_FAST = { stiffness: 800, damping: 50 }

export function InfiniteCanvas() {
  const {
    terminals,
    browsers,
    canvas: transform,
    moveTerminal,
    moveBrowser,
    setCanvasTransform,
    snapToNearest,
    snapToTerminal,
    snapToClosest,
    snapEnabled,
    snapFast: snapFastFlag,
    setSnapPaused,
    selectionMode,
    setSelectionMode,
    setSelectionCount,
    focusedTerminalId,
    focusedBrowserId,
    focusTerminal,
  } = useStore()

  const containerRef = useRef<HTMLDivElement>(null)
  const [isPanning, setIsPanning] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isUserDriving, setIsUserDriving] = useState(false) // true while user is actively panning/scrolling
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([])
  const [marqueeBox, setMarqueeBox] = useState<{
    x: number
    y: number
    width: number
    height: number
  } | null>(null)
  const panRef = useRef<{
    startX: number
    startY: number
    startTx: number
    startTy: number
  } | null>(null)
  const dragRef = useRef<{
    startX: number
    startY: number
    origins: ReturnType<typeof createSelectionOrigins>
  } | null>(null)
  const marqueeRef = useRef<{ startX: number; startY: number } | null>(null)
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectableWindows = useMemo<CanvasSelectableWindow[]>(
    () => [
      ...terminals.map((terminal) => ({ ...terminal, kind: 'terminal' as const })),
      ...browsers.map((browser) => ({ ...browser, kind: 'browser' as const })),
    ],
    [terminals, browsers],
  )

  // Animated motion values — these drive the visual transform
  const springConfig = snapFastFlag ? SPRING_FAST : SPRING_NORMAL
  const motionX = useMotionValue(transform.x)
  const motionY = useMotionValue(transform.y)
  const motionScale = useMotionValue(transform.scale)

  const springX = useSpring(motionX, springConfig)
  const springY = useSpring(motionY, springConfig)
  const springScale = useSpring(motionScale, springConfig)
  const viewportRect = getViewportRect(transform)
  const viewportArea = viewportRect.width * viewportRect.height
  const visibleWindowCount =
    viewportArea > 0
      ? getCanvasWindows(terminals, browsers).reduce((count, window) => {
          const overlapW = Math.max(
            0,
            Math.min(window.x + window.width, viewportRect.x + viewportRect.width) -
              Math.max(window.x, viewportRect.x),
          )
          const overlapH = Math.max(
            0,
            Math.min(window.y + window.height, viewportRect.y + viewportRect.height) -
              Math.max(window.y, viewportRect.y),
          )
          const coverage = (overlapW * overlapH) / viewportArea
          return coverage >= 0.08 ? count + 1 : count
        }, 0)
      : 0
  const showFocusedTerminalRing = visibleWindowCount >= 2

  // When user is actively driving (panning/scrolling), bypass springs and set directly
  // When animating (snap), let springs interpolate
  useEffect(() => {
    if (isUserDriving) {
      motionX.jump(transform.x)
      motionY.jump(transform.y)
      motionScale.jump(transform.scale)
    } else {
      motionX.set(transform.x)
      motionY.set(transform.y)
      motionScale.set(transform.scale)
    }
  }, [transform.x, transform.y, transform.scale, isUserDriving, motionX, motionY, motionScale])

  // Schedule a snap — delay scales with how much the closest terminal fills the viewport
  const scheduleSnap = useCallback(() => {
    if (!snapEnabled) return
    const { canvas, terminals: terms, browsers } = useStore.getState()
    if (canvas.scale < SNAP_DISABLE_ZOOM) {
      setSnapPaused(true)
      return
    }
    setSnapPaused(false)
    const windows = getCanvasWindows(terms, browsers)
    if (windows.length === 0) return

    // Find the window with the most overlap with the viewport
    const viewW = window.innerWidth
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT
    const viewL = -canvas.x / canvas.scale
    const viewT = -canvas.y / canvas.scale
    const viewR = viewL + viewW / canvas.scale
    const viewB = viewT + viewH / canvas.scale
    const viewArea = (viewR - viewL) * (viewB - viewT)

    let maxCoverage = 0
    for (const window of windows) {
      const overlapW = Math.max(
        0,
        Math.min(window.x + window.width, viewR) - Math.max(window.x, viewL),
      )
      const overlapH = Math.max(
        0,
        Math.min(window.y + window.height, viewB) - Math.max(window.y, viewT),
      )
      const coverage = (overlapW * overlapH) / viewArea
      if (coverage > maxCoverage) maxCoverage = coverage
    }

    // More coverage → shorter delay (linear interpolation, clamped)
    const t = Math.min(Math.max(maxCoverage, 0), 1)
    const delay = SNAP_DELAY_MAX - t * (SNAP_DELAY_MAX - SNAP_DELAY_MIN)

    if (snapTimerRef.current) clearTimeout(snapTimerRef.current)
    snapTimerRef.current = setTimeout(() => {
      setIsUserDriving(false)
      setSnapPaused(false)
      snapToClosest()
    }, delay)
  }, [snapToClosest, snapEnabled, setSnapPaused])

  const cancelSnap = useCallback(() => {
    if (snapTimerRef.current) {
      clearTimeout(snapTimerRef.current)
      snapTimerRef.current = null
    }
  }, [])

  // Pan handlers
  const handleCanvasMouseDown = useCallback(
    (e: MouseEvent) => {
      const termNode = (e.target as HTMLElement).closest('.terminal-node')
      const browserNode = (e.target as HTMLElement).closest('.browser-node')
      const clickedNode = termNode || browserNode

      if (selectionMode) {
        if (!clickedNode && e.button === 0 && e.metaKey) {
          e.preventDefault()
          e.stopPropagation()
          cancelSnap()
          setIsUserDriving(false)
          marqueeRef.current = { startX: e.clientX, startY: e.clientY }
          setMarqueeBox({ x: e.clientX, y: e.clientY, width: 0, height: 0 })
          setSelectedNodeIds([])
          focusTerminal(null)
          return
        }

        if (!clickedNode && e.button === 0) {
          e.preventDefault()
          e.stopPropagation()
          setSelectedNodeIds([])
          focusTerminal(null)
          return
        }
      }

      if (clickedNode) return

      if (e.button === 0 || e.button === 1) {
        e.preventDefault()
        cancelSnap()
        setIsUserDriving(true)
        focusTerminal(null)
        setIsPanning(true)
        panRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          startTx: transform.x,
          startTy: transform.y,
        }
      }
    },
    [transform.x, transform.y, focusTerminal, cancelSnap, selectionMode],
  )

  const handleMouseMove = useCallback(
    (e: globalThis.MouseEvent) => {
      if (isPanning && panRef.current) {
        const dx = e.clientX - panRef.current.startX
        const dy = e.clientY - panRef.current.startY
        setCanvasTransform({
          ...transform,
          x: panRef.current.startTx + dx,
          y: panRef.current.startTy + dy,
        })
      }

      if (isDragging && dragRef.current) {
        const dx = (e.clientX - dragRef.current.startX) / transform.scale
        const dy = (e.clientY - dragRef.current.startY) / transform.scale
        const moved = applySelectionDelta(dragRef.current.origins, dx, dy)
        for (const [id, origin] of Object.entries(moved)) {
          if (origin.kind === 'browser') {
            moveBrowser(id, origin.x, origin.y)
          } else {
            moveTerminal(id, origin.x, origin.y)
          }
        }
      }

      if (marqueeRef.current) {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return

        const nextRect = screenPointsToCanvasRect(
          { x: marqueeRef.current.startX, y: marqueeRef.current.startY },
          { x: e.clientX, y: e.clientY },
          transform,
        )
        setSelectedNodeIds(getIntersectingWindowIds(selectableWindows, nextRect))
        setMarqueeBox({
          x: Math.min(marqueeRef.current.startX, e.clientX) - rect.left,
          y: Math.min(marqueeRef.current.startY, e.clientY) - rect.top,
          width: Math.abs(e.clientX - marqueeRef.current.startX),
          height: Math.abs(e.clientY - marqueeRef.current.startY),
        })
      }
    },
    [
      isPanning,
      isDragging,
      transform,
      setCanvasTransform,
      moveTerminal,
      moveBrowser,
      selectableWindows,
    ],
  )

  const handleMouseUp = useCallback(() => {
    const wasPanning = isPanning
    setIsPanning(false)
    setIsDragging(false)
    setMarqueeBox(null)
    panRef.current = null
    dragRef.current = null
    marqueeRef.current = null
    if (wasPanning && (terminals.length > 0 || browsers.length > 0) && snapEnabled) {
      scheduleSnap()
    } else {
      setIsUserDriving(false)
    }
  }, [isPanning, terminals.length, browsers.length, scheduleSnap, snapEnabled])

  useEffect(() => {
    setSelectionCount(selectedNodeIds.length)
  }, [selectedNodeIds.length, setSelectionCount])

  useEffect(() => {
    return useStore.subscribe((state, previousState) => {
      if (state.selectionMode || state.selectionMode === previousState.selectionMode) return
      setSelectedNodeIds([])
      setMarqueeBox(null)
      setIsDragging(false)
      dragRef.current = null
      marqueeRef.current = null
      setSelectionCount(0)
    })
  }, [setSelectionCount])

  // Wheel handler: trackpad pan + pinch zoom, with snap-after-idle
  // Reads canvas state directly from the store on each event so rapid trackpad
  // events never read a stale closure value (multiple events can fire per frame).
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      cancelSnap()
      setIsUserDriving(true)

      const current = useStore.getState().canvas

      if (e.ctrlKey || e.metaKey) {
        const zoomIntensity = 0.01
        const newScale = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, current.scale * (1 - e.deltaY * zoomIntensity)),
        )

        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return

        const mouseX = e.clientX - rect.left
        const mouseY = e.clientY - rect.top
        const ratio = newScale / current.scale

        setCanvasTransform({
          x: mouseX - (mouseX - current.x) * ratio,
          y: mouseY - (mouseY - current.y) * ratio,
          scale: newScale,
        })
      } else {
        setCanvasTransform({
          x: current.x - e.deltaX,
          y: current.y - e.deltaY,
          scale: current.scale,
        })
      }

      if ((terminals.length > 0 || browsers.length > 0) && snapEnabled) {
        scheduleSnap()
      }
    },
    [setCanvasTransform, cancelSnap, scheduleSnap, terminals.length, browsers.length, snapEnabled],
  )

  // Terminal drag handler
  const beginSelectionDrag = useCallback(
    (dragIds: string[], startX: number, startY: number) => {
      if (dragIds.length === 0) return
      setIsDragging(true)
      dragRef.current = {
        startX,
        startY,
        origins: createSelectionOrigins(selectableWindows, dragIds),
      }
    },
    [selectableWindows],
  )

  const handleNodeDragStart = useCallback(
    (nodeId: string, kind: 'terminal' | 'browser', startX: number, startY: number) => {
      if (!selectionMode) {
        return
      }

      const dragIds = selectedNodeIds.includes(nodeId) ? selectedNodeIds : [nodeId]
      setSelectedNodeIds(dragIds)
      beginSelectionDrag(dragIds, startX, startY)
    },
    [selectionMode, selectedNodeIds, beginSelectionDrag],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 's' || !event.ctrlKey || event.metaKey || event.altKey) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      setSelectionMode(!useStore.getState().selectionMode)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [setSelectionMode])

  // Keyboard shortcuts
  useHotkey('Mod+Enter', () => {
    setIsUserDriving(false)
    const terms = useStore.getState().terminals
    if (terms.length > 0) {
      snapToTerminal(focusedTerminalId || terms[0].id)
    }
  })
  useHotkey('Mod+ArrowLeft', () => {
    setIsUserDriving(false)
    snapToNearest('left')
  })
  useHotkey('Mod+ArrowRight', () => {
    setIsUserDriving(false)
    snapToNearest('right')
  })
  useHotkey('Mod+ArrowUp', () => {
    setIsUserDriving(false)
    snapToNearest('up')
  })
  useHotkey('Mod+ArrowDown', () => {
    setIsUserDriving(false)
    snapToNearest('down')
  })
  useHotkey('Mod+0', () => {
    setIsUserDriving(false)
    const { focusedTerminalId: fid, terminals: terms, zoomToFit: fit } = useStore.getState()
    const id = fid || terms[0]?.id
    if (id) fit(id)
  })

  // Global mouse listeners for drag/pan
  useEffect(() => {
    if (isPanning || isDragging || marqueeBox) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [isPanning, isDragging, marqueeBox, handleMouseMove, handleMouseUp])

  return (
    <div
      ref={containerRef}
      className={cn(
        'canvas-stage flex-1 min-h-0 overflow-hidden relative',
        (isPanning || isDragging) && 'cursor-grabbing',
        selectionMode && !isPanning && !isDragging && 'cursor-default',
      )}
      onMouseDown={handleCanvasMouseDown}
      onWheel={handleWheel}
    >
      {/* Transform layer — spring-animated */}
      <motion.div
        className="absolute origin-top-left no-select"
        style={{
          x: springX,
          y: springY,
          scale: springScale,
          willChange: 'transform',
        }}
      >
        {terminals.map((terminal) => (
          <TerminalNode
            key={terminal.id}
            terminal={terminal}
            scale={transform.scale}
            selectionMode={selectionMode}
            isSelected={selectedNodeIds.includes(terminal.id)}
            isFocused={focusedTerminalId === terminal.id}
            showFocusRing={focusedTerminalId === terminal.id && showFocusedTerminalRing}
            onDragStart={handleNodeDragStart}
          />
        ))}
        {browsers.map((browser) => (
          <BrowserNode
            key={browser.id}
            browser={browser}
            scale={transform.scale}
            selectionMode={selectionMode}
            isSelected={selectedNodeIds.includes(browser.id)}
            isFocused={focusedBrowserId === browser.id}
            onDragStart={handleNodeDragStart}
          />
        ))}
      </motion.div>

      {marqueeBox && (
        <div
          className="pointer-events-none absolute z-30 rounded-lg border border-primary/70 bg-primary/10 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
          style={{
            left: marqueeBox.x,
            top: marqueeBox.y,
            width: marqueeBox.width,
            height: marqueeBox.height,
          }}
        />
      )}

      {/* Empty state */}
      {terminals.length === 0 && browsers.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <p className="text-muted-foreground/40 text-sm">Press ⌘T to get started</p>
          </div>
        </div>
      )}
    </div>
  )
}
