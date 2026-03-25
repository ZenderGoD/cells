import { useCallback, useEffect } from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'
import { useStore } from './lib/store'
import { StatusBar } from './components/toolbar/toolbar'
import { InfiniteCanvas } from './components/canvas/infinite-canvas'
import { CommandPalette } from './components/command-palette'
import { Onboarding } from './components/onboarding'
import { TerminalSwitcher } from './components/terminal-switcher'

export function App() {
  const { initialized, init, persist, projects } = useStore()

  const closeWindow = useCallback(() => {
    const { focusedBrowserId, removeBrowser, terminals, focusedTerminalId, removeTerminal } =
      useStore.getState()
    if (focusedBrowserId) {
      removeBrowser(focusedBrowserId)
    } else if (terminals.length > 0) {
      removeTerminal(focusedTerminalId || terminals[terminals.length - 1].id)
    }
  }, [])

  useHotkey('Mod+W', () => closeWindow())
  useHotkey('Mod+Q', () => window.close())
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
      if (state.overlayOpen || !event.ctrlKey || event.metaKey || event.altKey) return

      const key = event.key.toLowerCase()
      const direction =
        key === 'h' || key === 'arrowleft'
          ? 'left'
          : key === 'l' || key === 'arrowright'
            ? 'right'
            : key === 'k' || key === 'arrowup'
              ? 'up'
              : key === 'j' || key === 'arrowdown'
                ? 'down'
                : null

      if (direction) {
        event.preventDefault()
        event.stopPropagation()
        state.snapToNearest(direction)
        return
      }

      if (key === 'o' && event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        state.zoomToFitAll()
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
    if (!initialized) return
    const interval = setInterval(() => persist(), 10000)
    return () => clearInterval(interval)
  }, [initialized, persist])

  if (!initialized) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-xs text-muted-foreground/40">Loading...</p>
      </div>
    )
  }

  if (projects.length === 0) {
    return (
      <div className="h-full ring-1 ring-terminal-active/30 rounded-lg overflow-hidden">
        <Onboarding />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col ring-1 ring-terminal-active/30 rounded-lg overflow-hidden">
      <InfiniteCanvas />
      <StatusBar />
      <CommandPalette />
      <TerminalSwitcher />
    </div>
  )
}
