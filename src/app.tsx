import { useCallback, useEffect, useRef, useState } from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'
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
import { hasPrimaryModifier, isPrimaryModifierKey } from './lib/keyboard-shortcuts'
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
    restoreLastClosedWindow,
    restoreLastClosedProject,
    pendingCloseDialog,
    pendingProjectCloseDialog,
    pendingClosedWindows,
    pendingClosedProjects,
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
      restoreLastClosedWindow: s.restoreLastClosedWindow,
      restoreLastClosedProject: s.restoreLastClosedProject,
      pendingCloseDialog: s.pendingCloseDialog,
      pendingProjectCloseDialog: s.pendingProjectCloseDialog,
      pendingClosedWindows: s.pendingClosedWindows,
      pendingClosedProjects: s.pendingClosedProjects,
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

  useHotkey('Mod+W', () => closeWindow())
  useHotkey('Mod+Shift+T', () => {
    if (pendingClosedWindows.length > 0) {
      restoreLastClosedWindow()
      return
    }
    if (pendingClosedProjects.length > 0) {
      restoreLastClosedProject()
    }
  })
  useHotkey('Mod+Shift+P', () => useStore.getState().togglePinFocused())
  useHotkey('Mod+Q', () => {
    void window.cells.app.requestQuit()
  })
  useHotkey('Mod+R', () => useStore.getState().reloadFocused())
  useHotkey('Mod+[', () => {
    const bid = useStore.getState().focusedBrowserId
    if (bid) window.cells.browser.goBack(bid)
  })
  useHotkey('Mod+]', () => {
    const bid = useStore.getState().focusedBrowserId
    if (bid) window.cells.browser.goForward(bid)
  })

  // Cmd+S: toggle title bar visibility with two-press confirmation when hiding.
  // Unhiding is immediate; hiding requires a second press within ~3s so users
  // don't lose the bar (and the shortcut) by accident.
  const titleBarHideConfirmRef = useRef<number | null>(null)
  useHotkey('Mod+S', () => {
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
  })

  // Cmd+Shift+S: toggle the title bar between top and bottom.
  useHotkey('Mod+Shift+S', () => useStore.getState().toggleTitleBarPosition())

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
    let keyboardNavigationActive = false

    const beginKeyboardNavigation = () => {
      if (keyboardNavigationActive) return
      keyboardNavigationActive = true
      window.dispatchEvent(new Event('terminal-navigation-start'))
    }

    const endKeyboardNavigation = () => {
      if (!keyboardNavigationActive) return
      keyboardNavigationActive = false
      window.dispatchEvent(new Event('terminal-navigation-end'))
      requestAnimationFrame(() => window.dispatchEvent(new Event('terminal-refocus')))
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const state = useStore.getState()
      const key = event.key.toLowerCase()
      const primaryModifier = hasPrimaryModifier(event)
      if (state.overlayOpen || event.altKey) return

      const zoomIn =
        primaryModifier &&
        (key === '+' ||
          key === '=' ||
          key === 'add' ||
          event.code === 'Equal' ||
          event.code === 'NumpadAdd')
      const zoomOut =
        primaryModifier &&
        (key === '-' ||
          key === '_' ||
          key === 'subtract' ||
          event.code === 'Minus' ||
          event.code === 'NumpadSubtract')

      if (zoomIn || zoomOut) {
        event.preventDefault()
        event.stopPropagation()
        state.zoomFocusedWindow(zoomIn ? 'in' : 'out')
        return
      }

      if (key === 'f' && primaryModifier && state.focusedTerminalId) {
        event.preventDefault()
        event.stopPropagation()
        state.openTerminalFind()
        window.dispatchEvent(new Event('terminal-find-focus'))
        return
      }

      // Cmd+HJKL for canvas navigation (no Ctrl+Arrow — reserved for macOS text cursor)
      const direction = primaryModifier
        ? key === 'h'
          ? 'left'
          : key === 'l'
            ? 'right'
            : key === 'k'
              ? 'up'
              : key === 'j'
                ? 'down'
                : null
        : null

      if (direction) {
        event.preventDefault()
        event.stopPropagation()
        const keepScale = keyboardNavigationActive || event.repeat
        beginKeyboardNavigation()
        state.snapToNearest(direction, { keepScale })
        return
      }

      if (key === 'o' && event.shiftKey && primaryModifier) {
        event.preventDefault()
        event.stopPropagation()
        state.zoomToFitAll()
        // Remove text input focus so keystrokes don't go to a terminal
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
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

      if (key === 'enter' && event.shiftKey && primaryModifier) {
        event.preventDefault()
        event.stopPropagation()
        state.resizeFocusedToFitViewport()
      }

      if (key === '0' && event.shiftKey && primaryModifier) {
        event.preventDefault()
        event.stopPropagation()
        state.resizeWindowToFitFocused()
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
  }, [])

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
    setOverlayOpen(true)
    return () => setOverlayOpen(false)
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
