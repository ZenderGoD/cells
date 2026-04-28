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
import { hasPrimaryModifier, isPrimaryModifierKey } from '@/lib/keyboard-shortcuts'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import { getCanvasViewportSize, getCanvasWindows, getViewportRect } from '@/lib/canvas-navigation'
import {
  applySelectionDelta,
  createSelectionOrigins,
  getIntersectingWindowIds,
  screenPointsToCanvasRect,
  type CanvasSelectableWindow,
} from '@/lib/canvas-selection'
import { TerminalNode } from './terminal-node'
import { BrowserNode } from './browser-node'
import { AgentWindowNode } from './agent-window-node'
import { useShallow } from 'zustand/react/shallow'

const MIN_ZOOM = 0.15
const MAX_ZOOM = 1.5
const SNAP_DELAY_MIN = 80 // snap almost instantly when terminal fills view
const SNAP_DELAY_MAX = 400 // slow snap when terminal is barely visible
const SNAP_DISABLE_ZOOM = 0.5
const TERMINAL_VISIBILITY_OVERSCAN_PX = 240
const SNAP_POSITION_EPSILON = 0.5
const SNAP_SCALE_EPSILON = 0.002
const WHEEL_ZOOM_INTENSITY = 0.01
const BROWSER_VIEW_INSET_PX = 3 // Must match the content inset used by BrowserNode.

const SPRING_NORMAL = { stiffness: 300, damping: 30 }
const SPRING_FAST = { stiffness: 800, damping: 50 }

export function InfiniteCanvas() {
  const {
    terminals,
    browsers,
    agentWindows,
    canvas,
    moveCanvasNodes,
    setCanvasTransform,
    snapToTerminal,
    snapToBrowser,
    snapToAgentWindow,
    snapToClosest,
    snapEnabled,
    snapFast: snapFastFlag,
    setSnapPaused,
    reducedMotion,
    selectionMode,
    selectedNodeIds,
    setSelectedNodeIds,
    focusedTerminalId,
    focusedBrowserId,
    focusedAgentWindowId,
    focusTerminal,
    activeProjectId,
  } = useStore(
    useShallow((s) => ({
      terminals: s.terminals,
      browsers: s.browsers,
      agentWindows: s.agentWindows,
      canvas: s.canvas,
      moveCanvasNodes: s.moveCanvasNodes,
      setCanvasTransform: s.setCanvasTransform,
      snapToTerminal: s.snapToTerminal,
      snapToBrowser: s.snapToBrowser,
      snapToAgentWindow: s.snapToAgentWindow,
      snapToClosest: s.snapToClosest,
      snapEnabled: s.snapEnabled,
      snapFast: s.snapFast,
      setSnapPaused: s.setSnapPaused,
      reducedMotion: s.reducedMotion,
      selectionMode: s.selectionMode,
      selectedNodeIds: s.selectedNodeIds,
      setSelectedNodeIds: s.setSelectedNodeIds,
      focusedTerminalId: s.focusedTerminalId,
      focusedBrowserId: s.focusedBrowserId,
      focusedAgentWindowId: s.focusedAgentWindowId,
      focusTerminal: s.focusTerminal,
      activeProjectId: s.activeProjectId,
    })),
  )
  const titleBarHidden = useStore((s) => s.titleBarHidden)
  const transform = canvas

  const containerRef = useRef<HTMLDivElement>(null)
  const [isPanning, setIsPanning] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isUserDriving, setIsUserDriving] = useState(false) // true while user is actively panning/scrolling
  const [isSnapAnimating, setIsSnapAnimating] = useState(false)
  const [primaryModifierHeld, setPrimaryModifierHeld] = useState(false)
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
    transientSelection: boolean
  } | null>(null)
  const marqueeRef = useRef<{ startX: number; startY: number } | null>(null)
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectableWindows = useMemo<CanvasSelectableWindow[]>(
    () => [
      ...terminals.map((terminal) => ({ ...terminal, kind: 'terminal' as const })),
      ...browsers.map((browser) => ({ ...browser, kind: 'browser' as const })),
      ...agentWindows.map((agentWindow) => ({ ...agentWindow, kind: 'agent' as const })),
    ],
    [terminals, browsers, agentWindows],
  )

  // Animated motion values — these drive the visual transform
  const springConfig = snapFastFlag ? SPRING_FAST : SPRING_NORMAL
  const motionX = useMotionValue(transform.x)
  const motionY = useMotionValue(transform.y)
  const motionScale = useMotionValue(transform.scale)

  const springX = useSpring(motionX, springConfig)
  const springY = useSpring(motionY, springConfig)
  const springScale = useSpring(motionScale, springConfig)
  const animatedX = reducedMotion ? motionX : springX
  const animatedY = reducedMotion ? motionY : springY
  const animatedScale = reducedMotion ? motionScale : springScale
  const viewportSize = getCanvasViewportSize({ titleBarHidden })
  const viewportRect = getViewportRect(transform, viewportSize.width, viewportSize.height)
  const terminalViewportRect = useMemo(() => {
    const overscan = TERMINAL_VISIBILITY_OVERSCAN_PX / Math.max(transform.scale, MIN_ZOOM)
    return {
      x: viewportRect.x - overscan,
      y: viewportRect.y - overscan,
      width: viewportRect.width + overscan * 2,
      height: viewportRect.height + overscan * 2,
    }
  }, [transform.scale, viewportRect.x, viewportRect.y, viewportRect.width, viewportRect.height])
  const viewportArea = viewportRect.width * viewportRect.height
  const visibleWindowCount = useMemo(
    () =>
      viewportArea > 0
        ? getCanvasWindows(terminals, browsers, agentWindows).reduce((count, window) => {
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
        : 0,
    [
      viewportArea,
      viewportRect.x,
      viewportRect.y,
      viewportRect.width,
      viewportRect.height,
      terminals,
      browsers,
      agentWindows,
    ],
  )
  const showFocusedTerminalRing = visibleWindowCount >= 2
  const canvasWillChange = isPanning || isDragging || isUserDriving ? 'transform' : undefined

  const isTerminalVisible = useCallback(
    (terminal: { x: number; y: number; width: number; height: number }) =>
      terminal.x + terminal.width >= terminalViewportRect.x &&
      terminal.x <= terminalViewportRect.x + terminalViewportRect.width &&
      terminal.y + terminal.height >= terminalViewportRect.y &&
      terminal.y <= terminalViewportRect.y + terminalViewportRect.height,
    [terminalViewportRect],
  )

  // When user is actively driving (panning/scrolling), bypass springs and set directly
  // When animating (snap), let springs interpolate
  useEffect(() => {
    if (isUserDriving || reducedMotion) {
      motionX.jump(transform.x)
      motionY.jump(transform.y)
      motionScale.jump(transform.scale)
    } else {
      motionX.set(transform.x)
      motionY.set(transform.y)
      motionScale.set(transform.scale)
    }
  }, [
    transform.x,
    transform.y,
    transform.scale,
    isUserDriving,
    reducedMotion,
    motionX,
    motionY,
    motionScale,
  ])

  // Track snap animation state with a ref to avoid redundant setState calls
  // inside the rAF polling loop.
  const isSnapAnimatingRef = useRef(false)
  const prevTransformRef = useRef({ x: transform.x, y: transform.y, scale: transform.scale })

  useEffect(() => {
    const prev = prevTransformRef.current
    prevTransformRef.current = { x: transform.x, y: transform.y, scale: transform.scale }

    if (isUserDriving || reducedMotion) {
      if (isSnapAnimatingRef.current) {
        isSnapAnimatingRef.current = false
        window.requestAnimationFrame(() => {
          setIsSnapAnimating(false)
        })
      }
      return
    }

    // Eagerly mark animating when snap target jumps so the focus-change
    // render and pauseLiveRender update are batched into one pass.
    const jumped =
      Math.abs(prev.x - transform.x) > SNAP_POSITION_EPSILON ||
      Math.abs(prev.y - transform.y) > SNAP_POSITION_EPSILON ||
      Math.abs(prev.scale - transform.scale) > SNAP_SCALE_EPSILON
    if (jumped && !isSnapAnimatingRef.current) {
      isSnapAnimatingRef.current = true
      // Intentional synchronous set: batches focus-change + pauseLiveRender
      // in one render pass, avoiding an extra full re-render of all terminals.
      setIsSnapAnimating(true) // eslint-disable-line react-hooks/set-state-in-effect
    }

    let frame = 0
    let cancelled = false

    const updateAnimationState = () => {
      if (cancelled) return

      const animating =
        Math.abs(animatedX.get() - transform.x) > SNAP_POSITION_EPSILON ||
        Math.abs(animatedY.get() - transform.y) > SNAP_POSITION_EPSILON ||
        Math.abs(animatedScale.get() - transform.scale) > SNAP_SCALE_EPSILON

      if (isSnapAnimatingRef.current !== animating) {
        isSnapAnimatingRef.current = animating
        setIsSnapAnimating(animating)
      }

      if (animating) {
        frame = window.requestAnimationFrame(updateAnimationState)
      }
    }

    // Start polling after a tick to let springs begin
    frame = window.requestAnimationFrame(updateAnimationState)

    return () => {
      cancelled = true
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [
    animatedScale,
    animatedX,
    animatedY,
    isUserDriving,
    reducedMotion,
    transform.scale,
    transform.x,
    transform.y,
  ])

  // Schedule a snap — delay scales with how much the most visible on-canvas
  // window fills the viewport, and we snap back to that same window.
  const scheduleSnap = useCallback(() => {
    if (!snapEnabled) return
    const {
      activeProjectId: scheduledProjectId,
      canvas,
      terminals: terms,
      browsers,
      agentWindows: agents,
    } = useStore.getState()
    if (canvas.scale < SNAP_DISABLE_ZOOM) {
      setSnapPaused(true)
      return
    }
    setSnapPaused(false)
    const windows = getCanvasWindows(terms, browsers, agents)
    if (windows.length === 0) return

    // Find the window with the most overlap with the viewport
    const { width: viewW, height: viewH } = getCanvasViewportSize({
      titleBarHidden: useStore.getState().titleBarHidden,
    })
    const viewL = -canvas.x / canvas.scale
    const viewT = -canvas.y / canvas.scale
    const viewR = viewL + viewW / canvas.scale
    const viewB = viewT + viewH / canvas.scale
    const viewArea = (viewR - viewL) * (viewB - viewT)

    let maxCoverage = 0
    let bestWindow: ReturnType<typeof getCanvasWindows>[number] | null = null
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
      if (coverage > maxCoverage) {
        maxCoverage = coverage
        bestWindow = window
      }
    }

    // More coverage → shorter delay (linear interpolation, clamped)
    const t = Math.min(Math.max(maxCoverage, 0), 1)
    const delay = SNAP_DELAY_MAX - t * (SNAP_DELAY_MAX - SNAP_DELAY_MIN)

    if (snapTimerRef.current) clearTimeout(snapTimerRef.current)
    snapTimerRef.current = setTimeout(() => {
      snapTimerRef.current = null
      if (useStore.getState().activeProjectId !== scheduledProjectId) return
      setIsUserDriving(false)
      setSnapPaused(false)
      if (!bestWindow) {
        snapToClosest()
        return
      }
      if (bestWindow.type === 'terminal') {
        snapToTerminal(bestWindow.id)
      } else if (bestWindow.type === 'agent') {
        snapToAgentWindow(bestWindow.id)
      } else {
        snapToBrowser(bestWindow.id)
      }
    }, delay)
  }, [snapToAgentWindow, snapToBrowser, snapToClosest, snapToTerminal, snapEnabled, setSnapPaused])

  const cancelSnap = useCallback(() => {
    if (snapTimerRef.current) {
      clearTimeout(snapTimerRef.current)
      snapTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => cancelSnap()
  }, [cancelSnap])

  // Project switches replace the entire node set; don't let in-flight gestures
  // or springs from the previous project animate the new project into place.
  const activeProjectIdRef = useRef(activeProjectId)
  useEffect(() => {
    if (activeProjectIdRef.current === activeProjectId) return
    activeProjectIdRef.current = activeProjectId

    cancelSnap()
    panRef.current = null
    dragRef.current = null
    marqueeRef.current = null
    prevTransformRef.current = { x: transform.x, y: transform.y, scale: transform.scale }
    isSnapAnimatingRef.current = false

    motionX.jump(transform.x)
    motionY.jump(transform.y)
    motionScale.jump(transform.scale)
    springX.jump(transform.x)
    springY.jump(transform.y)
    springScale.jump(transform.scale)

    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setIsPanning(false)
      setIsDragging(false)
      setIsUserDriving(false)
      setIsSnapAnimating(false)
      setMarqueeBox(null)
      setPrimaryModifierHeld(false)
    })

    return () => {
      cancelled = true
    }
  }, [
    activeProjectId,
    cancelSnap,
    motionScale,
    motionX,
    motionY,
    springScale,
    springX,
    springY,
    transform.scale,
    transform.x,
    transform.y,
  ])

  const applyCanvasWheelGesture = useCallback(
    (gesture: {
      deltaX: number
      deltaY: number
      zoomModifier: boolean
      clientX?: number
      clientY?: number
    }) => {
      cancelSnap()
      setIsUserDriving(true)

      const current = useStore.getState().canvas

      if (gesture.zoomModifier) {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect || gesture.clientX == null || gesture.clientY == null) return

        const newScale = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, current.scale * (1 - gesture.deltaY * WHEEL_ZOOM_INTENSITY)),
        )

        const mouseX = gesture.clientX - rect.left
        const mouseY = gesture.clientY - rect.top
        const ratio = newScale / current.scale

        setCanvasTransform({
          x: mouseX - (mouseX - current.x) * ratio,
          y: mouseY - (mouseY - current.y) * ratio,
          scale: newScale,
        })
      } else {
        setCanvasTransform({
          x: current.x - gesture.deltaX,
          y: current.y - gesture.deltaY,
          scale: current.scale,
        })
      }

      if ((terminals.length > 0 || browsers.length > 0 || agentWindows.length > 0) && snapEnabled) {
        scheduleSnap()
      }
    },
    [
      setCanvasTransform,
      cancelSnap,
      scheduleSnap,
      terminals.length,
      browsers.length,
      agentWindows.length,
      snapEnabled,
    ],
  )

  // Pan handlers
  const handleCanvasMouseDown = useCallback(
    (e: MouseEvent) => {
      const termNode = (e.target as HTMLElement).closest('.terminal-node')
      const browserNode = (e.target as HTMLElement).closest('.browser-node')
      const agentNode = (e.target as HTMLElement).closest('.agent-window-node')
      const clickedNode = termNode || browserNode || agentNode

      if (selectionMode) {
        if (!clickedNode && e.button === 0) {
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
      }

      // Let terminal/browser handle their own clicks (including Cmd+click for links).
      // Only intercept Cmd+click on the non-interactive shell of the node (title bar, resize edges).
      const primaryModifier = hasPrimaryModifier(e)
      const isInsideContent =
        (e.target as HTMLElement).closest('.cell-terminal') ||
        (e.target as HTMLElement).closest('.browser-node > div') ||
        (e.target as HTMLElement).closest('.agent-chat-panel')
      if (clickedNode && (!primaryModifier || isInsideContent)) return

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
    [transform.x, transform.y, focusTerminal, cancelSnap, selectionMode, setSelectedNodeIds],
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
        moveCanvasNodes(
          Object.entries(moved).map(([id, origin]) => ({
            id,
            kind: origin.kind,
            x: origin.x,
            y: origin.y,
          })),
        )
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
      moveCanvasNodes,
      selectableWindows,
      setSelectedNodeIds,
    ],
  )

  const handleMouseUp = useCallback(() => {
    const wasPanning = isPanning
    const clearTransientSelection = dragRef.current?.transientSelection === true
    setIsPanning(false)
    setIsDragging(false)
    setMarqueeBox(null)
    panRef.current = null
    dragRef.current = null
    marqueeRef.current = null
    if (clearTransientSelection) {
      setSelectedNodeIds([])
    }
    if (
      wasPanning &&
      (terminals.length > 0 || browsers.length > 0 || agentWindows.length > 0) &&
      snapEnabled
    ) {
      scheduleSnap()
    } else {
      setIsUserDriving(false)
    }
  }, [
    isPanning,
    setSelectedNodeIds,
    terminals.length,
    browsers.length,
    agentWindows.length,
    scheduleSnap,
    snapEnabled,
  ])

  useEffect(() => {
    return useStore.subscribe((state, previousState) => {
      if (state.selectionMode || state.selectionMode === previousState.selectionMode) return
      setSelectedNodeIds([])
      setMarqueeBox(null)
      setIsDragging(false)
      dragRef.current = null
      marqueeRef.current = null
    })
  }, [setSelectedNodeIds])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isPrimaryModifierKey(e.key)) setPrimaryModifierHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (isPrimaryModifierKey(e.key)) setPrimaryModifierHeld(false)
    }
    const blur = () => setPrimaryModifierHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // Wheel handler: trackpad pan + pinch zoom, with snap-after-idle
  // Reads canvas state directly from the store on each event so rapid trackpad
  // events never read a stale closure value (multiple events can fire per frame).
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      const termNode = (e.target as HTMLElement).closest('.terminal-node')
      const browserNode = (e.target as HTMLElement).closest('.browser-node')
      const agentNode = (e.target as HTMLElement).closest('.agent-window-node')
      const zoomModifier = e.ctrlKey || e.metaKey
      const forceCanvasPan = e.shiftKey && !zoomModifier
      // Let node content own plain scroll, but reserve Cmd/Ctrl+scroll for
      // zoom and Shift+scroll/swipe as an explicit canvas-pan override.
      if ((termNode || browserNode || agentNode) && !zoomModifier && !forceCanvasPan) return

      e.preventDefault()
      e.stopPropagation()
      applyCanvasWheelGesture({
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        zoomModifier,
        clientX: e.clientX,
        clientY: e.clientY,
      })
    },
    [applyCanvasWheelGesture],
  )

  useEffect(() => {
    return window.cells.browser.onCanvasWheel((browserId, gesture) => {
      const zoomModifier = gesture.ctrlKey || gesture.metaKey
      const forceCanvasPan = gesture.shiftKey && !zoomModifier
      if (!zoomModifier && !forceCanvasPan) return

      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return

      const { browsers, canvas } = useStore.getState()
      const browser = browsers.find((entry) => entry.id === browserId)
      if (!browser) return

      const inset = BROWSER_VIEW_INSET_PX * canvas.scale
      applyCanvasWheelGesture({
        deltaX: gesture.deltaX,
        deltaY: gesture.deltaY,
        zoomModifier,
        clientX: rect.left + browser.x * canvas.scale + canvas.x + inset + gesture.clientX,
        clientY: rect.top + browser.y * canvas.scale + canvas.y + inset + gesture.clientY,
      })
    })
  }, [applyCanvasWheelGesture])

  // Terminal drag handler
  const beginSelectionDrag = useCallback(
    (
      dragIds: string[],
      startX: number,
      startY: number,
      options?: { transientSelection?: boolean },
    ) => {
      if (dragIds.length === 0) return
      setIsDragging(true)
      dragRef.current = {
        startX,
        startY,
        origins: createSelectionOrigins(selectableWindows, dragIds),
        transientSelection: options?.transientSelection === true,
      }
    },
    [selectableWindows],
  )

  const handleNodeDragStart = useCallback(
    (nodeId: string, kind: 'terminal' | 'browser' | 'agent', startX: number, startY: number) => {
      const { selectionMode: sm, selectedNodeIds: sel } = useStore.getState()
      if (!sm) {
        setSelectedNodeIds([nodeId])
        beginSelectionDrag([nodeId], startX, startY, { transientSelection: true })
        return
      }

      const dragIds = sel.includes(nodeId) ? sel : [nodeId]
      setSelectedNodeIds(dragIds)
      beginSelectionDrag(dragIds, startX, startY)
    },
    [beginSelectionDrag, setSelectedNodeIds],
  )

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
        primaryModifierHeld && !isPanning && !isDragging && 'cursor-grab',
        selectionMode && !isPanning && !isDragging && !primaryModifierHeld && 'cursor-default',
      )}
      onMouseDown={handleCanvasMouseDown}
      onWheelCapture={handleWheel}
    >
      {/* Transform layer — spring-animated */}
      <motion.div
        className="absolute origin-top-left no-select"
        style={{
          x: animatedX,
          y: animatedY,
          scale: animatedScale,
          willChange: canvasWillChange,
        }}
      >
        {terminals.map((terminal) => (
          <TerminalNode
            key={terminal.id}
            terminal={terminal}
            scale={transform.scale}
            isVisible={isTerminalVisible(terminal)}
            pauseLiveRender={isSnapAnimating && focusedTerminalId !== terminal.id}
            selectionMode={selectionMode}
            isSelected={selectedNodeIds.includes(terminal.id)}
            isFocused={focusedTerminalId === terminal.id}
            showFocusRing={focusedTerminalId === terminal.id && showFocusedTerminalRing}
            onDragStart={handleNodeDragStart}
          />
        ))}
        {browsers
          .filter((b) => !b.pinned)
          .map((browser) => (
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
        {agentWindows.map((agentWindow) => (
          <AgentWindowNode
            key={agentWindow.id}
            agentWindow={agentWindow}
            scale={transform.scale}
            selectionMode={selectionMode}
            isSelected={selectedNodeIds.includes(agentWindow.id)}
            isFocused={focusedAgentWindowId === agentWindow.id}
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
      {terminals.length === 0 && browsers.length === 0 && agentWindows.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <p className="text-muted-foreground/40 text-sm">Press ⌘T to get started</p>
          </div>
        </div>
      )}
    </div>
  )
}
