import type { AgentSessionMessage, AgentSessionSnapshot } from '@/types'

export function getInFlightAgentMessages(messages: AgentSessionMessage[]): AgentSessionMessage[] {
  return messages.filter((message) => {
    if (message.status !== 'in_progress') return false
    return (
      message.role === 'assistant' ||
      message.role === 'reasoning' ||
      message.role === 'tool' ||
      message.role === 'system' ||
      message.role === 'auth_request' ||
      message.role === 'compaction'
    )
  })
}

export function deriveAgentSessionWindowStatus(
  snapshot: Pick<AgentSessionSnapshot, 'status' | 'messages'> | null | undefined,
): 'idle' | 'running' | 'error' {
  if (snapshot?.status === 'error') return 'error'
  return getInFlightAgentMessages(snapshot?.messages ?? []).length > 0 ||
    snapshot?.status === 'running'
    ? 'running'
    : 'idle'
}
