import { useRef, useState, useCallback, useEffect, type MouseEvent, type WheelEvent } from 'react'
import { motion, useMotionValue, useSpring } from 'motion/react'
import { useHotkey, useKeyHold } from '@tanstack/react-hotkeys'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import { STATUS_BAR_HEIGHT, getCanvasWindows } from '@/lib/canvas-navigation'
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
    focusedTerminalId,
    focusedBrowserId,
    focusTerminal,
  } = useStore()

  const containerRef = useRef<HTMLDivElement>(null)
  const [isPanning, setIsPanning] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isUserDriving, setIsUserDriving] = useState(false) // true while user is actively panning/scrolling
  const cmdHeld = useKeyHold('Meta')
  const panRef = useRef<{
    startX: number
    startY: number
    startTx: number
    startTy: number
  } | null>(null)
  const dragRef = useRef<{
    termId: string
    isBrowser?: boolean
    startX: number
    startY: number
    origX: number
    origY: number
  } | null>(null)
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Animated motion values — these drive the visual transform
  const springConfig = snapFastFlag ? SPRING_FAST : SPRING_NORMAL
  const motionX = useMotionValue(transform.x)
  const motionY = useMotionValue(transform.y)
  const motionScale = useMotionValue(transform.scale)

  const springX = useSpring(motionX, springConfig)
  const springY = useSpring(motionY, springConfig)
  const springScale = useSpring(motionScale, springConfig)

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
      if ((termNode || browserNode) && !cmdHeld) return

      if (e.button === 0 || e.button === 1) {
        e.preventDefault()
        cancelSnap()
        setIsUserDriving(true)
        if (!cmdHeld) focusTerminal(null)
        setIsPanning(true)
        panRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          startTx: transform.x,
          startTy: transform.y,
        }
      }
    },
    [transform.x, transform.y, cmdHeld, focusTerminal, cancelSnap],
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
        const moveFn = dragRef.current.isBrowser ? moveBrowser : moveTerminal
        moveFn(dragRef.current.termId, dragRef.current.origX + dx, dragRef.current.origY + dy)
      }
    },
    [isPanning, isDragging, transform, setCanvasTransform, moveTerminal, moveBrowser],
  )

  const handleMouseUp = useCallback(() => {
    const wasPanning = isPanning
    setIsPanning(false)
    setIsDragging(false)
    panRef.current = null
    dragRef.current = null
    if (wasPanning && (terminals.length > 0 || browsers.length > 0) && snapEnabled) {
      scheduleSnap()
    } else {
      setIsUserDriving(false)
    }
  }, [isPanning, terminals.length, browsers.length, scheduleSnap, snapEnabled])

  // Wheel handler: trackpad pan + pinch zoom, with snap-after-idle
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      cancelSnap()
      setIsUserDriving(true)

      if (e.ctrlKey || e.metaKey) {
        const zoomIntensity = 0.01
        const newScale = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, transform.scale * (1 - e.deltaY * zoomIntensity)),
        )

        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return

        const mouseX = e.clientX - rect.left
        const mouseY = e.clientY - rect.top
        const ratio = newScale / transform.scale

        setCanvasTransform({
          x: mouseX - (mouseX - transform.x) * ratio,
          y: mouseY - (mouseY - transform.y) * ratio,
          scale: newScale,
        })
      } else {
        setCanvasTransform({
          ...transform,
          x: transform.x - e.deltaX,
          y: transform.y - e.deltaY,
        })
      }

      if ((terminals.length > 0 || browsers.length > 0) && snapEnabled) {
        scheduleSnap()
      }
    },
    [
      transform,
      setCanvasTransform,
      cancelSnap,
      scheduleSnap,
      terminals.length,
      browsers.length,
      snapEnabled,
    ],
  )

  // Terminal drag handler
  const handleTerminalDragStart = useCallback(
    (termId: string, startX: number, startY: number) => {
      const terminal = terminals.find((t) => t.id === termId)
      if (!terminal) return
      setIsDragging(true)
      dragRef.current = {
        termId,
        startX,
        startY,
        origX: terminal.x,
        origY: terminal.y,
      }
    },
    [terminals],
  )

  // Browser drag handler
  const handleBrowserDragStart = useCallback(
    (browserId: string, startX: number, startY: number) => {
      const browser = browsers.find((b) => b.id === browserId)
      if (!browser) return
      setIsDragging(true)
      dragRef.current = {
        termId: browserId,
        isBrowser: true,
        startX,
        startY,
        origX: browser.x,
        origY: browser.y,
      }
    },
    [browsers],
  )

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
    if (isPanning || isDragging) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [isPanning, isDragging, handleMouseMove, handleMouseUp])

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex-1 min-h-0 overflow-hidden relative bg-canvas canvas-grid',
        (isPanning || (cmdHeld && isDragging)) && 'cursor-grabbing',
        cmdHeld && !isPanning && !isDragging && 'cursor-grab',
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
            cmdHeld={cmdHeld}
            isFocused={focusedTerminalId === terminal.id}
            onDragStart={handleTerminalDragStart}
          />
        ))}
        {browsers.map((browser) => (
          <BrowserNode
            key={browser.id}
            browser={browser}
            scale={transform.scale}
            cmdHeld={cmdHeld}
            isFocused={focusedBrowserId === browser.id}
            onDragStart={handleBrowserDragStart}
          />
        ))}
      </motion.div>

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
