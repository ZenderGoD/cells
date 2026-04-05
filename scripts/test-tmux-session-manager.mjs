import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import test from 'node:test'

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

class DaemonClient {
  constructor(socketPath) {
    this.socketPath = socketPath
    this.socket = null
    this.lineBuffer = ''
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
        this.lineBuffer += chunk.toString()
        let newlineIdx
        while ((newlineIdx = this.lineBuffer.indexOf('\n')) !== -1) {
          const line = this.lineBuffer.slice(0, newlineIdx)
          this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1)
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
      })
    })
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

test('tmux daemon preserves a session across detach and reattach', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cells-tmux-daemon-test-'))
  const socketPath = path.join(stateDir, 'pty-daemon.sock')
  const daemon = spawn(process.execPath, ['dist-electron/pty-daemon.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CELLS_HOME_DIR: stateDir,
      CELLS_APP_VERSION: 'tmux-smoke-test',
      CELLS_TERMINAL_BACKEND: 'tmux',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  daemon.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  const client = new DaemonClient(socketPath)
  const termId = `smoke-${Date.now()}`
  const markerOne = `CELLS_TMUX_ONE_${Date.now()}`
  const markerTwo = `CELLS_TMUX_TWO_${Date.now()}`
  const shellMarker = `CELLS_SHELL_${Date.now()}`
  const termMarker = `CELLS_TERM_${Date.now()}`

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

    const version = await client.request('get-daemon-version')
    assert.equal(version.compatVersion, 8)
    assert.equal(version.backend, 'tmux')

    const firstAttach = await client.request('attach', {
      termId,
      cols: 80,
      rows: 24,
      cwd: stateDir,
    })
    assert.equal(firstAttach.backend, 'tmux')
    assert.equal(firstAttach.reattached, false)

    const tmuxOptions = execFileSync('tmux', ['-S', path.join(stateDir, 'tmux.sock'), 'show-options', '-g'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const tmuxConfig = await fs.readFile(path.join(stateDir, 'tmux.conf'), 'utf8')
    const configuredTerm =
      tmuxConfig.match(/^set-option -g default-terminal "([^"]+)"$/m)?.[1] ?? 'tmux-256color'
    assert.match(tmuxOptions, /^status off$/m)
    assert.match(tmuxOptions, /^mouse on$/m)
    assert.match(tmuxOptions, /^default-shell /m)
    assert.match(tmuxConfig, /^set-option -g focus-events on$/m)
    assert.match(tmuxConfig, /^set-option -g extended-keys on$/m)
    assert.ok(configuredTerm.length > 0)

    if (configuredTerm === 'cells-tmux-256color') {
      const compiledTerminfo = execFileSync(
        'infocmp',
        ['-x', '-A', path.join(stateDir, 'terminfo'), configuredTerm],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      assert.match(compiledTerminfo, /\bRGB\b/)
      assert.match(compiledTerminfo, /\bTc\b/)
      assert.match(compiledTerminfo, /\bSetulc=/)
    }

    client.send('write', { termId, data: `printf '${shellMarker}:%s\\n' "$SHELL"\r` })
    await waitFor(() =>
      client.events.some(
        (event) =>
          event.type === 'data' &&
          event.termId === termId &&
          event.data.includes(`${shellMarker}:${process.env.SHELL ?? ''}`),
      ),
    )

    client.send('write', { termId, data: `printf '${termMarker}:%s\\n' "$TERM"\r` })
    await waitFor(() =>
      client.events.some(
        (event) =>
          event.type === 'data' &&
          event.termId === termId &&
          event.data.includes(`${termMarker}:${configuredTerm}`),
      ),
    )

    client.send('write', { termId, data: `printf '${markerOne}\\n'\r` })
    await waitFor(() =>
      client.events.some((event) => event.type === 'data' && event.termId === termId && event.data.includes(markerOne)),
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
    assert.equal(secondAttach.backend, 'tmux')
    assert.equal(secondAttach.reattached, true)

    client.send('write', { termId, data: `printf '${markerTwo}\\n'\r` })
    await waitFor(() =>
      client.events.some((event) => event.type === 'data' && event.termId === termId && event.data.includes(markerTwo)),
    )

    await client.request('kill', { termId })
    await waitFor(async () => {
      const sessions = await client.request('list')
      return !sessions.includes(termId)
    })

    await client.request('shutdown')
  } finally {
    client.close()
    if (!daemon.killed) {
      daemon.kill('SIGTERM')
    }
    await new Promise((resolve) => daemon.once('exit', resolve))
    await fs.rm(stateDir, { recursive: true, force: true })
  }

  assert.equal(stderr.trim(), '')
})
