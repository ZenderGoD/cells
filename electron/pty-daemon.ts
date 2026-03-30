/**
 * PTY Daemon — standalone process that owns terminal PTYs.
 *
 * Runs via ELECTRON_RUN_AS_NODE=1 so it can use the same node-pty native addon.
 * Communicates with the Electron app over a Unix domain socket using
 * newline-delimited JSON.
 *
 * BACKWARD COMPATIBILITY CONTRACT:
 *
 * This daemon is designed to run independently of the Electron app version.
 * It must survive app updates without killing sessions. To maintain this:
 *
 * 1. The wire protocol is newline-delimited JSON — inherently extensible.
 *    New message types can be added without breaking old clients. Old clients
 *    simply never send the new types, and the daemon ignores unknown types.
 *
 * 2. Response shape: { type: "response", id, ok, data? } is fixed. New fields
 *    may be added to `data` but existing fields must never change meaning.
 *
 * 3. Push events (data, exit) are stable — they only carry termId + payload.
 *    New push event types may be added; old clients ignore unknown types.
 *
 * 4. The daemon should NEVER need restarting for protocol changes. If a new
 *    feature needs daemon support, add it as a new message type that gracefully
 *    degrades when the daemon doesn't understand it (client gets no response →
 *    timeout → fallback).
 *
 * 5. The only reason to restart the daemon is to pick up node-pty native addon
 *    changes (rare, tied to Electron major version bumps) or critical bug fixes.
 *    Users can trigger this manually from Settings > About > Daemon > Restart.
 *
 * DAEMON_PROTOCOL_VERSION tracks the protocol for informational purposes only.
 * Clients should NOT refuse to connect based on this version — it exists so
 * the settings UI can show whether an update is available.
 *
 * Environment variables:
 *   CELLS_HOME_DIR   — directory for socket/pid/version files (default: ~/.cells)
 *   CELLS_APP_VERSION — written to version file on startup
 */

import net from 'net'
import fs from 'fs'
import path from 'path'
import * as pty from 'node-pty'
import {
  HOME_DIR,
  resolveShell,
  resolveCwd,
  cleanEnv,
  ensureSpawnHelperExecutable,
  resolveTerminalProcessInfo,
  resolveCodexProcessPid,
  resolveCodexThreadTitle,
  MAX_BUFFER,
} from './pty-shared'

// Protocol version — bumped only when the daemon wire format changes in a
// breaking way. Clients should treat this as informational, not a gate.
const DAEMON_PROTOCOL_VERSION = 1

// ---------- Paths ----------

const STATE_DIR = process.env.CELLS_HOME_DIR || path.join(HOME_DIR, '.cells')
const SOCKET_PATH = path.join(STATE_DIR, 'pty-daemon.sock')
const PID_FILE = path.join(STATE_DIR, 'pty-daemon.pid')
const VERSION_FILE = path.join(STATE_DIR, 'pty-daemon.version')

// ---------- State ----------

const ptys = new Map<string, pty.IPty>()
const buffers = new Map<string, string>()
const histories = new Map<string, { chunks: string[]; length: number }>()
const subscribers = new Map<string, net.Socket>() // termId → subscribed client socket
const metadata = new Map<string, { shellPid: number }>()

// Track which terminals each client socket owns subscriptions for
const clientSubscriptions = new Map<net.Socket, Set<string>>()

// ---------- Buffer management ----------

const MAX_HISTORY = 4 * 1024 * 1024

function appendBuffer(termId: string, data: string) {
  const existing = buffers.get(termId) ?? ''
  const combined = existing + data
  buffers.set(termId, combined.length > MAX_BUFFER ? combined.slice(-MAX_BUFFER) : combined)
}

function appendHistory(termId: string, data: string) {
  if (!data) return

  let history = histories.get(termId)
  if (!history) {
    history = { chunks: [], length: 0 }
    histories.set(termId, history)
  }

  history.chunks.push(data)
  history.length += data.length

  while (history.length > MAX_HISTORY && history.chunks.length > 0) {
    const excess = history.length - MAX_HISTORY
    const first = history.chunks[0]
    if (first.length <= excess) {
      history.chunks.shift()
      history.length -= first.length
      continue
    }

    history.chunks[0] = first.slice(excess)
    history.length -= excess
    break
  }
}

function readHistory(termId: string) {
  const history = histories.get(termId)
  return history ? history.chunks.join('') : ''
}

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
  // If PTY already exists, return it (reattach case)
  const existing = ptys.get(termId)
  if (existing) {
    try {
      existing.resize(cols, rows)
    } catch {}
    return { reattached: true, shellPid: metadata.get(termId)?.shellPid ?? existing.pid }
  }

  ensureSpawnHelperExecutable()

  const p = pty.spawn(resolveShell(), ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: resolveCwd(cwd),
    env: cleanEnv(),
  })

  ptys.set(termId, p)
  buffers.set(termId, '')
  metadata.set(termId, { shellPid: p.pid })

  p.onData((data) => {
    if (ptys.get(termId) !== p) return
    appendHistory(termId, data)
    appendBuffer(termId, data)
    const sub = subscribers.get(termId)
    if (sub) {
      sendJson(sub, { type: 'data', termId, data })
    }
  })

  p.onExit(() => {
    if (ptys.get(termId) !== p) return
    ptys.delete(termId)
    buffers.delete(termId)
    metadata.delete(termId)
    const sub = subscribers.get(termId)
    if (sub) {
      sendJson(sub, { type: 'exit', termId })
      subscribers.delete(termId)
      clientSubscriptions.get(sub)?.delete(termId)
    }
  })

  return { reattached: false, shellPid: p.pid }
}

function killPty(termId: string) {
  const p = ptys.get(termId)
  if (p) {
    try {
      p.kill()
    } catch {}
    ptys.delete(termId)
  }
  buffers.delete(termId)
  histories.delete(termId)
  metadata.delete(termId)
  subscribers.delete(termId)
}

// ---------- Request handling ----------

function handleMessage(socket: net.Socket, msg: any) {
  const { type, id } = msg

  switch (type) {
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
      if (!ptys.has(termId)) {
        sendError(socket, id, `No PTY for terminal ${termId}`)
        break
      }
      // Unsubscribe previous subscriber if any
      const prevSub = subscribers.get(termId)
      if (prevSub) {
        clientSubscriptions.get(prevSub)?.delete(termId)
      }
      subscribers.set(termId, socket)
      if (!clientSubscriptions.has(socket)) clientSubscriptions.set(socket, new Set())
      clientSubscriptions.get(socket)!.add(termId)
      // Return buffer and clear
      const buffer = buffers.get(termId) ?? ''
      buffers.set(termId, '')
      sendResponse(socket, id, true, { buffer })
      break
    }

    case 'unsubscribe': {
      // Fire-and-forget, no response
      const termId = msg.termId
      if (subscribers.get(termId) === socket) {
        subscribers.delete(termId)
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
      const p = ptys.get(msg.termId)
      if (p) {
        try {
          p.write(msg.data)
        } catch {}
      }
      break
    }

    case 'resize': {
      // Fire-and-forget
      const p = ptys.get(msg.termId)
      if (p) {
        try {
          p.resize(msg.cols, msg.rows)
        } catch {}
      }
      break
    }

    case 'get-process-info': {
      const meta = metadata.get(msg.termId)
      const p = ptys.get(msg.termId)
      if (!meta && !p) {
        sendResponse(socket, id, true, null)
        break
      }
      const shellPid = meta?.shellPid ?? p?.pid ?? 0
      const info = resolveTerminalProcessInfo(shellPid, p?.process)
      sendResponse(socket, id, true, info)
      break
    }

    case 'get-codex-title': {
      const meta = metadata.get(msg.termId)
      const p = ptys.get(msg.termId)
      const shellPid = meta?.shellPid ?? p?.pid ?? 0
      const codexPid = shellPid ? resolveCodexProcessPid(shellPid) : null
      const title = codexPid ? resolveCodexThreadTitle(codexPid) : null
      sendResponse(socket, id, true, title)
      break
    }

    case 'get-shell-pid': {
      const meta = metadata.get(msg.termId)
      const p = ptys.get(msg.termId)
      sendResponse(socket, id, true, meta?.shellPid ?? p?.pid ?? null)
      break
    }

    case 'get-buffer': {
      const buffer = buffers.get(msg.termId) ?? ''
      sendResponse(socket, id, true, { buffer })
      break
    }

    case 'get-history': {
      sendResponse(socket, id, true, { buffer: readHistory(msg.termId) })
      break
    }

    case 'list': {
      sendResponse(socket, id, true, [...ptys.keys()])
      break
    }

    case 'ping': {
      sendResponse(socket, id, true, { ok: true })
      break
    }

    case 'get-daemon-version': {
      sendResponse(socket, id, true, {
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        appVersion: process.env.CELLS_APP_VERSION ?? null,
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
  // Snapshot keys first — killPty mutates the map
  for (const termId of [...ptys.keys()]) {
    killPty(termId)
  }
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
