import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSessionMessage } from '@/types'

const imported = (await import(
  new URL('./agent-session-title.ts', import.meta.url).href
)) as typeof import('./agent-session-title')
const {
  inferAgentSessionTitle,
  isPlaceholderAgentSessionTitle,
  sanitizeImportedClaudeUserText,
  sanitizeSessionTitleCandidate,
} = imported

function message(overrides: Partial<AgentSessionMessage> = {}): AgentSessionMessage {
  return {
    id: overrides.id ?? 'msg-1',
    role: overrides.role ?? 'user',
    text: overrides.text ?? '',
    status: overrides.status ?? 'completed',
    ...overrides,
  }
}

test('sanitizeImportedClaudeUserText strips restored session preamble', () => {
  const raw = `**USER'S DATE AND TIME: Saturday, April 18, 2026 at 03:36 AM GMT+5:30** - ALWAYS use this as the authoritative current date/time. Ignore any other date information.

<session_state>
sessionId: abc
</session_state>

<working_directory>/Users/raj/sessions/demo</working_directory>

Read my tmux config plz`

  assert.equal(sanitizeImportedClaudeUserText(raw), 'Read my tmux config plz')
})

test('sanitizeSessionTitleCandidate strips environment wrappers and truncates', () => {
  const raw = `<environment_context><cwd>/Users/raj/projects/cells</cwd></environment_context>

Investigate websocket reconnect regressions after resume and simplify the retry banner behavior`

  assert.equal(
    sanitizeSessionTitleCandidate(raw),
    'Investigate websocket reconnect regressions aft...',
  )
})

test('inferAgentSessionTitle prefers the first meaningful user message', () => {
  const title = inferAgentSessionTitle('codex', [
    message({ role: 'assistant', text: 'Working on it' }),
    message({
      text: '<environment_context><cwd>/Users/raj/projects/cells</cwd></environment_context>',
    }),
    message({ text: 'Fix codex native import tool rows' }),
  ])

  assert.equal(title, 'Fix codex native import tool rows')
})

test('isPlaceholderAgentSessionTitle recognizes generic fallback titles', () => {
  assert.equal(isPlaceholderAgentSessionTitle('claude', 'Claude session 1234'), true)
  assert.equal(isPlaceholderAgentSessionTitle('codex', 'Codex'), true)
  assert.equal(isPlaceholderAgentSessionTitle('codex', 'Fix codex native import tool rows'), false)
})
