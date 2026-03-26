export type AgentName = 'claude' | 'codex'

export function inferAgentFromCommand(command: string): AgentName | null {
  const trimmed = command.trim()
  const match = trimmed.match(
    /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))\s+)*(?<cmd>(?:\S*\/)?(?:claude|codex))(?=\s|$)/i,
  )

  if (!match?.groups?.cmd) return null

  const normalized = match.groups.cmd.toLowerCase().split('/').pop() ?? match.groups.cmd.toLowerCase()
  if (normalized === 'claude' || normalized.startsWith('claude-')) return 'claude'
  if (normalized === 'codex' || normalized === 'codex-cli' || normalized.startsWith('codex-')) {
    return 'codex'
  }

  return null
}

export function inferAgentFromTitle(title: string): AgentName | null {
  const normalized = title.trim().toLowerCase()
  if (normalized === 'claude' || normalized.startsWith('claude:')) return 'claude'
  if (normalized === 'codex' || normalized.startsWith('codex:')) return 'codex'
  return null
}
