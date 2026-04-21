import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
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

// ─── Line-level LCS diff ──────────────────────────────────────────────────────

type DiffOp = { op: 'eq' | 'del' | 'add'; text: string }

const MAX_DIFF_LINES = 300

function lineDiff(oldStr: string, newStr: string): DiffOp[] {
  const a = oldStr.split('\n')
  const b = newStr.split('\n')

  // Cap to avoid O(n²) hangs on huge files
  if (a.length + b.length > MAX_DIFF_LINES) {
    return [
      ...a.map((text) => ({ op: 'del' as const, text })),
      ...b.map((text) => ({ op: 'add' as const, text })),
    ]
  }

  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  const result: DiffOp[] = []
  let i = m,
    j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ op: 'eq', text: a[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ op: 'add', text: b[j - 1] })
      j--
    } else {
      result.unshift({ op: 'del', text: a[i - 1] })
      i--
    }
  }
  return result
}

// Show ±CONTEXT lines around each changed hunk; collapse the rest.
const CONTEXT = 3

function buildHunks(ops: DiffOp[]): Array<DiffOp | 'ellipsis'> {
  const changed = new Set<number>()
  ops.forEach((op, i) => {
    if (op.op !== 'eq') {
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) {
        changed.add(k)
      }
    }
  })
  if (changed.size === 0) return [] // identical
  const result: Array<DiffOp | 'ellipsis'> = []
  let skipping = false
  ops.forEach((op, i) => {
    if (changed.has(i)) {
      skipping = false
      result.push(op)
    } else {
      if (!skipping) result.push('ellipsis')
      skipping = true
    }
  })
  return result
}

// ─── Components ───────────────────────────────────────────────────────────────

function DiffLines({ oldString, newString }: { oldString: string; newString: string }) {
  const hunks = useMemo(() => buildHunks(lineDiff(oldString, newString)), [oldString, newString])
  if (hunks.length === 0) return null

  return (
    <div className="max-h-[320px] overflow-auto rounded-[6px] border border-border/30 bg-[oklch(0.10_0.004_285)] text-[11px] leading-[1.6] overscroll-contain">
      <table className="min-w-full border-collapse font-mono">
        <tbody>
          {hunks.map((item, idx) => {
            if (item === 'ellipsis') {
              return (
                <tr key={`ellipsis-${idx}`}>
                  <td className="w-5 select-none border-r border-border/20 px-1.5 text-center text-muted-foreground/30">
                    ⋯
                  </td>
                  <td className="px-2 text-muted-foreground/30">…</td>
                </tr>
              )
            }
            const { op, text } = item
            const isAdd = op === 'add'
            const isDel = op === 'del'
            return (
              <tr
                key={idx}
                className={cn(isDel && 'bg-rose-500/[0.08]', isAdd && 'bg-emerald-500/[0.08]')}
              >
                <td
                  className={cn(
                    'w-5 select-none border-r border-border/20 px-1.5 text-center font-medium',
                    isDel && 'border-rose-500/20 text-rose-400/70',
                    isAdd && 'border-emerald-500/20 text-emerald-400/70',
                    op === 'eq' && 'text-muted-foreground/25',
                  )}
                >
                  {isDel ? '−' : isAdd ? '+' : ' '}
                </td>
                <td
                  className={cn(
                    'whitespace-pre-wrap break-all px-2 py-px',
                    isDel && 'text-rose-200/80',
                    isAdd && 'text-emerald-200/80',
                    op === 'eq' && 'text-foreground/55',
                  )}
                >
                  {text}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PatchLines({ patch }: { patch: string }) {
  const lines = useMemo(() => patch.split('\n').slice(0, 400), [patch])
  if (lines.length === 0) return null

  return (
    <div className="max-h-[320px] overflow-auto rounded-[6px] border border-border/30 bg-[oklch(0.10_0.004_285)] text-[11px] leading-[1.6] overscroll-contain">
      <table className="min-w-full border-collapse font-mono">
        <tbody>
          {lines.map((line, idx) => {
            const isAdd = line.startsWith('+') && !line.startsWith('+++')
            const isDel = line.startsWith('-') && !line.startsWith('---')
            const isMeta =
              line.startsWith('diff --git ') ||
              line.startsWith('index ') ||
              line.startsWith('@@') ||
              line.startsWith('--- ') ||
              line.startsWith('+++ ') ||
              line.startsWith('rename ')
            return (
              <tr
                key={idx}
                className={cn(
                  isDel && 'bg-rose-500/[0.08]',
                  isAdd && 'bg-emerald-500/[0.08]',
                  isMeta && 'bg-foreground/[0.04]',
                )}
              >
                <td
                  className={cn(
                    'w-5 select-none border-r border-border/20 px-1.5 text-center font-medium',
                    isDel && 'border-rose-500/20 text-rose-400/70',
                    isAdd && 'border-emerald-500/20 text-emerald-400/70',
                    !isAdd && !isDel && 'text-muted-foreground/25',
                  )}
                >
                  {isDel ? '−' : isAdd ? '+' : ' '}
                </td>
                <td
                  className={cn(
                    'whitespace-pre-wrap break-all px-2 py-px',
                    isDel && 'text-rose-200/80',
                    isAdd && 'text-emerald-200/80',
                    isMeta && 'text-sky-200/75',
                    !isAdd && !isDel && !isMeta && 'text-foreground/55',
                  )}
                >
                  {line}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FileDiffRow({ file }: { file: FileDiffStats }) {
  const [expanded, setExpanded] = useState(false)
  const name = baseName(file.filePath)
  const dir = file.filePath.slice(0, Math.max(0, file.filePath.length - name.length - 1))
  const patches = file.patches ?? []
  const hasDetails = file.edits.length > 0 || patches.length > 0
  return (
    <li className="border-b border-border/20 last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-foreground/5"
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
        <span className="shrink-0 text-[11px] tabular-nums">
          {file.additions > 0 ? (
            <span className="text-emerald-400/80">+{file.additions}</span>
          ) : null}
          {file.additions > 0 && file.deletions > 0 ? (
            <span className="text-muted-foreground/30"> · </span>
          ) : null}
          {file.deletions > 0 ? <span className="text-rose-400/80">-{file.deletions}</span> : null}
        </span>
      </button>
      {expanded ? (
        <div className="max-h-[min(55vh,520px)] space-y-1.5 overflow-y-auto overscroll-contain px-3 pb-2 pr-2">
          {file.edits.map((edit, idx) => (
            <DiffLines
              key={`${edit.toolId}-${idx}`}
              oldString={edit.oldString}
              newString={edit.newString}
            />
          ))}
          {patches.map((patch, idx) => (
            <PatchLines key={`patch-${file.filePath}-${idx}`} patch={patch} />
          ))}
          {!hasDetails ? (
            <div className="rounded-[6px] border border-border/25 bg-background/40 px-2.5 py-2 text-[11px] text-muted-foreground/60">
              Diff summary available, but the full patch was not preserved for this file.
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

const MIN_WIDTH = 280
const MAX_WIDTH = 900
const DEFAULT_WIDTH = 520

export function SessionDiffsPanel({ messages, onClose }: SessionDiffsPanelProps) {
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
      {/* pr-8 keeps the X clear of the absolute 3-dot menu button */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/30 px-3 py-2 pr-8">
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
              <FileDiffRow key={file.filePath} file={file} />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}
