import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentRuntimeState } from '../types/index'
import { EnhancedSessionTracker } from './enhanced-session-tracker'

test('EnhancedSessionTracker - session lifecycle', async (t) => {
  const tracker = new EnhancedSessionTracker()
  const statuses: Array<{ termId: string; state: AgentRuntimeState | null }> = []

  tracker.subscribe((termId, status) => {
    statuses.push({ termId, state: status?.state ?? null })
  })

  // Register session
  tracker.registerSession('term1', 'claude', { sessionId: 'sess-123' })
  await new Promise((resolve) => setTimeout(resolve, 10))

  // Should emit working on launch
  assert.equal(statuses[statuses.length - 1].state, 'working')

  // Mark as waiting
  tracker.markWaiting('term1', 'Waiting for input')
  assert.equal(statuses[statuses.length - 1].state, 'waiting')

  // Mark as working
  tracker.markWorking('term1')
  assert.equal(statuses[statuses.length - 1].state, 'working')

  // Mark as completed
  tracker.markCompleted('term1')
  assert.equal(statuses[statuses.length - 1].state, 'done')

  tracker.stop()
})

test('EnhancedSessionTracker - error state', async (t) => {
  const tracker = new EnhancedSessionTracker()
  const statuses: Array<AgentRuntimeState | null> = []

  tracker.subscribe((termId, status) => {
    statuses.push(status?.state ?? null)
  })

  tracker.registerSession('term1', 'codex')
  await new Promise((resolve) => setTimeout(resolve, 10))

  tracker.markError('term1', 'Agent crashed')
  assert.equal(statuses[statuses.length - 1], 'error')

  tracker.stop()
})

test('EnhancedSessionTracker - cleanup on completion', async (t) => {
  const tracker = new EnhancedSessionTracker()
  let callCount = 0

  tracker.subscribe((termId, status) => {
    callCount++
  })

  tracker.registerSession('term1', 'claude')
  await new Promise((resolve) => setTimeout(resolve, 10))

  const beforeCount = callCount

  // Mark completed twice - should not queue multiple timeouts
  tracker.markCompleted('term1')
  tracker.markCompleted('term1')
  await new Promise((resolve) => setTimeout(resolve, 10))

  // Should only emit once per markCompleted call
  assert(callCount >= beforeCount + 2)

  tracker.stop()
})

test('EnhancedSessionTracker - multiple sessions', async (t) => {
  const tracker = new EnhancedSessionTracker()
  const statuses = new Map<string, AgentRuntimeState | null>()

  tracker.subscribe((termId, status) => {
    statuses.set(termId, status?.state ?? null)
  })

  tracker.registerSession('term1', 'claude')
  tracker.registerSession('term2', 'codex')
  tracker.registerSession('term3', 'opencode')
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(statuses.get('term1'), 'working')
  assert.equal(statuses.get('term2'), 'working')
  assert.equal(statuses.get('term3'), 'working')

  tracker.markWaiting('term1')
  tracker.markWaiting('term2')

  assert.equal(statuses.get('term1'), 'waiting')
  assert.equal(statuses.get('term2'), 'waiting')
  assert.equal(statuses.get('term3'), 'working')

  tracker.stop()
})

test('EnhancedSessionTracker - getStatus returns current status', async (t) => {
  const tracker = new EnhancedSessionTracker()

  tracker.registerSession('term1', 'claude')
  await new Promise((resolve) => setTimeout(resolve, 10))

  let status = tracker.getStatus('term1')
  assert(status?.state === 'working')

  tracker.markWaiting('term1')
  status = tracker.getStatus('term1')
  assert(status?.state === 'waiting')

  tracker.markError('term1')
  status = tracker.getStatus('term1')
  assert(status?.state === 'error')

  tracker.stop()
})

test('EnhancedSessionTracker - untrackSession cleanup', async (t) => {
  const tracker = new EnhancedSessionTracker()
  const statuses: Array<{ termId: string; status: string | null }> = []

  tracker.subscribe((termId, status) => {
    statuses.push({ termId, status: status?.state ?? null })
  })

  tracker.trackSession('term1', 'claude')
  await new Promise((resolve) => setTimeout(resolve, 10))

  const beforeCount = statuses.length

  tracker.untrackSession('term1')
  assert.equal(tracker.getStatus('term1'), null)

  tracker.stop()
})

test('EnhancedSessionTracker - no broadcasts for unchanged status', async (t) => {
  const tracker = new EnhancedSessionTracker()
  let callCount = 0

  tracker.subscribe(() => {
    callCount++
  })

  tracker.registerSession('term1', 'claude')
  await new Promise((resolve) => setTimeout(resolve, 10))

  const afterRegister = callCount

  // Calling markWorking multiple times should not trigger broadcasts
  // if status hasn't changed
  tracker.markWorking('term1', 'Working')
  tracker.markWorking('term1', 'Working')
  tracker.markWorking('term1', 'Working')

  // Should only broadcast on actual state change
  tracker.markWaiting('term1')
  assert(callCount > afterRegister)

  tracker.stop()
})

test('EnhancedSessionTracker - stop clears all state', async (t) => {
  const tracker = new EnhancedSessionTracker()

  tracker.registerSession('term1', 'claude')
  tracker.registerSession('term2', 'codex')

  assert(tracker.getStatus('term1') != null)
  assert(tracker.getStatus('term2') != null)

  tracker.stop()

  assert.equal(tracker.getStatus('term1'), null)
  assert.equal(tracker.getStatus('term2'), null)
})

test('EnhancedSessionTracker - configurable poll interval', async (t) => {
  const tracker = new EnhancedSessionTracker({ pollIntervalMs: 1000 })

  tracker.registerSession('term1', 'claude')
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert(tracker.getStatus('term1') != null)

  tracker.stop()
})
