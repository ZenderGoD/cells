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
import type { Project, ProjectsState } from '../src/types'

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

function generateId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
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
      if (!project) return { terminals: [], browsers: [] }

      const daemon = ctx.getDaemonClient()
      const useDaemon = ctx.getUseDaemon()

      // Enrich terminals with process info
      const terminals = await Promise.all(
        project.terminals.map(async (t) => {
          let processInfo = null
          try {
            if (useDaemon && daemon?.isConnected()) {
              processInfo = await daemon.getProcessInfo(t.id)
            }
          } catch {}
          return {
            id: t.id,
            title: t.title,
            agent: t.agent ?? null,
            agentStatus: t.agentStatus ?? null,
            processInfo,
          }
        }),
      )

      // Include MCP-created headless terminals for this project
      for (const [, mcp] of mcpTerminals) {
        if (project && mcp.projectId === project.id) {
          let processInfo = null
          try {
            if (useDaemon && daemon?.isConnected()) {
              processInfo = await daemon.getProcessInfo(mcp.termId)
            }
          } catch {}
          terminals.push({
            id: mcp.termId,
            title: `MCP Terminal (${mcp.cwd})`,
            agent: null,
            agentStatus: null,
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

      return { terminals, browsers }
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
      let url = params.url as string
      if (!/^https?:\/\//i.test(url) && !url.startsWith('about:')) {
        if (url.includes('.') && !url.includes(' ')) {
          url = 'https://' + url
        } else {
          url = `https://www.google.com/search?q=${encodeURIComponent(url)}`
        }
      }
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
        return { result: result !== undefined ? String(result) : 'undefined' }
      } catch (err: any) {
        return { error: err.message }
      }
    }

    case 'browser-screenshot': {
      const view = ctx.browserViews.get(params.browserId)
      if (!view) throw new Error('Browser not found: ' + params.browserId)
      const image = await view.webContents.capturePage()
      const png = image.toPNG()
      return { data: png.toString('base64'), mimeType: 'image/png' }
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
