import { FileText, FolderOpen, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Project } from '@/types'
import { cn } from '@/lib/utils'
import { getFileNameFromPath } from '@/lib/text-editor'

interface OpenFileProjectDialogProps {
  open: boolean
  paths: string[]
  projects: Project[]
  onSelectProject: (projectId: string) => void
  onCancel: () => void
}

export function OpenFileProjectDialog({
  open,
  paths,
  projects,
  onSelectProject,
  onCancel,
}: OpenFileProjectDialogProps) {
  const fileCount = paths.length

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (!nextOpen ? onCancel() : undefined)}>
      <DialogContent className="max-w-md p-0" showCloseButton={false}>
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/70">
              <FileText className="size-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle>Open in project</DialogTitle>
              <DialogDescription className="mt-1">
                Choose where to place {fileCount === 1 ? 'this file' : `${fileCount} files`}.
              </DialogDescription>
            </div>
            <button
              type="button"
              onClick={onCancel}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Cancel"
            >
              <X className="size-4" />
            </button>
          </div>
        </DialogHeader>

        <div className="max-h-32 overflow-auto border-b border-border/50 px-4 py-2">
          {paths.slice(0, 6).map((filePath) => (
            <div key={filePath} className="flex items-center gap-2 py-1 text-xs">
              <FileText className="size-3.5 shrink-0 text-muted-foreground/50" />
              <span className="min-w-0 flex-1 truncate">{getFileNameFromPath(filePath)}</span>
            </div>
          ))}
          {paths.length > 6 ? (
            <div className="py-1 text-[11px] text-muted-foreground/55">{paths.length - 6} more</div>
          ) : null}
        </div>

        <div className="max-h-72 overflow-auto p-2">
          {projects.length > 0 ? (
            projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => onSelectProject(project.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors',
                  'hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:outline-none',
                )}
              >
                <FolderOpen className="size-4 shrink-0 text-muted-foreground/60" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-foreground">
                    {project.name}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground/55">
                    {project.path || 'No folder path'}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <div className="px-2 py-8 text-center text-xs text-muted-foreground/60">
              Create a project first, then open the file again.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
