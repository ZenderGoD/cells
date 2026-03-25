import { useEffect, useEffectEvent } from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'
import { useStore } from './lib/store'
import { StatusBar } from './components/toolbar/toolbar'
import { InfiniteCanvas } from './components/canvas/infinite-canvas'
import { CommandPalette } from './components/command-palette'
import { Onboarding } from './components/onboarding'
import { TerminalSwitcher } from './components/terminal-switcher'

export function App() {
  const { initialized, init, persist, projects } = useStore()

  const closeWindow = useEffectEvent(() => {
    const { focusedBrowserId, removeBrowser, terminals, focusedTerminalId, removeTerminal } =
      useStore.getState()
    if (focusedBrowserId) {
      removeBrowser(focusedBrowserId)
    } else if (terminals.length > 0) {
      removeTerminal(focusedTerminalId || terminals[terminals.length - 1].id)
    }
  })

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
  }, [])

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
