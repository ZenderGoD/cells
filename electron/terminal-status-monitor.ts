import { execFile } from 'child_process'
import type {
  AgentName,
  AgentRuntimeState,
  TerminalExitDetails,
  TerminalProcessInfo,
  TerminalRuntimeStatus,
} from '../src/types'
import type { PtyDaemonClient } from './pty-client'
import type { TerminalSessionManager } from './terminal-session-manager'
import { inferAgentFromCommand } from '../src/lib/agent-command.ts'

// Simple process-based status monitor. Polls `ps` for CPU usage and reports
// whether a terminal's foreground process is an agent (by process name) and
// whether it is actively using CPU. No terminal-buffer scraping, no SDK/log
// attachments — those caused UI freezes when typing into agents.

const POLL_INTERVAL_MS = 5000
// CPU% above this is considered "working". Set high enough to ignore JIT/GC
// blips on idle agents, low enough to catch light tool invocations.
const CPU_WORKING_THRESHOLD = 10
// Require two consecutive idle samples before flipping from working → waiting
// to avoid flapping between states on noisy CPU samples.
const IDLE_CONFIRM_SAMPLES = 2

type LaunchMeta = {
  agent?: AgentName | null
  command?: string | null
  cwd?: string | null
}

export interface TerminalStatusMonitorOptions {
  getDaemonClient: () => PtyDaemonClient | null
  getFallbackSessions: () => TerminalSessionManager | null
  getUseDaemon: () => boolean
  onStatus: (termId: string, status: TerminalRuntimeStatus | null) => void
}

function sameStatus(
  a: TerminalRuntimeStatus | null | undefined,
  b: TerminalRuntimeStatus | null | undefined,
) {
  return (
    (a?.kind ?? null) === (b?.kind ?? null) &&
    (a?.agent ?? null) === (b?.agent ?? null) &&
    (a?.state ?? null) === (b?.state ?? null) &&
    (a?.detail ?? '') === (b?.detail ?? '') &&
    (a?.shortLabel ?? '') === (b?.shortLabel ?? '') &&
    (a?.pid ?? null) === (b?.pid ?? null) &&
    (a?.processLabel ?? null) === (b?.processLabel ?? null)
  )
}

function readCpuForPids(pids: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>()
  if (pids.length === 0) return Promise.resolve(map)
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'pid=,%cpu=', '-p', pids.join(',')],
      { encoding: 'utf8', timeout: 1500 },
      (error, stdout) => {
        if (error) {
          resolve(map)
          return
        }
        for (const line of stdout.split('\n')) {
          const match = line.trim().match(/^(\d+)\s+([\d.]+)$/)
          if (!match) continue
          map.set(Number.parseInt(match[1], 10), Number.parseFloat(match[2]))
        }
        resolve(map)
      },
    )
  })
}

function buildAgentStatus(
  now: number,
  agent: AgentName,
  state: AgentRuntimeState,
  pid: number | null,
): TerminalRuntimeStatus {
  return {
    kind: 'agent',
    agent,
    state,
    detail: state === 'working' ? 'Working' : 'Idle',
    shortLabel: state === 'working' ? 'Working' : 'Idle',
    source: 'process:cpu',
    pid,
    processLabel: null,
    updatedAt: now,
  }
}

function buildProcessStatus(
  now: number,
  processInfo: TerminalProcessInfo,
  running: boolean,
): TerminalRuntimeStatus {
  return {
    kind: 'process',
    detail: running ? 'Running' : 'Idle',
    shortLabel: running ? 'Running' : 'Idle',
    source: 'process:cpu',
    pid: processInfo.pid,
    processLabel: processInfo.label,
    updatedAt: now,
  }
}

export class TerminalStatusMonitor {
  private readonly knownTermIds = new Set<string>()
  private readonly statuses = new Map<string, TerminalRuntimeStatus | null>()
  private readonly launchMeta = new Map<string, LaunchMeta>()
  private readonly idleStreak = new Map<string, number>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private refreshing = false
  private refreshPending = false
  private readonly options: TerminalStatusMonitorOptions

  constructor(options: TerminalStatusMonitorOptions) {
    this.options = options
  }

  trackTerminal(termId: string, launch?: LaunchMeta | null) {
    this.knownTermIds.add(termId)
    if (launch) {
      const previous = this.launchMeta.get(termId) ?? {}
      this.launchMeta.set(termId, { ...previous, ...launch })
    }
    this.ensurePolling()
    this.scheduleRefresh()
  }

  setLaunchMeta(termId: string, launch: LaunchMeta) {
    this.trackTerminal(termId, launch)
  }

  forgetTerminal(termId: string) {
    this.knownTermIds.delete(termId)
    this.launchMeta.delete(termId)
    this.statuses.delete(termId)
    this.idleStreak.delete(termId)
    if (this.knownTermIds.size === 0) {
      this.stop()
    }
  }

  async getStatus(termId: string) {
    this.knownTermIds.add(termId)
    this.ensurePolling()
    await this.refreshAll()
    return this.statuses.get(termId) ?? null
  }

  handleTerminalExit(termId: string, _details?: TerminalExitDetails) {
    this.idleStreak.delete(termId)
    this.commitStatus(termId, null)
  }

  handleTerminalData(_termId: string, _data: string) {}

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private ensurePolling() {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.refreshAll()
    }, POLL_INTERVAL_MS)
    this.pollTimer.unref?.()
  }

  private scheduleRefresh() {
    if (this.refreshing) {
      this.refreshPending = true
      return
    }
    void this.refreshAll()
  }

  private async refreshAll() {
    if (this.refreshing) {
      this.refreshPending = true
      return
    }
    this.refreshing = true
    try {
      do {
        this.refreshPending = false
        const termIds = [...this.knownTermIds]
        const infos = await Promise.all(
          termIds.map(async (id) => ({ id, info: await this.getProcessInfo(id) })),
        )
        const pids = infos
          .map((entry) => entry.info?.pid)
          .filter((pid): pid is number => typeof pid === 'number' && pid > 0)
        const cpuMap = await readCpuForPids(pids)
        const now = Date.now()
        for (const { id, info } of infos) {
          this.commitStatus(id, this.buildStatusFor(id, info, cpuMap, now))
        }
      } while (this.refreshPending)
    } finally {
      this.refreshing = false
    }
  }

  private buildStatusFor(
    termId: string,
    processInfo: TerminalProcessInfo | null,
    cpuMap: Map<number, number>,
    now: number,
  ): TerminalRuntimeStatus | null {
    const launch = this.launchMeta.get(termId) ?? null
    const launchAgent = launch?.agent ?? null

    if (!processInfo || processInfo.isShell) {
      // Shell is in the foreground. If the user just launched an agent but
      // its process hasn't appeared yet, keep the launching placeholder so
      // the badge doesn't flicker. Otherwise there's no agent.
      this.idleStreak.delete(termId)
      if (launchAgent) {
        return buildAgentStatus(now, launchAgent, 'working', null)
      }
      return null
    }

    const agent =
      launchAgent ??
      inferAgentFromCommand(launch?.command ?? '') ??
      inferAgentFromCommand(processInfo.command) ??
      null

    const cpu = cpuMap.get(processInfo.pid) ?? 0
    const sampleBusy = cpu > CPU_WORKING_THRESHOLD
    const previous = this.statuses.get(termId)

    let running: boolean
    if (sampleBusy) {
      this.idleStreak.set(termId, 0)
      running = true
    } else {
      const streak = (this.idleStreak.get(termId) ?? 0) + 1
      this.idleStreak.set(termId, streak)
      const wasRunning =
        previous?.kind === 'agent'
          ? previous.state === 'working'
          : previous?.kind === 'process' && previous.detail === 'Running'
      // Keep reporting running until we've seen enough idle samples in a row.
      running = wasRunning && streak < IDLE_CONFIRM_SAMPLES
    }

    if (agent) {
      return buildAgentStatus(now, agent, running ? 'working' : 'waiting', processInfo.pid)
    }
    return buildProcessStatus(now, processInfo, running)
  }

  private commitStatus(termId: string, nextStatus: TerminalRuntimeStatus | null) {
    const previous = this.statuses.get(termId)
    if (sameStatus(previous, nextStatus)) return
    this.statuses.set(termId, nextStatus)
    this.options.onStatus(termId, nextStatus)
  }

  private async getProcessInfo(termId: string) {
    try {
      if (this.options.getUseDaemon()) {
        const daemon = this.options.getDaemonClient()
        if (daemon?.isConnected()) {
          return await daemon.getProcessInfo(termId)
        }
      }
      return this.options.getFallbackSessions()?.getProcessInfo(termId) ?? null
    } catch {
      return null
    }
  }
}
