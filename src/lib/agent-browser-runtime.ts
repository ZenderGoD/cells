import type {
  AgentBrowserDock,
  AgentBrowserEnsureOptions,
  AgentBrowserSessionState,
  BrowserHistoryEntry,
} from '../types'

export interface AgentBrowserController {
  agentWindowId: string
  navigate(url: string): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  reload(): Promise<void>
  focus(): Promise<void>
  startElementPicker?(targetAgentWindowId: string | null): Promise<boolean>
  cancelElementPicker?(): Promise<void>
  executeScript<T = unknown>(code: string, timeoutMs?: number): Promise<T>
  captureVisibleRegion(): Promise<string>
  getState(): AgentBrowserSessionState
}

export interface DynamicToolSpecLike {
  namespace?: string
  name: string
  description: string
  inputSchema: unknown
  deferLoading?: boolean
}

export interface DynamicToolCallResponseLike {
  contentItems: Array<
    { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }
  >
  success: boolean
}

type AgentBrowserStateListener = (state: AgentBrowserSessionState) => void
type JsonRecord = Record<string, unknown>

const AGENT_BROWSER_ID_PREFIX = 'agent-browser-'
const DEFAULT_AGENT_BROWSER_DOCK: AgentBrowserDock = 'right'
const DEFAULT_AGENT_BROWSER_SPLIT_RATIO = 0.42
const DEFAULT_AGENT_BROWSER_URL = 'about:blank'
const DEFAULT_SEARCH_ENGINE_URL = 'https://www.google.com/search?q=%s'
const AGENT_BROWSER_CONTROLLER_TIMEOUT_MS = 8_000
const AGENT_BROWSER_WAIT_INTERVAL_MS = 120
const AGENT_BROWSER_WAIT_TIMEOUT_MS = 5_000
const MAX_SNAPSHOT_ELEMENTS = 500

const agentBrowserStates = new Map<string, AgentBrowserSessionState>()
const agentBrowserControllers = new Map<string, AgentBrowserController>()
const stateListeners = new Set<AgentBrowserStateListener>()
const controllerWaiters = new Map<
  string,
  Set<{ resolve: (controller: AgentBrowserController) => void; reject: (error: Error) => void }>
>()

export function getAgentBrowserId(agentWindowId: string) {
  return `${AGENT_BROWSER_ID_PREFIX}${agentWindowId}`
}

export function getAgentWindowIdFromAgentBrowserId(browserId: string) {
  return browserId.startsWith(AGENT_BROWSER_ID_PREFIX)
    ? browserId.slice(AGENT_BROWSER_ID_PREFIX.length)
    : null
}

export function normalizeAgentBrowserUrl(
  rawUrl: string,
  searchEngineUrl = DEFAULT_SEARCH_ENGINE_URL,
) {
  const trimmed = rawUrl.trim()
  if (!trimmed) return DEFAULT_AGENT_BROWSER_URL
  if (/^(https?:\/\/|file:\/\/|about:|data:|chrome-extension:\/\/)/i.test(trimmed)) return trimmed
  if (/^(localhost|127\.0\.0\.1|\[::1])(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)) {
    return `http://${trimmed}`
  }
  if (/^[^\s]+\.[^\s]+$/.test(trimmed)) {
    return `https://${trimmed}`
  }
  return searchEngineUrl.replace('%s', encodeURIComponent(trimmed))
}

export function onAgentBrowserRuntimeStateChanged(listener: AgentBrowserStateListener) {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

export function getAgentBrowserRuntimeState(agentWindowId: string) {
  return agentBrowserStates.get(agentWindowId) ?? null
}

export function ensureAgentBrowserRuntimeState(
  agentWindowId: string,
  options: AgentBrowserEnsureOptions = {},
) {
  const now = Date.now()
  const existing = agentBrowserStates.get(agentWindowId)
  const next: AgentBrowserSessionState = {
    ...(existing ?? {
      id: getAgentBrowserId(agentWindowId),
      agentWindowId,
      url: DEFAULT_AGENT_BROWSER_URL,
      title: '',
      visible: false,
      dock: DEFAULT_AGENT_BROWSER_DOCK,
      splitRatio: DEFAULT_AGENT_BROWSER_SPLIT_RATIO,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      themeColor: null,
      faviconUrl: null,
      failure: null,
      history: { entries: [], activeIndex: -1 },
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
    }),
    updatedAt: now,
    lastActiveAt: now,
  }
  if (options.url != null) next.url = normalizeAgentBrowserUrl(options.url)
  if (options.visible != null) next.visible = Boolean(options.visible)
  if (options.dock === 'right' || options.dock === 'bottom') next.dock = options.dock
  if (typeof options.splitRatio === 'number' && Number.isFinite(options.splitRatio)) {
    next.splitRatio = clampSplitRatio(options.splitRatio)
  }
  if (options.history?.entries?.length) {
    next.history = sanitizeHistory(options.history)
  }
  return setAgentBrowserRuntimeState(agentWindowId, next)
}

export function updateAgentBrowserRuntimeState(
  agentWindowId: string,
  patch: Partial<AgentBrowserSessionState>,
) {
  const current = ensureAgentBrowserRuntimeState(agentWindowId)
  return setAgentBrowserRuntimeState(agentWindowId, {
    ...current,
    ...patch,
    agentWindowId,
    id: current.id,
    dock: patch.dock === 'bottom' || patch.dock === 'right' ? patch.dock : current.dock,
    splitRatio:
      typeof patch.splitRatio === 'number' ? clampSplitRatio(patch.splitRatio) : current.splitRatio,
    history: patch.history ? sanitizeHistory(patch.history) : current.history,
    updatedAt: Date.now(),
    lastActiveAt: Date.now(),
  })
}

export function removeAgentBrowserRuntimeState(agentWindowId: string) {
  agentBrowserStates.delete(agentWindowId)
  const controller = agentBrowserControllers.get(agentWindowId)
  if (controller) agentBrowserControllers.delete(agentWindowId)
}

export function registerAgentBrowserController(controller: AgentBrowserController) {
  agentBrowserControllers.set(controller.agentWindowId, controller)
  resolveControllerWaiters(controller.agentWindowId, controller)
  return () => {
    if (agentBrowserControllers.get(controller.agentWindowId) === controller) {
      agentBrowserControllers.delete(controller.agentWindowId)
    }
  }
}

export function getAgentBrowserController(agentWindowId: string) {
  return agentBrowserControllers.get(agentWindowId) ?? null
}

export async function waitForAgentBrowserController(
  agentWindowId: string,
  timeoutMs = AGENT_BROWSER_CONTROLLER_TIMEOUT_MS,
) {
  const existing = getAgentBrowserController(agentWindowId)
  if (existing) return existing
  return await new Promise<AgentBrowserController>((resolve, reject) => {
    const waiter = { resolve, reject }
    let waiters = controllerWaiters.get(agentWindowId)
    if (!waiters) {
      waiters = new Set()
      controllerWaiters.set(agentWindowId, waiters)
    }
    waiters.add(waiter)
    const timer = window.setTimeout(() => {
      waiters?.delete(waiter)
      if (waiters?.size === 0) controllerWaiters.delete(agentWindowId)
      reject(new Error('Timed out waiting for the Codex browser webview to mount.'))
    }, timeoutMs)
    waiter.resolve = (controller) => {
      window.clearTimeout(timer)
      resolve(controller)
    }
    waiter.reject = (error) => {
      window.clearTimeout(timer)
      reject(error)
    }
  })
}

export function getCodexAgentBrowserDynamicTools(): DynamicToolSpecLike[] {
  return [
    dynamicTool('browser_open', 'Open or navigate the Codex browser.', {
      type: 'object',
      properties: {
        url: { type: 'string' },
        visible: { type: 'boolean' },
      },
      required: ['url'],
      additionalProperties: false,
    }),
    dynamicTool(
      'browser_snapshot',
      'Inspect visible text and interactive elements in the browser.',
      {
        type: 'object',
        properties: {
          maxElements: { type: 'number' },
        },
        additionalProperties: false,
      },
    ),
    dynamicTool('browser_screenshot', 'Capture the current browser viewport.', emptySchema()),
    dynamicTool('browser_click', 'Click an element by selector, visible text, or coordinates.', {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      additionalProperties: false,
    }),
    dynamicTool('browser_fill', 'Set the value of an editable browser control.', {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['selector', 'value'],
      additionalProperties: false,
    }),
    dynamicTool('browser_type', 'Type text into the focused element or a selector.', {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    }),
    dynamicTool('browser_press_key', 'Press a key in the browser page.', {
      type: 'object',
      properties: {
        key: { type: 'string' },
      },
      required: ['key'],
      additionalProperties: false,
    }),
    dynamicTool('browser_select', 'Select an option value in a select element.', {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['selector', 'value'],
      additionalProperties: false,
    }),
    dynamicTool('browser_wait_for', 'Wait for a selector or visible text to appear.', {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      additionalProperties: false,
    }),
    dynamicTool('browser_back', 'Go back in browser history.', emptySchema()),
    dynamicTool('browser_forward', 'Go forward in browser history.', emptySchema()),
    dynamicTool('browser_reload', 'Reload the browser.', emptySchema()),
    dynamicTool('browser_show', 'Show the Codex browser pane.', emptySchema()),
    dynamicTool(
      'browser_hide',
      'Hide the Codex browser pane while keeping it running.',
      emptySchema(),
    ),
  ]
}

export async function runAgentBrowserDynamicTool(
  agentWindowId: string,
  tool: string,
  rawArguments: unknown,
  options: { searchEngineUrl?: string } = {},
): Promise<DynamicToolCallResponseLike> {
  try {
    const args = asRecord(rawArguments)
    switch (tool) {
      case 'browser_open':
        return await openTool(agentWindowId, args, options.searchEngineUrl)
      case 'browser_snapshot':
        return await textTool(await snapshotTool(agentWindowId, args))
      case 'browser_screenshot':
        rejectUnknownArguments(args, [])
        return await screenshotTool(agentWindowId)
      case 'browser_click':
        return await actionTool(agentWindowId, args, 'click')
      case 'browser_fill':
        return await actionTool(agentWindowId, args, 'fill')
      case 'browser_type':
        return await actionTool(agentWindowId, args, 'type')
      case 'browser_press_key':
        return await actionTool(agentWindowId, args, 'press')
      case 'browser_select':
        return await actionTool(agentWindowId, args, 'select')
      case 'browser_wait_for':
        return await waitForTool(agentWindowId, args)
      case 'browser_back':
        rejectUnknownArguments(args, [])
        return await navigationTool(agentWindowId, 'back')
      case 'browser_forward':
        rejectUnknownArguments(args, [])
        return await navigationTool(agentWindowId, 'forward')
      case 'browser_reload':
        rejectUnknownArguments(args, [])
        return await navigationTool(agentWindowId, 'reload')
      case 'browser_show':
        rejectUnknownArguments(args, [])
        updateAgentBrowserRuntimeState(agentWindowId, { visible: true })
        return textTool('Browser shown.')
      case 'browser_hide':
        rejectUnknownArguments(args, [])
        updateAgentBrowserRuntimeState(agentWindowId, { visible: false })
        return textTool('Browser hidden and still running.')
      default:
        return failedTool(`Unsupported browser tool: ${tool}`)
    }
  } catch (error) {
    return failedTool(error instanceof Error ? error.message : String(error))
  }
}

export function failedTool(text: string): DynamicToolCallResponseLike {
  return { success: false, contentItems: [{ type: 'inputText', text }] }
}

function textTool(text: string): DynamicToolCallResponseLike {
  return { success: true, contentItems: [{ type: 'inputText', text }] }
}

async function openTool(agentWindowId: string, args: JsonRecord, searchEngineUrl?: string) {
  rejectUnknownArguments(args, ['url', 'visible'])
  const url = requireString(args.url, 'url')
  const visible = typeof args.visible === 'boolean' ? args.visible : false
  const finalUrl = normalizeAgentBrowserUrl(url, searchEngineUrl)
  ensureAgentBrowserRuntimeState(agentWindowId, { url: finalUrl, visible })
  const controller = await waitForAgentBrowserController(agentWindowId)
  await controller.navigate(finalUrl)
  return textTool(`Opened ${finalUrl}.`)
}

async function snapshotTool(agentWindowId: string, args: JsonRecord) {
  rejectUnknownArguments(args, ['maxElements'])
  ensureAgentBrowserRuntimeState(agentWindowId)
  const controller = await waitForAgentBrowserController(agentWindowId)
  const maxElements = Math.min(
    MAX_SNAPSHOT_ELEMENTS,
    Math.max(1, Math.round(typeof args.maxElements === 'number' ? args.maxElements : 200)),
  )
  const snapshot = await controller.executeScript(buildSnapshotScript(maxElements), 5_000)
  return JSON.stringify(snapshot, null, 2)
}

async function screenshotTool(agentWindowId: string): Promise<DynamicToolCallResponseLike> {
  ensureAgentBrowserRuntimeState(agentWindowId)
  const controller = await waitForAgentBrowserController(agentWindowId)
  const data = await controller.captureVisibleRegion()
  const imageUrl = data.startsWith('data:') ? data : `data:image/png;base64,${data}`
  return { success: true, contentItems: [{ type: 'inputImage', imageUrl }] }
}

async function actionTool(agentWindowId: string, args: JsonRecord, action: string) {
  validateActionArguments(args, action)
  ensureAgentBrowserRuntimeState(agentWindowId)
  const controller = await waitForAgentBrowserController(agentWindowId)
  const script = buildActionScript(action, args)
  const result = await controller.executeScript<{ ok?: boolean; message?: string }>(script, 5_000)
  if (!result || result.ok !== true) throw new Error(result?.message || `Browser ${action} failed.`)
  return textTool(result.message || `Browser ${action} completed.`)
}

function validateActionArguments(args: JsonRecord, action: string) {
  if (action === 'click') {
    rejectUnknownArguments(args, ['selector', 'text', 'x', 'y'])
    const hasSelector = typeof args.selector === 'string' && args.selector.trim()
    const hasText = typeof args.text === 'string' && args.text.trim()
    const hasPoint = typeof args.x === 'number' && typeof args.y === 'number'
    if (!hasSelector && !hasText && !hasPoint) {
      throw new Error('browser_click requires selector, text, or x/y coordinates.')
    }
    return
  }
  if (action === 'fill') {
    rejectUnknownArguments(args, ['selector', 'value'])
    requireString(args.selector, 'selector')
    requireStringValue(args.value, 'value')
    return
  }
  if (action === 'type') {
    rejectUnknownArguments(args, ['selector', 'text'])
    requireString(args.text, 'text')
    return
  }
  if (action === 'press') {
    rejectUnknownArguments(args, ['key'])
    requireString(args.key, 'key')
    return
  }
  if (action === 'select') {
    rejectUnknownArguments(args, ['selector', 'value'])
    requireString(args.selector, 'selector')
    requireStringValue(args.value, 'value')
  }
}

async function navigationTool(agentWindowId: string, action: 'back' | 'forward' | 'reload') {
  ensureAgentBrowserRuntimeState(agentWindowId)
  const controller = await waitForAgentBrowserController(agentWindowId)
  if (action === 'back') await controller.goBack()
  else if (action === 'forward') await controller.goForward()
  else await controller.reload()
  return textTool(`Browser ${action} completed.`)
}

async function waitForTool(agentWindowId: string, args: JsonRecord) {
  rejectUnknownArguments(args, ['selector', 'text', 'timeoutMs'])
  ensureAgentBrowserRuntimeState(agentWindowId)
  const controller = await waitForAgentBrowserController(agentWindowId)
  const timeoutMs = Math.min(
    30_000,
    Math.max(
      250,
      typeof args.timeoutMs === 'number' ? args.timeoutMs : AGENT_BROWSER_WAIT_TIMEOUT_MS,
    ),
  )
  const started = Date.now()
  let lastMessage = 'Condition not met.'
  while (Date.now() - started < timeoutMs) {
    const result = await controller.executeScript<{ ok?: boolean; message?: string }>(
      buildWaitCheckScript(args),
      2_000,
    )
    if (result?.ok) return textTool(result.message || 'Browser condition matched.')
    lastMessage = result?.message || lastMessage
    await new Promise((resolve) => window.setTimeout(resolve, AGENT_BROWSER_WAIT_INTERVAL_MS))
  }
  throw new Error(`Timed out waiting for browser condition. ${lastMessage}`)
}

function setAgentBrowserRuntimeState(agentWindowId: string, state: AgentBrowserSessionState) {
  agentBrowserStates.set(agentWindowId, state)
  for (const listener of stateListeners) listener(state)
  return state
}

function resolveControllerWaiters(agentWindowId: string, controller: AgentBrowserController) {
  const waiters = controllerWaiters.get(agentWindowId)
  if (!waiters) return
  controllerWaiters.delete(agentWindowId)
  for (const waiter of waiters) waiter.resolve(controller)
}

function clampSplitRatio(value: number) {
  return Math.min(0.7, Math.max(0.25, value))
}

function sanitizeHistory(history: { entries: BrowserHistoryEntry[]; activeIndex: number }) {
  const entries = history.entries
    .filter((entry) => typeof entry.url === 'string' && entry.url.trim())
    .slice(-100)
    .map((entry) => ({ url: entry.url, title: entry.title || entry.url }))
  const activeIndex =
    entries.length === 0 ? -1 : Math.min(entries.length - 1, Math.max(0, history.activeIndex))
  return { entries, activeIndex }
}

function dynamicTool(name: string, description: string, inputSchema: unknown): DynamicToolSpecLike {
  return { namespace: 'cells', name, description, inputSchema, deferLoading: false }
}

function emptySchema() {
  return { type: 'object', properties: {}, additionalProperties: false }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function requireString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`browser tool requires ${label}.`)
  return value
}

function requireStringValue(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`browser tool requires ${label}.`)
  return value
}

function rejectUnknownArguments(args: JsonRecord, allowed: string[]) {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key))
  if (unknown.length > 0) {
    throw new Error(`browser tool received unsupported argument: ${unknown[0]}`)
  }
}

function buildSnapshotScript(maxElements: number) {
  return `(() => {
    const maxElements = ${JSON.stringify(maxElements)};
    const isVisible = (el) => {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
    };
    const cssPath = (el) => {
      if (!(el instanceof Element)) return '';
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      let current = el;
      while (current && current.nodeType === 1 && parts.length < 5) {
        let part = current.localName;
        if (current.classList.length > 0) part += '.' + Array.from(current.classList).slice(0, 2).map((name) => CSS.escape(name)).join('.');
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.localName === current.localName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(' > ');
    };
    const candidates = Array.from(document.querySelectorAll('a, button, input, textarea, select, summary, [role="button"], [role="link"], [tabindex], [contenteditable="true"]'));
    const elements = [];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      elements.push({
        selector: cssPath(el),
        tagName: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '').trim().slice(0, 180),
        href: el.href || null,
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      });
      if (elements.length >= maxElements) break;
    }
    return {
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
      elements,
      text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12000)
    };
  })()`
}

function buildActionScript(action: string, args: JsonRecord) {
  const payload = JSON.stringify(args)
  const actionName = JSON.stringify(action)
  return `(() => {
    const args = ${payload};
    const action = ${actionName};
    const visibleText = (el) => (el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '').trim();
    const findByText = (text) => {
      const needle = String(text || '').trim().toLowerCase();
      if (!needle) return null;
      const elements = Array.from(document.querySelectorAll('button, a, input, textarea, select, [role="button"], [role="link"], [tabindex], label, summary'));
      return elements.find((el) => visibleText(el).toLowerCase().includes(needle)) || null;
    };
    const target = () => {
      if (typeof args.selector === 'string' && args.selector.trim()) return document.querySelector(args.selector);
      if (typeof args.text === 'string' && args.text.trim()) return findByText(args.text);
      if (typeof args.x === 'number' && typeof args.y === 'number') return document.elementFromPoint(args.x, args.y);
      return document.activeElement;
    };
    const el = target();
    if (!el) return { ok: false, message: 'No matching browser element.' };
    const bubble = (type, init = {}) => el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
    const inputLike = (node) => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
    el.scrollIntoView?.({ block: 'center', inline: 'center' });
    if (action === 'click') {
      const rect = el.getBoundingClientRect();
      const x = typeof args.x === 'number' ? args.x : rect.left + rect.width / 2;
      const y = typeof args.y === 'number' ? args.y : rect.top + rect.height / 2;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      }
      return { ok: true, message: 'Clicked.' };
    }
    if (action === 'fill') {
      if (typeof args.value !== 'string') return { ok: false, message: 'browser_fill requires value.' };
      el.focus?.();
      if (inputLike(el)) el.value = args.value;
      else if (el instanceof HTMLSelectElement) el.value = args.value;
      else if (el.isContentEditable) el.textContent = args.value;
      else return { ok: false, message: 'Element is not editable.' };
      bubble('input');
      bubble('change');
      return { ok: true, message: 'Filled.' };
    }
    if (action === 'type') {
      if (typeof args.text !== 'string') return { ok: false, message: 'browser_type requires text.' };
      el.focus?.();
      if (inputLike(el)) {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, start) + args.text + el.value.slice(end);
        const next = start + args.text.length;
        el.setSelectionRange?.(next, next);
      } else if (el.isContentEditable) {
        document.execCommand('insertText', false, args.text);
      } else {
        return { ok: false, message: 'Element is not editable.' };
      }
      bubble('input');
      bubble('change');
      return { ok: true, message: 'Typed.' };
    }
    if (action === 'press') {
      if (typeof args.key !== 'string' || !args.key) return { ok: false, message: 'browser_press_key requires key.' };
      const target = document.activeElement || document.body;
      for (const type of ['keydown', 'keyup']) {
        target.dispatchEvent(new KeyboardEvent(type, { key: args.key, code: args.key, bubbles: true, cancelable: true }));
      }
      return { ok: true, message: 'Pressed ' + args.key + '.' };
    }
    if (action === 'select') {
      if (!(el instanceof HTMLSelectElement)) return { ok: false, message: 'Element is not a select.' };
      if (typeof args.value !== 'string') return { ok: false, message: 'browser_select requires value.' };
      el.value = args.value;
      bubble('input');
      bubble('change');
      return { ok: true, message: 'Selected.' };
    }
    return { ok: false, message: 'Unknown browser action.' };
  })()`
}

function buildWaitCheckScript(args: JsonRecord) {
  const payload = JSON.stringify(args)
  return `(() => {
    const args = ${payload};
    if (typeof args.selector === 'string' && args.selector.trim()) {
      const el = document.querySelector(args.selector);
      if (el) return { ok: true, message: 'Selector matched: ' + args.selector };
      return { ok: false, message: 'Selector not found: ' + args.selector };
    }
    if (typeof args.text === 'string' && args.text.trim()) {
      const text = document.body?.innerText || '';
      if (text.toLowerCase().includes(args.text.toLowerCase())) return { ok: true, message: 'Text matched: ' + args.text };
      return { ok: false, message: 'Text not found: ' + args.text };
    }
    if (document.readyState === 'complete') return { ok: true, message: 'Page loaded.' };
    return { ok: false, message: 'Page is still loading.' };
  })()`
}
