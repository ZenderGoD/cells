import test from 'node:test'
import assert from 'node:assert/strict'

const { parseCodexGoalCommand, formatCodexGoalSummary } = (await import(
  new URL('./codex-goal-command.ts', import.meta.url).href
)) as typeof import('./codex-goal-command')

test('parseCodexGoalCommand ignores ordinary prompts', () => {
  assert.equal(parseCodexGoalCommand('please use /goal later'), null)
})

test('parseCodexGoalCommand handles bare and control commands', () => {
  assert.deepEqual(parseCodexGoalCommand('/goal'), { kind: 'show' })
  assert.deepEqual(parseCodexGoalCommand('/goal clear'), { kind: 'clear' })
  assert.deepEqual(parseCodexGoalCommand('/goal pause'), {
    kind: 'set-status',
    status: 'paused',
  })
  assert.deepEqual(parseCodexGoalCommand('/goal resume'), {
    kind: 'set-status',
    status: 'active',
  })
})

test('parseCodexGoalCommand treats text as a goal objective', () => {
  assert.deepEqual(parseCodexGoalCommand('/goal ship the release'), {
    kind: 'set-objective',
    objective: 'ship the release',
  })
  assert.deepEqual(parseCodexGoalCommand('/goal edit update the docs'), {
    kind: 'set-objective',
    objective: 'update the docs',
  })
})

test('formatCodexGoalSummary renders an empty state and goal details', () => {
  assert.equal(formatCodexGoalSummary(null), 'No goal is set for this Codex thread.')
  assert.equal(
    formatCodexGoalSummary({
      threadId: 'thread-1',
      objective: 'ship it',
      status: 'active',
      tokenBudget: 1000,
      tokensUsed: 123,
      timeUsedSeconds: 65,
      createdAt: 1,
      updatedAt: 2,
    }),
    'Status: active\nObjective: ship it\nTime used: 1m\nTokens used: 123\nToken budget: 1,000',
  )
})
