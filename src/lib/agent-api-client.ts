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
 *
 * TODO: Implement Claude API integration
 * - Requires: Claude API auth token (from env or secure storage)
 * - Endpoint: https://api.claude.ai/sessions/{sessionId}
 * - Maps API response to AgentSessionStatus
 * - Returns null on error (process state monitoring provides fallback)
 */
export async function queryClaudeSessionStatus(
  sessionId: string,
): Promise<AgentSessionStatus | null> {
  // Stub: Returns null for now, process-based detection handles it
  // TODO: Implement actual API call
  return null
}

/**
 * Query Codex thread status
 *
 * TODO: Implement Codex API integration
 * - Query Codex thread API with threadId
 * - Maps thread status to AgentSessionStatus
 * - Returns null on error (process state monitoring provides fallback)
 */
export async function queryCodexSessionStatus(
  threadId: string,
): Promise<AgentSessionStatus | null> {
  // Stub: Returns null for now, process-based detection handles it
  // TODO: Implement actual API call
  return null
}

/**
 * Query OpenCode session status
 *
 * TODO: Implement OpenCode API integration
 * - Query OpenCode session API with sessionId
 * - Maps session status to AgentSessionStatus
 * - Returns null on error (process state monitoring provides fallback)
 */
export async function queryOpenCodeSessionStatus(
  sessionId: string,
): Promise<AgentSessionStatus | null> {
  // Stub: Returns null for now, process-based detection handles it
  // TODO: Implement actual API call
  return null
}

/**
 * Query Pi agent status
 *
 * TODO: Implement Pi API integration
 * - Query Pi agent API with sessionId
 * - Maps agent status to AgentSessionStatus
 * - Returns null on error (process state monitoring provides fallback)
 */
export async function queryPiSessionStatus(sessionId: string): Promise<AgentSessionStatus | null> {
  // Stub: Returns null for now, process-based detection handles it
  // TODO: Implement actual API call
  return null
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
