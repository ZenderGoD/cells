/**
 * Daemon lifecycle management.
 *
 * Cells treats the PTY daemon as an app-internal component with an explicit
 * compatibility contract. Compatible app builds may reuse the existing daemon;
 * incompatible ones restart it and sacrifice daemon-owned sessions.
 */

import net from 'net'
import fs from 'fs'
import path from 'path'
import { spawn as spawnProcess } from 'child_process'
import { getDaemonRestartReason, type PtyDaemonVersionInfo } from './pty-daemon-contract'
import type { TerminalSessionBackend } from '../src/types'

const CONNECT_TIMEOUT = 500
const REQUEST_TIMEOUT = 1000
const POLL_INTERVAL = 100
const POLL_MAX_WAIT = 3000

/**
 * Ensure the PTY daemon is running and compatible with the current app build.
 * Returns true if daemon is ready, false if unavailable (triggers fallback).
 */
export async function ensureDaemon(
  stateDir: string,
  appVersion: string,
  execPath: string,
  daemonScript: string,
  backend: TerminalSessionBackend,
): Promise<boolean> {
  const socketPath = path.join(stateDir, 'pty-daemon.sock')
  const pidFile = path.join(stateDir, 'pty-daemon.pid')
  const versionFile = path.join(stateDir, 'pty-daemon.version')

  // 1. Try connecting to existing daemon.
  const existing = await tryConnect(socketPath)
  if (existing) {
    existing.destroy()

    const runningVersion = await requestDaemonVersion(socketPath)
    const restartReason = getDaemonRestartReason(runningVersion, process.versions.modules, backend)
    if (restartReason === null) {
      return true
    }

    console.warn(`PTY daemon incompatible (${restartReason}); restarting daemon`)

    const stopped = await stopExistingDaemon(socketPath, pidFile, versionFile)
    if (!stopped) {
      console.warn('Failed to stop existing PTY daemon cleanly')
      return false
    }
  }

  // No daemon running — clean stale files
  cleanStaleFiles(socketPath, pidFile, versionFile)

  // 2. Spawn new daemon
  try {
    fs.mkdirSync(stateDir, { recursive: true })

    if (!fs.existsSync(daemonScript)) {
      console.warn(`PTY daemon script not found at ${daemonScript}`)
      return false
    }

    const logFile = path.join(stateDir, 'pty-daemon.log')
    const logFd = fs.openSync(logFile, 'a')

    console.log(`Spawning PTY daemon: ${execPath} ${daemonScript}`)
    const child = spawnProcess(execPath, [daemonScript], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CELLS_APP_VERSION: appVersion,
        CELLS_HOME_DIR: stateDir,
        CELLS_TERMINAL_BACKEND: backend,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    })
    child.unref()
    child.on('error', (err) => console.warn('Daemon child error:', err))
    fs.closeSync(logFd)
    console.log(`PTY daemon spawned with PID ${child.pid}`)
  } catch (err) {
    console.warn('Failed to spawn PTY daemon:', err)
    return false
  }

  // 3. Poll for daemon readiness
  const deadline = Date.now() + POLL_MAX_WAIT
  while (Date.now() < deadline) {
    const conn = await tryConnect(socketPath)
    if (conn) {
      conn.destroy()
      console.log('PTY daemon is ready')
      return true
    }
    await sleep(POLL_INTERVAL)
  }

  console.warn('PTY daemon did not become ready in time')
  return false
}

function tryConnect(socketPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(null)
    }, CONNECT_TIMEOUT)

    const socket = net.createConnection(socketPath, () => {
      clearTimeout(timer)
      resolve(socket)
    })

    socket.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

function cleanStaleFiles(socketPath: string, pidFile: string, versionFile: string) {
  for (const f of [socketPath, pidFile, versionFile]) {
    try {
      fs.unlinkSync(f)
    } catch {}
  }
}

function readFileTrimmed(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim() || null
  } catch {
    return null
  }
}

function requestDaemonVersion(socketPath: string): Promise<PtyDaemonVersionInfo | null> {
  return new Promise((resolve) => {
    let settled = false
    let lineBuffer = ''

    const finish = (value: PtyDaemonVersionInfo | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }

    const timer = setTimeout(() => finish(null), REQUEST_TIMEOUT)
    const socket = net.createConnection(socketPath, () => {
      socket.write(JSON.stringify({ id: 1, type: 'get-daemon-version' }) + '\n')
    })

    socket.on('data', (chunk) => {
      lineBuffer += chunk.toString()
      let newlineIdx: number
      while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIdx)
        lineBuffer = lineBuffer.slice(newlineIdx + 1)
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'response' && msg.id === 1 && msg.ok) {
            finish(msg.data as PtyDaemonVersionInfo)
            return
          }
        } catch {}
      }
    })

    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
  })
}

async function stopExistingDaemon(
  socketPath: string,
  pidFile: string,
  versionFile: string,
): Promise<boolean> {
  const pid = Number.parseInt(readFileTrimmed(pidFile) ?? '', 10)
  if (!Number.isNaN(pid) && pid > 0) {
    if (!signalProcess(pid, 'SIGTERM')) {
      cleanStaleFiles(socketPath, pidFile, versionFile)
      return true
    }

    if (await waitForDaemonExit(socketPath)) {
      cleanStaleFiles(socketPath, pidFile, versionFile)
      return true
    }

    signalProcess(pid, 'SIGKILL')
    if (await waitForDaemonExit(socketPath)) {
      cleanStaleFiles(socketPath, pidFile, versionFile)
      return true
    }
  }

  cleanStaleFiles(socketPath, pidFile, versionFile)
  const conn = await tryConnect(socketPath)
  if (conn) {
    conn.destroy()
    return false
  }
  return true
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== 'ESRCH'
  }
}

async function waitForDaemonExit(socketPath: string): Promise<boolean> {
  const deadline = Date.now() + POLL_MAX_WAIT
  while (Date.now() < deadline) {
    const conn = await tryConnect(socketPath)
    if (!conn) {
      return true
    }
    conn.destroy()
    await sleep(POLL_INTERVAL)
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
