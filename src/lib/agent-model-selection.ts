export interface AgentModelCandidate {
  id: string
  isDefault?: boolean
  available?: boolean
}

function hasModelId(models: AgentModelCandidate[], id: string | null | undefined): boolean {
  if (!id) return false
  return models.some((model) => model.id === id && model.available !== false)
}

export function resolveAgentModelId(
  agent: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode',
  requested: string | null | undefined,
  models: AgentModelCandidate[],
  fallback: string,
): string {
  const availableModels = models.filter((model) => model.available !== false)
  if (availableModels.length === 0) return fallback
  if (hasModelId(availableModels, requested)) return requested!
  if (agent === 'codex' || agent === 'cursor' || agent === 'copilot' || agent === 'opencode') {
    return (
      availableModels.find((model) => model.isDefault)?.id ?? availableModels[0]?.id ?? fallback
    )
  }
  return (
    availableModels.find((model) => model.id === fallback)?.id ?? availableModels[0]?.id ?? fallback
  )
}
