import type { AgentStatus } from '@/types'

/**
 * Centralized status indicator styles for terminals and windows.
 *
 * Determines the visual indicator based on:
 *   - agentStatus: 'active' | 'unread' | 'done' | null
 *   - agent: whether this terminal is running an agent (claude/codex)
 *   - processRunning: whether a non-shell process is running
 *
 * Rules:
 *   1. Agent status always takes priority when set
 *   2. processRunning only shows for non-agent terminals
 *   3. No indicator when agent is idle and user has seen it (null)
 */

export interface StatusIndicator {
  /** Tailwind ring classes for minimap/window borders */
  ringClass: string
  /** Tailwind classes for a small dot (toolbar, switcher) */
  dotClass: string
  /** Accessible label */
  label: string
}

const NONE: StatusIndicator = { ringClass: '', dotClass: '', label: '' }

const ACTIVE: StatusIndicator = {
  ringClass: 'ring-1 ring-primary/80 animate-pulse',
  dotClass: 'bg-primary/90 animate-pulse',
  label: 'Agent working',
}

const UNREAD: StatusIndicator = {
  ringClass: 'ring-1 ring-amber-500/50',
  dotClass: 'bg-amber-500/70',
  label: 'Agent has unread output',
}

const DONE: StatusIndicator = {
  ringClass: 'ring-1 ring-emerald-400/90',
  dotClass: 'bg-emerald-400',
  label: 'Agent finished',
}

const PROCESS: StatusIndicator = {
  ringClass: 'ring-1 ring-white/15',
  dotClass: 'bg-white/20',
  label: 'Process running',
}

export function getStatusIndicator(
  agentStatus: AgentStatus | undefined,
  agent: string | null | undefined,
  processRunning: boolean | undefined,
): StatusIndicator {
  if (agentStatus === 'active') return ACTIVE
  if (agentStatus === 'unread') return UNREAD
  if (agentStatus === 'done') return DONE
  if (!agent && processRunning) return PROCESS
  return NONE
}
