import test from 'node:test'
import assert from 'node:assert/strict'

const { inferAgentFromCommand, inferAgentFromTitle } = await import(
  new URL('./agent-command.ts', import.meta.url).href
)

test('inferAgentFromCommand detects direct codex and claude launches', () => {
  assert.equal(inferAgentFromCommand('codex "fix the bug"'), 'codex')
  assert.equal(inferAgentFromCommand("claude 'review this file'"), 'claude')
})

test('inferAgentFromCommand handles prefixed env vars and path-based binaries', () => {
  assert.equal(inferAgentFromCommand('OPENAI_API_KEY=test /usr/local/bin/codex plan'), 'codex')
  assert.equal(inferAgentFromCommand("ANTHROPIC_API_KEY=test ~/.local/bin/claude 'hello'"), 'claude')
})

test('inferAgentFromCommand returns null for non-agent commands', () => {
  assert.equal(inferAgentFromCommand('pnpm dev'), null)
  assert.equal(inferAgentFromCommand('echo codex'), null)
})

test('inferAgentFromTitle detects persisted agent-labelled terminal titles', () => {
  assert.equal(inferAgentFromTitle('Codex'), 'codex')
  assert.equal(inferAgentFromTitle('Codex: refactor title bar'), 'codex')
  assert.equal(inferAgentFromTitle('Claude: review this change'), 'claude')
  assert.equal(inferAgentFromTitle('Terminal'), null)
})
