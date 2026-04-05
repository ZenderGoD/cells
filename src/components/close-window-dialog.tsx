import { useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { hapticError, hapticNudge } from '@/lib/haptics'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface CloseWindowDialogProps {
  open: boolean
  windowTitle: string
  processLabel: string
  undoTimeoutMs: number
  onConfirm: (skipFuturePrompts: boolean) => void
  onCancel: () => void
}

function formatUndoTimeout(timeoutMs: number) {
  if (timeoutMs <= 0) return 'This close will terminate the process immediately.'
  const seconds = Math.round(timeoutMs / 1000)
  return `Cells will hide this window first and keep it restorable for ${seconds}s with Cmd+Shift+T.`
}

export function CloseWindowDialog({
  open,
  windowTitle,
  processLabel,
  undoTimeoutMs,
  onConfirm,
  onCancel,
}: CloseWindowDialogProps) {
  const skipFuturePromptsRef = useRef<HTMLInputElement>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) hapticError()
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent
        className="max-w-md"
        showCloseButton={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            hapticError()
            onConfirm(skipFuturePromptsRef.current?.checked ?? false)
          }
        }}
      >
        <DialogHeader>
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 rounded-md bg-amber-500/12 p-1.5 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="min-w-0 space-y-1.5">
              <DialogTitle>Close running window?</DialogTitle>
              <DialogDescription className="text-xs leading-relaxed">
                <span className="font-medium text-foreground">{processLabel}</span>
                {' is still running in '}
                <span className="font-medium text-foreground">
                  {windowTitle || 'this window'}
                </span>. {formatUndoTimeout(undoTimeoutMs)}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <label className="flex items-center gap-2 rounded-md px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground cursor-pointer">
          <input
            ref={skipFuturePromptsRef}
            type="checkbox"
            defaultChecked={false}
            className="h-3.5 w-3.5 rounded border-border/50 bg-background/70 accent-primary"
          />
          <span>Don&apos;t ask again for {processLabel}</span>
        </label>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              hapticNudge()
              onCancel()
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              hapticError()
              onConfirm(skipFuturePromptsRef.current?.checked ?? false)
            }}
          >
            Close Window
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
