import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const BINARY_DATA_MARKER = 0x02

function delay(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 8000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(stepMs)
  }
  throw new Error('Timed out waiting for condition')
}

async function stopChild(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (!child.killed) child.kill(signal)
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve) => child.once('exit', resolve))
}

async function waitForDaemonClient(client, socketPath, timeoutMs = 8000) {
  await waitFor(async () => {
    try {
      await fs.access(socketPath)
      await client.connect()
      return true
    } catch {
      client.close()
      return false
    }
  }, timeoutMs)
}

class DaemonClient {
  constructor(socketPath) {
    this.socketPath = socketPath
    this.socket = null
    this.recvBuf = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map()
    this.events = []
  }

  async connect() {
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath, () => {
        this.socket = socket
        resolve()
      })
      socket.on('error', reject)
      socket.on('data', (chunk) => {
        this.recvBuf = this.recvBuf.length === 0 ? chunk : Buffer.concat([this.recvBuf, chunk])
        this.drainRecvBuffer()
      })
    })
  }

  drainRecvBuffer() {
    while (this.recvBuf.length > 0) {
      if (this.recvBuf[0] === BINARY_DATA_MARKER) {
        const minHeader = 1 + 2
        if (this.recvBuf.length < minHeader) return
        const termIdLen = this.recvBuf.readUInt16BE(1)
        const fullHeader = minHeader + termIdLen + 4
        if (this.recvBuf.length < fullHeader) return
        const dataLen = this.recvBuf.readUInt32BE(minHeader + termIdLen)
        const totalLen = fullHeader + dataLen
        if (this.recvBuf.length < totalLen) return

        const termId = this.recvBuf.toString('utf8', minHeader, minHeader + termIdLen)
        const data = this.recvBuf.toString('utf8', fullHeader, totalLen)
        this.recvBuf = this.recvBuf.subarray(totalLen)
        this.events.push({ type: 'data', termId, data })
        continue
      }

      const newlineIdx = this.recvBuf.indexOf(0x0a)
      if (newlineIdx === -1) return
      const line = this.recvBuf.toString('utf8', 0, newlineIdx)
      this.recvBuf = this.recvBuf.subarray(newlineIdx + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.type === 'response') {
        const pending = this.pending.get(msg.id)
        if (!pending) continue
        this.pending.delete(msg.id)
        if (msg.ok) pending.resolve(msg.data)
        else pending.reject(new Error(msg.error || 'Daemon request failed'))
      } else {
        this.events.push(msg)
      }
    }
  }

  request(type, fields = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.write(JSON.stringify({ type, id, ...fields }) + '\n')
    })
  }

  send(type, fields = {}) {
    this.socket.write(JSON.stringify({ type, ...fields }) + '\n')
  }

  close() {
    this.socket?.destroy()
    this.socket = null
  }
}

function hasBundledZellij() {
  const platformDir =
    process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'darwin-arm64'
        : 'darwin-x64'
      : process.platform === 'linux'
        ? process.arch === 'arm64'
          ? 'linux-arm64'
          : 'linux-x64'
        : null
  if (!platformDir) return false
  return fsSync.existsSync(
    path.join(process.cwd(), 'resources', 'vendor', 'zellij', platformDir, 'zellij'),
  )
}

test('zellij daemon preserves a session across detach and reattach', async (t) => {
  const hasZellij = hasBundledZellij()
  if (!hasZellij) {
    t.skip('bundled zellij is not available on this machine')
    return
  }

  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cells-zellij-daemon-test-'))
  const socketPath = path.join(stateDir, 'pty-daemon.sock')
  const daemon = spawn(process.execPath, ['dist-electron/pty-daemon.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CELLS_HOME_DIR: stateDir,
      CELLS_APP_VERSION: 'zellij-smoke-test',
      CELLS_TERMINAL_BACKEND: 'zellij',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  daemon.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  const client = new DaemonClient(socketPath)
  const termId = `smoke-${Date.now()}`
  const markerOne = `CELLS_ZELLIJ_ONE_${Date.now()}`
  const markerTwo = `CELLS_ZELLIJ_TWO_${Date.now()}`

  try {
    await waitForDaemonClient(client, socketPath)

    const version = await client.request('get-daemon-version')
    assert.equal(version.compatVersion, 10)
    assert.equal(version.backend, 'zellij')

    const firstAttach = await client.request('attach', {
      termId,
      cols: 80,
      rows: 24,
      cwd: stateDir,
    })
    assert.equal(firstAttach.backend, 'zellij')
    assert.equal(firstAttach.reattached, false)

    client.send('write', { termId, data: `printf '${markerOne}\\n'\r` })
    await waitFor(() =>
      client.events.some(
        (event) =>
          event.type === 'data' && event.termId === termId && event.data.includes(markerOne),
      ),
    )

    client.send('unsubscribe', { termId })
    await delay(200)

    const listed = await client.request('list')
    assert.ok(listed.includes(termId))

    const secondAttach = await client.request('attach', {
      termId,
      cols: 80,
      rows: 24,
      cwd: stateDir,
    })
    assert.equal(secondAttach.backend, 'zellij')
    assert.equal(secondAttach.reattached, true)

    client.send('write', { termId, data: `printf '${markerTwo}\\n'\r` })
    await waitFor(() =>
      client.events.some(
        (event) =>
          event.type === 'data' && event.termId === termId && event.data.includes(markerTwo),
      ),
    )

    await client.request('kill', { termId })
    await waitFor(async () => {
      const sessions = await client.request('list')
      return !sessions.includes(termId)
    })

    await client.request('shutdown')
  } finally {
    client.close()
    await stopChild(daemon)
    await fs.rm(stateDir, { recursive: true, force: true })
  }

  assert.equal(stderr.trim(), '')
})

test('zellij daemon reattaches after daemon restart using persisted session mapping', async (t) => {
  const hasZellij = hasBundledZellij()
  if (!hasZellij) {
    t.skip('bundled zellij is not available on this machine')
    return
  }

  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cells-zellij-daemon-restart-test-'))
  const socketPath = path.join(stateDir, 'pty-daemon.sock')
  const termId = `restart-${Date.now()}`
  const marker = `CELLS_ZELLIJ_RESTART_${Date.now()}`

  const spawnDaemon = () =>
    spawn(process.execPath, ['dist-electron/pty-daemon.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CELLS_HOME_DIR: stateDir,
        CELLS_APP_VERSION: 'zellij-restart-test',
        CELLS_TERMINAL_BACKEND: 'zellij',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  let daemon = spawnDaemon()
  let stderr = ''
  daemon.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  const client = new DaemonClient(socketPath)

  try {
    await waitFor(async () => {
      try {
        await fs.access(socketPath)
        return true
      } catch {
        return false
      }
    }, 8000)
    await client.connect()

    const firstAttach = await client.request('attach', {
      termId,
      cols: 80,
      rows: 24,
      cwd: stateDir,
    })
    assert.equal(firstAttach.backend, 'zellij')
    assert.equal(firstAttach.reattached, false)

    client.send('write', { termId, data: `printf '${marker}\\n'\r` })
    await waitFor(() =>
      client.events.some(
        (event) => event.type === 'data' && event.termId === termId && event.data.includes(marker),
      ),
    )

    client.send('unsubscribe', { termId })
    await delay(200)
    client.close()

    daemon.kill('SIGKILL')
    await new Promise((resolve) => daemon.once('exit', resolve))

    daemon = spawnDaemon()
    daemon.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    const restartedClient = new DaemonClient(socketPath)
    await waitForDaemonClient(restartedClient, socketPath)

    const secondAttach = await restartedClient.request('attach', {
      termId,
      cols: 80,
      rows: 24,
      cwd: stateDir,
    })
    assert.equal(secondAttach.backend, 'zellij')
    assert.equal(secondAttach.reattached, true)

    await restartedClient.request('kill', { termId })
    await waitFor(async () => {
      const sessions = await restartedClient.request('list')
      return !sessions.includes(termId)
    })

    await restartedClient.request('shutdown')
    restartedClient.close()
  } finally {
    client.close()
    await stopChild(daemon)
    await fs.rm(stateDir, { recursive: true, force: true })
  }

  assert.equal(stderr.trim(), '')
})
