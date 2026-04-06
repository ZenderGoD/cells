import fs from 'fs'
import path from 'path'
import * as pty from 'node-pty'
import { execaSync } from 'execa'
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
 * Cells uses one tmux server per app state dir. Each project owns a primary
 * tmux session whose windows act as the project's terminal tabs. Individual
 * Cells terminals attach through lightweight viewer sessions grouped to the
 * same project window set so multiple terminals from one project can stay
 * visible independently without fighting over a shared current window.
 */

const PROJECT_SESSION_PREFIX = 'cp_'
const VIEWER_SESSION_PREFIX = 'cv_'
const WINDOW_NAME_PREFIX = 'cw_'

function encodeBase64Url(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8')
}

function encodeProjectSessionId(projectId: string): string {
  return `${PROJECT_SESSION_PREFIX}${encodeBase64Url(projectId)}`
}

function decodeProjectSessionId(sessionName: string): string | null {
  if (!sessionName.startsWith(PROJECT_SESSION_PREFIX)) return null
  try {
    return decodeBase64Url(sessionName.slice(PROJECT_SESSION_PREFIX.length))
  } catch {
    return null
  }
}

function encodeViewerSessionId(termId: string): string {
  return `${VIEWER_SESSION_PREFIX}${encodeBase64Url(termId)}`
}

function encodeWindowName(termId: string): string {
  return `${WINDOW_NAME_PREFIX}${encodeBase64Url(termId)}`
}

function decodeWindowName(windowName: string): string | null {
  if (!windowName.startsWith(WINDOW_NAME_PREFIX)) return null
  try {
    return decodeBase64Url(windowName.slice(WINDOW_NAME_PREFIX.length))
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

type CachedPaneFlags = TmuxPaneFlags & {
  expiresAt: number
}

type PendingWheelScroll = {
  delta: number
  sequence: string
  timer: ReturnType<typeof setTimeout> | null
}

type TerminalLocation = {
  termId: string
  projectId: string
  projectSession: string
  viewerSession: string
  windowName: string
}

export class TmuxSessionManager implements TerminalSessionManager {
  private readonly tmuxBinary = resolveTmuxBinary()
  private readonly tmuxConfigPath: string
  private readonly socketPath: string
  private readonly tmuxTerm: string
  private readonly terminfoDir: string | null
  private readonly attachedClients = new Map<string, AttachedClient>()
  private readonly pendingWheelScrolls = new Map<string, PendingWheelScroll>()
  private readonly paneFlagsCache = new Map<string, CachedPaneFlags>()
  private readonly knownTerminals = new Set<string>()
  private readonly termProjectIds = new Map<string, string>()
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
    projectId?: string | null,
  ): { reattached: boolean; shellPid: number } {
    const normalizedProjectId = this.resolveProjectIdForAttach(termId, projectId, cwd)
    const location = this.buildLocation(termId, normalizedProjectId)
    const reattached = this.windowExists(location)
    if (!reattached) {
      this.ensureProjectWindow(location, cols, rows, cwd)
    }
    this.rememberTerminal(location)
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
    projectId?: string | null,
    onAttached?: () => void,
  ): TerminalAttachResult {
    const normalizedProjectId = this.resolveProjectIdForAttach(termId, projectId, cwd)
    const result = this.spawn(termId, cols, rows, cwd, normalizedProjectId)
    this.replaceAttachedClient(termId, cols, rows, cwd, normalizedProjectId)
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
    const location = this.getKnownLocation(termId)
    if (!location) {
      this.forgetTerminal(termId)
      return
    }

    this.execTmux(['kill-window', '-t', this.getWindowTarget(location)], true)
    if (this.getWindowCount(location.projectSession) === 0) {
      this.execTmux(['kill-session', '-t', location.projectSession], true)
    }
    this.forgetTerminal(termId)
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
    const clampedSteps = Math.max(1, Math.min(24, Math.round(steps) || 1))
    const signedDelta = direction === 'up' ? clampedSteps : -clampedSteps
    const existing = this.pendingWheelScrolls.get(termId)
    if (existing) {
      existing.delta += signedDelta
      if (sequence) existing.sequence += sequence
      return
    }

    const pending: PendingWheelScroll = {
      delta: signedDelta,
      sequence,
      timer: setTimeout(() => {
        this.pendingWheelScrolls.delete(termId)
        this.flushWheelScroll(termId, pending.delta, pending.sequence)
      }, 20),
    }
    if (pending.timer) pending.timer.unref?.()
    this.pendingWheelScrolls.set(termId, pending)
  }

  getScrollStatus(termId: string): TerminalScrollStatus | null {
    const paneTarget = this.getPaneTarget(termId)
    if (!paneTarget) return null
    const paneFlags = this.getPaneFlags(termId)
    const output = this.execTmux(
      [
        'display-message',
        '-p',
        '-t',
        paneTarget,
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
      mouseAnyFlag: paneFlags?.mouseAnyFlag ?? false,
      alternateOn: paneFlags?.alternateOn ?? false,
    }
  }

  has(termId: string): boolean {
    const location = this.getKnownLocation(termId)
    return location ? this.windowExists(location) : false
  }

  list(): string[] {
    const mappings = this.listProjectWindows()
    for (const mapping of mappings) {
      this.termProjectIds.set(mapping.termId, mapping.projectId)
      this.knownTerminals.add(mapping.termId)
    }
    return mappings.map((mapping) => mapping.termId)
  }

  getShellPid(termId: string): number | null {
    const paneTarget = this.getPaneTarget(termId)
    if (!paneTarget) return null
    const output = this.execTmux(['display-message', '-p', '-t', paneTarget, '#{pane_pid}'], true)
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
    const paneTarget = this.getPaneTarget(termId)
    if (!paneTarget) return ''
    return this.execTmux(['capture-pane', '-p', '-J', '-S', '-', '-t', paneTarget], true) ?? ''
  }

  clear(termId: string): void {
    this.forgetTerminal(termId)
  }

  cleanup(): void {
    for (const pending of this.pendingWheelScrolls.values()) {
      if (pending.timer) clearTimeout(pending.timer)
    }
    this.pendingWheelScrolls.clear()
    this.paneFlagsCache.clear()
    for (const termId of [...this.attachedClients.keys()]) {
      this.disposeAttachedClient(termId)
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private flushWheelScroll(termId: string, delta: number, sequence: string): void {
    if (!delta && !sequence) return

    const flags = this.getPaneFlags(termId)
    if (!flags) {
      if (sequence) this.write(termId, sequence)
      return
    }

    if (flags.mouseAnyFlag || flags.alternateOn) {
      if (sequence) this.write(termId, sequence)
      return
    }

    const paneTarget = this.getPaneTarget(termId)
    if (!paneTarget) return
    const scrollAmount = Math.max(1, Math.min(24, Math.abs(delta)))

    if (delta > 0) {
      if (!flags.paneInMode) {
        this.execTmux(['copy-mode', '-eH', '-t', paneTarget], true)
        this.setPaneFlagsCache(termId, { ...flags, paneInMode: true })
      } else {
        this.execTmux(['copy-mode', '-H', '-t', paneTarget], true)
      }
      this.execTmux(
        ['send-keys', '-X', '-N', String(scrollAmount), '-t', paneTarget, 'scroll-up'],
        true,
      )
      return
    }

    if (!flags.paneInMode) return
    this.execTmux(['copy-mode', '-H', '-t', paneTarget], true)
    this.execTmux(
      ['send-keys', '-X', '-N', String(scrollAmount), '-t', paneTarget, 'scroll-down'],
      true,
    )
    this.clearPaneFlagsCache(termId)
  }

  private replaceAttachedClient(
    termId: string,
    cols: number,
    rows: number,
    cwd: string | undefined,
    projectId: string,
  ) {
    this.disposeAttachedClient(termId)

    const location = this.buildLocation(termId, projectId)
    this.ensureProjectWindow(location, cols, rows, cwd)
    this.ensureViewerSession(location)
    ensureSpawnHelperExecutable()

    const client = pty.spawn(
      this.tmuxBinary,
      this.tmuxArgs(['attach-session', '-t', location.viewerSession]),
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
      this.destroyViewerSession(termId)
      if (this.has(termId)) return
      this.forgetTerminal(termId)
      this.hooks.onExit?.(termId)
    })
  }

  private disposeAttachedClient(termId: string) {
    const existing = this.attachedClients.get(termId)
    if (!existing) {
      this.destroyViewerSession(termId)
      return
    }
    existing.ignoreExit = true
    this.attachedClients.delete(termId)
    try {
      existing.pty.kill()
    } catch {}
    this.destroyViewerSession(termId)
  }

  private startDetachedSessionPoller() {
    this.pollTimer = setInterval(() => {
      const liveTerminals = new Set(this.list())
      for (const termId of [...this.knownTerminals]) {
        if (liveTerminals.has(termId)) continue
        if (this.attachedClients.has(termId)) continue
        this.forgetTerminal(termId)
        this.hooks.onExit?.(termId)
      }
    }, 2000)
    this.pollTimer.unref?.()
  }

  private normalizeProjectId(projectId?: string | null, cwd?: string) {
    const trimmed = projectId?.trim()
    if (trimmed) return trimmed
    return `cwd:${resolveCwd(cwd)}`
  }

  private resolveProjectIdForAttach(termId: string, projectId?: string | null, cwd?: string) {
    return (
      projectId?.trim() ||
      this.termProjectIds.get(termId) ||
      this.discoverProjectIdForTerminal(termId) ||
      this.normalizeProjectId(projectId, cwd)
    )
  }

  private buildLocation(termId: string, projectId: string): TerminalLocation {
    return {
      termId,
      projectId,
      projectSession: encodeProjectSessionId(projectId),
      viewerSession: encodeViewerSessionId(termId),
      windowName: encodeWindowName(termId),
    }
  }

  private rememberTerminal(location: TerminalLocation) {
    this.knownTerminals.add(location.termId)
    this.termProjectIds.set(location.termId, location.projectId)
  }

  private forgetTerminal(termId: string) {
    this.knownTerminals.delete(termId)
    this.termProjectIds.delete(termId)
    this.clearPaneFlagsCache(termId)
  }

  private getKnownLocation(termId: string): TerminalLocation | null {
    const projectId = this.termProjectIds.get(termId) || this.discoverProjectIdForTerminal(termId)
    if (!projectId) return null
    return this.buildLocation(termId, projectId)
  }

  private discoverProjectIdForTerminal(termId: string): string | null {
    const mapping = this.listProjectWindows().find((entry) => entry.termId === termId)
    if (!mapping) return null
    this.termProjectIds.set(termId, mapping.projectId)
    this.knownTerminals.add(termId)
    return mapping.projectId
  }

  private listProjectWindows() {
    const output = this.execTmux(
      ['list-windows', '-a', '-F', '#{session_name}\t#{window_name}'],
      true,
    )
    if (!output) return [] as Array<{ projectId: string; termId: string }>
    const mappings: Array<{ projectId: string; termId: string }> = []
    for (const line of output.split('\n')) {
      const [sessionNameRaw, windowNameRaw] = line.split('\t')
      const sessionName = sessionNameRaw?.trim()
      const windowName = windowNameRaw?.trim()
      if (!sessionName || !windowName) continue
      const projectId = decodeProjectSessionId(sessionName)
      const termId = decodeWindowName(windowName)
      if (!projectId || !termId) continue
      mappings.push({ projectId, termId })
    }
    return mappings
  }

  private ensureProjectWindow(
    location: TerminalLocation,
    cols: number,
    rows: number,
    cwd?: string,
  ) {
    const resolvedCwd = resolveCwd(cwd)
    if (!this.sessionExists(location.projectSession)) {
      this.execTmux([
        'new-session',
        '-d',
        '-s',
        location.projectSession,
        '-n',
        location.windowName,
        '-c',
        resolvedCwd,
        '-x',
        String(cols),
        '-y',
        String(rows),
      ])
      return
    }

    if (this.windowExists(location)) return

    this.execTmux([
      'new-window',
      '-d',
      '-t',
      `${location.projectSession}:`,
      '-n',
      location.windowName,
      '-c',
      resolvedCwd,
    ])
    this.execTmux(
      [
        'resize-window',
        '-t',
        this.getWindowTarget(location),
        '-x',
        String(cols),
        '-y',
        String(rows),
      ],
      true,
    )
  }

  private ensureViewerSession(location: TerminalLocation) {
    if (!this.sessionExists(location.viewerSession)) {
      this.execTmux([
        'new-session',
        '-d',
        '-t',
        location.projectSession,
        '-s',
        location.viewerSession,
      ])
    }
    this.execTmux(['select-window', '-t', `${location.viewerSession}:${location.windowName}`], true)
  }

  private destroyViewerSession(termId: string) {
    const location = this.getKnownLocation(termId)
    if (!location) return
    this.execTmux(['kill-session', '-t', location.viewerSession], true)
  }

  private sessionExists(sessionName: string) {
    return this.execTmux(['has-session', '-t', sessionName], true) !== null
  }

  private windowExists(location: TerminalLocation) {
    const output = this.execTmux(
      ['list-windows', '-t', location.projectSession, '-F', '#{window_name}'],
      true,
    )
    if (!output) return false
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .includes(location.windowName)
  }

  private getWindowCount(sessionName: string) {
    const output = this.execTmux(['list-windows', '-t', sessionName, '-F', '#{window_name}'], true)
    if (!output) return 0
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean).length
  }

  private getWindowTarget(location: TerminalLocation) {
    return `${location.projectSession}:${location.windowName}`
  }

  private getPaneTarget(termId: string) {
    const location = this.getKnownLocation(termId)
    if (!location || !this.windowExists(location)) return null
    return `${this.getWindowTarget(location)}.0`
  }

  private tmuxArgs(args: string[]): string[] {
    return ['-f', this.tmuxConfigPath, '-S', this.socketPath, ...args]
  }

  private reloadConfig() {
    this.execTmux(['start-server'], true)
    this.execTmux(['source-file', this.tmuxConfigPath], true)
  }

  private getPaneFlags(termId: string): TmuxPaneFlags | null {
    const cached = this.paneFlagsCache.get(termId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached
    }

    const paneTarget = this.getPaneTarget(termId)
    if (!paneTarget) return null
    const output = this.execTmux(
      [
        'display-message',
        '-p',
        '-t',
        paneTarget,
        '#{pane_in_mode} #{mouse_any_flag} #{alternate_on}',
      ],
      true,
    )
    if (!output) return null
    const [paneInMode, mouseAnyFlag, alternateOn] = output.trim().split(/\s+/)
    const flags = {
      paneInMode: paneInMode === '1',
      mouseAnyFlag: mouseAnyFlag === '1',
      alternateOn: alternateOn === '1',
    }
    this.setPaneFlagsCache(termId, flags)
    return flags
  }

  private setPaneFlagsCache(termId: string, flags: TmuxPaneFlags) {
    this.paneFlagsCache.set(termId, { ...flags, expiresAt: Date.now() + 80 })
  }

  private clearPaneFlagsCache(termId: string) {
    this.paneFlagsCache.delete(termId)
  }

  private execTmux(args: string[], allowFailure = false): string | null {
    const result = execaSync(this.tmuxBinary, this.tmuxArgs(args), {
      cwd: this.stateDir,
      env: this.buildTmuxEnv(),
      reject: false,
      stdin: 'ignore',
      timeout: 5000,
    })
    if (result.exitCode === 0) return result.stdout.trim()
    if (allowFailure) return null

    const message = result.stderr.trim() || result.shortMessage || 'Unknown tmux error'
    throw new Error(message)
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

export function getTmuxProjectSessionNameForTest(projectId: string): string {
  return encodeProjectSessionId(projectId)
}

export function getTmuxViewerSessionNameForTest(termId: string): string {
  return encodeViewerSessionId(termId)
}

export function getTmuxWindowNameForTest(termId: string): string {
  return encodeWindowName(termId)
}
