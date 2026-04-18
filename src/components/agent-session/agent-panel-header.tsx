import { cn } from '@/lib/utils'

// Copied and adapted from Craft Agents OSS:
// ../craft-agents-oss/apps/electron/src/renderer/components/app-shell/PanelHeader.tsx

interface AgentPanelHeaderProps {
  title: React.ReactNode
  leading?: React.ReactNode
  status?: React.ReactNode
  actions?: React.ReactNode
  className?: string
  onMouseDown?: React.MouseEventHandler<HTMLDivElement>
}

export function AgentPanelHeader({
  title,
  leading,
  status,
  actions,
  className,
  onMouseDown,
}: AgentPanelHeaderProps) {
  return (
    <div
      className={cn(
        'relative flex h-[44px] shrink-0 items-center gap-2 border-b border-border/60 bg-background/60 pl-3 pr-1.5 backdrop-blur-xl',
        className,
      )}
      onMouseDown={onMouseDown}
    >
      {leading ? <div className="titlebar-no-drag shrink-0">{leading}</div> : null}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
        <div className="flex max-w-full items-center gap-2 overflow-hidden">
          <div className="min-w-0 truncate text-[13px] font-semibold leading-tight tracking-tight text-foreground/95">
            {title}
          </div>
          {status}
        </div>
      </div>
      {actions ? (
        <div className="titlebar-no-drag flex shrink-0 items-center gap-0.5">{actions}</div>
      ) : null}
    </div>
  )
}
