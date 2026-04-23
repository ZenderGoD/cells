import type {
  AgentName,
  AgentSessionSnapshot,
  AgentStatus,
  AgentWindowNode,
  AgentWindowStatus,
  TerminalRuntimeStatus,
} from '@/types'

export type ProjectAttention = 'approval' | 'error' | 'waiting' | 'working' | 'done' | null

/** Per-window activity surfaced on a project tab as a colored stripe.
 *  Derived from each terminal's runtime status and each agent window's status
 *  so both kinds of sessions contribute equally. Ordered by priority (see
 *  `getProjectWindowActivities`) so "needs attention" items lead. */
export type WindowActivityKind =
  | 'approval'
  | 'input'
  | 'error'
  | 'plan'
  | 'waiting'
  | 'unread-done'
  | 'working'
  | 'running-process'

export interface ProjectWindowActivity {
  key: string
  source: 'terminal' | 'agent'
  kind: WindowActivityKind
  updatedAt: number
}

export interface StatusPresentation {
  ringClass: string
  dotClass: string
  pillClass: string
  label: string
  detail: string
  /** Extra detail lines — plan/question/queue/usage state — for UIs that
   *  want to render more than the single-line `detail`. Empty if no snapshot
   *  is provided or none of the conditions apply. */
  details: string[]
  projectAttention: ProjectAttention
}

export interface AgentWindowStatusPresentation {
  label: string
  dotClass: string
  pillClass: string
  ringClass: string
}

const NONE: StatusPresentation = {
  ringClass: '',
  dotClass: '',
  pillClass: '',
  label: '',
  detail: '',
  details: [],
  projectAttention: null,
}

export function getAgentWindowStatusPresentation(
  status: AgentWindowStatus | null | undefined,
  options?: { hasUnviewedCompletion?: boolean },
): AgentWindowStatusPresentation {
  // "Done but unchecked" beats idle — surfaces finished work the user hasn't
  // looked at yet with a calm emerald dot. Only applies when the session is
  // otherwise idle; any active state (approval/input/running/plan) takes
  // priority since those are more urgent than "you have unread results".
  if (status === 'idle' && options?.hasUnviewedCompletion) {
    return {
      label: 'Done',
      pillClass: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300',
      dotClass: 'bg-emerald-400',
      ringClass: 'ring-1 ring-emerald-500/65',
    }
  }
  // Palette mirrors t3code's sidebar pill (amber→indigo→sky→violet→emerald).
  // Only active states pulse so the minimap reads as calm at rest.
  if (status === 'awaiting-approval') {
    return {
      label: 'Approval needed',
      pillClass: 'border-amber-400/25 bg-amber-500/10 text-amber-300',
      dotClass: 'bg-amber-400 animate-pulse',
      ringClass: 'ring-1 ring-amber-500/70',
    }
  }
  if (status === 'awaiting-input') {
    return {
      label: 'Awaiting input',
      pillClass: 'border-indigo-400/25 bg-indigo-500/10 text-indigo-300',
      dotClass: 'bg-indigo-400 animate-pulse',
      ringClass: 'ring-1 ring-indigo-500/70',
    }
  }
  if (status === 'running') {
    return {
      label: 'Working',
      pillClass: 'border-sky-400/25 bg-sky-500/10 text-sky-300',
      dotClass: 'bg-sky-400 animate-pulse',
      ringClass: 'ring-1 ring-sky-500/65',
    }
  }
  if (status === 'plan-ready') {
    return {
      label: 'Plan ready',
      pillClass: 'border-violet-400/25 bg-violet-500/10 text-violet-300',
      dotClass: 'bg-violet-400',
      ringClass: 'ring-1 ring-violet-500/70',
    }
  }
  if (status === 'error') {
    return {
      label: 'Error',
      pillClass: 'border-red-400/25 bg-red-500/10 text-red-300',
      dotClass: 'bg-red-400',
      ringClass: 'ring-1 ring-rose-500/70',
    }
  }
  return {
    label: 'Idle',
    pillClass: 'border-border/30 bg-muted/40 text-muted-foreground/80',
    dotClass: 'bg-muted-foreground/50',
    ringClass: '',
  }
}

function buildAgentDetails(
  snapshot?: AgentSessionSnapshot | null,
  windowNode?: AgentWindowNode | null,
): string[] {
  const details: string[] = []
  if (snapshot?.pendingPlanApproval) {
    details.push('Plan proposed — awaiting approval')
  }
  if (snapshot?.pendingApproval) {
    details.push(
      snapshot.pendingApproval.kind === 'command'
        ? 'Command approval needed'
        : 'File-change approval needed',
    )
  }
  if (snapshot?.pendingQuestion) {
    const n = snapshot.pendingQuestion.questions.length
    details.push(n === 1 ? 'Question for you' : `${n} questions for you`)
  }
  if (snapshot?.codexPlan && snapshot.codexPlan.items.length > 0) {
    const done = snapshot.codexPlan.items.filter((item) => item.completed).length
    details.push(`Plan: ${done}/${snapshot.codexPlan.items.length}`)
  }
  if (windowNode?.queuedMessages && windowNode.queuedMessages.length > 0) {
    const n = windowNode.queuedMessages.length
    details.push(n === 1 ? '1 message queued' : `${n} messages queued`)
  }
  if (snapshot?.usage && snapshot.usage.contextWindow) {
    const used =
      snapshot.usage.usedTokens && snapshot.usage.usedTokens > 0
        ? snapshot.usage.usedTokens
        : snapshot.usage.totalProcessedTokens && snapshot.usage.totalProcessedTokens > 0
          ? Math.min(snapshot.usage.totalProcessedTokens, snapshot.usage.contextWindow)
          : 0
    const pct = Math.round((used / snapshot.usage.contextWindow) * 100)
    if (pct >= 1) details.push(`${pct}% context`)
  }
  return details
}

const AGENT_LABELS: Record<AgentName, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
}

function legacyToRuntimeStatus(
  runtimeStatus?: TerminalRuntimeStatus | null,
  fallback?: {
    agent?: AgentName | null
    agentStatus?: AgentStatus | undefined
    processRunning?: boolean | undefined
  },
): TerminalRuntimeStatus | null {
  if (runtimeStatus) return runtimeStatus
  if (fallback?.agentStatus === 'active') {
    return {
      kind: 'agent',
      agent: fallback.agent ?? null,
      state: 'working',
      detail: 'Working',
      shortLabel: 'Working',
      source: 'legacy',
      updatedAt: 0,
    }
  }
  if (fallback?.agentStatus === 'unread') {
    return {
      kind: 'agent',
      agent: fallback.agent ?? null,
      state: 'waiting',
      detail: 'Waiting for input',
      shortLabel: 'Waiting',
      source: 'legacy',
      updatedAt: 0,
      attention: true,
    }
  }
  if (fallback?.agentStatus === 'done') {
    return {
      kind: 'agent',
      agent: fallback.agent ?? null,
      state: 'done',
      detail: 'Done',
      shortLabel: 'Done',
      source: 'legacy',
      updatedAt: 0,
    }
  }
  if (!fallback?.agent && fallback?.processRunning) {
    return {
      kind: 'process',
      detail: 'Running',
      shortLabel: 'Running',
      source: 'legacy',
      updatedAt: 0,
    }
  }
  if (fallback?.agent) {
    return {
      kind: 'agent',
      agent: fallback.agent,
      state: 'working',
      detail: 'Working',
      shortLabel: 'Working',
      source: 'fallback:agent-brand',
      updatedAt: 0,
      attention: false,
    }
  }
  return null
}

function getProjectAttention(runtimeStatus: TerminalRuntimeStatus | null): ProjectAttention {
  if (runtimeStatus?.kind !== 'agent') return null
  if (runtimeStatus.source === 'fallback:agent-brand') return null
  switch (runtimeStatus.state) {
    case 'approval':
      return 'approval'
    case 'error':
      return 'error'
    case 'waiting':
      return 'waiting'
    case 'working':
      return 'working'
    case 'done':
      return 'done'
    default:
      return null
  }
}

function formatStatusDetail(runtimeStatus: TerminalRuntimeStatus | null) {
  if (!runtimeStatus) return ''
  if (runtimeStatus.kind === 'agent') {
    const label = runtimeStatus.agent ? AGENT_LABELS[runtimeStatus.agent] : 'Agent'
    return `${label} · ${runtimeStatus.detail}`
  }
  if (runtimeStatus.kind === 'process') {
    return `${runtimeStatus.processLabel || 'Process'} · ${runtimeStatus.detail}`
  }
  return runtimeStatus.detail
}

export function getStatusPresentation(
  runtimeStatus?: TerminalRuntimeStatus | null,
  fallback?: {
    agent?: AgentName | null
    agentStatus?: AgentStatus | undefined
    processRunning?: boolean | undefined
  },
  extras?: {
    /** Agent snapshot — used to derive plan/question/usage detail lines. */
    agentSnapshot?: AgentSessionSnapshot | null
    /** Agent window node — used to derive queued-message count detail. */
    agentWindow?: AgentWindowNode | null
  },
): StatusPresentation {
  const resolved = legacyToRuntimeStatus(runtimeStatus, fallback)
  if (!resolved) return NONE

  const detail = formatStatusDetail(resolved)
  const attention = getProjectAttention(resolved)
  const details = buildAgentDetails(extras?.agentSnapshot, extras?.agentWindow)

  if (resolved.kind === 'process') {
    return {
      ringClass: 'ring-1 ring-white/15',
      dotClass: 'bg-white/35',
      pillClass: 'border-white/12 bg-white/8 text-foreground/55',
      label: detail || 'Process running',
      detail,
      details,
      projectAttention: null,
    }
  }

  switch (resolved.state) {
    case 'approval':
      return {
        ringClass: 'ring-1 ring-amber-500/70',
        dotClass: 'bg-amber-400',
        pillClass: 'border-amber-500/25 bg-amber-500/10 text-amber-200',
        label: detail || 'Approval needed',
        detail,
        details,
        projectAttention: attention,
      }
    case 'error':
      return {
        ringClass: 'ring-1 ring-rose-500/70',
        dotClass: 'bg-rose-400',
        pillClass: 'border-rose-500/25 bg-rose-500/10 text-rose-200',
        label: detail || 'Agent error',
        detail,
        details,
        projectAttention: attention,
      }
    case 'waiting':
      return {
        ringClass: 'ring-1 ring-sky-500/65',
        dotClass: 'bg-sky-400',
        pillClass: 'border-sky-500/25 bg-sky-500/10 text-sky-200',
        label: detail || 'Waiting for input',
        detail,
        details,
        projectAttention: attention,
      }
    case 'done':
      return {
        ringClass: 'ring-1 ring-emerald-400/90',
        dotClass: 'bg-emerald-400',
        pillClass: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200',
        label: detail || 'Done',
        detail,
        details,
        projectAttention: attention,
      }
    case 'working':
    default:
      return {
        ringClass: 'ring-1 ring-primary/80 animate-pulse',
        dotClass: 'bg-primary/90 animate-pulse',
        pillClass: 'border-primary/25 bg-primary/10 text-primary/90',
        label: detail || 'Working',
        detail,
        details,
        projectAttention: attention,
      }
  }
}

const ACTIVITY_PRIORITY: Record<WindowActivityKind, number> = {
  approval: 80,
  input: 70,
  error: 60,
  plan: 50,
  waiting: 40,
  'unread-done': 30,
  working: 20,
  'running-process': 10,
}

function terminalActivityKind(terminal: {
  runtimeStatus?: TerminalRuntimeStatus | null
  agent?: AgentName | null
  agentStatus?: AgentStatus | undefined
  processRunning?: boolean | undefined
}): WindowActivityKind | null {
  const resolved = legacyToRuntimeStatus(terminal.runtimeStatus, terminal)
  if (!resolved) return null
  if (resolved.kind === 'process') return 'running-process'
  if (resolved.kind !== 'agent') return null
  if (resolved.source === 'fallback:agent-brand') return null
  switch (resolved.state) {
    case 'approval':
      return 'approval'
    case 'error':
      return 'error'
    case 'waiting':
      return 'waiting'
    case 'working':
      return 'working'
    case 'done':
      return 'unread-done'
    default:
      return null
  }
}

function agentWindowActivityKind(window: {
  status?: AgentWindowStatus
  hasUnviewedCompletion?: boolean
}): WindowActivityKind | null {
  switch (window.status) {
    case 'awaiting-approval':
      return 'approval'
    case 'awaiting-input':
      return 'input'
    case 'error':
      return 'error'
    case 'plan-ready':
      return 'plan'
    case 'running':
      return 'working'
    case 'idle':
    case undefined:
      return window.hasUnviewedCompletion ? 'unread-done' : null
    default:
      return null
  }
}

export function getProjectWindowActivities(
  terminals: Array<{
    id: string
    runtimeStatus?: TerminalRuntimeStatus | null
    agent?: AgentName | null
    agentStatus?: AgentStatus | undefined
    processRunning?: boolean | undefined
  }>,
  agentWindows: Array<{
    id: string
    status?: AgentWindowStatus
    hasUnviewedCompletion?: boolean
  }>,
  options: { limit?: number } = {},
): ProjectWindowActivity[] {
  const items: ProjectWindowActivity[] = []

  for (const terminal of terminals) {
    const kind = terminalActivityKind(terminal)
    if (!kind) continue
    items.push({
      key: `t:${terminal.id}`,
      source: 'terminal',
      kind,
      updatedAt: terminal.runtimeStatus?.updatedAt ?? 0,
    })
  }

  for (const window of agentWindows) {
    const kind = agentWindowActivityKind(window)
    if (!kind) continue
    items.push({
      key: `a:${window.id}`,
      source: 'agent',
      kind,
      updatedAt: 0,
    })
  }

  items.sort((a, b) => {
    const dp = ACTIVITY_PRIORITY[b.kind] - ACTIVITY_PRIORITY[a.kind]
    if (dp !== 0) return dp
    return b.updatedAt - a.updatedAt
  })

  const limit = options.limit ?? 8
  return items.slice(0, limit)
}

export function getProjectRuntimeAttention(
  terminals: Array<{
    runtimeStatus?: TerminalRuntimeStatus | null
    agent?: AgentName | null
    agentStatus?: AgentStatus | undefined
    processRunning?: boolean | undefined
  }>,
): ProjectAttention {
  let best: ProjectAttention = null
  let bestPriority = -1

  const priorities: Record<Exclude<ProjectAttention, null>, number> = {
    approval: 5,
    error: 4,
    waiting: 3,
    working: 2,
    done: 1,
  }

  for (const terminal of terminals) {
    const attention = getStatusPresentation(terminal.runtimeStatus, terminal).projectAttention
    if (!attention) continue
    const priority = priorities[attention]
    if (priority > bestPriority) {
      bestPriority = priority
      best = attention
    }
  }

  return best
}
