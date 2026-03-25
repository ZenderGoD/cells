import { useEffect, useState, useCallback, useRef } from 'react'
import { Globe, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import { motion, AnimatePresence } from 'motion/react'

interface SwitcherItem {
  id: string
  title: string
  type: 'terminal' | 'browser'
  url?: string
  isCurrent: boolean
}

export function TerminalSwitcher() {
  const terminals = useStore((s) => s.terminals)
  const browsers = useStore((s) => s.browsers)
  const focusedTerminalId = useStore((s) => s.focusedTerminalId)
  const focusedBrowserId = useStore((s) => s.focusedBrowserId)
  const snapToTerminal = useStore((s) => s.snapToTerminal)
  const snapToBrowser = useStore((s) => s.snapToBrowser)
  const setOverlayOpen = useStore((s) => s.setOverlayOpen)

  const [open, setOpenRaw] = useState(false)
  const setOpen = (v: boolean) => {
    setOpenRaw(v)
    setOverlayOpen(v)
  }
  const [selectedIndex, setSelectedIndex] = useState(0)
  const ctrlHeld = useRef(false)

  // Build combined list of all switchable items
  const items: SwitcherItem[] = [
    ...terminals.map((t) => ({
      id: t.id,
      title: t.title,
      type: 'terminal' as const,
      isCurrent: t.id === focusedTerminalId,
    })),
    ...browsers.map((b) => ({
      id: b.id,
      title: b.title || b.url || 'New Tab',
      type: 'browser' as const,
      url: b.url,
      isCurrent: b.id === focusedBrowserId,
    })),
  ]

  const cycle = useCallback(
    (direction: 1 | -1) => {
      const state = useStore.getState()
      const allItems = [
        ...state.terminals.map((t) => ({ id: t.id, type: 'terminal' as const })),
        ...state.browsers.map((b) => ({ id: b.id, type: 'browser' as const })),
      ]
      if (allItems.length < 2) return

      if (!open) {
        const currentId = state.focusedTerminalId || state.focusedBrowserId
        const currentIdx = allItems.findIndex((item) => item.id === currentId)
        const startIdx = currentIdx === -1 ? 0 : currentIdx
        const nextIdx =
          (((startIdx + direction) % allItems.length) + allItems.length) % allItems.length
        setSelectedIndex(nextIdx)
        setOpen(true)
      } else {
        setSelectedIndex((prev) => {
          const next = (((prev + direction) % allItems.length) + allItems.length) % allItems.length
          return next
        })
      }
    },
    [open],
  )

  const commit = useCallback(() => {
    const state = useStore.getState()
    const allItems = [
      ...state.terminals.map((t) => ({ id: t.id, type: 'terminal' as const })),
      ...state.browsers.map((b) => ({ id: b.id, type: 'browser' as const })),
    ]
    if (allItems.length > 0 && open) {
      const target = allItems[selectedIndex]
      if (target) {
        if (target.type === 'terminal') {
          snapToTerminal(target.id)
        } else {
          snapToBrowser(target.id)
        }
      }
    }
    setOpen(false)
  }, [open, selectedIndex, snapToTerminal, snapToBrowser])

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
  }, [cycle, commit])

  if (items.length < 2) return null

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
        >
          <div className="bg-card/80 backdrop-blur-xl rounded-xl ring-1 ring-border/40 shadow-2xl p-3 pointer-events-auto max-w-lg">
            {/* Grid of preview tiles */}
            <div className={cn('grid gap-2', items.length <= 4 ? 'grid-cols-2' : 'grid-cols-3')}>
              {items.map((item, i) => (
                <div
                  key={item.id}
                  className={cn(
                    'relative flex flex-col rounded-lg overflow-hidden transition-all',
                    i === selectedIndex
                      ? 'ring-2 ring-primary shadow-lg shadow-primary/10'
                      : 'ring-1 ring-border/30',
                  )}
                  style={{ width: 160, height: 110 }}
                >
                  {/* Preview area */}
                  <div
                    className={cn(
                      'flex-1 flex items-center justify-center',
                      item.type === 'terminal' ? 'bg-neutral-950' : 'bg-neutral-900',
                    )}
                  >
                    {item.type === 'terminal' ? (
                      <TerminalSquare
                        className={cn(
                          'w-6 h-6',
                          i === selectedIndex ? 'text-primary/60' : 'text-muted-foreground/20',
                        )}
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

            <div className="mt-2 px-1 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/30">⌃Tab to cycle</span>
              <span className="text-[10px] text-muted-foreground/30">Release ⌃ to switch</span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
