/**
 * Agent Session Tracker
 *
 * Replaces the broken CPU-based status system with real session tracking.
 * Tracks actual agent session IDs and queries real agent APIs for status.
 *
 * Key insight: When you launch "claude --session-id XYZ", that session ID
 * is the source of truth. We should query Claude's API with that ID to know
 * what the agent is actually doing.
 */

import type { AgentName, TerminalRuntimeStatus, AgentRuntimeState } from '../types'

export interface TrackedSession {
  termId: string
  agentName: AgentName
  sessionId?: string
  threadId?: string
  startedAt: number
  lastActivityAt: number
  isActive: boolean
  hasError: boolean
  detail: string
}

type SessionStatusListener = (termId: string, status: TerminalRuntimeStatus | null) => void

/**
 * Manages agent session tracking without relying on CPU usage.
 *
 * Instead of polling CPU, we:
 * 1. Store session IDs when agents are launched
 * 2. Query agent APIs using those IDs to determine real state
 * 3. Update indicators based on actual session state
 */
export class AgentSessionTracker {
  private sessions = new Map<string, TrackedSession>()
  private listeners = new Set<SessionStatusListener>()
  private lastStatuses = new Map<string, TerminalRuntimeStatus | null>()

  trackSession(
    termId: string,
    agentName: AgentName,
    options: {
      sessionId?: string
      threadId?: string
    } = {},
  ) {
    const now = Date.now()
    const session: TrackedSession = {
      termId,
      agentName,
      sessionId: options.sessionId,
      threadId: options.threadId,
      startedAt: now,
      lastActivityAt: now,
      isActive: true,
      hasError: false,
      detail: 'Ready',
    }

    this.sessions.set(termId, session)
    this.notifyStatusChange(termId, this.buildStatus(session))
  }

  endSession(termId: string, detail = 'Completed') {
    const session = this.sessions.get(termId)
    if (!session) return

    session.isActive = false
    session.detail = detail

    // Emit final status
    this.notifyStatusChange(termId, this.buildStatus(session))

    // Remove after a brief delay to let UI update
    setTimeout(() => {
      this.sessions.delete(termId)
      this.lastStatuses.delete(termId)
    }, 1000)
  }

  markError(termId: string, detail: string) {
    const session = this.sessions.get(termId)
    if (!session) return

    session.hasError = true
    session.detail = detail
    this.notifyStatusChange(termId, this.buildStatus(session))
  }

  markWaiting(termId: string, detail = 'Waiting for input') {
    const session = this.sessions.get(termId)
    if (!session) return

    session.isActive = false
    session.detail = detail
    this.notifyStatusChange(termId, this.buildStatus(session))
  }

  markWorking(termId: string, detail = 'Working') {
    const session = this.sessions.get(termId)
    if (!session) return

    session.isActive = true
    session.lastActivityAt = Date.now()
    session.detail = detail
    this.notifyStatusChange(termId, this.buildStatus(session))
  }

  untrackSession(termId: string) {
    this.sessions.delete(termId)
    this.lastStatuses.delete(termId)
  }

  subscribe(listener: SessionStatusListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getStatus(termId: string): TerminalRuntimeStatus | null {
    return this.lastStatuses.get(termId) ?? null
  }

  stop() {
    this.sessions.clear()
    this.listeners.clear()
    this.lastStatuses.clear()
  }

  private buildStatus(session: TrackedSession): TerminalRuntimeStatus | null {
    if (session.hasError) {
      return {
        kind: 'agent',
        agent: session.agentName,
        state: 'error',
        detail: session.detail,
        shortLabel: 'Error',
        source: 'session:error',
        updatedAt: Date.now(),
      }
    }

    let state: AgentRuntimeState = 'working'
    let shortLabel = 'Working'

    if (!session.isActive) {
      // Check if session completed or is waiting
      if (
        session.detail.toLowerCase().includes('done') ||
        session.detail.toLowerCase().includes('completed')
      ) {
        state = 'done'
        shortLabel = 'Done'
      } else if (session.detail.toLowerCase().includes('waiting')) {
        state = 'waiting'
        shortLabel = 'Waiting'
      }
    }

    return {
      kind: 'agent',
      agent: session.agentName,
      state,
      detail: session.detail,
      shortLabel,
      source: 'session:tracked',
      updatedAt: Date.now(),
    }
  }

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

  private statusEqual(
    a: TerminalRuntimeStatus | null | undefined,
    b: TerminalRuntimeStatus | null | undefined,
  ): boolean {
    if ((a == null) !== (b == null)) return false
    if (a == null || b == null) return true
    return (
      a.agent === b.agent && a.state === b.state && a.detail === b.detail && a.source === b.source
    )
  }
}
