import { Globe, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getCanvasBounds, type CanvasRect, type CanvasWindow } from '@/lib/canvas-navigation'
import { AgentIcon } from '@/components/agent-icon'

interface WindowOverviewMapProps {
  windows: CanvasWindow[]
  currentId?: string | null
  focusedId?: string | null
  viewport?: CanvasRect
  width: number
  height: number
  className?: string
  onSelect?: (window: CanvasWindow) => void
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

  // Terminal with agent — use the same branded icon as terminal window tabs
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

export function WindowOverviewMap({
  windows,
  currentId = null,
  focusedId = null,
  viewport,
  width,
  height,
  className,
  onSelect,
}: WindowOverviewMapProps) {
  const bounds = getCanvasBounds(viewport ? [viewport, ...windows] : windows)
  if (!bounds) return null

  const availableWidth = width - 4
  const availableHeight = height - 4
  const scale = Math.min(
    availableWidth / Math.max(bounds.width, 1),
    availableHeight / Math.max(bounds.height, 1),
  )
  const contentWidth = bounds.width * scale
  const contentHeight = bounds.height * scale
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
          offsetX + (rect.x - bounds.x) * scale - (renderedWidth - scaledWidth) / 2,
        ),
      ),
      top: Math.max(
        0,
        Math.min(
          height - renderedHeight,
          offsetY + (rect.y - bounds.y) * scale - (renderedHeight - scaledHeight) / 2,
        ),
      ),
      width: renderedWidth,
      height: renderedHeight,
    }
  }

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-[8px] border border-border/50 bg-background/80',
        className,
      )}
      style={{ width, height }}
    >
      {viewport && (
        <div
          className="pointer-events-none absolute rounded-[6px] border border-foreground/28 bg-foreground/[0.05] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]"
          style={renderRect(viewport)}
        />
      )}

      {[...windows]
        .sort((a, b) => a.zIndex - b.zIndex)
        .map((window) => {
          const isCurrent = currentId === window.id
          const isFocused = focusedId === window.id
          const rectStyle = renderRect(window)
          const minDim = Math.min(rectStyle.width, rectStyle.height)
          const canShowIcon = minDim >= 8
          const iconSize = Math.max(6, Math.min(minDim * 0.55, 14))
          const sharedClassName = cn(
            'absolute flex items-center justify-center border transition-[transform,background-color,border-color,opacity,box-shadow] duration-150',
            onSelect && 'hover:scale-[1.04]',
            window.type === 'browser'
              ? 'rounded-[4px] border-white/24 bg-white/14 text-foreground/55'
              : 'rounded-[3px] border-white/16 bg-white/8 text-foreground/45',
            isCurrent
              ? 'z-10 border-foreground/90 bg-foreground/20 text-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.16),0_10px_22px_rgba(0,0,0,0.24)]'
              : isFocused
                ? 'z-[9] border-white/70 bg-white/16 shadow-[0_0_0_1px_rgba(255,255,255,0.12)]'
                : 'hover:border-foreground/45',
          )

          if (onSelect) {
            return (
              <button
                key={window.id}
                className={sharedClassName}
                style={rectStyle}
                onClick={() => onSelect(window)}
                title={`${window.type === 'browser' ? 'Browser' : window.agent ? `Agent (${window.agent})` : 'Terminal'}: ${window.title}`}
              >
                {canShowIcon && <WindowIcon window={window} iconSize={iconSize} />}
                {window.agent && (
                  <span className="pointer-events-none absolute top-0 right-0 size-1.5 rounded-full bg-primary/90 animate-pulse" />
                )}
                {isFocused && !isCurrent && (
                  <span className="pointer-events-none absolute bottom-0.5 right-0.5 size-1 rounded-full bg-white/90" />
                )}
              </button>
            )
          }

          return (
            <div key={window.id} className={sharedClassName} style={rectStyle}>
              {canShowIcon && <WindowIcon window={window} iconSize={iconSize} />}
              {window.agent && (
                <span className="pointer-events-none absolute top-0 right-0 size-1.5 rounded-full bg-primary/90 animate-pulse" />
              )}
              {isFocused && !isCurrent && (
                <span className="pointer-events-none absolute bottom-0.5 right-0.5 size-1 rounded-full bg-white/90" />
              )}
            </div>
          )
        })}
    </div>
  )
}
