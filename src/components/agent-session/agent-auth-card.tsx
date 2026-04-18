import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, KeyRound, Loader2, XCircle } from 'lucide-react'
import type { AgentSessionMessage, AgentWindowNode } from '@/types'
import { cn } from '@/lib/utils'
import { AgentIcon } from '@/components/agent-icon'

// Copied and adapted from Craft Agents OSS:
// ../craft-agents-oss/apps/electron/src/renderer/components/chat/AuthRequestCard.tsx
// Craft-style flow: spawn the CLI hidden, sniff the OAuth URL, open the
// browser automatically, show live state — the user never sees a terminal.

interface AgentAuthCardProps {
  message: AgentSessionMessage
  agent: AgentWindowNode['agent']
}

type Phase = 'idle' | 'starting' | 'awaiting_browser' | 'success' | 'failed' | 'cancelled'

function agentLabel(agent: AgentWindowNode['agent']) {
  return agent === 'claude' ? 'Claude Code' : 'Codex'
}

export function AgentAuthCard({ message, agent }: AgentAuthCardProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [authUrl, setAuthUrl] = useState<string | null>(message.authLoginUrl ?? null)
  const [errorText, setErrorText] = useState<string | null>(null)

  // Subscribe to login events while mounted — both agent cards receive
  // every event but we filter by agent.
  useEffect(() => {
    const unsubscribe = window.cells.agentSession.onLoginEvent((event) => {
      if (event.agent !== agent) return
      setPhase(event.phase)
      if (event.url) setAuthUrl(event.url)
      if (event.message) setErrorText(event.message)
      else if (event.phase !== 'failed') setErrorText(null)
    })
    return unsubscribe
  }, [agent])

  const persistedDone = (message.status ?? 'in_progress') === 'completed'
  const effective: Phase = persistedDone ? 'success' : phase
  const isBusy = effective === 'starting' || effective === 'awaiting_browser'
  const isDone = effective === 'success'
  const isFailed = effective === 'failed' || effective === 'cancelled'

  const variantClasses = isFailed
    ? 'border-red-500/25 bg-red-500/5'
    : isDone
      ? 'border-emerald-500/25 bg-emerald-500/5'
      : 'border-border/60 bg-background/70'

  const StatusIcon = isFailed ? XCircle : isDone ? CheckCircle2 : KeyRound
  const statusTint = isFailed
    ? 'text-red-400'
    : isDone
      ? 'text-emerald-400'
      : isBusy
        ? 'text-amber-400'
        : 'text-foreground/80'
  const statusLabel = isFailed
    ? effective === 'cancelled'
      ? 'Cancelled'
      : 'Failed'
    : isDone
      ? 'Signed in'
      : effective === 'starting'
        ? 'Starting…'
        : effective === 'awaiting_browser'
          ? 'Waiting for browser'
          : 'Action needed'

  const handleSignIn = async () => {
    setErrorText(null)
    setPhase('starting')
    try {
      await window.cells.agentSession.startLogin(agent)
    } catch (err) {
      setPhase('failed')
      setErrorText(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCancel = () => {
    void window.cells.agentSession.cancelLogin(agent)
  }

  return (
    <div
      className={cn(
        'mx-auto w-full max-w-[520px] rounded-[14px] border p-4 shadow-middle transition-colors',
        variantClasses,
      )}
    >
      <div className="mb-3 flex items-center gap-3">
        <div className="relative flex size-9 items-center justify-center rounded-[10px] border border-border/50 bg-background/80">
          <AgentIcon agent={agent} className="size-5" />
          <span className="absolute -right-1 -bottom-1 inline-flex size-4 items-center justify-center rounded-full bg-background ring-2 ring-background">
            {isBusy ? (
              <Loader2 className={cn('size-3.5 animate-spin', statusTint)} />
            ) : (
              <StatusIcon className={cn('size-3.5', statusTint)} strokeWidth={2.5} />
            )}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13px] font-semibold text-foreground">
              {message.title || `Sign in to ${agentLabel(agent)}`}
            </p>
            <span
              className={cn(
                'rounded-full border px-1.5 py-[1px] text-[9.5px] font-medium uppercase tracking-[0.14em]',
                isFailed
                  ? 'border-red-500/30 text-red-300'
                  : isDone
                    ? 'border-emerald-500/30 text-emerald-300'
                    : isBusy
                      ? 'border-amber-500/30 text-amber-300'
                      : 'border-border/60 text-muted-foreground',
              )}
            >
              {statusLabel}
            </span>
          </div>
        </div>
      </div>

      <div className="mb-3 whitespace-pre-wrap break-words text-[12.5px] leading-[1.55] text-foreground/80">
        {isDone
          ? `You're signed in. Retry your last message to continue.`
          : effective === 'awaiting_browser'
            ? 'Approve access in the browser window we just opened. This card will update the moment it completes.'
            : isFailed
              ? errorText || 'Sign in was interrupted. Try again when you’re ready.'
              : message.text}
      </div>

      {!isDone ? (
        <div className="flex flex-col gap-2">
          {isBusy ? (
            <div className="flex items-center gap-2">
              {authUrl ? (
                <button
                  type="button"
                  onClick={() => void window.cells.app.openExternal(authUrl)}
                  className="inline-flex h-8 flex-1 items-center justify-center gap-2 rounded-[10px] border border-border/60 bg-background/70 px-3 text-[12px] text-foreground transition-colors hover:bg-foreground/5"
                >
                  <ExternalLink className="size-3.5" />
                  <span>Re-open browser</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={handleCancel}
                className="inline-flex h-8 items-center justify-center gap-2 rounded-[10px] border border-border/60 bg-background/70 px-3 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleSignIn}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-[10px] bg-foreground px-3 text-[13px] font-medium text-background shadow-minimal transition-colors hover:bg-foreground/90"
            >
              <KeyRound className="size-3.5" />
              <span>{isFailed ? `Try again` : `Sign in to ${agentLabel(agent)}`}</span>
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}
