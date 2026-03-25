import * as React from 'react'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import { cn } from '@/lib/utils'

const ScrollArea = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    viewportClassName?: string
  }
>(({ className, children, viewportClassName, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    data-slot="scroll-area"
    className={cn('relative overflow-hidden', className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      data-slot="scroll-area-viewport"
      className={cn('size-full rounded-[inherit]', viewportClassName)}
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar orientation="vertical" />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
))
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName

const ScrollBar = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    data-slot="scroll-area-scrollbar"
    className={cn(
      'data-[state=visible]:fade-in-0 data-[state=hidden]:fade-out-0 data-[state=visible]:animate-in data-[state=hidden]:animate-out z-50 flex touch-none p-px transition-opacity duration-150 select-none',
      orientation === 'vertical' && 'h-full w-1.5 border-l border-l-transparent',
      orientation === 'horizontal' && 'h-1.5 flex-col border-t border-t-transparent',
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb
      data-slot="scroll-area-thumb"
      className="bg-foreground/10 hover:bg-foreground/15 relative flex-1 rounded-full transition-colors"
    />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
))
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName

export { ScrollArea, ScrollBar }
