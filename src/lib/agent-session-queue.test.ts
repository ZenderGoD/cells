import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentWindowNode, QueuedAgentMessage } from '../types'

const { buildAgentSessionRequestFromWindow, sanitizeQueuedMessages } = await import(
  new URL('./agent-session-queue.ts', import.meta.url).href
)

test('sanitizeQueuedMessages preserves Codex fast mode', () => {
  const queued: QueuedAgentMessage[] = [
    {
      id: 'q1',
      text: 'ship it',
      attachments: [],
      mode: 'after-turn',
      model: 'gpt-5.5',
      thinkingLevel: 'high',
      permissionMode: 'ask',
      fastMode: true,
    },
  ]

  assert.equal(sanitizeQueuedMessages(queued)[0]?.fastMode, true)
})

test('buildAgentSessionRequestFromWindow includes fast mode', () => {
  const window: AgentWindowNode = {
    id: 'agent-1',
    agent: 'codex',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    title: 'Codex',
    model: 'gpt-5.5',
    permissionMode: 'ask',
    thinkingLevel: 'high',
    fastMode: true,
  }

  assert.equal(buildAgentSessionRequestFromWindow(window).fastMode, true)
})
