import fs from 'fs'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import * as pty from 'node-pty'
import {
  cleanEnv,
  ensureSpawnHelperExecutable,
  resolveCwd,
  resolveCodexProcessPid,
  resolveCodexThreadTitle,
  resolveShell,
  resolveTerminalProcessInfo,
} from './pty-shared'
import {
  ensurePrivateZellijConfig,
  getPrivateZellijConfigDir,
  getPrivateZellijConfigPath,
  getPrivateZellijDataDir,
  getPrivateZellijLayoutPath,
  getZellijSupportStatus,
  resolveZellijBinary,
  ZELLIJ_MIN_VERSION,
} from './zellij-shared'
import type { TerminalProcessInfo } from '../src/types'
import type {
  TerminalAttachResult,
  TerminalScrollStatus,
  TerminalSessionManager,
} from './terminal-session-manager'

function buildSessionPrefix(stateDir: string): string {
  return `cz${crypto.createHash('sha1').update(stateDir).digest('hex').slice(0, 5)}`
}

function buildSessionName(prefix: string, termId: string, salt = ''): string {
  // Zellij 0.44.0 can hang on `attach --create-background` with some longer
  // or more complex session names. Keep Cells session ids short, lowercase,
  // and deterministic.
  const digest = crypto.createHash('sha1').update(`${termId}:${salt}`).digest('hex').slice(0, 18)
  return `${prefix}${digest}`
}

function isSafeSessionName(prefix: string, sessionName: string) {
  return new RegExp(`^${prefix}[0-9a-f]{18}$`).test(sessionName)
}

function basenameCommand(command: string) {
  return command.trim().split('/').pop() ?? command.trim()
}

function isShellCommand(command: string) {
  const normalized = basenameCommand(command).toLowerCase()
  return ['sh', 'bash', 'zsh', 'fish', 'login'].includes(normalized)
}

function isZellijCommand(command: string | null | undefined) {
  if (!command) return false
  return basenameCommand(command).toLowerCase() === 'zellij'
}

type ZellijPaneInfo = {
  id: string | null
  pid: number | null
  command: string | null
  cwd: string | null
  focused: boolean
  isPlugin: boolean
}

export interface ZellijSessionManagerHooks {
  onData?: (termId: string, data: string) => void
  onExit?: (termId: string) => void
}

type AttachedClient = {
  pty: pty.IPty
  ignoreExit: boolean
}

type PendingWheelScroll = {
  delta: number
  timer: ReturnType<typeof setTimeout> | null
}

export class ZellijSessionManager implements TerminalSessionManager {
  private readonly zellijBinary = resolveZellijBinary()
  private readonly configDir: string
  private readonly configPath: string
  private readonly layoutPath: string
  private readonly dataDir: string
  private readonly sessionPrefix: string
  private readonly sessionMapPath: string
  private readonly attachedClients = new Map<string, AttachedClient>()
  private readonly knownSessions = new Set<string>()
  private readonly sessionNames = new Map<string, string>()
  private readonly pendingWheelScrolls = new Map<string, PendingWheelScroll>()
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly stateDir: string,
    private readonly hooks: ZellijSessionManagerHooks = {},
  ) {
    // Cells uses Zellij as a hidden single-pane session owner:
    // - one Zellij session per terminal node
    // - a fresh Zellij client PTY per renderer attach
    // - app-owned config/layout only, never user config
    // The browser terminal does not rebuild live state from replay when the
    // backend is Zellij; Zellij redraws the canonical pane state on attach.
    const support = getZellijSupportStatus()
    if (!support.ok) {
      const detail =
        support.reason === 'too-old'
          ? `zellij ${support.version ?? 'unknown'} found, need ${ZELLIJ_MIN_VERSION}+`
          : `zellij ${ZELLIJ_MIN_VERSION}+ is required`
      throw new Error(`zellij unavailable: ${detail}`)
    }

    fs.mkdirSync(stateDir, { recursive: true })
    ensurePrivateZellijConfig(stateDir, resolveShell())
    this.configDir = getPrivateZellijConfigDir(stateDir)
    this.configPath = getPrivateZellijConfigPath(stateDir)
    this.layoutPath = getPrivateZellijLayoutPath(stateDir)
    this.dataDir = getPrivateZellijDataDir(stateDir)
    this.sessionPrefix = buildSessionPrefix(stateDir)
    this.sessionMapPath = `${this.dataDir}/sessions.json`
    this.loadSessionMap()
    this.startDetachedSessionPoller()
  }

  spawn(
    termId: string,
    _cols: number,
    _rows: number,
    cwd?: string,
  ): { reattached: boolean; shellPid: number } {
    // Zellij sessions can outlive the in-process manager across app/daemon
    // restarts. `knownSessions` only reflects this manager instance, so attach
    // must consult the real session list before deciding to bootstrap a new
    // background session.
    const reattached = this.knownSessions.has(termId) || this.sessionExists(termId)
    if (!reattached) {
      this.execZellij(['attach', this.encodeSessionId(termId), '--create-background'], {
        cwd: resolveCwd(cwd),
      })
    }
    this.knownSessions.add(termId)
    return {
      reattached,
      shellPid: this.getShellPid(termId) ?? 0,
    }
  }

  attach(
    termId: string,
    cols: number,
    rows: number,
    cwd?: string,
    onAttached?: () => void,
  ): TerminalAttachResult {
    const result = this.spawn(termId, cols, rows, cwd)
    this.replaceAttachedClient(termId, cols, rows, cwd, false)
    onAttached?.()
    return {
      ...result,
      buffer: '',
      backend: 'zellij',
    }
  }

  subscribe(_termId: string, onSubscribed?: () => void): string {
    onSubscribed?.()
    return ''
  }

  unsubscribe(termId: string): void {
    this.disposeAttachedClient(termId)
  }

  kill(termId: string): void {
    this.disposeAttachedClient(termId)
    this.execZellij(['kill-session', this.getSessionName(termId)], { allowFailure: true })
    this.knownSessions.delete(termId)
    this.sessionNames.delete(termId)
    this.saveSessionMap()
  }

  write(termId: string, data: string): void {
    this.attachedClients.get(termId)?.pty.write(data)
  }

  resize(termId: string, cols: number, rows: number): void {
    try {
      this.attachedClients.get(termId)?.pty.resize(cols, rows)
    } catch {}
  }

  handleWheel(termId: string, direction: 'up' | 'down', steps: number, sequence: string): void {
    const count = Math.max(1, Math.min(8, Math.round(steps) || 1))
    const signedDelta = direction === 'up' ? count : -count
    const existing = this.pendingWheelScrolls.get(termId)
    if (existing) {
      existing.delta += signedDelta
      return
    }

    const pending: PendingWheelScroll = {
      delta: signedDelta,
      timer: setTimeout(() => {
        this.pendingWheelScrolls.delete(termId)
        this.flushWheelScroll(termId, pending.delta, sequence)
      }, 16),
    }
    if (pending.timer) pending.timer.unref?.()
    this.pendingWheelScrolls.set(termId, pending)
  }

  private flushWheelScroll(termId: string, delta: number, sequence: string) {
    if (!delta) return

    // Write mouse sequences to the PTY so TUIs with mouse reporting (e.g.
    // opencode) receive scroll events through the normal input channel.
    // Zellij forwards them to the active pane when mouse mode is enabled.
    if (sequence) {
      this.write(termId, sequence)
      return
    }

    const count = Math.max(1, Math.min(12, Math.abs(delta)))
    const fallback = delta > 0 ? '\x1b[A' : '\x1b[B'
    this.write(termId, fallback.repeat(count))
  }

  getScrollStatus(_termId: string): TerminalScrollStatus | null {
    return null
  }

  has(termId: string): boolean {
    return this.list().includes(termId)
  }

  list(): string[] {
    const output = this.execZellij(['list-sessions', '-s'], { allowFailure: true })
    if (!output) return []
    const liveSessionNames = new Set(
      output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    )
    const termIds: string[] = []
    for (const [termId, sessionName] of this.sessionNames.entries()) {
      if (liveSessionNames.has(sessionName)) {
        termIds.push(termId)
      }
    }
    return termIds
  }

  getShellPid(termId: string): number | null {
    const clientPid = this.attachedClients.get(termId)?.pty.pid ?? null
    return typeof clientPid === 'number' && clientPid > 0 ? clientPid : null
  }

  getProcessInfo(termId: string): TerminalProcessInfo | null {
    const pane = this.getPrimaryPane(termId)
    if (pane?.pid) {
      const resolved = resolveTerminalProcessInfo(pane.pid, pane.command)
      if (resolved) return resolved
    }

    const command = pane?.command?.trim()
    if (command) {
      const label = basenameCommand(command)
      return {
        pid: pane?.pid ?? this.getShellPid(termId) ?? 0,
        command,
        label,
        key: label.toLowerCase(),
        isShell: isShellCommand(command),
      }
    }

    const shellPid = this.getShellPid(termId)
    const shellCommand = this.attachedClients.get(termId)?.pty.process ?? null
    if (isZellijCommand(shellCommand)) {
      const fallbackShell = resolveShell()
      const label = basenameCommand(fallbackShell)
      return {
        pid: 0,
        command: fallbackShell,
        label,
        key: label.toLowerCase(),
        isShell: true,
      }
    }
    return shellPid ? resolveTerminalProcessInfo(shellPid, shellCommand) : null
  }

  getCodexTitle(termId: string): string | null {
    const pane = this.getPrimaryPane(termId)
    const shellPid = pane?.pid ?? this.getShellPid(termId)
    if (!shellPid) return null
    const codexPid = resolveCodexProcessPid(shellPid)
    return codexPid ? resolveCodexThreadTitle(codexPid) : null
  }

  getBuffer(_termId: string): string {
    return ''
  }

  getHistory(termId: string): string {
    return this.execZellijSession(termId, ['action', 'dump-screen', '--full'], true) ?? ''
  }

  clear(termId: string): void {
    this.knownSessions.delete(termId)
    this.sessionNames.delete(termId)
    this.saveSessionMap()
  }

  cleanup(): void {
    for (const termId of [...this.attachedClients.keys()]) {
      this.disposeAttachedClient(termId)
    }
    for (const pending of this.pendingWheelScrolls.values()) {
      if (pending.timer) clearTimeout(pending.timer)
    }
    this.pendingWheelScrolls.clear()
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private replaceAttachedClient(
    termId: string,
    cols: number,
    rows: number,
    cwd?: string,
    createBackground = false,
  ) {
    this.disposeAttachedClient(termId)
    ensureSpawnHelperExecutable()

    const attachArgs = ['attach', this.encodeSessionId(termId)]
    if (createBackground) attachArgs.push('--create-background')
    const client = pty.spawn(this.zellijBinary, this.zellijArgs(attachArgs), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: resolveCwd(cwd),
      env: this.buildZellijEnv(),
    })

    const entry: AttachedClient = { pty: client, ignoreExit: false }
    this.attachedClients.set(termId, entry)

    client.onData((data) => {
      const active = this.attachedClients.get(termId)
      if (!active || active.pty !== client) return
      this.hooks.onData?.(termId, data)
    })

    client.onExit(() => {
      const active = this.attachedClients.get(termId)
      if (!active || active.pty !== client) return
      this.attachedClients.delete(termId)
      if (active.ignoreExit) return
      if (this.has(termId)) return
      this.knownSessions.delete(termId)
      this.hooks.onExit?.(termId)
    })
  }

  private disposeAttachedClient(termId: string) {
    const existing = this.attachedClients.get(termId)
    if (!existing) return
    existing.ignoreExit = true
    this.attachedClients.delete(termId)
    try {
      existing.pty.kill()
    } catch {}
  }

  private startDetachedSessionPoller() {
    this.pollTimer = setInterval(() => {
      const liveSessions = new Set(this.list())
      for (const termId of [...this.knownSessions]) {
        if (liveSessions.has(termId)) continue
        if (this.attachedClients.has(termId)) continue
        this.knownSessions.delete(termId)
        this.hooks.onExit?.(termId)
      }
    }, 2000)
    this.pollTimer.unref?.()
  }

  private getPrimaryPane(termId: string): ZellijPaneInfo | null {
    const output = this.execZellijSession(termId, ['action', 'list-panes', '--json'], true)
    if (!output) return null
    try {
      const parsed = JSON.parse(output)
      const panes = Array.isArray(parsed) ? parsed : []
      const normalized = panes
        .map((pane) => this.normalizePaneInfo(pane))
        .filter((pane): pane is ZellijPaneInfo => pane !== null && !pane.isPlugin)
      if (normalized.length === 0) return null
      return normalized.find((pane) => pane.focused) ?? normalized[0]
    } catch {
      return null
    }
  }

  private normalizePaneInfo(raw: any): ZellijPaneInfo | null {
    if (!raw || typeof raw !== 'object') return null
    const idValue = raw.pane_id ?? raw.id ?? raw.paneId ?? null
    const isPlugin = raw.is_plugin === true || raw.isPlugin === true
    const id = typeof idValue === 'string' || typeof idValue === 'number' ? String(idValue) : null
    const pidValue =
      raw.pid ?? raw.process_id ?? raw.processId ?? raw.terminal_pid ?? raw.terminalPid ?? null
    const pid =
      typeof pidValue === 'number'
        ? pidValue
        : typeof pidValue === 'string' && /^\d+$/.test(pidValue)
          ? Number.parseInt(pidValue, 10)
          : null
    const command =
      typeof raw.pane_command === 'string'
        ? raw.pane_command
        : typeof raw.command === 'string'
          ? raw.command
          : typeof raw.terminal_command === 'string'
            ? raw.terminal_command
            : typeof raw.name === 'string'
              ? raw.name
              : null
    const cwd =
      typeof raw.pane_cwd === 'string' ? raw.pane_cwd : typeof raw.cwd === 'string' ? raw.cwd : null
    const focused = raw.is_focused === true || raw.focused === true
    return { id, pid, command, cwd, focused, isPlugin }
  }

  private zellijArgs(args: string[]) {
    return [
      '--config',
      this.configPath,
      '--config-dir',
      this.configDir,
      '--data-dir',
      this.dataDir,
      ...args,
    ]
  }

  private execZellij(
    args: string[],
    options: { cwd?: string; allowFailure?: boolean; timeoutMs?: number } = {},
  ): string | null {
    try {
      return execFileSync(this.zellijBinary, this.zellijArgs(args), {
        cwd: options.cwd ?? this.stateDir,
        encoding: 'utf8',
        env: this.buildZellijEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeoutMs ?? 5000,
      }).trim()
    } catch (error) {
      if (options.allowFailure) return null
      const message =
        error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
          ? error.stderr.trim() || error.message
          : error instanceof Error
            ? error.message
            : 'Unknown zellij error'
      throw error instanceof Error ? new Error(message, { cause: error }) : new Error(message)
    }
  }

  private execZellijSession(termId: string, args: string[], allowFailure = false) {
    return this.execZellij(['--session', this.encodeSessionId(termId), ...args], {
      allowFailure,
      timeoutMs: allowFailure ? 500 : 5000,
    })
  }

  private encodeSessionId(termId: string) {
    return this.getSessionName(termId)
  }

  private sessionExists(termId: string) {
    const sessionName = this.encodeSessionId(termId)
    const output = this.execZellij(['list-sessions', '-s'], { allowFailure: true })
    if (!output) return false
    return output
      .split('\n')
      .map((line) => line.trim())
      .some((line) => line === sessionName)
  }

  private getSessionName(termId: string) {
    const existing = this.sessionNames.get(termId)
    if (existing) return existing

    let salt = ''
    while (true) {
      const candidate = buildSessionName(this.sessionPrefix, termId, salt)
      const conflict = [...this.sessionNames.entries()].find(
        ([knownTermId, knownSessionName]) =>
          knownTermId !== termId && knownSessionName === candidate,
      )
      if (!conflict) {
        this.sessionNames.set(termId, candidate)
        this.saveSessionMap()
        return candidate
      }
      salt = salt ? `${salt}-1` : '1'
    }
  }

  private loadSessionMap() {
    try {
      const raw = fs.readFileSync(this.sessionMapPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return
      for (const [termId, sessionName] of Object.entries(parsed)) {
        if (
          typeof termId === 'string' &&
          typeof sessionName === 'string' &&
          isSafeSessionName(this.sessionPrefix, sessionName)
        ) {
          this.sessionNames.set(termId, sessionName)
        }
      }
    } catch {}
  }

  private saveSessionMap() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      const entries = [...this.sessionNames.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      )
      fs.writeFileSync(this.sessionMapPath, JSON.stringify(Object.fromEntries(entries), null, 2))
    } catch {}
  }

  private buildZellijEnv() {
    const env = cleanEnv()
    env.SHELL = resolveShell()
    env.ZELLIJ_CONFIG_FILE = this.configPath
    env.ZELLIJ_CONFIG_DIR = this.configDir
    env.ZELLIJ_DATA_DIR = this.dataDir
    env.TERM = env.TERM || 'xterm-256color'
    return env
  }
}
