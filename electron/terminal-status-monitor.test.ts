import test from 'node:test'
import assert from 'node:assert/strict'
import type { TerminalRuntimeStatus } from '../src/types'

const {
  classifyClaudeSessionMessages,
  TerminalStatusMonitor,
  classifyOpenCodePartData,
  classifyPiSessionEntries,
  getFallbackRuntimeState,
  mapClaudeSdkMessageState,
  mapCodexAppServerEventState,
  mapCodexThreadStatusState,
  mapOpenCodeSessionStatus,
} = await import(new URL('./terminal-status-monitor.ts', import.meta.url).href)

test('mapClaudeSdkMessageState treats session state changes as authoritative', () => {
  assert.equal(
    mapClaudeSdkMessageState({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
      uuid: '1',
      session_id: 'session',
    }),
    'working',
  )

  assert.equal(
    mapClaudeSdkMessageState({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'requires_action',
      uuid: '1',
      session_id: 'session',
    }),
    'approval',
  )

  assert.equal(
    mapClaudeSdkMessageState({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      uuid: '1',
      session_id: 'session',
    }),
    'waiting',
  )
})

test('mapClaudeSdkMessageState keeps Claude task and result lifecycle consistent', () => {
  assert.equal(
    mapClaudeSdkMessageState({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      description: 'Review repository',
      uuid: '1',
      session_id: 'session',
    }),
    'working',
  )

  assert.equal(
    mapClaudeSdkMessageState({
      type: 'tool_progress',
      tool_use_id: 'tool-1',
      tool_name: 'Read',
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: '1',
      session_id: 'session',
    }),
    'working',
  )

  assert.equal(
    mapClaudeSdkMessageState({
      type: 'result',
      subtype: 'success',
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: 'done',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: '1',
      session_id: 'session',
    }),
    'waiting',
  )

  assert.equal(
    mapClaudeSdkMessageState({
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: true,
      num_turns: 1,
      result: 'boom',
      stop_reason: null,
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: '1',
      session_id: 'session',
    }),
    'error',
  )
})

test('mapCodexThreadStatusState distinguishes working, approval, waiting, and error', () => {
  assert.equal(mapCodexThreadStatusState({ type: 'active', activeFlags: [] }), 'working')
  assert.equal(
    mapCodexThreadStatusState({ type: 'active', activeFlags: ['waitingOnApproval'] }),
    'approval',
  )
  assert.equal(
    mapCodexThreadStatusState({ type: 'active', activeFlags: ['waitingOnUserInput'] }),
    'waiting',
  )
  assert.equal(mapCodexThreadStatusState({ type: 'idle' }), 'waiting')
  assert.equal(mapCodexThreadStatusState({ type: 'systemError' }), 'error')
})

test('mapCodexAppServerEventState maps app-server notifications and requests', () => {
  assert.equal(
    mapCodexAppServerEventState('thread/status/changed', {
      threadId: 'thread-1',
      status: { type: 'active', activeFlags: [] },
    }),
    'working',
  )

  assert.equal(
    mapCodexAppServerEventState('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
    }),
    'approval',
  )

  assert.equal(
    mapCodexAppServerEventState('item/tool/requestUserInput', {
      threadId: 'thread-1',
    }),
    'waiting',
  )

  assert.equal(
    mapCodexAppServerEventState('turn/completed', {
      threadId: 'thread-1',
      turn: { status: 'failed' },
    }),
    'error',
  )

  assert.equal(
    mapCodexAppServerEventState('turn/completed', {
      threadId: 'thread-1',
      turn: { status: 'completed' },
    }),
    'waiting',
  )
})

test('getFallbackRuntimeState only keeps generic non-sdk agents in working mode', () => {
  assert.equal(getFallbackRuntimeState('claude'), 'waiting')
  assert.equal(getFallbackRuntimeState('codex'), 'waiting')
  assert.equal(getFallbackRuntimeState('opencode'), 'waiting')
  assert.equal(getFallbackRuntimeState('pi'), 'waiting')
})

test('classifyOpenCodePartData detects working, waiting, and approval', () => {
  assert.equal(classifyOpenCodePartData('{"type":"step-start"}'), 'working')
  assert.equal(classifyOpenCodePartData('{"type":"step-finish","reason":"tool-calls"}'), 'working')
  assert.equal(classifyOpenCodePartData('{"type":"step-finish","reason":"stop"}'), 'waiting')
  assert.equal(
    classifyOpenCodePartData('{"type":"tool","state":{"status":"pending-approval"}}'),
    'approval',
  )
})

test('classifyClaudeSessionMessages uses Claude SDK transcript state', () => {
  assert.equal(
    classifyClaudeSessionMessages([
      {
        type: 'user',
        uuid: '1',
        session_id: 'session',
        message: { role: 'user', content: 'review repo' },
        parent_tool_use_id: null,
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    ]),
    'working',
  )

  assert.equal(
    classifyClaudeSessionMessages([
      {
        type: 'assistant',
        uuid: '2',
        session_id: 'session',
        message: { role: 'assistant', stop_reason: 'end_turn', content: [] },
        parent_tool_use_id: null,
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ]),
    'waiting',
  )
})

test('mapOpenCodeSessionStatus maps opencode sdk states', () => {
  assert.equal(mapOpenCodeSessionStatus({ type: 'busy' }), 'working')
  assert.equal(mapOpenCodeSessionStatus({ type: 'retry' }), 'working')
  assert.equal(mapOpenCodeSessionStatus({ type: 'idle' }), 'waiting')
})

test('classifyPiSessionEntries maps pi session transcript states', () => {
  assert.equal(
    classifyPiSessionEntries([
      {
        type: 'message',
        id: '1',
        message: { role: 'user', content: [{ type: 'text', text: 'review repo' }] },
      },
    ]),
    'working',
  )

  assert.equal(
    classifyPiSessionEntries([
      {
        type: 'message',
        id: '2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'stop',
        },
      },
    ]),
    'waiting',
  )
})

test('handleTerminalExit reports done for launched agent sessions', () => {
  const events: Array<{ termId: string; status: TerminalRuntimeStatus | null }> = []
  const monitor = new TerminalStatusMonitor({
    getDaemonClient: () => null,
    getFallbackSessions: () => null,
    getUseDaemon: () => false,
    onStatus: (termId: string, status: TerminalRuntimeStatus | null) => {
      events.push({ termId, status })
    },
  })

  ;(monitor as unknown as { launchMeta: Map<string, { agent: string }> }).launchMeta.set('term-1', {
    agent: 'codex',
  })

  monitor.handleTerminalExit('term-1', { reason: 'process-exit' })

  assert.equal(events.length, 1)
  assert.equal(events[0].termId, 'term-1')
  assert.equal(events[0].status?.kind, 'agent')
  assert.equal(events[0].status?.agent, 'codex')
  assert.equal(events[0].status?.state, 'done')
  assert.equal(events[0].status?.detail, 'Done')
})

test('getStatus transitions to new agent when a different launch is registered', async () => {
  const events: Array<{ termId: string; status: TerminalRuntimeStatus | null }> = []
  const monitor = new TerminalStatusMonitor({
    getDaemonClient: () => null,
    getFallbackSessions: () => null,
    getUseDaemon: () => false,
    onStatus: (termId: string, status: TerminalRuntimeStatus | null) => {
      events.push({ termId, status })
    },
  })

  type InternalMonitor = {
    statuses: Map<string, TerminalRuntimeStatus>
    launchMeta: Map<string, { agent: string; startedAt?: number }>
  }
  const internal = monitor as unknown as InternalMonitor

  // Simulate: codex was actively running (working state)
  internal.statuses.set('term-1', {
    kind: 'agent',
    agent: 'codex',
    state: 'working',
    detail: 'Working',
    shortLabel: 'Working',
    source: 'codex:app-server',
    updatedAt: 100,
  })
  internal.launchMeta.set('term-1', { agent: 'codex', startedAt: 50 })

  // User switches to claude (Ctrl+C codex, then types claude)
  monitor.setLaunchMeta('term-1', { agent: 'claude', startedAt: Date.now() } as never)
  // Allow the async refreshTerm to settle
  const status = await monitor.getStatus('term-1')

  assert.equal(status?.kind, 'agent')
  assert.equal(status?.agent, 'claude')
  assert.equal(status?.state, 'working')
  assert.match(status?.source ?? '', /launching/)
})

test('getStatus preserves active agent status when processInfo is unavailable', async () => {
  const events: Array<{ termId: string; status: TerminalRuntimeStatus | null }> = []
  const monitor = new TerminalStatusMonitor({
    getDaemonClient: () => null,
    getFallbackSessions: () => null,
    getUseDaemon: () => false,
    onStatus: (termId: string, status: TerminalRuntimeStatus | null) => {
      events.push({ termId, status })
    },
  })

  type InternalMonitor = {
    statuses: Map<string, TerminalRuntimeStatus>
    launchMeta: Map<string, { agent: string; startedAt?: number }>
  }
  const internal = monitor as unknown as InternalMonitor

  // Simulate: claude is actively running
  internal.statuses.set('term-1', {
    kind: 'agent',
    agent: 'claude',
    state: 'waiting',
    detail: 'Waiting for input',
    shortLabel: 'Waiting',
    source: 'claude:sdk',
    updatedAt: 100,
  })
  internal.launchMeta.set('term-1', { agent: 'claude', startedAt: 50 })

  // getStatus with no daemon/sessions → processInfo is null → should preserve
  const status = await monitor.getStatus('term-1')

  assert.equal(status?.kind, 'agent')
  assert.equal(status?.agent, 'claude')
  assert.equal(status?.state, 'waiting')
  assert.equal(status?.source, 'claude:sdk')
})

test('getStatus returns launching state for a registered agent with no prior status', async () => {
  const events: Array<{ termId: string; status: TerminalRuntimeStatus | null }> = []
  const monitor = new TerminalStatusMonitor({
    getDaemonClient: () => null,
    getFallbackSessions: () => null,
    getUseDaemon: () => false,
    onStatus: (termId: string, status: TerminalRuntimeStatus | null) => {
      events.push({ termId, status })
    },
  })

  type InternalMonitor = {
    launchMeta: Map<string, { agent: string; startedAt?: number }>
  }
  const internal = monitor as unknown as InternalMonitor

  internal.launchMeta.set('term-1', { agent: 'opencode', startedAt: Date.now() })

  const status = await monitor.getStatus('term-1')

  assert.equal(status?.kind, 'agent')
  assert.equal(status?.agent, 'opencode')
  assert.equal(status?.state, 'working')
  assert.match(status?.source ?? '', /launching/)
})

test('handleTerminalExit reports error for daemon disconnects', () => {
  const events: Array<{ termId: string; status: TerminalRuntimeStatus | null }> = []
  const monitor = new TerminalStatusMonitor({
    getDaemonClient: () => null,
    getFallbackSessions: () => null,
    getUseDaemon: () => false,
    onStatus: (termId: string, status: TerminalRuntimeStatus | null) => {
      events.push({ termId, status })
    },
  })

  ;(
    monitor as unknown as {
      statuses: Map<
        string,
        {
          kind: string
          agent: string
          state: string
          detail: string
          shortLabel: string
          source: string
          updatedAt: number
        }
      >
    }
  ).statuses.set('term-2', {
    kind: 'agent',
    agent: 'claude',
    state: 'working',
    detail: 'Working',
    shortLabel: 'Working',
    source: 'test',
    updatedAt: 1,
  })

  monitor.handleTerminalExit('term-2', { reason: 'daemon-disconnect' })

  assert.equal(events.length, 1)
  assert.equal(events[0].termId, 'term-2')
  assert.equal(events[0].status?.kind, 'agent')
  assert.equal(events[0].status?.agent, 'claude')
  assert.equal(events[0].status?.state, 'error')
  assert.equal(events[0].status?.detail, 'Error')
})
