import { useMemo, useState } from 'react'
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Copy,
  FileText,
  MessageCircleDashed,
  XCircle,
} from 'lucide-react'
import type { AgentSessionMessage, AgentWindowNode } from '@/types'
import { cn } from '@/lib/utils'
import { resolveToolIcon } from '@/lib/tool-icons'
import { AgentMarkdown } from './agent-markdown'
import { LoadingIndicator, Spinner } from './agent-loading-indicator'

const RESPONSE_MAX_HEIGHT = 540
// Subtle 16px fade on top & bottom edges (dark mode only, matching Craft).
const RESPONSE_FADE_MASK =
  'linear-gradient(to bottom, transparent 0%, black 16px, black calc(100% - 16px), transparent 100%)'

// Copied and adapted from Craft Agents OSS:
// ../craft-agents-oss/packages/ui/src/components/chat/TurnCard.tsx
// Renders activities stripe (count badge + preview) and response card.

interface AgentTurnCardProps {
  activities: AgentSessionMessage[]
  responses: AgentSessionMessage[]
  agent: AgentWindowNode['agent']
  isStreaming: boolean
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

// Activity row — Craft layout: [status icon] [tool name] [filename pill]
// [ · description · summary]. Depth controls left indentation so subagent
// children nest visually.
function ActivityRow({ node, depth }: { node: ActivityNode; depth: number }) {
  const { message, children } = node
  const hasChildren = children.length > 0
  const isTaskLike =
    message.role === 'tool' && (message.title === 'Task' || message.title === 'Agent')
  // Task/Agent rows collapse by default — the outer stripe already shows the
  // subagent's prompt and aggregate status, so the long child list shouldn't
  // push the main response off-screen. User can still open via the chevron.
  void isTaskLike
  const [expanded, setExpanded] = useState(false)
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

  return (
    <div className="group/row">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 rounded-[6px] px-1 py-0.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5"
        style={{ paddingLeft: `${4 + depth * 12}px` }}
      >
        <StatusIcon message={message} customIconUrl={resolvedTool?.iconUrl} />
        <span className="shrink-0">{displayName}</span>
        {row.filename ? (
          <span
            className="shrink-0 rounded-[4px] bg-background px-1.5 py-0.5 text-[11px] text-foreground/70 shadow-minimal"
            title={row.summary ?? row.filename}
          >
            {row.filename}
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
      </button>
      {/* Regular leaf rows show the raw payload in a <pre> when expanded;
       *  rows with children render those children instead. */}
      {expanded && !hasChildren ? (
        <pre
          className={cn(
            'mt-1 mb-1 whitespace-pre-wrap break-words rounded-[8px] border border-border/40 bg-background/50 px-3 py-2 text-[13px] leading-[1.5]',
            message.role === 'reasoning'
              ? 'font-sans text-foreground/80'
              : 'font-mono text-foreground/75',
          )}
          style={{ marginLeft: `${24 + depth * 12}px` }}
        >
          {message.text || '(no output)'}
        </pre>
      ) : null}
      {hasChildren && expanded ? (
        <div className="space-y-0.5">
          {children.map((child) => (
            <ActivityRow key={child.message.id} node={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
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
      for (const a of activities) {
        const row = formatToolRow(a)
        if (row.description) return row.description
      }
      return errorCount > 0 ? `Completed · ${errorCount} failed` : 'Completed'
    }
    // Streaming: prefer a running activity's description/summary
    const running = activities.find((a) => a.status === 'in_progress')
    if (running) {
      const row = formatToolRow(running)
      if (row.description) return row.description
      if (running.role === 'reasoning') return 'Thinking…'
      return `Running ${getToolDisplayName(running.title || 'Tool')}…`
    }
    for (const a of activities) {
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
// Short, plain assistant text (e.g. "Let me find your tmux config.") reads
// better as a bare line than buried inside the full response card chrome.
// We keep the card only when the response is long enough to warrant the copy
// / markdown affordances or carries markdown features that benefit from the
// scroll container (code, lists, headings, tables, blockquotes).
const MARKDOWN_FEATURE_RE =
  /(^#{1,6}\s)|(^\s*[-*+]\s)|(^\s*\d+\.\s)|(^>\s)|(^\s*```)|(\|.*\|)|(\n\s*\n)/m
function isShortPlainResponse(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (trimmed.length > 240) return false
  if (trimmed.split('\n').length > 3) return false
  if (MARKDOWN_FEATURE_RE.test(trimmed)) return false
  return true
}

function ResponseCard({ responses }: { responses: AgentSessionMessage[] }) {
  const visible = responses.filter((r) => r.text.trim().length > 0)
  const [copied, setCopied] = useState(false)
  // Craft's "Markdown" button toggles a raw-source view of the message (so
  // you can read/copy the underlying .md). Same behaviour here.
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered')
  const isStreaming = visible.length > 0 && visible[visible.length - 1].status === 'in_progress'
  const combinedText = useMemo(() => visible.map((r) => r.text).join('\n\n'), [visible])

  // Plain-line path: skip the card wrapper entirely for short, markdown-free
  // responses. Only applies once streaming has settled — while the message is
  // still coming in we always show the full card so the layout doesn't
  // shift under the user.
  if (!isStreaming && visible.length === 1 && isShortPlainResponse(visible[0].text)) {
    return (
      <div className="select-text px-1 text-sm leading-relaxed text-foreground/90">
        <AgentMarkdown inline>{visible[0].text}</AgentMarkdown>
      </div>
    )
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(combinedText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard blocked — ignore silently, matches Craft's fire-and-forget.
    }
  }

  // Lifted surface — Cells's --background is very dark (oklch(0.12)); the
  // card sits one step brighter so it reads as "elevated" over the window
  // surface, matching Craft's visual where the response card is clearly
  // lighter than its surroundings. oklch(0.17) sits between --background
  // (0.12) and --card (0.21), avoiding the too-bright flat look of bg-card.
  return (
    <div
      className="group relative overflow-hidden rounded-[8px] shadow-minimal"
      style={{ backgroundColor: 'oklch(0.17 0.004 285.9)' }}
    >
      <div
        data-search-root="response"
        className="scrollbar-hover select-text overflow-y-auto pl-[22px] pr-4 py-3 text-sm text-foreground/90"
        style={{
          maxHeight: RESPONSE_MAX_HEIGHT,
          maskImage: RESPONSE_FADE_MASK,
          WebkitMaskImage: RESPONSE_FADE_MASK,
        }}
      >
        {visible.map((response, idx) => (
          <div key={response.id} className={cn(idx > 0 && 'mt-3 border-t border-border/30 pt-3')}>
            {viewMode === 'source' ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.55] text-foreground/80">
                {response.text}
              </pre>
            ) : (
              <AgentMarkdown>{response.text}</AgentMarkdown>
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 pl-4 pr-2.5 py-2 text-[13px]">
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
      </div>
    </div>
  )
}

export function AgentTurnCard({ activities, responses, agent, isStreaming }: AgentTurnCardProps) {
  const hasActivities = activities.length > 0
  const hasResponse = responses.some((r) => r.text.trim().length > 0)
  // Activities stripe collapses by default — the preview pill already shows
  // the count + current status, so the long child list shouldn't push the
  // response card off-screen. User can click to expand.
  const [collapsed, setCollapsed] = useState(true)
  const showActivities = !collapsed
  const previewText = usePreviewText(activities, isStreaming, agent)
  const tree = useMemo(() => buildActivityTree(activities), [activities])

  return (
    <div className="flex w-full justify-start">
      <div className="w-full space-y-1">
        {hasActivities ? (
          <div className="select-none">
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left transition-colors hover:bg-foreground/5 focus:outline-none"
            >
              <ChevronRight
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground/70 transition-transform',
                  showActivities && 'rotate-90',
                )}
              />
              <span className="-ml-0.5 shrink-0 rounded-[4px] bg-background px-1.5 py-0.5 text-[10px] font-medium tabular-nums shadow-minimal">
                {activities.length}
              </span>
              {isStreaming ? (
                <LoadingIndicator
                  label={previewText}
                  showElapsed
                  className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground [&>span:nth-child(2)]:truncate"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                  {previewText}
                </span>
              )}
            </button>
            {showActivities ? (
              <div className="ml-[13px] max-h-[360px] space-y-0.5 overflow-y-auto overscroll-contain border-l-2 border-border/40 pl-3 pr-1 py-0.5">
                {tree.map((node) => (
                  <ActivityRow key={node.message.id} node={node} depth={0} />
                ))}
              </div>
            ) : null}
          </div>
        ) : isStreaming && !hasResponse ? (
          <LoadingIndicator
            label={agent === 'claude' ? 'Claude is thinking…' : 'Codex is thinking…'}
            showElapsed
            className="px-3 py-1.5 text-[13px] text-muted-foreground"
          />
        ) : null}

        {hasResponse ? <ResponseCard responses={responses} /> : null}
      </div>
    </div>
  )
}
