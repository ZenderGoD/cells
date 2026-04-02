import { useCallback, useEffect, useState } from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'
import { useStore } from './lib/store'
import { StatusBar } from './components/toolbar/toolbar'
import { InfiniteCanvas } from './components/canvas/infinite-canvas'
import { CommandPalette } from './components/command-palette'
import { Onboarding } from './components/onboarding'
import { TerminalSwitcher } from './components/terminal-switcher'
import { OnboardingGuide } from './components/onboarding-guide'
import { ProjectSwitcher } from './components/project-switcher'
import { CloseWindowDialog } from './components/close-window-dialog'
import { Toaster } from './components/toast'
import { PinnedWindow } from './components/pinned-window'
import { getCachedTerminalCount } from './components/terminal/cell-terminal'
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

function MainApp() {
  const {
    initialized,
    init,
    persist,
    projects,
    windowOpacity,
    useTransparentWindow,
    dimWhenUnfocused,
    requestCloseWindow,
    restoreLastClosedWindow,
    pendingCloseDialog,
    closeUndoTimeoutMs,
    confirmPendingClose,
    cancelPendingClose,
    setOverlayOpen,
  } = useStore(
    useShallow((s) => ({
      initialized: s.initialized,
      init: s.init,
      persist: s.persist,
      projects: s.projects,
      windowOpacity: s.windowOpacity,
      useTransparentWindow: s.useTransparentWindow,
      dimWhenUnfocused: s.dimWhenUnfocused,
      requestCloseWindow: s.requestCloseWindow,
      restoreLastClosedWindow: s.restoreLastClosedWindow,
      pendingCloseDialog: s.pendingCloseDialog,
      closeUndoTimeoutMs: s.closeUndoTimeoutMs,
      confirmPendingClose: s.confirmPendingClose,
      cancelPendingClose: s.cancelPendingClose,
      setOverlayOpen: s.setOverlayOpen,
    })),
  )
  const shellStyle = buildWindowAppearanceStyle({ windowOpacity, useTransparentWindow })

  const [windowFocused, setWindowFocused] = useState(true)
  useEffect(() => {
    // Use native BrowserWindow focus/blur via IPC so the overlay tracks the
    // actual OS window state.  DOM window blur fires whenever a WebContentsView
    // (browser panel) takes keyboard focus, which is a false positive.
    return window.cells.app.onWindowFocus(setWindowFocused)
  }, [])

  const showDimOverlay = dimWhenUnfocused && !windowFocused

  const closeWindow = useCallback(() => {
    void requestCloseWindow()
  }, [requestCloseWindow])

  useHotkey('Mod+W', () => closeWindow())
  useHotkey('Mod+Shift+T', () => restoreLastClosedWindow())
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const state = useStore.getState()
      const key = event.key.toLowerCase()
      if (state.overlayOpen || event.altKey) return

      if (key === 'f' && event.metaKey && !event.ctrlKey && state.focusedTerminalId) {
        event.preventDefault()
        event.stopPropagation()
        state.openTerminalFind()
        window.dispatchEvent(new Event('terminal-find-focus'))
        return
      }

      // Cmd+HJKL for canvas navigation (no Ctrl+Arrow — reserved for macOS text cursor)
      const direction =
        event.metaKey && !event.ctrlKey
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
        state.snapToNearest(direction)
        return
      }

      if (key === 'o' && event.shiftKey && event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        event.stopPropagation()
        state.zoomToFitAll()
        // Remove text input focus so keystrokes don't go to a terminal
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      }

      // ESC in overview mode → return to previously focused window
      if (
        key === 'escape' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !state.focusedTerminalId &&
        !state.focusedBrowserId
      ) {
        event.preventDefault()
        event.stopPropagation()
        state.exitOverview()
      }

      if (key === 'enter' && event.shiftKey && event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        event.stopPropagation()
        state.resizeFocusedToFitViewport()
      }

      if (key === '0' && event.shiftKey && event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        event.stopPropagation()
        state.resizeWindowToFitFocused()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
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
    if (!pendingCloseDialog) return
    setOverlayOpen(true)
    return () => setOverlayOpen(false)
  }, [pendingCloseDialog, setOverlayOpen])

  useEffect(() => {
    if (!initialized) return
    const interval = setInterval(() => persist(), 10000)
    return () => clearInterval(interval)
  }, [initialized, persist])

  useEffect(() => {
    if (!initialized) return

    let frameCount = 0
    let sampleStart = performance.now()
    let longTaskCount = 0
    let maxLongTaskMs = 0
    let frameHandle = 0

    const tick = () => {
      frameCount += 1
      frameHandle = window.requestAnimationFrame(tick)
    }
    frameHandle = window.requestAnimationFrame(tick)

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

    const interval = window.setInterval(() => {
      const now = performance.now()
      const sampleWindowMs = Math.max(1, Math.round(now - sampleStart))
      const fps = Number(((frameCount * 1000) / sampleWindowMs).toFixed(1))
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
        projectCount: state.projects.length,
        focusedTerminalId: state.focusedTerminalId,
        focusedBrowserId: state.focusedBrowserId,
        useTransparentWindow: state.useTransparentWindow,
        windowOpacity: state.windowOpacity,
        overlayOpen: state.overlayOpen,
      })

      sampleStart = now
      frameCount = 0
      longTaskCount = 0
      maxLongTaskMs = 0
    }, 5_000)

    return () => {
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
        {showDimOverlay && <UnfocusedOverlay onDismiss={() => setWindowFocused(true)} />}
      </div>
    )
  }

  return (
    <div
      className="app-shell h-full flex flex-col ring-1 ring-terminal-active/30 rounded-lg overflow-hidden"
      style={shellStyle}
    >
      <InfiniteCanvas />
      <StatusBar />
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
