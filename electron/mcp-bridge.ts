/**
 * MCP Bridge — local Unix socket server inside the Electron main process.
 *
 * Exposes terminal and browser operations so the standalone MCP server
 * (a separate process used by CLI agents) can control Cells windows.
 *
 * Protocol: newline-delimited JSON (same style as the PTY daemon).
 *   Request:  { id: number, method: string, params: object }
 *   Response: { id: number, ok: boolean, data?: any, error?: string }
 */

import net from 'net'
import fs from 'fs'
import { Notification } from 'electron'
import type { BrowserWindow, WebContentsView } from 'electron'
import type { PtyDaemonClient } from './pty-client'
import type { TerminalSessionManager } from './terminal-session-manager'
import type {
  AgentSessionSnapshot,
  Project,
  ProjectsState,
  TerminalRuntimeStatus,
} from '../src/types'

// ---------- Console log buffering ----------

interface ConsoleLogEntry {
  level: string
  message: string
  line: number
  source: string
  timestamp: number
}

const consoleLogs = new Map<string, ConsoleLogEntry[]>()
const MAX_LOGS_PER_BROWSER = 1000

interface NetworkRequestEntry {
  id: string
  url: string
  method: string
  statusCode: number
  statusLine?: string
  resourceType?: string
  mimeType?: string
  fromCache?: boolean
  error?: string
  timestamp: number
  elapsedMs?: number | null
}

const networkRequests = new Map<string, NetworkRequestEntry[]>()
const MAX_NETWORK_REQUESTS_PER_BROWSER = 1000

export function captureConsoleLog(
  browserId: string,
  level: number,
  message: string,
  line: number,
  source: string,
) {
  let logs = consoleLogs.get(browserId)
  if (!logs) {
    logs = []
    consoleLogs.set(browserId, logs)
  }
  logs.push({
    level: ['verbose', 'info', 'warning', 'error'][level] ?? 'info',
    message,
    line,
    source,
    timestamp: Date.now(),
  })
  if (logs.length > MAX_LOGS_PER_BROWSER) {
    logs.splice(0, logs.length - MAX_LOGS_PER_BROWSER)
  }
}

export function clearBrowserConsoleLogs(browserId: string) {
  consoleLogs.delete(browserId)
}

export function captureNetworkRequest(browserId: string, entry: NetworkRequestEntry) {
  let requests = networkRequests.get(browserId)
  if (!requests) {
    requests = []
    networkRequests.set(browserId, requests)
  }
  requests.push(entry)
  if (requests.length > MAX_NETWORK_REQUESTS_PER_BROWSER) {
    requests.splice(0, requests.length - MAX_NETWORK_REQUESTS_PER_BROWSER)
  }
}

export function clearBrowserNetworkRequests(browserId: string) {
  networkRequests.delete(browserId)
}

// ---------- Terminal output ring buffer ----------

const terminalOutputRing = new Map<string, string>()
const OUTPUT_RING_SIZE = 256 * 1024 // 256KB per terminal

export function bufferTerminalOutput(termId: string, data: string) {
  const existing = terminalOutputRing.get(termId) ?? ''
  const combined = existing + data
  terminalOutputRing.set(
    termId,
    combined.length > OUTPUT_RING_SIZE ? combined.slice(-OUTPUT_RING_SIZE) : combined,
  )
}

export function clearTerminalOutputRing(termId: string) {
  terminalOutputRing.delete(termId)
}

// ---------- MCP-created headless terminals ----------

interface McpTerminal {
  termId: string
  projectId: string
  cwd: string
  createdAt: number
}

const mcpTerminals = new Map<string, McpTerminal>()

// ---------- Bridge context ----------

export interface BridgeContext {
  browserViews: Map<string, WebContentsView>
  browserIdToProject: Map<string, string>
  getDaemonClient: () => PtyDaemonClient | null
  getFallbackSessions: () => TerminalSessionManager | null
  getUseDaemon: () => boolean
  getTerminalStatus: (
    termId: string,
  ) => Promise<TerminalRuntimeStatus | null> | TerminalRuntimeStatus | null
  getAgentSessionSnapshot: (
    windowId: string,
  ) => Promise<AgentSessionSnapshot | null> | AgentSessionSnapshot | null
  sendAgentMessage: (
    windowId: string,
    input: string,
    attachments?: string[],
  ) => Promise<void> | void
  getMainWindow: () => BrowserWindow | null
  stateFile: string
  subscribedTerminals: Set<string>
}

// ---------- Helpers ----------

function sendJson(socket: net.Socket, msg: object) {
  try {
    socket.write(JSON.stringify(msg) + '\n')
  } catch {}
}

function respond(socket: net.Socket, id: number, data: any) {
  sendJson(socket, { id, ok: true, data })
}

function respondError(socket: net.Socket, id: number, error: string) {
  sendJson(socket, { id, ok: false, error })
}

function loadState(stateFile: string): ProjectsState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
  } catch {
    return null
  }
}

function findProject(stateFile: string, projectPath: string): Project | null {
  const state = loadState(stateFile)
  if (!state?.projects) return null
  let best: Project | null = null
  let bestLen = 0
  for (const p of state.projects) {
    if (projectPath.startsWith(p.path) && p.path.length > bestLen) {
      best = p
      bestLen = p.path.length
    }
  }
  return best
}

function listProjects(stateFile: string): Project[] {
  return loadState(stateFile)?.projects ?? []
}

function findProjectByWindowId(
  stateFile: string,
  type: 'terminal' | 'browser' | 'agent',
  windowId: string,
): Project | null {
  for (const project of listProjects(stateFile)) {
    if (type === 'terminal' && project.terminals.some((entry) => entry.id === windowId)) {
      return project
    }
    if (type === 'browser' && project.browsers.some((entry) => entry.id === windowId)) {
      return project
    }
    if (type === 'agent' && (project.agentWindows ?? []).some((entry) => entry.id === windowId)) {
      return project
    }
  }
  return null
}

function generateId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

function trimLines(value: string, lines?: number) {
  if (!lines) return value
  return value.split('\n').slice(-lines).join('\n')
}

function serializeJsResult(result: any): string {
  if (result === undefined) return 'undefined'
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function normalizeBrowserUrl(input: string): string {
  let url = input
  if (
    !/^(https?:\/\/|about:|file:\/\/|chrome-extension:\/\/)/i.test(url) &&
    !url.startsWith('data:')
  ) {
    const hostLike = /^[^\s]+\.[^\s]+$/.test(url)
    const localhostLike = /^(localhost|\[::1\]|127(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i.test(
      url,
    )
    const ipv4Like = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#].*)?$/.test(url)
    const localNetworkLike =
      /^(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2}(?::\d+)?(?:[/?#].*)?$/.test(url)
    if ((hostLike || localhostLike || ipv4Like) && !url.includes(' ')) {
      const scheme = localhostLike || ipv4Like || localNetworkLike ? 'http://' : 'https://'
      url = `${scheme}${url}`
    } else {
      url = `https://www.google.com/search?q=${encodeURIComponent(url)}`
    }
  }
  return url
}

function focusMainWindow(window: BrowserWindow | null) {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}

async function waitForBrowserLoad(view: WebContentsView, timeoutMs: number) {
  if (!view.webContents.isLoadingMainFrame()) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, timeoutMs)
    function done() {
      clearTimeout(timer)
      view.webContents.removeListener('did-stop-loading', done)
      view.webContents.removeListener('did-fail-load', done)
      view.webContents.removeListener('did-fail-provisional-load', done)
      resolve()
    }
    view.webContents.once('did-stop-loading', done)
    view.webContents.once('did-fail-load', done)
    view.webContents.once('did-fail-provisional-load', done)
  })
}

// ---------- Request handler ----------

async function handleRequest(ctx: BridgeContext, method: string, params: any): Promise<any> {
  switch (method) {
    // ---- Project ----
    case 'get-project': {
      const project = findProject(ctx.stateFile, params.projectPath)
      if (!project) return null
      return { id: project.id, name: project.name, path: project.path }
    }

    // ---- List windows ----
    case 'list-windows': {
      const project = findProject(ctx.stateFile, params.projectPath)
      if (!project) return { terminals: [], browsers: [], agents: [] }

      const daemon = ctx.getDaemonClient()
      const useDaemon = ctx.getUseDaemon()

      // Enrich terminals with process info
      const terminals = await Promise.all(
        project.terminals.map(async (t) => {
          const [processInfo, runtimeStatus] = await Promise.all([
            (async () => {
              try {
                if (useDaemon && daemon?.isConnected()) {
                  return await daemon.getProcessInfo(t.id)
                }
              } catch {}
              return null
            })(),
            Promise.resolve(ctx.getTerminalStatus(t.id)),
          ])
          return {
            id: t.id,
            title: t.title,
            agent: t.agent ?? null,
            agentStatus: t.agentStatus ?? null,
            runtimeStatus,
            processInfo,
          }
        }),
      )

      // Include MCP-created headless terminals for this project
      for (const [, mcp] of mcpTerminals) {
        if (project && mcp.projectId === project.id) {
          const [processInfo, runtimeStatus] = await Promise.all([
            (async () => {
              try {
                if (useDaemon && daemon?.isConnected()) {
                  return await daemon.getProcessInfo(mcp.termId)
                }
              } catch {}
              return null
            })(),
            Promise.resolve(ctx.getTerminalStatus(mcp.termId)),
          ])
          terminals.push({
            id: mcp.termId,
            title: `MCP Terminal (${mcp.cwd})`,
            agent: null,
            agentStatus: null,
            runtimeStatus,
            processInfo,
          })
        }
      }

      // Enrich browsers with current URL
      const browsers = project.browsers.map((b) => {
        const view = ctx.browserViews.get(b.id)
        let currentUrl = b.url
        let currentTitle = b.title
        try {
          if (view) {
            currentUrl = view.webContents.getURL() || b.url
            currentTitle = view.webContents.getTitle() || b.title
          }
        } catch {}
        return {
          id: b.id,
          url: currentUrl,
          title: currentTitle,
        }
      })

      const agents = await Promise.all(
        (project.agentWindows ?? []).map(async (agentWindow) => {
          const snapshot = await Promise.resolve(ctx.getAgentSessionSnapshot(agentWindow.id))
          return {
            id: agentWindow.id,
            title: agentWindow.customTitle || snapshot?.title || agentWindow.title,
            agent: agentWindow.agent,
            status: snapshot?.status ?? agentWindow.status ?? 'idle',
            cwd: snapshot?.cwd ?? agentWindow.cwd ?? null,
            messageCount: snapshot?.messages.length ?? null,
            claudeSessionId: snapshot?.claudeSessionId ?? agentWindow.claudeSessionId ?? null,
            codexThreadId: snapshot?.codexThreadId ?? agentWindow.codexThreadId ?? null,
            pendingPlanApproval: Boolean(snapshot?.pendingPlanApproval),
            pendingQuestion: Boolean(snapshot?.pendingQuestion),
            pendingApproval: Boolean(snapshot?.pendingApproval),
          }
        }),
      )

      return { terminals, browsers, agents }
    }

    case 'list-all-windows': {
      const projects = listProjects(ctx.stateFile)
      const daemon = ctx.getDaemonClient()
      const useDaemon = ctx.getUseDaemon()

      const result = await Promise.all(
        projects.map(async (project) => {
          const terminals = await Promise.all(
            project.terminals.map(async (t) => {
              const processInfo = await (async () => {
                try {
                  if (useDaemon && daemon?.isConnected()) return await daemon.getProcessInfo(t.id)
                } catch {}
                return null
              })()
              return {
                id: t.id,
                type: 'terminal',
                title: t.title,
                projectId: project.id,
                projectName: project.name,
                projectPath: project.path,
                agent: t.agent ?? null,
                agentStatus: t.agentStatus ?? null,
                runtimeStatus: await Promise.resolve(ctx.getTerminalStatus(t.id)),
                processInfo,
              }
            }),
          )
          const browsers = project.browsers.map((b) => {
            const view = ctx.browserViews.get(b.id)
            return {
              id: b.id,
              type: 'browser',
              title: view?.webContents.getTitle() || b.title,
              projectId: project.id,
              projectName: project.name,
              projectPath: project.path,
              url: view?.webContents.getURL() || b.url,
            }
          })
          const agents = await Promise.all(
            (project.agentWindows ?? []).map(async (agentWindow) => {
              const snapshot = await Promise.resolve(ctx.getAgentSessionSnapshot(agentWindow.id))
              return {
                id: agentWindow.id,
                type: 'agent',
                title: agentWindow.customTitle || snapshot?.title || agentWindow.title,
                projectId: project.id,
                projectName: project.name,
                projectPath: project.path,
                agent: agentWindow.agent,
                status: snapshot?.status ?? agentWindow.status ?? 'idle',
                cwd: snapshot?.cwd ?? agentWindow.cwd ?? null,
                messageCount: snapshot?.messages.length ?? null,
                pendingPlanApproval: Boolean(snapshot?.pendingPlanApproval),
                pendingQuestion: Boolean(snapshot?.pendingQuestion),
                pendingApproval: Boolean(snapshot?.pendingApproval),
              }
            }),
          )
          return {
            project: { id: project.id, name: project.name, path: project.path },
            windows: [...terminals, ...browsers, ...agents],
          }
        }),
      )

      return { projects: result }
    }

    // ---- Terminal operations ----
    case 'get-terminal-output': {
      const termId = params.terminalId as string
      // First check main process ring buffer (captures subscribed terminal data)
      const ringBuffer = terminalOutputRing.get(termId)
      if (ringBuffer && ringBuffer.length > 0) {
        const lines = params.lines as number | undefined
        if (lines) {
          const allLines = ringBuffer.split('\n')
          return { output: allLines.slice(-lines).join('\n') }
        }
        return { output: ringBuffer }
      }

      // Fallback to daemon buffer (for unsubscribed terminals)
      const daemon = ctx.getDaemonClient()
      if (ctx.getUseDaemon() && daemon?.isConnected()) {
        try {
          const buffer = await daemon.getBuffer(termId)
          if (params.lines) {
            const allLines = buffer.split('\n')
            return { output: allLines.slice(-params.lines).join('\n') }
          }
          return { output: buffer }
        } catch {}
      }

      const fallbackBuffer = ctx.getFallbackSessions()?.getBuffer(termId) ?? ''
      if (params.lines) {
        const allLines = fallbackBuffer.split('\n')
        return { output: allLines.slice(-params.lines).join('\n') }
      }
      if (fallbackBuffer) {
        return { output: fallbackBuffer }
      }
      return { output: '' }
    }

    case 'write-terminal': {
      const termId = params.terminalId as string
      const data = params.data as string
      const daemon = ctx.getDaemonClient()
      if (ctx.getUseDaemon() && daemon?.isConnected()) {
        daemon.write(termId, data)
      } else {
        ctx.getFallbackSessions()?.write(termId, data)
      }
      return null
    }

    case 'get-terminal-process': {
      const termId = params.terminalId as string
      const daemon = ctx.getDaemonClient()
      if (ctx.getUseDaemon() && daemon?.isConnected()) {
        return await daemon.getProcessInfo(termId)
      }
      return ctx.getFallbackSessions()?.getProcessInfo(termId) ?? null
    }

    case 'create-terminal': {
      const projectPath = params.projectPath as string
      const cwd = (params.cwd as string) || projectPath
      const project = findProject(ctx.stateFile, projectPath)
      if (!project) throw new Error('No project found for path: ' + projectPath)

      const termId = 'mcp-' + generateId()
      const daemon = ctx.getDaemonClient()
      if (ctx.getUseDaemon() && daemon?.isConnected()) {
        await daemon.spawn(termId, 120, 40, cwd)
        // Subscribe so we get output in the ring buffer
        const buffer = await daemon.subscribe(termId)
        if (buffer) bufferTerminalOutput(termId, buffer)
        ctx.subscribedTerminals.add(termId)

        mcpTerminals.set(termId, {
          termId,
          projectId: project.id,
          cwd,
          createdAt: Date.now(),
        })
        return { terminalId: termId }
      }
      throw new Error('PTY daemon not available')
    }

    case 'close-terminal': {
      const termId = params.terminalId as string
      const daemon = ctx.getDaemonClient()
      if (ctx.getUseDaemon() && daemon?.isConnected()) {
        await daemon.kill(termId)
      }
      ctx.subscribedTerminals.delete(termId)
      mcpTerminals.delete(termId)
      terminalOutputRing.delete(termId)
      return null
    }

    // ---- Browser operations ----
    case 'navigate-browser': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      const url = normalizeBrowserUrl(params.url as string)
      view.webContents.loadURL(url)
      return null
    }

    case 'browser-go-back': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      if (view.webContents.navigationHistory.canGoBack()) {
        view.webContents.navigationHistory.goBack()
      }
      return null
    }

    case 'browser-go-forward': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      if (view.webContents.navigationHistory.canGoForward()) {
        view.webContents.navigationHistory.goForward()
      }
      return null
    }

    case 'browser-reload': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      view.webContents.reload()
      return null
    }

    case 'browser-get-url': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      return { url: view.webContents.getURL(), title: view.webContents.getTitle() }
    }

    case 'get-console-logs': {
      const logs = consoleLogs.get(params.browserId) ?? []
      return { logs }
    }

    case 'execute-js': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      try {
        const result = await view.webContents.executeJavaScript(params.code)
        return { result: serializeJsResult(result) }
      } catch (err: any) {
        return { error: err.message }
      }
    }

    case 'browser-snapshot': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      const maxElements = Math.max(1, Math.min(Number(params.maxElements ?? 200), 500))
      return await view.webContents.executeJavaScript(`(() => {
        const maxElements = ${JSON.stringify(maxElements)};
        const cssEscape = (value) => {
          if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
          return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
        };
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          if (!style || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
        };
        const selectorFor = (el) => {
          if (el.id) return '#' + cssEscape(el.id);
          const parts = [];
          let node = el;
          while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body && parts.length < 6) {
            const tag = node.tagName.toLowerCase();
            let index = 1;
            let sibling = node.previousElementSibling;
            while (sibling) {
              if (sibling.tagName === node.tagName) index += 1;
              sibling = sibling.previousElementSibling;
            }
            parts.unshift(tag + ':nth-of-type(' + index + ')');
            node = node.parentElement;
          }
          return 'body > ' + parts.join(' > ');
        };
        const roleFor = (el) => {
          const explicit = el.getAttribute('role');
          if (explicit) return explicit;
          const tag = el.tagName.toLowerCase();
          if (tag === 'a') return 'link';
          if (tag === 'button') return 'button';
          if (tag === 'input') return el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox';
          if (tag === 'textarea') return 'textbox';
          if (tag === 'select') return 'combobox';
          if (/^h[1-6]$/.test(tag)) return 'heading';
          return tag;
        };
        const nameFor = (el) => {
          const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt');
          if (aria) return aria.trim();
          if (el.labels && el.labels.length) return Array.from(el.labels).map((label) => label.innerText).join(' ').trim();
          return (el.innerText || el.value || el.textContent || '').replace(/\\s+/g, ' ').trim();
        };
        const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"],h1,h2,h3,h4,h5,h6,[tabindex]'));
        const elements = [];
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          const rect = el.getBoundingClientRect();
          elements.push({
            ref: elements.length + 1,
            role: roleFor(el),
            name: nameFor(el).slice(0, 240),
            selector: selectorFor(el),
            value: 'value' in el ? String(el.value ?? '').slice(0, 240) : null,
            checked: 'checked' in el ? Boolean(el.checked) : null,
            disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          });
          if (elements.length >= maxElements) break;
        }
        return {
          url: location.href,
          title: document.title,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          elements,
          text: (document.body?.innerText || '').slice(0, 20000),
        };
      })()`)
    }

    case 'browser-click': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      let x = Number(params.x)
      let y = Number(params.y)
      if (params.selector || params.text) {
        const target = await view.webContents.executeJavaScript(`(() => {
          const selector = ${JSON.stringify(params.selector ?? null)};
          const text = ${JSON.stringify(params.text ?? null)};
          const visible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          let el = selector ? document.querySelector(selector) : null;
          if (!el && text) {
            const needle = String(text).toLowerCase();
            el = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[tabindex]'))
              .find((candidate) => visible(candidate) && (candidate.innerText || candidate.value || candidate.getAttribute('aria-label') || '').toLowerCase().includes(needle));
          }
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          if (typeof el.focus === 'function') el.focus();
          const rect = el.getBoundingClientRect();
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        })()`)
        if (!target) throw new Error('Browser target not found')
        x = target.x
        y = target.y
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('browser-click requires selector, text, or x/y coordinates')
      }
      view.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      view.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      view.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      return null
    }

    case 'browser-hover': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      let x = Number(params.x)
      let y = Number(params.y)
      if (params.selector) {
        const target = await view.webContents.executeJavaScript(`(() => {
          const el = document.querySelector(${JSON.stringify(params.selector)});
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = el.getBoundingClientRect();
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        })()`)
        if (!target) throw new Error('Browser target not found')
        x = target.x
        y = target.y
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('browser-hover requires selector or x/y coordinates')
      }
      view.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      return null
    }

    case 'browser-fill': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      const ok = await view.webContents.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        const value = ${JSON.stringify(params.value ?? '')};
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof el.focus === 'function') el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set && ('value' in el)) descriptor.set.call(el, value);
        else el.value = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`)
      if (!ok) throw new Error('Browser target not found: ' + params.selector)
      return null
    }

    case 'browser-type': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      if (params.selector) {
        const ok = await view.webContents.executeJavaScript(`(() => {
          const el = document.querySelector(${JSON.stringify(params.selector)});
          if (!el) return false;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          if (typeof el.focus === 'function') el.focus();
          return true;
        })()`)
        if (!ok) throw new Error('Browser target not found: ' + params.selector)
      }
      if (typeof (view.webContents as any).insertText === 'function') {
        await (view.webContents as any).insertText(params.text ?? '')
      } else {
        await view.webContents.executeJavaScript(
          `document.execCommand('insertText', false, ${JSON.stringify(params.text ?? '')})`,
        )
      }
      return null
    }

    case 'browser-press-key': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      const keyCode = String(params.key)
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode })
      return null
    }

    case 'browser-select': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      const ok = await view.webContents.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!(el instanceof HTMLSelectElement)) return false;
        el.value = ${JSON.stringify(params.value ?? '')};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`)
      if (!ok) throw new Error('Browser select target not found: ' + params.selector)
      return null
    }

    case 'browser-wait-for': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      const timeoutMs = Math.max(500, Math.min(Number(params.timeoutMs ?? 10_000), 60_000))
      const start = Date.now()
      if (params.loadState === 'loaded') {
        await waitForBrowserLoad(view, timeoutMs)
        return { matched: true }
      }
      while (Date.now() - start < timeoutMs) {
        const matched = await view.webContents.executeJavaScript(`(() => {
          const selector = ${JSON.stringify(params.selector ?? null)};
          const text = ${JSON.stringify(params.text ?? null)};
          if (selector && document.querySelector(selector)) return true;
          if (text && (document.body?.innerText || '').includes(text)) return true;
          return false;
        })()`)
        if (matched) return { matched: true }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      return { matched: false }
    }

    case 'get-network-requests': {
      const requests = networkRequests.get(params.browserId) ?? []
      const limit = Math.max(1, Math.min(Number(params.limit ?? 100), 1000))
      return { requests: requests.slice(-limit) }
    }

    case 'clear-network-requests': {
      clearBrowserNetworkRequests(params.browserId)
      return null
    }

    case 'browser-screenshot': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      const image = await view.webContents.capturePage()
      const png = image.toPNG()
      return { data: png.toString('base64'), mimeType: 'image/png' }
    }

    // ---- Cells window and agent session operations ----
    case 'focus-window': {
      const windowId = params.windowId as string
      const type = params.type as 'terminal' | 'browser' | 'agent'
      if (!windowId || !type) throw new Error('Missing required params: windowId, type')
      const project = findProjectByWindowId(ctx.stateFile, type, windowId)
      const mainWindow = ctx.getMainWindow()
      focusMainWindow(mainWindow)

      if (type === 'browser') {
        const view = ctx.browserViews.get(windowId)
        if (!view) throw new Error('Browser not found: ' + windowId)
        view.webContents.focus()
      } else if (type === 'agent') {
        if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window not available')
        mainWindow.webContents.send('app:focus-agent-window', {
          windowId,
          projectId: project?.id ?? null,
        })
      }

      return { focused: true, projectId: project?.id ?? null }
    }

    case 'get-agent-session': {
      const windowId = params.windowId as string
      const snapshot = await Promise.resolve(ctx.getAgentSessionSnapshot(windowId))
      if (!snapshot) throw new Error('Agent session not found: ' + windowId)
      return snapshot
    }

    case 'get-agent-messages': {
      const windowId = params.windowId as string
      const snapshot = await Promise.resolve(ctx.getAgentSessionSnapshot(windowId))
      if (!snapshot) throw new Error('Agent session not found: ' + windowId)
      const limit = Math.max(1, Math.min(Number(params.limit ?? snapshot.messages.length), 200))
      const lines = Math.max(0, Math.min(Number(params.lines ?? 0), 1000)) || undefined
      return {
        windowId: snapshot.windowId,
        agent: snapshot.agent,
        title: snapshot.title,
        status: snapshot.status,
        updatedAt: snapshot.updatedAt,
        messages: snapshot.messages.slice(-limit).map((message) => ({
          ...message,
          text: trimLines(message.text, lines),
        })),
      }
    }

    case 'send-agent-message': {
      const windowId = params.windowId as string
      const input = params.input as string
      if (!windowId || typeof input !== 'string') {
        throw new Error('Missing required params: windowId, input')
      }
      await Promise.resolve(ctx.sendAgentMessage(windowId, input, params.attachments))
      return null
    }

    // ---- Notifications ----
    case 'notify': {
      const title = (params.title as string) || 'Cells'
      const body = params.body as string
      if (!body) throw new Error('Missing required param: body')
      const n = new Notification({ title, body })
      n.show()
      return null
    }

    default:
      throw new Error('Unknown method: ' + method)
  }
}

// ---------- Client connection ----------

function handleClient(socket: net.Socket, ctx: BridgeContext) {
  let lineBuffer = ''

  socket.on('data', (chunk) => {
    lineBuffer += chunk.toString()
    let idx: number
    while ((idx = lineBuffer.indexOf('\n')) !== -1) {
      const line = lineBuffer.slice(0, idx)
      lineBuffer = lineBuffer.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        const { id, method, params } = msg
        if (!id || !method) {
          respondError(socket, id ?? 0, 'Missing id or method')
          continue
        }
        handleRequest(ctx, method, params ?? {})
          .then((data) => respond(socket, id, data))
          .catch((err) => respondError(socket, id, err.message ?? String(err)))
      } catch {
        // Malformed JSON — ignore
      }
    }
  })

  socket.on('error', () => {})
}

// ---------- Start / stop ----------

let server: net.Server | null = null

export function startMcpBridge(socketPath: string, ctx: BridgeContext): void {
  // Clean stale socket
  try {
    fs.unlinkSync(socketPath)
  } catch {}

  server = net.createServer((socket) => handleClient(socket, ctx))

  server.listen(socketPath, () => {
    // Restrict permissions
    try {
      fs.chmodSync(socketPath, 0o600)
    } catch {}
  })

  server.on('error', (err) => {
    console.error('[mcp-bridge] Server error:', err)
  })
}

export function stopMcpBridge(socketPath: string): void {
  if (server) {
    server.close()
    server = null
  }
  try {
    fs.unlinkSync(socketPath)
  } catch {}
}
