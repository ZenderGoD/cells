import type { AgentSessionMessage, AgentSessionSnapshot, AgentWindowStatus } from '@/types'

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

type DeriveStatusInput = Pick<
  AgentSessionSnapshot,
  'status' | 'messages' | 'pendingApproval' | 'pendingPlanApproval' | 'pendingQuestion'
>

export function deriveAgentSessionWindowStatus(
  snapshot: DeriveStatusInput | null | undefined,
): AgentWindowStatus {
  if (snapshot?.status === 'error') return 'error'
  // Approval comes first: it blocks progress and needs user action, matching
  // t3code's sidebar priority order (approval > input > working > plan > done).
  if (snapshot?.pendingApproval) return 'awaiting-approval'
  if (snapshot?.pendingQuestion) return 'awaiting-input'
  const working =
    getInFlightAgentMessages(snapshot?.messages ?? []).length > 0 || snapshot?.status === 'running'
  if (working) return 'running'
  if (snapshot?.pendingPlanApproval) return 'plan-ready'
  return 'idle'
}
