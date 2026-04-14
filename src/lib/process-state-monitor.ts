/**
 * Process State Monitor
 *
 * Real, observable indicator data source:
 * - Is the agent process running in foreground?
 * - Is it using CPU?
 * - Has it been idle for a while?
 * - Did it exit?
 *
 * Unlike the old CPU-based system, this is integrated with real process info
 * from the terminal backend and observable state transitions.
 */

import type { TerminalProcessInfo } from '../types'

export interface ProcessState {
  pid: number | null
  isRunning: boolean
  isForeground: boolean
  cpuUsage: number
  lastActivityAt: number
}

export interface MonitoredProcess {
  termId: string
  agent: string | null
  lastKnownPid: number | null
  lastKnownState: ProcessState
  lastStateChangeAt: number
}

export class ProcessStateMonitor {
  private processes = new Map<string, MonitoredProcess>()
  private stateListeners = new Set<(termId: string, state: ProcessState) => void>()
  private cpuThreshold = 10 // % CPU above this = considered "working"
  private idleThresholdMs = 3000 // ms without activity = considered "idle"

  /**
   * Update process info for a terminal
   */
  updateProcessInfo(
    termId: string,
    processInfo: TerminalProcessInfo | null,
    cpuUsage: number,
    isForeground: boolean,
  ) {
    const now = Date.now()
    const isRunning = processInfo != null
    const pid = processInfo?.pid ?? null

    let existing = this.processes.get(termId)
    if (!existing) {
      existing = {
        termId,
        agent: null,
        lastKnownPid: pid,
        lastKnownState: {
          pid,
          isRunning,
          isForeground,
          cpuUsage,
          lastActivityAt: now,
        },
        lastStateChangeAt: now,
      }
      this.processes.set(termId, existing)
    } else {
      const oldState = existing.lastKnownState
      existing.lastKnownPid = pid

      // Detect activity
      const isActive = cpuUsage > this.cpuThreshold
      if (isActive || !oldState.isRunning) {
        existing.lastKnownState.lastActivityAt = now
      }

      // Build new state
      const newState: ProcessState = {
        pid,
        isRunning,
        isForeground,
        cpuUsage,
        lastActivityAt: existing.lastKnownState.lastActivityAt,
      }

      // Emit change if state actually changed
      if (!this.stateEqual(oldState, newState)) {
        existing.lastStateChangeAt = now
        existing.lastKnownState = newState
        this.emitStateChange(termId, newState)
      }
    }
  }

  setAgent(termId: string, agent: string | null) {
    const existing = this.processes.get(termId)
    if (existing) {
      existing.agent = agent
    }
  }

  getState(termId: string): ProcessState | null {
    return this.processes.get(termId)?.lastKnownState ?? null
  }

  getAgent(termId: string): string | null {
    return this.processes.get(termId)?.agent ?? null
  }

  /**
   * Derive indicator state from process state
   */
  deriveIndicatorState(state: ProcessState, idleDuration: number): 'working' | 'waiting' | 'idle' {
    if (!state.isRunning) {
      return 'idle'
    }
    if (state.cpuUsage > this.cpuThreshold) {
      return 'working'
    }
    if (idleDuration > this.idleThresholdMs) {
      return 'waiting'
    }
    return 'working'
  }

  subscribe(listener: (termId: string, state: ProcessState) => void) {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  clear(termId: string) {
    this.processes.delete(termId)
  }

  clearAll() {
    this.processes.clear()
  }

  private stateEqual(a: ProcessState, b: ProcessState): boolean {
    return (
      a.pid === b.pid &&
      a.isRunning === b.isRunning &&
      a.isForeground === b.isForeground &&
      a.cpuUsage === b.cpuUsage
    )
  }

  private emitStateChange(termId: string, state: ProcessState) {
    for (const listener of this.stateListeners) {
      listener(termId, state)
    }
  }
}
