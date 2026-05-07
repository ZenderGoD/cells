import { Suspense, lazy, useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { ChevronRight, FileText, Pencil, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { AgentSessionMessage } from '@/types'
import { cn } from '@/lib/utils'
import { groupDiffsByFile, type FileDiffStats } from '@/lib/tool-diff-stats'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useStore } from '@/lib/store'

// ease-out-quart — smoother tail for height-based expand/collapse.
const EASE_EXPAND: [number, number, number, number] = [0.22, 1, 0.36, 1]
const EXPAND_TRANSITION = {
  height: { duration: 0.28, ease: EASE_EXPAND },
  opacity: { duration: 0.18, ease: EASE_EXPAND },
} as const
const LazyPierreFileDiffPreview = lazy(() =>
  import('./session-diffs-viewer').then((module) => ({
    default: module.PierreFileDiffPreview,
  })),
)

interface SessionDiffsPanelProps {
  messages: AgentSessionMessage[]
  cwd?: string | null
  onClose: () => void
}

function baseName(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function resolveDiffFilePath(filePath: string, cwd?: string | null): string {
  if (
    filePath.startsWith('/') ||
    filePath.startsWith('file://') ||
    /^[A-Za-z]:[\\/]/.test(filePath)
  ) {
    return filePath
  }
  if (!cwd) return filePath
  return `${cwd.replace(/[\\/]+$/, '')}/${filePath}`
}

// ─── Components ───────────────────────────────────────────────────────────────

export function FileDiffPreview({
  file,
  className,
  tableClassName,
}: {
  file: FileDiffStats
  className?: string
  tableClassName?: string
}) {
  const hasDetails = file.edits.length > 0 || (file.patches?.length ?? 0) > 0

  return (
    <div className={className}>
      {hasDetails ? (
        <Suspense
          fallback={
            <div
              className={cn(
                'max-h-[min(55vh,520px)] rounded-[6px] border border-border/30 bg-[oklch(0.10_0.004_285)] px-2.5 py-2 text-[11px] text-muted-foreground/55',
                tableClassName,
              )}
            >
              Loading diff viewer...
            </div>
          }
        >
          <LazyPierreFileDiffPreview file={file} tableClassName={tableClassName} />
        </Suspense>
      ) : (
        <div className="rounded-[6px] border border-border/25 bg-background/40 px-2.5 py-2 text-[11px] text-muted-foreground/60">
          Diff summary available, but the full patch was not preserved for this file.
        </div>
      )}
    </div>
  )
}

function FileDiffRow({ file, cwd }: { file: FileDiffStats; cwd?: string | null }) {
  const [expanded, setExpanded] = useState(false)
  const reduceMotion = useReducedMotion()
  const activeProjectId = useStore((state) => state.activeProjectId)
  const openTextEditorForPath = useStore((state) => state.openTextEditorForPath)
  const name = baseName(file.filePath)
  const dir = file.filePath.slice(0, Math.max(0, file.filePath.length - name.length - 1))
  const openFile = useCallback(() => {
    openTextEditorForPath(resolveDiffFilePath(file.filePath, cwd), activeProjectId)
  }, [activeProjectId, cwd, file.filePath, openTextEditorForPath])

  return (
    <li className="border-b border-border/20 last:border-b-0">
      <div className="flex w-full items-center gap-1 px-3 py-1.5 transition-colors hover:bg-foreground/5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground/40 transition-transform',
              expanded && 'rotate-90',
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[12px]" title={file.filePath}>
            <span className="font-medium text-foreground/85">{name}</span>
            {dir ? <span className="ml-1.5 text-muted-foreground/45">{dir}</span> : null}
          </span>
        </button>
        <span className="shrink-0 text-[11px] tabular-nums">
          {file.additions > 0 ? (
            <span className="text-emerald-400/80">+{file.additions}</span>
          ) : null}
          {file.additions > 0 && file.deletions > 0 ? (
            <span className="text-muted-foreground/30"> · </span>
          ) : null}
          {file.deletions > 0 ? <span className="text-rose-400/80">-{file.deletions}</span> : null}
        </span>
        <button
          type="button"
          onClick={openFile}
          className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground/40 transition-colors hover:bg-foreground/8 hover:text-foreground"
          title="Open in text editor"
          aria-label={`Open ${name} in text editor`}
        >
          <Pencil className="size-3.5" />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="file-diff-body"
            initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduceMotion ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0 }}
            transition={EXPAND_TRANSITION}
            style={{ overflow: 'hidden' }}
          >
            <div className="px-3 pb-2 pr-2">
              <FileDiffPreview file={file} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  )
}

const MIN_WIDTH = 280
const MAX_WIDTH = 900
const DEFAULT_WIDTH = 520

export function SessionDiffsPanel({ messages, cwd, onClose }: SessionDiffsPanelProps) {
  const files = useMemo(() => groupDiffsByFile(messages), [messages])
  const totalAdditions = files.reduce((acc, f) => acc + f.additions, 0)
  const totalDeletions = files.reduce((acc, f) => acc + f.deletions, 0)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return
    const delta = startX.current - e.clientX
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta)))
  }, [])

  const onMouseUp = useCallback(() => {
    dragging.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  useEffect(() => {
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [onMouseMove, onMouseUp])

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = width
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div
      className="relative z-20 flex h-full shrink-0 flex-col border-l border-border/40 bg-[oklch(0.11_0.004_285)] backdrop-blur-sm"
      style={{ width }}
    >
      {/* Drag-resize handle on the left edge */}
      <div
        onMouseDown={onResizeStart}
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-ew-resize transition-colors hover:bg-foreground/10"
      />
      <div className="flex shrink-0 items-center gap-2 border-b border-border/30 px-3 py-2">
        <FileText className="size-3 shrink-0 text-muted-foreground/50" />
        <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
          Session diffs
        </span>
        <span className="shrink-0 text-[11px] tabular-nums">
          {totalAdditions > 0 ? (
            <span className="text-emerald-400/80">+{totalAdditions}</span>
          ) : null}
          {totalAdditions > 0 && totalDeletions > 0 ? (
            <span className="text-muted-foreground/30"> · </span>
          ) : null}
          {totalDeletions > 0 ? <span className="text-rose-400/80">-{totalDeletions}</span> : null}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-[4px] p-0.5 text-muted-foreground/40 transition-colors hover:bg-foreground/8 hover:text-muted-foreground"
          aria-label="Close diffs panel"
        >
          <X className="size-3" />
        </button>
      </div>
      <ScrollArea className="flex-1">
        {files.length === 0 ? (
          <div className="px-4 py-6 text-[12px] text-muted-foreground/50">
            No file edits in this session yet.
          </div>
        ) : (
          <ul className="flex flex-col py-1">
            {files.map((file) => (
              <FileDiffRow key={file.filePath} file={file} cwd={cwd} />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}
