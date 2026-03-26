/**
 * Daemon lifecycle management — starting, version checking, and health-checking
 * the PTY daemon process.
 */

import net from 'net'
import fs from 'fs'
import path from 'path'
import { spawn as spawnProcess } from 'child_process'

const CONNECT_TIMEOUT = 500
const POLL_INTERVAL = 100
const POLL_MAX_WAIT = 3000

/**
 * Ensure the PTY daemon is running and version-matched.
 * Returns true if daemon is ready, false if unavailable (triggers fallback).
 */
export async function ensureDaemon(
  stateDir: string,
  appVersion: string,
  execPath: string,
  daemonScript: string,
): Promise<boolean> {
  const socketPath = path.join(stateDir, 'pty-daemon.sock')
  const pidFile = path.join(stateDir, 'pty-daemon.pid')
  const versionFile = path.join(stateDir, 'pty-daemon.version')

  // 1. Try connecting to existing daemon — reuse it regardless of version
  // to preserve running sessions across app updates
  const existing = await tryConnect(socketPath)
  if (existing) {
    existing.destroy()
    try {
      fs.writeFileSync(versionFile, appVersion)
    } catch {}
    return true
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
