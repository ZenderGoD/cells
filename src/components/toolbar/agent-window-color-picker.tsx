import { useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  AGENT_WINDOW_COLORS,
  getAgentWindowColor,
  type AgentWindowColorId,
} from '@/lib/agent-window-colors'
import { hapticBuzz } from '@/lib/haptics'

interface AgentWindowColorPickerProps {
  agentWindowId: string
  currentColor: AgentWindowColorId | null | undefined
}

export function AgentWindowColorPicker({
  agentWindowId,
  currentColor,
}: AgentWindowColorPickerProps) {
  const [open, setOpen] = useState(false)
  const setOverlayOpen = useStore((s) => s.setOverlayOpen)
  const syncAgentWindow = useStore((s) => s.syncAgentWindow)
  const active = getAgentWindowColor(currentColor)
  const hasColor = active.id !== 'none'

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setOverlayOpen(`agent-window-color-picker:${agentWindowId}`, next)
      }}
    >
      <PopoverTrigger
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:bg-muted/40 hover:text-foreground"
        title="Color-code window"
      >
        {hasColor ? (
          <span
            className={cn(
              'size-2.5 rounded-full ring-1 ring-inset ring-foreground/10',
              active.swatchClass,
            )}
          />
        ) : (
          <span className="size-2.5 rounded-full border border-dashed border-muted-foreground/50" />
        )}
      </PopoverTrigger>
      <PopoverContent side="top" sideOffset={8} className="w-44 p-1">
        <div className="px-2 pt-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
          Window color
        </div>
        <div className="grid grid-cols-4 gap-1 p-1">
          {AGENT_WINDOW_COLORS.map((color) => {
            const selected = color.id === active.id
            const isNone = color.id === 'none'
            return (
              <button
                key={color.id}
                type="button"
                onClick={() => {
                  hapticBuzz()
                  syncAgentWindow(agentWindowId, {
                    color: color.id === 'none' ? null : color.id,
                  })
                  setOpen(false)
                }}
                className={cn(
                  'group relative flex size-7 items-center justify-center rounded-md transition-colors hover:bg-muted/60',
                  selected && 'bg-muted/60',
                )}
                title={color.label}
              >
                {isNone ? (
                  <span className="size-3.5 rounded-full border border-dashed border-muted-foreground/60" />
                ) : (
                  <span
                    className={cn(
                      'size-3.5 rounded-full ring-1 ring-inset ring-foreground/10',
                      color.swatchClass,
                    )}
                  />
                )}
                {selected ? (
                  <Check className="pointer-events-none absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-background p-[1px] text-foreground shadow-sm" />
                ) : null}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
