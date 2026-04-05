import fs from 'fs'
import path from 'path'
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
  ensurePrivateTmuxTerminfo,
  buildPrivateTmuxConfig,
  getPrivateTmuxConfigPath,
  getPrivateTmuxSocketPath,
  getTmuxSupportStatus,
  resolveTmuxBinary,
  TMUX_MIN_VERSION,
} from './tmux-shared'
import type { TerminalProcessInfo } from '../src/types'
import type {
  TerminalAttachResult,
  TerminalScrollStatus,
  TerminalSessionManager,
} from './terminal-session-manager'

/**
 * Private tmux-backed terminal session owner.
 *
 * Cells uses tmux as the canonical session server:
 * - the shell/process tree lives inside tmux, not inside the browser terminal
 * - detach drops only the current tmux client PTY
 * - reattach spawns a fresh tmux client PTY and lets tmux redraw the current
 *   screen exactly as a native tmux attach would
 *
 * This is intentionally isolated from user tmux state:
 * - private socket path under Cells state
 * - private app-owned tmux.conf so personal tmux.conf is ignored
 */

function encodeSessionId(termId: string): string {
  return `cells_${Buffer.from(termId, 'utf8').toString('base64url')}`
}

function decodeSessionId(sessionName: string): string | null {
  if (!sessionName.startsWith('cells_')) return null
  try {
    return Buffer.from(sessionName.slice('cells_'.length), 'base64url').toString('utf8')
  } catch {
    return null
  }
}

export interface TmuxSessionManagerHooks {
  onData?: (termId: string, data: string) => void
  onExit?: (termId: string) => void
}

type AttachedClient = {
  pty: pty.IPty
  ignoreExit: boolean
}

type TmuxPaneFlags = {
  paneInMode: boolean
  mouseAnyFlag: boolean
  alternateOn: boolean
}

export class TmuxSessionManager implements TerminalSessionManager {
  private readonly tmuxBinary = resolveTmuxBinary()
  private readonly tmuxConfigPath: string
  private readonly socketPath: string
  private readonly tmuxTerm: string
  private readonly terminfoDir: string | null
  private readonly attachedClients = new Map<string, AttachedClient>()
  private readonly knownSessions = new Set<string>()
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly stateDir: string,
    private readonly hooks: TmuxSessionManagerHooks = {},
  ) {
    const support = getTmuxSupportStatus()
    if (!support.ok) {
      const detail =
        support.reason === 'too-old'
          ? `tmux ${support.version ?? 'unknown'} found, need ${TMUX_MIN_VERSION}+`
          : `tmux ${TMUX_MIN_VERSION}+ is required`
      throw new Error(`tmux unavailable: ${detail}`)
    }
    fs.mkdirSync(stateDir, { recursive: true })
    this.tmuxConfigPath = getPrivateTmuxConfigPath(stateDir)
    this.socketPath = getPrivateTmuxSocketPath(stateDir)
    const terminfo = ensurePrivateTmuxTerminfo(stateDir)
    this.tmuxTerm = terminfo.termName
    this.terminfoDir = terminfo.terminfoDir
    fs.writeFileSync(
      this.tmuxConfigPath,
      buildPrivateTmuxConfig(resolveShell(), this.tmuxTerm),
      'utf8',
    )
    this.reloadConfig()
    this.startDetachedSessionPoller()
  }

  spawn(
    termId: string,
    cols: number,
    rows: number,
    cwd?: string,
  ): { reattached: boolean; shellPid: number } {
    const reattached = this.has(termId)
    if (!reattached) {
      this.execTmux([
        'new-session',
        '-d',
        '-s',
        encodeSessionId(termId),
        '-c',
        resolveCwd(cwd),
        '-x',
        String(cols),
        '-y',
        String(rows),
      ])
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
    this.replaceAttachedClient(termId, cols, rows, cwd)
    onAttached?.()
    return {
      ...result,
      buffer: '',
      backend: 'tmux',
    }
  }

  subscribe(termId: string, onSubscribed?: () => void): string {
    onSubscribed?.()
    return ''
  }

  unsubscribe(termId: string): void {
    this.disposeAttachedClient(termId)
  }

  kill(termId: string): void {
    this.disposeAttachedClient(termId)
    this.execTmux(['kill-session', '-t', encodeSessionId(termId)], true)
    this.knownSessions.delete(termId)
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
    const clampedSteps = Math.max(1, Math.min(12, Math.round(steps) || 1))
    const flags = this.getPaneFlags(termId)
    if (!flags) {
      if (sequence) this.write(termId, sequence)
      return
    }

    if (flags.mouseAnyFlag) {
      if (sequence) this.write(termId, sequence)
      return
    }

    const target = `${encodeSessionId(termId)}:0.0`
    const scrollAmount = clampedSteps

    if (direction === 'up') {
      if (!flags.paneInMode) {
        this.execTmux(['copy-mode', '-eH', '-t', target], true)
      } else {
        this.execTmux(['copy-mode', '-H', '-t', target], true)
      }
      this.execTmux(
        ['send-keys', '-X', '-N', String(scrollAmount), '-t', target, 'scroll-up'],
        true,
      )
      return
    }

    if (!flags.paneInMode) return
    this.execTmux(['copy-mode', '-H', '-t', target], true)
    this.execTmux(
      ['send-keys', '-X', '-N', String(scrollAmount), '-t', target, 'scroll-down'],
      true,
    )
  }

  getScrollStatus(termId: string): TerminalScrollStatus | null {
    if (!this.has(termId)) return null
    const output = this.execTmux(
      [
        'display-message',
        '-p',
        '-t',
        `${encodeSessionId(termId)}:0.0`,
        '#{pane_in_mode} #{scroll_position} #{history_size}',
      ],
      true,
    )
    if (!output) return null
    const [paneInModeRaw, scrollPositionRaw, historySizeRaw] = output.trim().split(/\s+/)
    return {
      backend: 'tmux',
      paneInMode: paneInModeRaw === '1',
      scrollPosition: Number.parseInt(scrollPositionRaw ?? '0', 10) || 0,
      historySize: Number.parseInt(historySizeRaw ?? '0', 10) || 0,
    }
  }

  has(termId: string): boolean {
    return this.execTmux(['has-session', '-t', encodeSessionId(termId)], true) !== null
  }

  list(): string[] {
    const output = this.execTmux(['list-sessions', '-F', '#{session_name}'], true)
    if (!output) return []
    return output
      .split('\n')
      .map((line) => decodeSessionId(line.trim()))
      .filter((value): value is string => Boolean(value))
  }

  getShellPid(termId: string): number | null {
    const output = this.execTmux(
      ['display-message', '-p', '-t', `${encodeSessionId(termId)}:0.0`, '#{pane_pid}'],
      true,
    )
    const value = output ? Number.parseInt(output.trim(), 10) : NaN
    return Number.isFinite(value) && value > 0 ? value : null
  }

  getProcessInfo(termId: string): TerminalProcessInfo | null {
    const shellPid = this.getShellPid(termId)
    if (!shellPid) return null
    return resolveTerminalProcessInfo(shellPid, null)
  }

  getCodexTitle(termId: string): string | null {
    const shellPid = this.getShellPid(termId)
    if (!shellPid) return null
    const codexPid = resolveCodexProcessPid(shellPid)
    return codexPid ? resolveCodexThreadTitle(codexPid) : null
  }

  getBuffer(_termId: string): string {
    return ''
  }

  getHistory(termId: string): string {
    return (
      this.execTmux(
        ['capture-pane', '-p', '-J', '-S', '-', '-t', `${encodeSessionId(termId)}:0.0`],
        true,
      ) ?? ''
    )
  }

  clear(termId: string): void {
    this.knownSessions.delete(termId)
  }

  cleanup(): void {
    for (const termId of [...this.attachedClients.keys()]) {
      this.disposeAttachedClient(termId)
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private replaceAttachedClient(termId: string, cols: number, rows: number, cwd?: string) {
    this.disposeAttachedClient(termId)
    ensureSpawnHelperExecutable()

    const client = pty.spawn(
      this.tmuxBinary,
      this.tmuxArgs(['attach-session', '-t', encodeSessionId(termId)]),
      {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolveCwd(cwd),
        env: this.buildTmuxEnv(),
      },
    )

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

  private tmuxArgs(args: string[]): string[] {
    return ['-f', this.tmuxConfigPath, '-S', this.socketPath, ...args]
  }

  private reloadConfig() {
    this.execTmux(['start-server'], true)
    this.execTmux(['source-file', this.tmuxConfigPath], true)
  }

  private getPaneFlags(termId: string): TmuxPaneFlags | null {
    const output = this.execTmux(
      [
        'display-message',
        '-p',
        '-t',
        `${encodeSessionId(termId)}:0.0`,
        '#{pane_in_mode} #{mouse_any_flag} #{alternate_on}',
      ],
      true,
    )
    if (!output) return null
    const [paneInMode, mouseAnyFlag, alternateOn] = output.trim().split(/\s+/)
    return {
      paneInMode: paneInMode === '1',
      mouseAnyFlag: mouseAnyFlag === '1',
      alternateOn: alternateOn === '1',
    }
  }

  private execTmux(args: string[], allowFailure = false): string | null {
    try {
      return execFileSync(this.tmuxBinary, this.tmuxArgs(args), {
        cwd: this.stateDir,
        encoding: 'utf8',
        env: this.buildTmuxEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim()
    } catch (error) {
      if (allowFailure) return null
      const message =
        error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
          ? error.stderr.trim() || error.message
          : error instanceof Error
            ? error.message
            : 'Unknown tmux error'
      throw error instanceof Error ? new Error(message, { cause: error }) : new Error(message)
    }
  }

  private buildTmuxEnv() {
    const env = cleanEnv()
    env.SHELL = resolveShell()
    if (this.terminfoDir) {
      env.TERMINFO = this.terminfoDir
      env.TERMINFO_DIRS = env.TERMINFO_DIRS
        ? `${this.terminfoDir}${path.delimiter}${env.TERMINFO_DIRS}`
        : this.terminfoDir
    }
    return env
  }
}

export function getTmuxSessionNameForTest(termId: string): string {
  return encodeSessionId(termId)
}

export function decodeTmuxSessionNameForTest(sessionName: string): string | null {
  return decodeSessionId(sessionName)
}
