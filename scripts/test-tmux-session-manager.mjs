import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
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

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
}

function getBundledTmuxBinary() {
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
  if (!platformDir) return null
  const candidate = path.join(process.cwd(), 'resources', 'vendor', 'tmux', platformDir, 'tmux')
  return fsSync.existsSync(candidate) ? candidate : null
}

function getExpectedUserShell() {
  const shell = process.env.SHELL?.trim()
  return shell || '/bin/sh'
}

function getExpectedXdgConfigHome(stateDir) {
  return path.join(stateDir, 'real-xdg-config')
}

function getExpectedXdgDataHome(stateDir) {
  return path.join(stateDir, 'real-xdg-data')
}

function encodeTmuxProjectSessionId(projectId) {
  return `cp_${Buffer.from(projectId, 'utf8').toString('base64url')}`
}

function encodeTmuxWindowName(termId) {
  return `cw_${Buffer.from(termId, 'utf8').toString('base64url')}`
}

function getTmuxPaneTarget(projectId, termId) {
  return `${encodeTmuxProjectSessionId(projectId)}:${encodeTmuxWindowName(termId)}.0`
}

function captureTmuxPane(tmuxBinary, socketPath, projectId, termId) {
  return execFileSync(
    tmuxBinary,
    [
      '-S',
      socketPath,
      'capture-pane',
      '-p',
      '-J',
      '-S',
      '-',
      '-t',
      getTmuxPaneTarget(projectId, termId),
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
}

function killTmuxServer(tmuxBinary, socketPath) {
  try {
    execFileSync(tmuxBinary, ['-S', socketPath, 'kill-server'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {}
}

async function removeDirWithRetry(dirPath, attempts = 5) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      await delay(100 * (attempt + 1))
    }
  }
  if (lastError) throw lastError
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

test('tmux daemon preserves a session across detach and reattach', async () => {
  const bundledTmux = getBundledTmuxBinary()
  assert.ok(bundledTmux, 'bundled tmux should be available after build')

  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cells-tmux-daemon-test-'))
  const socketPath = path.join(stateDir, 'pty-daemon.sock')
  const expectedXdgConfigHome = getExpectedXdgConfigHome(stateDir)
  const expectedXdgDataHome = getExpectedXdgDataHome(stateDir)
  const daemon = spawn(process.execPath, ['dist-electron/pty-daemon.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CELLS_TMUX_BINARY: bundledTmux,
      CELLS_REAL_XDG_CONFIG_HOME: expectedXdgConfigHome,
      CELLS_REAL_XDG_DATA_HOME: expectedXdgDataHome,
      XDG_CONFIG_HOME: path.join(stateDir, 'sandbox-xdg-config'),
      XDG_DATA_HOME: path.join(stateDir, 'sandbox-xdg-data'),
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
  const projectId = 'project-smoke'
  const markerOne = `CELLS_TMUX_ONE_${Date.now()}`
  const markerTwo = `CELLS_TMUX_TWO_${Date.now()}`
  const shellMarker = `CELLS_SHELL_${Date.now()}`
  const expectedShell = getExpectedUserShell()

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
    assert.equal(version.compatVersion, 10)
    assert.equal(version.backend, 'tmux')

    const firstAttach = await client.request('attach', {
      termId,
      cols: 80,
      rows: 24,
      cwd: stateDir,
      projectId,
    })
    assert.equal(firstAttach.backend, 'tmux')
    assert.equal(firstAttach.reattached, false)

    const tmuxOptions = execFileSync(
      bundledTmux,
      ['-S', path.join(stateDir, 'tmux.sock'), 'show-options', '-g'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const tmuxConfig = await fs.readFile(path.join(stateDir, 'tmux.conf'), 'utf8')
    const configuredTerm =
      tmuxConfig.match(/^set-option -g default-terminal "([^"]+)"$/m)?.[1] ?? 'tmux-256color'
    assert.match(tmuxOptions, /^status off$/m)
    assert.match(tmuxOptions, /^visual-activity off$/m)
    assert.match(tmuxOptions, /^visual-bell off$/m)
    assert.match(tmuxOptions, /^mouse on$/m)
    assert.match(tmuxOptions, /^default-shell /m)
    assert.match(
      tmuxConfig,
      new RegExp(`^set-option -g default-shell "${escapeRegex(expectedShell)}"$`, 'm'),
    )
    assert.match(
      tmuxConfig,
      new RegExp(`^set-option -g default-command "${escapeRegex(expectedShell)} -l"$`, 'm'),
    )
    assert.match(tmuxConfig, /^set-option -g allow-passthrough on$/m)
    assert.match(tmuxConfig, /^set-option -sg display-time 0$/m)
    assert.match(tmuxConfig, /^set-option -sg message-style "bg=default,fg=default"$/m)
    assert.match(tmuxConfig, /^set-option -sg message-command-style "bg=default,fg=default"$/m)
    assert.match(tmuxConfig, /^set-option -sg bell-action none$/m)
    assert.match(tmuxConfig, /^set-option -g focus-events on$/m)
    assert.match(tmuxConfig, /^set-option -g extended-keys on$/m)
    assert.match(tmuxConfig, /^set-option -g monitor-activity off$/m)
    assert.match(tmuxConfig, /^set-option -g allow-rename off$/m)
    assert.match(tmuxConfig, /^set-window-option -g automatic-rename off$/m)
    assert.match(tmuxConfig, /^set-window-option -g pane-border-status off$/m)
    assert.match(tmuxConfig, /^set-window-option -g remain-on-exit off$/m)
    assert.match(
      tmuxConfig,
      new RegExp(
        `^set-option -ga terminal-features ",${escapeRegex(configuredTerm)}:RGB,clipboard,ccolour,cstyle,extkeys,focus,hyperlinks,osc7,title,usstyle,strikethrough,overline,sync"$`,
        'm',
      ),
    )
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

    execFileSync(
      bundledTmux,
      [
        '-S',
        path.join(stateDir, 'tmux.sock'),
        'send-keys',
        '-N',
        '80',
        '-t',
        getTmuxPaneTarget(projectId, termId),
        'Enter',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const preScrollStatus = await waitFor(() => {
      const output = execFileSync(
        bundledTmux,
        [
          '-S',
          path.join(stateDir, 'tmux.sock'),
          'display-message',
          '-p',
          '-t',
          getTmuxPaneTarget(projectId, termId),
          '#{history_size}',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      const historySize = Number.parseInt(output.trim(), 10) || 0
      return historySize > 0 ? { backend: 'tmux', historySize } : null
    })
    assert.equal(preScrollStatus.backend, 'tmux')
    assert.ok(preScrollStatus.historySize > 0)

    await client.request('handle-wheel', { termId, direction: 'up', steps: 3, sequence: '' })
    const scrollStatus = await waitFor(async () => {
      const status = await client.request('get-scroll-status', { termId })
      return status?.backend === 'tmux' && status.paneInMode && status.scrollPosition > 0
        ? status
        : null
    })
    assert.equal(scrollStatus.backend, 'tmux')
    assert.equal(scrollStatus.paneInMode, true)
    assert.ok(scrollStatus.scrollPosition > 0)
    execFileSync(
      bundledTmux,
      [
        '-S',
        path.join(stateDir, 'tmux.sock'),
        'send-keys',
        '-X',
        '-t',
        getTmuxPaneTarget(projectId, termId),
        'cancel',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    execFileSync(
      bundledTmux,
      [
        '-S',
        path.join(stateDir, 'tmux.sock'),
        'send-keys',
        '-t',
        getTmuxPaneTarget(projectId, termId),
        `printf '${shellMarker}:%s\\n' "$SHELL"`,
        'Enter',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    await waitFor(() =>
      captureTmuxPane(bundledTmux, path.join(stateDir, 'tmux.sock'), projectId, termId).includes(
        `${shellMarker}:${expectedShell}`,
      ),
    )

    const tmuxXdgConfig = execFileSync(
      bundledTmux,
      ['-S', path.join(stateDir, 'tmux.sock'), 'show-environment', '-g', 'XDG_CONFIG_HOME'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim()
    assert.equal(tmuxXdgConfig, `XDG_CONFIG_HOME=${expectedXdgConfigHome}`)

    const tmuxXdgData = execFileSync(
      bundledTmux,
      ['-S', path.join(stateDir, 'tmux.sock'), 'show-environment', '-g', 'XDG_DATA_HOME'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim()
    assert.equal(tmuxXdgData, `XDG_DATA_HOME=${expectedXdgDataHome}`)

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
      projectId,
    })
    assert.equal(secondAttach.backend, 'tmux')
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
    killTmuxServer(bundledTmux, path.join(stateDir, 'tmux.sock'))
    await stopChild(daemon)
    await removeDirWithRetry(stateDir)
  }

  assert.equal(stderr.trim(), '')
})

test('tmux daemon keeps multiple terminals under one private socket', async () => {
  const bundledTmux = getBundledTmuxBinary()
  assert.ok(bundledTmux, 'bundled tmux should be available after build')

  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cells-tmux-daemon-multi-test-'))
  const socketPath = path.join(stateDir, 'pty-daemon.sock')
  const daemon = spawn(process.execPath, ['dist-electron/pty-daemon.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CELLS_TMUX_BINARY: bundledTmux,
      CELLS_HOME_DIR: stateDir,
      CELLS_APP_VERSION: 'tmux-multi-session-test',
      CELLS_TERMINAL_BACKEND: 'tmux',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  daemon.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  const client = new DaemonClient(socketPath)
  const termA = `multi-a-${Date.now()}`
  const termB = `multi-b-${Date.now()}`
  const termC = `multi-c-${Date.now()}`
  const projectA = 'project-a'
  const projectB = 'project-b'

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

    await client.request('attach', {
      termId: termA,
      cols: 80,
      rows: 24,
      cwd: stateDir,
      projectId: projectA,
    })
    await client.request('attach', {
      termId: termB,
      cols: 100,
      rows: 30,
      cwd: stateDir,
      projectId: projectA,
    })
    await client.request('attach', {
      termId: termC,
      cols: 90,
      rows: 28,
      cwd: stateDir,
      projectId: projectB,
    })

    const listed = await waitFor(async () => {
      const current = await client.request('list')
      return current.includes(termA) && current.includes(termB) && current.includes(termC)
        ? current
        : null
    })
    assert.ok(listed.includes(termA))
    assert.ok(listed.includes(termB))
    assert.ok(listed.includes(termC))

    const sessions = execFileSync(
      bundledTmux,
      ['-S', path.join(stateDir, 'tmux.sock'), 'list-sessions', '-F', '#{session_name}'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    const projectSessions = sessions.filter((session) => session.startsWith('cp_'))
    const viewerSessions = sessions.filter((session) => session.startsWith('cv_'))
    assert.deepEqual(
      projectSessions.sort(),
      [encodeTmuxProjectSessionId(projectA), encodeTmuxProjectSessionId(projectB)].sort(),
    )
    assert.equal(viewerSessions.length, 3)

    const projectAWindows = execFileSync(
      bundledTmux,
      [
        '-S',
        path.join(stateDir, 'tmux.sock'),
        'list-windows',
        '-t',
        encodeTmuxProjectSessionId(projectA),
        '-F',
        '#{window_name}',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    assert.deepEqual(
      projectAWindows.sort(),
      [encodeTmuxWindowName(termA), encodeTmuxWindowName(termB)].sort(),
    )

    await client.request('shutdown')
  } finally {
    client.close()
    killTmuxServer(bundledTmux, path.join(stateDir, 'tmux.sock'))
    await stopChild(daemon)
    await removeDirWithRetry(stateDir)
  }

  assert.equal(stderr.trim(), '')
})
