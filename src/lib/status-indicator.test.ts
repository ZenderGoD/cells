import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentName, AgentRuntimeState, TerminalRuntimeStatus } from '@/types'

const { getAgentWindowStatusPresentation, getProjectRuntimeAttention, getStatusPresentation } =
  await import(new URL('./status-indicator.ts', import.meta.url).href)

function makeAgentStatus(
  agent: AgentName,
  state: AgentRuntimeState,
  overrides: Partial<TerminalRuntimeStatus> = {},
): TerminalRuntimeStatus {
  const details: Record<AgentRuntimeState, { detail: string; shortLabel: string }> = {
    approval: { detail: 'Approval needed', shortLabel: 'Approval' },
    error: { detail: 'Error', shortLabel: 'Error' },
    waiting: { detail: 'Waiting for input', shortLabel: 'Waiting' },
    done: { detail: 'Done', shortLabel: 'Done' },
    working: { detail: 'Working', shortLabel: 'Working' },
  }

  return {
    kind: 'agent',
    agent,
    state,
    detail: details[state].detail,
    shortLabel: details[state].shortLabel,
    source: 'test',
    updatedAt: 1,
    ...overrides,
  }
}

test('getStatusPresentation maps every agent runtime state to shared indicator styling', () => {
  const cases: Array<{
    state: AgentRuntimeState
    ring: RegExp
    dot: RegExp
    pill: RegExp
    detail: string
    projectAttention: AgentRuntimeState
  }> = [
    {
      state: 'approval',
      ring: /amber/,
      dot: /amber/,
      pill: /amber/,
      detail: 'Codex · Approval needed',
      projectAttention: 'approval',
    },
    {
      state: 'error',
      ring: /rose/,
      dot: /rose/,
      pill: /rose/,
      detail: 'Codex · Error',
      projectAttention: 'error',
    },
    {
      state: 'waiting',
      ring: /sky/,
      dot: /sky/,
      pill: /sky/,
      detail: 'Codex · Waiting for input',
      projectAttention: 'waiting',
    },
    {
      state: 'done',
      ring: /emerald/,
      dot: /emerald/,
      pill: /emerald/,
      detail: 'Codex · Done',
      projectAttention: 'done',
    },
    {
      state: 'working',
      ring: /primary/,
      dot: /primary/,
      pill: /primary/,
      detail: 'Codex · Working',
      projectAttention: 'working',
    },
  ]

  for (const testCase of cases) {
    const presentation = getStatusPresentation(makeAgentStatus('codex', testCase.state))

    assert.equal(presentation.label, testCase.detail)
    assert.equal(presentation.detail, testCase.detail)
    assert.equal(presentation.projectAttention, testCase.projectAttention)
    assert.match(presentation.ringClass, testCase.ring)
    assert.match(presentation.dotClass, testCase.dot)
    assert.match(presentation.pillClass, testCase.pill)
  }
})

test('getStatusPresentation formats process status for the bottom bar and minimap', () => {
  const named = getStatusPresentation({
    kind: 'process',
    detail: 'Running',
    shortLabel: 'Running',
    source: 'test',
    updatedAt: 1,
    processLabel: 'pnpm dev',
  })

  assert.equal(named.label, 'pnpm dev · Running')
  assert.equal(named.detail, 'pnpm dev · Running')
  assert.equal(named.projectAttention, null)
  assert.match(named.dotClass, /white/)

  const unnamed = getStatusPresentation({
    kind: 'process',
    detail: 'Running',
    shortLabel: 'Running',
    source: 'test',
    updatedAt: 1,
  })

  assert.equal(unnamed.detail, 'Process · Running')
})

test('getStatusPresentation returns an empty presentation when there is no runtime signal', () => {
  const presentation = getStatusPresentation(null)

  assert.deepEqual(presentation, {
    ringClass: '',
    dotClass: '',
    pillClass: '',
    label: '',
    detail: '',
    details: [],
    projectAttention: null,
  })
})

test('getAgentWindowStatusPresentation maps idle, running, and error to shared agent-window styles', () => {
  const idle = getAgentWindowStatusPresentation('idle')
  assert.equal(idle.label, 'Idle')
  assert.match(idle.dotClass, /muted/)
  assert.match(idle.pillClass, /muted/)

  const running = getAgentWindowStatusPresentation('running')
  assert.equal(running.label, 'Running')
  assert.match(running.dotClass, /emerald/)
  assert.match(running.pillClass, /emerald/)

  const error = getAgentWindowStatusPresentation('error')
  assert.equal(error.label, 'Error')
  assert.match(error.dotClass, /red/)
  assert.match(error.pillClass, /red/)
})

test('getStatusPresentation supports legacy fallback agent and process states', () => {
  const working = getStatusPresentation(undefined, { agent: 'claude', agentStatus: 'active' })
  assert.equal(working.detail, 'Claude · Working')
  assert.equal(working.projectAttention, 'working')

  const waiting = getStatusPresentation(undefined, { agent: 'claude', agentStatus: 'unread' })
  assert.equal(waiting.detail, 'Claude · Waiting for input')
  assert.equal(waiting.projectAttention, 'waiting')

  const done = getStatusPresentation(undefined, { agent: 'claude', agentStatus: 'done' })
  assert.equal(done.detail, 'Claude · Done')
  assert.equal(done.projectAttention, 'done')

  const process = getStatusPresentation(undefined, { processRunning: true })
  assert.equal(process.detail, 'Process · Running')
  assert.equal(process.projectAttention, null)
})

test('getStatusPresentation shows a visible branded fallback when agent identity exists but runtime status is missing', () => {
  const presentation = getStatusPresentation(undefined, { agent: 'codex' })

  assert.equal(presentation.detail, 'Codex · Working')
  assert.equal(presentation.label, 'Codex · Working')
  assert.equal(presentation.projectAttention, null)
  assert.match(presentation.dotClass, /primary/)
})

test('getProjectRuntimeAttention uses the shared priority order across agent states', () => {
  const attention = getProjectRuntimeAttention([
    { runtimeStatus: makeAgentStatus('claude', 'done') },
    { runtimeStatus: makeAgentStatus('codex', 'working') },
    { runtimeStatus: makeAgentStatus('opencode', 'waiting') },
    { runtimeStatus: makeAgentStatus('pi', 'error') },
    { runtimeStatus: makeAgentStatus('claude', 'approval') },
  ])

  assert.equal(attention, 'approval')
})

test('getProjectRuntimeAttention ignores generic process-running terminals and supports legacy fallbacks', () => {
  const attention = getProjectRuntimeAttention([
    {
      runtimeStatus: {
        kind: 'process',
        detail: 'Running',
        shortLabel: 'Running',
        source: 'test',
        updatedAt: 1,
        processLabel: 'pnpm dev',
      },
    },
    {
      agent: 'codex',
      agentStatus: 'unread',
    },
  ])

  assert.equal(attention, 'waiting')
})
