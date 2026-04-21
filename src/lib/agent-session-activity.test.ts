import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentSessionMessage } from '@/types'

const imported = (await import(
  new URL('./agent-session-activity.ts', import.meta.url).href
)) as typeof import('./agent-session-activity')
const { deriveAgentSessionWindowStatus, getInFlightAgentMessages } = imported

function message(overrides: Partial<AgentSessionMessage> = {}): AgentSessionMessage {
  return {
    id: overrides.id ?? 'msg-1',
    role: overrides.role ?? 'tool',
    text: overrides.text ?? '',
    status: overrides.status ?? 'completed',
    ...overrides,
  }
}

test('getInFlightAgentMessages keeps only active non-user rows', () => {
  const messages = [
    message({ id: 'tool-live', role: 'tool', status: 'in_progress' }),
    message({ id: 'assistant-live', role: 'assistant', status: 'in_progress' }),
    message({ id: 'user-live', role: 'user', status: 'in_progress' }),
    message({ id: 'tool-done', role: 'tool', status: 'completed' }),
  ]

  assert.deepEqual(
    getInFlightAgentMessages(messages).map((entry) => entry.id),
    ['tool-live', 'assistant-live'],
  )
})

test('deriveAgentSessionWindowStatus treats in-flight messages as running', () => {
  assert.equal(
    deriveAgentSessionWindowStatus({
      status: 'idle',
      messages: [message({ id: 'tool-live', role: 'tool', status: 'in_progress' })],
    }),
    'running',
  )
})

test('deriveAgentSessionWindowStatus preserves error state', () => {
  assert.equal(
    deriveAgentSessionWindowStatus({
      status: 'error',
      messages: [message({ id: 'tool-live', role: 'tool', status: 'in_progress' })],
    }),
    'error',
  )
})

test('deriveAgentSessionWindowStatus surfaces approval over working', () => {
  // pendingApproval blocks progress, so it outranks the in-flight tool call.
  assert.equal(
    deriveAgentSessionWindowStatus({
      status: 'running',
      messages: [message({ id: 'tool-live', role: 'tool', status: 'in_progress' })],
      pendingApproval: { kind: 'command' } as never,
    }),
    'awaiting-approval',
  )
})

test('deriveAgentSessionWindowStatus surfaces awaiting-input when a question is pending', () => {
  assert.equal(
    deriveAgentSessionWindowStatus({
      status: 'idle',
      messages: [],
      pendingQuestion: { questions: [{ id: 'q1', question: 'why' }] } as never,
    }),
    'awaiting-input',
  )
})

test('deriveAgentSessionWindowStatus surfaces plan-ready only when idle', () => {
  // Plan ranks below working — a still-streaming turn shouldn't be reported as plan-ready.
  assert.equal(
    deriveAgentSessionWindowStatus({
      status: 'running',
      messages: [],
      pendingPlanApproval: { plan: 'do thing' } as never,
    }),
    'running',
  )
  assert.equal(
    deriveAgentSessionWindowStatus({
      status: 'idle',
      messages: [],
      pendingPlanApproval: { plan: 'do thing' } as never,
    }),
    'plan-ready',
  )
})
