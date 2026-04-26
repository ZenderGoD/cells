import { useEffect, useState, useRef, useCallback, useLayoutEffect } from 'react'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import { inferAgentFromTitle } from '@/lib/agent-command'
import {
  STATUS_BAR_HEIGHT,
  getCanvasWindows,
  getViewportRect,
  orderByRecent,
} from '@/lib/canvas-navigation'
import { hapticNudge, hapticSuccess } from '@/lib/haptics'
import { motion, AnimatePresence } from 'motion/react'
import { WindowOverviewMap } from './canvas/window-overview-map'
import { AgentIcon } from './agent-icon'
import { Logo } from './logo'
import { getAgentWindowStatusPresentation, getStatusPresentation } from '@/lib/status-indicator'
import type { AgentWindowStatus, TerminalRuntimeStatus } from '@/types'

interface SwitcherItem {
  id: string
  title: string
  type: 'terminal' | 'browser' | 'agent'
  agent?: 'claude' | 'codex' | 'opencode' | 'pi' | null
  runtimeStatus?: TerminalRuntimeStatus | null
  agentStatus?: AgentWindowStatus | null
  url?: string
  isCurrent: boolean
  faviconUrl?: string
}

export function TerminalSwitcher() {
  const terminals = useStore((s) => s.terminals)
  const browsers = useStore((s) => s.browsers)
  const agentWindows = useStore((s) => s.agentWindows)
  const focusedTerminalId = useStore((s) => s.focusedTerminalId)
  const focusedBrowserId = useStore((s) => s.focusedBrowserId)
  const focusedAgentWindowId = useStore((s) => s.focusedAgentWindowId)
  const canvas = useStore((s) => s.canvas)
  const snapToTerminal = useStore((s) => s.snapToTerminal)
  const snapToBrowser = useStore((s) => s.snapToBrowser)
  const snapToAgentWindow = useStore((s) => s.snapToAgentWindow)
  const setOverlayOpen = useStore((s) => s.setOverlayOpen)
  const tabSwitchMode = useStore((s) => s.tabSwitchMode)
  const reducedMotion = useStore((s) => s.reducedMotion)
  const titleBarHidden = useStore((s) => s.titleBarHidden)

  const [open, setOpenRaw] = useState(false)
  const openRef = useRef(false)
  const setOpen = useCallback(
    (v: boolean) => {
      openRef.current = v
      setOpenRaw(v)
      setOverlayOpen('terminal-switcher', v)
    },
    [setOverlayOpen],
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedIndexRef = useRef(0)
  const selectedIdRef = useRef<string | null>(null)
  const ctrlHeld = useRef(false)
  const mouseActivated = useRef(false)
  const overviewContainerRef = useRef<HTMLDivElement | null>(null)
  const [overviewAvailableWidth, setOverviewAvailableWidth] = useState(0)

  const updateSelected = useCallback((index: number, id: string | null) => {
    selectedIndexRef.current = index
    selectedIdRef.current = id
    setSelectedIndex(index)
  }, [])

  // Build combined list of all switchable items
  const focusHistory = useStore((s) => s.focusHistory)
  const chronologicalItems: SwitcherItem[] = [
    ...terminals.map((t) => ({
      id: t.id,
      title: t.customTitle || t.title,
      type: 'terminal' as const,
      agent: t.agent ?? inferAgentFromTitle(t.customTitle || t.title),
      runtimeStatus: t.runtimeStatus ?? null,
      isCurrent: t.id === focusedTerminalId,
    })),
    ...browsers.map((b) => ({
      id: b.id,
      title: b.title || b.url || 'New Tab',
      type: 'browser' as const,
      url: b.url,
      isCurrent: b.id === focusedBrowserId,
      faviconUrl: b.faviconUrl,
    })),
    ...agentWindows.map((a) => ({
      id: a.id,
      title: a.customTitle || a.title || (a.agent === 'claude' ? 'Claude Code' : 'Codex'),
      type: 'agent' as const,
      agent: a.agent,
      agentStatus: a.status ?? null,
      isCurrent: a.id === focusedAgentWindowId,
    })),
  ]

  const currentId = focusedTerminalId || focusedBrowserId || focusedAgentWindowId
  const canvasWindows = getCanvasWindows(terminals, browsers, agentWindows)
  const viewportRect = getViewportRect(
    canvas,
    window.innerWidth,
    window.innerHeight - (titleBarHidden ? 0 : STATUS_BAR_HEIGHT),
  )
  const items = (
    tabSwitchMode === 'recent' && focusHistory.length > 0
      ? orderByRecent(chronologicalItems, currentId, focusHistory)
      : chronologicalItems
  ).slice(0, 12)
  const selectedItemId = items[selectedIndex]?.id ?? currentId ?? null
  const desiredOverviewWidth = Math.min(980, Math.max(560, items.length * 118))
  const fallbackOverviewWidth = Math.max(240, Math.min(window.innerWidth * 0.98, 700) - 32)
  const overviewWidth =
    overviewAvailableWidth > 0
      ? Math.min(desiredOverviewWidth, overviewAvailableWidth)
      : Math.min(desiredOverviewWidth, fallbackOverviewWidth)

  useLayoutEffect(() => {
    const node = overviewContainerRef.current
    if (!node) return

    const updateWidth = () => {
      setOverviewAvailableWidth(node.clientWidth)
    }

    updateWidth()
    const resizeObserver = new ResizeObserver(updateWidth)
    resizeObserver.observe(node)
    return () => resizeObserver.disconnect()
  }, [open])

  const cycle = useCallback(
    (direction: 1 | -1) => {
      const state = useStore.getState()
      const chronologicalItems = [
        ...state.terminals.map((t) => ({ id: t.id, type: 'terminal' as const })),
        ...state.browsers.map((b) => ({ id: b.id, type: 'browser' as const })),
        ...state.agentWindows.map((a) => ({ id: a.id, type: 'agent' as const })),
      ]
      if (chronologicalItems.length < 2) return

      const currentId =
        state.focusedTerminalId || state.focusedBrowserId || state.focusedAgentWindowId
      const allItems = (
        state.tabSwitchMode === 'recent' && state.focusHistory.length > 0
          ? orderByRecent(chronologicalItems, currentId, state.focusHistory)
          : chronologicalItems
      ).slice(0, 12)

      let nextIdx: number
      if (!openRef.current) {
        if (state.tabSwitchMode === 'recent') {
          const previousId = [...state.focusHistory]
            .reverse()
            .find((id) => id !== currentId && allItems.some((item) => item.id === id))
          const previousIndex = previousId
            ? allItems.findIndex((item) => item.id === previousId)
            : -1

          if (direction === 1 && previousIndex !== -1) {
            nextIdx = previousIndex
          } else {
            nextIdx = direction === 1 ? 1 : allItems.length - 1
          }
        } else {
          const currentIdx = allItems.findIndex((item) => item.id === currentId)
          const startIdx = currentIdx === -1 ? 0 : currentIdx
          nextIdx = (((startIdx + direction) % allItems.length) + allItems.length) % allItems.length
        }
        mouseActivated.current = false
        setOpen(true)
      } else {
        nextIdx =
          (((selectedIndexRef.current + direction) % allItems.length) + allItems.length) %
          allItems.length
      }
      updateSelected(nextIdx, allItems[nextIdx]?.id ?? null)
      hapticNudge()
    },
    [setOpen, updateSelected],
  )

  const commit = useCallback(() => {
    if (openRef.current && selectedIdRef.current) {
      const state = useStore.getState()
      const targetId = selectedIdRef.current
      const isTerminal = state.terminals.some((t) => t.id === targetId)
      const isBrowser = state.browsers.some((b) => b.id === targetId)
      const isAgent = state.agentWindows.some((a) => a.id === targetId)
      if (isTerminal) {
        snapToTerminal(targetId)
      } else if (isBrowser) {
        snapToBrowser(targetId)
      } else if (isAgent) {
        snapToAgentWindow(targetId)
      }
      hapticSuccess()
    }
    setOpen(false)
    updateSelected(0, null)
  }, [setOpen, snapToAgentWindow, snapToBrowser, snapToTerminal, updateSelected])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        e.stopPropagation()
        ctrlHeld.current = true
        cycle(e.shiftKey ? -1 : 1)
      }

      if (e.key === 'Control') {
        ctrlHeld.current = true
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') {
        ctrlHeld.current = false
        commit()
      }
    }

    const handleBlur = () => {
      if (ctrlHeld.current) {
        ctrlHeld.current = false
        commit()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', handleBlur)
    }
  }, [commit, cycle])

  useEffect(() => {
    const unsub = window.cells.browser.onWindowCycle((direction) => {
      ctrlHeld.current = true
      cycle(direction)
    })
    return unsub
  }, [cycle])

  if (items.length < 2) return null

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={reducedMotion ? false : { opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
          transition={{ duration: reducedMotion ? 0 : 0.12 }}
          className="fixed inset-0 z-[10000] flex items-center justify-center pointer-events-none"
        >
          <div
            className="w-[min(98vw,700px)] max-w-[min(98vw,700px)] bg-card/92 rounded-xl ring-1 ring-border/40 p-3 pointer-events-auto"
            onMouseMove={() => {
              mouseActivated.current = true
            }}
          >
            <div ref={overviewContainerRef} className="min-w-0 px-1 pb-2">
              <WindowOverviewMap
                windows={canvasWindows}
                currentId={selectedItemId}
                focusedId={currentId}
                viewport={viewportRect}
                width={overviewWidth}
                height={142}
                className="mx-auto max-w-full border-0 bg-transparent rounded-none"
                onSelect={(window) => {
                  const nextIndex = items.findIndex((item) => item.id === window.id)
                  if (nextIndex !== -1) updateSelected(nextIndex, window.id)
                }}
              />
            </div>

            <div className="mt-2 px-1 py-2">
              <div className="flex flex-wrap gap-3 items-stretch justify-center">
                {items.slice(0, 12).map((item, i) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      updateSelected(i, item.id)
                      selectedIdRef.current = item.id
                      commit()
                    }}
                    onMouseEnter={() => {
                      if (mouseActivated.current) updateSelected(i, item.id)
                    }}
                    className={cn(
                      'relative flex flex-col rounded-lg overflow-hidden transition-all shrink-0 bg-card/30 text-left',
                      i === selectedIndex
                        ? 'ring-2 ring-primary'
                        : 'ring-1 ring-border/30 hover:ring-border/50',
                    )}
                    style={{ width: 160, height: 110 }}
                  >
                    {/* Icon area */}
                    <div className="relative flex-1 w-full grid place-items-center overflow-hidden bg-background">
                      {item.type === 'terminal' || item.type === 'agent' ? (
                        item.agent ? (
                          <AgentIcon
                            agent={item.agent}
                            className={cn(
                              'h-6 w-6',
                              i === selectedIndex ? 'opacity-100' : 'opacity-35',
                            )}
                            size={24}
                          />
                        ) : (
                          <Logo
                            className={cn(
                              'h-6 w-6',
                              i === selectedIndex ? 'text-primary/60' : 'text-muted-foreground/20',
                            )}
                          />
                        )
                      ) : item.faviconUrl ? (
                        <img
                          src={item.faviconUrl}
                          alt=""
                          className="w-6 h-6 rounded-sm object-contain"
                        />
                      ) : (
                        <Globe
                          className={cn(
                            'w-6 h-6',
                            i === selectedIndex ? 'text-primary/60' : 'text-muted-foreground/20',
                          )}
                        />
                      )}
                    </div>

                    {/* Title bar */}
                    <div
                      className={cn(
                        'px-2 py-1.5 flex items-center gap-1.5 bg-card/90',
                        i === selectedIndex ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {item.type === 'terminal' || item.type === 'agent' ? (
                        item.agent ? (
                          <AgentIcon agent={item.agent} className="h-3 w-3 opacity-80" size={12} />
                        ) : (
                          <Logo className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                        )
                      ) : item.faviconUrl ? (
                        <img
                          src={item.faviconUrl}
                          alt=""
                          className="w-3 h-3 shrink-0 rounded-[1px] object-contain"
                        />
                      ) : (
                        <Globe className="w-3 h-3 shrink-0 text-muted-foreground/50" />
                      )}
                      <span className="text-[10px] truncate flex-1">{item.title}</span>
                      {(() => {
                        if (item.type === 'agent') {
                          const presentation = getAgentWindowStatusPresentation(item.agentStatus)
                          const hasStatus = item.agentStatus && item.agentStatus !== 'idle'
                          if (hasStatus)
                            return (
                              <div
                                className={`w-1.5 h-1.5 rounded-full shrink-0 ${presentation.dotClass}`}
                                title={presentation.label}
                              />
                            )
                          if (item.isCurrent)
                            return (
                              <div className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0" />
                            )
                          return null
                        }
                        const si = getStatusPresentation(item.runtimeStatus, { agent: item.agent })
                        if (si.dotClass)
                          return (
                            <div
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${si.dotClass}`}
                              title={si.label}
                            />
                          )
                        if (item.isCurrent)
                          return <div className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0" />
                        return null
                      })()}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-2 px-1 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/30">⌃Tab forward, ⇧⌃Tab back</span>
              <span className="text-[10px] text-muted-foreground/30">Release ⌃ to switch</span>
            </div>

            <div className="mt-2 px-1 text-center">
              <span className="text-[9px] text-muted-foreground/40">
                Configure switcher order in Settings
              </span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
