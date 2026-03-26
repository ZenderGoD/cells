export type AgentBrand = 'claude-code' | 'openai' | 'cells'
export type AgentName = 'claude' | 'codex' | null | undefined

export function getAgentBrand(agent: AgentName): AgentBrand {
  if (agent === 'claude') return 'claude-code'
  if (agent === 'codex') return 'openai'
  return 'cells'
}
