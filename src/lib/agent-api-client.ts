/**
 * Agent API Clients
 *
 * Query actual agent session APIs to get real status instead of guessing.
 * Each agent type has its own API for querying session state.
 */

export type AgentSessionState = 'active' | 'waiting' | 'completed' | 'error' | 'unknown'

export interface AgentSessionStatus {
  state: AgentSessionState
  detail: string
  lastActivity?: number
}

/**
 * Query Claude session status via Claude's session API
 */
export async function queryClaudeSessionStatus(
  sessionId: string,
): Promise<AgentSessionStatus | null> {
  try {
    // Claude sessions are typically tracked via the Claude CLI or local state
    // For now, we return null to indicate we need external API support
    // In production, this would query: https://api.claude.ai/sessions/{sessionId}
    // But that requires authentication and proper API setup

    // Return null to fall back to process-based detection
    return null
  } catch {
    return null
  }
}

/**
 * Query Codex thread status
 */
export async function queryCodexSessionStatus(
  threadId: string,
): Promise<AgentSessionStatus | null> {
  try {
    // Codex threads have their own API endpoint
    // Similar to Claude, this would require proper authentication
    return null
  } catch {
    return null
  }
}

/**
 * Query OpenCode session status
 */
export async function queryOpenCodeSessionStatus(
  sessionId: string,
): Promise<AgentSessionStatus | null> {
  try {
    // OpenCode has its own session tracking
    return null
  } catch {
    return null
  }
}

/**
 * Query Pi agent status
 */
export async function queryPiSessionStatus(sessionId: string): Promise<AgentSessionStatus | null> {
  try {
    // Pi agent status tracking
    return null
  } catch {
    return null
  }
}

/**
 * Unified API to query any agent session
 */
export async function queryAgentSessionStatus(
  agentName: string,
  sessionId: string | undefined,
): Promise<AgentSessionStatus | null> {
  if (!sessionId) return null

  switch (agentName) {
    case 'claude':
      return queryClaudeSessionStatus(sessionId)
    case 'codex':
      return queryCodexSessionStatus(sessionId)
    case 'opencode':
      return queryOpenCodeSessionStatus(sessionId)
    case 'pi':
      return queryPiSessionStatus(sessionId)
    default:
      return null
  }
}
