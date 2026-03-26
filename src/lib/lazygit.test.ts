import test from 'node:test'
import assert from 'node:assert/strict'

const { GIT_GRAPH_LABEL, buildLazygitCommand } = await import(
  new URL('./lazygit.ts', import.meta.url).href
)

test('Git Graph remains the user-facing label for the lazygit surface', () => {
  assert.equal(GIT_GRAPH_LABEL, 'Git Graph')
})

test('buildLazygitCommand launches lazygit directly when available', () => {
  assert.equal(
    buildLazygitCommand(),
    [
      'if command -v lazygit >/dev/null 2>&1; then',
      '  lazygit;',
      'else',
      "  printf '\\nlazygit is not installed. Install it first, then reopen this terminal.\\n\\n';",
      'fi',
    ].join(' '),
  )
})
