import { useEffect, useState, useRef, useCallback } from 'react'
import { Globe, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import { getCanvasWindows, getViewportRect, orderByRecent } from '@/lib/canvas-navigation'
import { motion, AnimatePresence } from 'motion/react'
import { WindowOverviewMap } from './canvas/window-overview-map'
import { getTerminalPreviewSnapshot } from './terminal/cell-terminal'

interface SwitcherItem {
  id: string
  title: string
  type: 'terminal' | 'browser'
  url?: string
  isCurrent: boolean
  previewLines?: string[]
}

export function TerminalSwitcher() {
  const terminals = useStore((s) => s.terminals)
  const browsers = useStore((s) => s.browsers)
  const focusedTerminalId = useStore((s) => s.focusedTerminalId)
  const focusedBrowserId = useStore((s) => s.focusedBrowserId)
  const canvas = useStore((s) => s.canvas)
  const snapToTerminal = useStore((s) => s.snapToTerminal)
  const snapToBrowser = useStore((s) => s.snapToBrowser)
  const setOverlayOpen = useStore((s) => s.setOverlayOpen)
  const tabSwitchMode = useStore((s) => s.tabSwitchMode)
  const reducedMotion = useStore((s) => s.reducedMotion)

  const [open, setOpenRaw] = useState(false)
  const openRef = useRef(false)
  const setOpen = useCallback(
    (v: boolean) => {
      openRef.current = v
      setOpenRaw(v)
      setOverlayOpen(v)
    },
    [setOverlayOpen],
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedIndexRef = useRef(0)
  const selectedIdRef = useRef<string | null>(null)
  const ctrlHeld = useRef(false)
  const [, setPreviewTick] = useState(0)

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
      title: t.title,
      type: 'terminal' as const,
      isCurrent: t.id === focusedTerminalId,
      previewLines: getTerminalPreviewSnapshot(t.id, { lines: 6, columns: 34 }),
    })),
    ...browsers.map((b) => ({
      id: b.id,
      title: b.title || b.url || 'New Tab',
      type: 'browser' as const,
      url: b.url,
      isCurrent: b.id === focusedBrowserId,
    })),
  ]

  const currentId = focusedTerminalId || focusedBrowserId
  const canvasWindows = getCanvasWindows(terminals, browsers)
  const viewportRect = getViewportRect(canvas)
  const items =
    tabSwitchMode === 'recent' && focusHistory.length > 0
      ? orderByRecent(chronologicalItems, currentId, focusHistory)
      : chronologicalItems
  const selectedItemId = items[selectedIndex]?.id ?? currentId ?? null

  const cycle = useCallback(
    (direction: 1 | -1) => {
      const state = useStore.getState()
      const chronologicalItems = [
        ...state.terminals.map((t) => ({ id: t.id, type: 'terminal' as const })),
        ...state.browsers.map((b) => ({ id: b.id, type: 'browser' as const })),
      ]
      if (chronologicalItems.length < 2) return

      const currentId = state.focusedTerminalId || state.focusedBrowserId
      const allItems =
        state.tabSwitchMode === 'recent' && state.focusHistory.length > 0
          ? orderByRecent(chronologicalItems, currentId, state.focusHistory)
          : chronologicalItems

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
        setOpen(true)
      } else {
        nextIdx =
          (((selectedIndexRef.current + direction) % allItems.length) + allItems.length) %
          allItems.length
      }
      updateSelected(nextIdx, allItems[nextIdx]?.id ?? null)
    },
    [setOpen, updateSelected],
  )

  const commit = useCallback(() => {
    if (openRef.current && selectedIdRef.current) {
      const state = useStore.getState()
      const targetId = selectedIdRef.current
      const isTerminal = state.terminals.some((t) => t.id === targetId)
      const isBrowser = state.browsers.some((b) => b.id === targetId)
      if (isTerminal) {
        snapToTerminal(targetId)
      } else if (isBrowser) {
        snapToBrowser(targetId)
      }
    }
    setOpen(false)
    updateSelected(0, null)
  }, [setOpen, snapToBrowser, snapToTerminal, updateSelected])

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

  useEffect(() => {
    if (!open) return
    const interval = window.setInterval(() => {
      setPreviewTick((tick) => tick + 1)
    }, 120)
    return () => window.clearInterval(interval)
  }, [open])

  if (items.length < 2) return null

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={reducedMotion ? false : { opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
          transition={{ duration: reducedMotion ? 0 : 0.12 }}
          className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
        >
          <div className="bg-card/92 rounded-xl ring-1 ring-border/40 p-3 pointer-events-auto max-w-[min(98vw,1280px)]">
            <div className="px-1 pb-2">
              <WindowOverviewMap
                windows={canvasWindows}
                currentId={selectedItemId}
                focusedId={currentId}
                viewport={viewportRect}
                width={Math.min(980, Math.max(560, items.length * 118))}
                height={142}
                className="mx-auto border-0 bg-transparent rounded-none"
                onSelect={(window) => {
                  const nextIndex = items.findIndex((item) => item.id === window.id)
                  if (nextIndex !== -1) updateSelected(nextIndex, window.id)
                }}
              />
            </div>

            <div className="mt-2 overflow-x-auto overflow-y-visible px-1 py-2 scrollbar-none">
              <div className="flex w-max min-w-full gap-3 items-stretch">
                {items.map((item, i) => (
                  <div
                    key={item.id}
                    className={cn(
                      'relative flex flex-col rounded-lg overflow-hidden transition-all shrink-0 bg-card',
                      i === selectedIndex ? 'ring-2 ring-primary' : 'border border-border/30',
                    )}
                    style={{ width: 160, height: 110 }}
                  >
                    {/* Preview area */}
                    <div
                      className={cn(
                        'relative flex-1 overflow-hidden',
                        item.type === 'terminal' ? 'bg-neutral-950' : 'bg-neutral-900',
                      )}
                    >
                      {item.type === 'terminal' ? (
                        item.previewLines && item.previewLines.some((line) => line.length > 0) ? (
                          <>
                            <pre
                              className={cn(
                                'absolute inset-0 overflow-hidden px-2 py-1.5 text-[8px] leading-[1.25] whitespace-pre text-left',
                                i === selectedIndex ? 'text-primary/80' : 'text-foreground/75',
                              )}
                              style={{
                                fontFamily:
                                  '"Geist Mono", "SFMono-Regular", "JetBrains Mono", "Menlo", monospace',
                              }}
                            >
                              {item.previewLines.join('\n')}
                            </pre>
                            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-neutral-950 via-neutral-950/70 to-transparent" />
                          </>
                        ) : (
                          <div className="flex h-full items-center justify-center">
                            <TerminalSquare
                              className={cn(
                                'w-6 h-6',
                                i === selectedIndex
                                  ? 'text-primary/60'
                                  : 'text-muted-foreground/20',
                              )}
                            />
                          </div>
                        )
                      ) : (
                        <div className="flex h-full items-center justify-center">
                          <Globe
                            className={cn(
                              'w-6 h-6',
                              i === selectedIndex ? 'text-primary/60' : 'text-muted-foreground/20',
                            )}
                          />
                        </div>
                      )}
                    </div>

                    {/* Title bar */}
                    <div
                      className={cn(
                        'px-2 py-1.5 flex items-center gap-1.5 bg-card/90',
                        i === selectedIndex ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {item.type === 'terminal' ? (
                        <TerminalSquare className="w-3 h-3 shrink-0 text-muted-foreground/50" />
                      ) : (
                        <Globe className="w-3 h-3 shrink-0 text-muted-foreground/50" />
                      )}
                      <span className="text-[10px] truncate flex-1">{item.title}</span>
                      {item.isCurrent && (
                        <div className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-2 px-1 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/30">⌃Tab forward, ⇧⌃Tab back</span>
              <span className="text-[10px] text-muted-foreground/30">Release ⌃ to switch</span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
