import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  ChevronRight,
  Clock,
  FastForward,
  Folder,
  GripVertical,
  HelpCircle,
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
  PendingQuestion,
  QueuedAgentMessage,
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
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Kbd } from '@/components/ui/kbd'

interface AgentChatPanelProps {
  agentWindow: AgentWindowNode
}

// Copied and adapted from Craft Agents OSS:
// ../craft-agents-oss/apps/electron/src/renderer/pages/ChatPage.tsx
// ../craft-agents-oss/apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx
// ../craft-agents-oss/apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx
// ../craft-agents-oss/packages/ui/src/components/chat/UserMessageBubble.tsx

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

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

function isImagePath(p: string): boolean {
  const i = p.lastIndexOf('.')
  if (i < 0) return false
  return IMAGE_EXTENSIONS.has(p.slice(i).toLowerCase())
}

function AttachmentThumbnail({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    window.cells.app
      .fileThumbnail(path)
      .then((resolved) => {
        if (!cancelled) setUrl(resolved)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [path])
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
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!isImage) return
    let cancelled = false
    window.cells.app
      .fileThumbnail(path)
      .then((resolved) => {
        if (!cancelled) setUrl(resolved)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [path, isImage])
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

// Composer chip — small (single-line) thumbnail for images, paperclip for
// everything else. Rendered above the textarea so the user sees what they
// attached before typing. Uses the same `fileThumbnail` IPC that the
// larger user-bubble preview uses, so the cache is shared.
function ComposerAttachmentChip({ path, onRemove }: { path: string; onRemove: () => void }) {
  const name = path.split('/').pop() || path
  const isImage = isImagePath(path)
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!isImage) return
    let cancelled = false
    window.cells.app
      .fileThumbnail(path)
      .then((resolved) => {
        if (!cancelled) setUrl(resolved)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [path, isImage])
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[6px] bg-foreground/5 py-0.5 pl-1 pr-1 text-[11px] text-muted-foreground/90"
      title={path}
    >
      {isImage && url ? (
        <img
          src={url}
          alt=""
          className="size-5 shrink-0 rounded-[4px] border border-border/30 object-cover"
        />
      ) : (
        <Paperclip className="ml-1 size-3" />
      )}
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

function UserBubble({ message }: { message: AgentSessionMessage }) {
  // Deliberately tighter than Craft's bubble — the user asked for a more
  // compact message pill than Craft's (px-4 py-2.5 text-sm with wider max-w).
  const attachments = message.attachments ?? []
  const images = attachments.filter(isImagePath)
  const others = attachments.filter((p) => !isImagePath(p))
  const hasText = message.text.trim().length > 0
  return (
    <div className="mt-8 flex w-full justify-end">
      <div className="flex max-w-[78%] flex-col items-end gap-1.5 select-text">
        {images.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map((p) => (
              <AttachmentThumbnail key={p} path={p} />
            ))}
          </div>
        ) : null}
        {hasText ? (
          <div className="break-words rounded-[10px] bg-foreground/5 px-3 py-1.5 text-[13px] leading-[1.45] text-foreground">
            <AgentMarkdown inline>{message.text}</AgentMarkdown>
          </div>
        ) : null}
        {others.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1">
            {others.map((p) => (
              <AttachmentPill key={p} path={p} />
            ))}
          </div>
        ) : null}
      </div>
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
    }
  | { kind: 'error'; key: string; message: AgentSessionMessage }
  | { kind: 'auth'; key: string; message: AgentSessionMessage }
  | { kind: 'system'; key: string; message: AgentSessionMessage }

/**
 * Group messages into Craft-style turns:
 *   - Each user message stands alone.
 *   - Consecutive non-user messages collapse into a single "turn" whose
 *     assistant messages become the response and whose reasoning / tool /
 *     system messages become the activities stripe.
 *   - Errors and auth prompts are lifted out of the group so they render
 *     as their own cards (matches Craft).
 */
function groupMessages(messages: AgentSessionMessage[]): ChatGroup[] {
  const groups: ChatGroup[] = []
  let pending: { activities: AgentSessionMessage[]; responses: AgentSessionMessage[] } | null = null
  let turnIndex = 0

  const flushPending = () => {
    if (!pending) return
    if (pending.activities.length === 0 && pending.responses.length === 0) {
      pending = null
      return
    }
    groups.push({
      kind: 'turn',
      key: `turn-${turnIndex++}`,
      activities: pending.activities,
      responses: pending.responses,
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
      if (!pending) pending = { activities: [], responses: [] }
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
      case 'assistant':
      case 'reasoning':
      case 'tool':
      case 'system': {
        // Preserve chronological order of assistant text vs tool activity.
        // Whenever a non-assistant message (tool / reasoning / system) arrives
        // after any assistant response has already landed in the current turn,
        // close that turn and open a new one. Without this, a sequence like
        // [tool, tool, text, tool, tool] would collapse both tool pairs into
        // a single activities stripe above one response — the second pair
        // needs to render BELOW the text, not merged with the first pair.
        if (message.role !== 'assistant' && pending && pending.responses.length > 0) {
          flushPending()
        }
        if (!pending) pending = { activities: [], responses: [] }
        if (message.role === 'assistant') pending.responses.push(message)
        else pending.activities.push(message)
        break
      }
      default:
        break
    }
  }
  flushPending()
  return groups
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
  questions,
}: {
  windowId: string
  questions: PendingQuestion[]
}) {
  const [selections, setSelections] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {}
    for (const q of questions) init[q.question] = []
    return init
  })
  const [busy, setBusy] = useState<'submit' | 'cancel' | null>(null)

  const toggle = useCallback((q: PendingQuestion, label: string) => {
    setSelections((prev) => {
      const current = prev[q.question] ?? []
      if (q.multiSelect) {
        const has = current.includes(label)
        const next = has ? current.filter((x) => x !== label) : [...current, label]
        return { ...prev, [q.question]: next }
      }
      return { ...prev, [q.question]: [label] }
    })
  }, [])

  const canSubmit = questions.every((q) => (selections[q.question]?.length ?? 0) > 0)

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
            ? 'Claude needs an answer'
            : `Claude needs ${questions.length} answers`}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {questions.map((q) => {
          const selected = selections[q.question] ?? []
          return (
            <div key={q.question} className="flex flex-col gap-1.5">
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
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void cancel()}
          className="rounded-[6px] px-2 py-1 text-[11.5px] text-muted-foreground/80 hover:bg-foreground/5 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
        >
          {busy === 'cancel' ? 'Dismissing…' : 'Skip'}
        </button>
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

function GroupRenderer({
  group,
  agent,
  isStreamingLastTurn,
}: {
  group: ChatGroup
  agent: AgentWindowNode['agent']
  isStreamingLastTurn: boolean
}) {
  switch (group.kind) {
    case 'user':
      return <UserBubble message={group.message} />
    case 'turn':
      return (
        <AgentTurnCard
          activities={group.activities}
          responses={group.responses}
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
    default:
      return null
  }
}

export function AgentChatPanel({ agentWindow }: AgentChatPanelProps) {
  const [snapshot, setSnapshot] = useState<AgentSessionSnapshot | null>(null)
  const [input, setInput] = useState('')
  const [isComposerFocused, setIsComposerFocused] = useState(false)
  const [attachments, setAttachments] = useState<string[]>([])
  // Queue is persisted on the AgentWindowNode so it survives app restart.
  // Read straight from the prop (zustand re-renders this component whenever
  // the window patches) and write through `syncAgentWindow` so the change
  // flows out to disk via the debounced projects-state persister.
  const queuedMessages = useMemo<QueuedMessage[]>(
    () => agentWindow.queuedMessages ?? [],
    [agentWindow.queuedMessages],
  )
  const setQueuedMessages = useCallback(
    (updater: (prev: QueuedMessage[]) => QueuedMessage[]) => {
      const prev =
        useStore.getState().agentWindows.find((w) => w.id === agentWindow.id)?.queuedMessages ?? []
      const next = updater(prev)
      useStore.getState().syncAgentWindow(agentWindow.id, { queuedMessages: next })
    },
    [agentWindow.id],
  )
  // If the panel mounts with a non-empty queue, the app was quit mid-turn —
  // auto-draining would feel like the agent started itself without the user
  // asking. Hold the queue behind an explicit "Continue" button until the
  // user confirms. Once lifted, normal drain behaviour takes over.
  const [resumeGated, setResumeGated] = useState<boolean>(
    () => (agentWindow.queuedMessages?.length ?? 0) > 0,
  )
  // Separately track mid-turn resumes: the session had an outstanding user
  // turn when the app was closed (last message is a user message with no
  // completed assistant response). Surfaces the Continue banner even when
  // the queue is empty so the user can decide whether to resume.
  const [midTurnDetected, setMidTurnDetected] = useState(false)
  const midTurnAppliedRef = useRef(false)
  useEffect(() => {
    // If the user removes every queued message manually we don't want to keep
    // gating future queues — lift the gate once the queue empties, unless a
    // mid-turn banner is still being offered.
    if (queuedMessages.length === 0 && resumeGated && !midTurnDetected) setResumeGated(false)
  }, [queuedMessages.length, resumeGated, midTurnDetected])
  // Queue list collapses by default — the header already shows count + a
  // preview of the next message, mirroring AgentTurnCard's activities stripe.
  const [queueCollapsed, setQueueCollapsed] = useState(true)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  // Active drag state for queue reorder — `dragIndex` is the row being dragged,
  // `dragOverIndex` is the row currently under the pointer. Both reset on
  // drop or drag-end.
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const inputRef = useRef(input)
  const snapshotRef = useRef(snapshot)
  const windowIdRef = useRef(agentWindow.id)
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
    let cancelled = false

    const sync = (next: AgentSessionSnapshot) => {
      if (cancelled || next.windowId !== agentWindow.id) return
      setSnapshot(next)
      // First snapshot after mount: detect mid-turn resumes so the drain
      // effect stays gated until the user presses Continue. A session is
      // mid-turn when the last message is a user message (no assistant reply
      // followed) or any tool/reasoning row is still in_progress.
      if (!midTurnAppliedRef.current) {
        midTurnAppliedRef.current = true
        const msgs = next.messages
        if (msgs.length > 0) {
          const tail = msgs[msgs.length - 1]
          const tailIsUser = tail.role === 'user'
          const hasPending = msgs.some((m) => m.status === 'in_progress')
          if (tailIsUser || hasPending) {
            setMidTurnDetected(true)
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
        status: next.status,
        error: next.error ?? null,
        claudeSessionId: next.claudeSessionId ?? null,
        codexThreadId: next.codexThreadId ?? null,
        initialPrompt: shouldClearInitialPrompt ? null : (agentWindow.initialPrompt ?? null),
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
    agentWindow.title,
    agentWindow.model,
    agentWindow.permissionMode,
    agentWindow.thinkingLevel,
    agentWindow.contextLength,
  ])

  useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
  }, [snapshot?.messages.length, snapshot?.status])

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
    setAttachments((prev) => prev.filter((p) => p !== path))
  }, [])

  const composerPlaceholder = useMemo(
    () => getComposerPlaceholder(agentWindow.agent),
    [agentWindow.agent],
  )

  const cwdDisplay = truncateCwd(snapshot?.cwd || agentWindow.cwd)
  const isRunning = snapshot?.status === 'running'
  const canSubmit = Boolean(input.trim()) && !isRunning

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
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  useEffect(() => {
    queueRef.current = queuedMessages
  }, [queuedMessages])

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

  const submit = useCallback(
    async (intent: 'after-turn' | 'after-tool' | 'stop' = 'after-turn') => {
      const rawValue = inputRef.current.trim()
      const pinned = attachmentsRef.current
      if (!rawValue && pinned.length === 0) return
      // Attachments travel in a separate array — images become proper
      // multimodal content blocks downstream, non-image paths get `[path]`
      // injected into the agent's text for file-read tool use.
      const value = rawValue || '(attached files)'
      const running = snapshotRef.current?.status === 'running'

      // Drain the input optimistically so typing feels instant.
      setInput('')
      inputRef.current = ''
      setAttachments([])
      attachmentsRef.current = []

      const settings = {
        model: agentWindow.model ?? null,
        thinkingLevel: agentWindow.thinkingLevel ?? null,
        permissionMode: agentWindow.permissionMode ?? null,
      }

      // Cmd+Enter: interrupt the running turn and send this message NEXT —
      // ahead of anything else already queued. The drain effect pulls
      // queue[0] first, so jumping to the front is how "send immediately"
      // is expressed in terms of the existing queue.
      if (intent === 'stop' && running) {
        const entry: QueuedMessage = {
          text: value,
          attachments: pinned,
          mode: 'stop',
          ...settings,
        }
        setQueuedMessages((q) => [entry, ...q])
        queueRef.current = [entry, ...queueRef.current]
        void handleStop()
        return
      }

      // Option+Enter (after-tool) and plain Enter (after-turn) both queue the
      // message — they only differ in when the drain fires. after-tool
      // triggers a stop the moment a tool call completes; after-turn simply
      // waits for the turn to end naturally.
      if ((intent === 'after-tool' || intent === 'after-turn') && running) {
        const entry: QueuedMessage = {
          text: value,
          attachments: pinned,
          mode: intent,
          ...settings,
        }
        setQueuedMessages((q) => [...q, entry])
        queueRef.current = [...queueRef.current, entry]
        return
      }

      try {
        await sendToAgent(value, pinned)
      } catch (err) {
        setInput(value)
        inputRef.current = value
        setAttachments(pinned)
        attachmentsRef.current = pinned
        console.error('[agent-chat] send failed', err)
      }
    },
    [
      sendToAgent,
      handleStop,
      agentWindow.model,
      agentWindow.thinkingLevel,
      agentWindow.permissionMode,
    ],
  )

  const unqueueMessage = useCallback((index: number) => {
    setQueuedMessages((q) => q.filter((_, i) => i !== index))
    setEditingIndex((current) => {
      if (current === null) return current
      if (current === index) return null
      return current > index ? current - 1 : current
    })
  }, [])

  const beginEditQueued = useCallback(
    (index: number) => {
      const entry = queuedMessages[index]
      if (!entry) return
      setEditingIndex(index)
      setEditDraft(entry.text)
      setQueueCollapsed(false)
    },
    [queuedMessages],
  )

  const commitEditQueued = useCallback(() => {
    if (editingIndex === null) return
    const index = editingIndex
    const draft = editDraft.trim()
    setQueuedMessages((q) => q.map((m, i) => (i === index ? { ...m, text: draft || m.text } : m)))
    setEditingIndex(null)
    setEditDraft('')
  }, [editDraft, editingIndex])

  const cancelEditQueued = useCallback(() => {
    setEditingIndex(null)
    setEditDraft('')
  }, [])

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
    const front = queuedMessages[0]
    if (!front || front.mode !== 'after-tool') return
    afterToolFiredRef.current = true
    void handleStop()
  }, [snapshot?.messages, snapshot?.status, queuedMessages, handleStop])
  useEffect(() => {
    if (snapshot?.status !== 'idle') return
    if (queuedMessages.length === 0) return
    if (resumeGated) return
    if (sendingQueuedRef.current) return
    if (awaitingRunningRef.current) return
    sendingQueuedRef.current = true
    awaitingRunningRef.current = true
    const next = queuedMessages[0]
    // Defer the state update a microtask so we don't invoke setState
    // synchronously inside the effect (cascading-renders rule).
    queueMicrotask(() => {
      setQueuedMessages((q) => q.slice(1))
    })
    void sendToAgent(next.text, next.attachments, {
      model: next.model,
      thinkingLevel: next.thinkingLevel,
      permissionMode: next.permissionMode,
    })
      .catch((err) => {
        console.error('[agent-chat] queued send failed', err)
        // Put it back at the front so the user can retry / see it.
        setQueuedMessages((q) => [next, ...q])
        awaitingRunningRef.current = false
      })
      .finally(() => {
        sendingQueuedRef.current = false
      })
  }, [queuedMessages, resumeGated, sendToAgent, snapshot?.status])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if (event.key !== 'Enter') return
      if (event.shiftKey) return // Shift+Enter → newline
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
    [submit, handleStop],
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
      if (event.key !== 'Enter') return
      if (event.shiftKey) return
      if ((event as any).isComposing || event.keyCode === 229) return
      event.preventDefault()
      event.stopPropagation()
      if (event.metaKey) {
        void submit('stop')
      } else if (event.altKey) {
        void submit('after-tool')
      } else {
        void submit('after-turn')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [submit, handleStop, agentWindow.id])

  const messages = snapshot?.messages ?? []
  const hasMessages = messages.length > 0
  const groups = useMemo(() => groupMessages(messages), [messages])
  const lastTurnIndex = (() => {
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      if (groups[i].kind === 'turn') return i
    }
    return -1
  })()
  // Show the Craft-style "working" pill whenever the agent is running and the
  // last rendered group isn't a turn (= model hasn't emitted anything yet).
  const showPendingLoader =
    isRunning && (groups.length === 0 || groups[groups.length - 1].kind !== 'turn')

  return (
    <div
      className="agent-chat-panel flex h-full min-h-0 flex-col"
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
          <ScrollArea
            className="h-full min-w-0"
            viewportRef={scrollViewportRef}
            viewportClassName="rounded-none"
          >
            <div className="mx-auto min-h-full max-w-3xl py-6">
              {!hasMessages ? (
                <div className="flex min-h-[360px] flex-col items-center justify-center gap-6 py-10">
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
                      <p className="text-[11.5px] text-muted-foreground/60">No working directory</p>
                    )}
                  </div>
                  <AgentEmptyStateHint />
                  <div className="mt-1 flex flex-col items-stretch gap-1 text-[11.5px] text-muted-foreground/70">
                    {(['stop', 'after-tool', 'after-turn'] as const).map((mode) => {
                      const meta = QUEUE_MODE_META[mode]
                      return (
                        <div
                          key={mode}
                          className="flex items-center justify-between gap-3 rounded-[8px] border border-border/40 bg-background/40 px-2.5 py-1 shadow-minimal"
                        >
                          <div className="flex items-center gap-1.5">
                            <meta.Icon className={cn('size-3.5 shrink-0', meta.tint)} />
                            <span className="text-foreground/80">{meta.label}</span>
                          </div>
                          <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-foreground/6 px-1 text-[10px] text-muted-foreground/80">
                            {meta.shortcut}
                          </Kbd>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {groups.map((group, idx) => (
                    <GroupRenderer
                      key={group.key}
                      group={group}
                      agent={agentWindow.agent}
                      isStreamingLastTurn={isRunning && idx === lastTurnIndex}
                    />
                  ))}
                  {showPendingLoader ? (
                    <div className="flex justify-start px-2">
                      <PendingTurnIndicator agent={agentWindow.agent} />
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>

        <div className="relative shrink-0 px-4 pb-4 pt-2">
          <div className="mx-auto max-w-3xl">
            {snapshot?.error ? (
              <div className="mb-2 rounded-[12px] border border-red-500/25 bg-red-500/8 px-3 py-2 text-[12px] text-red-300 shadow-minimal">
                {snapshot.error}
              </div>
            ) : null}
            {snapshot?.pendingPlanApproval ? (
              <PlanApprovalBanner windowId={agentWindow.id} />
            ) : null}
            {snapshot?.pendingQuestion ? (
              <QuestionBanner
                windowId={agentWindow.id}
                questions={snapshot.pendingQuestion.questions}
              />
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
                <button
                  type="button"
                  onClick={() => setQueueCollapsed((v) => !v)}
                  className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1 text-left transition-colors hover:bg-foreground/5 focus:outline-none"
                  title={queueCollapsed ? 'Show queued messages' : 'Hide queued messages'}
                >
                  <span className="shrink-0 rounded-[4px] bg-background px-1.5 py-0.5 text-[10px] font-medium tabular-nums shadow-minimal">
                    {queuedMessages.length}
                  </span>
                  {(() => {
                    const next = queuedMessages[0]
                    const meta = QUEUE_MODE_META[next.mode]
                    return (
                      <meta.Icon
                        className={cn('size-3.5 shrink-0', meta.tint)}
                        aria-label={meta.label}
                      />
                    )
                  })()}
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                    {queuedMessages[0].text.replace(/\n/g, ' ') || '(attached files)'}
                  </span>
                  <ChevronRight
                    className={cn(
                      'ml-auto size-3.5 shrink-0 text-muted-foreground/70 transition-transform',
                      !queueCollapsed && 'rotate-90',
                    )}
                  />
                </button>
                {!queueCollapsed ? (
                  <div className="mt-1 flex max-h-[108px] flex-col gap-1 overflow-y-auto overscroll-contain pr-0.5">
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
                      return (
                        <div
                          key={`${i}-${entry.text.slice(0, 16)}`}
                          draggable={!isEditing}
                          onDragStart={(e) => {
                            if (isEditing) return
                            setDragIndex(i)
                            e.dataTransfer.effectAllowed = 'move'
                            try {
                              e.dataTransfer.setData('text/plain', String(i))
                            } catch {
                              // Safari may throw if dataTransfer is locked; drag still works.
                            }
                          }}
                          onDragOver={(e) => {
                            if (dragIndex === null || dragIndex === i) return
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            if (dragOverIndex !== i) setDragOverIndex(i)
                          }}
                          onDragLeave={() => {
                            setDragOverIndex((prev) => (prev === i ? null : prev))
                          }}
                          onDrop={(e) => {
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
                            'group/queued flex gap-2 rounded-[10px] border border-border/50 bg-muted/30 px-2.5 py-1.5 text-[12px] text-foreground/85 shadow-minimal transition-colors',
                            isEditing ? 'items-start' : 'items-center',
                            isEditing && 'border-foreground/30 bg-muted/50',
                            isDragging && 'opacity-50',
                            isDropTarget && 'border-foreground/40 bg-foreground/5',
                          )}
                          title={
                            isEditing
                              ? undefined
                              : `${meta.shortcut} · ${meta.hint} · drag to reorder`
                          }
                        >
                          {!isEditing ? (
                            <span
                              className="flex size-3.5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground/70 group-hover/queued:opacity-100 active:cursor-grabbing"
                              aria-label="Drag to reorder"
                              title="Drag to reorder"
                            >
                              <GripVertical className="size-3" />
                            </span>
                          ) : null}
                          <meta.Icon
                            className={cn('size-3.5 shrink-0', isEditing && 'mt-[3px]', meta.tint)}
                            aria-label={meta.label}
                          />
                          <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            {isEditing ? (
                              <textarea
                                autoFocus
                                value={editDraft}
                                onChange={(e) => setEditDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    commitEditQueued()
                                  } else if (e.key === 'Escape') {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    cancelEditQueued()
                                  }
                                }}
                                onBlur={commitEditQueued}
                                rows={Math.min(6, Math.max(1, editDraft.split('\n').length))}
                                className="min-w-0 w-full resize-none border-0 bg-transparent p-0 text-[12px] leading-[1.45] text-foreground/95 outline-none"
                              />
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => beginEditQueued(i)}
                                  className="min-w-0 flex-1 truncate text-left text-muted-foreground/90 hover:text-foreground"
                                  title="Click to edit"
                                >
                                  {entry.text.replace(/\n/g, ' ') ||
                                    (entry.attachments.length > 0 ? '(attached files)' : '')}
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
                              </>
                            )}
                          </div>
                          <div
                            className={cn(
                              'flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground/80',
                              isEditing && 'self-start',
                            )}
                          >
                            {modelLabel ? (
                              <span
                                className="rounded-[6px] border border-border/40 bg-background/40 px-1.5 py-px"
                                title={`Model: ${modelLabel}`}
                              >
                                {modelLabel}
                              </span>
                            ) : null}
                            {thinkingLabel ? (
                              <span
                                className="rounded-[6px] border border-border/40 bg-background/40 px-1.5 py-px"
                                title={`Thinking: ${thinkingLabel}`}
                              >
                                {thinkingLabel}
                              </span>
                            ) : null}
                            {permissionOption ? (
                              <span
                                className={cn(
                                  'inline-flex items-center gap-1 rounded-[6px] border border-border/40 bg-background/40 px-1.5 py-px',
                                  permissionOption.tint,
                                )}
                                title={`Permission: ${permissionOption.label}`}
                              >
                                <permissionOption.Icon className="size-2.5" />
                                {permissionOption.short}
                              </span>
                            ) : null}
                          </div>
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                onMouseDown={(e) => {
                                  // prevent textarea blur from firing commit before this click handler
                                  e.preventDefault()
                                }}
                                onClick={commitEditQueued}
                                aria-label="Save edit"
                                title="Save (Enter)"
                                className="shrink-0 rounded p-0.5 text-success/80 hover:bg-foreground/10 hover:text-success"
                              >
                                <Check className="size-3" />
                              </button>
                              <button
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={cancelEditQueued}
                                aria-label="Cancel edit"
                                title="Cancel (Esc)"
                                className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground"
                              >
                                <X className="size-3" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => beginEditQueued(i)}
                                aria-label="Edit queued message"
                                title="Edit"
                                className="shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover/queued:opacity-100"
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
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div
              className={cn(
                'group/composer relative overflow-hidden rounded-[14px] border bg-background/95 shadow-middle transition-colors',
                isComposerFocused ? 'border-foreground/25' : 'border-border/60 hover:border-border',
              )}
            >
              {attachments.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border/30 px-2.5 pb-2 pt-2">
                  {attachments.map((p) => (
                    <ComposerAttachmentChip key={p} path={p} onRemove={() => removeAttachment(p)} />
                  ))}
                </div>
              ) : null}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onFocus={() => setIsComposerFocused(true)}
                onBlur={() => setIsComposerFocused(false)}
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
                placeholder={composerPlaceholder}
                spellCheck={false}
                rows={Math.min(8, Math.max(3, input.split('\n').length))}
                className="block w-full min-h-[72px] resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-6 text-foreground placeholder:text-muted-foreground/55 outline-none border-0 focus:outline-none focus-visible:outline-none"
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
                    useStore.getState().syncAgentWindow(agentWindow.id, { permissionMode: mode })
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
                  onChange={(modelId) =>
                    useStore.getState().syncAgentWindow(agentWindow.id, { model: modelId })
                  }
                  onContextLengthChange={(length: AgentContextLength) => {
                    useStore.getState().syncAgentWindow(agentWindow.id, { contextLength: length })
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
                  onChange={(level) =>
                    useStore.getState().syncAgentWindow(agentWindow.id, { thinkingLevel: level })
                  }
                />
                <ContextUsageIndicator
                  usage={snapshot?.usage ?? null}
                  agent={agentWindow.agent}
                  contextLength={agentWindow.contextLength}
                />
                <div className="flex-1" />
                {!isRunning ? (
                  <span className="hidden items-center gap-1 text-[10.5px] text-muted-foreground/60 sm:inline-flex">
                    <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-foreground/6 px-1 text-[10px] text-muted-foreground/80">
                      ↵
                    </Kbd>
                    <span>send</span>
                  </span>
                ) : null}
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
                      ? 'bg-amber-400/90 text-background hover:bg-amber-400'
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
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
