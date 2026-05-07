/**
 * PTY Daemon — standalone process that owns terminal PTYs.
 *
 * Runs via ELECTRON_RUN_AS_NODE=1 so it can use the same node-pty native addon.
 * Communicates with the Electron app over a Unix domain socket using
 * newline-delimited JSON.
 *
 * Cells intentionally version-locks this daemon to the app. On app upgrade we
 * restart the daemon rather than preserving cross-version sessions. That keeps
 * the attach contract app-internal and lets the protocol evolve without
 * carrying compatibility fallbacks forever.
 *
 * Protocol stability still matters within a single app version:
 * - requests are newline-delimited JSON
 * - responses are { type: "response", id, ok, data? }
 * - push events are stable `data` and `exit` messages
 *
 * `attach` is the critical session primitive. In tmux mode the daemon creates
 * a fresh tmux client PTY for the renderer and lets tmux redraw the canonical
 * server-owned screen state. Cells does not reconstruct live sessions from
 * replayed shell bytes anymore.
 *
 * Environment variables:
 *   CELLS_HOME_DIR   — directory for socket/pid/version files (default: ~/.cells)
 *   CELLS_APP_VERSION — written to version file on startup
 */

import net from 'net'
import fs from 'fs'
import path from 'path'
import { HOME_DIR } from './pty-shared'
import { PTY_DAEMON_COMPAT_VERSION, PTY_DAEMON_PROTOCOL_VERSION } from './pty-daemon-contract'
import { createTerminalSessionManager, getTerminalBackendSupportStatus } from './terminal-backend'
import type { Project, ProjectsState, TerminalNode, TerminalSessionBackend } from '../src/types'

// ---------- Paths ----------

const STATE_DIR = process.env.CELLS_HOME_DIR || path.join(HOME_DIR, '.cells')
const SOCKET_PATH = path.join(STATE_DIR, 'pty-daemon.sock')
const SERVICE_SOCKET_PATH = path.join(STATE_DIR, 'terminal-service.sock')
const PID_FILE = path.join(STATE_DIR, 'pty-daemon.pid')
const VERSION_FILE = path.join(STATE_DIR, 'pty-daemon.version')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const BACKEND = (
  process.env.CELLS_TERMINAL_BACKEND === 'tmux' ? 'tmux' : 'zellij'
) as TerminalSessionBackend

// ---------- State ----------

const subscribers = new Map<string, net.Socket>() // termId → subscribed client socket
const serviceTerminals = new Map<string, { termId: string; projectId: string; cwd: string }>()
const serviceAttachedTerminals = new Set<string>()

// Track which terminals each client socket owns subscriptions for
const clientSubscriptions = new Map<net.Socket, Set<string>>()

const backendSupport = getTerminalBackendSupportStatus(BACKEND)
if (!backendSupport.ok) {
  throw new Error(
    backendSupport.reason === 'too-old'
      ? `${backendSupport.name} ${backendSupport.minimumVersion}+ required, found ${backendSupport.version ?? 'unknown'}`
      : `${backendSupport.name} ${backendSupport.minimumVersion}+ is required`,
  )
}

// ---------- Microbatch outgoing terminal data ----------
// During heavy output (builds, large logs) node-pty fires many small data
// events. Sending each one as a separate JSON message over the socket is
// wasteful — the client-side PtyDaemonClient parses each line individually.
// Instead we accumulate per-terminal data and flush after a short delay or
// when the buffer exceeds a size threshold, cutting socket message count by
// 10-50× during bursts while adding at most ~4ms latency.

const MICROBATCH_DELAY_MS = 4
const MICROBATCH_MAX_BYTES = 64 * 1024

const pendingData = new Map<string, string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(flushPendingData, MICROBATCH_DELAY_MS)
}

function flushPendingData() {
  flushTimer = null
  for (const [termId, data] of pendingData) {
    const sub = subscribers.get(termId)
    if (sub) {
      sendBinaryData(sub, termId, data)
    }
  }
  pendingData.clear()
}

function bufferTerminalData(termId: string, data: string) {
  const existing = pendingData.get(termId)
  const merged = existing ? existing + data : data
  pendingData.set(termId, merged)

  // Flush immediately if accumulated data is large enough —
  // no point adding latency when there's already a big chunk to send.
  if (merged.length >= MICROBATCH_MAX_BYTES) {
    // Flush only this terminal's buffer; leave others to the timer.
    pendingData.delete(termId)
    const sub = subscribers.get(termId)
    if (sub) {
      sendBinaryData(sub, termId, merged)
    }
  } else {
    scheduleFlush()
  }
}

// The backend manager owns canonical terminal state for this daemon lifetime.
// In tmux mode that constructor boots the private Cells tmux server immediately
// but still leaves per-project session creation lazy until terminal attach.
const sessionManager = createTerminalSessionManager(BACKEND, STATE_DIR, {
  onData(termId, data) {
    bufferTerminalData(termId, data)
  },
  onExit(termId) {
    serviceAttachedTerminals.delete(termId)
    serviceTerminals.delete(termId)

    // Flush any buffered data before sending the exit event so the client
    // sees the final output before the terminal disappears.
    const buffered = pendingData.get(termId)
    if (buffered) {
      pendingData.delete(termId)
      const sub = subscribers.get(termId)
      if (sub) {
        sendBinaryData(sub, termId, buffered)
      }
    }

    const sub = subscribers.get(termId)
    if (sub) {
      sendJson(sub, { type: 'exit', termId })
      subscribers.delete(termId)
      clientSubscriptions.get(sub)?.delete(termId)
    }
  },
})

// ---------- Send helpers ----------

// Binary frame marker for terminal data events. Any byte < 0x20 works since
// JSON lines always start with '{' (0x7B). The client parser checks the first
// byte to decide whether to parse a binary frame or a JSON line.
const BINARY_DATA_MARKER = 0x02

/**
 * Send terminal data as a compact binary frame, avoiding JSON overhead.
 * Frame layout: [0x02][uint16 termId len][termId][uint32 data len][data]
 */
function sendBinaryData(socket: net.Socket, termId: string, data: string) {
  try {
    const termIdBuf = Buffer.from(termId, 'utf-8')
    const dataBuf = Buffer.from(data, 'utf-8')
    const frame = Buffer.allocUnsafe(1 + 2 + termIdBuf.length + 4 + dataBuf.length)
    let off = 0
    frame[off++] = BINARY_DATA_MARKER
    frame.writeUInt16BE(termIdBuf.length, off)
    off += 2
    termIdBuf.copy(frame, off)
    off += termIdBuf.length
    frame.writeUInt32BE(dataBuf.length, off)
    off += 4
    dataBuf.copy(frame, off)
    socket.write(frame)
  } catch {}
}

function sendJson(socket: net.Socket, msg: object) {
  try {
    socket.write(JSON.stringify(msg) + '\n')
  } catch {}
}

function sendResponse(socket: net.Socket, id: number, ok: boolean, data?: any) {
  sendJson(socket, { type: 'response', id, ok, ...(data !== undefined ? { data } : {}) })
}

function sendError(socket: net.Socket, id: number, error: string) {
  sendJson(socket, { type: 'response', id, ok: false, error })
}

function sendServiceResponse(
  socket: net.Socket,
  id: number,
  ok: boolean,
  data?: any,
  error?: string,
) {
  sendJson(socket, { id, ok, ...(ok ? { data } : { error }) })
}

function loadState(): ProjectsState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as ProjectsState
  } catch {
    return null
  }
}

function listProjects(): Project[] {
  return loadState()?.projects ?? []
}

function findProject(projectPath: string): Project | null {
  let best: Project | null = null
  let bestLen = 0
  for (const project of listProjects()) {
    if (projectPath.startsWith(project.path) && project.path.length > bestLen) {
      best = project
      bestLen = project.path.length
    }
  }
  return best
}

function findProjectById(projectId: string): Project | null {
  return listProjects().find((project) => project.id === projectId) ?? null
}

function findTerminalContext(
  termId: string,
  projectPath: string,
): { project: Project; cwd: string } | null {
  const serviceTerminal = serviceTerminals.get(termId)
  if (serviceTerminal) {
    const project = findProjectById(serviceTerminal.projectId)
    return project ? { project, cwd: serviceTerminal.cwd } : null
  }

  const preferredProject = findProject(projectPath)
  const projects = preferredProject
    ? [preferredProject, ...listProjects().filter((project) => project.id !== preferredProject.id)]
    : listProjects()

  for (const project of projects) {
    const terminal = (project.terminals ?? []).find((entry) => entry.id === termId)
    if (terminal) return { project, cwd: terminal.cwd || project.path }
  }

  return null
}

function ensureServiceTerminalAttached(termId: string, params: any) {
  if (serviceAttachedTerminals.has(termId)) return true
  const context = findTerminalContext(termId, String(params.projectPath ?? ''))
  if (!context) return false
  attachPty(termId, 120, 40, context.cwd, context.project.id)
  serviceAttachedTerminals.add(termId)
  return true
}

function trimLines(value: string, lines?: number) {
  if (!lines) return value
  return value.split('\n').slice(-lines).join('\n')
}

function generateServiceTermId() {
  return `mcp-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

function serializeTerminal(project: Project, terminal: TerminalNode) {
  const processInfo = sessionManager.has(terminal.id)
    ? sessionManager.getProcessInfo(terminal.id)
    : null
  return {
    id: terminal.id,
    title: terminal.title,
    type: 'terminal',
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    agent: terminal.agent ?? null,
    agentStatus: terminal.agentStatus ?? null,
    runtimeStatus: null,
    processInfo,
  }
}

function serializeServiceTerminal(project: Project, entry: { termId: string; cwd: string }) {
  return {
    id: entry.termId,
    title: `MCP Terminal (${entry.cwd})`,
    type: 'terminal',
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    agent: null,
    agentStatus: null,
    runtimeStatus: null,
    processInfo: sessionManager.has(entry.termId)
      ? sessionManager.getProcessInfo(entry.termId)
      : null,
  }
}

async function handleServiceRequest(method: string, params: any): Promise<any> {
  switch (method) {
    case 'get-project': {
      const project = findProject(String(params.projectPath ?? ''))
      return project ? { id: project.id, name: project.name, path: project.path } : null
    }

    case 'list-windows': {
      const project = findProject(String(params.projectPath ?? ''))
      if (!project) return { terminals: [], browsers: [], agents: [] }
      const terminals = (project.terminals ?? []).map((terminal) =>
        serializeTerminal(project, terminal),
      )
      for (const entry of serviceTerminals.values()) {
        if (entry.projectId === project.id) terminals.push(serializeServiceTerminal(project, entry))
      }
      const browsers = (project.browsers ?? []).map((browser) => ({
        id: browser.id,
        url: browser.url,
        title: browser.title,
      }))
      const agents = (project.agentWindows ?? []).map((agentWindow) => ({
        id: agentWindow.id,
        title: agentWindow.customTitle || agentWindow.title,
        agent: agentWindow.agent,
        status: agentWindow.status ?? 'idle',
        cwd: agentWindow.cwd ?? null,
        messageCount: null,
        claudeSessionId: agentWindow.claudeSessionId ?? null,
        codexThreadId: agentWindow.codexThreadId ?? null,
        pendingPlanApproval: false,
        pendingQuestion: false,
        pendingApproval: false,
      }))
      return { terminals, browsers, agents }
    }

    case 'list-all-windows': {
      const projects = listProjects()
      return {
        projects: projects.map((project) => ({
          project: { id: project.id, name: project.name, path: project.path },
          windows: [
            ...(project.terminals ?? []).map((terminal) => serializeTerminal(project, terminal)),
            ...(project.browsers ?? []).map((browser) => ({
              id: browser.id,
              type: 'browser',
              title: browser.title,
              projectId: project.id,
              projectName: project.name,
              projectPath: project.path,
              url: browser.url,
            })),
            ...(project.agentWindows ?? []).map((agentWindow) => ({
              id: agentWindow.id,
              type: 'agent',
              title: agentWindow.customTitle || agentWindow.title,
              projectId: project.id,
              projectName: project.name,
              projectPath: project.path,
              agent: agentWindow.agent,
              status: agentWindow.status ?? 'idle',
              cwd: agentWindow.cwd ?? null,
              messageCount: null,
              pendingPlanApproval: false,
              pendingQuestion: false,
              pendingApproval: false,
            })),
            ...[...serviceTerminals.values()]
              .filter((entry) => entry.projectId === project.id)
              .map((entry) => serializeServiceTerminal(project, entry)),
          ],
        })),
      }
    }

    case 'get-terminal-output': {
      const termId = String(params.terminalId ?? '')
      const output = sessionManager.has(termId)
        ? sessionManager.getBuffer(termId) || sessionManager.getHistory(termId)
        : ''
      return { output: trimLines(output, params.lines) }
    }

    case 'write-terminal': {
      const termId = String(params.terminalId ?? '')
      if (!ensureServiceTerminalAttached(termId, params)) {
        throw new Error(`Terminal not found: ${termId}`)
      }
      sessionManager.write(termId, String(params.data ?? ''))
      return null
    }

    case 'get-terminal-process': {
      const termId = String(params.terminalId ?? '')
      return sessionManager.has(termId) ? sessionManager.getProcessInfo(termId) : null
    }

    case 'create-terminal': {
      const project = findProject(String(params.projectPath ?? ''))
      if (!project) throw new Error(`No project found for path: ${params.projectPath ?? ''}`)
      const cwd = String(params.cwd || project.path)
      const termId = generateServiceTermId()
      attachPty(termId, 120, 40, cwd, project.id)
      serviceAttachedTerminals.add(termId)
      serviceTerminals.set(termId, { termId, projectId: project.id, cwd })
      return { terminalId: termId }
    }

    case 'close-terminal': {
      const termId = String(params.terminalId ?? '')
      sessionManager.kill(termId)
      serviceAttachedTerminals.delete(termId)
      serviceTerminals.delete(termId)
      return null
    }

    default:
      throw new Error(`Cells app bridge is required for '${method}'`)
  }
}

// ---------- PTY management ----------

function spawnPty(
  termId: string,
  cols: number,
  rows: number,
  cwd?: string,
  projectId?: string | null,
): { reattached: boolean; shellPid: number } {
  return sessionManager.spawn(termId, cols, rows, cwd, projectId)
}

function attachPty(
  termId: string,
  cols: number,
  rows: number,
  cwd: string | undefined,
  projectId?: string | null,
): { reattached: boolean; shellPid: number; buffer: string } {
  return sessionManager.attach(termId, cols, rows, cwd, projectId)
}

function killPty(termId: string) {
  sessionManager.kill(termId)
  subscribers.delete(termId)
  for (const subscribedTerminals of clientSubscriptions.values()) {
    subscribedTerminals.delete(termId)
  }
}

// ---------- Request handling ----------

function handleMessage(socket: net.Socket, msg: any) {
  const { type, id } = msg

  switch (type) {
    case 'attach': {
      const termId = msg.termId
      const prevSub = subscribers.get(termId)
      if (prevSub) {
        clientSubscriptions.get(prevSub)?.delete(termId)
      }
      subscribers.set(termId, socket)
      if (!clientSubscriptions.has(socket)) clientSubscriptions.set(socket, new Set())
      clientSubscriptions.get(socket)!.add(termId)

      try {
        sendResponse(
          socket,
          id,
          true,
          attachPty(termId, msg.cols, msg.rows, msg.cwd, msg.projectId),
        )
      } catch (err: any) {
        if (subscribers.get(termId) === socket) {
          subscribers.delete(termId)
        }
        clientSubscriptions.get(socket)?.delete(termId)
        sendError(socket, id, err.message)
      }
      break
    }

    case 'spawn': {
      try {
        const result = spawnPty(msg.termId, msg.cols, msg.rows, msg.cwd, msg.projectId)
        sendResponse(socket, id, true, result)
      } catch (err: any) {
        sendError(socket, id, err.message)
      }
      break
    }

    case 'subscribe': {
      const termId = msg.termId
      if (!sessionManager.has(termId)) {
        sendError(socket, id, `No PTY for terminal ${termId}`)
        break
      }
      const buffer = sessionManager.subscribe(termId, () => {
        const prevSub = subscribers.get(termId)
        if (prevSub) {
          clientSubscriptions.get(prevSub)?.delete(termId)
        }
        subscribers.set(termId, socket)
        if (!clientSubscriptions.has(socket)) clientSubscriptions.set(socket, new Set())
        clientSubscriptions.get(socket)!.add(termId)
      })
      sendResponse(socket, id, true, { buffer })
      break
    }

    case 'unsubscribe': {
      // Fire-and-forget, no response
      const termId = msg.termId
      if (subscribers.get(termId) === socket) {
        subscribers.delete(termId)
        sessionManager.unsubscribe(termId)
      }
      clientSubscriptions.get(socket)?.delete(termId)
      break
    }

    case 'kill': {
      killPty(msg.termId)
      sendResponse(socket, id, true)
      break
    }

    case 'write': {
      // Fire-and-forget
      sessionManager.write(msg.termId, msg.data)
      break
    }

    case 'resize': {
      // Fire-and-forget
      sessionManager.resize(msg.termId, msg.cols, msg.rows)
      break
    }

    case 'handle-wheel': {
      sessionManager.handleWheel(msg.termId, msg.direction, msg.steps, msg.sequence)
      if (id != null) {
        sendResponse(socket, id, true)
      }
      break
    }

    case 'get-process-info': {
      if (!sessionManager.has(msg.termId)) {
        sendResponse(socket, id, true, null)
        break
      }
      sendResponse(socket, id, true, sessionManager.getProcessInfo(msg.termId))
      break
    }

    case 'get-codex-title': {
      sendResponse(socket, id, true, sessionManager.getCodexTitle(msg.termId))
      break
    }

    case 'get-shell-pid': {
      sendResponse(socket, id, true, sessionManager.getShellPid(msg.termId))
      break
    }

    case 'get-scroll-status': {
      sendResponse(socket, id, true, sessionManager.getScrollStatus(msg.termId))
      break
    }

    case 'get-buffer': {
      sendResponse(socket, id, true, { buffer: sessionManager.getBuffer(msg.termId) })
      break
    }

    case 'get-history': {
      sendResponse(socket, id, true, { buffer: sessionManager.getHistory(msg.termId) })
      break
    }

    case 'list': {
      sendResponse(socket, id, true, sessionManager.list())
      break
    }

    case 'ping': {
      sendResponse(socket, id, true, { ok: true })
      break
    }

    case 'get-daemon-version': {
      sendResponse(socket, id, true, {
        protocolVersion: PTY_DAEMON_PROTOCOL_VERSION,
        compatVersion: PTY_DAEMON_COMPAT_VERSION,
        backend: BACKEND,
        appVersion: process.env.CELLS_APP_VERSION ?? null,
        electronVersion: process.versions.electron ?? null,
        nodeAbi: process.versions.modules ?? null,
        pid: process.pid,
        uptime: Math.floor(process.uptime()),
        backendDetails: sessionManager.getBackendDetails(),
      })
      break
    }

    case 'shutdown': {
      sendResponse(socket, id, true)
      gracefulShutdown()
      break
    }

    // Unknown message types are silently ignored for forward compatibility.
    // New app versions may send messages that old daemons don't understand —
    // the client will time out and degrade gracefully.
    default:
      if (id != null) {
        sendError(socket, id, `Unknown message type: ${type}`)
      }
      break
  }
}

// ---------- Client connection ----------

function handleClient(socket: net.Socket) {
  let lineBuffer = ''
  clientSubscriptions.set(socket, new Set())

  socket.on('data', (chunk) => {
    lineBuffer += chunk.toString()
    let newlineIdx: number
    while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
      const line = lineBuffer.slice(0, newlineIdx)
      lineBuffer = lineBuffer.slice(newlineIdx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        handleMessage(socket, msg)
      } catch {}
    }
  })

  socket.on('close', () => {
    // Unsubscribe all terminals owned by this client
    const subs = clientSubscriptions.get(socket)
    if (subs) {
      for (const termId of subs) {
        if (subscribers.get(termId) === socket) {
          subscribers.delete(termId)
          sessionManager.unsubscribe(termId)
        }
      }
    }
    clientSubscriptions.delete(socket)
  })

  socket.on('error', () => {
    // Handled by close
  })
}

function handleServiceClient(socket: net.Socket) {
  let lineBuffer = ''

  socket.on('data', (chunk) => {
    lineBuffer += chunk.toString()
    let newlineIdx: number
    while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
      const line = lineBuffer.slice(0, newlineIdx)
      lineBuffer = lineBuffer.slice(newlineIdx + 1)
      if (!line.trim()) continue

      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }

      const id = Number(msg.id)
      const method = String(msg.method ?? '')
      handleServiceRequest(method, msg.params ?? {})
        .then((data) => sendServiceResponse(socket, id, true, data))
        .catch((error) =>
          sendServiceResponse(
            socket,
            id,
            false,
            undefined,
            error instanceof Error ? error.message : String(error),
          ),
        )
    }
  })

  socket.on('error', () => {})
}

// ---------- Lifecycle ----------

function cleanup() {
  try {
    fs.unlinkSync(SOCKET_PATH)
  } catch {}
  try {
    fs.unlinkSync(SERVICE_SOCKET_PATH)
  } catch {}
  try {
    fs.unlinkSync(PID_FILE)
  } catch {}
  try {
    fs.unlinkSync(VERSION_FILE)
  } catch {}
}

function gracefulShutdown() {
  server.close()
  serviceServer.close()
  // Flush any buffered terminal data before tearing down
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flushPendingData()
  // The daemon owns attach-side client PTYs, not the canonical backend
  // sessions themselves. On shutdown we only tear down disposable viewer/client
  // attachments and leave the private tmux server plus project sessions alive
  // so a restarted daemon can rediscover and reattach to the same backend state.
  sessionManager.cleanup()
  cleanup()
  process.exit(0)
}

process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)
process.on('uncaughtException', (err) => {
  // Ignore dead PTY EIO errors
  if ((err as any).code === 'EIO' && (err as any).syscall === 'write') return
  console.error('Daemon uncaught exception:', err)
})

// ---------- Start server ----------

fs.mkdirSync(STATE_DIR, { recursive: true })

// Clean stale socket
try {
  fs.unlinkSync(SOCKET_PATH)
} catch {}
try {
  fs.unlinkSync(SERVICE_SOCKET_PATH)
} catch {}

const server = net.createServer(handleClient)
const serviceServer = net.createServer(handleServiceClient)

server.listen(SOCKET_PATH, () => {
  // Write PID and version files
  fs.writeFileSync(PID_FILE, String(process.pid))
  if (process.env.CELLS_APP_VERSION) {
    fs.writeFileSync(VERSION_FILE, process.env.CELLS_APP_VERSION)
  }
  // Restrict socket permissions
  try {
    fs.chmodSync(SOCKET_PATH, 0o600)
  } catch {}
})

server.on('error', (err) => {
  console.error('Daemon server error:', err)
  process.exit(1)
})

serviceServer.listen(SERVICE_SOCKET_PATH, () => {
  try {
    fs.chmodSync(SERVICE_SOCKET_PATH, 0o600)
  } catch {}
})

serviceServer.on('error', (err) => {
  console.error('Terminal service server error:', err)
})
