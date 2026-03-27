import { useCallback, useEffect } from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'
import { useStore } from './lib/store'
import { StatusBar } from './components/toolbar/toolbar'
import { InfiniteCanvas } from './components/canvas/infinite-canvas'
import { CommandPalette } from './components/command-palette'
import { Onboarding } from './components/onboarding'
import { TerminalSwitcher } from './components/terminal-switcher'
import { ProjectSwitcher } from './components/project-switcher'
import { CloseWindowDialog } from './components/close-window-dialog'
import { Toaster } from './components/toast'
import { PinnedWindow } from './components/pinned-window'
import { buildWindowAppearanceStyle } from './lib/window-appearance'

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
    requestCloseWindow,
    restoreLastClosedWindow,
    pendingCloseDialog,
    closeUndoTimeoutMs,
    confirmPendingClose,
    cancelPendingClose,
    setOverlayOpen,
  } = useStore()
  const shellStyle = buildWindowAppearanceStyle({ windowOpacity })

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
          : event.ctrlKey && !event.metaKey
            ? key === 'arrowleft'
              ? 'left'
              : key === 'arrowright'
                ? 'right'
                : key === 'arrowup'
                  ? 'up'
                  : key === 'arrowdown'
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
    </div>
  )
}
