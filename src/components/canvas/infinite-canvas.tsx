import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type MouseEvent,
  type WheelEvent,
} from 'react'
import { GripHorizontal, Move, Trash2 } from 'lucide-react'
import { motion, useMotionValue, useSpring } from 'motion/react'
import { hasPrimaryModifier, isPrimaryModifierKey } from '@/lib/keyboard-shortcuts'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import { getCanvasViewportSize, getCanvasWindows, getViewportRect } from '@/lib/canvas-navigation'
import { getTopLevelArrangeItems } from '@/lib/canvas-arrange'
import { createWheelModifierBurstState, shouldHonorWheelModifier } from '@/lib/wheel-modifier-burst'
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
import { TextEditorNode } from './text-editor-node'
import { CANVAS_GESTURE_LOCKED_EVENT } from '@/components/ui/popover'
import { CELLS_SHORTCUT_STATE_RESET_EVENT } from '@/lib/cells-shortcuts'
import { useShallow } from 'zustand/react/shallow'
import type { WindowSection } from '@/types'

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
const SECTION_MIN_WIDTH = 320
const SECTION_MIN_HEIGHT = 220
const SECTION_HANDLE_SIZE = 10
type SectionResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const SECTION_RESIZE_EDGES: SectionResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

const SPRING_NORMAL = { stiffness: 300, damping: 30 }
const SPRING_FAST = { stiffness: 800, damping: 50 }

function getSectionCanvasClass(color: WindowSection['color']) {
  switch (color) {
    case 'slate':
      return 'border-slate-300/75 bg-slate-400/[0.12] outline-slate-300/25'
    case 'green':
      return 'border-emerald-300/80 bg-emerald-400/[0.13] outline-emerald-300/30'
    case 'amber':
      return 'border-amber-300/85 bg-amber-400/[0.14] outline-amber-300/30'
    case 'rose':
      return 'border-rose-300/80 bg-rose-400/[0.13] outline-rose-300/30'
    case 'violet':
      return 'border-violet-300/80 bg-violet-400/[0.13] outline-violet-300/30'
    case 'blue':
    default:
      return 'border-sky-300/85 bg-sky-400/[0.14] outline-sky-300/30'
  }
}

function getSectionResizeCursor(edge: SectionResizeEdge) {
  if (edge === 'n' || edge === 's') return 'ns-resize'
  if (edge === 'e' || edge === 'w') return 'ew-resize'
  if (edge === 'ne' || edge === 'sw') return 'nesw-resize'
  return 'nwse-resize'
}

function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

export function InfiniteCanvas() {
  const {
    terminals,
    browsers,
    textEditors,
    agentWindows,
    canvas,
    moveCanvasNodes,
    commitWindowSectionDrag,
    resizeWindowSection,
    removeWindowSection,
    setCanvasTransform,
    snapToTerminal,
    snapToBrowser,
    snapToTextEditor,
    snapToAgentWindow,
    snapToWindowSection,
    snapToClosest,
    snapEnabled,
    snapFast: snapFastFlag,
    setSnapPaused,
    reducedMotion,
    selectionMode,
    selectedNodeIds,
    windowSections,
    togglePinSection,
    autoArrangeMode,
    arrangeDwindleSections,
    setSelectedNodeIds,
    focusedTerminalId,
    focusedBrowserId,
    focusedTextEditorId,
    focusedAgentWindowId,
    focusTerminal,
    activeProjectId,
  } = useStore(
    useShallow((s) => ({
      terminals: s.terminals,
      browsers: s.browsers,
      textEditors: s.textEditors,
      agentWindows: s.agentWindows,
      canvas: s.canvas,
      moveCanvasNodes: s.moveCanvasNodes,
      commitWindowSectionDrag: s.commitWindowSectionDrag,
      resizeWindowSection: s.resizeWindowSection,
      removeWindowSection: s.removeWindowSection,
      setCanvasTransform: s.setCanvasTransform,
      snapToTerminal: s.snapToTerminal,
      snapToBrowser: s.snapToBrowser,
      snapToTextEditor: s.snapToTextEditor,
      snapToAgentWindow: s.snapToAgentWindow,
      snapToWindowSection: s.snapToWindowSection,
      snapToClosest: s.snapToClosest,
      snapEnabled: s.snapEnabled,
      snapFast: s.snapFast,
      setSnapPaused: s.setSnapPaused,
      reducedMotion: s.reducedMotion,
      selectionMode: s.selectionMode,
      selectedNodeIds: s.selectedNodeIds,
      windowSections: s.windowSections,
      togglePinSection: s.togglePinSection,
      autoArrangeMode: s.autoArrangeMode,
      arrangeDwindleSections: s.arrangeDwindleSections,
      setSelectedNodeIds: s.setSelectedNodeIds,
      focusedTerminalId: s.focusedTerminalId,
      focusedBrowserId: s.focusedBrowserId,
      focusedTextEditorId: s.focusedTextEditorId,
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
  const [draggingSectionId, setDraggingSectionId] = useState<string | null>(null)
  const [resizingSectionId, setResizingSectionId] = useState<string | null>(null)
  const wheelModifierBurstRef = useRef(createWheelModifierBurstState())
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
    ids: string[]
  } | null>(null)
  const sectionDragRef = useRef<{
    id: string
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const sectionResizeRef = useRef<{
    id: string
    edge: SectionResizeEdge
    startX: number
    startY: number
    originX: number
    originY: number
    originWidth: number
    originHeight: number
  } | null>(null)
  const marqueeRef = useRef<{ startX: number; startY: number } | null>(null)
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectableWindows = useMemo<CanvasSelectableWindow[]>(
    () => [
      ...terminals.map((terminal) => ({ ...terminal, kind: 'terminal' as const })),
      ...browsers.map((browser) => ({ ...browser, kind: 'browser' as const })),
      ...textEditors.map((editor) => ({ ...editor, kind: 'editor' as const })),
      ...agentWindows.map((agentWindow) => ({ ...agentWindow, kind: 'agent' as const })),
    ],
    [terminals, browsers, textEditors, agentWindows],
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
  const sectionHandleScale = Math.min(5, Math.max(1, 1 / Math.max(transform.scale, 0.2)))
  const sectionHandleExpanded = transform.scale < 0.55
  const getSectionWidth = useCallback(
    (section: WindowSection) =>
      Math.max(SECTION_MIN_WIDTH, section.width ?? viewportSize.width - 16),
    [viewportSize.width],
  )
  const getSectionHeight = useCallback(
    (section: WindowSection) =>
      Math.max(SECTION_MIN_HEIGHT, section.height ?? viewportSize.height - 16),
    [viewportSize.height],
  )
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
  const visibleWindowCount = useMemo(() => {
    if (viewportArea <= 0) return 0
    const windows = getCanvasWindows(terminals, browsers, textEditors, agentWindows)
    const sections = windowSections.map((section) => ({
      id: section.id,
      type: 'section' as const,
      x: section.x,
      y: section.y,
      width: getSectionWidth(section),
      height: getSectionHeight(section),
      windowIds: section.windowIds,
    }))
    return getTopLevelArrangeItems(windows, sections).reduce((count, window) => {
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
  }, [
    getSectionHeight,
    getSectionWidth,
    viewportArea,
    viewportRect.x,
    viewportRect.y,
    viewportRect.width,
    viewportRect.height,
    terminals,
    browsers,
    textEditors,
    agentWindows,
    windowSections,
  ])
  const showFocusedWindowRing = visibleWindowCount >= 2
  const canvasWillChange = isPanning || isDragging || isUserDriving ? 'transform' : undefined
  const renderedWindowSections = useMemo(
    () =>
      windowSections.filter((section) =>
        rectsIntersect(
          {
            x: section.x,
            y: section.y,
            width: getSectionWidth(section),
            height: getSectionHeight(section),
          },
          terminalViewportRect,
        ),
      ),
    [getSectionHeight, getSectionWidth, terminalViewportRect, windowSections],
  )
  const pinnedSectionWindowIds = useMemo(
    () =>
      new Set(
        windowSections.filter((section) => section.pinned).flatMap((section) => section.windowIds),
      ),
    [windowSections],
  )
  const renderedTerminals = useMemo(
    () =>
      terminals.filter((terminal) => {
        if (pinnedSectionWindowIds.has(terminal.id)) return false
        return (
          terminal.id === focusedTerminalId ||
          selectedNodeIds.includes(terminal.id) ||
          rectsIntersect(terminal, terminalViewportRect)
        )
      }),
    [focusedTerminalId, pinnedSectionWindowIds, selectedNodeIds, terminalViewportRect, terminals],
  )
  const renderedBrowsers = useMemo(
    () =>
      browsers.filter((browser) => {
        if (pinnedSectionWindowIds.has(browser.id)) return false
        return (
          browser.id === focusedBrowserId ||
          selectedNodeIds.includes(browser.id) ||
          rectsIntersect(browser, terminalViewportRect)
        )
      }),
    [browsers, focusedBrowserId, pinnedSectionWindowIds, selectedNodeIds, terminalViewportRect],
  )
  const renderedTextEditors = useMemo(
    () =>
      textEditors.filter((editor) => {
        if (pinnedSectionWindowIds.has(editor.id)) return false
        return (
          editor.id === focusedTextEditorId ||
          selectedNodeIds.includes(editor.id) ||
          rectsIntersect(editor, terminalViewportRect)
        )
      }),
    [
      focusedTextEditorId,
      pinnedSectionWindowIds,
      selectedNodeIds,
      terminalViewportRect,
      textEditors,
    ],
  )
  const renderedAgentWindows = useMemo(
    () =>
      agentWindows.filter((agentWindow) => {
        if (pinnedSectionWindowIds.has(agentWindow.id)) return false
        return (
          agentWindow.id === focusedAgentWindowId ||
          selectedNodeIds.includes(agentWindow.id) ||
          rectsIntersect(agentWindow, terminalViewportRect)
        )
      }),
    [
      agentWindows,
      focusedAgentWindowId,
      pinnedSectionWindowIds,
      selectedNodeIds,
      terminalViewportRect,
    ],
  )

  useEffect(() => {
    if (autoArrangeMode !== 'dwindle' || windowSections.length === 0) return
    arrangeDwindleSections(true)
  }, [
    arrangeDwindleSections,
    autoArrangeMode,
    viewportSize.width,
    viewportSize.height,
    windowSections.length,
  ])

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
      textEditors: editors,
      agentWindows: agents,
      windowSections: sections,
      titleBarHidden: scheduledTitleBarHidden,
      focusedWindowSectionId: scheduledFocusedWindowSectionId,
    } = useStore.getState()
    if (canvas.scale < SNAP_DISABLE_ZOOM) {
      setSnapPaused(true)
      return
    }
    setSnapPaused(false)
    const windows = getCanvasWindows(terms, browsers, editors, agents)

    // Find the window with the most overlap with the viewport
    const { width: viewW, height: viewH } = getCanvasViewportSize({
      titleBarHidden: scheduledTitleBarHidden,
    })
    const sectionTargets = sections.map((section) => ({
      id: section.id,
      type: 'section' as const,
      x: section.x,
      y: section.y,
      width: Math.max(SECTION_MIN_WIDTH, section.width ?? viewW - 16),
      height: Math.max(SECTION_MIN_HEIGHT, section.height ?? viewH - 16),
      windowIds: section.windowIds,
    }))
    const focusedSectionTarget = scheduledFocusedWindowSectionId
      ? sectionTargets.find((section) => section.id === scheduledFocusedWindowSectionId)
      : null
    const targets = focusedSectionTarget
      ? [focusedSectionTarget]
      : getTopLevelArrangeItems(windows, sectionTargets)
    if (targets.length === 0) return

    const viewL = -canvas.x / canvas.scale
    const viewT = -canvas.y / canvas.scale
    const viewR = viewL + viewW / canvas.scale
    const viewB = viewT + viewH / canvas.scale
    const viewArea = (viewR - viewL) * (viewB - viewT)

    let maxCoverage = 0
    let bestTarget: (typeof targets)[number] | null = null
    for (const target of targets) {
      const overlapW = Math.max(
        0,
        Math.min(target.x + target.width, viewR) - Math.max(target.x, viewL),
      )
      const overlapH = Math.max(
        0,
        Math.min(target.y + target.height, viewB) - Math.max(target.y, viewT),
      )
      const coverage = (overlapW * overlapH) / viewArea
      if (coverage > maxCoverage) {
        maxCoverage = coverage
        bestTarget = target
      }
    }

    // More coverage → shorter delay (linear interpolation, clamped)
    const t = Math.min(Math.max(maxCoverage, 0), 1)
    const delay = SNAP_DELAY_MAX - t * (SNAP_DELAY_MAX - SNAP_DELAY_MIN)

    if (snapTimerRef.current) clearTimeout(snapTimerRef.current)
    snapTimerRef.current = setTimeout(() => {
      snapTimerRef.current = null
      const currentState = useStore.getState()
      if (currentState.activeProjectId !== scheduledProjectId) return
      if (document.visibilityState === 'hidden' || currentState.appWindowFocused === false) {
        setIsUserDriving(false)
        return
      }

      const currentViewport = getCanvasViewportSize({
        titleBarHidden: currentState.titleBarHidden,
      })
      const currentWindows = getCanvasWindows(
        currentState.terminals,
        currentState.browsers,
        currentState.textEditors,
        currentState.agentWindows,
      )
      const currentSectionTargets = currentState.windowSections.map((section) => ({
        id: section.id,
        type: 'section' as const,
        x: section.x,
        y: section.y,
        width: Math.max(SECTION_MIN_WIDTH, section.width ?? currentViewport.width - 16),
        height: Math.max(SECTION_MIN_HEIGHT, section.height ?? currentViewport.height - 16),
        windowIds: section.windowIds,
      }))
      const currentFocusedSection = currentState.focusedWindowSectionId
        ? currentSectionTargets.find(
            (section) => section.id === currentState.focusedWindowSectionId,
          )
        : null
      const currentTargets = currentFocusedSection
        ? [currentFocusedSection]
        : getTopLevelArrangeItems(currentWindows, currentSectionTargets)
      const currentViewL = -currentState.canvas.x / currentState.canvas.scale
      const currentViewT = -currentState.canvas.y / currentState.canvas.scale
      const currentViewR = currentViewL + currentViewport.width / currentState.canvas.scale
      const currentViewB = currentViewT + currentViewport.height / currentState.canvas.scale
      const currentViewArea = Math.max(
        1,
        (currentViewR - currentViewL) * (currentViewB - currentViewT),
      )
      let snapTarget: (typeof currentTargets)[number] | null = null
      let snapCoverage = 0
      for (const target of currentTargets) {
        const overlapW = Math.max(
          0,
          Math.min(target.x + target.width, currentViewR) - Math.max(target.x, currentViewL),
        )
        const overlapH = Math.max(
          0,
          Math.min(target.y + target.height, currentViewB) - Math.max(target.y, currentViewT),
        )
        const coverage = (overlapW * overlapH) / currentViewArea
        if (coverage > snapCoverage) {
          snapCoverage = coverage
          snapTarget = target
        }
      }

      setIsUserDriving(false)
      setSnapPaused(false)
      if (!snapTarget && !bestTarget) {
        snapToClosest()
        return
      }
      const target = snapTarget ?? bestTarget
      if (!target) return
      if (target.type === 'section') {
        snapToWindowSection(target.id)
      } else if (target.type === 'terminal') {
        snapToTerminal(target.id)
      } else if (target.type === 'editor') {
        snapToTextEditor(target.id)
      } else if (target.type === 'agent') {
        snapToAgentWindow(target.id)
      } else {
        snapToBrowser(target.id)
      }
    }, delay)
  }, [
    snapToAgentWindow,
    snapToBrowser,
    snapToTextEditor,
    snapToClosest,
    snapToTerminal,
    snapToWindowSection,
    snapEnabled,
    setSnapPaused,
  ])

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
    sectionDragRef.current = null
    sectionResizeRef.current = null
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
      setDraggingSectionId(null)
      setResizingSectionId(null)
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

      if (
        (terminals.length > 0 ||
          browsers.length > 0 ||
          textEditors.length > 0 ||
          agentWindows.length > 0 ||
          windowSections.length > 0) &&
        snapEnabled
      ) {
        scheduleSnap()
      }
    },
    [
      setCanvasTransform,
      cancelSnap,
      scheduleSnap,
      terminals.length,
      browsers.length,
      textEditors.length,
      agentWindows.length,
      windowSections.length,
      snapEnabled,
    ],
  )

  // Pan handlers
  const handleCanvasMouseDown = useCallback(
    (e: MouseEvent) => {
      containerRef.current?.focus({ preventScroll: true })
      const termNode = (e.target as HTMLElement).closest('.terminal-node')
      const browserNode = (e.target as HTMLElement).closest('.browser-node')
      const editorNode = (e.target as HTMLElement).closest('.text-editor-node')
      const agentNode = (e.target as HTMLElement).closest('.agent-window-node')
      const clickedNode = termNode || browserNode || editorNode || agentNode

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
        (e.target as HTMLElement).closest('.text-editor-content') ||
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

      if (sectionDragRef.current) {
        const dx = (e.clientX - sectionDragRef.current.startX) / transform.scale
        const dy = (e.clientY - sectionDragRef.current.startY) / transform.scale
        useStore
          .getState()
          .moveWindowSection(
            sectionDragRef.current.id,
            sectionDragRef.current.originX + dx,
            sectionDragRef.current.originY + dy,
          )
      }

      if (sectionResizeRef.current) {
        const dx = (e.clientX - sectionResizeRef.current.startX) / transform.scale
        const dy = (e.clientY - sectionResizeRef.current.startY) / transform.scale
        const resize = sectionResizeRef.current
        const movesLeft = resize.edge.includes('w')
        const movesRight = resize.edge.includes('e')
        const movesTop = resize.edge.includes('n')
        const movesBottom = resize.edge.includes('s')
        let width = resize.originWidth
        let height = resize.originHeight
        let x = resize.originX
        let y = resize.originY

        if (movesRight) width = Math.max(SECTION_MIN_WIDTH, resize.originWidth + dx)
        if (movesBottom) height = Math.max(SECTION_MIN_HEIGHT, resize.originHeight + dy)
        if (movesLeft) {
          width = Math.max(SECTION_MIN_WIDTH, resize.originWidth - dx)
          x = resize.originX + (resize.originWidth - width)
        }
        if (movesTop) {
          height = Math.max(SECTION_MIN_HEIGHT, resize.originHeight - dy)
          y = resize.originY + (resize.originHeight - height)
        }

        resizeWindowSection(resize.id, { x, y, width, height })
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
      resizeWindowSection,
      selectableWindows,
      setSelectedNodeIds,
    ],
  )

  const handleMouseUp = useCallback(() => {
    const wasPanning = isPanning
    const clearTransientSelection = dragRef.current?.transientSelection === true
    const draggedIds = dragRef.current?.ids ?? []
    const resizedSectionId = sectionResizeRef.current?.id ?? null
    setIsPanning(false)
    setIsDragging(false)
    setMarqueeBox(null)
    panRef.current = null
    dragRef.current = null
    sectionDragRef.current = null
    sectionResizeRef.current = null
    marqueeRef.current = null
    setDraggingSectionId(null)
    setResizingSectionId(null)
    if (clearTransientSelection) {
      setSelectedNodeIds([])
    }
    if (draggedIds.length > 0) {
      commitWindowSectionDrag(draggedIds)
    }
    if (resizedSectionId) {
      arrangeDwindleSections(true, null, resizedSectionId)
      setIsUserDriving(false)
      return
    }
    if (
      wasPanning &&
      (terminals.length > 0 ||
        browsers.length > 0 ||
        textEditors.length > 0 ||
        agentWindows.length > 0 ||
        windowSections.length > 0) &&
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
    textEditors.length,
    agentWindows.length,
    windowSections.length,
    scheduleSnap,
    snapEnabled,
    commitWindowSectionDrag,
    arrangeDwindleSections,
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
    const reset = () => {
      setPrimaryModifierHeld(false)
      cancelSnap()
      setIsUserDriving(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    window.addEventListener(CELLS_SHORTCUT_STATE_RESET_EVENT, reset)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      window.removeEventListener(CELLS_SHORTCUT_STATE_RESET_EVENT, reset)
    }
  }, [cancelSnap])

  // Wheel handler: trackpad pan + pinch zoom, with snap-after-idle
  // Reads canvas state directly from the store on each event so rapid trackpad
  // events never read a stale closure value (multiple events can fire per frame).
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (
        Reflect.get(e.nativeEvent, CANVAS_GESTURE_LOCKED_EVENT) === true ||
        (e.target as HTMLElement).closest('[data-canvas-gesture-lock="true"]')
      ) {
        return
      }

      const termNode = (e.target as HTMLElement).closest('.terminal-node')
      const browserNode = (e.target as HTMLElement).closest('.browser-node')
      const editorNode = (e.target as HTMLElement).closest('.text-editor-node')
      const agentNode = (e.target as HTMLElement).closest('.agent-window-node')
      const requestedZoomModifier = e.ctrlKey || e.metaKey
      const requestedModifierWheel = requestedZoomModifier || e.shiftKey
      const honorModifierWheel = shouldHonorWheelModifier(
        wheelModifierBurstRef.current,
        requestedModifierWheel,
        e.timeStamp,
      )
      const zoomModifier = requestedZoomModifier && honorModifierWheel
      const forceCanvasPan = e.shiftKey && honorModifierWheel && !zoomModifier
      // Let node content own plain scroll, but reserve Cmd/Ctrl+scroll for
      // zoom and Shift+scroll/swipe as an explicit canvas-pan override.
      if ((termNode || browserNode || editorNode || agentNode) && !zoomModifier && !forceCanvasPan)
        return

      if (requestedModifierWheel && !honorModifierWheel) return

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
      cancelSnap()
      setIsUserDriving(true)
      setIsDragging(true)
      dragRef.current = {
        startX,
        startY,
        origins: createSelectionOrigins(selectableWindows, dragIds),
        transientSelection: options?.transientSelection === true,
        ids: dragIds,
      }
    },
    [cancelSnap, selectableWindows],
  )

  const handleNodeDragStart = useCallback(
    (
      nodeId: string,
      kind: 'terminal' | 'browser' | 'agent' | 'editor',
      startX: number,
      startY: number,
    ) => {
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
    if (isPanning || isDragging || marqueeBox || draggingSectionId || resizingSectionId) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [
    isPanning,
    isDragging,
    marqueeBox,
    draggingSectionId,
    resizingSectionId,
    handleMouseMove,
    handleMouseUp,
  ])

  return (
    <div
      ref={containerRef}
      className={cn(
        'canvas-stage flex-1 min-h-0 overflow-hidden relative',
        (isPanning || isDragging || draggingSectionId || resizingSectionId) && 'cursor-grabbing',
        primaryModifierHeld && !isPanning && !isDragging && 'cursor-grab',
        selectionMode && !isPanning && !isDragging && !primaryModifierHeld && 'cursor-default',
      )}
      tabIndex={-1}
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
        {renderedWindowSections.map((section) => {
          const sectionWidth = getSectionWidth(section)
          const sectionHeight = getSectionHeight(section)
          return (
            <div
              key={section.id}
              onMouseDown={(event) => {
                if (hasPrimaryModifier(event)) {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelSnap()
                  setIsUserDriving(true)
                  setDraggingSectionId(section.id)
                  sectionDragRef.current = {
                    id: section.id,
                    startX: event.clientX,
                    startY: event.clientY,
                    originX: section.x,
                    originY: section.y,
                  }
                  return
                }

                if (event.button === 0) {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelSnap()
                  setIsUserDriving(false)
                  snapToWindowSection(section.id)
                }
              }}
              className={cn(
                'absolute rounded-lg border-[3px] border-dashed outline outline-2 outline-offset-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16),0_18px_40px_rgba(0,0,0,0.24)] backdrop-blur-[1px] transition-[border-color,background-color,box-shadow]',
                primaryModifierHeld || draggingSectionId === section.id
                  ? 'cursor-grab active:cursor-grabbing'
                  : 'cursor-pointer',
                getSectionCanvasClass(section.color),
              )}
              style={{
                left: section.x,
                top: section.y,
                width: sectionWidth,
                height: sectionHeight,
                zIndex: 0,
              }}
            >
              <div className="pointer-events-none absolute inset-2 rounded-md border border-white/18 bg-background/[0.03]" />
              {section.pinned ? (
                <div className="absolute inset-0 flex items-center justify-center p-6">
                  <div className="pointer-events-auto flex max-w-64 flex-col items-center gap-3 rounded-lg border border-border/60 bg-background/90 px-4 py-3 text-center shadow-minimal backdrop-blur">
                    <div className="text-xs font-medium text-foreground/80">Popped out section</div>
                    <div className="max-w-full truncate text-[11px] text-muted-foreground/60">
                      {section.name}
                    </div>
                    <button
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation()
                        togglePinSection(section.id)
                      }}
                      className="rounded-md border border-border/60 bg-background/70 px-2.5 py-1.5 text-[11px] text-foreground transition-colors hover:bg-muted/40"
                    >
                      Pop back in
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
        {renderedTerminals.map((terminal) => (
          <TerminalNode
            key={terminal.id}
            terminal={terminal}
            scale={transform.scale}
            isVisible={isTerminalVisible(terminal)}
            pauseLiveRender={isSnapAnimating && focusedTerminalId !== terminal.id}
            selectionMode={selectionMode}
            isSelected={selectedNodeIds.includes(terminal.id)}
            isFocused={focusedTerminalId === terminal.id}
            showFocusRing={focusedTerminalId === terminal.id && showFocusedWindowRing}
            onDragStart={handleNodeDragStart}
          />
        ))}
        {renderedBrowsers
          .filter((b) => !b.pinned)
          .map((browser) => (
            <BrowserNode
              key={browser.id}
              browser={browser}
              scale={transform.scale}
              selectionMode={selectionMode}
              isSelected={selectedNodeIds.includes(browser.id)}
              isFocused={focusedBrowserId === browser.id}
              showFocusRing={focusedBrowserId === browser.id && showFocusedWindowRing}
              onDragStart={handleNodeDragStart}
            />
          ))}
        {renderedTextEditors
          .filter((editor) => !editor.pinned)
          .map((editor) => (
            <TextEditorNode
              key={editor.id}
              editor={editor}
              scale={transform.scale}
              selectionMode={selectionMode}
              isSelected={selectedNodeIds.includes(editor.id)}
              isFocused={focusedTextEditorId === editor.id}
              showFocusRing={focusedTextEditorId === editor.id && showFocusedWindowRing}
              onDragStart={handleNodeDragStart}
            />
          ))}
        {renderedAgentWindows.map((agentWindow) => (
          <AgentWindowNode
            key={agentWindow.id}
            agentWindow={agentWindow}
            scale={transform.scale}
            selectionMode={selectionMode}
            isSelected={selectedNodeIds.includes(agentWindow.id)}
            isFocused={focusedAgentWindowId === agentWindow.id}
            showFocusRing={focusedAgentWindowId === agentWindow.id && showFocusedWindowRing}
            onDragStart={handleNodeDragStart}
          />
        ))}
        {renderedWindowSections.map((section) => {
          const sectionWidth = getSectionWidth(section)
          const sectionHeight = getSectionHeight(section)
          return (
            <div
              key={`${section.id}-overlay`}
              className={cn(
                'pointer-events-none absolute rounded-lg border-[3px] border-dashed outline outline-2 outline-offset-2 shadow-[0_0_0_1px_rgba(0,0,0,0.32),0_0_24px_rgba(0,0,0,0.28)]',
                getSectionCanvasClass(section.color),
                'bg-transparent',
              )}
              style={{
                left: section.x,
                top: section.y,
                width: sectionWidth,
                height: sectionHeight,
                zIndex: 200000,
              }}
            >
              <button
                type="button"
                onMouseDown={(event) => {
                  if (event.button !== 0) return
                  event.preventDefault()
                  event.stopPropagation()
                  cancelSnap()
                  setIsUserDriving(true)
                  setDraggingSectionId(section.id)
                  sectionDragRef.current = {
                    id: section.id,
                    startX: event.clientX,
                    startY: event.clientY,
                    originX: section.x,
                    originY: section.y,
                  }
                }}
                className={cn(
                  'pointer-events-auto absolute left-2 top-0 z-20 flex max-w-72 items-center gap-1.5 rounded-md border border-white/18 bg-background/95 font-semibold text-foreground/85 shadow-[0_8px_24px_rgba(0,0,0,0.28)] backdrop-blur transition-colors hover:bg-muted/90 hover:text-foreground active:cursor-grabbing',
                  draggingSectionId === section.id ? 'cursor-grabbing' : 'cursor-grab',
                  sectionHandleExpanded ? 'px-3 py-2 text-[12px]' : 'px-2 py-1 text-[10px]',
                )}
                style={{
                  transform: `translateY(calc(-100% - 8px)) scale(${sectionHandleScale})`,
                  transformOrigin: 'left bottom',
                }}
                title="Drag section"
              >
                <Move
                  className={cn(
                    'shrink-0 text-muted-foreground/70',
                    sectionHandleExpanded ? 'h-4 w-4' : 'h-3 w-3',
                  )}
                />
                <span className="min-w-0 truncate">{section.name}</span>
                <GripHorizontal
                  className={cn(
                    'shrink-0 text-muted-foreground/45',
                    sectionHandleExpanded ? 'h-4 w-4' : 'h-3 w-3',
                  )}
                />
              </button>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  removeWindowSection(section.id)
                }}
                className={cn(
                  'pointer-events-auto absolute right-2 top-0 z-20 flex items-center justify-center rounded-md border border-white/18 bg-background/95 text-muted-foreground/70 shadow-[0_8px_24px_rgba(0,0,0,0.28)] backdrop-blur transition-colors hover:bg-destructive/15 hover:text-destructive',
                  sectionHandleExpanded ? 'size-8' : 'size-6',
                )}
                style={{
                  transform: `translateY(calc(-100% - 8px)) scale(${sectionHandleScale})`,
                  transformOrigin: 'right bottom',
                }}
                title="Delete section"
                aria-label={`Delete section ${section.name}`}
              >
                <Trash2 className={cn(sectionHandleExpanded ? 'h-4 w-4' : 'h-3 w-3')} />
              </button>
              {SECTION_RESIZE_EDGES.map((edge) => (
                <div
                  key={edge}
                  className="pointer-events-auto absolute z-10"
                  style={{
                    top: edge.includes('n')
                      ? -SECTION_HANDLE_SIZE / 2
                      : edge.includes('s')
                        ? undefined
                        : SECTION_HANDLE_SIZE,
                    bottom: edge.includes('s')
                      ? -SECTION_HANDLE_SIZE / 2
                      : edge.includes('n')
                        ? undefined
                        : SECTION_HANDLE_SIZE,
                    left: edge.includes('w')
                      ? -SECTION_HANDLE_SIZE / 2
                      : edge.includes('e')
                        ? undefined
                        : SECTION_HANDLE_SIZE,
                    right: edge.includes('e')
                      ? -SECTION_HANDLE_SIZE / 2
                      : edge.includes('w')
                        ? undefined
                        : SECTION_HANDLE_SIZE,
                    width:
                      edge === 'n' || edge === 's'
                        ? `calc(100% - ${SECTION_HANDLE_SIZE * 2}px)`
                        : SECTION_HANDLE_SIZE * 2,
                    height:
                      edge === 'e' || edge === 'w'
                        ? `calc(100% - ${SECTION_HANDLE_SIZE * 2}px)`
                        : SECTION_HANDLE_SIZE * 2,
                    cursor: getSectionResizeCursor(edge),
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    cancelSnap()
                    setIsUserDriving(true)
                    setResizingSectionId(section.id)
                    sectionResizeRef.current = {
                      id: section.id,
                      edge,
                      startX: event.clientX,
                      startY: event.clientY,
                      originX: section.x,
                      originY: section.y,
                      originWidth: sectionWidth,
                      originHeight: sectionHeight,
                    }
                  }}
                />
              ))}
            </div>
          )
        })}
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
      {terminals.length === 0 &&
        browsers.length === 0 &&
        textEditors.length === 0 &&
        agentWindows.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <p className="text-muted-foreground/40 text-sm">Press ⌘T to get started</p>
            </div>
          </div>
        )}
    </div>
  )
}
