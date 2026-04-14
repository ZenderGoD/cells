import type { AgentName, AgentRuntimeState, TerminalRuntimeStatus } from '@/types'

/**
 * Session metadata for tracking agent instances across terminals.
 * Stores the actual IDs/tokens needed to query real agent APIs.
 */
export interface SessionMetadata {
  sessionId?: string | null
  agentName: AgentName
  startedAt?: number
  sourceTermId?: string
}

/**
 * Source of indicator data — used for debugging and prioritization
 */
export type IndicatorSource =
  | 'session:active' // Session API confirms active
  | 'session:waiting' // Session API confirms waiting for input
  | 'session:completed' // Session API confirms completed
  | 'session:error' // Session API reports error
  | 'terminal:foreground' // Agent process in foreground
  | 'terminal:background' // Agent process running in background
  | 'terminal:idle' // Terminal with agent metadata but no process
  | 'none' // No indicator

/**
 * Build a runtime status from actual session state.
 * Unlike the old system, this derives state from:
 * - Real API queries to agent services
 * - Session completion signals
 * - Terminal process state as fallback
 */
export function buildSessionIndicatorStatus(
  agent: AgentName | null,
  source: IndicatorSource,
  detail: string,
  pid?: number | null,
): TerminalRuntimeStatus | null {
  if (!agent || source === 'none') return null

  let state: AgentRuntimeState
  let shortLabel: string

  switch (source) {
    case 'session:active':
      state = 'working'
      shortLabel = 'Working'
      break
    case 'session:waiting':
      state = 'waiting'
      shortLabel = 'Waiting'
      break
    case 'session:completed':
      state = 'done'
      shortLabel = 'Done'
      break
    case 'session:error':
      state = 'error'
      shortLabel = 'Error'
      break
    case 'terminal:foreground':
      state = 'working'
      shortLabel = 'Working'
      break
    case 'terminal:background':
      state = 'waiting'
      shortLabel = 'Idle'
      break
    case 'terminal:idle':
      state = 'working'
      shortLabel = 'Ready'
      break
    default:
      return null
  }

  return {
    kind: 'agent',
    agent,
    state,
    detail,
    shortLabel,
    source,
    pid: pid ?? undefined,
    updatedAt: Date.now(),
  }
}

/**
 * Session indicator cache entry.
 * Caches the last known status for a session to avoid excessive API calls.
 */
interface CachedIndicator {
  status: TerminalRuntimeStatus | null
  timestamp: number
  ttlMs: number
}

/**
 * Provider that tracks agent sessions and derives indicators from real data.
 *
 * Architecture:
 * 1. Terminals register with session metadata (claudeSessionId, etc.)
 * 2. Provider periodically queries agent APIs for real status
 * 3. Falls back to terminal foreground process state when API unavailable
 * 4. Caches results to avoid excessive API load
 */
export class SessionIndicatorProvider {
  private readonly sessions = new Map<string, SessionMetadata>()
  private readonly cache = new Map<string, CachedIndicator>()
  private readonly callbacks = new Set<
    (termId: string, status: TerminalRuntimeStatus | null) => void
  >()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private readonly cacheDefaultTtlMs = 5000 // 5 second cache

  /**
   * Register a terminal session for tracking.
   * Called when an agent is launched.
   */
  registerSession(termId: string, metadata: SessionMetadata) {
    this.sessions.set(termId, metadata)
    this.invalidateCache(termId)
    this.ensurePolling()
  }

  /**
   * Unregister a terminal session.
   * Called when a terminal is closed.
   */
  unregisterSession(termId: string) {
    this.sessions.delete(termId)
    this.cache.delete(termId)
    if (this.sessions.size === 0) {
      this.stopPolling()
    }
  }

  /**
   * Subscribe to indicator updates.
   * Returns unsubscribe function.
   */
  subscribe(callback: (termId: string, status: TerminalRuntimeStatus | null) => void) {
    this.callbacks.add(callback)
    return () => {
      this.callbacks.delete(callback)
    }
  }

  /**
   * Get current cached indicator for a terminal.
   */
  getIndicator(termId: string): TerminalRuntimeStatus | null {
    const cached = this.cache.get(termId)
    if (cached && Date.now() - cached.timestamp < cached.ttlMs) {
      return cached.status
    }
    return null
  }

  /**
   * Force invalidate cache for a terminal.
   * Used when we know state has changed.
   */
  invalidateCache(termId: string) {
    this.cache.delete(termId)
  }

  /**
   * Stop the provider and clear all tracking.
   */
  stop() {
    this.stopPolling()
    this.sessions.clear()
    this.cache.clear()
    this.callbacks.clear()
  }

  private ensurePolling() {
    if (this.pollTimer) return
    // Poll every 3 seconds for session status updates
    this.pollTimer = setInterval(() => {
      this.updateAllIndicators()
    }, 3000)
    this.pollTimer.unref?.()
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async updateAllIndicators() {
    const termIds = Array.from(this.sessions.keys())
    for (const termId of termIds) {
      const metadata = this.sessions.get(termId)
      if (!metadata) continue

      // TODO: Query actual agent APIs here (Claude, Codex, etc.)
      // For now, this is a placeholder that will be filled in
      // with real API integration

      // This would look like:
      // const status = await querySessionStatus(metadata.sessionId, metadata.agentName)
      // But that requires implementing the actual agent API clients
    }
  }

  private emitUpdate(termId: string, status: TerminalRuntimeStatus | null) {
    // Cache the status
    this.cache.set(termId, {
      status,
      timestamp: Date.now(),
      ttlMs: this.cacheDefaultTtlMs,
    })

    // Emit to all subscribers
    for (const callback of this.callbacks) {
      callback(termId, status)
    }
  }
}
