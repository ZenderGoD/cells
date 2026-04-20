import { useMemo, useState } from 'react'
import { ChevronRight, FileText, X } from 'lucide-react'
import type { AgentSessionMessage } from '@/types'
import { cn } from '@/lib/utils'
import { groupDiffsByFile, type FileDiffStats } from '@/lib/tool-diff-stats'
import { ScrollArea } from '@/components/ui/scroll-area'

interface SessionDiffsPanelProps {
  messages: AgentSessionMessage[]
  onClose: () => void
}

function baseName(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function SessionDiffsPanel({ messages, onClose }: SessionDiffsPanelProps) {
  const files = useMemo(() => groupDiffsByFile(messages), [messages])
  const totalAdditions = files.reduce((acc, f) => acc + f.additions, 0)
  const totalDeletions = files.reduce((acc, f) => acc + f.deletions, 0)

  return (
    <div className="flex h-full w-[420px] flex-col border-l border-border/40 bg-background/95 backdrop-blur-sm">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3 py-2">
        <FileText className="size-3.5 shrink-0 text-muted-foreground/80" />
        <span className="flex-1 text-[12px] font-medium uppercase tracking-[0.12em] text-foreground/80">
          Session diffs
        </span>
        <span className="shrink-0 text-[11px] tabular-nums">
          {totalAdditions > 0 ? (
            <span className="text-emerald-400/90">+{totalAdditions}</span>
          ) : null}
          {totalAdditions > 0 && totalDeletions > 0 ? ' ' : ''}
          {totalDeletions > 0 ? <span className="text-rose-400/90">-{totalDeletions}</span> : null}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-[6px] p-1 text-muted-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
          aria-label="Close diffs panel"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <ScrollArea className="flex-1">
        {files.length === 0 ? (
          <div className="px-4 py-6 text-[12px] text-muted-foreground/70">
            No file edits in this session yet.
          </div>
        ) : (
          <ul className="flex flex-col py-1">
            {files.map((file) => (
              <FileDiffRow key={file.filePath} file={file} />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}

function FileDiffRow({ file }: { file: FileDiffStats }) {
  const [expanded, setExpanded] = useState(false)
  const name = baseName(file.filePath)
  const dir = file.filePath.slice(0, Math.max(0, file.filePath.length - name.length - 1))
  return (
    <li className="border-b border-border/20 last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-foreground/5"
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground/50 transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <span
          className="min-w-0 flex-1 truncate text-[12px] text-foreground/90"
          title={file.filePath}
        >
          <span className="font-medium">{name}</span>
          {dir ? <span className="ml-1 text-muted-foreground/60">{dir}</span> : null}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums">
          {file.additions > 0 ? (
            <span className="text-emerald-400/90">+{file.additions}</span>
          ) : null}
          {file.additions > 0 && file.deletions > 0 ? ' ' : ''}
          {file.deletions > 0 ? <span className="text-rose-400/90">-{file.deletions}</span> : null}
        </span>
      </button>
      {expanded ? (
        <div className="px-3 pb-2">
          {file.edits.map((edit, idx) => (
            <div
              key={`${edit.toolId}-${idx}`}
              className="mb-1.5 overflow-hidden rounded-[6px] border border-border/40 bg-background/60 text-[11px] leading-[1.45] last:mb-0"
            >
              {edit.oldString ? (
                <pre className="whitespace-pre-wrap break-words border-l-2 border-rose-400/60 bg-rose-500/5 px-2 py-1 font-mono text-rose-200/90">
                  {edit.oldString}
                </pre>
              ) : null}
              {edit.newString ? (
                <pre className="whitespace-pre-wrap break-words border-l-2 border-emerald-400/60 bg-emerald-500/5 px-2 py-1 font-mono text-emerald-200/90">
                  {edit.newString}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </li>
  )
}
