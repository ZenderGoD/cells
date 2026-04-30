import { useCallback, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from 'motion/react'
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Copy,
  FileText,
  MessageCircleDashed,
  Reply,
  XCircle,
} from 'lucide-react'
import type { AgentReplyReference, AgentSessionMessage, AgentWindowNode } from '@/types'
import { cn } from '@/lib/utils'
import { resolveToolIcon } from '@/lib/tool-icons'
import { getVerticalScrollFadeMask, useVerticalScrollFades } from '@/lib/use-scroll-fades'
import {
  diffStatsFromMessage,
  groupDiffsByFile,
  hasDiffStats,
  sumDiffStats,
  type DiffStats,
} from '@/lib/tool-diff-stats'
import { AgentMarkdown } from './agent-markdown'
import { LoadingIndicator, Spinner } from './agent-loading-indicator'
import { FileDiffPreview } from './session-diffs-panel'

const RESPONSE_MAX_HEIGHT = 540

// Copied and adapted from Craft Agents OSS:
// ../craft-agents-oss/packages/ui/src/components/chat/TurnCard.tsx
// Renders activities stripe (count badge + preview) and response card.

// Ease-out-quad (cubic-bezier(0.25, 0.46, 0.45, 0.94)). Entrances/exits should
// feel responsive — fast start, gentle landing — per Emil Kowalski's easing
// rules. Reused everywhere in this file so paired elements move as a unit.
const EASE_OUT = [0.25, 0.46, 0.45, 0.94] as const
// ease-out-quart — smoother landing for height-based expand/collapse so the
// tail of the motion sits gently instead of clipping to a stop. Use this
// whenever we animate height: 0 → 'auto'.
const EASE_EXPAND = [0.22, 1, 0.36, 1] as const
// Shared expand transition: height leads the eye, opacity fades in faster so
// content is legible while the container is still growing.
const EXPAND_TRANSITION = {
  height: { duration: 0.28, ease: EASE_EXPAND },
  opacity: { duration: 0.18, ease: EASE_EXPAND },
} as const
// Assistant-turn text should start on the same x-axis as ResponseCard content.
// If the visible text sits inside a padded affordance, offset the wrapper by
// that affordance's inner padding so the glyphs, not the container edge, align.
const RESPONSE_TEXT_INSET_CLASS = 'pl-4'
const TOOL_GROUP_COUNT_TEXT_INSET_CLASS = 'pl-2.5'
const TOOL_GROUP_ACTIVITY_RAIL_CLASS = 'ml-[18px]'
const REPLY_SWIPE_TRIGGER_X = 34
const REPLY_WHEEL_RESET_MS = 280
const REPLY_WHEEL_COOLDOWN_MS = 700

interface AgentTurnCardProps {
  activities: AgentSessionMessage[]
  responses: AgentSessionMessage[]
  changedFilesActivities?: AgentSessionMessage[]
  // Interim assistant text that preceded this turn's tool calls. When
  // present it replaces the generic "Working…" preview so the user reads
  // the intent behind the upcoming activity instead of a filler label.
  leadText?: string
  leadResponses?: AgentSessionMessage[]
  cwd?: string | null
  agent: AgentWindowNode['agent']
  isStreaming: boolean
  onReply?: (replyTo: AgentReplyReference) => void
}

function parseToolInput(raw: string | null | undefined): Record<string, any> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function baseName(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p)
}

function joinPath(basePath: string, relativePath: string): string {
  const normalizedBase = basePath.replace(/[\\/]+$/, '')
  const normalizedRelative = relativePath.replace(/^[.][\\/]/, '').replace(/^[/\\]+/, '')
  return `${normalizedBase}/${normalizedRelative}`
}

async function revealChangedFile(filePath: string, cwd: string | null | undefined) {
  const candidates =
    cwd && !isAbsolutePath(filePath) ? [joinPath(cwd, filePath), filePath] : [filePath]
  for (const candidate of candidates) {
    try {
      const stat = await window.cells.app.statPath(candidate)
      if (stat.kind !== 'missing') {
        await window.cells.app.revealPath(stat.resolved)
        return
      }
    } catch {
      // Fall through to the next candidate and let revealPath surface the final failure.
    }
  }
  await window.cells.app.revealPath(candidates[0] ?? filePath)
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

function getMessageDurationMs(message: AgentSessionMessage): number | null {
  const startedAt = message.startedAt ?? null
  const updatedAt = message.updatedAt ?? null
  if (!startedAt || !updatedAt) return null
  const elapsed = updatedAt - startedAt
  return elapsed >= 1000 ? elapsed : null
}

function normalizeReplyPreview(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 220)
}

function makeReplyReference(
  id: string,
  role: AgentReplyReference['role'],
  label: string,
  preview: string | null | undefined,
  title?: string | null,
): AgentReplyReference {
  return {
    id,
    role,
    label,
    preview: normalizeReplyPreview(preview) || label,
    title: title ?? null,
  }
}

function useReplyGesture(onReply?: () => void) {
  const reduceMotion = useReducedMotion()
  const x = useMotionValue(0)
  const pointerStartXRef = useRef<number | null>(null)
  const pointerStartYRef = useRef<number | null>(null)
  const pointerActiveRef = useRef(false)
  const swipedRef = useRef(false)
  const wheelCooldownRef = useRef(0)
  const wheelResetTimerRef = useRef<number | null>(null)

  const animateBack = useCallback(() => {
    if (wheelResetTimerRef.current !== null) {
      window.clearTimeout(wheelResetTimerRef.current)
      wheelResetTimerRef.current = null
    }
    if (reduceMotion) {
      x.set(0)
      return
    }
    void animate(x, 0, { type: 'spring', stiffness: 520, damping: 34, mass: 0.55 })
  }, [reduceMotion, x])

  const setSwipeOffset = useCallback(
    (offset: number) => {
      if (reduceMotion) return
      x.set(Math.max(0, offset))
    },
    [reduceMotion, x],
  )

  const triggerReply = useCallback(() => {
    if (!onReply) return
    swipedRef.current = true
    onReply()
    animateBack()
  }, [animateBack, onReply])

  const onWheel = useCallback(
    (event: ReactWheelEvent<HTMLElement>) => {
      if (!onReply) return
      const absX = Math.abs(event.deltaX)
      const absY = Math.abs(event.deltaY)
      if (absX < 4 || absX < absY * 1.15) return
      const now = Date.now()
      if (now - wheelCooldownRef.current < REPLY_WHEEL_COOLDOWN_MS) return
      const swipeDelta = -event.deltaX
      if (swipeDelta <= 0) {
        animateBack()
        return
      }
      const nextOffset = Math.max(0, x.get() + swipeDelta)
      setSwipeOffset(nextOffset)
      if (nextOffset < REPLY_SWIPE_TRIGGER_X || absX < absY * 1.4) {
        if (wheelResetTimerRef.current !== null) {
          window.clearTimeout(wheelResetTimerRef.current)
        }
        wheelResetTimerRef.current = window.setTimeout(animateBack, REPLY_WHEEL_RESET_MS)
        return
      }
      wheelCooldownRef.current = now
      triggerReply()
    },
    [animateBack, onReply, setSwipeOffset, triggerReply, x],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!onReply || event.pointerType === 'mouse') return
      pointerStartXRef.current = event.clientX
      pointerStartYRef.current = event.clientY
      pointerActiveRef.current = true
      swipedRef.current = false
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [onReply],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const startX = pointerStartXRef.current
      const startY = pointerStartYRef.current
      if (!onReply || startX == null || startY == null) return
      const deltaX = event.clientX - startX
      const deltaY = event.clientY - startY
      if (Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return
      if (deltaX <= 0) {
        setSwipeOffset(0)
        return
      }
      setSwipeOffset(deltaX)
    },
    [onReply, setSwipeOffset],
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const startX = pointerStartXRef.current
      const startY = pointerStartYRef.current
      pointerStartXRef.current = null
      pointerStartYRef.current = null
      pointerActiveRef.current = false
      if (!onReply || startX == null || startY == null) return
      const deltaX = event.clientX - startX
      const deltaY = event.clientY - startY
      if (deltaX < 64 || deltaX < Math.abs(deltaY) * 1.4) {
        animateBack()
        return
      }
      triggerReply()
    },
    [animateBack, onReply, triggerReply],
  )

  const onPointerCancel = useCallback(() => {
    pointerStartXRef.current = null
    pointerStartYRef.current = null
    pointerActiveRef.current = false
    animateBack()
  }, [animateBack])

  const onPointerLeave = useCallback(() => {
    // Pointer capture keeps delivering move/up events even when the translated
    // card slides out from under the cursor. Resetting here makes long swipes
    // snap back before release.
  }, [])

  const onLostPointerCapture = useCallback(() => {
    if (!pointerActiveRef.current) return
    pointerStartXRef.current = null
    pointerStartYRef.current = null
    pointerActiveRef.current = false
    animateBack()
  }, [animateBack])

  const wasReplyGesture = useCallback(() => {
    const wasSwiped = swipedRef.current
    swipedRef.current = false
    return wasSwiped
  }, [])

  return {
    x,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave,
    onLostPointerCapture,
    wasReplyGesture,
  }
}

function getActivitiesDurationMs(activities: AgentSessionMessage[]): number | null {
  let startedAt: number | null = null
  let updatedAt: number | null = null
  for (const activity of activities) {
    const activityStartedAt = activity.startedAt ?? activity.updatedAt ?? null
    if (typeof activityStartedAt === 'number') {
      startedAt = startedAt == null ? activityStartedAt : Math.min(startedAt, activityStartedAt)
    }
    const activityUpdatedAt = activity.updatedAt ?? null
    if (typeof activityUpdatedAt === 'number') {
      updatedAt = updatedAt == null ? activityUpdatedAt : Math.max(updatedAt, activityUpdatedAt)
    }
  }
  if (startedAt == null || updatedAt == null) return null
  const elapsed = updatedAt - startedAt
  return elapsed >= 1000 ? elapsed : null
}

// Friendly display names for specific tools — matches Craft's getToolDisplayName.
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Read: 'Read',
  Edit: 'Edit',
  MultiEdit: 'MultiEdit',
  Write: 'Write',
  Bash: 'Bash',
  BashOutput: 'BashOutput',
  Glob: 'Glob',
  Grep: 'Grep',
  Task: 'Sub Agent',
  Agent: 'Sub Agent',
  TodoWrite: 'Todo List Updated',
  WebFetch: 'WebFetch',
  WebSearch: 'WebSearch',
  NotebookEdit: 'NotebookEdit',
}

function getToolDisplayName(name: string): string {
  const stripped = name.replace(/^mcp__[^_]+__/, '')
  return TOOL_DISPLAY_NAMES[stripped] || stripped
}

// Returns Craft's { description, filename, input-summary } triple for an
// activity row. description === Craft's `intentOrDescription` (e.g. Bash's
// description field). filename → shown as a pill. summary → lightly-muted
// params following " · ".
function formatToolRow(message: AgentSessionMessage): {
  description?: string
  filename?: string
  summary?: string
} {
  if (message.role !== 'tool') return {}
  const rawTitle = message.title || ''
  const title = rawTitle.replace(/^mcp__[^_]+__/, '')
  const input = parseToolInput(message.text)
  if (!input) {
    const firstLine = (message.text || '').split('\n')[0].trim()
    if (!firstLine || firstLine === '{}') return {}
    return { summary: firstLine.length > 140 ? firstLine.slice(0, 140) + '…' : firstLine }
  }
  const filePath =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : typeof input.notebook_path === 'string'
          ? input.notebook_path
          : null
  if (
    filePath &&
    (title === 'Read' ||
      title === 'Edit' ||
      title === 'MultiEdit' ||
      title === 'Write' ||
      title === 'NotebookEdit' ||
      title === 'LS')
  ) {
    return { filename: baseName(filePath), summary: filePath }
  }
  if (title === 'Bash' && typeof input.command === 'string') {
    return {
      description: typeof input.description === 'string' ? input.description : undefined,
      summary: input.command,
    }
  }
  if ((title === 'Grep' || title === 'Glob') && typeof input.pattern === 'string') {
    return {
      summary: input.pattern,
      filename: typeof input.path === 'string' ? baseName(input.path) : undefined,
    }
  }
  if (title === 'WebFetch' && typeof input.url === 'string') {
    return { summary: input.url }
  }
  if (title === 'WebSearch' && typeof input.query === 'string') {
    return { summary: input.query }
  }
  if (title === 'Task' || title === 'Agent') {
    // Prefer the actual prompt sent to the subagent over the short
    // description so the user can see what the subagent is doing at a
    // glance. Truncate aggressively so long prompts don't blow out the row.
    const promptSource =
      typeof input.prompt === 'string' && input.prompt.trim()
        ? input.prompt
        : typeof input.description === 'string'
          ? input.description
          : ''
    const firstLine = promptSource.split('\n')[0].trim()
    const summary = firstLine.length > 140 ? firstLine.slice(0, 140) + '…' : firstLine
    return {
      description: summary || undefined,
      filename: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
    }
  }
  if (title === 'TodoWrite' && Array.isArray(input.todos)) {
    return { summary: `${input.todos.length} todos` }
  }
  return {}
}

// Craft-style status icon: spinner while running, green check when done,
// red X on error. Matches TurnCard.ActivityStatusIcon exactly. When a
// `customIconUrl` is passed and the row is completed, we render the brand
// icon instead of the checkmark — matches Craft's behavior for Bash tools
// that resolve to a known CLI (git, npm, docker, etc.).
function StatusIcon({
  message,
  customIconUrl,
}: {
  message: AgentSessionMessage
  customIconUrl?: string | null
}) {
  const status = message.status
  const isError = status === 'failed' || message.role === 'error'
  if (isError) return <XCircle className="size-3 shrink-0 text-destructive" />
  if (status === 'in_progress') {
    return (
      <div className="flex size-3 items-center justify-center shrink-0">
        <Spinner className="text-muted-foreground/80 text-[10px]" />
      </div>
    )
  }
  if (message.role === 'reasoning') {
    return <MessageCircleDashed className="size-3 shrink-0 text-muted-foreground/60" />
  }
  if (status === 'completed') {
    if (customIconUrl) {
      return (
        <img src={customIconUrl} alt="" className="size-3 shrink-0 rounded-sm object-contain" />
      )
    }
    return <CheckCircle2 className="size-3 shrink-0 text-success" />
  }
  return <Circle className="size-3 shrink-0 text-muted-foreground/50" />
}

interface ActivityNode {
  message: AgentSessionMessage
  children: ActivityNode[]
}

// Build Craft-style hierarchical tree from a flat activity list. Children of
// Task/Agent tools (any message with parentToolUseId set) get nested under
// their parent so subagent work appears indented under the Task row instead
// of inline with the parent's own tools.
function buildActivityTree(activities: AgentSessionMessage[]): ActivityNode[] {
  const byToolUseId = new Map<string, ActivityNode>()
  const roots: ActivityNode[] = []
  // First pass: create nodes keyed by toolUseId when available.
  const nodes: ActivityNode[] = activities.map((message) => {
    const node: ActivityNode = { message, children: [] }
    if (message.toolUseId) byToolUseId.set(message.toolUseId, node)
    return node
  })
  // Second pass: attach to parent when parentToolUseId resolves, else root.
  for (const node of nodes) {
    const parentId = node.message.parentToolUseId
    const parent = parentId ? byToolUseId.get(parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

function DiffStatsBadge({ stats, className }: { stats: DiffStats; className?: string }) {
  if (!hasDiffStats(stats)) return null
  const hasLineCounts = stats.additions > 0 || stats.deletions > 0
  return (
    <span
      className={cn(
        'shrink-0 inline-flex items-center gap-1 text-[11px] tabular-nums font-medium',
        className,
      )}
      title={
        hasLineCounts
          ? `+${stats.additions} / -${stats.deletions}`
          : `${stats.changedFiles ?? 0} file${stats.changedFiles === 1 ? '' : 's'} changed`
      }
    >
      {hasLineCounts ? (
        <>
          {stats.additions > 0 ? (
            <span className="text-emerald-400/90">+{stats.additions}</span>
          ) : null}
          {stats.deletions > 0 ? (
            <span className="text-rose-400/90">-{stats.deletions}</span>
          ) : null}
        </>
      ) : (
        <span className="text-muted-foreground/80">
          {stats.changedFiles} file{stats.changedFiles === 1 ? '' : 's'}
        </span>
      )}
    </span>
  )
}

function ActivityDiffDetails({
  files,
  depth,
}: {
  files: ReturnType<typeof groupDiffsByFile>
  depth: number
}) {
  if (files.length === 0) return null
  return (
    <div className="mt-1 mb-1 space-y-2" style={{ marginLeft: `${24 + depth * 12}px` }}>
      {files.map((file) => {
        const name = baseName(file.filePath)
        const dir = file.filePath.slice(0, Math.max(0, file.filePath.length - name.length - 1))
        return (
          <div key={file.filePath} className="min-w-0">
            <div className="mb-1 flex min-w-0 items-center gap-2 px-1 text-[11.5px]">
              <FileText className="size-3 shrink-0 text-muted-foreground/45" />
              <span className="min-w-0 truncate" title={file.filePath}>
                <span className="font-medium text-foreground/80">{name}</span>
                {dir ? <span className="ml-1.5 text-muted-foreground/45">{dir}</span> : null}
              </span>
              <span className="ml-auto shrink-0 text-[11px] tabular-nums">
                {file.additions > 0 ? (
                  <span className="text-emerald-400/80">+{file.additions}</span>
                ) : null}
                {file.additions > 0 && file.deletions > 0 ? (
                  <span className="text-muted-foreground/30"> · </span>
                ) : null}
                {file.deletions > 0 ? (
                  <span className="text-rose-400/80">-{file.deletions}</span>
                ) : null}
              </span>
            </div>
            <FileDiffPreview file={file} tableClassName="max-h-[min(44vh,420px)]" />
          </div>
        )
      })}
    </div>
  )
}

// Activity row — Craft layout: [status icon] [tool name] [filename pill]
// [ · description · summary]. Depth controls left indentation so subagent
// children nest visually.
function ActivityRow({
  node,
  depth,
  onReply,
}: {
  node: ActivityNode
  depth: number
  onReply?: (replyTo: AgentReplyReference) => void
}) {
  const { message, children } = node
  const hasChildren = children.length > 0
  const isTaskLike =
    message.role === 'tool' && (message.title === 'Task' || message.title === 'Agent')
  // Task/Agent rows collapse by default — the outer stripe already shows the
  // subagent's prompt and aggregate status, so the long child list shouldn't
  // push the main response off-screen. User can still open via the chevron.
  void isTaskLike
  const [expanded, setExpanded] = useState(false)
  const reduceMotion = useReducedMotion()
  const row = formatToolRow(message)
  // For Bash rows, try to resolve the leading command against the bundled
  // tool-icons set (git → Git icon, npm → npm, etc.). When we get a hit we
  // use the brand displayName and icon; otherwise we fall back to the
  // generic "Bash" label + green checkmark.
  const resolvedTool =
    message.role === 'tool' && message.title === 'Bash' ? resolveToolIcon(row.summary) : null
  // For file-reading/writing tools, append the filename to the tool name so
  // the row reads "Read polish.lua" instead of just "Read" — matches Craft's
  // LLM-generated display names without actually needing SSE interception.
  const fileToolTitle =
    message.role === 'tool' &&
    (message.title === 'Read' ||
      message.title === 'Edit' ||
      message.title === 'Write' ||
      message.title === 'MultiEdit' ||
      message.title === 'NotebookEdit') &&
    row.filename
      ? `${message.title} ${row.filename}`
      : null
  const displayName =
    resolvedTool?.displayName ??
    fileToolTitle ??
    (message.role === 'reasoning'
      ? 'Thinking'
      : message.role === 'system'
        ? message.title || 'System'
        : message.role === 'error'
          ? message.title || 'Error'
          : message.role === 'assistant'
            ? 'Agent'
            : getToolDisplayName(message.title || 'Tool'))
  // For assistant subagent messages, use the text as the description inline.
  const assistantInline =
    message.role === 'assistant'
      ? (message.text || '').trim().split('\n')[0].slice(0, 180)
      : undefined
  const hasTrailing = !!(row.description || row.summary || assistantInline)
  const rowDiffStats = diffStatsFromMessage(message)
  const diffFiles = useMemo(() => groupDiffsByFile([message]), [message])
  const hasDiffDetails = diffFiles.length > 0
  const durationMs = getMessageDurationMs(message)
  const isSettled = message.status === 'completed' || message.status === 'failed'
  const replyReference = useMemo(
    () =>
      makeReplyReference(
        message.id,
        message.role,
        displayName,
        row.description || assistantInline || row.summary || message.text || displayName,
        message.title ?? null,
      ),
    [assistantInline, displayName, message.id, message.role, message.text, message.title, row],
  )
  const handleReply = useCallback(() => onReply?.(replyReference), [onReply, replyReference])
  const replyGesture = useReplyGesture(onReply ? handleReply : undefined)

  return (
    <div className="group/row">
      <div className="flex min-w-0 items-center gap-1">
        <motion.button
          type="button"
          onClick={() => {
            if (replyGesture.wasReplyGesture()) return
            setExpanded((v) => !v)
          }}
          onWheel={replyGesture.onWheel}
          onPointerDown={replyGesture.onPointerDown}
          onPointerMove={replyGesture.onPointerMove}
          onPointerUp={replyGesture.onPointerUp}
          onPointerCancel={replyGesture.onPointerCancel}
          onPointerLeave={replyGesture.onPointerLeave}
          onLostPointerCapture={replyGesture.onLostPointerCapture}
          className="flex min-w-0 flex-1 overflow-hidden items-center gap-2 rounded-[6px] px-1 py-0.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5"
          style={{ x: replyGesture.x, paddingLeft: `${4 + depth * 12}px` }}
        >
          <StatusIcon message={message} customIconUrl={resolvedTool?.iconUrl} />
          <span className="shrink truncate">{displayName}</span>
          {row.filename ? (
            <span
              className="shrink-0 rounded-[4px] bg-background px-1.5 py-0.5 text-[11px] text-foreground/70 shadow-minimal"
              title={row.summary ?? row.filename}
            >
              {row.filename}
            </span>
          ) : null}
          {rowDiffStats ? <DiffStatsBadge stats={rowDiffStats} /> : null}
          {isSettled && durationMs ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/55">
              {formatDuration(durationMs)}
            </span>
          ) : null}
          {hasTrailing ? (
            <span className="min-w-0 flex-1 truncate">
              {row.description ? (
                <>
                  <span className="opacity-60"> · </span>
                  <span>{row.description}</span>
                </>
              ) : null}
              {assistantInline ? (
                <>
                  <span className="opacity-60"> · </span>
                  <span>{assistantInline}</span>
                </>
              ) : null}
              {row.summary ? (
                <>
                  <span className="opacity-60"> · </span>
                  <span className="opacity-60">
                    {row.summary.length > 200 ? row.summary.slice(0, 200) + '…' : row.summary}
                  </span>
                </>
              ) : null}
            </span>
          ) : null}
          <ChevronRight
            className={cn(
              'ml-auto size-3 shrink-0 text-muted-foreground/40 transition-transform',
              expanded && 'rotate-90',
            )}
          />
        </motion.button>
        {onReply ? (
          <button
            type="button"
            onClick={handleReply}
            aria-label={`Reply to ${displayName}`}
            title="Reply"
            className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground/35 opacity-0 transition-colors hover:bg-foreground/8 hover:text-foreground/80 group-hover/row:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
          >
            <Reply className="size-3.5" />
          </button>
        ) : null}
      </div>
      {/* Diff-producing leaf rows show a rendered diff when expanded; other
       *  leaf rows show the raw payload. Rows with children render those
       *  children instead. */}
      <AnimatePresence initial={false}>
        {expanded && !hasChildren ? (
          <motion.div
            key="leaf"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0 }}
            transition={EXPAND_TRANSITION}
            style={{ overflow: 'hidden' }}
          >
            {hasDiffDetails ? (
              <ActivityDiffDetails files={diffFiles} depth={depth} />
            ) : (
              <pre
                className={cn(
                  'mt-1 mb-1 select-text whitespace-pre-wrap break-words rounded-[8px] border border-border/40 bg-background/50 px-3 py-2 text-[13px] leading-[1.5]',
                  message.role === 'reasoning'
                    ? 'font-sans text-foreground/80'
                    : 'font-mono text-foreground/75',
                )}
                style={{ marginLeft: `${24 + depth * 12}px` }}
              >
                {message.text || '(no output)'}
              </pre>
            )}
          </motion.div>
        ) : null}
        {hasChildren && expanded ? (
          <motion.div
            key="children"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0 }}
            transition={EXPAND_TRANSITION}
            style={{ overflow: 'hidden' }}
          >
            <div className="space-y-0.5">
              {children.map((child) => (
                <ActivityRow
                  key={child.message.id}
                  node={child}
                  depth={depth + 1}
                  onReply={onReply}
                />
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

// Derive a collapsed-state preview string from activities. Matches Craft's
// getPreviewText: prefer a running tool's description, then any Bash
// description, then running tool names, then "Completed".
function usePreviewText(
  activities: AgentSessionMessage[],
  isStreaming: boolean,
  agent: AgentWindowNode['agent'],
): string {
  return useMemo(() => {
    if (activities.length === 0) {
      return isStreaming
        ? agent === 'claude'
          ? 'Claude is thinking…'
          : 'Codex is thinking…'
        : 'No activity'
    }
    // Once the turn is idle, show a completion summary — even if some tool
    // row still happens to carry `in_progress` (e.g. tool_result event
    // dropped), we don't want to keep saying "Running Read…".
    if (!isStreaming) {
      const errorCount = activities.filter((a) => a.status === 'failed').length
      const durationMs = getActivitiesDurationMs(activities)
      for (let index = activities.length - 1; index >= 0; index -= 1) {
        const a = activities[index]
        const row = formatToolRow(a)
        if (row.description) return row.description
      }
      const completedLabel = durationMs ? `Completed · ${formatDuration(durationMs)}` : 'Completed'
      return errorCount > 0 ? `${completedLabel} · ${errorCount} failed` : completedLabel
    }
    // Streaming: prefer a running activity's description/summary
    for (let index = activities.length - 1; index >= 0; index -= 1) {
      const running = activities[index]
      if (running.status !== 'in_progress') continue
      const row = formatToolRow(running)
      if (row.description) return row.description
      if (running.role === 'reasoning') return 'Thinking…'
      return `Running ${getToolDisplayName(running.title || 'Tool')}…`
    }
    for (let index = activities.length - 1; index >= 0; index -= 1) {
      const a = activities[index]
      const row = formatToolRow(a)
      if (row.description) return row.description
    }
    return 'Working…'
  }, [activities, isStreaming, agent])
}

// Mirrors Craft's ResponseCard — ../craft-agents-oss/packages/ui/src/components/chat/TurnCard.tsx
// lines 2414-2616. Wrapper is `bg-card` (Cells's --card matches Craft's
// --background brightness at oklch(0.21)); inner content is pl-[22px] pr-4 py-3
// with a 16px top/bottom fade mask in dark mode; footer has a Copy button on
// the left, border-top, and a muted background. Streaming state swaps the
// footer's copy area for a "Streaming…" spinner.
function ResponseSurface({
  responses,
  text,
  variant,
  className,
  onReply,
}: {
  responses?: AgentSessionMessage[]
  text?: string
  variant: 'boxed' | 'lead'
  className?: string
  onReply?: (replyTo: AgentReplyReference) => void
}) {
  const reduceMotion = useReducedMotion()
  const visible = useMemo(() => {
    const responseItems = responses?.filter((r) => r.text.trim().length > 0)
    if (responseItems?.length) return responseItems
    const trimmed = text?.trim()
    return trimmed
      ? [
          {
            id: `lead-${trimmed}`,
            role: 'assistant' as const,
            text: trimmed,
            status: 'completed' as const,
          } satisfies AgentSessionMessage,
        ]
      : []
  }, [responses, text])
  const isBoxed = variant === 'boxed'
  const [copied, setCopied] = useState(false)
  // Craft's "Markdown" button toggles a raw-source view of the message (so
  // you can read/copy the underlying .md). Same behaviour here.
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered')
  const isStreaming =
    isBoxed && visible.length > 0 && visible[visible.length - 1].status === 'in_progress'
  const combinedText = useMemo(() => visible.map((r) => r.text).join('\n\n'), [visible])
  const [setResponseScrollElement, responseFade] = useVerticalScrollFades(
    `${viewMode}:${combinedText}`,
  )
  const responseMask = getVerticalScrollFadeMask(responseFade, 16, 16)
  const replyReference = useMemo(() => {
    if (!combinedText.trim()) return null
    const id = visible.length
      ? visible.map((response) => response.id).join('|')
      : `reply-${variant}`
    return makeReplyReference(id, 'assistant', 'Agent response', combinedText, null)
  }, [combinedText, variant, visible])
  const handleReply = useCallback(() => {
    if (replyReference) onReply?.(replyReference)
  }, [onReply, replyReference])
  const replyGesture = useReplyGesture(onReply && replyReference ? handleReply : undefined)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(combinedText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard blocked — ignore silently, matches Craft's fire-and-forget.
    }
  }

  // Lifted surface — sits between --background and --card in both themes so
  // the response reads as "elevated" over the window surface, matching
  // Craft's visual. See --elevated-surface in globals.css.
  return (
    <motion.div
      layout={false}
      onWheel={replyGesture.onWheel}
      onPointerDown={replyGesture.onPointerDown}
      onPointerMove={replyGesture.onPointerMove}
      onPointerUp={replyGesture.onPointerUp}
      onPointerCancel={replyGesture.onPointerCancel}
      onPointerLeave={replyGesture.onPointerLeave}
      onLostPointerCapture={replyGesture.onLostPointerCapture}
      className={cn(
        'group relative overflow-visible rounded-[12px]',
        !isBoxed && 'agent-response',
        className,
      )}
      style={{ x: replyGesture.x, overflowAnchor: 'none' }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
    >
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[12px] shadow-minimal"
        initial={false}
        animate={{ opacity: isBoxed ? 1 : 0 }}
        transition={{ duration: 0.18, ease: EASE_OUT }}
        style={{ backgroundColor: 'var(--elevated-surface)' }}
      />
      <div
        ref={setResponseScrollElement}
        data-search-root="response"
        className={cn(
          'relative select-text px-4 pt-1 text-sm',
          isBoxed
            ? 'scrollbar-hover overflow-y-auto text-foreground/90'
            : 'overflow-visible pr-2.5 leading-relaxed text-foreground/85 [&_.agent-markdown>:first-child]:mt-0 [&_p:last-child]:mb-0',
        )}
        style={{
          maxHeight: isBoxed ? RESPONSE_MAX_HEIGHT : undefined,
          overflowAnchor: 'none',
          scrollbarGutter: isBoxed ? 'stable' : undefined,
          maskImage: isBoxed ? responseMask : undefined,
          WebkitMaskImage: isBoxed ? responseMask : undefined,
        }}
      >
        {visible.map((response, idx) => (
          <div key={response.id} className={cn(idx > 0 && 'mt-3 border-t border-border/30 pt-3')}>
            {isBoxed && viewMode === 'source' ? (
              <pre className="whitespace-pre-wrap break-words font-sans py-2">{response.text}</pre>
            ) : (
              <AgentMarkdown
                breaks={response.status === 'in_progress'}
                streamingReveal={response.status === 'in_progress'}
              >
                {response.text}
              </AgentMarkdown>
            )}
          </div>
        ))}
      </div>
      <AnimatePresence initial={false}>
        {isBoxed ? (
          <motion.div
            key="response-footer"
            initial={false}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={EXPAND_TRANSITION}
            style={{ overflow: 'hidden' }}
          >
            <div className="relative flex items-center gap-3 pl-4 pr-2.5 py-2 text-[13px]">
              {isStreaming ? (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Spinner className="text-[10px]" />
                  <span>Streaming…</span>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className={cn(
                      'flex select-none items-center gap-1.5 transition-colors focus:outline-none focus-visible:underline',
                      copied ? 'text-success' : 'text-foreground/40 hover:text-foreground/80',
                    )}
                  >
                    {copied ? (
                      <>
                        <Check className="size-3" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="size-3" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode((v) => (v === 'source' ? 'rendered' : 'source'))}
                    className={cn(
                      'flex select-none items-center gap-1.5 transition-colors focus:outline-none focus-visible:underline',
                      viewMode === 'source'
                        ? 'text-foreground/80'
                        : 'text-foreground/40 hover:text-foreground/80',
                    )}
                    title={viewMode === 'source' ? 'Show rendered' : 'Show raw markdown'}
                  >
                    <FileText className="size-3" />
                    <span>Markdown</span>
                  </button>
                </>
              )}
              {onReply && replyReference ? (
                <button
                  type="button"
                  onClick={handleReply}
                  aria-label="Reply to agent response"
                  title="Reply"
                  className="ml-auto flex select-none items-center gap-1.5 text-foreground/40 transition-colors hover:text-foreground/80 focus:outline-none focus-visible:underline"
                >
                  <Reply className="size-3" />
                  <span>Reply</span>
                </button>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  )
}

function ResponseCard({
  responses,
  onReply,
}: {
  responses: AgentSessionMessage[]
  onReply?: (replyTo: AgentReplyReference) => void
}) {
  return <ResponseSurface responses={responses} variant="boxed" onReply={onReply} />
}

function ChangedFilesSection({
  activities,
  cwd,
}: {
  activities: AgentSessionMessage[]
  cwd?: string | null
}) {
  const [open, setOpen] = useState(false)
  const reduceMotion = useReducedMotion()
  const files = useMemo(() => groupDiffsByFile(activities), [activities])
  if (files.length === 0) return null
  const totals = files.reduce(
    (acc, f) => ({
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { additions: 0, deletions: 0 },
  )
  return (
    <div className="mt-1 select-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-[6px] py-0.5 pr-1 text-left text-[12px] text-muted-foreground/70 transition-colors hover:bg-foreground/5',
          RESPONSE_TEXT_INSET_CLASS,
        )}
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="shrink-0">
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
        </span>
        <span className="ml-1 inline-flex items-center gap-1 tabular-nums">
          {totals.additions > 0 && <span className="text-emerald-400/80">+{totals.additions}</span>}
          {totals.deletions > 0 && <span className="text-rose-400/80">-{totals.deletions}</span>}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="files"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0 }}
            transition={EXPAND_TRANSITION}
            style={{ overflow: 'hidden' }}
          >
            <div className="ml-4 mt-0.5 space-y-px">
              {files.map((f) => {
                const name = f.filePath.split('/').pop() ?? f.filePath
                const dir = f.filePath.includes('/')
                  ? f.filePath.slice(0, f.filePath.lastIndexOf('/'))
                  : null
                return (
                  <button
                    key={f.filePath}
                    type="button"
                    onClick={() => void revealChangedFile(f.filePath, cwd)}
                    className="flex w-full items-center gap-1.5 rounded-[4px] py-0.5 text-left text-[11.5px] text-muted-foreground/80 transition-colors hover:bg-foreground/5 hover:text-foreground/90"
                    title={f.filePath}
                  >
                    <FileText className="size-3 shrink-0 opacity-50" />
                    <span className="truncate font-medium">{name}</span>
                    {dir ? (
                      <span className="shrink-0 truncate text-muted-foreground/40">{dir}</span>
                    ) : null}
                    <span className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums text-[11px]">
                      {f.additions > 0 && (
                        <span className="text-emerald-400/80">+{f.additions}</span>
                      )}
                      {f.deletions > 0 && <span className="text-rose-400/80">-{f.deletions}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export function AgentTurnCard({
  activities,
  responses,
  changedFilesActivities,
  leadText,
  leadResponses,
  cwd,
  agent,
  isStreaming,
  onReply,
}: AgentTurnCardProps) {
  const hasActivities = activities.length > 0
  const hasResponse = responses.some((r) => r.text.trim().length > 0)
  const hasLeadResponse = Boolean(leadResponses?.some((r) => r.text.trim().length > 0))
  const hasLeadText = Boolean(leadText?.trim()) || hasLeadResponse
  const showStandaloneResponse = !hasActivities && hasResponse
  const [collapsed, setCollapsed] = useState(true)
  const showActivities = !collapsed
  const computedPreview = usePreviewText(activities, isStreaming, agent)
  const reduceMotion = useReducedMotion()
  const tree = useMemo(
    () => (showActivities ? buildActivityTree(activities) : []),
    [activities, showActivities],
  )
  const groupDiffStats = useMemo(() => sumDiffStats(activities), [activities])

  return (
    <div className="flex w-full justify-start">
      <motion.div layout={isStreaming ? false : 'position'} className="w-full space-y-1">
        {hasLeadText || showStandaloneResponse ? (
          <ResponseSurface
            responses={hasLeadText ? leadResponses : responses}
            text={hasLeadText ? leadText : undefined}
            variant={showStandaloneResponse && !hasLeadText ? 'boxed' : 'lead'}
            className={hasActivities ? 'pb-1' : undefined}
            onReply={onReply}
          />
        ) : null}
        {hasActivities ? (
          // Tool activity always stays grouped behind a single collapse handle.
          // This keeps the transcript rhythm consistent even for one-off calls.
          <div className="select-none">
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className={cn(
                'flex w-full items-center gap-2 overflow-hidden rounded-[8px] py-1.5 pr-2.5 text-left transition-colors hover:bg-foreground/5 focus:outline-none',
                TOOL_GROUP_COUNT_TEXT_INSET_CLASS,
              )}
            >
              <span
                className={cn(
                  'inline-flex shrink-0 items-center justify-center rounded-[4px] bg-background px-1.5 py-0.5 text-[10px] font-medium tabular-nums shadow-minimal',
                )}
              >
                {activities.length}
              </span>
              {isStreaming ? (
                <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-muted-foreground">
                  <Spinner className="shrink-0 text-[10px] text-muted-foreground/80" />
                  <LoadingIndicator
                    label={computedPreview}
                    showSpinner={false}
                    showElapsed
                    className="min-w-0 flex-1 gap-1.5 overflow-hidden whitespace-nowrap"
                    labelClassName="min-w-0 flex-1 truncate"
                    elapsedClassName="shrink-0"
                  />
                </span>
              ) : (
                <span className="relative min-w-0 flex-1 text-[13px] text-muted-foreground">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span
                      key={computedPreview}
                      className="block truncate"
                      // Blur keeps each swap from feeling like a cut; kept at
                      // 3px so Safari's filter cost stays cheap (skill warns
                      // above 20px). Disable entirely under reduced motion.
                      initial={reduceMotion ? false : { opacity: 0, filter: 'blur(3px)' }}
                      animate={{ opacity: 1, filter: 'blur(0px)' }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(3px)' }}
                      transition={{ duration: 0.18, ease: EASE_OUT }}
                    >
                      {computedPreview}
                    </motion.span>
                  </AnimatePresence>
                </span>
              )}
              {hasDiffStats(groupDiffStats) ? (
                <DiffStatsBadge stats={groupDiffStats} className="ml-auto" />
              ) : null}
              <ChevronRight
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground/70 transition-transform',
                  !hasDiffStats(groupDiffStats) && 'ml-auto',
                  showActivities && 'rotate-90',
                )}
              />
            </button>
            <AnimatePresence initial={false}>
              {showActivities ? (
                <motion.div
                  key="activity-list"
                  initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={reduceMotion ? { opacity: 0 } : { height: 0 }}
                  transition={EXPAND_TRANSITION}
                  style={{ overflow: 'hidden' }}
                >
                  <div
                    className={cn(
                      'mt-1 max-h-[360px] space-y-0.5 overflow-y-auto overscroll-contain border-l-2 border-border/40 pl-3 pr-1 py-0.5',
                      TOOL_GROUP_ACTIVITY_RAIL_CLASS,
                    )}
                  >
                    {tree.map((node) => (
                      <ActivityRow key={node.message.id} node={node} depth={0} onReply={onReply} />
                    ))}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        ) : isStreaming && !hasResponse && !hasLeadText ? (
          <LoadingIndicator
            label={agent === 'claude' ? 'Claude is thinking…' : 'Codex is thinking…'}
            showElapsed
            className={cn(
              'py-1.5 pr-3 text-[13px] text-muted-foreground',
              RESPONSE_TEXT_INSET_CLASS,
            )}
          />
        ) : null}

        {hasActivities && hasResponse ? (
          <motion.div
            key="response"
            initial={reduceMotion || isStreaming ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
          >
            <ResponseCard responses={responses} onReply={onReply} />
          </motion.div>
        ) : null}
        {!isStreaming && changedFilesActivities ? (
          <ChangedFilesSection activities={changedFilesActivities} cwd={cwd} />
        ) : null}
      </motion.div>
    </div>
  )
}
