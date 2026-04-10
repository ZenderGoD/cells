import test from 'node:test'
import assert from 'node:assert/strict'

const { sanitizeBackendLeakedTitle } = await import(
  new URL('./terminal-title.ts', import.meta.url).href
)

test('sanitizeBackendLeakedTitle strips the Cells zellij session prefix', () => {
  assert.equal(
    sanitizeBackendLeakedTitle('czba1d9888fa56fe2207bc8ce | * Claude Code | /project'),
    '/project',
  )
  assert.equal(sanitizeBackendLeakedTitle('cells_main | Terminal'), 'Terminal')
})

test('sanitizeBackendLeakedTitle drops leading zellij marker glyphs', () => {
  assert.equal(sanitizeBackendLeakedTitle('* refactor router'), 'refactor router')
  assert.equal(sanitizeBackendLeakedTitle('+ staged changes'), 'staged changes')
  assert.equal(sanitizeBackendLeakedTitle('- dropped'), 'dropped')
})

test('sanitizeBackendLeakedTitle strips a single known agent prefix', () => {
  assert.equal(sanitizeBackendLeakedTitle('Claude Code | /Users/raj/project'), '/Users/raj/project')
  assert.equal(sanitizeBackendLeakedTitle('Codex | refactor the router'), 'refactor the router')
  assert.equal(sanitizeBackendLeakedTitle('OpenCode: plan the migration'), 'plan the migration')
  assert.equal(sanitizeBackendLeakedTitle('Pi | investigate flake'), 'investigate flake')
  assert.equal(sanitizeBackendLeakedTitle('claude: review this'), 'review this')
})

test('sanitizeBackendLeakedTitle preserves unrelated pipe-separated titles', () => {
  // Titles that use "|" as a separator but don't start with an agent label
  // should be left intact.
  assert.equal(sanitizeBackendLeakedTitle('Bug fix | refactor router'), 'Bug fix | refactor router')
  assert.equal(sanitizeBackendLeakedTitle('a | b | c'), 'a | b | c')
})

test('sanitizeBackendLeakedTitle only strips the first agent prefix, not recursively', () => {
  // A legitimate title that happens to repeat "Claude" shouldn't be chewed
  // down to nothing — only the outermost prefix is removed.
  assert.equal(sanitizeBackendLeakedTitle('Claude | Claude is slow today'), 'Claude is slow today')
})

test('sanitizeBackendLeakedTitle collapses whitespace and trims', () => {
  assert.equal(sanitizeBackendLeakedTitle('   Codex  |   fix\tbug  '), 'fix bug')
  assert.equal(sanitizeBackendLeakedTitle(''), '')
  assert.equal(sanitizeBackendLeakedTitle('   '), '')
})

test('sanitizeBackendLeakedTitle leaves a bare agent label alone', () => {
  // "Claude" with no separator after it is not a prefix — keep it.
  assert.equal(sanitizeBackendLeakedTitle('Claude'), 'Claude')
  assert.equal(sanitizeBackendLeakedTitle('Codex'), 'Codex')
})
