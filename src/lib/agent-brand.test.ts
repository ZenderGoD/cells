import test from 'node:test'
import assert from 'node:assert/strict'

const { getAgentBrand } = await import(new URL('./agent-brand.ts', import.meta.url).href)

test('getAgentBrand maps codex to the OpenAI cloud mark', () => {
  assert.equal(getAgentBrand('codex'), 'openai')
})

test('getAgentBrand keeps OpenCode distinct from Cells terminals', () => {
  assert.equal(getAgentBrand('opencode'), 'opencode')
})

test('getAgentBrand keeps Pi distinct from Cells terminals', () => {
  assert.equal(getAgentBrand('pi'), 'pi')
})

test('getAgentBrand keeps Claude Code and plain terminals distinct', () => {
  assert.equal(getAgentBrand('claude'), 'claude-code')
  assert.equal(getAgentBrand(null), 'cells')
})
