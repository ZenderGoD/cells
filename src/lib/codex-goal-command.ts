export type CodexGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete'

export type CodexGoalCommand =
  | { kind: 'show' }
  | { kind: 'clear' }
  | { kind: 'set-status'; status: 'active' | 'paused' }
  | { kind: 'set-objective'; objective: string }

export interface CodexThreadGoal {
  threadId: string
  objective: string
  status: CodexGoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

export function parseCodexGoalCommand(input: string): CodexGoalCommand | null {
  const trimmed = input.trim()
  if (trimmed !== '/goal' && !trimmed.startsWith('/goal ')) return null
  const args = trimmed.slice('/goal'.length).trim()
  if (!args) return { kind: 'show' }

  const [first, ...rest] = args.split(/\s+/)
  const normalized = first.toLowerCase()
  if (normalized === 'clear') return { kind: 'clear' }
  if (normalized === 'pause') return { kind: 'set-status', status: 'paused' }
  if (normalized === 'resume') return { kind: 'set-status', status: 'active' }

  if (normalized === 'edit') {
    const objective = rest.join(' ').trim()
    return objective ? { kind: 'set-objective', objective } : { kind: 'show' }
  }

  return { kind: 'set-objective', objective: args }
}

export function formatCodexGoalElapsed(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  if (safeSeconds < 60) return `${safeSeconds}s`
  const minutes = Math.floor(safeSeconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`
}

export function formatCodexGoalStatus(status: CodexGoalStatus) {
  switch (status) {
    case 'active':
      return 'active'
    case 'paused':
      return 'paused'
    case 'blocked':
      return 'blocked'
    case 'usageLimited':
      return 'usage limited'
    case 'budgetLimited':
      return 'limited by budget'
    case 'complete':
      return 'complete'
  }
}

export function formatCodexGoalSummary(goal: CodexThreadGoal | null) {
  if (!goal) return 'No goal is set for this Codex thread.'

  const lines = [
    `Status: ${formatCodexGoalStatus(goal.status)}`,
    `Objective: ${goal.objective}`,
    `Time used: ${formatCodexGoalElapsed(goal.timeUsedSeconds)}`,
    `Tokens used: ${goal.tokensUsed.toLocaleString()}`,
  ]
  if (goal.tokenBudget != null) {
    lines.push(`Token budget: ${goal.tokenBudget.toLocaleString()}`)
  }
  return lines.join('\n')
}
