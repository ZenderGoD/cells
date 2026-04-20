import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { FileText, Folder, ListTodo } from 'lucide-react'
import type { AgentMentionSearchResult } from '@/types'
import {
  extractAgentComposerMentionTrigger,
  type AgentComposerMentionKind,
} from '@/lib/agent-composer-mentions'
import { cn } from '@/lib/utils'

// Copied and adapted from Craft Agents OSS inline mention UI:
// ../craft-agents-oss/apps/electron/src/renderer/components/ui/mention-menu.tsx
// ../craft-agents-oss/apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx

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
  position: { x: number; y: number }
  selectedIndex: number
  onHover: (index: number) => void
  onSelect: (item: AgentMentionSearchResult) => void
  onClose: () => void
}

const MENU_CONTAINER_STYLE =
  'overflow-hidden rounded-[8px] bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10'
const MENU_LIST_STYLE = 'max-h-[240px] overflow-y-auto py-1'
const MENU_ITEM_STYLE =
  'mx-1 flex cursor-pointer select-none items-center gap-3 rounded-[6px] px-2 py-1.5 text-[13px]'
const MENU_ITEM_SELECTED = 'bg-foreground/5'
const MENU_TYPE_BADGE =
  'shrink-0 rounded-[4px] bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm'

function getParentDir(relativePath: string): string {
  const lastSlash = relativePath.lastIndexOf('/')
  if (lastSlash <= 0) return ''
  return relativePath.slice(0, lastSlash + 1)
}

function getTextareaCaretRect(textarea: HTMLTextAreaElement): DOMRect | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  const style = window.getComputedStyle(textarea)
  const mirror = document.createElement('div')
  const span = document.createElement('span')
  const rect = textarea.getBoundingClientRect()
  const selectionStart = textarea.selectionStart ?? 0
  const before = textarea.value.slice(0, selectionStart)

  const properties = [
    'boxSizing',
    'width',
    'height',
    'overflowX',
    'overflowY',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontStyle',
    'fontVariant',
    'fontWeight',
    'fontStretch',
    'fontSize',
    'fontSizeAdjust',
    'lineHeight',
    'fontFamily',
    'textAlign',
    'textTransform',
    'textIndent',
    'textDecoration',
    'letterSpacing',
    'wordSpacing',
    'tabSize',
  ] as const

  mirror.style.position = 'fixed'
  mirror.style.pointerEvents = 'none'
  mirror.style.visibility = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordBreak = 'break-word'
  mirror.style.left = `${rect.left}px`
  mirror.style.top = `${rect.top}px`
  mirror.style.transform = `translateY(-${textarea.scrollTop}px)`

  for (const property of properties) {
    ;(mirror.style as any)[property] = style[property]
  }

  mirror.textContent = before
  if (before.endsWith('\n') || before.length === 0) {
    mirror.append(document.createTextNode('\u200b'))
  }
  span.textContent = textarea.value.slice(selectionStart) || '\u200b'
  mirror.appendChild(span)
  document.body.appendChild(mirror)
  const caretRect = span.getBoundingClientRect()
  document.body.removeChild(mirror)
  return caretRect
}

function buildMentionText(item: AgentMentionSearchResult): string {
  const kind: AgentComposerMentionKind = item.type
  return `[${kind}:${item.relativePath}] `
}

function MentionItemIcon({ item }: { item: AgentMentionSearchResult }) {
  if (item.type === 'skill') {
    return <ListTodo className="size-4 text-muted-foreground" />
  }
  if (item.type === 'folder') {
    return <Folder className="size-4 text-muted-foreground" />
  }
  return <FileText className="size-4 text-muted-foreground" />
}

export function InlineMentionMenu({
  open,
  items,
  position,
  selectedIndex,
  onHover,
  onSelect,
  onClose,
}: InlineMentionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const selected = menuRef.current?.querySelector<HTMLElement>('[data-selected="true"]')
    selected?.scrollIntoView({ block: 'nearest' })
  }, [open, selectedIndex])

  if (!open) return null

  const bottomPosition =
    typeof window !== 'undefined' ? window.innerHeight - Math.round(position.y) + 8 : 0

  return (
    <div
      ref={menuRef}
      className={cn('fixed z-[20010]', MENU_CONTAINER_STYLE)}
      style={{
        left: Math.round(position.x) - 10,
        bottom: bottomPosition,
        width: 280,
        maxWidth: 280,
      }}
    >
      <div className="border-b border-foreground/5 px-3 py-1.5 text-[12px] font-medium text-muted-foreground">
        Files, folders & skills
      </div>
      <div className={MENU_LIST_STYLE}>
        {items.length === 0 ? (
          <div className="px-3 py-2 text-[12px] text-muted-foreground/60">No results</div>
        ) : null}
        {items.map((item, index) => {
          const isSelected = index === selectedIndex
          const parentDir = getParentDir(item.relativePath)
          return (
            <div
              key={`${item.type}-${item.absolutePath}`}
              data-selected={isSelected}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault()
                onSelect(item)
              }}
              className={cn(MENU_ITEM_STYLE, isSelected && MENU_ITEM_SELECTED)}
            >
              <div className="shrink-0">
                <MentionItemIcon item={item} />
              </div>
              {item.type === 'skill' ? (
                <>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate">{item.label}</span>
                  </div>
                  <span className={MENU_TYPE_BADGE}>Skill</span>
                </>
              ) : (
                <>
                  <span className="shrink-0">{item.label}</span>
                  {parentDir ? (
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground/50">
                      {parentDir}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function useInlineMention({ inputRef, cwd }: UseInlineMentionOptions) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [items, setItems] = useState<AgentMentionSearchResult[]>([])
  const [atStart, setAtStart] = useState(-1)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRequestIdRef = useRef(0)
  const currentInputRef = useRef({ value: '', cursorPosition: 0 })

  const close = useCallback(() => {
    searchRequestIdRef.current += 1
    setOpen(false)
    setItems([])
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
      setSelectedIndex(0)
      runSearch(trigger.query)

      const input = inputRef.current
      if (!input) return
      const caretRect = getTextareaCaretRect(input)
      if (caretRect && caretRect.x > 0) {
        setPosition({ x: caretRect.x, y: caretRect.y })
        return
      }
      const rect = input.getBoundingClientRect()
      const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight || '20') || 20
      const linesBeforeCursor = value.slice(0, cursorPosition).split('\n').length - 1
      setPosition({
        x: rect.left,
        y: rect.top + (linesBeforeCursor + 1) * lineHeight,
      })
    },
    [close, inputRef, runSearch],
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

  return {
    open,
    items,
    position,
    selectedIndex,
    setSelectedIndex,
    handleInputChange,
    handleKeyDown,
    selectItem,
    close,
  }
}
