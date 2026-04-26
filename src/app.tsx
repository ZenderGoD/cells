import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useStore } from './lib/store'
import { StatusBar } from './components/toolbar/toolbar'
import { InfiniteCanvas } from './components/canvas/infinite-canvas'
import { CommandPalette } from './components/command-palette'
import { Onboarding } from './components/onboarding'
import { TerminalSwitcher } from './components/terminal-switcher'
import { OnboardingGuide } from './components/onboarding-guide'
import { ProjectSwitcher } from './components/project-switcher'
import { CloseWindowDialog } from './components/close-window-dialog'
import { CloseProjectDialog } from './components/close-project-dialog'
import { Toaster, showToast } from './components/toast'
import { PinnedWindow } from './components/pinned-window'
import { BackgroundAgentSessionHosts } from './components/agent-session/background-agent-session-runner'
import {
  getCachedTerminalCount,
  reloadAllTerminals,
} from './components/terminal/terminal-cache-api'
import { STATUS_BAR_HEIGHT } from './lib/canvas-navigation'
import {
  hasPrimaryModifier,
  isEditableTarget,
  isPrimaryModifierKey,
} from './lib/keyboard-shortcuts'
import {
  CELLS_COPY_BROWSER_URL_EVENT,
  CELLS_OPEN_BROWSER_LOCATION_EVENT,
  CELLS_OPEN_SETTINGS_EVENT,
  CELLS_TOGGLE_COMMAND_PALETTE_EVENT,
  CELLS_TOGGLE_PROJECT_SWITCHER_EVENT,
  getCellsShortcutScope,
  type CellsShortcutCommand,
  matchRendererShortcut,
} from './lib/cells-shortcuts'
import { buildWindowAppearanceStyle } from './lib/window-appearance'
import { useShallow } from 'zustand/react/shallow'

const pinnedId = window.cells.app.getPinnedId()
const pinnedType = window.cells.app.getPinnedType()

export function App() {
  if (pinnedId && pinnedType) {
    return <PinnedWindow termId={pinnedId} type={pinnedType} />
  }

  return <MainApp />
}

// Animated wrapper around StatusBar: the bar lives at a fixed 40px tall, so we
// collapse height + opacity in lockstep instead of measuring `auto`. Reduced
// motion skips the slide and just mounts/unmounts. Kept above MainApp so its
// identity is stable across re-renders.
function AnimatedTitleBarSlot({ position, show }: { position: 'top' | 'bottom'; show: boolean }) {
  const reduceMotion = useReducedMotion()
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          key={`status-${position}`}
          initial={reduceMotion ? false : { height: 0, opacity: 0 }}
          animate={{ height: STATUS_BAR_HEIGHT, opacity: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={{
            height: { duration: 0.22, ease: [0.2, 0, 0, 1] },
            opacity: { duration: 0.14, ease: [0.2, 0, 0, 1] },
          }}
          style={{ overflow: 'hidden', flexShrink: 0 }}
        >
          <StatusBar />
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

function isCellsTerminalShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('[data-cells-terminal-input="true"]'))
}

function MainApp() {
  const {
    initialized,
    init,
    persist,
    projects,
    windowOpacity,
    useTransparentWindow,
    titleBarPosition,
    titleBarHidden,
    dimWhenUnfocused,
    requestCloseWindow,
    pendingCloseDialog,
    pendingProjectCloseDialog,
    closeUndoTimeoutMs,
    confirmPendingClose,
    cancelPendingClose,
    confirmPendingProjectClose,
    cancelPendingProjectClose,
    setOverlayOpen,
  } = useStore(
    useShallow((s) => ({
      initialized: s.initialized,
      init: s.init,
      persist: s.persist,
      projects: s.projects,
      windowOpacity: s.windowOpacity,
      useTransparentWindow: s.useTransparentWindow,
      titleBarPosition: s.titleBarPosition,
      titleBarHidden: s.titleBarHidden,
      dimWhenUnfocused: s.dimWhenUnfocused,
      requestCloseWindow: s.requestCloseWindow,
      pendingCloseDialog: s.pendingCloseDialog,
      pendingProjectCloseDialog: s.pendingProjectCloseDialog,
      closeUndoTimeoutMs: s.closeUndoTimeoutMs,
      confirmPendingClose: s.confirmPendingClose,
      cancelPendingClose: s.cancelPendingClose,
      confirmPendingProjectClose: s.confirmPendingProjectClose,
      cancelPendingProjectClose: s.cancelPendingProjectClose,
      setOverlayOpen: s.setOverlayOpen,
    })),
  )
  const shellStyle = buildWindowAppearanceStyle({ windowOpacity, useTransparentWindow })
  const activeProjectId = useStore((s) => s.activeProjectId)
  const focusedAgentWindowId = useStore((s) => s.focusedAgentWindowId)
  const suppressWindowFocusTerminalRefocusRef = useRef(false)
  const suppressWindowFocusTerminalRefocusTimerRef = useRef<number | null>(null)
  const pendingNotificationFocusFrameRef = useRef<number | null>(null)
  const keyboardNavigationActiveRef = useRef(false)

  const [windowFocused, setWindowFocused] = useState(true)
  useEffect(() => {
    const clearSuppressedWindowFocusRefocus = () => {
      suppressWindowFocusTerminalRefocusRef.current = false
      if (suppressWindowFocusTerminalRefocusTimerRef.current != null) {
        window.clearTimeout(suppressWindowFocusTerminalRefocusTimerRef.current)
        suppressWindowFocusTerminalRefocusTimerRef.current = null
      }
    }

    // Use native BrowserWindow focus/blur via IPC so the overlay tracks the
    // actual OS window state.  DOM window blur fires whenever a WebContentsView
    // (browser panel) takes keyboard focus, which is a false positive.
    const unsubscribe = window.cells.app.onWindowFocus((focused) => {
      setWindowFocused(focused)
      if (!focused) return
      requestAnimationFrame(() => {
        if (suppressWindowFocusTerminalRefocusRef.current) {
          clearSuppressedWindowFocusRefocus()
          return
        }
        window.dispatchEvent(new Event('terminal-refocus'))
      })
    })

    return () => {
      clearSuppressedWindowFocusRefocus()
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    return window.cells.app.onFocusAgentWindow(({ windowId, projectId }) => {
      if (pendingNotificationFocusFrameRef.current != null) {
        window.cancelAnimationFrame(pendingNotificationFocusFrameRef.current)
        pendingNotificationFocusFrameRef.current = null
      }
      suppressWindowFocusTerminalRefocusRef.current = true
      if (suppressWindowFocusTerminalRefocusTimerRef.current != null) {
        window.clearTimeout(suppressWindowFocusTerminalRefocusTimerRef.current)
      }
      suppressWindowFocusTerminalRefocusTimerRef.current = window.setTimeout(() => {
        suppressWindowFocusTerminalRefocusRef.current = false
        suppressWindowFocusTerminalRefocusTimerRef.current = null
      }, 750)

      const state = useStore.getState()
      const resolvedProjectId =
        projectId ??
        state.projects.find((project) =>
          (project.agentWindows ?? []).some((entry) => entry.id === windowId),
        )?.id ??
        null

      if (resolvedProjectId && state.activeProjectId !== resolvedProjectId) {
        state.switchProject(resolvedProjectId)
      }

      let attempts = 0
      const focusTarget = () => {
        const nextState = useStore.getState()
        const target = nextState.agentWindows.find((entry) => entry.id === windowId)
        if (!target) {
          if (attempts >= 5) {
            pendingNotificationFocusFrameRef.current = null
            return
          }
          attempts += 1
          pendingNotificationFocusFrameRef.current = window.requestAnimationFrame(focusTarget)
          return
        }
        pendingNotificationFocusFrameRef.current = null
        nextState.snapToAgentWindow(windowId)
      }

      pendingNotificationFocusFrameRef.current = window.requestAnimationFrame(focusTarget)
    })
  }, [])

  useEffect(
    () => () => {
      if (pendingNotificationFocusFrameRef.current != null) {
        window.cancelAnimationFrame(pendingNotificationFocusFrameRef.current)
        pendingNotificationFocusFrameRef.current = null
      }
    },
    [],
  )

  useEffect(() => {
    window.cells.app.updateNotificationContext({
      activeProjectId,
      focusedAgentWindowId,
    })
  }, [activeProjectId, focusedAgentWindowId])

  // Push each agent window's queued-message count to main so it can suppress
  // the "finished" notification when more queued work is about to run.
  useEffect(() => {
    const lastReported = new Map<string, number>()
    const push = () => {
      const state = useStore.getState()
      const counts = new Map<string, number>()
      for (const agentWindow of state.agentWindows) {
        counts.set(agentWindow.id, agentWindow.queuedMessages?.length ?? 0)
      }
      for (const project of state.projects) {
        for (const agentWindow of project.agentWindows ?? []) {
          counts.set(agentWindow.id, agentWindow.queuedMessages?.length ?? 0)
        }
      }
      for (const [id, count] of counts) {
        if (lastReported.get(id) !== count) {
          lastReported.set(id, count)
          window.cells.agentSession.reportQueueCount(id, count)
        }
      }
      for (const id of [...lastReported.keys()]) {
        if (!counts.has(id)) {
          lastReported.delete(id)
          window.cells.agentSession.reportQueueCount(id, 0)
        }
      }
    }
    push()
    return useStore.subscribe(push)
  }, [])

  useEffect(() => {
    return window.cells.app.onDaemonDisconnected(() => {
      reloadAllTerminals()
    })
  }, [])

  const showDimOverlay = dimWhenUnfocused && !windowFocused

  const runCanvasZoomCommand = useCallback((command: 'fit' | 'in' | 'out') => {
    const state = useStore.getState()
    if (command === 'fit') {
      const id =
        state.focusedTerminalId ||
        state.focusedBrowserId ||
        state.focusedAgentWindowId ||
        state.terminals[0]?.id ||
        state.browsers[0]?.id ||
        state.agentWindows[0]?.id
      if (id) state.zoomToFit(id)
      return
    }

    state.zoomFocusedWindow(command)
  }, [])

  useEffect(() => {
    return window.cells.app.onCanvasZoom(runCanvasZoomCommand)
  }, [runCanvasZoomCommand])

  const closeWindow = useCallback(() => {
    void requestCloseWindow()
  }, [requestCloseWindow])

  // Cmd+S: toggle title bar visibility with two-press confirmation when hiding.
  // Unhiding is immediate; hiding requires a second press within ~3s so users
  // don't lose the bar (and the shortcut) by accident.
  const titleBarHideConfirmRef = useRef<number | null>(null)
  const toggleTitleBarHidden = useCallback(() => {
    const { titleBarHidden: hidden, setTitleBarHidden } = useStore.getState()
    if (hidden) {
      setTitleBarHidden(false)
      if (titleBarHideConfirmRef.current !== null) {
        window.clearTimeout(titleBarHideConfirmRef.current)
        titleBarHideConfirmRef.current = null
      }
      return
    }
    if (titleBarHideConfirmRef.current !== null) {
      window.clearTimeout(titleBarHideConfirmRef.current)
      titleBarHideConfirmRef.current = null
      setTitleBarHidden(true)
      return
    }
    showToast('Press ⌘S again to hide the title bar', 'info')
    titleBarHideConfirmRef.current = window.setTimeout(() => {
      titleBarHideConfirmRef.current = null
    }, 3000)
  }, [])

  const runShortcutCommand = useCallback(
    (command: CellsShortcutCommand, options?: { repeat?: boolean }) => {
      const state = useStore.getState()
      switch (command) {
        case 'toggle-command-palette':
          window.dispatchEvent(new Event(CELLS_TOGGLE_COMMAND_PALETTE_EVENT))
          return true
        case 'open-settings':
          window.dispatchEvent(new Event(CELLS_OPEN_SETTINGS_EVENT))
          return true
        case 'toggle-project-switcher':
          window.dispatchEvent(new Event(CELLS_TOGGLE_PROJECT_SWITCHER_EVENT))
          return true
        case 'toggle-selection-mode':
          state.setSelectionMode(!state.selectionMode)
          return true
        case 'close-window':
          closeWindow()
          return true
        case 'restore-last-closed':
          if (state.pendingClosedWindows.length > 0) {
            state.restoreLastClosedWindow()
            return true
          }
          if (state.pendingClosedProjects.length > 0) {
            state.restoreLastClosedProject()
            return true
          }
          return false
        case 'toggle-pin-focused':
          state.togglePinFocused()
          return true
        case 'quit-app':
          void window.cells.app.requestQuit()
          return true
        case 'reload-focused':
          state.reloadFocused()
          return true
        case 'browser-back':
          if (state.overlayOpen) return false
          if (!state.focusedBrowserId) return false
          window.cells.browser.goBack(state.focusedBrowserId)
          return true
        case 'browser-forward':
          if (state.overlayOpen) return false
          if (!state.focusedBrowserId) return false
          window.cells.browser.goForward(state.focusedBrowserId)
          return true
        case 'open-browser-location':
          if (state.overlayOpen) return false
          if (!state.focusedBrowserId) return false
          window.dispatchEvent(new Event(CELLS_OPEN_BROWSER_LOCATION_EVENT))
          return true
        case 'copy-browser-url':
          if (state.overlayOpen) return false
          if (!state.focusedBrowserId) return false
          window.dispatchEvent(new Event(CELLS_COPY_BROWSER_URL_EVENT))
          return true
        case 'toggle-title-bar-hidden':
          toggleTitleBarHidden()
          return true
        case 'toggle-title-bar-position':
          state.toggleTitleBarPosition()
          return true
        case 'zoom-focused-window-in':
          if (state.overlayOpen) return false
          state.zoomFocusedWindow('in')
          return true
        case 'zoom-focused-window-out':
          if (state.overlayOpen) return false
          state.zoomFocusedWindow('out')
          return true
        case 'snap-focused-window':
          if (state.overlayOpen) return false
          if (state.focusedTerminalId) {
            state.snapToTerminal(state.focusedTerminalId)
            return true
          }
          if (state.focusedBrowserId) {
            state.snapToBrowser(state.focusedBrowserId)
            return true
          }
          if (state.focusedAgentWindowId) {
            state.snapToAgentWindow(state.focusedAgentWindowId)
            return true
          }
          return false
        case 'zoom-to-fit-focused': {
          if (state.overlayOpen) return false
          const id =
            state.focusedTerminalId ||
            state.focusedBrowserId ||
            state.focusedAgentWindowId ||
            state.terminals[0]?.id ||
            state.browsers[0]?.id ||
            state.agentWindows[0]?.id
          if (!id) return false
          state.zoomToFit(id)
          return true
        }
        case 'zoom-to-fit-all':
          if (state.overlayOpen) return false
          state.zoomToFitAll()
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
          return true
        case 'snap-left':
        case 'snap-right':
        case 'snap-up':
        case 'snap-down': {
          if (state.overlayOpen) return false
          const direction = command.replace('snap-', '') as 'left' | 'right' | 'up' | 'down'
          const keepScale = keyboardNavigationActiveRef.current || options?.repeat === true
          if (!keyboardNavigationActiveRef.current) {
            keyboardNavigationActiveRef.current = true
            window.dispatchEvent(new Event('terminal-navigation-start'))
          }
          state.snapToNearest(direction, {
            keepScale,
          })
          return true
        }
        case 'resize-focused-to-fit-viewport':
          if (state.overlayOpen) return false
          state.resizeFocusedToFitViewport()
          return true
        case 'resize-window-to-fit-focused':
          if (state.overlayOpen) return false
          state.resizeWindowToFitFocused()
          return true
        default:
          return false
      }
    },
    [closeWindow, toggleTitleBarHidden],
  )

  // When the title bar toggles, the effective viewport height changes, so
  // any canvas math that subtracts the title bar has new answers. Re-snap to
  // the focused window after the slide animation so the view lines up with
  // the new viewport (and the extra space gained by hiding is usable).
  const prevTitleBarHiddenRef = useRef(titleBarHidden)
  useEffect(() => {
    if (prevTitleBarHiddenRef.current === titleBarHidden) return
    prevTitleBarHiddenRef.current = titleBarHidden
    const resnap = () => {
      const state = useStore.getState()
      if (state.focusedTerminalId) state.snapToTerminal(state.focusedTerminalId)
      else if (state.focusedBrowserId) state.snapToBrowser(state.focusedBrowserId)
      else if (state.focusedAgentWindowId) state.snapToAgentWindow(state.focusedAgentWindowId)
    }
    // Match the 220ms slide animation below so the snap lands on the final
    // viewport size, not the intermediate height during the collapse.
    const timer = window.setTimeout(resnap, 240)
    return () => window.clearTimeout(timer)
  }, [titleBarHidden])

  useEffect(() => {
    const beginKeyboardNavigation = () => {
      if (keyboardNavigationActiveRef.current) return
      keyboardNavigationActiveRef.current = true
      window.dispatchEvent(new Event('terminal-navigation-start'))
    }

    const endKeyboardNavigation = () => {
      if (!keyboardNavigationActiveRef.current) return
      keyboardNavigationActiveRef.current = false
      window.dispatchEvent(new Event('terminal-navigation-end'))
      requestAnimationFrame(() => window.dispatchEvent(new Event('terminal-refocus')))
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const state = useStore.getState()
      const key = event.key.toLowerCase()
      const primaryModifier = hasPrimaryModifier(event)
      const shortcutCommand = matchRendererShortcut(
        {
          key: event.key,
          code: event.code,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        },
        {
          browserFocused: Boolean(state.focusedBrowserId),
          platform: navigator.platform,
        },
      )
      if (shortcutCommand) {
        const shortcutScope = getCellsShortcutScope(shortcutCommand)
        // Window-navigation carve-out for Cmd+hjkl.
        //
        // The default rule below skips canvas-scope shortcuts when focus is on
        // an editable element so we don't hijack typing. That blanket skip is
        // what was breaking Cmd+hjkl: in the common case the user has the
        // agent chat composer textarea focused, so Cmd+H/J/K/L matched
        // snap-left/down/up/right but got dropped before runShortcutCommand.
        //
        // Why bypass here in app.tsx and not somewhere "closer to the input":
        //  - This window keydown listener is attached in capture phase
        //    (`addEventListener(..., true)` below), so it fires before any
        //    descendant element — textarea, xterm hidden textarea, etc. — and
        //    we stopPropagation when handled. That means downstream handlers
        //    (xterm's attachCustomKeyEventHandler, the composer's onKeyDown)
        //    never see these events, so adding hjkl to xterm's metaShortcuts
        //    whitelist has no effect.
        //  - The earlier fix added `data-cells-terminal-input` on xterm's
        //    hidden textarea so terminal focus would still allow snap-*. But
        //    the agent composer textarea has no such marker, so typing in
        //    chat (the dominant case) still got blocked. Decided not to
        //    sprinkle the marker across every textarea — Cmd+hjkl has no
        //    text-editing semantics, so just always allow it.
        //
        // Why letters only and not Cmd+arrows: Cmd+arrows have OS textarea
        // semantics (jump to line start/end, doc start/end). If we bypassed
        // for arrows too, typing in the composer would lose those. Cmd+hjkl
        // and overview are unambiguous — no textarea binds them. Cmd+Shift+Enter
        // is the explicit "fit focused window to viewport" shortcut, so it also
        // needs to work from the agent composer.
        const isHjklSnap = shortcutCommand.startsWith('snap-') && /^[hjkl]$/i.test(event.key)
        const allowFromEditableTarget =
          isHjklSnap ||
          shortcutCommand === 'zoom-to-fit-all' ||
          shortcutCommand === 'resize-focused-to-fit-viewport'
        if (
          isEditableTarget(event.target) &&
          shortcutScope === 'canvas' &&
          !allowFromEditableTarget &&
          !isCellsTerminalShortcutTarget(event.target)
        ) {
          return
        }
        const handled = runShortcutCommand(shortcutCommand, { repeat: event.repeat })
        if (handled) {
          event.preventDefault()
          event.stopPropagation()
          if (shortcutCommand.startsWith('snap-')) beginKeyboardNavigation()
          return
        }
      }

      if (state.overlayOpen || event.altKey) return

      if (key === 'f' && primaryModifier && state.focusedTerminalId) {
        event.preventDefault()
        event.stopPropagation()
        state.openTerminalFind()
        window.dispatchEvent(new Event('terminal-find-focus'))
        return
      }

      // ESC in overview mode → return to previously focused window.
      // Skip when an agent window is focused — the agent panel binds Esc
      // to "stop the current turn".
      if (
        key === 'escape' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !state.focusedTerminalId &&
        !state.focusedBrowserId &&
        !state.focusedAgentWindowId
      ) {
        event.preventDefault()
        event.stopPropagation()
        state.exitOverview()
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (isPrimaryModifierKey(event.key)) {
        endKeyboardNavigation()
      }
    }

    const handleBlur = () => {
      endKeyboardNavigation()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', handleBlur)
    }
  }, [runShortcutCommand])

  useEffect(() => {
    return window.cells.app.onShortcut((payload) => {
      runShortcutCommand(payload.command)
    })
  }, [runShortcutCommand])

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => {
    const cleanup = window.cells.app.onBeforeQuit(() => persist())
    return cleanup
  }, [persist])

  useEffect(() => {
    const handleBeforeUnload = () => persist()
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [persist])

  useEffect(() => {
    const cleanupClose = window.cells.app.onCloseTerminal(closeWindow)
    return () => {
      cleanupClose()
    }
  }, [closeWindow])

  useEffect(() => {
    if (!pendingCloseDialog && !pendingProjectCloseDialog) return
    setOverlayOpen('app-close-dialogs', true)
    return () => setOverlayOpen('app-close-dialogs', false)
  }, [pendingCloseDialog, pendingProjectCloseDialog, setOverlayOpen])

  useEffect(() => {
    if (!initialized) return
    const interval = setInterval(() => persist(), 10000)
    return () => clearInterval(interval)
  }, [initialized, persist])

  useEffect(() => {
    if (!initialized || !window.cells.perf.enabled) return

    let longTaskCount = 0
    let maxLongTaskMs = 0
    let frameHandle = 0
    let burstTimer = 0

    const measureFpsBurst = (durationMs = 250) =>
      new Promise<{ fps: number; sampleWindowMs: number }>((resolve) => {
        let frameCount = 0
        const sampleStart = performance.now()
        const tick = () => {
          frameCount += 1
          frameHandle = window.requestAnimationFrame(tick)
        }
        frameHandle = window.requestAnimationFrame(tick)
        burstTimer = window.setTimeout(() => {
          window.cancelAnimationFrame(frameHandle)
          frameHandle = 0
          const now = performance.now()
          const sampleWindowMs = Math.max(1, Math.round(now - sampleStart))
          const fps = Number(((frameCount * 1000) / sampleWindowMs).toFixed(1))
          resolve({ fps, sampleWindowMs })
        }, durationMs)
      })

    let longTaskObserver: PerformanceObserver | null = null
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTaskCount += 1
            maxLongTaskMs = Math.max(maxLongTaskMs, entry.duration)
          }
        })
        longTaskObserver.observe({ entryTypes: ['longtask'] })
      } catch {
        longTaskObserver = null
      }
    }

    const reportSample = async () => {
      const { fps, sampleWindowMs } = await measureFpsBurst()
      const state = useStore.getState()

      void window.cells.perf.reportRendererSample({
        sampleWindowMs,
        fps,
        longTaskCount,
        maxLongTaskMs: Number(maxLongTaskMs.toFixed(1)),
        liveTerminalCount: document.querySelectorAll('.cell-terminal').length,
        cachedTerminalCount: getCachedTerminalCount(),
        totalTerminalCount: state.terminals.length,
        totalBrowserCount: state.browsers.length,
        totalAgentWindowCount: state.agentWindows.length,
        projectCount: state.projects.length,
        focusedTerminalId: state.focusedTerminalId,
        focusedBrowserId: state.focusedBrowserId,
        focusedAgentWindowId: state.focusedAgentWindowId,
        useTransparentWindow: state.useTransparentWindow,
        windowOpacity: state.windowOpacity,
        overlayOpen: state.overlayOpen,
      })
      longTaskCount = 0
      maxLongTaskMs = 0
    }

    void reportSample()
    const interval = window.setInterval(() => {
      void reportSample()
    }, 5_000)

    return () => {
      window.clearTimeout(burstTimer)
      window.cancelAnimationFrame(frameHandle)
      window.clearInterval(interval)
      longTaskObserver?.disconnect()
    }
  }, [initialized])

  // Subscribe to auto-updater status and expose in store for toolbar
  useEffect(() => {
    return window.cells.updater.onStatus((status, info) => {
      useStore.setState({
        updateStatus: status,
        updateVersion: info?.version ?? useStore.getState().updateVersion,
      })
    })
  }, [])

  if (!initialized) {
    return (
      <div className="app-shell h-full flex items-center justify-center" style={shellStyle}>
        <p className="text-xs text-muted-foreground/40">Loading...</p>
        {showDimOverlay && <UnfocusedOverlay onDismiss={() => setWindowFocused(true)} />}
      </div>
    )
  }

  if (projects.length === 0) {
    return (
      <div
        className="app-shell h-full ring-1 ring-terminal-active/30 rounded-lg overflow-hidden"
        style={shellStyle}
      >
        <Onboarding />
        <Toaster />
        {showDimOverlay && <UnfocusedOverlay onDismiss={() => setWindowFocused(true)} />}
      </div>
    )
  }

  return (
    <div
      className="app-shell h-full flex flex-col ring-1 ring-terminal-active/30 rounded-lg overflow-hidden"
      style={shellStyle}
    >
      <AnimatedTitleBarSlot position="top" show={!titleBarHidden && titleBarPosition === 'top'} />
      <InfiniteCanvas />
      <BackgroundAgentSessionHosts />
      <AnimatedTitleBarSlot
        position="bottom"
        show={!titleBarHidden && titleBarPosition === 'bottom'}
      />
      <CommandPalette />
      <TerminalSwitcher />
      <ProjectSwitcher />
      <CloseWindowDialog
        open={!!pendingCloseDialog}
        windowTitle={pendingCloseDialog?.title ?? 'Window'}
        processLabel={pendingCloseDialog?.process.label ?? 'process'}
        undoTimeoutMs={closeUndoTimeoutMs}
        onConfirm={confirmPendingClose}
        onCancel={cancelPendingClose}
      />
      <CloseProjectDialog
        open={!!pendingProjectCloseDialog}
        projectName={pendingProjectCloseDialog?.projectName ?? 'Project'}
        windowCount={pendingProjectCloseDialog?.windowCount ?? 0}
        runningProcessLabels={pendingProjectCloseDialog?.runningProcessLabels ?? []}
        graceMs={15000}
        onConfirm={confirmPendingProjectClose}
        onCancel={cancelPendingProjectClose}
      />
      <Toaster />
      <OnboardingGuide />
      {showDimOverlay && <UnfocusedOverlay onDismiss={() => setWindowFocused(true)} />}
    </div>
  )
}

function UnfocusedOverlay({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <div
      className="absolute inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-[1px] rounded-lg"
      onClick={onDismiss}
    >
      <p className="text-xs text-white/50">
        Window not in focus{' '}
        <span className="text-white/30">&middot; disable in Settings &gt; Appearance</span>
      </p>
    </div>
  )
}
