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
import { ArrowUpRight } from 'lucide-react'
import { hapticBuzz } from '@/lib/haptics'
import type { AgentWindowNode as AgentWindowNodeType } from '@/types'
import { AGENT_WINDOW_RELOAD_EVENT, type AgentWindowReloadEventDetail, useStore } from '@/lib/store'
import { useShallow } from 'zustand/react/shallow'
import { hasPrimaryModifier } from '@/lib/keyboard-shortcuts'
import { cn } from '@/lib/utils'
import { AgentChatPanel } from '@/components/agent-session/agent-chat-panel'
import { AgentOverviewPopover } from '@/components/agent-session/agent-overview-popover'
import { getAgentWindowColor } from '@/lib/agent-window-colors'
import { getAgentWindowStatusPresentation } from '@/lib/status-indicator'
import type { AgentWindowStatus } from '@/types'

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const MIN_W = 460
const MIN_H = 360
const HANDLE = 6
const EMPTY_SESSION_DIFF_STATS = { additions: 0, deletions: 0, changedFiles: 0 }
const noop = () => undefined

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
  showFocusRing: boolean
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
  showFocusRing,
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
  const [reloadKey, setReloadKey] = useState(0)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const z = agentWindow.zIndex ?? 1

  useEffect(() => {
    if (!isEditingTitle) return
    titleInputRef.current?.focus()
    titleInputRef.current?.select()
  }, [isEditingTitle])

  useEffect(() => {
    let active = true
    const handleReload = (event: Event) => {
      const detail = (event as CustomEvent<AgentWindowReloadEventDetail>).detail
      if (detail?.windowId !== agentWindow.id) return
      void (async () => {
        try {
          await window.cells.agentSession.close(agentWindow.id)
          await window.cells.agentSession.dispose(agentWindow.id)
        } catch (err) {
          console.error('[agent-window] reload failed', err)
        } finally {
          if (active) setReloadKey((key) => key + 1)
        }
      })()
    }

    window.addEventListener(AGENT_WINDOW_RELOAD_EVENT, handleReload)
    return () => {
      active = false
      window.removeEventListener(AGENT_WINDOW_RELOAD_EVENT, handleReload)
    }
  }, [agentWindow.id])

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

  const currentTitle = agentWindow.customTitle || agentWindow.title

  const handleClearConversation = async () => {
    try {
      // Fully dispose — throws away message history and session id so the next
      // ensure() starts a fresh conversation.
      await window.cells.agentSession.dispose(agentWindow.id)
      syncAgentWindow(agentWindow.id, {
        claudeSessionId: null,
        codexThreadId: null,
        cursorAgentId: null,
        cursorRunId: null,
        copilotSessionId: null,
        opencodeSessionId: null,
        agentBrowser: null,
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
  const focusRingStyle: CSSProperties | undefined =
    isFocused && showFocusRing
      ? {
          boxShadow: `0 0 0 ${Math.min(8, Math.max(2, Math.round(2 / Math.max(scale, 0.2))))}px var(--color-primary)`,
        }
      : undefined
  const chromeActions = {
    title: currentTitle,
    isPinned: Boolean(agentWindow.pinned),
    onRename: handleRename,
    onClearConversation: handleClearConversation,
    onCloseSession: handleClose,
    onTogglePin: handleTogglePin,
  }

  return (
    <div
      data-focused={isFocused ? 'true' : 'false'}
      className={cn(
        'agent-window-node group absolute overflow-hidden rounded-lg border bg-background/92 transition-[box-shadow,border-color,transform] duration-150',
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
        ...focusRingStyle,
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

      {agentWindow.pinned ? (
        <>
          <AgentOverviewPopover
            agentWindow={agentWindow}
            snapshot={null}
            messages={[]}
            sessionDiffStats={EMPTY_SESSION_DIFF_STATS}
            diffsPanelOpen={false}
            isWindowFocused={isFocused}
            chromeActions={chromeActions}
            onToggleDiffs={noop}
          />
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
        </>
      ) : (
        <div className="h-full bg-gradient-to-b from-background/30 to-background/55">
          <AgentChatPanel
            key={reloadKey}
            agentWindow={agentWindow}
            isWindowFocused={isFocused}
            chromeActions={chromeActions}
          />
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
