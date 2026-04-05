export type AgentName = 'claude' | 'codex' | 'opencode' | 'pi'

export function inferAgentFromCommand(command: string): AgentName | null {
  const trimmed = command.trim()
  const match = trimmed.match(
    /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))\s+)*(?<cmd>(?:\S*\/)?(?:claude|codex|opencode|pi))(?=\s|$)/i,
  )

  if (!match?.groups?.cmd) return null

  const normalized =
    match.groups.cmd.toLowerCase().split('/').pop() ?? match.groups.cmd.toLowerCase()
  if (normalized === 'claude' || normalized.startsWith('claude-')) return 'claude'
  if (normalized === 'codex' || normalized === 'codex-cli' || normalized.startsWith('codex-')) {
    return 'codex'
  }
  if (normalized === 'opencode' || normalized.startsWith('opencode-')) return 'opencode'
  if (normalized === 'pi' || normalized.startsWith('pi-')) return 'pi'

  return null
}

export function inferAgentFromTitle(title: string): AgentName | null {
  const normalized = title.trim().toLowerCase()
  if (normalized === 'claude' || normalized.startsWith('claude:')) return 'claude'
  if (normalized === 'codex' || normalized.startsWith('codex:')) return 'codex'
  if (normalized === 'opencode' || normalized.startsWith('opencode:')) return 'opencode'
  if (normalized === 'pi' || normalized.startsWith('pi:')) return 'pi'
  return null
}
