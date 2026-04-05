import test from 'node:test'
import assert from 'node:assert/strict'

const { inferAgentFromCommand, inferAgentFromTitle } = await import(
  new URL('./agent-command.ts', import.meta.url).href
)

test('inferAgentFromCommand detects direct agent launches', () => {
  assert.equal(inferAgentFromCommand('codex "fix the bug"'), 'codex')
  assert.equal(inferAgentFromCommand("claude 'review this file'"), 'claude')
  assert.equal(inferAgentFromCommand("opencode --prompt 'add tests'"), 'opencode')
  assert.equal(inferAgentFromCommand("pi 'investigate flaky tests'"), 'pi')
})

test('inferAgentFromCommand handles prefixed env vars and path-based binaries', () => {
  assert.equal(inferAgentFromCommand('OPENAI_API_KEY=test /usr/local/bin/codex plan'), 'codex')
  assert.equal(
    inferAgentFromCommand("ANTHROPIC_API_KEY=test ~/.local/bin/claude 'hello'"),
    'claude',
  )
  assert.equal(
    inferAgentFromCommand('OPENCODE_CONFIG=~/config.json /opt/homebrew/bin/opencode --continue'),
    'opencode',
  )
  assert.equal(inferAgentFromCommand('PI_CONFIG=1 ~/.local/bin/pi -p "hello"'), 'pi')
})

test('inferAgentFromCommand returns null for non-agent commands', () => {
  assert.equal(inferAgentFromCommand('pnpm dev'), null)
  assert.equal(inferAgentFromCommand('echo codex'), null)
})

test('inferAgentFromTitle detects persisted agent-labelled terminal titles', () => {
  assert.equal(inferAgentFromTitle('Codex'), 'codex')
  assert.equal(inferAgentFromTitle('Codex: refactor title bar'), 'codex')
  assert.equal(inferAgentFromTitle('Claude: review this change'), 'claude')
  assert.equal(inferAgentFromTitle('OpenCode: plan the refactor'), 'opencode')
  assert.equal(inferAgentFromTitle('Pi: plan the migration'), 'pi')
  assert.equal(inferAgentFromTitle('Terminal'), null)
})
