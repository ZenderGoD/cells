import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import {
  ArrowUpRight,
  ClipboardCopy,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  PencilLine,
  RotateCcw,
  XCircle,
} from 'lucide-react'
import { hapticBuzz } from '@/lib/haptics'
import type { AgentWindowNode as AgentWindowNodeType } from '@/types'
import { useStore } from '@/lib/store'
import { useShallow } from 'zustand/react/shallow'
import { hasPrimaryModifier } from '@/lib/keyboard-shortcuts'
import { cn } from '@/lib/utils'
import { AgentChatPanel } from '@/components/agent-session/agent-chat-panel'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { getAgentWindowColor } from '@/lib/agent-window-colors'
import { getAgentWindowStatusPresentation } from '@/lib/status-indicator'
import { WorktreeManager } from '@/components/worktree-manager'
import type { AgentWindowStatus } from '@/types'

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const MIN_W = 460
const MIN_H = 360
const HANDLE = 6

function getAgentWindowStatusAccent(
  status: AgentWindowStatus | null | undefined,
  hasUnviewedCompletion: boolean | undefined,
) {
  if (status === 'idle' && hasUnviewedCompletion) return 'oklch(76.5% 0.177 163.223)'
  switch (status) {
    case 'awaiting-approval':
      return 'oklch(82.8% 0.189 84.429)'
    case 'awaiting-input':
      return 'oklch(67.3% 0.182 276.935)'
    case 'running':
      return 'oklch(74.6% 0.16 232.66)'
    case 'plan-ready':
      return 'oklch(70.2% 0.183 293.541)'
    case 'error':
      return 'oklch(71.2% 0.194 13.428)'
    default:
      return 'oklch(70.5% 0.015 286.067)'
  }
}

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
    togglePin,
  } = useStore(
    useShallow((state) => ({
      moveAgentWindow: state.moveAgentWindow,
      resizeAgentWindow: state.resizeAgentWindow,
      requestCloseWindow: state.requestCloseWindow,
      focusAgentWindow: state.focusAgentWindow,
      bringAgentWindowToFront: state.bringAgentWindowToFront,
      syncAgentWindow: state.syncAgentWindow,
      togglePin: state.togglePin,
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
  const handleTogglePin = () => {
    hapticBuzz()
    togglePin(agentWindow.id, 'agent')
  }

  const colorSpec = getAgentWindowColor(agentWindow.color)
  const hasColor = colorSpec.id !== 'none'
  const agentWindowColorOpacity = useStore((state) => state.agentWindowColorOpacity)
  const statusPresentation = getAgentWindowStatusPresentation(agentWindow.status, {
    hasUnviewedCompletion: agentWindow.hasUnviewedCompletion,
  })
  const statusAccent = getAgentWindowStatusAccent(
    agentWindow.status,
    agentWindow.hasUnviewedCompletion,
  )
  const showUnreadDoneEdge =
    hasColor && agentWindow.status === 'idle' && Boolean(agentWindow.hasUnviewedCompletion)
  const showStatusEdge = hasColor && (agentWindow.status !== 'idle' || showUnreadDoneEdge)
  const animateStatusEdge = showStatusEdge && statusPresentation.dotClass.includes('animate-pulse')

  return (
    <div
      data-focused={isFocused ? 'true' : 'false'}
      className={cn(
        'agent-window-node group absolute overflow-hidden rounded-lg border bg-background/75 backdrop-blur-xl transition-[box-shadow,border-color,transform] duration-150',
        hasColor && 'border-[3px]',
        hasColor
          ? isFocused
            ? 'agent-window-color-frame agent-window-color-frame-focused'
            : 'agent-window-color-frame agent-window-color-frame-unfocused'
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
        ...(hasColor
          ? ({
              '--agent-window-accent': colorSpec.frameColor,
              '--agent-window-accent-opacity': `${agentWindowColorOpacity}%`,
              '--agent-window-status-accent': statusAccent,
            } as CSSProperties)
          : null),
      }}
      onMouseDown={handleNodeMouseDown}
    >
      {hasColor ? (
        <div
          aria-hidden
          className={cn(
            'agent-window-status-edge',
            showStatusEdge && !showUnreadDoneEdge && 'agent-window-status-edge-visible',
            animateStatusEdge && 'animate-agent-window-status-edge',
            showUnreadDoneEdge && 'agent-window-status-edge-done',
            showUnreadDoneEdge && 'animate-agent-window-status-done',
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
            <div className="flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12.5px] text-foreground/90">
              <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
                <GitBranch className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate">Worktrees</span>
              <WorktreeManager agentWindowId={agentWindow.id} compact side="right" align="start" />
            </div>
            <MenuItem
              icon={<ArrowUpRight className="size-3.5" />}
              label={agentWindow.pinned ? 'Pop back in' : 'Pop out to window'}
              onSelect={handleTogglePin}
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

      {agentWindow.pinned ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background/92 px-6 text-center">
          <div className="text-xs font-medium text-foreground/80">Popped out agent</div>
          <div className="max-w-52 text-[11px] leading-5 text-muted-foreground/60">
            {currentTitle}
          </div>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/70 px-2.5 py-1.5 text-[11px] text-foreground transition-colors hover:bg-muted/40"
            onClick={(event) => {
              event.stopPropagation()
              handleTogglePin()
            }}
          >
            <ArrowUpRight className="h-3 w-3 rotate-180" />
            Pop back in
          </button>
        </div>
      ) : (
        <div className="h-full bg-gradient-to-b from-background/30 to-background/55">
          <AgentChatPanel agentWindow={agentWindow} />
        </div>
      )}

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
