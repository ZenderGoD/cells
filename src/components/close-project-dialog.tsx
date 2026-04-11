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

interface CloseProjectDialogProps {
  open: boolean
  projectName: string
  windowCount: number
  runningProcessLabels: string[]
  graceMs: number
  onConfirm: () => void
  onCancel: () => void
}

function formatGracePeriod(graceMs: number) {
  return `${Math.max(1, Math.round(graceMs / 1000))}s`
}

export function CloseProjectDialog({
  open,
  projectName,
  windowCount,
  runningProcessLabels,
  graceMs,
  onConfirm,
  onCancel,
}: CloseProjectDialogProps) {
  const hasRunningProcesses = runningProcessLabels.length > 0

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
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            hapticError()
            onConfirm()
          }
        }}
      >
        <DialogHeader>
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 rounded-md bg-amber-500/12 p-1.5 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="min-w-0 space-y-1.5">
              <DialogTitle>Close project?</DialogTitle>
              <DialogDescription className="text-xs leading-relaxed">
                <span className="font-medium text-foreground">{projectName}</span>
                {` will close ${windowCount === 1 ? '1 window' : `${windowCount} windows`}. `}
                {hasRunningProcesses
                  ? `Cells will keep the running services alive for ${formatGracePeriod(graceMs)} before shutting them down.`
                  : `Cells will keep the project restorable for ${formatGracePeriod(graceMs)} before removing it completely.`}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {hasRunningProcesses ? (
          <div className="space-y-2 rounded-lg border border-amber-500/15 bg-amber-500/6 p-3">
            <p className="text-[11px] font-medium text-foreground/85">Running services</p>
            <div className="flex flex-wrap gap-1.5">
              {runningProcessLabels.map((label) => (
                <span
                  key={label}
                  className="inline-flex items-center rounded-md border border-border/30 bg-background/60 px-2 py-1 text-[10px] text-muted-foreground/80"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        ) : null}

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
              onConfirm()
            }}
          >
            Close Project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
