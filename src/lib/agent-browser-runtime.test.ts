import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentBrowserController, DynamicToolSpecLike } from './agent-browser-runtime.ts'

const runtime = await import(new URL('./agent-browser-runtime.ts', import.meta.url).href)

function fakeController(agentWindowId: string, overrides: Partial<AgentBrowserController> = {}) {
  const calls: string[] = []
  const controller: AgentBrowserController = {
    agentWindowId,
    navigate: async (url) => {
      calls.push(`navigate:${url}`)
      runtime.updateAgentBrowserRuntimeState(agentWindowId, { url })
    },
    goBack: async () => {
      calls.push('back')
    },
    goForward: async () => {
      calls.push('forward')
    },
    reload: async () => {
      calls.push('reload')
    },
    focus: async () => {
      calls.push('focus')
    },
    executeScript: async <T>() => ({ ok: true, message: 'ok' }) as T,
    captureVisibleRegion: async () => 'image-bytes',
    getState: () => runtime.ensureAgentBrowserRuntimeState(agentWindowId),
    ...overrides,
  }
  return { controller, calls }
}

test('normalizeAgentBrowserUrl handles direct URLs and search fallback', () => {
  assert.equal(runtime.normalizeAgentBrowserUrl('https://example.com'), 'https://example.com')
  assert.equal(runtime.normalizeAgentBrowserUrl('example.com'), 'https://example.com')
  assert.equal(runtime.normalizeAgentBrowserUrl('localhost:3000'), 'http://localhost:3000')
  assert.equal(
    runtime.normalizeAgentBrowserUrl('localhost:3000?debug=1#top'),
    'http://localhost:3000?debug=1#top',
  )
  assert.equal(
    runtime.normalizeAgentBrowserUrl('127.0.0.1:5173/path'),
    'http://127.0.0.1:5173/path',
  )
  assert.equal(
    runtime.normalizeAgentBrowserUrl('hello world', 'https://search.test/?q=%s'),
    'https://search.test/?q=hello%20world',
  )
})

test('dynamic tool specs expose the expected Codex browser contract', () => {
  const tools: DynamicToolSpecLike[] = runtime.getCodexAgentBrowserDynamicTools()
  const names = tools.map((tool) => `${tool.namespace}:${tool.name}`)
  assert.deepEqual(names, [
    'cells:browser_open',
    'cells:browser_snapshot',
    'cells:browser_screenshot',
    'cells:browser_click',
    'cells:browser_fill',
    'cells:browser_type',
    'cells:browser_press_key',
    'cells:browser_select',
    'cells:browser_wait_for',
    'cells:browser_back',
    'cells:browser_forward',
    'cells:browser_reload',
    'cells:browser_show',
    'cells:browser_hide',
  ])
  assert.equal(
    (tools.find((tool) => tool.name === 'browser_open')?.inputSchema as any).required[0],
    'url',
  )
})

test('browser_open normalizes, navigates, and keeps browser hidden by default', async () => {
  const agentWindowId = 'agent-browser-test-open'
  const { controller, calls } = fakeController(agentWindowId)
  const unregister = runtime.registerAgentBrowserController(controller)
  try {
    const result = await runtime.runAgentBrowserDynamicTool(agentWindowId, 'browser_open', {
      url: 'example.com',
    })
    assert.equal(result.success, true)
    assert.deepEqual(calls, ['navigate:https://example.com'])
    assert.equal(runtime.getAgentBrowserRuntimeState(agentWindowId)?.visible, false)
    assert.equal(runtime.getAgentBrowserRuntimeState(agentWindowId)?.url, 'https://example.com')
  } finally {
    unregister()
    runtime.removeAgentBrowserRuntimeState(agentWindowId)
  }
})

test('browser_screenshot returns Codex image content item', async () => {
  const agentWindowId = 'agent-browser-test-screenshot'
  const { controller } = fakeController(agentWindowId)
  const unregister = runtime.registerAgentBrowserController(controller)
  try {
    const result = await runtime.runAgentBrowserDynamicTool(agentWindowId, 'browser_screenshot', {})
    assert.equal(result.success, true)
    assert.equal(result.contentItems[0]?.type, 'inputImage')
    assert.equal(
      result.contentItems[0]?.type === 'inputImage' ? result.contentItems[0].imageUrl : '',
      'data:image/png;base64,image-bytes',
    )
  } finally {
    unregister()
    runtime.removeAgentBrowserRuntimeState(agentWindowId)
  }
})

test('browser_fill validates required arguments through failed dynamic response', async () => {
  const agentWindowId = 'agent-browser-test-validation'
  const { controller } = fakeController(agentWindowId)
  const unregister = runtime.registerAgentBrowserController(controller)
  try {
    const result = await runtime.runAgentBrowserDynamicTool(agentWindowId, 'browser_fill', {
      selector: '#name',
    })
    assert.equal(result.success, false)
    assert.match(
      result.contentItems[0]?.type === 'inputText' ? result.contentItems[0].text : '',
      /requires value|failed/i,
    )
  } finally {
    unregister()
    runtime.removeAgentBrowserRuntimeState(agentWindowId)
  }
})

test('browser tools reject arguments outside their declared schemas', async () => {
  const agentWindowId = 'agent-browser-test-schema-validation'
  const { controller } = fakeController(agentWindowId)
  const unregister = runtime.registerAgentBrowserController(controller)
  try {
    const result = await runtime.runAgentBrowserDynamicTool(agentWindowId, 'browser_screenshot', {
      fullPage: true,
    })
    assert.equal(result.success, false)
    assert.match(
      result.contentItems[0]?.type === 'inputText' ? result.contentItems[0].text : '',
      /unsupported argument/i,
    )
  } finally {
    unregister()
    runtime.removeAgentBrowserRuntimeState(agentWindowId)
  }
})

test('failedTool uses the Codex dynamic tool response shape', () => {
  assert.deepEqual(runtime.failedTool('Browser tools are Codex-only in this build.'), {
    success: false,
    contentItems: [{ type: 'inputText', text: 'Browser tools are Codex-only in this build.' }],
  })
})
