export type AgentBrand = 'claude-code' | 'openai' | 'opencode' | 'pi' | 'cells'
export type AgentName = 'claude' | 'codex' | 'opencode' | 'pi' | null | undefined

export function getAgentBrand(agent: AgentName): AgentBrand {
  if (agent === 'claude') return 'claude-code'
  if (agent === 'codex') return 'openai'
  if (agent === 'opencode') return 'opencode'
  if (agent === 'pi') return 'pi'
  return 'cells'
}
