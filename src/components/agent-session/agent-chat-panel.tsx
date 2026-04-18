import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Folder, Paperclip, Square, X } from 'lucide-react'
import type {
  AgentPermissionMode,
  AgentSessionMessage,
  AgentSessionSnapshot,
  AgentWindowNode,
} from '@/types'
import { useStore } from '@/lib/store'
import { AgentIcon } from '@/components/agent-icon'
import { AgentEmptyStateHint } from './agent-empty-state-hint'
import { AgentMarkdown } from './agent-markdown'
import { AgentAuthCard } from './agent-auth-card'
import { ModelPicker, PermissionPicker, getDefaultPermissionMode } from './agent-composer-toolbar'
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

function UserBubble({ message }: { message: AgentSessionMessage }) {
  // Deliberately tighter than Craft's bubble — the user asked for a more
  // compact message pill than Craft's (px-4 py-2.5 text-sm with wider max-w).
  return (
    <div className="mt-8 flex w-full justify-end">
      <div className="max-w-[78%] break-words rounded-[10px] bg-foreground/5 px-3 py-1.5 text-[13px] leading-[1.45] text-foreground select-text">
        <AgentMarkdown inline>{message.text}</AgentMarkdown>
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
        // Preserve chronological order of assistant preamble vs tool activity.
        // If the model streams text BEFORE any tool call (e.g. "Let me find
        // your tmux config."), we close the preamble as its own
        // response-only card, then start a new turn for the tool + final
        // answer. That way the preamble renders above the tool stripe the
        // way the user saw it arrive, not below it.
        if (
          message.role !== 'assistant' &&
          pending &&
          pending.responses.length > 0 &&
          pending.activities.length === 0
        ) {
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
  const [queuedMessages, setQueuedMessages] = useState<string[]>([])
  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const inputRef = useRef(input)
  inputRef.current = input
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const windowIdRef = useRef(agentWindow.id)
  windowIdRef.current = agentWindow.id

  useEffect(() => {
    let cancelled = false

    const sync = (next: AgentSessionSnapshot) => {
      if (cancelled || next.windowId !== agentWindow.id) return
      setSnapshot(next)
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
  attachmentsRef.current = attachments
  const queueRef = useRef<string[]>(queuedMessages)
  queueRef.current = queuedMessages

  // Actually ship one message to the agent. Separated from submit() so the
  // queue-flusher effect can call it too.
  const sendToAgent = useCallback(
    async (value: string) => {
      const trySend = () => window.cells.agentSession.send(windowIdRef.current, value)
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

  const submit = useCallback(async () => {
    const rawValue = inputRef.current.trim()
    const pinned = attachmentsRef.current
    if (!rawValue && pinned.length === 0) return
    // Craft emits attachments inline as `[path]` references so the agent can
    // open them via the file-read tool.
    const attachmentLine = pinned.length ? pinned.map((p) => `[${p}]`).join(' ') + '\n\n' : ''
    const value = `${attachmentLine}${rawValue}`.trim()
    if (!value) return

    // Drain the input optimistically so typing feels instant.
    setInput('')
    inputRef.current = ''
    setAttachments([])
    attachmentsRef.current = []

    // If the agent is mid-turn, queue the message — it'll fire as soon as the
    // current turn finishes. This matches Craft's behavior.
    if (snapshotRef.current?.status === 'running') {
      setQueuedMessages((q) => [...q, value])
      queueRef.current = [...queueRef.current, value]
      return
    }

    try {
      await sendToAgent(value)
    } catch (err) {
      setInput(value)
      inputRef.current = value
      console.error('[agent-chat] send failed', err)
    }
  }, [sendToAgent])

  const unqueueMessage = useCallback((index: number) => {
    setQueuedMessages((q) => q.filter((_, i) => i !== index))
  }, [])

  // Drain the queue whenever the agent flips back to idle. Pop the front
  // item OPTIMISTICALLY before dispatching — if sendToAgent throws we push
  // it back. Prior version removed-on-success but sendToAgent resolves after
  // the agent flips to `running`, which the user could read as "the queue
  // item is still there even though the agent already started it".
  const sendingQueuedRef = useRef(false)
  useEffect(() => {
    if (snapshot?.status !== 'idle') return
    if (queuedMessages.length === 0) return
    if (sendingQueuedRef.current) return
    sendingQueuedRef.current = true
    const next = queuedMessages[0]
    setQueuedMessages((q) => q.slice(1))
    void sendToAgent(next)
      .catch((err) => {
        console.error('[agent-chat] queued send failed', err)
        // Put it back at the front so the user can retry / see it.
        setQueuedMessages((q) => [next, ...q])
      })
      .finally(() => {
        sendingQueuedRef.current = false
      })
  }, [queuedMessages, sendToAgent, snapshot?.status])

  const handleStop = useCallback(async () => {
    try {
      // v2 SDKSession has no interrupt; closing the session is the only way
      // to actually halt an in-flight turn.
      await window.cells.agentSession.close(windowIdRef.current)
    } catch (err) {
      console.error('[agent-chat] stop failed', err)
    }
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape' && snapshotRef.current?.status === 'running') {
        event.preventDefault()
        event.stopPropagation()
        void handleStop()
        return
      }
      if (event.key !== 'Enter') return
      if (event.shiftKey || event.altKey) return
      event.preventDefault()
      event.stopPropagation()
      void submit()
    },
    [submit, handleStop],
  )

  // Capture-phase fallback for ancestors that swallow keydown.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Esc → stop the running turn. Works from anywhere inside the agent
      // window (textarea, body, etc.) as long as this window is focused.
      if (
        event.key === 'Escape' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        useStore.getState().focusedAgentWindowId === agentWindow.id &&
        snapshotRef.current?.status === 'running'
      ) {
        event.preventDefault()
        event.stopPropagation()
        void handleStop()
        return
      }
      if (document.activeElement !== textareaRef.current) return
      if (event.key !== 'Enter') return
      if (event.shiftKey || event.altKey) return
      if ((event as any).isComposing || event.keyCode === 229) return
      event.preventDefault()
      event.stopPropagation()
      void submit()
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
    <div className="agent-chat-panel flex h-full min-h-0 flex-col" data-focus-zone="chat">
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
            <div
              className={cn(
                'group/composer relative overflow-hidden rounded-[14px] border bg-background/95 shadow-middle transition-colors',
                isComposerFocused ? 'border-foreground/25' : 'border-border/60 hover:border-border',
              )}
            >
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
              {attachments.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 border-t border-border/30 px-2.5 pt-2">
                  {attachments.map((p) => {
                    const name = p.split('/').pop() || p
                    return (
                      <span
                        key={p}
                        className="inline-flex items-center gap-1 rounded-[6px] bg-foreground/5 pl-2 pr-1 py-0.5 text-[11px] text-muted-foreground/90"
                        title={p}
                      >
                        <Paperclip className="size-3" />
                        <span className="truncate max-w-[180px] font-mono">{name}</span>
                        <button
                          type="button"
                          onClick={() => removeAttachment(p)}
                          aria-label={`Remove ${name}`}
                          className="ml-0.5 rounded p-0.5 text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    )
                  })}
                </div>
              ) : null}
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
                  thinkingLevel={agentWindow.thinkingLevel}
                  onChange={(modelId) =>
                    useStore.getState().syncAgentWindow(agentWindow.id, { model: modelId })
                  }
                  onThinkingChange={(level) =>
                    useStore.getState().syncAgentWindow(agentWindow.id, { thinkingLevel: level })
                  }
                />
                <div className="flex-1" />
                {isRunning ? (
                  <span className="hidden items-center gap-1 text-[10.5px] text-amber-300/90 sm:inline-flex">
                    <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-amber-400/15 px-1 text-[10px] text-amber-200">
                      esc
                    </Kbd>
                    <span>to stop</span>
                  </span>
                ) : (
                  <span className="hidden items-center gap-1 text-[10.5px] text-muted-foreground/60 sm:inline-flex">
                    <Kbd className="h-[18px] min-w-[18px] rounded-[4px] bg-foreground/6 px-1 text-[10px] text-muted-foreground/80">
                      ↵
                    </Kbd>
                    <span>send</span>
                  </span>
                )}
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
            {queuedMessages.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {queuedMessages.map((text, i) => (
                  <span
                    key={`${i}-${text.slice(0, 16)}`}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-[8px] border border-amber-500/25 bg-amber-500/8 pl-2 pr-1 py-1 text-[11px] text-amber-200"
                    title={text}
                  >
                    <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.14em] text-amber-300/80">
                      queued
                    </span>
                    <span className="truncate max-w-[320px]">{text.replace(/\n/g, ' ')}</span>
                    <button
                      type="button"
                      onClick={() => unqueueMessage(i)}
                      aria-label="Remove queued message"
                      className="ml-0.5 rounded p-0.5 text-amber-300/80 hover:bg-amber-500/15 hover:text-amber-100"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
