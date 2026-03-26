'use client'

import * as React from 'react'
import { Command as CommandPrimitive } from 'cmdk'

import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group'
import { SearchIcon, CheckIcon } from 'lucide-react'

// Track whether the last Enter-selection was performed with Cmd held
let _lastSelectMetaKey = false
export function wasLastSelectWithMeta(): boolean {
  const v = _lastSelectMetaKey
  _lastSelectMetaKey = false
  return v
}

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex size-full flex-col overflow-hidden rounded-xl! bg-popover p-1 text-popover-foreground',
        className,
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title = 'Command Palette',
  description = 'Search for a command to run...',
  children,
  className,
  showCloseButton = false,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, 'children'> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  children: React.ReactNode
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn('top-1/3 translate-y-0 overflow-hidden rounded-xl! p-0', className)}
        showCloseButton={showCloseButton}
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  multiline,
  icon,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  multiline?: boolean
  icon?: React.ReactNode
}) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea to fit content
  React.useEffect(() => {
    if (multiline && textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'
    }
  }, [multiline, props.value])

  // Auto-focus textarea when mounted
  React.useEffect(() => {
    if (multiline && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [multiline])

  const addonIcon = icon ?? <SearchIcon className="size-4 shrink-0 opacity-50" />

  if (!multiline) {
    return (
      <div data-slot="command-input-wrapper" className="p-1 pb-0">
        <InputGroup className="h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
          <CommandPrimitive.Input
            data-slot="command-input"
            className={cn(
              'w-full text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
              className,
            )}
            {...props}
          />
          <InputGroupAddon>{addonIcon}</InputGroupAddon>
        </InputGroup>
      </div>
    )
  }

  const { value, onValueChange, onKeyDown, placeholder } = props

  return (
    <div data-slot="command-input-wrapper" className="p-1 pb-0">
      {/* Hidden cmdk input to drive search/filter */}
      <CommandPrimitive.Input
        value={value}
        onValueChange={onValueChange}
        className="sr-only absolute"
        tabIndex={-1}
        aria-hidden
      />
      <InputGroup className="h-auto! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2! *:data-[slot=input-group-addon]:pr-0! *:data-[slot=input-group-addon]:pt-[7px]!">
        <textarea
          ref={textareaRef}
          data-slot="command-input"
          className={cn(
            'w-full text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50 resize-none bg-transparent py-1.5 pl-1.5 min-h-[32px] max-h-[120px] overflow-y-auto',
            className,
          )}
          value={(value as string) ?? ''}
          onChange={(e) => onValueChange?.(e.target.value)}
          placeholder={placeholder}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.altKey) {
              // Option+Enter: insert newline (textarea doesn't do this natively)
              e.preventDefault()
              const ta = textareaRef.current
              if (ta) {
                const start = ta.selectionStart
                const end = ta.selectionEnd
                const val = (value as string) ?? ''
                onValueChange?.(val.slice(0, start) + '\n' + val.slice(end))
                requestAnimationFrame(() => {
                  ta.selectionStart = ta.selectionEnd = start + 1
                })
              }
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              _lastSelectMetaKey = e.metaKey
              // Find and click the selected cmdk item, or let parent handle fallback
              const root = (e.target as HTMLElement).closest('[cmdk-root]')
              const selected = root?.querySelector(
                '[cmdk-item][data-selected="true"]',
              ) as HTMLElement
              if (selected) {
                selected.click()
              } else {
                onKeyDown?.(e as any)
              }
            } else if (e.key === 'Backspace' && !(value as string)?.length) {
              // Empty input + backspace → forward to parent (e.g. remove attachment)
              onKeyDown?.(e as any)
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              // Forward arrow keys to cmdk for item navigation
              e.preventDefault()
              const root = (e.target as HTMLElement).closest('[cmdk-root]')
              const hiddenInput = root?.querySelector('input[cmdk-input]') as HTMLInputElement
              if (hiddenInput) {
                hiddenInput.dispatchEvent(
                  new KeyboardEvent('keydown', {
                    key: e.key,
                    bubbles: true,
                    cancelable: true,
                  }),
                )
              }
            }
          }}
        />
        <InputGroupAddon>{addonIcon}</InputGroupAddon>
      </InputGroup>
    </div>
  )
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        'no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none',
        className,
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn('py-6 text-center text-sm', className)}
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('-mx-1 h-px bg-border', className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none in-data-[slot=dialog-content]:rounded-lg! data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-selected:bg-muted data-selected:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-selected:*:[svg]:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        'ml-auto text-xs tracking-widest text-muted-foreground group-data-selected/command-item:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
