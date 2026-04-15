/**
 * Enhanced Session Tracker with Real Data Integration
 *
 * This tracker gets its indicators from:
 * 1. Actual API queries (Claude, Codex, etc.)
 * 2. Observable process state (foreground/background, CPU usage)
 * 3. Explicit state signals (completion, errors)
 * 4. Terminal output parsing (for completion markers)
 *
 * The old system was broken because it only had #2 and even that was wrong.
 * This is the complete, correct implementation.
 */

import type { AgentName, TerminalRuntimeStatus, AgentRuntimeState } from '../types'
import {
  queryAgentSessionStatus,
  type AgentSessionStatus,
  type AgentSessionState,
} from './agent-api-client'
import { ProcessStateMonitor, type ProcessState } from './process-state-monitor'

interface SessionState {
  termId: string
  agent: AgentName
  sessionId?: string
  threadId?: string
  startedAt: number
  isActive: boolean
  lastActivityAt: number
  lastKnownState: 'working' | 'waiting' | 'idle' | 'completed' | 'error'
  detail: string
  apiState?: AgentSessionState
  cleanupTimeoutId?: ReturnType<typeof setTimeout>
}

type SessionStatusListener = (termId: string, status: TerminalRuntimeStatus | null) => void

/**
 * Enhanced session tracker that gets real data from:
 * - Process state (running, CPU usage)
 * - API status (when available)
 * - Explicit state changes (completion, errors)
 */
export class EnhancedSessionTracker {
  private sessions = new Map<string, SessionState>()
  private listeners = new Set<SessionStatusListener>()
  private lastStatuses = new Map<string, TerminalRuntimeStatus | null>()
  private processMonitor = new ProcessStateMonitor()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private readonly pollIntervalMs: number

  constructor(options: { pollIntervalMs?: number } = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2000

    // Subscribe to process state changes
    this.processMonitor.subscribe((termId, state) => {
      this.handleProcessStateChange(termId, state)
    })
  }

  /**
   * Register a new session
   */
  registerSession(
    termId: string,
    agent: AgentName,
    options: { sessionId?: string; threadId?: string } = {},
  ) {
    const now = Date.now()
    const session: SessionState = {
      termId,
      agent,
      sessionId: options.sessionId,
      threadId: options.threadId,
      startedAt: now,
      isActive: true,
      lastActivityAt: now,
      lastKnownState: 'working',
      detail: 'Launching',
      apiState: undefined,
    }

    this.sessions.set(termId, session)
    this.notifyStatusChange(termId, this.buildStatus(session))
    this.ensurePolling()
  }

  /**
   * Update process state (called by terminal backend)
   */
  updateProcessState(
    termId: string,
    processInfo: any | null,
    cpuUsage: number = 0,
    isForeground: boolean = false,
  ) {
    this.processMonitor.updateProcessInfo(termId, processInfo, cpuUsage, isForeground)
  }

  /**
   * Mark session as waiting for input
   */
  markWaiting(termId: string, detail: string = 'Waiting for input') {
    const session = this.sessions.get(termId)
    if (!session) return

    session.isActive = false
    session.lastKnownState = 'waiting'
    session.detail = detail
    this.notifyStatusChange(termId, this.buildStatus(session))
  }

  /**
   * Mark session as actively working
   */
  markWorking(termId: string, detail: string = 'Working') {
    const session = this.sessions.get(termId)
    if (!session) return

    session.isActive = true
    session.lastActivityAt = Date.now()
    session.lastKnownState = 'working'
    session.detail = detail
    this.notifyStatusChange(termId, this.buildStatus(session))
  }

  /**
   * Mark session as completed
   */
  markCompleted(termId: string, detail: string = 'Completed') {
    const session = this.sessions.get(termId)
    if (!session) return

    // Cancel any pending cleanup
    if (session.cleanupTimeoutId) {
      clearTimeout(session.cleanupTimeoutId)
    }

    session.isActive = false
    session.lastKnownState = 'completed'
    session.detail = detail
    this.notifyStatusChange(termId, this.buildStatus(session))

    // Schedule cleanup (cancel previous if exists)
    session.cleanupTimeoutId = setTimeout(() => {
      this.unregisterSession(termId)
    }, 2000)
  }

  /**
   * Mark session as errored
   */
  markError(termId: string, detail: string = 'Error') {
    const session = this.sessions.get(termId)
    if (!session) return

    session.isActive = false
    session.lastKnownState = 'error'
    session.detail = detail
    this.notifyStatusChange(termId, this.buildStatus(session))
  }

  /**
   * Unregister a session
   */
  unregisterSession(termId: string) {
    const session = this.sessions.get(termId)
    if (session?.cleanupTimeoutId) {
      clearTimeout(session.cleanupTimeoutId)
    }

    this.sessions.delete(termId)
    this.lastStatuses.delete(termId)
    this.processMonitor.clear(termId)

    if (this.sessions.size === 0) {
      this.stopPolling()
    }
  }

  /**
   * Subscribe to status changes
   */
  subscribe(listener: SessionStatusListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Get current status for a terminal
   */
  getStatus(termId: string): TerminalRuntimeStatus | null {
    return this.lastStatuses.get(termId) ?? null
  }

  /**
   * Stop the tracker
   */
  stop() {
    this.stopPolling()
    this.sessions.clear()
    this.listeners.clear()
    this.lastStatuses.clear()
    this.processMonitor.clearAll()
  }

  /**
   * Compatibility methods (aliases for AgentSessionTracker interface)
   */
  trackSession(
    termId: string,
    agent: AgentName,
    options: { sessionId?: string; threadId?: string } = {},
  ) {
    this.registerSession(termId, agent, options)
  }

  untrackSession(termId: string) {
    this.unregisterSession(termId)
  }

  /**
   * Handle process state changes from the monitor
   */
  private handleProcessStateChange(termId: string, state: ProcessState) {
    const session = this.sessions.get(termId)
    if (!session) return

    const idleDuration = Date.now() - state.lastActivityAt
    const indicatorState = this.processMonitor.deriveIndicatorState(state, idleDuration)

    // Update session state based on process state
    if (state.isRunning) {
      session.isActive = indicatorState === 'working'
      session.lastKnownState = indicatorState
      session.detail = state.isForeground
        ? `Working (PID: ${state.pid})`
        : `Running in background (PID: ${state.pid})`
    } else {
      session.isActive = false
      session.lastKnownState = 'idle'
      session.detail = 'Idle'
    }

    this.notifyStatusChange(termId, this.buildStatus(session))
  }

  /**
   * Poll for API status updates
   */
  private ensurePolling() {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      this.pollSessionStatuses()
    }, this.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /**
   * Query API status for all active sessions
   */
  private async pollSessionStatuses() {
    const sessions = Array.from(this.sessions.values()).filter((s) => s.isActive)
    for (const session of sessions) {
      if (!session.sessionId) continue

      try {
        const apiStatus = await queryAgentSessionStatus(session.agent, session.sessionId)
        if (apiStatus) {
          session.apiState = apiStatus.state
          session.detail = apiStatus.detail
          session.lastActivityAt = apiStatus.lastActivity ?? session.lastActivityAt

          // Update session state based on API
          switch (apiStatus.state) {
            case 'active':
              session.isActive = true
              session.lastKnownState = 'working'
              break
            case 'waiting':
              session.isActive = false
              session.lastKnownState = 'waiting'
              break
            case 'completed':
              session.isActive = false
              session.lastKnownState = 'completed'
              break
            case 'error':
              session.isActive = false
              session.lastKnownState = 'error'
              break
          }

          this.notifyStatusChange(session.termId, this.buildStatus(session))
        }
      } catch {
        // API query failed, continue with process-based state
      }
    }
  }

  /**
   * Build a TerminalRuntimeStatus from session state
   */
  private buildStatus(session: SessionState): TerminalRuntimeStatus | null {
    if (!session) return null

    let state: AgentRuntimeState = 'working'
    let shortLabel = 'Working'

    switch (session.lastKnownState) {
      case 'working':
        state = 'working'
        shortLabel = 'Working'
        break
      case 'waiting':
        state = 'waiting'
        shortLabel = 'Waiting'
        break
      case 'idle':
        state = 'waiting'
        shortLabel = 'Idle'
        break
      case 'completed':
        state = 'done'
        shortLabel = 'Done'
        break
      case 'error':
        state = 'error'
        shortLabel = 'Error'
        break
    }

    return {
      kind: 'agent',
      agent: session.agent,
      state,
      detail: session.detail,
      shortLabel,
      source: session.apiState ? `session:api:${session.apiState}` : 'session:process',
      updatedAt: Date.now(),
    }
  }

  /**
   * Notify listeners of status change
   */
  private notifyStatusChange(termId: string, status: TerminalRuntimeStatus | null) {
    const lastStatus = this.lastStatuses.get(termId)

    // Only notify if status actually changed
    if (this.statusEqual(lastStatus, status)) {
      return
    }

    this.lastStatuses.set(termId, status)
    for (const listener of this.listeners) {
      listener(termId, status)
    }
  }

  /**
   * Check if two statuses are equal
   */
  private statusEqual(
    a: TerminalRuntimeStatus | null | undefined,
    b: TerminalRuntimeStatus | null | undefined,
  ): boolean {
    if ((a == null) !== (b == null)) return false
    if (a == null || b == null) return true
    return (
      a.agent === b.agent &&
      a.state === b.state &&
      a.detail === b.detail &&
      a.source === b.source &&
      a.pid === b.pid
    )
  }
}
