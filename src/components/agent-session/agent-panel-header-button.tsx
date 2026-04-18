import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

// Copied and adapted from Craft Agents OSS:
// ../craft-agents-oss/apps/electron/src/renderer/components/ui/PanelHeaderCenterButton.tsx

interface AgentPanelHeaderButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode
}

export const AgentPanelHeaderButton = forwardRef<HTMLButtonElement, AgentPanelHeaderButtonProps>(
  ({ icon, className, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          'panel-header-btn titlebar-no-drag inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground/80 transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {icon}
      </button>
    )
  },
)

AgentPanelHeaderButton.displayName = 'AgentPanelHeaderButton'
