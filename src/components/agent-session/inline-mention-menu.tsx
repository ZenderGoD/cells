import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { FileText, Folder, ListTodo } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { AgentMentionSearchResult } from '@/types'
import {
  extractAgentComposerMentionTrigger,
  type AgentComposerMentionKind,
} from '@/lib/agent-composer-mentions'
import { cn } from '@/lib/utils'

// Design note: this menu is rendered INSIDE the composer pill (above the
// textarea), not as a floating popover. The composer expands upward when
// `@` is typed, and the menu shares the composer's width so full relative
// paths stay readable. Backend scoring already ranks on label AND
// relativePath (see electron/main.ts getAgentMentionScore), so fuzzy-path
// matching works once the UI has room to show it.

interface UseInlineMentionOptions {
  inputRef: RefObject<HTMLTextAreaElement | null>
  cwd?: string | null
}

interface InlineMentionSelection {
  value: string
  cursorPosition: number
}

type InlineMentionKeyResult = InlineMentionSelection | 'handled' | null

interface InlineMentionMenuProps {
  open: boolean
  items: AgentMentionSearchResult[]
  query: string
  selectedIndex: number
  onHover: (index: number) => void
  onSelect: (item: AgentMentionSearchResult) => void
}

const EASE_OUT: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94]
// ease-out-quart — smoother tail for height-based expand/collapse.
const EASE_EXPAND: [number, number, number, number] = [0.22, 1, 0.36, 1]
const EXPAND_TRANSITION = {
  height: { duration: 0.28, ease: EASE_EXPAND },
  opacity: { duration: 0.18, ease: EASE_EXPAND },
} as const

function buildMentionText(item: AgentMentionSearchResult): string {
  const kind: AgentComposerMentionKind = item.type
  return `[${kind}:${item.relativePath}] `
}

function MentionItemIcon({ item }: { item: AgentMentionSearchResult }) {
  if (item.type === 'skill') {
    return <ListTodo className="size-4 text-muted-foreground/80" />
  }
  if (item.type === 'folder') {
    return <Folder className="size-4 text-muted-foreground/80" />
  }
  return <FileText className="size-4 text-muted-foreground/80" />
}

function typeBadgeLabel(type: AgentMentionSearchResult['type']): string {
  if (type === 'skill') return 'Skill'
  if (type === 'folder') return 'Folder'
  return 'File'
}

export function InlineMentionMenu({
  open,
  items,
  query,
  selectedIndex,
  onHover,
  onSelect,
}: InlineMentionMenuProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (!open) return
    const selected = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')
    selected?.scrollIntoView({ block: 'nearest' })
  }, [open, selectedIndex])

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="mention-menu"
          // Height animation trades layout cost for the natural "composer
          // grows upward" feel — a one-shot toggle so the cost is paid
          // once per open/close. Reduced motion drops to opacity only.
          initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
          animate={reduceMotion ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { height: 0 }}
          transition={reduceMotion ? { duration: 0.18, ease: EASE_OUT } : EXPAND_TRANSITION}
          className="overflow-hidden border-b border-border/40"
        >
          <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
              Files, folders &amp; skills
            </span>
            {query ? (
              <span className="truncate text-[11px] text-muted-foreground/55">“{query}”</span>
            ) : null}
          </div>
          <div ref={listRef} className="max-h-[280px] overflow-y-auto pb-1">
            {items.length === 0 ? (
              <div className="px-3 py-3 text-[12.5px] text-muted-foreground/60">
                No matches. Try a path fragment like <code>skills/release</code>.
              </div>
            ) : null}
            {items.map((item, index) => {
              const isSelected = index === selectedIndex
              return (
                <div
                  key={`${item.type}-${item.absolutePath}`}
                  data-selected={isSelected}
                  onMouseEnter={() => onHover(index)}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    onSelect(item)
                  }}
                  className={cn(
                    'mx-1.5 flex cursor-pointer select-none items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-[13px] transition-colors',
                    isSelected ? 'bg-foreground/8' : 'hover:bg-foreground/5',
                  )}
                >
                  <MentionItemIcon item={item} />
                  <div className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="shrink-0 truncate font-medium text-foreground/95">
                      {item.label}
                    </span>
                    <span
                      className="min-w-0 truncate text-[11.5px] text-muted-foreground/65"
                      dir="rtl"
                      // dir=rtl keeps the END of long paths visible when
                      // they don't fit — the filename/leaf matters most.
                    >
                      <bdi>{item.relativePath}</bdi>
                    </span>
                  </div>
                  <span className="shrink-0 rounded-[4px] bg-foreground/5 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/80">
                    {typeBadgeLabel(item.type)}
                  </span>
                </div>
              )
            })}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export function useInlineMention({ inputRef, cwd }: UseInlineMentionOptions) {
  const [open, setOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [items, setItems] = useState<AgentMentionSearchResult[]>([])
  const [query, setQuery] = useState('')
  const [atStart, setAtStart] = useState(-1)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRequestIdRef = useRef(0)
  const currentInputRef = useRef({ value: '', cursorPosition: 0 })

  const close = useCallback(() => {
    searchRequestIdRef.current += 1
    setOpen(false)
    setItems([])
    setQuery('')
    setSelectedIndex(0)
    setAtStart(-1)
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current)
      searchTimeoutRef.current = null
    }
  }, [])

  useEffect(() => () => close(), [close])

  const runSearch = useCallback(
    (nextQuery: string) => {
      searchRequestIdRef.current += 1
      const requestId = searchRequestIdRef.current
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
        searchTimeoutRef.current = null
      }
      searchTimeoutRef.current = setTimeout(async () => {
        if (!cwd) {
          setItems([])
          return
        }
        try {
          const results = await window.cells.app.searchAgentMentions(cwd, nextQuery)
          if (requestId !== searchRequestIdRef.current) return
          setItems(results)
        } catch (error) {
          console.error('[agent-chat] mention search failed', error)
          if (requestId === searchRequestIdRef.current) setItems([])
        }
      }, 80)
    },
    [cwd],
  )

  const handleInputChange = useCallback(
    (value: string, cursorPosition: number) => {
      currentInputRef.current = { value, cursorPosition }
      const trigger = extractAgentComposerMentionTrigger(value, cursorPosition)
      if (!trigger) {
        close()
        return
      }

      setAtStart(trigger.start)
      setOpen(true)
      setQuery(trigger.query)
      setSelectedIndex(0)
      runSearch(trigger.query)
    },
    [close, runSearch],
  )

  const selectItem = useCallback(
    (item: AgentMentionSearchResult): InlineMentionSelection => {
      const mentionText = buildMentionText(item)
      const { value, cursorPosition } = currentInputRef.current
      const before = atStart >= 0 ? value.slice(0, atStart) : value
      const after = atStart >= 0 ? value.slice(cursorPosition) : ''
      const nextValue = `${before}${mentionText}${after}`
      close()
      return {
        value: nextValue,
        cursorPosition: before.length + mentionText.length,
      }
    },
    [atStart, close],
  )

  const flatItems = useMemo(() => items, [items])

  const handleKeyDown = useCallback(
    (event: Pick<KeyboardEvent, 'key' | 'preventDefault'>): InlineMentionKeyResult => {
      if (!open) return null
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedIndex((current) => (flatItems.length > 0 ? (current + 1) % flatItems.length : 0))
        return 'handled'
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex((current) =>
          flatItems.length > 0 ? (current - 1 + flatItems.length) % flatItems.length : 0,
        )
        return 'handled'
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return 'handled'
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (flatItems.length === 0) {
          event.preventDefault()
          return 'handled'
        }
        event.preventDefault()
        return selectItem(flatItems[selectedIndex] ?? flatItems[0])
      }
      return null
    },
    [close, flatItems, open, selectItem, selectedIndex],
  )

  // `inputRef` is reserved for future use (e.g., closing on focus loss); kept
  // in the API to avoid churn at the call site.
  void inputRef

  return {
    open,
    items,
    query,
    selectedIndex,
    setSelectedIndex,
    handleInputChange,
    handleKeyDown,
    selectItem,
    close,
  }
}
