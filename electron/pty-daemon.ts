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
import type { TerminalSessionBackend } from '../src/types'

// ---------- Paths ----------

const STATE_DIR = process.env.CELLS_HOME_DIR || path.join(HOME_DIR, '.cells')
const SOCKET_PATH = path.join(STATE_DIR, 'pty-daemon.sock')
const PID_FILE = path.join(STATE_DIR, 'pty-daemon.pid')
const VERSION_FILE = path.join(STATE_DIR, 'pty-daemon.version')
const BACKEND = (
  process.env.CELLS_TERMINAL_BACKEND === 'tmux' ? 'tmux' : 'zellij'
) as TerminalSessionBackend

// ---------- State ----------

const subscribers = new Map<string, net.Socket>() // termId → subscribed client socket

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

const sessionManager = createTerminalSessionManager(BACKEND, STATE_DIR, {
  onData(termId, data) {
    const sub = subscribers.get(termId)
    if (sub) {
      sendJson(sub, { type: 'data', termId, data })
    }
  },
  onExit(termId) {
    const sub = subscribers.get(termId)
    if (sub) {
      sendJson(sub, { type: 'exit', termId })
      subscribers.delete(termId)
      clientSubscriptions.get(sub)?.delete(termId)
    }
  },
})

// ---------- Send helpers ----------

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

// ---------- PTY management ----------

function spawnPty(
  termId: string,
  cols: number,
  rows: number,
  cwd?: string,
): { reattached: boolean; shellPid: number } {
  return sessionManager.spawn(termId, cols, rows, cwd)
}

function attachPty(
  termId: string,
  cols: number,
  rows: number,
  cwd: string | undefined,
): { reattached: boolean; shellPid: number; buffer: string } {
  return sessionManager.attach(termId, cols, rows, cwd)
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
        sendResponse(socket, id, true, attachPty(termId, msg.cols, msg.rows, msg.cwd))
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
        const result = spawnPty(msg.termId, msg.cols, msg.rows, msg.cwd)
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

// ---------- Lifecycle ----------

function cleanup() {
  try {
    fs.unlinkSync(SOCKET_PATH)
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
  // The daemon owns attach-side client PTYs, not the canonical backend
  // sessions themselves. On shutdown we detach clients and leave tmux/Zellij
  // sessions alive so a restarted daemon can reconnect cleanly.
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

const server = net.createServer(handleClient)

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
