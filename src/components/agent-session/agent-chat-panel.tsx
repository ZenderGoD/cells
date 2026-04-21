import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  ArchiveRestore,
  ArrowUp,
  Check,
  ChevronRight,
  Circle,
  Clock,
  FastForward,
  FileText,
  Folder,
  GripVertical,
  HelpCircle,
  History,
  ListTodo,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  ShieldCheck,
  Square,
  X,
  Zap,
} from 'lucide-react'
import type {
  AgentContextLength,
  AgentPermissionMode,
  AgentSessionMessage,
  AgentSessionSnapshot,
  AgentThinkingLevel,
  AgentWindowNode,
  CodexPlanSnapshot,
  PendingAgentApproval,
  PendingQuestion,
  QueuedAgentMessage,
  RecentAgentSessionSummary,
} from '@/types'
import { useStore } from '@/lib/store'
import { AgentIcon } from '@/components/agent-icon'
import { AgentEmptyStateHint } from './agent-empty-state-hint'
import { AgentMarkdown } from './agent-markdown'
import { AgentAuthCard } from './agent-auth-card'
import {
  ContextUsageIndicator,
  ModelPicker,
  PERMISSION_MODE_OPTIONS,
  PermissionPicker,
  THINKING_LEVEL_LABEL_MAP,
  ThinkingPicker,
  getDefaultPermissionMode,
  prettifyModelId,
} from './agent-composer-toolbar'
import { AgentTurnCard } from './agent-turn-card'
import { LoadingIndicator } from './agent-loading-indicator'
import { SessionDiffsPanel } from './session-diffs-panel'
import { InlineMentionMenu, useInlineMention } from './inline-mention-menu'
import { sumDiffStats, hasDiffStats } from '@/lib/tool-diff-stats'
import {
  deriveAgentSessionWindowStatus,
  getInFlightAgentMessages,
} from '@/lib/agent-session-activity'
import { cn } from '@/lib/utils'
import { computeStableList, createEmptyStableListState } from '@/lib/stable-list'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Kbd } from '@/components/ui/kbd'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { LegendList, type LegendListRef } from '@legendapp/list/react'

interface AgentChatPanelProps {
  agentWindow: AgentWindowNode
}

// Copied and adapted from Craft Agents OSS:
// ../craft-agents-oss/apps/electron/src/renderer/pages/ChatPage.tsx
// ../craft-agents-oss/apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx
// ../craft-agents-oss/apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx
// ../craft-agents-oss/packages/ui/src/components/chat/UserMessageBubble.tsx

const EASE_OUT = [0.25, 0.46, 0.45, 0.94] as const
// Shared-element morphs read as "one thing moving into another". Emil's
// guidance: ease-in-out for on-screen movement (not entering/exiting),
// <300ms, transform+opacity only. Slightly slower than the queue's
// enter/exit so the morph reads as intentional motion, not a jank.
const EASE_IN_OUT = [0.645, 0.045, 0.355, 1] as const

function getComposerPlaceholder(agent: AgentWindowNode['agent']) {
  return agent === 'claude' ? 'Message Claude Code…' : 'Message Codex…'
}

function getAgentDisplayName(agent: AgentWindowNode['agent']) {
  return agent === 'claude' ? 'Claude Code' : 'Codex'
}

function truncateCwd(cwd: string | null | undefined) {
  if (!cwd) return null
  const home = '/Users/raj'
  if (cwd.startsWith(home)) return '~' + cwd.slice(home.length)
  return cwd
}

function formatRelativeTime(timestamp: number) {
  const deltaMs = Math.max(0, Date.now() - timestamp)
  const deltaMinutes = Math.floor(deltaMs / 60_000)
  if (deltaMinutes < 1) return 'just now'
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`
  const deltaHours = Math.floor(deltaMinutes / 60)
  if (deltaHours < 24) return `${deltaHours}h ago`
  const deltaDays = Math.floor(deltaHours / 24)
  if (deltaDays < 7) return `${deltaDays}d ago`
  return new Date(timestamp).toLocaleDateString()
}

function formatElapsedMs(startedAt: number | null | undefined) {
  if (!startedAt) return null
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  const elapsedSeconds = Math.floor(elapsedMs / 1000)
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function getActivityPreview(message: AgentSessionMessage) {
  const metadata = parseJsonObject(message.metadata)
  const textObject = parseJsonObject(message.text)
  const command =
    typeof metadata?.command === 'string'
      ? metadata.command
      : typeof textObject?.command === 'string'
        ? textObject.command
        : null
  const description =
    typeof metadata?.description === 'string'
      ? metadata.description
      : typeof textObject?.description === 'string'
        ? textObject.description
        : null
  const cwd =
    typeof metadata?.cwd === 'string'
      ? metadata.cwd
      : typeof textObject?.cwd === 'string'
        ? textObject.cwd
        : typeof message.metadata === 'string' && message.metadata.startsWith('/')
          ? message.metadata
          : null
  const previewSource =
    description ||
    command ||
    message.text.split('\n').find((line) => line.trim().length > 0) ||
    message.title ||
    'Working'
  return {
    preview: previewSource.length > 160 ? `${previewSource.slice(0, 160)}…` : previewSource,
    cwd,
  }
}

function normalizeFsPath(value: string | null | undefined) {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed
}

function isPathWithin(
  candidatePath: string | null | undefined,
  rootPath: string | null | undefined,
) {
  const candidate = normalizeFsPath(candidatePath)
  const root = normalizeFsPath(rootPath)
  if (!candidate || !root) return false
  return candidate === root || candidate.startsWith(`${root}/`)
}

function filterRecentSessionsForProject(
  sessions: RecentAgentSessionSummary[],
  projectPath: string | null | undefined,
  worktrees: Array<{ path: string; isBare?: boolean }>,
) {
  const roots = Array.from(
    new Set(
      [
        normalizeFsPath(projectPath),
        ...worktrees
          .filter((worktree) => !worktree.isBare)
          .map((worktree) => normalizeFsPath(worktree.path)),
      ].filter((value): value is string => Boolean(value)),
    ),
  )
  if (roots.length === 0) return sessions
  return sessions.filter((session) => roots.some((root) => isPathWithin(session.cwd, root)))
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

function isImagePath(p: string): boolean {
  const i = p.lastIndexOf('.')
  if (i < 0) return false
  return IMAGE_EXTENSIONS.has(p.slice(i).toLowerCase())
}

function useFileThumbnail(path: string, enabled = true, maxHeight = 96) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    window.cells.app
      .fileThumbnail(path, maxHeight)
      .then((resolved) => {
        if (!cancelled) setUrl(resolved)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, maxHeight, path])

  return enabled ? url : null
}

function AttachmentThumbnail({ path }: { path: string }) {
  const url = useFileThumbnail(path)
  const name = path.split('/').pop() || path
  const open = () => {
    void window.cells.app.revealPath(path).catch(() => {})
  }
  if (!url) {
    return (
      <button
        type="button"
        onClick={open}
        title={`Open ${path}`}
        className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[8px] bg-foreground/10 text-[10px] text-muted-foreground/70 transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
      >
        <Paperclip className="size-3.5" />
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={open}
      title={`Open ${path}`}
      className="shrink-0 rounded-[8px] transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
    >
      <img
        src={url}
        alt={name}
        className="h-16 w-16 rounded-[8px] border border-border/30 object-cover"
      />
    </button>
  )
}

function AttachmentPill({ path }: { path: string }) {
  const name = path.split('/').pop() || path
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[6px] bg-foreground/5 px-2 py-0.5 text-[11px] text-muted-foreground/90"
      title={path}
    >
      <Paperclip className="size-3" />
      <span className="truncate max-w-[180px] font-mono">{name}</span>
    </span>
  )
}

// Tiny inline thumbnail used inside queued-message rows where horizontal
// space is at a premium. Shows a 16px image preview for image attachments
// and a paperclip icon for anything else.
function QueueAttachmentThumb({ path }: { path: string }) {
  const name = path.split('/').pop() || path
  const isImage = isImagePath(path)
  const url = useFileThumbnail(path, isImage)
  if (isImage && url) {
    return (
      <img
        src={url}
        alt=""
        title={name}
        className="size-4 shrink-0 rounded-[3px] border border-border/40 object-cover"
      />
    )
  }
  return (
    <span
      title={name}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] border border-border/40 bg-foreground/5 text-muted-foreground/80"
    >
      <Paperclip className="size-2.5" />
    </span>
  )
}

function ComposerImagePreviewDialog({
  path,
  onClose,
}: {
  path: string | null
  onClose: () => void
}) {
  const name = path?.split('/').pop() || path || ''
  const url = useFileThumbnail(path ?? '', Boolean(path), 1400)

  return (
    <Dialog
      open={Boolean(path)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        showCloseButton
        className="max-h-[calc(100vh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-[1280px] overflow-hidden border border-border/40 bg-[oklch(0.12_0.004_285)] p-0"
      >
        <DialogTitle className="sr-only">{name || 'Image preview'}</DialogTitle>
        <div className="flex min-h-0 max-h-[calc(100vh-1.5rem)] flex-col">
          <div className="flex shrink-0 items-center gap-2 px-2 py-1.5 pr-9">
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground/80">
              {name}
            </span>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center bg-black/60 p-1">
            {url ? (
              <img
                src={url}
                alt={name}
                className="max-h-[calc(100vh-6rem)] max-w-full rounded-[8px] object-contain shadow-2xl"
              />
            ) : (
              <div className="flex h-40 w-40 items-center justify-center rounded-[8px] border border-border/30 bg-background/30 text-muted-foreground/70">
                <Paperclip className="size-7" />
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ComposerImageAttachment({
  path,
  onPreview,
  onRemove,
}: {
  path: string
  onPreview: () => void
  onRemove: () => void
}) {
  const name = path.split('/').pop() || path
  const url = useFileThumbnail(path, true, 192)

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={onPreview}
        title={`Preview ${name}`}
        className="group/image relative overflow-hidden rounded-[12px] border border-border/35 bg-foreground/5 transition-colors hover:border-border/60 hover:bg-foreground/8 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
      >
        {url ? (
          <img src={url} alt={name} className="h-20 w-20 object-cover" />
        ) : (
          <div className="flex h-20 w-20 items-center justify-center text-muted-foreground/70">
            <Paperclip className="size-5" />
          </div>
        )}
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
        aria-label={`Remove ${name}`}
        className="absolute right-1 top-1 rounded-full border border-black/20 bg-black/55 p-1 text-white/80 backdrop-blur transition-colors hover:bg-black/75 hover:text-white"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

// Non-image composer attachments stay compact and text-first. Image attachments
// use the larger preview tiles above instead.
function ComposerAttachmentChip({ path, onRemove }: { path: string; onRemove: () => void }) {
  const name = path.split('/').pop() || path
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[6px] bg-foreground/5 py-0.5 pl-1 pr-1 text-[11px] text-muted-foreground/90"
      title={path}
    >
      <Paperclip className="ml-1 size-3" />
      <span className="max-w-[180px] truncate font-mono">{name}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="ml-0.5 rounded p-0.5 text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

function UserBubble({
  message,
  morphLayoutId,
  onMorphComplete,
}: {
  message: AgentSessionMessage
  morphLayoutId?: string
  onMorphComplete?: () => void
}) {
  // Deliberately tighter than Craft's bubble — the user asked for a more
  // compact message pill than Craft's (px-4 py-2.5 text-sm with wider max-w).
  const attachments = message.attachments ?? []
  const images = attachments.filter(isImagePath)
  const others = attachments.filter((p) => !isImagePath(p))
  const hasText = message.text.trim().length > 0
  return (
    <div className="mt-8 flex w-full justify-end">
      <motion.div
        // When `morphLayoutId` is set, this bubble pairs with a matching
        // layoutId on the composer pill or the exiting queue row. Framer
        // morphs this element FROM the source's bounding box — transform
        // +opacity only per Emil's animation rules.
        layoutId={morphLayoutId}
        onLayoutAnimationComplete={onMorphComplete}
        transition={{ layout: { duration: 0.26, ease: EASE_IN_OUT } }}
        className="flex max-w-[78%] flex-col items-end gap-1.5 select-text"
      >
        {images.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map((p) => (
              <AttachmentThumbnail key={p} path={p} />
            ))}
          </div>
        ) : null}
        {hasText ? (
          <div className="break-words rounded-[10px] bg-foreground/5 px-3.5 py-2 text-[13px] leading-[1.45] text-foreground">
            <AgentMarkdown inline breaks>
              {message.text}
            </AgentMarkdown>
          </div>
        ) : null}
        {others.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1">
            {others.map((p) => (
              <AttachmentPill key={p} path={p} />
            ))}
          </div>
        ) : null}
      </motion.div>
    </div>
  )
}

function SystemLine({ message }: { message: AgentSessionMessage }) {
  return (
    <div className="flex items-center gap-2 px-3 py-0.5 text-[12px] text-muted-foreground select-none">
      <span className="h-px flex-1 bg-border/40" />
      <span className="shrink-0">{message.text}</span>
      <span className="h-px flex-1 bg-border/40" />
    </div>
  )
}

function CompactionLine({ message }: { message: AgentSessionMessage }) {
  const isRunning = message.status === 'in_progress'
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[12px] text-muted-foreground/55 select-none">
      <span className="h-px flex-1 bg-border/30" />
      <span className="flex shrink-0 items-center gap-1.5">
        {isRunning ? (
          <Loader2 className="size-3 animate-spin text-muted-foreground/40" />
        ) : (
          <ArchiveRestore className="size-3 text-muted-foreground/40" />
        )}
        <span>{message.text}</span>
      </span>
      <span className="h-px flex-1 bg-border/30" />
    </div>
  )
}

function ErrorBubble({ message }: { message: AgentSessionMessage }) {
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[92%] rounded-[10px] border border-red-500/25 bg-red-500/8 px-4 py-3 text-[12.5px] text-red-300 select-text">
        <div className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.14em] text-red-400/85">
          {message.title || 'Error'}
        </div>
        <div className="whitespace-pre-wrap break-words">{message.text}</div>
      </div>
    </div>
  )
}

type QueuedMessage = QueuedAgentMessage
const ATTACHMENTS_ONLY_TEXT = '(attached files)'

function sanitizeQueuedMessages(messages: QueuedMessage[]): QueuedMessage[] {
  return messages.filter((message) => message.mode !== 'stop')
}

function getQueuedComposerText(message: QueuedMessage) {
  return message.attachments.length > 0 && message.text === ATTACHMENTS_ONLY_TEXT
    ? ''
    : message.text
}

function getQueuedStoredText(text: string, attachments: string[]) {
  const trimmed = text.trim()
  if (trimmed) return trimmed
  return attachments.length > 0 ? ATTACHMENTS_ONLY_TEXT : ''
}

const QUEUE_MODE_META: Record<
  QueuedMessage['mode'],
  { Icon: typeof Zap; tint: string; shortcut: string; hint: string; label: string }
> = {
  stop: {
    Icon: Zap,
    tint: 'text-rose-400/90',
    shortcut: '⌘↩',
    label: 'Interrupt',
    hint: 'Interrupt the agent now and send this next.',
  },
  'after-tool': {
    Icon: FastForward,
    tint: 'text-violet-400/90',
    shortcut: '⌥↩',
    label: 'After next tool',
    hint: 'Send as soon as the next tool call finishes — don’t cut off a running tool.',
  },
  'after-turn': {
    Icon: Clock,
    tint: 'text-amber-400/90',
    shortcut: '↩',
    label: 'After this turn',
    hint: 'Send after the current turn finishes naturally.',
  },
}

type ChatGroup =
  | { kind: 'user'; key: string; message: AgentSessionMessage }
  | {
      kind: 'turn'
      key: string
      activities: AgentSessionMessage[]
      responses: AgentSessionMessage[]
      changedFilesActivities?: AgentSessionMessage[]
      // When present, this group came from an explicit backend turn boundary
      // (currently Codex's `tN-...` item ids), not our renderer heuristic.
      // Keep those groups intact even if assistant prose lands between tools.
      turnBoundaryKey?: string | null
      // Interim assistant text that preceded this turn's tool calls. When the
      // agent emits prose between tool groups, we demote that prose from its
      // own ResponseCard into the next turn's header line — it reads as the
      // intent behind the upcoming activity instead of a separate bubble.
      leadText?: string
    }
  | { kind: 'error'; key: string; message: AgentSessionMessage }
  | { kind: 'auth'; key: string; message: AgentSessionMessage }
  | { kind: 'system'; key: string; message: AgentSessionMessage }
  | { kind: 'compaction'; key: string; message: AgentSessionMessage }

function areStringArraysEqual(previous: string[] | undefined, next: string[] | undefined): boolean {
  if (previous === next) return true
  if (!previous || !next) return !previous && !next
  if (previous.length !== next.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false
  }
  return true
}

function isAgentSessionMessageUnchanged(
  previous: AgentSessionMessage,
  next: AgentSessionMessage,
): boolean {
  return (
    previous.id === next.id &&
    previous.role === next.role &&
    previous.text === next.text &&
    previous.title === next.title &&
    previous.metadata === next.metadata &&
    previous.status === next.status &&
    previous.startedAt === next.startedAt &&
    previous.updatedAt === next.updatedAt &&
    previous.authLoginUrl === next.authLoginUrl &&
    previous.parentToolUseId === next.parentToolUseId &&
    previous.toolUseId === next.toolUseId &&
    areStringArraysEqual(previous.attachments, next.attachments)
  )
}

function areMessageRefsEqual(
  previous: AgentSessionMessage[],
  next: AgentSessionMessage[],
): boolean {
  if (previous === next) return true
  if (previous.length !== next.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false
  }
  return true
}

function isChatGroupUnchanged(previous: ChatGroup, next: ChatGroup): boolean {
  if (previous.kind !== next.kind || previous.key !== next.key) return false
  switch (previous.kind) {
    case 'user':
    case 'error':
    case 'auth':
    case 'system':
    case 'compaction':
      return previous.message === (next as typeof previous).message
    case 'turn': {
      const nextTurn = next as typeof previous
      return (
        areMessageRefsEqual(
          previous.changedFilesActivities ?? [],
          nextTurn.changedFilesActivities ?? [],
        ) &&
        previous.turnBoundaryKey === nextTurn.turnBoundaryKey &&
        previous.leadText === nextTurn.leadText &&
        areMessageRefsEqual(previous.activities, nextTurn.activities) &&
        areMessageRefsEqual(previous.responses, nextTurn.responses)
      )
    }
    default:
      return false
  }
}

/**
 * Group messages into Craft-style turns:
 *   - Each user message stands alone.
 *   - Consecutive non-user messages collapse into a single "turn" whose
 *     assistant messages become the response and whose reasoning / tool /
 *     system messages become the activities stripe.
 *   - Errors and auth prompts are lifted out of the group so they render
 *     as their own cards (matches Craft).
 */
function chatGroupKey(group: ChatGroup): string {
  return group.key
}

function getExplicitTurnBoundaryKey(message: AgentSessionMessage): string | null {
  const match = /^(t\d+)-/.exec(message.id)
  return match ? match[1] : null
}

function turnHasVisibleResponse(group: Extract<ChatGroup, { kind: 'turn' }>) {
  return group.responses.some((response) => response.text.trim().length > 0)
}

function finalizeTurnGroups(groups: ChatGroup[]): ChatGroup[] {
  const nextGroups = groups.slice()
  let runStart = 0

  const finalizeRun = (start: number, endExclusive: number) => {
    if (start >= endExclusive) return
    let anchorIndex = -1
    let lastActivityIndex = -1
    const aggregatedActivities: AgentSessionMessage[] = []

    for (let index = start; index < endExclusive; index += 1) {
      const group = nextGroups[index]
      if (group.kind !== 'turn') return
      aggregatedActivities.push(...group.activities)
      if (group.activities.length > 0) lastActivityIndex = index
    }

    if (lastActivityIndex >= start) {
      for (let index = lastActivityIndex; index < endExclusive; index += 1) {
        const group = nextGroups[index]
        if (group.kind === 'turn' && turnHasVisibleResponse(group)) anchorIndex = index
      }
    }

    for (let index = start; index < endExclusive; index += 1) {
      const group = nextGroups[index]
      if (group.kind !== 'turn') continue
      const changedFilesActivities = index === anchorIndex ? aggregatedActivities : undefined
      if (areMessageRefsEqual(group.changedFilesActivities ?? [], changedFilesActivities ?? []))
        continue
      nextGroups[index] = { ...group, changedFilesActivities }
    }
  }

  for (let index = 0; index <= nextGroups.length; index += 1) {
    const group = nextGroups[index]
    if (group?.kind === 'turn') continue
    finalizeRun(runStart, index)
    runStart = index + 1
  }

  return nextGroups
}

function groupMessages(messages: AgentSessionMessage[]): ChatGroup[] {
  const groups: ChatGroup[] = []
  let pending: {
    activities: AgentSessionMessage[]
    responses: AgentSessionMessage[]
    turnBoundaryKey: string | null
  } | null = null
  let turnIndex = 0

  const flushPending = () => {
    if (!pending) return
    if (pending.activities.length === 0 && pending.responses.length === 0) {
      pending = null
      return
    }
    groups.push({
      kind: 'turn',
      key: pending.turnBoundaryKey ?? `turn-${turnIndex++}`,
      activities: pending.activities,
      responses: pending.responses,
      turnBoundaryKey: pending.turnBoundaryKey,
    })
    pending = null
  }

  for (const message of messages) {
    // Subagent traffic (anything with a parentToolUseId) belongs INSIDE the
    // Task tool row, not as its own group. The parent Task row renders it
    // hierarchically via AgentTurnCard. We still push those messages into the
    // pending activities so the TurnCard can look them up — user bubbles from
    // subagents are dropped entirely since they're system-prompt noise.
    if (message.parentToolUseId) {
      if (message.role === 'user') continue
      if (!pending) pending = { activities: [], responses: [], turnBoundaryKey: null }
      // Assistant text from a subagent still lives in the activities stripe
      // (rendered as a child of the Task row), not as the top-level response.
      pending.activities.push(message)
      continue
    }

    switch (message.role) {
      case 'user':
        flushPending()
        groups.push({ kind: 'user', key: message.id, message })
        break
      case 'error':
        flushPending()
        groups.push({ kind: 'error', key: message.id, message })
        break
      case 'auth_request':
        flushPending()
        groups.push({ kind: 'auth', key: message.id, message })
        break
      case 'compaction':
        flushPending()
        groups.push({ kind: 'compaction', key: message.id, message })
        break
      case 'assistant':
      case 'reasoning':
      case 'tool':
      case 'system': {
        const turnBoundaryKey = getExplicitTurnBoundaryKey(message)
        if (
          pending &&
          pending.turnBoundaryKey &&
          turnBoundaryKey &&
          pending.turnBoundaryKey !== turnBoundaryKey
        ) {
          flushPending()
        }
        // Preserve chronological order of assistant text vs tool activity.
        // Whenever a non-assistant message (tool / reasoning / system) arrives
        // after any assistant response has already landed in the current turn,
        // close that turn and open a new one. Without this, a sequence like
        // [tool, tool, text, tool, tool] would collapse both tool pairs into
        // a single activities stripe above one response — the second pair
        // needs to render BELOW the text, not merged with the first pair.
        //
        // Codex exposes a real turn boundary in its generated message ids
        // (`tN-...`). When we have that explicit boundary, keep the whole turn
        // together instead of splitting on assistant prose.
        if (
          message.role !== 'assistant' &&
          pending &&
          pending.responses.length > 0 &&
          !pending.turnBoundaryKey &&
          !turnBoundaryKey
        ) {
          flushPending()
        }
        if (!pending) pending = { activities: [], responses: [], turnBoundaryKey }
        if (message.role === 'assistant') pending.responses.push(message)
        else pending.activities.push(message)
        break
      }
      default:
        break
    }
  }
  flushPending()
  return finalizeTurnGroups(demoteInterimResponses(groups))
}

// Walks the grouped output and moves any "interim" assistant responses
// (responses in a turn that is immediately followed by another turn) into
// the next turn's `leadText`. The current turn keeps only its activities;
// if it had no activities either, it is dropped entirely.
//
// Example: [tool_a, tool_b, text, tool_c, tool_d] groups as
//   turn1(acts=[a,b], resp=[text]) + turn2(acts=[c,d])
// After demotion:
//   turn1(acts=[a,b]) + turn2(acts=[c,d], leadText=text)
function demoteInterimResponses(groups: ChatGroup[]): ChatGroup[] {
  const working: ChatGroup[] = groups.slice()
  const result: ChatGroup[] = []
  for (let i = 0; i < working.length; i++) {
    const g = working[i]
    if (g.kind === 'turn' && g.responses.length > 0) {
      const next = working[i + 1]
      if (
        next &&
        next.kind === 'turn' &&
        next.activities.length > 0 &&
        !g.turnBoundaryKey &&
        !next.turnBoundaryKey
      ) {
        const leadText = g.responses
          .map((r) => r.text)
          .join('\n\n')
          .trim()
        working[i + 1] = { ...next, leadText: leadText || next.leadText }
        if (g.activities.length > 0) {
          result.push({
            kind: 'turn',
            key: g.key,
            activities: g.activities,
            responses: [],
            turnBoundaryKey: g.turnBoundaryKey,
          })
        }
        continue
      }
    }
    result.push(g)
  }
  return result
}

// Craft-style "working" pill shown while the agent is running but hasn't
// produced a turn yet. Matches the ⋮⋮ Zipping… 4s row under the user bubble.
function PendingTurnIndicator({ agent }: { agent: AgentWindowNode['agent'] }) {
  return (
    <LoadingIndicator
      label={`${agent === 'claude' ? 'Claude Code' : 'Codex'} is thinking`}
      showElapsed
      className="text-[12px] text-muted-foreground"
    />
  )
}

// Banner shown above the composer while Claude has called ExitPlanMode and
// is waiting on the user's decision. Mirrors the Claude Code CLI's three
// prompt options verbatim: auto-accept, manually approve, or keep planning.
function CodexPlanBanner({ plan }: { plan: CodexPlanSnapshot }) {
  const [collapsed, setCollapsed] = useState(false)
  const total = plan.items.length
  const done = plan.items.filter((item) => item.completed).length
  if (total === 0) return null
  return (
    <div className="mb-2 rounded-[12px] border border-sky-300/12 bg-[linear-gradient(180deg,rgba(8,35,47,0.92),rgba(10,23,31,0.96))] px-3 py-2 text-[12px] text-foreground/90 shadow-[inset_0_1px_0_rgba(125,211,252,0.08),0_0_0_1px_rgba(12,18,24,0.35)]">
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        className="flex w-full items-center gap-2 text-left"
      >
        <ListTodo className="size-3.5 shrink-0 text-sky-300/90" />
        <span className="flex-1 text-[11px] font-medium uppercase tracking-[0.12em] text-sky-300/90">
          Plan
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground/80">
          {done}/{total}
        </span>
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/70 transition-transform',
            !collapsed && 'rotate-90',
          )}
        />
      </button>
      {!collapsed ? (
        <ul className="mt-1.5 flex flex-col gap-1">
          {plan.items.map((item, idx) => (
            <li key={`${idx}-${item.text}`} className="flex items-start gap-2">
              {item.completed ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-400/90" />
              ) : (
                <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50" />
              )}
              <span
                className={cn(
                  'min-w-0 flex-1 break-words leading-[1.45]',
                  item.completed && 'text-muted-foreground/70 line-through',
                )}
              >
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function AgentApprovalBanner({
  windowId,
  approval,
}: {
  windowId: string
  approval: PendingAgentApproval
}) {
  const [busy, setBusy] = useState<'accept' | 'acceptForSession' | 'decline' | null>(null)
  const respond = useCallback(
    async (decision: 'accept' | 'acceptForSession' | 'decline') => {
      if (busy) return
      setBusy(decision)
      try {
        await window.cells.agentSession.respondApproval(windowId, decision)
      } catch (err) {
        console.error('[agent-chat] respondApproval failed', err)
      } finally {
        setBusy(null)
      }
    },
    [busy, windowId],
  )

  return (
    <div className="mb-2 rounded-[12px] border border-amber-400/25 bg-amber-400/5 px-3 py-2.5 text-[12px] text-foreground/90 shadow-minimal">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-amber-300/90">
        <ShieldCheck className="size-3.5" />
        <span>{approval.title}</span>
      </div>
      <div className="space-y-1.5">
        {approval.detail ? (
          <div className="rounded-[8px] border border-border/50 bg-background/50 px-2.5 py-2 text-[12px] leading-[1.45] text-foreground/90">
            {approval.detail}
          </div>
        ) : null}
        {approval.reason ? (
          <div className="text-[11px] leading-[1.45] text-muted-foreground/80">
            Reason: {approval.reason}
          </div>
        ) : null}
        {approval.cwd ? (
          <div className="text-[11px] leading-[1.45] text-muted-foreground/80">
            Cwd: {truncateCwd(approval.cwd)}
          </div>
        ) : null}
        {approval.grantRoot ? (
          <div className="text-[11px] leading-[1.45] text-muted-foreground/80">
            Grant root: {truncateCwd(approval.grantRoot)}
          </div>
        ) : null}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void respond('decline')}
          className="rounded-[6px] px-2 py-1 text-[11.5px] text-muted-foreground/80 hover:bg-foreground/5 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
        >
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </button>
        {approval.canApproveForSession ? (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void respond('acceptForSession')}
            className="rounded-[6px] border border-border/60 bg-background/60 px-2.5 py-1 text-[11.5px] font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-foreground/5 disabled:cursor-wait disabled:opacity-60"
          >
            {busy === 'acceptForSession' ? 'Approving…' : 'Allow for session'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void respond('accept')}
          className="rounded-[6px] bg-amber-400 px-2.5 py-1 text-[11.5px] font-medium text-background transition-colors hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
        >
          {busy === 'accept' ? 'Approving…' : 'Allow once'}
        </button>
      </div>
    </div>
  )
}

function PlanApprovalBanner({ windowId }: { windowId: string }) {
  const [busy, setBusy] = useState<'auto-accept' | 'ask' | 'reject' | null>(null)
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')
  const respond = useCallback(
    async (decision: 'auto-accept' | 'ask' | 'reject', note?: string) => {
      if (busy) return
      setBusy(decision)
      try {
        await window.cells.agentSession.respondPlan(windowId, decision, note)
        // Backend flipped its own permission mode — mirror that into the
        // zustand store so the PermissionPicker chip updates immediately
        // instead of drifting out of sync until the user touches it.
        if (decision === 'auto-accept') {
          useStore.getState().syncAgentWindow(windowId, { permissionMode: 'bypass' })
        } else if (decision === 'ask') {
          useStore.getState().syncAgentWindow(windowId, { permissionMode: 'ask' })
        }
      } catch (err) {
        console.error('[agent-chat] respondPlan failed', err)
      } finally {
        setBusy(null)
      }
    },
    [busy, windowId],
  )
  const optionClass =
    'flex w-full items-start gap-2 rounded-[10px] border border-border/60 bg-background/60 px-3 py-2 text-left text-[12px] transition-colors hover:border-foreground/30 hover:bg-foreground/5 disabled:cursor-wait disabled:opacity-60'
  return (
    <div className="mb-2 rounded-[12px] border border-emerald-400/25 bg-emerald-500/5 px-3 py-2.5 text-[12px] text-foreground/90 shadow-minimal">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-emerald-300/90">
        <ShieldCheck className="size-3.5" />
        <span>Would you like to proceed?</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void respond('auto-accept')}
          className={cn(optionClass, 'hover:border-emerald-400/60 hover:bg-emerald-500/10')}
        >
          <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-[10px] font-medium text-emerald-300/90">
            1
          </span>
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="font-medium text-foreground">
              {busy === 'auto-accept' ? 'Starting…' : 'Yes, and auto-accept edits'}
            </span>
            <span className="text-[11px] text-muted-foreground/80">
              Switch to Yolo — Claude runs tools without asking.
            </span>
          </span>
          <Zap className="mt-0.5 size-3.5 shrink-0 text-emerald-300/80" />
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void respond('ask')}
          className={optionClass}
        >
          <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[10px] font-medium text-foreground/80">
            2
          </span>
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="font-medium text-foreground">
              {busy === 'ask' ? 'Starting…' : 'Yes, and manually approve edits'}
            </span>
            <span className="text-[11px] text-muted-foreground/80">
              Switch to Ask — approve each write/bash individually.
            </span>
          </span>
          <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => setShowFeedback((v) => !v)}
          className={optionClass}
        >
          <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[10px] font-medium text-foreground/80">
            3
          </span>
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="font-medium text-foreground">No, keep planning</span>
            <span className="text-[11px] text-muted-foreground/80">
              Stay in Plan mode
              {showFeedback ? ' — add feedback below' : ' — optionally add feedback'}.
            </span>
          </span>
          <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
        </button>
      </div>
      {showFeedback ? (
        <div className="mt-2 space-y-1.5">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            placeholder="What should Claude change about the plan? (optional)"
            className="block w-full resize-none rounded-[8px] border border-border/50 bg-background/80 px-2.5 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-foreground/30"
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              disabled={!!busy}
              onClick={() => {
                setShowFeedback(false)
                setFeedback('')
              }}
              className="rounded-[6px] px-2 py-1 text-[11.5px] text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void respond('reject', feedback)}
              className="rounded-[6px] bg-foreground px-2.5 py-1 text-[11.5px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-wait disabled:opacity-60"
            >
              {busy === 'reject' ? 'Sending…' : feedback.trim() ? 'Send feedback' : 'Keep planning'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// Banner shown above the composer while Claude has called AskUserQuestion and
// is waiting on the user's answers. One group per question, rendered as radio
// (single-select) or checkbox (multi-select) lists. Submitting sends the
// answers back through canUseTool; Dismiss tells the agent to proceed
// without the input.
function QuestionBanner({
  windowId,
  agent,
  questions,
}: {
  windowId: string
  agent: AgentWindowNode['agent']
  questions: PendingQuestion[]
}) {
  const questionKey = useCallback((q: PendingQuestion) => q.id || q.question, [])
  const [selections, setSelections] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {}
    for (const q of questions) init[questionKey(q)] = []
    return init
  })
  const [busy, setBusy] = useState<'submit' | 'cancel' | null>(null)

  const toggle = useCallback((q: PendingQuestion, label: string) => {
    const key = q.id || q.question
    setSelections((prev) => {
      const current = prev[key] ?? []
      if (q.multiSelect) {
        const has = current.includes(label)
        const next = has ? current.filter((x) => x !== label) : [...current, label]
        return { ...prev, [key]: next }
      }
      return { ...prev, [key]: [label] }
    })
  }, [])

  const canSubmit = questions.every((q) => (selections[questionKey(q)]?.length ?? 0) > 0)

  const submit = useCallback(async () => {
    if (busy || !canSubmit) return
    setBusy('submit')
    try {
      await window.cells.agentSession.respondQuestion(windowId, selections)
    } catch (err) {
      console.error('[agent-chat] respondQuestion failed', err)
    } finally {
      setBusy(null)
    }
  }, [busy, canSubmit, selections, windowId])

  const cancel = useCallback(async () => {
    if (busy) return
    setBusy('cancel')
    try {
      await window.cells.agentSession.respondQuestion(windowId, null)
    } catch (err) {
      console.error('[agent-chat] respondQuestion cancel failed', err)
    } finally {
      setBusy(null)
    }
  }, [busy, windowId])

  return (
    <div className="mb-2 rounded-[12px] border border-sky-400/25 bg-sky-500/5 px-3 py-2.5 text-[12px] text-foreground/90 shadow-minimal">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-sky-300/90">
        <HelpCircle className="size-3.5" />
        <span>
          {questions.length === 1
            ? `${getAgentDisplayName(agent)} needs an answer`
            : `${getAgentDisplayName(agent)} needs ${questions.length} answers`}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {questions.map((q) => {
          const selected = selections[questionKey(q)] ?? []
          return (
            <div key={questionKey(q)} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                {q.header ? (
                  <span className="shrink-0 rounded-[4px] bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground/70 shadow-minimal">
                    {q.header}
                  </span>
                ) : null}
                <span className="text-[12.5px] font-medium text-foreground">{q.question}</span>
                {q.multiSelect ? (
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground/60">
                    Multi-select
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col gap-1">
                {q.options.map((opt) => {
                  const isSelected = selected.includes(opt.label)
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={!!busy}
                      onClick={() => toggle(q, opt.label)}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-[10px] border px-3 py-2 text-left text-[12px] transition-colors disabled:cursor-wait disabled:opacity-60',
                        isSelected
                          ? 'border-sky-400/60 bg-sky-500/10'
                          : 'border-border/60 bg-background/60 hover:border-foreground/30 hover:bg-foreground/5',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 inline-flex size-4 shrink-0 items-center justify-center',
                          q.multiSelect ? 'rounded-[4px]' : 'rounded-full',
                          isSelected
                            ? 'bg-sky-500/80 text-background'
                            : 'border border-border/70 bg-background/60',
                        )}
                      >
                        {isSelected ? <Check className="size-2.5" /> : null}
                      </span>
                      <span className="flex flex-1 flex-col gap-0.5">
                        <span className="font-medium text-foreground">{opt.label}</span>
                        {opt.description ? (
                          <span className="text-[11px] text-muted-foreground/80">
                            {opt.description}
                          </span>
                        ) : null}
                        {opt.preview ? (
                          <pre className="mt-1 max-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-[6px] border border-border/40 bg-background/60 px-2 py-1 font-mono text-[11px] leading-[1.45] text-foreground/75">
                            {opt.preview}
                          </pre>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-2.5 flex items-center justify-end gap-1.5">
        {agent === 'claude' ? (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void cancel()}
            className="rounded-[6px] px-2 py-1 text-[11.5px] text-muted-foreground/80 hover:bg-foreground/5 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
          >
            {busy === 'cancel' ? 'Dismissing…' : 'Skip'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={!!busy || !canSubmit}
          onClick={() => void submit()}
          className="rounded-[6px] bg-sky-500 px-2.5 py-1 text-[11.5px] font-medium text-background transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'submit' ? 'Sending…' : 'Send answer'}
        </button>
      </div>
    </div>
  )
}

function BackgroundActivityBanner({
  agent,
  activities,
  onStop,
}: {
  agent: AgentWindowNode['agent']
  activities: AgentSessionMessage[]
  onStop: () => void
}) {
  const oldestStartedAt = activities.reduce<number | null>((oldest, activity) => {
    const startedAt = activity.startedAt ?? activity.updatedAt ?? null
    if (!startedAt) return oldest
    return oldest == null ? startedAt : Math.min(oldest, startedAt)
  }, null)
  const elapsed = formatElapsedMs(oldestStartedAt)
  const agentName = getAgentDisplayName(agent)

  return (
    <div className="mb-2 select-none">
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground/70" />
        <div className="min-w-0 flex-1">
          <span className="truncate text-[12px] font-medium text-foreground/90">
            {activities.length === 1
              ? `${agentName} is still running in the background`
              : `${agentName} still has ${activities.length} background tasks running`}
          </span>
          {elapsed ? (
            <span className="ml-1.5 text-[11px] tabular-nums text-muted-foreground/60">
              {elapsed}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onStop}
          className="inline-flex shrink-0 items-center gap-1 rounded-[8px] bg-foreground px-2.5 py-1 text-[11.5px] font-medium text-background shadow-minimal transition-colors hover:bg-foreground/90"
        >
          <Square className="size-3 fill-current" />
          Stop
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {activities.slice(0, 3).map((activity) => {
          const details = getActivityPreview(activity)
          const started = activity.startedAt ? formatElapsedMs(activity.startedAt) : null
          return (
            <div
              key={activity.id}
              className="flex items-center gap-2 rounded-[10px] bg-foreground/5 px-2.5 py-1.5 text-[12px] text-foreground/85"
            >
              <Clock className="size-3.5 shrink-0 text-muted-foreground/60" />
              <span className="shrink-0 truncate font-medium text-foreground/90">
                {activity.title || 'Activity'}
              </span>
              {details.preview ? (
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground/75">
                  {details.preview}
                </span>
              ) : (
                <span className="min-w-0 flex-1" />
              )}
              {started ? (
                <span className="shrink-0 tabular-nums text-[10.5px] text-muted-foreground/60">
                  {started}
                </span>
              ) : null}
            </div>
          )
        })}
        {activities.length > 3 ? (
          <div className="px-2 pt-0.5 text-[10.5px] text-muted-foreground/60">
            +{activities.length - 3} more active {activities.length - 3 === 1 ? 'task' : 'tasks'}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function GroupRenderer({
  group,
  agent,
  isStreamingLastTurn,
  userMorphLayoutId,
  onUserMorphComplete,
}: {
  group: ChatGroup
  agent: AgentWindowNode['agent']
  isStreamingLastTurn: boolean
  userMorphLayoutId?: string
  onUserMorphComplete?: () => void
}) {
  switch (group.kind) {
    case 'user':
      return (
        <UserBubble
          message={group.message}
          morphLayoutId={userMorphLayoutId}
          onMorphComplete={onUserMorphComplete}
        />
      )
    case 'turn':
      return (
        <AgentTurnCard
          activities={group.activities}
          responses={group.responses}
          changedFilesActivities={group.changedFilesActivities}
          leadText={group.leadText}
          agent={agent}
          isStreaming={isStreamingLastTurn}
        />
      )
    case 'error':
      return <ErrorBubble message={group.message} />
    case 'auth':
      return <AgentAuthCard message={group.message} agent={agent} />
    case 'system':
      return <SystemLine message={group.message} />
    case 'compaction':
      return <CompactionLine message={group.message} />
    default:
      return null
  }
}

const MessageGroupRow = memo(
  function MessageGroupRow({
    group,
    agent,
    isStreamingLastTurn,
    userMorphLayoutId,
    onUserMorphComplete,
  }: {
    group: ChatGroup
    agent: AgentWindowNode['agent']
    isStreamingLastTurn: boolean
    userMorphLayoutId?: string
    onUserMorphComplete?: () => void
  }) {
    const reduceMotion = useReducedMotion()
    // `contain: layout style paint` on the wrapper would confine the child's
    // layout measurements, breaking Framer's cross-tree layoutId pairing for
    // the shared-element morph. Disable containment while a morph is active.
    const hasMorph = Boolean(userMorphLayoutId)
    return (
      <motion.div
        className="min-w-0 p-[1px]"
        style={{
          contain: hasMorph ? 'style paint' : 'layout style paint',
          contentVisibility: 'auto',
          containIntrinsicSize: '320px',
        }}
        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: EASE_OUT }}
      >
        <GroupRenderer
          group={group}
          agent={agent}
          isStreamingLastTurn={isStreamingLastTurn}
          userMorphLayoutId={userMorphLayoutId}
          onUserMorphComplete={onUserMorphComplete}
        />
      </motion.div>
    )
  },
  (previous, next) =>
    previous.group === next.group &&
    previous.agent === next.agent &&
    previous.isStreamingLastTurn === next.isStreamingLastTurn &&
    previous.userMorphLayoutId === next.userMorphLayoutId &&
    previous.onUserMorphComplete === next.onUserMorphComplete,
)

export function AgentChatPanel({ agentWindow }: AgentChatPanelProps) {
  const reduceMotion = useReducedMotion()
  const [snapshot, setSnapshot] = useState<AgentSessionSnapshot | null>(null)
  const [messages, setMessages] = useState<AgentSessionMessage[]>([])
  const [groups, setGroups] = useState<ChatGroup[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [composerPreviewPath, setComposerPreviewPath] = useState<string | null>(null)
  const activeProjectPath = useStore(
    (state) => state.projects.find((project) => project.id === state.activeProjectId)?.path ?? null,
  )
  const worktrees = useStore((state) => state.worktrees)
  // Queue is persisted on the AgentWindowNode so it survives app restart.
  // Read straight from the prop (zustand re-renders this component whenever
  // the window patches) and write through `syncAgentWindow` so the change
  // flows out to disk via the debounced projects-state persister.
  const queuedMessages = useMemo<QueuedMessage[]>(
    () => sanitizeQueuedMessages(agentWindow.queuedMessages ?? []),
    [agentWindow.queuedMessages],
  )
  const setQueuedMessages = useCallback(
    (updater: (prev: QueuedMessage[]) => QueuedMessage[]) => {
      const prev = sanitizeQueuedMessages(
        useStore.getState().agentWindows.find((w) => w.id === agentWindow.id)?.queuedMessages ?? [],
      )
      const next = sanitizeQueuedMessages(updater(prev))
      useStore.getState().syncAgentWindow(agentWindow.id, { queuedMessages: next })
    },
    [agentWindow.id],
  )
  useEffect(() => {
    const raw = agentWindow.queuedMessages ?? []
    const sanitized = sanitizeQueuedMessages(raw)
    if (sanitized.length !== raw.length) {
      useStore.getState().syncAgentWindow(agentWindow.id, { queuedMessages: sanitized })
    }
  }, [agentWindow.id, agentWindow.queuedMessages])
  // Only gate resume when the session was actually reconstructed from the
  // persisted snapshot after Cells restarted. Project/window remounts within
  // the same app session should not show the "Continue" banner.
  const [resumeGated, setResumeGated] = useState(false)
  // Separately track mid-turn resumes: the session had an outstanding user
  // turn when the app was closed (last message is a user message with no
  // completed assistant response). Surfaces the Continue banner even when
  // the queue is empty so the user can decide whether to resume.
  const [midTurnDetected, setMidTurnDetected] = useState(false)
  const midTurnAppliedRef = useRef(false)
  const [recentSessions, setRecentSessions] = useState<RecentAgentSessionSummary[]>([])
  const [recentSessionsFade, setRecentSessionsFade] = useState({ top: false, bottom: false })
  // Queue list collapses by default — the header already shows count + a
  // preview of the next message, mirroring AgentTurnCard's activities stripe.
  const [queueCollapsed, setQueueCollapsed] = useState(true)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  // Active drag state for queue reorder — `dragIndex` is the row being dragged,
  // `dragOverIndex` is the row currently under the pointer. Both reset on
  // drop or drag-end.
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  // Shared-element morph plumbing. When a new user message appears, we want
  // the bubble to morph FROM whichever source produced it — the queue row
  // that just drained, or the composer pill. Both live in a different subtree
  // than the LegendList rows, so Framer needs matching `layoutId`s across the
  // tree to run the animation.
  //
  // Flow:
  //  1. On send, we push a morph id onto `pendingMorphsRef` (FIFO). Queue
  //     drains push `queue-morph-${queueKey}` (the same id as the exiting
  //     queue row). Composer sends push a fresh `composer-morph-${n}` and
  //     also set `composerMorphId` so the composer pill carries that id.
  //  2. During render we diff `messages` against `handledUserIdsRef`. The
  //     first never-seen user message pops the FIFO and records a mapping
  //     from message.id → morphId in `morphAssignments`.
  //  3. MessageGroupRow threads that layoutId to UserBubble. When the bubble
  //     mounts, Framer finds a matching layoutId already on-screen (the
  //     exiting queue row or the composer pill) and morphs between them.
  //  4. The composer's stale layoutId is cleared in `onLayoutAnimationComplete`
  //     so subsequent sends get a fresh nonce and don't collide.
  const pendingMorphsRef = useRef<string[]>([])
  const handledUserIdsRef = useRef<Set<string>>(new Set())
  const handledUserIdsInitRef = useRef(false)
  const [morphAssignments, setMorphAssignments] = useState<Record<string, string>>({})
  const [composerMorphId, setComposerMorphId] = useState<string | null>(null)
  const composerMorphNonceRef = useRef(0)
  // Edge-fade state for the queue scroll area. `top` = content above the
  // viewport, `bottom` = content below. We fade each edge only when there's
  // something hidden on that side so the fade itself stays honest.
  const queueScrollRef = useRef<HTMLDivElement | null>(null)
  const [queueScrollFade, setQueueScrollFade] = useState<{ top: boolean; bottom: boolean }>({
    top: false,
    bottom: false,
  })
  const updateQueueScrollFade = useCallback(() => {
    const el = queueScrollRef.current
    if (!el) return
    const { scrollTop, scrollHeight, clientHeight } = el
    const atTop = scrollTop <= 1
    const atBottom = scrollTop + clientHeight >= scrollHeight - 1
    const isScrollable = scrollHeight > clientHeight + 1
    setQueueScrollFade((prev) => {
      const next = {
        top: isScrollable && !atTop,
        bottom: isScrollable && !atBottom,
      }
      if (prev.top === next.top && prev.bottom === next.bottom) return prev
      return next
    })
  }, [])
  useEffect(() => {
    updateQueueScrollFade()
  }, [queuedMessages.length, queueCollapsed, updateQueueScrollFade])
  const interruptMessageRef = useRef<QueuedMessage | null>(null)
  const reorderQueue = useCallback(
    (from: number, to: number) => {
      if (from === to) return
      setQueuedMessages((prev) => {
        if (from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev
        const next = [...prev]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        return next
      })
    },
    [setQueuedMessages],
  )
  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<LegendListRef>(null)
  const recentSessionsViewportRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const inputRef = useRef(input)
  const snapshotRef = useRef(snapshot)
  const windowIdRef = useRef(agentWindow.id)
  const messageStateRef = useRef(createEmptyStableListState<AgentSessionMessage>())
  const groupStateRef = useRef(createEmptyStableListState<ChatGroup>())
  const pendingSnapshotRef = useRef<AgentSessionSnapshot | null>(null)
  const pendingFrameRef = useRef<number | null>(null)
  useEffect(() => {
    inputRef.current = input
  }, [input])
  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])
  useEffect(() => {
    windowIdRef.current = agentWindow.id
  }, [agentWindow.id])
  useEffect(() => {
    messageStateRef.current = createEmptyStableListState<AgentSessionMessage>()
    groupStateRef.current = createEmptyStableListState<ChatGroup>()
  }, [agentWindow.id])

  useEffect(() => {
    let cancelled = false

    const applySnapshot = (next: AgentSessionSnapshot) => {
      if (cancelled || next.windowId !== agentWindow.id) return
      const nextMessageState = computeStableList(next.messages ?? [], messageStateRef.current, {
        getId: (message) => message.id,
        isUnchanged: isAgentSessionMessageUnchanged,
      })
      messageStateRef.current = nextMessageState
      const nextGroupState = computeStableList(
        groupMessages(nextMessageState.result),
        groupStateRef.current,
        {
          getId: (group) => group.key,
          isUnchanged: isChatGroupUnchanged,
        },
      )
      groupStateRef.current = nextGroupState
      setSnapshot(next)
      setMessages(nextMessageState.result)
      setGroups(nextGroupState.result)
      // First snapshot after mount: detect recovered mid-turn resumes so the
      // drain effect stays gated until the user presses Continue. We only do
      // this for sessions restored from disk after an app restart — normal
      // remounts from project switching should not trigger the banner.
      if (!midTurnAppliedRef.current) {
        midTurnAppliedRef.current = true
        const msgs = next.messages
        const hasQueued = sanitizeQueuedMessages(agentWindow.queuedMessages ?? []).length > 0
        if (next.restoredFromPersist && (msgs.length > 0 || hasQueued)) {
          const tail = msgs[msgs.length - 1]
          const tailIsUser = tail?.role === 'user'
          const hasPending = msgs.some((m) => m.status === 'in_progress')
          if (tailIsUser || hasPending || hasQueued) {
            setMidTurnDetected(tailIsUser || hasPending)
            setResumeGated(true)
          }
        }
      }
      const shouldClearInitialPrompt =
        Boolean(agentWindow.initialPrompt) &&
        (next.messages.some((message) => message.role === 'user') ||
          next.status === 'running' ||
          Boolean(next.claudeSessionId) ||
          Boolean(next.codexThreadId))
      useStore.getState().syncAgentWindow(agentWindow.id, {
        title: next.title,
        cwd: next.cwd ?? agentWindow.cwd ?? null,
        status: deriveAgentSessionWindowStatus(next),
        error: next.error ?? null,
        claudeSessionId: next.claudeSessionId ?? null,
        codexThreadId: next.codexThreadId ?? null,
        initialPrompt: shouldClearInitialPrompt ? null : (agentWindow.initialPrompt ?? null),
      })
    }

    const sync = (next: AgentSessionSnapshot) => {
      pendingSnapshotRef.current = next
      if (pendingFrameRef.current !== null) return
      pendingFrameRef.current = window.requestAnimationFrame(() => {
        pendingFrameRef.current = null
        const pending = pendingSnapshotRef.current
        pendingSnapshotRef.current = null
        if (pending) applySnapshot(pending)
      })
    }

    void window.cells.agentSession
      .ensure({
        windowId: agentWindow.id,
        agent: agentWindow.agent,
        title: agentWindow.customTitle || agentWindow.title,
        cwd: agentWindow.cwd ?? null,
        initialPrompt: agentWindow.initialPrompt ?? null,
        claudeSessionId: agentWindow.claudeSessionId ?? null,
        codexThreadId: agentWindow.codexThreadId ?? null,
        model: agentWindow.model ?? null,
        permissionMode: agentWindow.permissionMode ?? null,
        thinkingLevel: agentWindow.thinkingLevel ?? null,
        contextLength: agentWindow.contextLength ?? null,
      })
      .then(sync)

    const unsubscribe = window.cells.agentSession.onUpdate(sync)
    return () => {
      cancelled = true
      pendingSnapshotRef.current = null
      if (pendingFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingFrameRef.current)
        pendingFrameRef.current = null
      }
      unsubscribe()
    }
  }, [
    agentWindow.agent,
    agentWindow.claudeSessionId,
    agentWindow.codexThreadId,
    agentWindow.cwd,
    agentWindow.customTitle,
    agentWindow.id,
    agentWindow.initialPrompt,
    agentWindow.queuedMessages,
    agentWindow.title,
    agentWindow.model,
    agentWindow.permissionMode,
    agentWindow.thinkingLevel,
    agentWindow.contextLength,
  ])

  // Scroll-to-bottom is handled by <LegendList maintainScrollAtEnd /> in the
  // messages branch; the skeleton/empty branches don't need autoscroll.

  useEffect(() => {
    const id = window.setTimeout(() => textareaRef.current?.focus(), 50)
    return () => window.clearTimeout(id)
  }, [agentWindow.id])

  const pickAttachments = useCallback(async () => {
    try {
      const picked = await window.cells.app.pickFiles()
      if (!picked || picked.length === 0) return
      setAttachments((prev) => Array.from(new Set([...prev, ...picked])))
    } catch (err) {
      console.error('[agent-chat] pick files failed', err)
    }
  }, [])

  const removeAttachment = useCallback((path: string) => {
    setComposerPreviewPath((current) => (current === path ? null : current))
    setAttachments((prev) => prev.filter((p) => p !== path))
  }, [])

  const composerPlaceholder = useMemo(
    () => getComposerPlaceholder(agentWindow.agent),
    [agentWindow.agent],
  )
  const snapshotMatchesWindow = snapshot?.windowId === agentWindow.id
  const visibleSnapshot = useMemo(
    () => (snapshotMatchesWindow ? snapshot : null),
    [snapshot, snapshotMatchesWindow],
  )
  const visibleMessages = useMemo(
    () => (snapshotMatchesWindow ? messages : []),
    [messages, snapshotMatchesWindow],
  )
  const visibleGroups = useMemo(
    () => (snapshotMatchesWindow ? groups : []),
    [groups, snapshotMatchesWindow],
  )
  // Claim pending morph ids for newly-arrived user messages. Runs at render
  // time (NOT in an effect) because the layoutId has to be present the very
  // first time the bubble renders — a post-mount effect would assign it too
  // late for Framer to pair it with the exiting queue row / composer pill.
  //
  // The `setMorphAssignments` call during render is intentional and safe:
  // `handledUserIdsRef` records every id we've already processed, so the
  // loop makes no changes on re-renders and the update is convergent.
  if (!handledUserIdsInitRef.current) {
    // First render: every existing user message predates this mount, so they
    // must never steal a future morph. Mark them all as handled.
    for (const m of messages) {
      if (m.role === 'user') handledUserIdsRef.current.add(m.id)
    }
    handledUserIdsInitRef.current = true
  } else if (pendingMorphsRef.current.length > 0) {
    const claims: Record<string, string> = {}
    for (const m of messages) {
      if (m.role !== 'user') continue
      if (handledUserIdsRef.current.has(m.id)) continue
      handledUserIdsRef.current.add(m.id)
      const morph = pendingMorphsRef.current.shift()
      if (morph) claims[m.id] = morph
      if (pendingMorphsRef.current.length === 0) break
    }
    if (Object.keys(claims).length > 0) {
      setMorphAssignments((prev) => ({ ...prev, ...claims }))
    }
  } else {
    // Keep the handled set in sync with the arrival of new user messages
    // even when no morph is pending, so a stale pending morph from the
    // future never binds to an older user message it wasn't meant for.
    for (const m of messages) {
      if (m.role !== 'user') continue
      if (!handledUserIdsRef.current.has(m.id)) handledUserIdsRef.current.add(m.id)
    }
  }
  // Clear a completed morph assignment — and the composer's stale layoutId
  // if this bubble was the one consuming it — so the next send mints a
  // fresh id instead of colliding with the old bubble's.
  const handleUserMorphComplete = useCallback((messageId: string) => {
    let consumed: string | undefined
    setMorphAssignments((prev) => {
      if (!(messageId in prev)) return prev
      consumed = prev[messageId]
      const { [messageId]: _discard, ...rest } = prev
      return rest
    })
    if (consumed && consumed.startsWith('composer-morph-')) {
      setComposerMorphId((prev) => (prev === consumed ? null : prev))
    }
  }, [])
  const inlineMention = useInlineMention({
    inputRef: textareaRef,
    cwd: visibleSnapshot?.cwd ?? agentWindow.cwd ?? null,
  })

  const cwdDisplay = truncateCwd(visibleSnapshot?.cwd || agentWindow.cwd)
  const backgroundActivities = useMemo(
    () => getInFlightAgentMessages(visibleMessages),
    [visibleMessages],
  )
  const hasMessages = visibleMessages.length > 0
  const isLoadingSnapshot = !visibleSnapshot
  const filteredRecentSessions = useMemo(
    () =>
      filterRecentSessionsForProject(
        recentSessions,
        activeProjectPath ?? visibleSnapshot?.cwd ?? agentWindow.cwd ?? null,
        worktrees,
      ),
    [activeProjectPath, agentWindow.cwd, recentSessions, visibleSnapshot?.cwd, worktrees],
  )
  useEffect(() => {
    const viewport = recentSessionsViewportRef.current
    if (!viewport) return

    let frame: number | null = null
    const update = () => {
      frame = null
      const maxScroll = viewport.scrollHeight - viewport.clientHeight
      const hasOverflow = maxScroll > 1
      const next = {
        top: hasOverflow && viewport.scrollTop > 1,
        bottom: hasOverflow && viewport.scrollTop < maxScroll - 1,
      }
      setRecentSessionsFade((prev) =>
        prev.top === next.top && prev.bottom === next.bottom ? prev : next,
      )
    }
    const scheduleUpdate = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(update)
    }

    scheduleUpdate()
    viewport.addEventListener('scroll', scheduleUpdate, { passive: true })

    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleUpdate) : null
    observer?.observe(viewport)
    const content = viewport.firstElementChild
    if (content instanceof HTMLElement) observer?.observe(content)
    window.addEventListener('resize', scheduleUpdate)

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', scheduleUpdate)
      observer?.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
    }
  }, [filteredRecentSessions])
  const hasBackgroundActivity = backgroundActivities.length > 0
  const isRunning = deriveAgentSessionWindowStatus(visibleSnapshot) === 'running'
  const composerImageAttachments = useMemo(
    () => attachments.filter((path) => isImagePath(path)),
    [attachments],
  )
  const composerFileAttachments = useMemo(
    () => attachments.filter((path) => !isImagePath(path)),
    [attachments],
  )
  const visibleComposerPreviewPath =
    composerPreviewPath && attachments.includes(composerPreviewPath) ? composerPreviewPath : null
  const hasComposerPayload = Boolean(input.trim()) || attachments.length > 0
  const canSubmit = hasComposerPayload && !isRunning
  const isEditingQueuedMessage = editingIndex !== null
  const canSaveQueuedEdit = isEditingQueuedMessage && hasComposerPayload

  const ensureSession = useCallback(async () => {
    await window.cells.agentSession.ensure({
      windowId: agentWindow.id,
      agent: agentWindow.agent,
      title: agentWindow.customTitle || agentWindow.title,
      cwd: agentWindow.cwd ?? null,
      initialPrompt: null,
      claudeSessionId: agentWindow.claudeSessionId ?? null,
      codexThreadId: agentWindow.codexThreadId ?? null,
      model: agentWindow.model ?? null,
      permissionMode: agentWindow.permissionMode ?? null,
      thinkingLevel: agentWindow.thinkingLevel ?? null,
    })
  }, [
    agentWindow.agent,
    agentWindow.claudeSessionId,
    agentWindow.codexThreadId,
    agentWindow.customTitle,
    agentWindow.cwd,
    agentWindow.id,
    agentWindow.model,
    agentWindow.permissionMode,
    agentWindow.thinkingLevel,
    agentWindow.title,
  ])

  const attachmentsRef = useRef(attachments)
  const queueRef = useRef<QueuedMessage[]>(queuedMessages)
  const queuedEditRestoreRef = useRef<{ input: string; attachments: string[] } | null>(null)
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  useEffect(() => {
    queueRef.current = queuedMessages
  }, [queuedMessages])

  const writeComposer = useCallback((value: string, nextAttachments: string[]) => {
    setInput(value)
    inputRef.current = value
    setAttachments(nextAttachments)
    attachmentsRef.current = nextAttachments
  }, [])

  // Actually ship one message to the agent. Separated from submit() so the
  // queue-flusher effect can call it too.
  const sendToAgent = useCallback(
    async (
      value: string,
      attachments: string[],
      overrides?: {
        model?: string | null
        thinkingLevel?: AgentThinkingLevel | null
        permissionMode?: AgentPermissionMode | null
      },
    ) => {
      const trySend = () =>
        window.cells.agentSession.send(windowIdRef.current, value, attachments, overrides)
      try {
        await trySend()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/Missing agent session/i.test(msg)) {
          try {
            await ensureSession()
            await trySend()
            return
          } catch (retryErr) {
            console.error('[agent-chat] retry failed', retryErr)
          }
        }
        throw err
      }
    },
    [ensureSession],
  )

  const handleStop = useCallback(async () => {
    try {
      // v2 SDKSession has no interrupt; closing the session is the only way
      // to actually halt an in-flight turn.
      await window.cells.agentSession.close(windowIdRef.current)
    } catch (err) {
      console.error('[agent-chat] stop failed', err)
    }
  }, [])

  const applyInlineMentionSelection = useCallback(
    (selection: { value: string; cursorPosition: number } | null) => {
      if (!selection) return false
      setInput(selection.value)
      inputRef.current = selection.value
      window.setTimeout(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(selection.cursorPosition, selection.cursorPosition)
      }, 0)
      return true
    },
    [],
  )

  const submit = useCallback(
    async (intent: 'after-turn' | 'after-tool' | 'stop' = 'after-turn') => {
      const rawValue = inputRef.current.trim()
      const pinned = attachmentsRef.current
      if (!rawValue && pinned.length === 0) return
      // Attachments travel in a separate array — images become proper
      // multimodal content blocks downstream, non-image paths get `[path]`
      // injected into the agent's text for file-read tool use.
      const value = rawValue || ATTACHMENTS_ONLY_TEXT
      const running = snapshotRef.current?.status === 'running'

      // Drain the input optimistically so typing feels instant.
      setInput('')
      inputRef.current = ''
      inlineMention.close()
      setAttachments([])
      attachmentsRef.current = []

      const settings = {
        model: agentWindow.model ?? null,
        thinkingLevel: agentWindow.thinkingLevel ?? null,
        permissionMode: agentWindow.permissionMode ?? null,
      }

      // Cmd+Enter is an immediate interrupt/retry path, not a normal queued
      // follow-up. Keep it out of the persisted queue so it does not survive
      // project switches or restarts, and send it before any after-turn/tool
      // messages once the runtime flips back to idle.
      if (intent === 'stop' && running) {
        const entry: QueuedMessage = {
          text: value,
          attachments: pinned,
          mode: 'stop',
          ...settings,
        }
        interruptMessageRef.current = entry
        void handleStop()
        return
      }

      // Option+Enter (after-tool) and plain Enter (after-turn) both defer the
      // message, but after-tool needs priority: place it at the front so it
      // sends immediately after the next tool boundary instead of sitting
      // behind older after-turn entries.
      if ((intent === 'after-tool' || intent === 'after-turn') && running) {
        const entry: QueuedMessage = {
          text: value,
          attachments: pinned,
          mode: intent,
          ...settings,
        }
        const nextQueue =
          intent === 'after-tool' ? [entry, ...queueRef.current] : [...queueRef.current, entry]
        queueFrontModeRef.current = nextQueue[0]?.mode ?? null
        setQueuedMessages(() => nextQueue)
        queueRef.current = nextQueue
        return
      }

      // Prime a composer→bubble morph for the message this send produces.
      // Nonce keeps ids unique across sends so an older (already-morphed)
      // bubble's layoutId never collides with a fresh one.
      composerMorphNonceRef.current += 1
      const morphId = `composer-morph-${composerMorphNonceRef.current}`
      pendingMorphsRef.current.push(morphId)
      setComposerMorphId(morphId)

      try {
        await sendToAgent(value, pinned)
      } catch (err) {
        // Rollback the pending morph — if the send failed, the bubble will
        // never arrive to claim it and it would incorrectly bind to the
        // next message from a later source.
        const idx = pendingMorphsRef.current.indexOf(morphId)
        if (idx >= 0) pendingMorphsRef.current.splice(idx, 1)
        setComposerMorphId((prev) => (prev === morphId ? null : prev))
        writeComposer(value, pinned)
        console.error('[agent-chat] send failed', err)
      }
    },
    [
      sendToAgent,
      handleStop,
      inlineMention,
      setQueuedMessages,
      writeComposer,
      agentWindow.model,
      agentWindow.thinkingLevel,
      agentWindow.permissionMode,
    ],
  )

  const unqueueMessage = useCallback(
    (index: number) => {
      if (editingIndex === index) {
        const restore = queuedEditRestoreRef.current
        queuedEditRestoreRef.current = null
        setEditingIndex(null)
        writeComposer(restore?.input ?? '', restore?.attachments ?? [])
      }
      setQueuedMessages((q) => q.filter((_, i) => i !== index))
      setEditingIndex((current) => (current !== null && current > index ? current - 1 : current))
    },
    [editingIndex, setQueuedMessages, writeComposer],
  )

  const beginEditQueued = useCallback(
    (index: number) => {
      const entry = queuedMessages[index]
      if (!entry) return
      if (editingIndex === null) {
        queuedEditRestoreRef.current = {
          input: inputRef.current,
          attachments: [...attachmentsRef.current],
        }
      }
      setEditingIndex(index)
      writeComposer(getQueuedComposerText(entry), [...entry.attachments])
      setQueueCollapsed(false)
      window.setTimeout(() => textareaRef.current?.focus(), 0)
    },
    [editingIndex, queuedMessages, writeComposer],
  )

  const commitEditQueued = useCallback(() => {
    if (editingIndex === null) return
    const nextText = getQueuedStoredText(inputRef.current, attachmentsRef.current)
    if (!nextText) return
    const nextAttachments = [...attachmentsRef.current]
    setQueuedMessages((q) =>
      q.map((m, i) =>
        i === editingIndex ? { ...m, text: nextText, attachments: nextAttachments } : m,
      ),
    )
    const restore = queuedEditRestoreRef.current
    queuedEditRestoreRef.current = null
    setEditingIndex(null)
    writeComposer(restore?.input ?? '', restore?.attachments ?? [])
  }, [editingIndex, setQueuedMessages, writeComposer])

  const cancelEditQueued = useCallback(() => {
    const restore = queuedEditRestoreRef.current
    queuedEditRestoreRef.current = null
    setEditingIndex(null)
    writeComposer(restore?.input ?? '', restore?.attachments ?? [])
  }, [writeComposer])

  const sendQueuedImmediately = useCallback(
    (index: number) => {
      const entry = queuedMessages[index]
      if (!entry) return
      if (editingIndex === index) {
        const restore = queuedEditRestoreRef.current
        queuedEditRestoreRef.current = null
        setEditingIndex(null)
        writeComposer(restore?.input ?? '', restore?.attachments ?? [])
      }
      interruptMessageRef.current = { ...entry, mode: 'stop' }
      setQueuedMessages((q) => q.filter((_, i) => i !== index))
      setResumeGated(false)
      setMidTurnDetected(false)
      if (snapshotRef.current?.status === 'running') void handleStop()
    },
    [editingIndex, handleStop, queuedMessages, setQueuedMessages, writeComposer],
  )

  // Drain the queue whenever the agent flips back to idle. Pop the front
  // item OPTIMISTICALLY before dispatching — if sendToAgent throws we push
  // it back. Prior version removed-on-success but sendToAgent resolves after
  // the agent flips to `running`, which the user could read as "the queue
  // item is still there even though the agent already started it".
  //
  // `awaitingRunningRef` gates back-to-back sends: after we fire a queued
  // message, `sendToAgent()` can resolve before the backend emits the
  // `session_state_changed → running` event. Without this gate the effect
  // would re-fire on the next `queuedMessages` change while status is still
  // `idle`, shipping a second message before the first one's turn has even
  // started. We clear the gate once we actually observe the running signal.
  const sendingQueuedRef = useRef(false)
  const awaitingRunningRef = useRef(false)
  useEffect(() => {
    if (snapshot?.status === 'running') awaitingRunningRef.current = false
  }, [snapshot?.status])

  // after-tool watcher: when the front-of-queue entry is waiting for a tool
  // boundary, fire a stop the moment any tool message flips to completed
  // after it was enqueued. Track seen completed tool ids so a single tool
  // end doesn't fire stop twice; gate on `afterToolFiredRef` so we only
  // interrupt once per running-turn (reset when the turn ends).
  const seenCompletedToolsRef = useRef<Set<string>>(new Set())
  const afterToolFiredRef = useRef(false)
  // Mirror of queuedMessages[0].mode kept as a mutable ref so the watcher
  // always reads the CURRENT value, not the stale closure. React's batched
  // state updates mean queuedMessages in the effect closure can lag behind
  // reality by one render — this ref is cleared synchronously at drain time
  // so the watcher never sees the stale 'after-tool' mode on the new turn.
  const queueFrontModeRef = useRef<QueuedMessage['mode'] | null>(queuedMessages[0]?.mode ?? null)
  useEffect(() => {
    queueFrontModeRef.current = queuedMessages[0]?.mode ?? null
  }, [queuedMessages])
  const toggleQueuedMode = useCallback(
    (index: number) => {
      setQueuedMessages((q) =>
        q.map((entry, i) => {
          if (i !== index) return entry
          const nextMode = entry.mode === 'after-tool' ? 'after-turn' : 'after-tool'
          if (i === 0) queueFrontModeRef.current = nextMode
          return { ...entry, mode: nextMode }
        }),
      )
    },
    [setQueuedMessages],
  )
  useEffect(() => {
    if (snapshot?.status !== 'running') afterToolFiredRef.current = false
  }, [snapshot?.status])
  useEffect(() => {
    const msgs = snapshot?.messages
    if (!msgs) return
    const nextSeen = new Set<string>()
    let hasNewCompletion = false
    for (const m of msgs) {
      if (m.role !== 'tool' || m.status !== 'completed') continue
      nextSeen.add(m.id)
      if (!seenCompletedToolsRef.current.has(m.id)) hasNewCompletion = true
    }
    seenCompletedToolsRef.current = nextSeen
    if (!hasNewCompletion) return
    if (snapshot?.status !== 'running') return
    if (afterToolFiredRef.current) return
    if (queueFrontModeRef.current !== 'after-tool') return
    afterToolFiredRef.current = true
    void handleStop()
  }, [snapshot?.messages, snapshot?.status, handleStop])
  useEffect(() => {
    if (snapshot?.status !== 'idle') return
    if (resumeGated) return
    if (sendingQueuedRef.current) return
    if (awaitingRunningRef.current) return
    sendingQueuedRef.current = true
    awaitingRunningRef.current = true
    if (interruptMessageRef.current) {
      const next = interruptMessageRef.current
      interruptMessageRef.current = null
      // Even though the original queue row has long since exited, priming the
      // morph means the bubble still animates in from a sensible layout origin
      // — Framer falls back to a fresh mount if no shared id is on-screen.
      const interruptMorphId = `interrupt-morph-${Date.now()}`
      pendingMorphsRef.current.push(interruptMorphId)
      void sendToAgent(next.text, next.attachments, {
        model: next.model,
        thinkingLevel: next.thinkingLevel,
        permissionMode: next.permissionMode,
      })
        .catch((err) => {
          console.error('[agent-chat] interrupt send failed', err)
          const idx = pendingMorphsRef.current.indexOf(interruptMorphId)
          if (idx >= 0) pendingMorphsRef.current.splice(idx, 1)
          interruptMessageRef.current = next
          awaitingRunningRef.current = false
        })
        .finally(() => {
          sendingQueuedRef.current = false
        })
      return
    }
    if (queuedMessages.length === 0) {
      sendingQueuedRef.current = false
      awaitingRunningRef.current = false
      return
    }
    const next = queuedMessages[0]
    // Clear the ref synchronously so the after-tool watcher immediately sees
    // no pending mode — React's batched state update for setQueuedMessages
    // would otherwise leave queuedMessages stale in the closure long enough
    // for the watcher to fire handleStop() on the new turn.
    queueFrontModeRef.current = queuedMessages[1]?.mode ?? null
    // Prime the queue→bubble morph. Same key as the exiting queue row; the
    // bubble will claim it on arrival (see pendingMorphsRef logic above).
    const queueMorphId = `queue-morph-${next.mode}|${next.text}|${next.attachments.join(',')}`
    pendingMorphsRef.current.push(queueMorphId)
    setQueuedMessages((q) => q.slice(1))
    void sendToAgent(next.text, next.attachments, {
      model: next.model,
      thinkingLevel: next.thinkingLevel,
      permissionMode: next.permissionMode,
    })
      .catch((err) => {
        console.error('[agent-chat] queued send failed', err)
        const idx = pendingMorphsRef.current.indexOf(queueMorphId)
        if (idx >= 0) pendingMorphsRef.current.splice(idx, 1)
        // Put it back at the front so the user can retry / see it.
        setQueuedMessages((q) => [next, ...q])
        awaitingRunningRef.current = false
      })
      .finally(() => {
        sendingQueuedRef.current = false
      })
  }, [queuedMessages, resumeGated, sendToAgent, setQueuedMessages, snapshot?.status])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if (inlineMention.open) {
        const mentionResult = inlineMention.handleKeyDown(event.nativeEvent)
        if (mentionResult) {
          if (mentionResult !== 'handled') applyInlineMentionSelection(mentionResult)
          event.stopPropagation()
          return
        }
      }
      if (event.key !== 'Enter') return
      if (event.shiftKey) return // Shift+Enter → newline
      if (editingIndex !== null) {
        event.preventDefault()
        event.stopPropagation()
        commitEditQueued()
        return
      }
      // Cmd+Enter: interrupt the running turn and send this message next.
      if (event.metaKey) {
        event.preventDefault()
        event.stopPropagation()
        void submit('stop')
        return
      }
      // Option+Enter: send after the next tool call completes.
      if (event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        void submit('after-tool')
        return
      }
      // Plain Enter (while running): queue until the turn finishes naturally.
      event.preventDefault()
      event.stopPropagation()
      void submit('after-turn')
    },
    [applyInlineMentionSelection, commitEditQueued, editingIndex, inlineMention, submit],
  )

  const absorbDroppedImages = useCallback(async (dataTransfer: DataTransfer) => {
    const files = Array.from(dataTransfer.files)
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    const saved: string[] = []
    for (const file of images) {
      // Finder / native drags: we already have a path on disk, no need to
      // copy into the temp dir.
      try {
        const existing = window.cells.app.getPathForFile(file)
        if (existing) {
          saved.push(existing)
          continue
        }
      } catch {
        // getPathForFile throws for cross-app / in-memory blobs — fall through
      }
      try {
        const buf = new Uint8Array(await file.arrayBuffer())
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
        const name = file.name && file.name.trim() ? file.name : `drop-${Date.now()}.${ext}`
        const stored = await window.cells.app.saveTempFile(buf, name)
        if (stored) saved.push(stored)
      } catch (err) {
        console.error('[agent-chat] save dropped image failed', err)
      }
    }
    if (saved.length > 0) {
      setAttachments((prev) => Array.from(new Set([...prev, ...saved])))
    }
  }, [])

  // Capture-phase fallback for ancestors that swallow keydown.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.activeElement !== textareaRef.current) return
      if (inlineMention.open) {
        const mentionResult = inlineMention.handleKeyDown(event)
        if (mentionResult) {
          if (mentionResult !== 'handled') applyInlineMentionSelection(mentionResult)
          event.stopPropagation()
          return
        }
      }
      if (event.key !== 'Enter') return
      if (event.shiftKey) return
      if ((event as any).isComposing || event.keyCode === 229) return
      event.preventDefault()
      event.stopPropagation()
      if (editingIndex !== null) {
        commitEditQueued()
      } else if (event.metaKey) {
        void submit('stop')
      } else if (event.altKey) {
        void submit('after-tool')
      } else {
        void submit('after-turn')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [
    agentWindow.id,
    applyInlineMentionSelection,
    commitEditQueued,
    editingIndex,
    inlineMention,
    submit,
  ])

  useEffect(() => {
    if (hasMessages) return
    let cancelled = false
    window.cells.agentSession
      .listRecentSessions(agentWindow.agent, 8)
      .then((sessions) => {
        if (!cancelled) setRecentSessions(sessions)
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[agent-chat] listRecentSessions failed', err)
          setRecentSessions([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [agentWindow.agent, hasMessages])

  const openRecentSession = useCallback(
    (session: RecentAgentSessionSummary) => {
      const store = useStore.getState()
      if (session.origin === 'cells' && session.windowId) {
        store.addAgentWindow(session.agent, {
          id: session.windowId,
          title: session.title,
          cwd: session.cwd ?? null,
          claudeSessionId: session.claudeSessionId ?? null,
          codexThreadId: session.codexThreadId ?? null,
          model: session.model ?? null,
        })
      } else {
        store.addAgentWindow(session.agent, {
          title: session.title,
          cwd: session.cwd ?? null,
          claudeSessionId: session.claudeSessionId ?? null,
          codexThreadId: session.codexThreadId ?? null,
          model: session.model ?? null,
        })
      }
      store.removeAgentWindow(agentWindow.id)
    },
    [agentWindow.id],
  )

  const sessionDiffStats = useMemo(() => sumDiffStats(visibleMessages), [visibleMessages])
  const [diffsPanelOpen, setDiffsPanelOpen] = useState(false)
  const streamingTurnKey = useMemo(() => {
    if (!isRunning) return null
    for (let i = visibleGroups.length - 1; i >= 0; i -= 1) {
      const group = visibleGroups[i]
      if (group.kind === 'turn') return group.key
    }
    return null
  }, [isRunning, visibleGroups])
  // Show the Craft-style "working" pill whenever the agent is running and the
  // last rendered group isn't a turn (= model hasn't emitted anything yet).
  const showPendingLoader =
    isRunning &&
    (visibleGroups.length === 0 || visibleGroups[visibleGroups.length - 1].kind !== 'turn')

  return (
    <div
      className="agent-chat-panel flex h-full min-h-0"
      data-focus-zone="chat"
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes('Files')) {
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return
        event.preventDefault()
        event.stopPropagation()
        void absorbDroppedImages(event.dataTransfer)
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            className="min-h-0 flex-1"
            style={{
              maskImage:
                'linear-gradient(to bottom, transparent 0%, black 28px, black calc(100% - 20px), transparent 100%)',
              WebkitMaskImage:
                'linear-gradient(to bottom, transparent 0%, black 28px, black calc(100% - 20px), transparent 100%)',
            }}
          >
            {isLoadingSnapshot || !hasMessages ? (
              <ScrollArea
                className="h-full min-w-0"
                viewportRef={scrollViewportRef}
                viewportClassName="rounded-none"
              >
                <div className="mx-auto min-h-full max-w-3xl py-6">
                  {isLoadingSnapshot ? (
                    <div className="space-y-3 px-2" aria-hidden>
                      <div className="flex justify-end">
                        <div className="h-6 w-[45%] animate-pulse rounded-[10px] bg-foreground/5" />
                      </div>
                      <div className="space-y-2">
                        <div className="h-4 w-[70%] animate-pulse rounded-[8px] bg-foreground/5" />
                        <div className="h-4 w-[55%] animate-pulse rounded-[8px] bg-foreground/5" />
                        <div className="h-4 w-[40%] animate-pulse rounded-[8px] bg-foreground/5" />
                      </div>
                      <div className="flex justify-end">
                        <div className="h-6 w-[30%] animate-pulse rounded-[10px] bg-foreground/5" />
                      </div>
                      <div className="space-y-2">
                        <div className="h-4 w-[60%] animate-pulse rounded-[8px] bg-foreground/5" />
                        <div className="h-4 w-[35%] animate-pulse rounded-[8px] bg-foreground/5" />
                      </div>
                    </div>
                  ) : (
                    <div className="flex min-h-[360px] flex-col items-center justify-center gap-4 py-8">
                      <div className="relative flex size-14 items-center justify-center rounded-[16px] border border-border/60 bg-background/85 shadow-middle">
                        <AgentIcon agent={agentWindow.agent} className="size-7" />
                        <span
                          className={cn(
                            'absolute -right-1 -bottom-1 size-3 rounded-full ring-2 ring-background',
                            isRunning
                              ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]'
                              : 'bg-muted-foreground/40',
                          )}
                        />
                      </div>
                      <div className="space-y-1.5 text-center">
                        <p className="text-[15px] font-semibold tracking-tight text-foreground">
                          New {getAgentDisplayName(agentWindow.agent)} session
                        </p>
                        {cwdDisplay ? (
                          <p className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground/85">
                            <Folder className="h-3 w-3" />
                            <span className="font-mono">{cwdDisplay}</span>
                          </p>
                        ) : (
                          <p className="text-[11.5px] text-muted-foreground/60">
                            No working directory
                          </p>
                        )}
                      </div>
                      <AgentEmptyStateHint />
                      <div className="flex w-full max-w-xl flex-wrap items-center justify-center gap-1.5 text-[11px] text-muted-foreground/70">
                        {(['stop', 'after-tool', 'after-turn'] as const).map((mode) => {
                          const meta = QUEUE_MODE_META[mode]
                          return (
                            <div
                              key={mode}
                              className="inline-flex items-center gap-1.5 rounded-[999px] bg-background/35 px-2.5 py-1"
                            >
                              <meta.Icon className={cn('size-3.5 shrink-0', meta.tint)} />
                              <span className="text-foreground/80">{meta.label}</span>
                              <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-foreground/6 px-1 text-[10px] text-muted-foreground/80">
                                {meta.shortcut}
                              </Kbd>
                            </div>
                          )
                        })}
                      </div>
                      {filteredRecentSessions.length > 0 ? (
                        <div className="w-full max-w-xl">
                          <div className="flex items-center gap-1.5 px-1 pb-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/65">
                            <History className="size-3.5" />
                            Recent Sessions
                          </div>
                          <div className="relative">
                            <ScrollArea
                              className="max-h-[250px] w-full"
                              viewportClassName="pr-2"
                              viewportRef={recentSessionsViewportRef}
                            >
                              <div className="flex flex-col gap-0.5 pb-2">
                                {filteredRecentSessions.map((session) => (
                                  <button
                                    key={`${session.origin}:${session.windowId ?? session.nativeId ?? session.title}`}
                                    type="button"
                                    onClick={() => openRecentSession(session)}
                                    className="flex items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-foreground/5"
                                  >
                                    <AgentIcon agent={session.agent} className="size-4 shrink-0" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2">
                                        <span className="truncate text-[12.5px] font-medium text-foreground/90">
                                          {session.title}
                                        </span>
                                        <span className="shrink-0 rounded-[6px] border border-border/35 bg-background/50 px-1.5 py-0.5 text-[10px] text-muted-foreground/70">
                                          {session.sourceLabel}
                                        </span>
                                      </div>
                                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground/65">
                                        {session.cwd ? (
                                          <span className="truncate font-mono">
                                            {truncateCwd(session.cwd)}
                                          </span>
                                        ) : null}
                                        <span className="shrink-0">
                                          {formatRelativeTime(session.updatedAt)}
                                        </span>
                                      </div>
                                    </div>
                                    <span className="shrink-0 text-[11px] text-muted-foreground/70">
                                      {session.origin === 'cells' ? 'Open' : 'Import'}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            </ScrollArea>
                            {recentSessionsFade.top ? (
                              <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-background via-background/95 to-transparent" />
                            ) : null}
                            {recentSessionsFade.bottom ? (
                              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background via-background/95 to-transparent" />
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </ScrollArea>
            ) : (
              <LegendList<ChatGroup>
                key={agentWindow.id}
                ref={listRef}
                data={visibleGroups}
                // LegendList recycles row renders and only refreshes them when
                // the backing item or `extraData` changes. The row UI also
                // depends on which turn is currently streaming, so surface that
                // as extraData; otherwise an older turn can stay visually stuck
                // in the "Working..." state after a newer turn becomes active.
                // Morph assignments are folded in so a newly-claimed layoutId
                // reaches the user bubble the first time it renders.
                extraData={`${streamingTurnKey ?? ''}|${Object.keys(morphAssignments).join(',')}`}
                keyExtractor={chatGroupKey}
                renderItem={({ item }) => {
                  const userMorphId =
                    item.kind === 'user' ? morphAssignments[item.message.id] : undefined
                  const userId = item.kind === 'user' ? item.message.id : null
                  return (
                    <div className="mx-auto w-full min-w-0 max-w-3xl">
                      <div className="pb-3">
                        <MessageGroupRow
                          group={item}
                          agent={agentWindow.agent}
                          isStreamingLastTurn={
                            item.kind === 'turn' && item.key === streamingTurnKey
                          }
                          userMorphLayoutId={userMorphId}
                          onUserMorphComplete={
                            userId && userMorphId
                              ? () => handleUserMorphComplete(userId)
                              : undefined
                          }
                        />
                      </div>
                    </div>
                  )
                }}
                estimatedItemSize={120}
                initialScrollAtEnd
                maintainScrollAtEnd
                maintainScrollAtEndThreshold={0.1}
                maintainVisibleContentPosition
                className="h-full overscroll-y-contain"
                ListHeaderComponent={<div className="h-6" />}
                ListFooterComponent={
                  <div className="mx-auto w-full min-w-0 max-w-3xl pb-6">
                    {showPendingLoader ? <PendingTurnIndicator agent={agentWindow.agent} /> : null}
                  </div>
                }
              />
            )}
          </div>

          <div className="relative shrink-0 px-4 pb-4 pt-2">
            <div className="mx-auto max-w-3xl">
              {visibleSnapshot?.error ? (
                <div className="mb-2 rounded-[12px] bg-red-500/12 px-3 py-2 text-[12px] text-red-300">
                  {visibleSnapshot.error}
                </div>
              ) : null}
              {visibleSnapshot?.pendingPlanApproval ? (
                <PlanApprovalBanner
                  key={visibleSnapshot.pendingPlanApproval.createdAt}
                  windowId={agentWindow.id}
                />
              ) : null}
              {visibleSnapshot?.pendingApproval ? (
                <AgentApprovalBanner
                  key={visibleSnapshot.pendingApproval.createdAt}
                  windowId={agentWindow.id}
                  approval={visibleSnapshot.pendingApproval}
                />
              ) : null}
              {visibleSnapshot?.pendingQuestion ? (
                <QuestionBanner
                  key={visibleSnapshot.pendingQuestion.createdAt}
                  windowId={agentWindow.id}
                  agent={agentWindow.agent}
                  questions={visibleSnapshot.pendingQuestion.questions}
                />
              ) : null}
              {visibleSnapshot?.codexPlan ? (
                <CodexPlanBanner plan={visibleSnapshot.codexPlan} />
              ) : null}
              {hasDiffStats(sessionDiffStats) ? (
                <div className="mb-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setDiffsPanelOpen((v) => !v)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-[6px] bg-foreground/5 px-2 py-0.5 text-[11px] text-muted-foreground/80 transition-colors hover:bg-foreground/10',
                      diffsPanelOpen && 'bg-foreground/10 text-foreground/90',
                    )}
                    title="Show session diffs"
                  >
                    <FileText className="size-3 shrink-0" />
                    <span className="tabular-nums">
                      {sessionDiffStats.additions > 0 ? (
                        <span className="text-emerald-400/80">+{sessionDiffStats.additions}</span>
                      ) : null}
                      {sessionDiffStats.additions > 0 && sessionDiffStats.deletions > 0 ? ' ' : ''}
                      {sessionDiffStats.deletions > 0 ? (
                        <span className="text-rose-400/80">-{sessionDiffStats.deletions}</span>
                      ) : null}
                      {sessionDiffStats.additions === 0 &&
                      sessionDiffStats.deletions === 0 &&
                      (sessionDiffStats.changedFiles ?? 0) > 0 ? (
                        <span className="text-muted-foreground/85">
                          {sessionDiffStats.changedFiles} file
                          {sessionDiffStats.changedFiles === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </span>
                    <span>diffs</span>
                  </button>
                </div>
              ) : null}
              {resumeGated && (queuedMessages.length > 0 || midTurnDetected) ? (
                <div className="mb-2 flex items-center gap-2 rounded-[10px] border border-amber-400/25 bg-amber-400/5 px-2.5 py-1.5 text-[12px] text-foreground/90 shadow-minimal">
                  <Clock className="size-3.5 shrink-0 text-amber-400/90" />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground/90">
                    {queuedMessages.length > 0
                      ? queuedMessages.length === 1
                        ? '1 message queued from your last session.'
                        : `${queuedMessages.length} messages queued from your last session.`
                      : 'Your last session ended mid-turn.'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setResumeGated(false)
                      setMidTurnDetected(false)
                      if (queuedMessages.length > 0) {
                        setQueueCollapsed(false)
                      } else {
                        void sendToAgent('Please continue where you left off.', [], {
                          model: agentWindow.model ?? null,
                          thinkingLevel: agentWindow.thinkingLevel ?? null,
                          permissionMode: agentWindow.permissionMode ?? null,
                        })
                      }
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-[8px] bg-amber-400/90 px-2.5 py-1 text-[11.5px] font-medium text-background transition-colors hover:bg-amber-400"
                  >
                    <ArrowUp className="size-3" />
                    Continue
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (queuedMessages.length > 0) setQueuedMessages(() => [])
                      setResumeGated(false)
                      setMidTurnDetected(false)
                    }}
                    aria-label={queuedMessages.length > 0 ? 'Discard queued messages' : 'Dismiss'}
                    className="shrink-0 rounded p-1 text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground"
                    title={queuedMessages.length > 0 ? 'Discard queued messages' : 'Dismiss'}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : null}
              {queuedMessages.length > 0 ? (
                <div className="mb-2 select-none">
                  {(() => {
                    const forceQueueExpanded = queuedMessages.length === 1
                    const next = queuedMessages[0]
                    const meta = QUEUE_MODE_META[next.mode]
                    if (forceQueueExpanded) return null
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          setQueueCollapsed((v) => !v)
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-[8px] px-2 py-1 text-left transition-colors focus:outline-none',
                          'hover:bg-foreground/5',
                        )}
                        title={queueCollapsed ? 'Show queued messages' : 'Hide queued messages'}
                      >
                        <span className="shrink-0 rounded-[4px] bg-background px-1.5 py-0.5 text-[10px] font-medium tabular-nums shadow-minimal">
                          {queuedMessages.length}
                        </span>
                        <meta.Icon
                          className={cn('size-3.5 shrink-0', meta.tint)}
                          aria-label={meta.label}
                        />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                          {next.text.replace(/\n/g, ' ') || '(attached files)'}
                        </span>
                        <ChevronRight
                          className={cn(
                            'ml-auto size-3.5 shrink-0 text-muted-foreground/70 transition-transform',
                            !queueCollapsed && 'rotate-90',
                          )}
                        />
                      </button>
                    )
                  })()}
                  {!queueCollapsed || queuedMessages.length === 1 ? (
                    <div
                      ref={queueScrollRef}
                      onScroll={updateQueueScrollFade}
                      // Mask-image creates a subtle fade at whichever edge has
                      // hidden content. Uses a narrow 10px band and fades to
                      // 78% (not full transparent) so the effect reads as a
                      // hint, not a cut. Only the active edge fades, so when
                      // you're at the top there's just a fade at the bottom
                      // and vice versa.
                      style={
                        queueScrollFade.top || queueScrollFade.bottom
                          ? {
                              maskImage: `linear-gradient(to bottom, ${
                                queueScrollFade.top ? 'rgba(0,0,0,0.78)' : 'black'
                              } 0, black 10px, black calc(100% - 10px), ${
                                queueScrollFade.bottom ? 'rgba(0,0,0,0.78)' : 'black'
                              } 100%)`,
                              WebkitMaskImage: `linear-gradient(to bottom, ${
                                queueScrollFade.top ? 'rgba(0,0,0,0.78)' : 'black'
                              } 0, black 10px, black calc(100% - 10px), ${
                                queueScrollFade.bottom ? 'rgba(0,0,0,0.78)' : 'black'
                              } 100%)`,
                            }
                          : undefined
                      }
                      className={cn(
                        'flex max-h-[108px] flex-col gap-1 overflow-y-auto overscroll-contain pr-0.5',
                        queuedMessages.length > 1 && 'mt-1',
                      )}
                    >
                      <AnimatePresence initial={false} mode="popLayout">
                        {queuedMessages.map((entry, i) => {
                          const meta = QUEUE_MODE_META[entry.mode]
                          const modelLabel = entry.model
                            ? prettifyModelId(agentWindow.agent, entry.model)
                            : null
                          const thinkingLabel =
                            entry.thinkingLevel && entry.thinkingLevel !== 'off'
                              ? THINKING_LEVEL_LABEL_MAP[entry.thinkingLevel]
                              : null
                          const permissionOption = entry.permissionMode
                            ? PERMISSION_MODE_OPTIONS.find((o) => o.id === entry.permissionMode)
                            : null
                          const isEditing = editingIndex === i
                          const isDragging = dragIndex === i
                          const isDropTarget =
                            dragOverIndex === i && dragIndex !== null && dragIndex !== i
                          // Content-derived key. Index keys break AnimatePresence's
                          // exit/reorder bookkeeping because neighbors shift index
                          // when an entry is removed; duplicates are theoretically
                          // possible but visually indistinguishable so we accept it.
                          const queueKey = `${entry.mode}|${entry.text}|${entry.attachments.join(',')}`
                          // `layoutId` binds this row to the user bubble that
                          // will arrive for this exact entry. Disabled under
                          // reduced motion so the shared-element morph never
                          // kicks in when the user has asked for less motion.
                          const queueMorphLayoutId = reduceMotion
                            ? undefined
                            : `queue-morph-${queueKey}`
                          return (
                            <motion.div
                              key={queueKey}
                              layoutId={queueMorphLayoutId}
                              layout
                              initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.98 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              // Exit slides UP toward the chat history. Pairs with
                              // the new user-message row's y:6→0 entrance so the
                              // queue feels like it flows into the conversation
                              // instead of just popping out.
                              exit={
                                reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }
                              }
                              transition={{
                                duration: 0.22,
                                ease: EASE_OUT,
                                layout: { duration: 0.26, ease: EASE_IN_OUT },
                              }}
                              draggable={!isEditing}
                              // motion.div retypes the drag event handlers for
                              // its own gesture system (MouseEvent | TouchEvent |
                              // PointerEvent). HTML5 drag-and-drop still fires
                              // here at runtime — the events are real DragEvents,
                              // we just have to cast back to access dataTransfer.
                              onDragStart={(event) => {
                                if (isEditing) return
                                const e = event as unknown as React.DragEvent<HTMLDivElement>
                                setDragIndex(i)
                                e.dataTransfer.effectAllowed = 'move'
                                try {
                                  e.dataTransfer.setData('text/plain', String(i))
                                } catch {
                                  // Safari may throw if dataTransfer is locked; drag still works.
                                }
                              }}
                              onDragOver={(event) => {
                                if (dragIndex === null || dragIndex === i) return
                                const e = event as unknown as React.DragEvent<HTMLDivElement>
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                                if (dragOverIndex !== i) setDragOverIndex(i)
                              }}
                              onDragLeave={() => {
                                setDragOverIndex((prev) => (prev === i ? null : prev))
                              }}
                              onDrop={(event) => {
                                const e = event as unknown as React.DragEvent<HTMLDivElement>
                                e.preventDefault()
                                if (dragIndex !== null && dragIndex !== i) {
                                  reorderQueue(dragIndex, i)
                                }
                                setDragIndex(null)
                                setDragOverIndex(null)
                              }}
                              onDragEnd={() => {
                                setDragIndex(null)
                                setDragOverIndex(null)
                              }}
                              className={cn(
                                'group/queued flex gap-2 rounded-[10px] bg-foreground/5 px-2.5 py-1.5 text-[12px] text-foreground/85 transition-colors',
                                'items-center',
                                isEditing && 'bg-cyan-500/10',
                                isDragging && 'opacity-50',
                                isDropTarget && 'bg-foreground/10',
                              )}
                              title={
                                isEditing
                                  ? 'Editing in composer'
                                  : `${meta.shortcut} · ${meta.hint}`
                              }
                            >
                              <span
                                className={cn(
                                  'flex size-3.5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/40 transition-colors hover:text-foreground/70 active:cursor-grabbing',
                                  isEditing && 'text-cyan-300/80',
                                )}
                                aria-label="Drag to reorder"
                                title="Drag to reorder"
                              >
                                <GripVertical className="size-3" />
                              </span>
                              <button
                                type="button"
                                onClick={() => toggleQueuedMode(i)}
                                aria-label={`Change queue mode from ${meta.label}`}
                                title={`${meta.label} · click to switch queue mode`}
                                className="shrink-0 rounded-[6px] p-0.5 hover:bg-foreground/10"
                              >
                                <meta.Icon className={cn('size-3.5 shrink-0', meta.tint)} />
                              </button>
                              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => beginEditQueued(i)}
                                  className={cn(
                                    'min-w-0 flex-1 truncate text-left text-muted-foreground/90 hover:text-foreground',
                                    isEditing && 'text-cyan-100',
                                  )}
                                  title={isEditing ? 'Editing in composer' : 'Edit in composer'}
                                >
                                  {entry.text.replace(/\n/g, ' ') ||
                                    (entry.attachments.length > 0 ? ATTACHMENTS_ONLY_TEXT : '')}
                                </button>
                                {entry.attachments.length > 0 ? (
                                  <div className="flex shrink-0 items-center gap-1">
                                    {entry.attachments.slice(0, 4).map((p) => (
                                      <QueueAttachmentThumb key={p} path={p} />
                                    ))}
                                    {entry.attachments.length > 4 ? (
                                      <span className="text-[10px] tabular-nums text-muted-foreground/70">
                                        +{entry.attachments.length - 4}
                                      </span>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                              <div className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground/80">
                                {modelLabel ? (
                                  <span
                                    className="rounded-[6px] bg-background/60 px-1.5 py-px"
                                    title={`Model: ${modelLabel}`}
                                  >
                                    {modelLabel}
                                  </span>
                                ) : null}
                                {thinkingLabel ? (
                                  <span
                                    className="rounded-[6px] bg-background/60 px-1.5 py-px"
                                    title={`Thinking: ${thinkingLabel}`}
                                  >
                                    {thinkingLabel}
                                  </span>
                                ) : null}
                                {permissionOption ? (
                                  <span
                                    className={cn(
                                      'inline-flex items-center gap-1 rounded-[6px] bg-background/60 px-1.5 py-px',
                                      permissionOption.tint,
                                    )}
                                    title={`Permission: ${permissionOption.label}`}
                                  >
                                    <permissionOption.Icon className="size-2.5" />
                                    {permissionOption.short}
                                  </span>
                                ) : null}
                              </div>
                              <button
                                type="button"
                                onClick={() => sendQueuedImmediately(i)}
                                aria-label="Send queued message now"
                                title="Send now"
                                className="shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground"
                              >
                                <ArrowUp className="size-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => beginEditQueued(i)}
                                aria-label="Edit queued message"
                                title="Edit"
                                className="shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground"
                              >
                                <Pencil className="size-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => unqueueMessage(i)}
                                aria-label="Remove queued message"
                                className="shrink-0 rounded p-0.5 text-muted-foreground/50 hover:bg-foreground/10 hover:text-foreground"
                              >
                                <X className="size-3" />
                              </button>
                            </motion.div>
                          )
                        })}
                      </AnimatePresence>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {hasBackgroundActivity && visibleSnapshot?.status !== 'running' ? (
                <BackgroundActivityBanner
                  agent={agentWindow.agent}
                  activities={backgroundActivities}
                  onStop={() => {
                    void handleStop()
                  }}
                />
              ) : null}
              <motion.div
                // When a composer send is in flight, `composerMorphId` carries
                // the layoutId that the incoming user bubble will match. The
                // composer itself doesn't unmount, so we rely on Framer's
                // mid-animation duplicate-id handling: the newly-mounted bubble
                // animates from this pill's bounding box and `onLayoutAnimationComplete`
                // clears the id on the bubble side.
                layoutId={reduceMotion ? undefined : (composerMorphId ?? undefined)}
                layout={false}
                className="group/composer relative overflow-hidden rounded-[12px] shadow-minimal"
                style={{ backgroundColor: 'oklch(0.17 0.004 285.9)' }}
              >
                <AnimatePresence initial={false}>
                  {isEditingQueuedMessage ? (
                    <motion.div
                      key="editing-queued"
                      // Height animations trigger layout (skill's golden rule
                      // prefers transform/opacity), but the banner is a one-shot
                      // toggle so the cost is paid at most once per edit — a
                      // reasonable trade for the natural expand/collapse feel.
                      initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: EASE_OUT }}
                      style={{ overflow: 'hidden' }}
                    >
                      <div className="flex items-center justify-between gap-3 bg-cyan-500/6 px-3 py-2 text-[11.5px]">
                        <div className="min-w-0">
                          <span className="font-medium text-cyan-100">Editing queued message</span>
                          <span className="ml-1.5 text-muted-foreground/80">
                            Save updates back into the queue.
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={cancelEditQueued}
                          className="shrink-0 rounded-[6px] px-2 py-1 text-muted-foreground/75 transition-colors hover:bg-foreground/10 hover:text-foreground"
                        >
                          Cancel
                        </button>
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
                {attachments.length > 0 ? (
                  <div className="space-y-2 px-3 pb-1 pt-3">
                    {composerImageAttachments.length > 0 ? (
                      <div className="flex flex-wrap gap-2.5">
                        {composerImageAttachments.map((path) => (
                          <ComposerImageAttachment
                            key={path}
                            path={path}
                            onPreview={() => setComposerPreviewPath(path)}
                            onRemove={() => removeAttachment(path)}
                          />
                        ))}
                      </div>
                    ) : null}
                    {composerFileAttachments.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {composerFileAttachments.map((path) => (
                          <ComposerAttachmentChip
                            key={path}
                            path={path}
                            onRemove={() => removeAttachment(path)}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(event) => {
                    const nextValue = event.target.value
                    setInput(nextValue)
                    inlineMention.handleInputChange(
                      nextValue,
                      event.target.selectionStart ?? nextValue.length,
                    )
                  }}
                  onKeyDown={handleKeyDown}
                  onPaste={async (event) => {
                    const items = Array.from(event.clipboardData?.items ?? [])
                    const imageItems = items.filter((it) => it.type.startsWith('image/'))
                    if (imageItems.length === 0) return // fall through to default text paste
                    event.preventDefault()
                    const saved: string[] = []
                    for (const item of imageItems) {
                      const file = item.getAsFile()
                      if (!file) continue
                      const buf = new Uint8Array(await file.arrayBuffer())
                      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
                      const name =
                        file.name && file.name.trim() ? file.name : `clipboard-${Date.now()}.${ext}`
                      try {
                        const stored = await window.cells.app.saveTempFile(buf, name)
                        if (stored) saved.push(stored)
                      } catch (err) {
                        console.error('[agent-chat] save pasted image failed', err)
                      }
                    }
                    if (saved.length > 0) {
                      setAttachments((prev) => Array.from(new Set([...prev, ...saved])))
                    }
                  }}
                  placeholder={
                    isEditingQueuedMessage ? 'Edit queued message…' : composerPlaceholder
                  }
                  spellCheck={false}
                  rows={Math.min(8, Math.max(3, input.split('\n').length))}
                  className="block w-full min-h-[72px] resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-6 text-foreground placeholder:text-muted-foreground/55 outline-none border-0 focus:outline-none focus-visible:outline-none"
                />
                <ComposerImagePreviewDialog
                  path={visibleComposerPreviewPath}
                  onClose={() => setComposerPreviewPath(null)}
                />
                <InlineMentionMenu
                  open={inlineMention.open}
                  items={inlineMention.items}
                  position={inlineMention.position}
                  selectedIndex={inlineMention.selectedIndex}
                  onHover={inlineMention.setSelectedIndex}
                  onClose={inlineMention.close}
                  onSelect={(item) => {
                    applyInlineMentionSelection(inlineMention.selectItem(item))
                  }}
                />
                <div className="flex items-center gap-1.5 px-2 pb-2 pt-0.5">
                  <button
                    type="button"
                    onClick={pickAttachments}
                    aria-label="Attach files"
                    className="inline-flex h-7 shrink-0 items-center justify-center rounded-[8px] bg-foreground/5 px-2 text-muted-foreground/85 transition-colors hover:bg-foreground/10 hover:text-foreground"
                    title="Attach files"
                  >
                    <Paperclip className="size-3.5" />
                  </button>
                  <PermissionPicker
                    value={agentWindow.permissionMode ?? getDefaultPermissionMode()}
                    onChange={(mode: AgentPermissionMode) => {
                      const store = useStore.getState()
                      store.syncAgentWindow(agentWindow.id, { permissionMode: mode })
                      store.setLastAgentSessionDefaults(agentWindow.agent, { permissionMode: mode })
                      // Live-update the running session so the agent picks up
                      // the new mode on the NEXT turn without needing a restart.
                      void window.cells.agentSession
                        .updatePermissionMode(agentWindow.id, mode)
                        .catch((err: unknown) =>
                          console.error('[agent-chat] updatePermissionMode failed', err),
                        )
                    }}
                  />
                  <ModelPicker
                    agent={agentWindow.agent}
                    value={agentWindow.model}
                    contextLength={agentWindow.contextLength}
                    onChange={(modelId) => {
                      const store = useStore.getState()
                      store.syncAgentWindow(agentWindow.id, { model: modelId })
                      store.setLastAgentSessionDefaults(agentWindow.agent, { model: modelId })
                    }}
                    onContextLengthChange={(length: AgentContextLength) => {
                      const store = useStore.getState()
                      store.syncAgentWindow(agentWindow.id, { contextLength: length })
                      store.setLastAgentSessionDefaults(agentWindow.agent, {
                        contextLength: length,
                      })
                      // Claude session has to be reopened to pick up / drop the
                      // context-1m beta flag — the backend handles that inside
                      // updateContextLength by closing the runtime.
                      void window.cells.agentSession
                        .updateContextLength(agentWindow.id, length)
                        .catch((err: unknown) =>
                          console.error('[agent-chat] updateContextLength failed', err),
                        )
                    }}
                  />
                  <ThinkingPicker
                    agent={agentWindow.agent}
                    model={agentWindow.model}
                    value={agentWindow.thinkingLevel}
                    onChange={(level) => {
                      const store = useStore.getState()
                      store.syncAgentWindow(agentWindow.id, { thinkingLevel: level })
                      store.setLastAgentSessionDefaults(agentWindow.agent, { thinkingLevel: level })
                    }}
                  />
                  <ContextUsageIndicator
                    usage={visibleSnapshot?.usage ?? null}
                    agent={agentWindow.agent}
                    contextLength={agentWindow.contextLength}
                  />
                  <div className="flex-1" />
                  {!isRunning && !isEditingQueuedMessage ? (
                    <span className="hidden items-center gap-1 text-[10.5px] text-muted-foreground/60 sm:inline-flex">
                      <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-foreground/6 px-1 text-[10px] text-muted-foreground/80">
                        ↵
                      </Kbd>
                      <span>send</span>
                    </span>
                  ) : null}
                  {isEditingQueuedMessage ? (
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={commitEditQueued}
                      disabled={!canSaveQueuedEdit}
                      aria-label="Save queued message"
                      className={cn(
                        'ml-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-2.5 text-[11.5px] font-medium transition-colors',
                        canSaveQueuedEdit
                          ? 'bg-cyan-400/90 text-background shadow-minimal hover:bg-cyan-400'
                          : 'cursor-not-allowed bg-foreground/10 text-muted-foreground/60',
                      )}
                    >
                      <Check className="size-3.5" />
                      Save
                    </button>
                  ) : (
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        if (isRunning) void handleStop()
                        else void submit()
                      }}
                      disabled={!isRunning && !canSubmit}
                      aria-label={isRunning ? 'Stop agent' : 'Send message'}
                      className={cn(
                        'ml-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors',
                        isRunning
                          ? 'bg-foreground text-background shadow-minimal hover:bg-foreground/90'
                          : canSubmit
                            ? 'bg-foreground text-background shadow-minimal hover:bg-foreground/90'
                            : 'cursor-not-allowed bg-foreground/20 text-background/70',
                      )}
                    >
                      {isRunning ? (
                        <Square className="h-3 w-3 fill-current" />
                      ) : (
                        <ArrowUp className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
      {diffsPanelOpen ? (
        <SessionDiffsPanel messages={visibleMessages} onClose={() => setDiffsPanelOpen(false)} />
      ) : null}
    </div>
  )
}
