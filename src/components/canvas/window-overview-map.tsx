import { useCallback, useRef } from 'react'
import { FileText, Globe, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getCanvasBounds, type CanvasRect, type CanvasWindow } from '@/lib/canvas-navigation'
import { AgentIcon } from '@/components/agent-icon'
import { getAgentWindowStatusPresentation, getStatusPresentation } from '@/lib/status-indicator'
import { getAgentWindowColor } from '@/lib/agent-window-colors'
import type { WindowSection } from '@/types'

interface WindowOverviewMapProps {
  windows: CanvasWindow[]
  sections?: WindowSection[]
  currentId?: string | null
  focusedId?: string | null
  viewport?: CanvasRect
  width: number
  height: number
  className?: string
  onSelect?: (window: CanvasWindow) => void
  onMove?: (window: CanvasWindow, x: number, y: number) => void
}

function WindowIcon({ window, iconSize }: { window: CanvasWindow; iconSize: number }) {
  if (window.type === 'browser') {
    if (window.faviconUrl) {
      return (
        <img
          src={window.faviconUrl}
          alt=""
          className="pointer-events-none rounded-[1px] object-contain"
          style={{ width: iconSize, height: iconSize }}
        />
      )
    }
    return (
      <Globe
        className="pointer-events-none opacity-80"
        style={{ width: iconSize, height: iconSize }}
      />
    )
  }

  if (window.type === 'editor') {
    return (
      <FileText
        className="pointer-events-none opacity-80"
        style={{ width: iconSize, height: iconSize }}
      />
    )
  }

  // Agent window OR terminal with agent — use the same branded icon.
  if (window.agent) {
    return <AgentIcon agent={window.agent} className="pointer-events-none" size={iconSize} />
  }

  return (
    <TerminalSquare
      className="pointer-events-none opacity-80"
      style={{ width: iconSize, height: iconSize }}
    />
  )
}

const DRAG_THRESHOLD = 3

const SECTION_COLOR_CLASSES: Record<
  NonNullable<WindowSection['color']>,
  { border: string; fill: string }
> = {
  slate: { border: 'border-slate-300/75', fill: 'bg-slate-400/16' },
  blue: { border: 'border-sky-300/85', fill: 'bg-sky-400/18' },
  green: { border: 'border-emerald-300/80', fill: 'bg-emerald-400/18' },
  amber: { border: 'border-amber-300/85', fill: 'bg-amber-400/18' },
  rose: { border: 'border-rose-300/80', fill: 'bg-rose-400/18' },
  violet: { border: 'border-violet-300/80', fill: 'bg-violet-400/18' },
}

export function WindowOverviewMap({
  windows,
  sections = [],
  currentId = null,
  focusedId = null,
  viewport,
  width,
  height,
  className,
  onSelect,
  onMove,
}: WindowOverviewMapProps) {
  const sectionRects = sections.map((section) => ({
    x: section.x,
    y: section.y,
    width: section.width ?? viewport?.width ?? 800,
    height: section.height ?? viewport?.height ?? 500,
  }))
  const bounds = getCanvasBounds(
    viewport ? [viewport, ...sectionRects, ...windows] : [...sectionRects, ...windows],
  )
  const dragRef = useRef<{
    windowId: string
    startX: number
    startY: number
    originX: number
    originY: number
    dragging: boolean
  } | null>(null)

  const resolvedBounds = bounds ?? { x: 0, y: 0, width: 1, height: 1 }

  const availableWidth = width - 4
  const availableHeight = height - 4
  const scale = Math.min(
    availableWidth / Math.max(resolvedBounds.width, 1),
    availableHeight / Math.max(resolvedBounds.height, 1),
  )
  const contentWidth = resolvedBounds.width * scale
  const contentHeight = resolvedBounds.height * scale
  const offsetX = (width - contentWidth) / 2
  const offsetY = (height - contentHeight) / 2

  const renderRect = (rect: Pick<CanvasRect, 'x' | 'y' | 'width' | 'height'>) => {
    const scaledWidth = rect.width * scale
    const scaledHeight = rect.height * scale
    // Enforce minimum size but preserve aspect ratio
    const minSize = 4
    const upscale = Math.max(
      1,
      minSize / Math.max(scaledWidth, 1),
      minSize / Math.max(scaledHeight, 1),
    )
    const renderedWidth = scaledWidth * upscale
    const renderedHeight = scaledHeight * upscale

    return {
      left: Math.max(
        0,
        Math.min(
          width - renderedWidth,
          offsetX + (rect.x - resolvedBounds.x) * scale - (renderedWidth - scaledWidth) / 2,
        ),
      ),
      top: Math.max(
        0,
        Math.min(
          height - renderedHeight,
          offsetY + (rect.y - resolvedBounds.y) * scale - (renderedHeight - scaledHeight) / 2,
        ),
      ),
      width: renderedWidth,
      height: renderedHeight,
    }
  }

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, win: CanvasWindow) => {
      if (!onMove) return
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = {
        windowId: win.id,
        startX: e.clientX,
        startY: e.clientY,
        originX: win.x,
        originY: win.y,
        dragging: false,
      }
    },
    [onMove],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent, win: CanvasWindow) => {
      const drag = dragRef.current
      if (!drag || drag.windowId !== win.id || !onMove) return

      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY

      if (!drag.dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
        drag.dragging = true
      }

      const canvasDx = dx / scale
      const canvasDy = dy / scale
      onMove(win, drag.originX + canvasDx, drag.originY + canvasDy)
    },
    [onMove, scale],
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent, win: CanvasWindow) => {
      const drag = dragRef.current
      dragRef.current = null
      if (!drag || drag.windowId !== win.id) return

      // If it wasn't a drag, treat it as a click/select
      if (!drag.dragging && onSelect) {
        onSelect(win)
      }
    },
    [onSelect],
  )

  if (!bounds) return null

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-none border border-border/50 bg-background/80',
        className,
      )}
      style={{ width, height }}
      onDragStart={onMove ? (e) => e.preventDefault() : undefined}
    >
      {viewport && (
        <div
          className="pointer-events-none absolute rounded-none border border-foreground/28 bg-foreground/[0.05] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]"
          style={renderRect(viewport)}
        />
      )}

      {sections.map((section) => {
        const color = SECTION_COLOR_CLASSES[section.color ?? 'blue']
        return (
          <div
            key={section.id}
            className={cn(
              'pointer-events-none absolute rounded-none border-2 border-dashed shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]',
              color.border,
              color.fill,
            )}
            style={renderRect({
              x: section.x,
              y: section.y,
              width: section.width ?? viewport?.width ?? 800,
              height: section.height ?? viewport?.height ?? 500,
            })}
            title={section.name}
          />
        )
      })}

      {[...windows]
        .sort((a, b) => a.zIndex - b.zIndex)
        .map((window) => {
          const isCurrent = currentId === window.id
          const isFocused = focusedId === window.id
          const rectStyle = renderRect(window)
          const minDim = Math.min(rectStyle.width, rectStyle.height)
          const canShowIcon = minDim >= 8
          const iconSize = Math.max(6, Math.min(minDim * 0.55, 14))
          const canDrag = !!onMove
          const runtimeStatus = getStatusPresentation(window.runtimeStatus, { agent: window.agent })
          const agentWindowStatus =
            window.type === 'agent'
              ? getAgentWindowStatusPresentation(window.agentWindowStatus, {
                  hasUnviewedCompletion: window.hasUnviewedCompletion,
                })
              : null
          const isAgent = window.type === 'agent'
          const agentColor = isAgent ? getAgentWindowColor(window.color) : null
          const hasAgentColor = !!agentColor && agentColor.id !== 'none'
          const statusClass = isAgent
            ? (agentWindowStatus?.ringClass ?? '')
            : runtimeStatus.ringClass
          // Agent windows use a dock-style bottom pill instead of a corner dot;
          // terminal/browser windows keep the classic corner dot.
          const indicatorDotClass = isAgent
            ? ''
            : window.type === 'editor' && window.isDirty
              ? 'bg-primary/80'
              : runtimeStatus.dotClass
          const agentPillClass = isAgent ? (agentWindowStatus?.dotClass ?? '') : ''
          const statusTitle = agentWindowStatus?.label || runtimeStatus.detail
          const statusDotClass = minDim >= 14 ? 'size-2' : 'size-1.5'
          const agentPillHeight = minDim >= 20 ? 'h-[2px]' : 'h-px'
          const agentPillWidth = minDim >= 20 ? 'w-3' : 'w-2'
          // Top accent bar (agent color). Skips on the smallest rectangles
          // where a 2px bar starts crowding the icon — border tint still
          // carries the signal there.
          const canShowColorBar = hasAgentColor && minDim >= 10
          // When the rectangle is current (inverted, filled), its own
          // foreground fill sits over the top border; hide the color bar to
          // avoid a muddy overlap with the inverted chrome.
          const showColorBar = canShowColorBar && !isCurrent
          // Swap the default neutral border for the agent's color tint when
          // the rectangle isn't already visually claimed by current/focused
          // chrome. Mirrors the real window's focused/unfocused border tint.
          const colorBorderOverride =
            hasAgentColor && !isCurrent && !isFocused
              ? agentColor.unfocusedBorderClass
              : hasAgentColor && isFocused && !isCurrent
                ? agentColor.focusedBorderClass
                : ''
          const sharedClassName = cn(
            'absolute flex items-center justify-center border transition-[transform,background-color,border-color,opacity,box-shadow] duration-150',
            (onSelect || canDrag) && 'hover:scale-[1.04]',
            canDrag && 'cursor-grab active:cursor-grabbing',
            window.type === 'browser'
              ? 'rounded-none border-white/24 bg-white/14 text-foreground/55'
              : window.type === 'editor'
                ? 'rounded-none border-primary/26 bg-primary/12 text-foreground/55'
                : 'rounded-none border-white/16 bg-white/8 text-foreground/45',
            isCurrent
              ? 'z-10 border-foreground bg-foreground text-background shadow-[0_0_0_2px_rgba(255,255,255,0.3),0_10px_22px_rgba(0,0,0,0.24)]'
              : isFocused
                ? 'z-[9] border-white/70 bg-white/16 shadow-[0_0_0_1px_rgba(255,255,255,0.12)]'
                : 'hover:border-foreground/45',
            colorBorderOverride,
            statusClass,
          )
          const colorBar = showColorBar ? (
            <span
              className={cn(
                'pointer-events-none absolute top-[2px] left-1/2 -translate-x-1/2 rounded-full',
                minDim >= 14 ? 'h-[2px] w-[60%]' : 'h-px w-[55%]',
                agentColor.accentBarClass,
              )}
            />
          ) : null

          if (onSelect || canDrag) {
            return (
              <button
                key={window.id}
                className={sharedClassName}
                style={rectStyle}
                onClick={!canDrag && onSelect ? () => onSelect(window) : undefined}
                onPointerDown={canDrag ? (e) => handlePointerDown(e, window) : undefined}
                onPointerMove={canDrag ? (e) => handlePointerMove(e, window) : undefined}
                onPointerUp={canDrag ? (e) => handlePointerUp(e, window) : undefined}
                title={`${window.type === 'browser' ? 'Browser' : window.type === 'editor' ? 'Editor' : window.agent ? `Agent (${window.agent})` : 'Terminal'}: ${window.title}${hasAgentColor ? ` · ${agentColor.label}` : ''}${statusTitle ? ` — ${statusTitle}` : ''}`}
              >
                {canShowIcon && <WindowIcon window={window} iconSize={iconSize} />}
                {colorBar}
                {indicatorDotClass ? (
                  <span
                    className={cn(
                      'pointer-events-none absolute right-0.5 top-0.5 rounded-full shadow-[0_0_0_1px_rgba(0,0,0,0.22)]',
                      statusDotClass,
                      indicatorDotClass,
                    )}
                  />
                ) : null}
                {agentPillClass ? (
                  <span
                    className={cn(
                      'pointer-events-none absolute bottom-[2px] left-1/2 -translate-x-1/2 rounded-full',
                      agentPillHeight,
                      agentPillWidth,
                      agentPillClass,
                    )}
                  />
                ) : null}
                {isFocused && !isCurrent && (
                  <span
                    className={cn(
                      'pointer-events-none absolute left-1/2 top-[2px] -translate-x-1/2 rounded-full bg-white/90',
                      agentPillHeight,
                      agentPillWidth,
                    )}
                  />
                )}
              </button>
            )
          }

          return (
            <div key={window.id} className={sharedClassName} style={rectStyle}>
              {canShowIcon && <WindowIcon window={window} iconSize={iconSize} />}
              {colorBar}
              {indicatorDotClass ? (
                <span
                  className={cn(
                    'pointer-events-none absolute right-0.5 top-0.5 rounded-full shadow-[0_0_0_1px_rgba(0,0,0,0.22)]',
                    statusDotClass,
                    indicatorDotClass,
                  )}
                />
              ) : null}
              {agentPillClass ? (
                <span
                  className={cn(
                    'pointer-events-none absolute bottom-[2px] left-1/2 -translate-x-1/2 rounded-full',
                    agentPillHeight,
                    agentPillWidth,
                    agentPillClass,
                  )}
                />
              ) : null}
              {isFocused && !isCurrent && (
                <span className="pointer-events-none absolute bottom-0.5 right-0.5 size-1 rounded-full bg-white/90" />
              )}
            </div>
          )
        })}
    </div>
  )
}
