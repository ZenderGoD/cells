export type AgentBrand =
  | 'claude-code'
  | 'openai'
  | 'cursor'
  | 'github-copilot'
  | 'opencode'
  | 'pi'
  | 'cells'
export type AgentName =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'copilot'
  | 'opencode'
  | 'pi'
  | null
  | undefined

export function getAgentBrand(agent: AgentName): AgentBrand {
  if (agent === 'claude') return 'claude-code'
  if (agent === 'codex') return 'openai'
  if (agent === 'cursor') return 'cursor'
  if (agent === 'copilot') return 'github-copilot'
  if (agent === 'opencode') return 'opencode'
  if (agent === 'pi') return 'pi'
  return 'cells'
}
