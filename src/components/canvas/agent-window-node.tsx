import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import {
  ClipboardCopy,
  FolderOpen,
  MoreHorizontal,
  PencilLine,
  RotateCcw,
  XCircle,
} from 'lucide-react'
import type { AgentWindowNode as AgentWindowNodeType } from '@/types'
import { useStore } from '@/lib/store'
import { useShallow } from 'zustand/react/shallow'
import { hasPrimaryModifier } from '@/lib/keyboard-shortcuts'
import { cn } from '@/lib/utils'
import { AgentChatPanel } from '@/components/agent-session/agent-chat-panel'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { getAgentWindowColor } from '@/lib/agent-window-colors'

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const MIN_W = 460
const MIN_H = 360
const HANDLE = 6

interface AgentWindowNodeProps {
  agentWindow: AgentWindowNodeType
  scale: number
  selectionMode: boolean
  isSelected: boolean
  isFocused: boolean
  onDragStart: (
    id: string,
    kind: 'terminal' | 'browser' | 'agent',
    startX: number,
    startY: number,
  ) => void
}

export const AgentWindowNode = memo(function AgentWindowNode({
  agentWindow,
  scale,
  selectionMode,
  isSelected,
  isFocused,
  onDragStart,
}: AgentWindowNodeProps) {
  const {
    moveAgentWindow,
    resizeAgentWindow,
    requestCloseWindow,
    focusAgentWindow,
    bringAgentWindowToFront,
    syncAgentWindow,
  } = useStore(
    useShallow((state) => ({
      moveAgentWindow: state.moveAgentWindow,
      resizeAgentWindow: state.resizeAgentWindow,
      requestCloseWindow: state.requestCloseWindow,
      focusAgentWindow: state.focusAgentWindow,
      bringAgentWindowToFront: state.bringAgentWindowToFront,
      syncAgentWindow: state.syncAgentWindow,
    })),
  )
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [isResizing, setIsResizing] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const z = agentWindow.zIndex ?? 1

  useEffect(() => {
    if (!isEditingTitle) return
    titleInputRef.current?.focus()
    titleInputRef.current?.select()
  }, [isEditingTitle])

  const commitTitle = useCallback(() => {
    setIsEditingTitle(false)
    syncAgentWindow(agentWindow.id, { customTitle: editValue.trim() || null })
  }, [agentWindow.id, editValue, syncAgentWindow])

  const handleDragMouseDown = useCallback(
    (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest('button')) return
      if ((event.target as HTMLElement).closest('input')) return
      const modifierDrag = hasPrimaryModifier(event)
      if (!selectionMode && !modifierDrag) {
        focusAgentWindow(agentWindow.id)
        if (!isFocused) bringAgentWindowToFront(agentWindow.id)
        return
      }
      if (modifierDrag && !selectionMode) {
        focusAgentWindow(agentWindow.id)
        if (!isFocused) bringAgentWindowToFront(agentWindow.id)
      }
      event.preventDefault()
      event.stopPropagation()
      onDragStart(agentWindow.id, 'agent', event.clientX, event.clientY)
    },
    [
      agentWindow.id,
      bringAgentWindowToFront,
      focusAgentWindow,
      isFocused,
      onDragStart,
      selectionMode,
    ],
  )

  const handleNodeMouseDown = useCallback(
    (event: MouseEvent) => {
      const modifierDrag = hasPrimaryModifier(event)
      if (!selectionMode && !modifierDrag) {
        focusAgentWindow(agentWindow.id)
        if (!isFocused) bringAgentWindowToFront(agentWindow.id)
        return
      }
      if (modifierDrag && !selectionMode) {
        focusAgentWindow(agentWindow.id)
        if (!isFocused) bringAgentWindowToFront(agentWindow.id)
      }
      event.preventDefault()
      event.stopPropagation()
      onDragStart(agentWindow.id, 'agent', event.clientX, event.clientY)
    },
    [
      agentWindow.id,
      bringAgentWindowToFront,
      focusAgentWindow,
      isFocused,
      onDragStart,
      selectionMode,
    ],
  )

  const handleEdgeMouseDown = useCallback(
    (edge: Edge, event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setIsResizing(true)

      const startX = event.clientX
      const startY = event.clientY
      const startW = agentWindow.width
      const startH = agentWindow.height
      const startPx = agentWindow.x
      const startPy = agentWindow.y
      const moveLeft = edge.includes('w')
      const moveRight = edge.includes('e')
      const moveTop = edge.includes('n')
      const moveBottom = edge.includes('s')

      const onMove = (moveEvent: globalThis.MouseEvent) => {
        const dx = (moveEvent.clientX - startX) / scale
        const dy = (moveEvent.clientY - startY) / scale
        let width = startW
        let height = startH
        let x = startPx
        let y = startPy

        if (moveRight) width = Math.max(MIN_W, startW + dx)
        if (moveBottom) height = Math.max(MIN_H, startH + dy)
        if (moveLeft) {
          width = Math.max(MIN_W, startW - dx)
          x = startPx + (startW - width)
        }
        if (moveTop) {
          height = Math.max(MIN_H, startH - dy)
          y = startPy + (startH - height)
        }

        resizeAgentWindow(agentWindow.id, width, height)
        if (moveLeft || moveTop) moveAgentWindow(agentWindow.id, x, y)
      }

      const onUp = () => {
        setIsResizing(false)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [
      agentWindow.height,
      agentWindow.id,
      agentWindow.width,
      agentWindow.x,
      agentWindow.y,
      moveAgentWindow,
      resizeAgentWindow,
      scale,
    ],
  )

  const cwd = agentWindow.cwd ?? null
  const currentTitle = agentWindow.customTitle || agentWindow.title

  const handleCopyCwd = () => {
    if (!cwd) return
    void navigator.clipboard.writeText(cwd)
  }
  const handleOpenCwd = () => {
    if (!cwd) return
    void window.cells.app.revealPath(cwd)
  }
  const handleClearConversation = async () => {
    try {
      // Fully dispose — throws away message history and session id so the next
      // ensure() starts a fresh conversation.
      await window.cells.agentSession.dispose(agentWindow.id)
      syncAgentWindow(agentWindow.id, {
        claudeSessionId: null,
        codexThreadId: null,
        error: null,
        status: 'idle',
      })
    } catch (err) {
      console.error('[agent-window] clear failed', err)
    }
  }
  const handleRename = () => {
    setEditValue(currentTitle)
    setIsEditingTitle(true)
  }
  const handleClose = () => {
    void requestCloseWindow({ id: agentWindow.id, type: 'agent' })
  }

  const colorSpec = getAgentWindowColor(agentWindow.color)
  const hasColor = colorSpec.id !== 'none'

  return (
    <div
      data-focused={isFocused ? 'true' : 'false'}
      className={cn(
        'agent-window-node group absolute overflow-hidden rounded-lg border bg-background/75 backdrop-blur-xl transition-[box-shadow,border-color,transform] duration-150',
        hasColor
          ? isFocused
            ? cn(colorSpec.focusedBorderClass, 'shadow-elevated')
            : cn(colorSpec.unfocusedBorderClass, 'shadow-middle')
          : isFocused
            ? 'border-foreground/15 shadow-elevated'
            : 'border-border/50 shadow-middle',
        isSelected && 'ring-2 ring-primary/35',
        isResizing && 'select-none',
      )}
      style={{
        left: agentWindow.x,
        top: agentWindow.y,
        width: agentWindow.width,
        height: agentWindow.height,
        zIndex: z,
      }}
      onMouseDown={handleNodeMouseDown}
    >
      {hasColor ? (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-20 h-[2px]',
            colorSpec.accentBarClass,
          )}
        />
      ) : null}
      {/* Chrome-less: a thin drag strip runs across the top so the window can
       * be moved in selection mode, and a hover-only menu button lives in the
       * top-right corner. The title/status now lives in the canvas's bottom
       * tab bar (see project-switcher / window-list). */}
      <div
        className="absolute inset-x-0 top-0 z-10 h-8 cursor-grab active:cursor-grabbing"
        onMouseDown={handleDragMouseDown}
        onDoubleClick={handleRename}
      />

      {isEditingTitle ? (
        <div className="absolute inset-x-8 top-1.5 z-20">
          <input
            ref={titleInputRef}
            value={editValue}
            onChange={(event) => setEditValue(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitTitle()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setIsEditingTitle(false)
              }
            }}
            className="w-full rounded-[6px] bg-background/60 px-2 py-1 text-center text-[12px] font-semibold text-foreground outline-none ring-1 ring-border/60"
          />
        </div>
      ) : null}

      <div
        className={cn(
          'absolute right-1.5 top-1.5 z-20 opacity-0 transition-opacity',
          isFocused && 'opacity-100',
          'group-hover:opacity-100',
        )}
      >
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Agent window menu"
                className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <PopoverContent align="end" side="bottom" sideOffset={4} className="w-56 p-1">
            <MenuItem
              icon={<PencilLine className="size-3.5" />}
              label="Rename"
              onSelect={handleRename}
            />
            <MenuItem
              icon={<ClipboardCopy className="size-3.5" />}
              label="Copy working directory"
              disabled={!cwd}
              onSelect={handleCopyCwd}
            />
            <MenuItem
              icon={<FolderOpen className="size-3.5" />}
              label="Reveal in Finder"
              disabled={!cwd}
              onSelect={handleOpenCwd}
            />
            <div className="my-1 h-px bg-border/40" />
            <MenuItem
              icon={<RotateCcw className="size-3.5" />}
              label="Clear conversation"
              onSelect={handleClearConversation}
            />
            <MenuItem
              icon={<XCircle className="size-3.5" />}
              label="Close session"
              onSelect={handleClose}
              tone="danger"
            />
          </PopoverContent>
        </Popover>
      </div>

      <div className="h-full bg-gradient-to-b from-background/30 to-background/55">
        <AgentChatPanel agentWindow={agentWindow} />
      </div>

      {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as Edge[]).map((edge) => (
        <div
          key={edge}
          className="absolute z-20"
          style={{
            top: edge.includes('n') ? -HANDLE / 2 : edge.includes('s') ? undefined : HANDLE,
            bottom: edge.includes('s') ? -HANDLE / 2 : edge.includes('n') ? undefined : HANDLE,
            left: edge.includes('w') ? -HANDLE / 2 : edge.includes('e') ? undefined : HANDLE,
            right: edge.includes('e') ? -HANDLE / 2 : edge.includes('w') ? undefined : HANDLE,
            width: edge === 'n' || edge === 's' ? `calc(100% - ${HANDLE * 2}px)` : HANDLE * 2,
            height: edge === 'e' || edge === 'w' ? `calc(100% - ${HANDLE * 2}px)` : HANDLE * 2,
            cursor:
              edge === 'n' || edge === 's'
                ? 'ns-resize'
                : edge === 'e' || edge === 'w'
                  ? 'ew-resize'
                  : edge === 'ne' || edge === 'sw'
                    ? 'nesw-resize'
                    : 'nwse-resize',
          }}
          onMouseDown={(event) => handleEdgeMouseDown(edge, event)}
        />
      ))}
    </div>
  )
})

interface MenuItemProps {
  icon: React.ReactNode
  label: string
  onSelect: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
}

function MenuItem({ icon, label, onSelect, disabled, tone = 'default' }: MenuItemProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12.5px] transition-colors',
        disabled
          ? 'cursor-not-allowed text-muted-foreground/40'
          : tone === 'danger'
            ? 'text-red-300 hover:bg-red-500/10 hover:text-red-200'
            : 'text-foreground/90 hover:bg-foreground/5',
      )}
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center',
          tone === 'danger' ? 'text-red-300' : 'text-muted-foreground/70',
        )}
      >
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  )
}
