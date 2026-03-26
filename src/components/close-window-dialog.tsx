import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
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
  const [skipFuturePrompts, setSkipFuturePrompts] = useState(false)

  useEffect(() => {
    if (open) setSkipFuturePrompts(false)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
      <DialogContent className="max-w-md gap-3 p-0" showCloseButton={false}>
        <DialogHeader className="border-b border-border/30 px-4 py-3">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 rounded-md bg-amber-500/12 p-1.5 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 space-y-1">
              <DialogTitle className="text-sm">Close running window?</DialogTitle>
              <DialogDescription className="text-[11px] leading-5 text-muted-foreground/70">
                <span className="font-medium text-foreground">{processLabel}</span>
                {' is still running in '}
                <span className="font-medium text-foreground">{windowTitle || 'this window'}</span>.{' '}
                {formatUndoTimeout(undoTimeoutMs)}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="px-4 pb-1">
          <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground">
            <input
              type="checkbox"
              checked={skipFuturePrompts}
              onChange={(event) => setSkipFuturePrompts(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-border/50 bg-background/70"
            />
            <span>Don&apos;t ask again for {processLabel}</span>
          </label>
        </div>

        <DialogFooter className="bg-muted/35 px-4 py-3">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={() => onConfirm(skipFuturePrompts)}>
            Close Window
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
