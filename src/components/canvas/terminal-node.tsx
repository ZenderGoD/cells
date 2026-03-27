import { useState, useCallback, type MouseEvent } from 'react'
import { ArrowUpRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CellTerminal } from '../terminal/cell-terminal'
import { useStore } from '@/lib/store'
import type { TerminalNode as TerminalNodeType } from '@/types'
import { AgentIcon } from '@/components/agent-icon'
import { getStatusIndicator } from '@/lib/status-indicator'
import { inferAgentFromTitle } from '@/lib/agent-command'
import { Logo } from '@/components/logo'
import { WorktreeSwitcher } from '@/components/worktree-switcher'
import { useShallow } from 'zustand/react/shallow'
import { hapticBuzz, hapticNudge } from '@/lib/haptics'

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const MIN_W = 320
const MIN_H = 200
const HANDLE = 6 // px width of edge handles

interface TerminalNodeProps {
  terminal: TerminalNodeType
  scale: number
  selectionMode: boolean
  isSelected: boolean
  isFocused: boolean
  showFocusRing: boolean
  onDragStart: (id: string, kind: 'terminal' | 'browser', startX: number, startY: number) => void
}

export function TerminalNode({
  terminal,
  scale,
  selectionMode,
  isSelected,
  isFocused,
  showFocusRing,
  onDragStart,
}: TerminalNodeProps) {
  const {
    requestCloseWindow,
    resizeTerminal,
    moveTerminal,
    updateTerminalTitle,
    focusTerminal,
    togglePin,
  } = useStore(
    useShallow((s) => ({
      requestCloseWindow: s.requestCloseWindow,
      resizeTerminal: s.resizeTerminal,
      moveTerminal: s.moveTerminal,
      updateTerminalTitle: s.updateTerminalTitle,
      focusTerminal: s.focusTerminal,
      togglePin: s.togglePin,
    })),
  )
  const arrangeAnimating = useStore((s) => s.arrangeAnimating)
  const [isResizing, setIsResizing] = useState(false)
  const displayAgent = terminal.agent ?? inferAgentFromTitle(terminal.title)

  const handleDragMouseDown = useCallback(
    (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) return
      if (!selectionMode) {
        focusTerminal(terminal.id)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      onDragStart(terminal.id, 'terminal', e.clientX, e.clientY)
    },
    [focusTerminal, terminal.id, onDragStart, selectionMode],
  )

  const handleEdgeMouseDown = useCallback(
    (edge: Edge, e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsResizing(true)

      const startX = e.clientX
      const startY = e.clientY
      const startW = terminal.width
      const startH = terminal.height
      const startTx = terminal.x
      const startTy = terminal.y

      const movesLeft = edge.includes('w')
      const movesRight = edge.includes('e')
      const movesTop = edge.includes('n')
      const movesBottom = edge.includes('s')

      const handleMouseMove = (ev: globalThis.MouseEvent) => {
        const dx = (ev.clientX - startX) / scale
        const dy = (ev.clientY - startY) / scale

        let newW = startW
        let newH = startH
        let newX = startTx
        let newY = startTy

        if (movesRight) newW = Math.max(MIN_W, startW + dx)
        if (movesBottom) newH = Math.max(MIN_H, startH + dy)
        if (movesLeft) {
          newW = Math.max(MIN_W, startW - dx)
          newX = startTx + (startW - newW)
        }
        if (movesTop) {
          newH = Math.max(MIN_H, startH - dy)
          newY = startTy + (startH - newH)
        }

        resizeTerminal(terminal.id, newW, newH)
        if (movesLeft || movesTop) moveTerminal(terminal.id, newX, newY)
      }

      const handleMouseUp = () => {
        setIsResizing(false)
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [
      terminal.id,
      terminal.width,
      terminal.height,
      terminal.x,
      terminal.y,
      scale,
      resizeTerminal,
      moveTerminal,
    ],
  )

  const handleNodeMouseDown = useCallback(
    (e: MouseEvent) => {
      if (!selectionMode) {
        focusTerminal(terminal.id)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      onDragStart(terminal.id, 'terminal', e.clientX, e.clientY)
    },
    [focusTerminal, selectionMode, terminal.id, onDragStart],
  )

  const zBase = terminal.pinned ? 10000 : 0
  const z = zBase + (terminal.zIndex ?? 0)

  // Scale up ring widths when zoomed out so status borders remain visible
  const statusIndicator = getStatusIndicator(
    terminal.agentStatus,
    terminal.agent,
    terminal.processRunning,
  )
  const hasStatusRing = !isFocused && !isSelected && !!statusIndicator.ringClass
  let ringStyle: React.CSSProperties | undefined
  if (scale < 1) {
    if (isFocused && showFocusRing) {
      const w = Math.min(16, Math.round(4 / scale))
      ringStyle = { boxShadow: `0 0 0 ${w}px var(--color-primary)` }
    } else if (isSelected) {
      const w = Math.min(10, Math.round(2 / scale))
      ringStyle = {
        ['--tw-ring-shadow' as string]: `0 0 0 calc(${w}px + var(--tw-ring-offset-width, 0px)) var(--tw-ring-color, currentcolor)`,
      }
    } else if (hasStatusRing) {
      const w = Math.min(6, Math.round(1 / scale))
      ringStyle = {
        ['--tw-ring-shadow' as string]: `0 0 0 calc(${w}px + var(--tw-ring-offset-width, 0px)) var(--tw-ring-color, currentcolor)`,
      }
    }
  }

  return (
    <div
      data-term-id={terminal.id}
      className={cn(
        'terminal-node absolute',
        isResizing && 'pointer-events-none',
        selectionMode && 'cursor-grab',
      )}
      style={{
        left: terminal.x,
        top: terminal.y,
        width: terminal.width,
        height: terminal.height,
        zIndex: z,
        transition: arrangeAnimating
          ? 'left 300ms cubic-bezier(0.4, 0, 0.2, 1), top 300ms cubic-bezier(0.4, 0, 0.2, 1)'
          : undefined,
      }}
      onMouseDown={handleNodeMouseDown}
    >
      {selectionMode && <div className="absolute inset-0 z-10 cursor-grab" />}

      {/* Terminal container with focus ring + agent/process status border */}
      <div
        className={cn(
          'w-full h-full rounded-lg overflow-hidden transition-shadow duration-150',
          isFocused ? (showFocusRing ? 'terminal-focused' : 'opacity-100') : 'terminal-unfocused',
          isSelected && 'ring-2 ring-primary/70 ring-offset-1 ring-offset-background',
          !isFocused && !isSelected && statusIndicator.ringClass,
        )}
        style={ringStyle}
      >
        <CellTerminal
          termId={terminal.id}
          width={terminal.width}
          height={terminal.height}
          isFocused={isFocused}
          onTitleChange={(title) => updateTerminalTitle(terminal.id, title)}
        />

        {/* Title bar — top right, inside terminal */}
        <div
          className="absolute top-0 right-0 z-20 flex items-center cursor-grab active:cursor-grabbing select-none"
          onMouseDown={(e) => {
            e.preventDefault()
            handleDragMouseDown(e)
          }}
        >
          <div
            className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-bl-lg rounded-tr-[7px] transition-all',
              isFocused ? 'bg-card/70 opacity-100' : 'bg-card/40 opacity-0 hover:opacity-100',
            )}
          >
            {displayAgent ? (
              <AgentIcon agent={displayAgent} className="h-3 w-3" size={12} />
            ) : (
              <Logo className="h-3 w-3 text-primary/60 shrink-0" />
            )}
            <span className="text-[11px] font-medium truncate max-w-40 text-muted-foreground">
              {terminal.title}
            </span>
            <WorktreeSwitcher termId={terminal.id} />
            <button
              className="p-1 rounded-md transition-colors text-muted-foreground/40 hover:text-foreground hover:bg-muted/40"
              onClick={(e) => {
                e.stopPropagation()
                hapticBuzz()
                togglePin(terminal.id, 'terminal')
              }}
              title="Pop out to separate window"
            >
              <ArrowUpRight className="w-3 h-3" />
            </button>
            <button
              className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                hapticNudge()
                void requestCloseWindow({ id: terminal.id, type: 'terminal' })
              }}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {/* Resize handles — edges */}
      <div
        className="absolute z-30 cursor-n-resize"
        style={{ top: -HANDLE / 2, left: HANDLE, right: HANDLE, height: HANDLE }}
        onMouseDown={(e) => handleEdgeMouseDown('n', e)}
      />
      <div
        className="absolute z-30 cursor-s-resize"
        style={{ bottom: -HANDLE / 2, left: HANDLE, right: HANDLE, height: HANDLE }}
        onMouseDown={(e) => handleEdgeMouseDown('s', e)}
      />
      <div
        className="absolute z-30 cursor-w-resize"
        style={{ left: -HANDLE / 2, top: HANDLE, bottom: HANDLE, width: HANDLE }}
        onMouseDown={(e) => handleEdgeMouseDown('w', e)}
      />
      <div
        className="absolute z-30 cursor-e-resize"
        style={{ right: -HANDLE / 2, top: HANDLE, bottom: HANDLE, width: HANDLE }}
        onMouseDown={(e) => handleEdgeMouseDown('e', e)}
      />

      {/* Resize handles — corners */}
      <div
        className="absolute z-30 cursor-nw-resize"
        style={{ top: -HANDLE / 2, left: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 }}
        onMouseDown={(e) => handleEdgeMouseDown('nw', e)}
      />
      <div
        className="absolute z-30 cursor-ne-resize"
        style={{ top: -HANDLE / 2, right: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 }}
        onMouseDown={(e) => handleEdgeMouseDown('ne', e)}
      />
      <div
        className="absolute z-30 cursor-sw-resize"
        style={{ bottom: -HANDLE / 2, left: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 }}
        onMouseDown={(e) => handleEdgeMouseDown('sw', e)}
      />
      <div
        className="absolute z-30 cursor-se-resize"
        style={{ bottom: -HANDLE / 2, right: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 }}
        onMouseDown={(e) => handleEdgeMouseDown('se', e)}
      />
    </div>
  )
}
