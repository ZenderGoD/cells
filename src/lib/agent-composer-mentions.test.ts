import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractAgentComposerMentionTrigger,
  rewriteAgentComposerMentions,
} from './agent-composer-mentions.ts'

test('extractAgentComposerMentionTrigger opens on valid @ prefixes only', () => {
  assert.deepEqual(extractAgentComposerMentionTrigger('@vec', 4), {
    kind: 'inline',
    query: 'vec',
    start: 0,
  })
  assert.deepEqual(extractAgentComposerMentionTrigger('open @.agents', 13), {
    kind: 'inline',
    query: '.agents',
    start: 5,
  })
  assert.equal(extractAgentComposerMentionTrigger('test@example.com', 16), null)
})

test('rewriteAgentComposerMentions normalizes bracket syntax and collects resolved paths', () => {
  const result = rewriteAgentComposerMentions(
    'Use [skill:.agents/skills/release/SKILL.md] and [file:.claude/settings.local.json].',
    (_kind, value) => `/abs/${value}`,
  )

  assert.equal(
    result.text,
    'Use [.agents/skills/release/SKILL.md] and [.claude/settings.local.json].',
  )
  assert.deepEqual(result.referencedPaths, [
    '/abs/.agents/skills/release/SKILL.md',
    '/abs/.claude/settings.local.json',
  ])
})
