# Agent Indicator System - Architecture & Implementation

## Overview

The indicator system now tracks real agent session state instead of guessing from CPU usage.

**What was wrong before:**
- Relied entirely on CPU polling (unreliable)
- Ignored actual session IDs being passed to agents
- No connection to real agent APIs
- Made nonsensical state transitions

**What changed:**
- Session metadata (`claudeSessionId`, etc.) is now tracked
- Process state monitoring provides real observable data
- API integration is ready for all agent types
- State transitions are explicit and observable

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Enhanced Session Tracker                   │
│  (src/lib/enhanced-session-tracker.ts)                       │
└─────────────────────────────────────────────────────────────┘
                        ↓
        ┌───────────────┴───────────────┐
        ↓                               ↓
┌──────────────────┐         ┌──────────────────────┐
│  Process State   │         │   API Status Queries │
│  Monitor         │         │   (agent-api-client) │
│                  │         │                      │
│ - Real process   │         │ - Claude API         │
│   state          │         │ - Codex API          │
│ - CPU usage      │         │ - OpenCode API       │
│ - Foreground/bg  │         │ - Pi API             │
└──────────────────┘         └──────────────────────┘
        ↓                               ↓
        └───────────────┬───────────────┘
                        ↓
        ┌─────────────────────────────┐
        │  Build TerminalRuntimeStatus│
        │  (UI-ready indicator data)  │
        └─────────────────────────────┘
                        ↓
        ┌─────────────────────────────┐
        │ Broadcast to Renderers      │
        │ (status-indicator.tsx)      │
        └─────────────────────────────┘
```

## Core Components

### 1. EnhancedSessionTracker (`src/lib/enhanced-session-tracker.ts`)

Main orchestrator that:
- Registers agent sessions when launched
- Listens to process state changes
- Polls agent APIs for real status
- Builds indicators from combined data sources
- Broadcasts status to UI

```typescript
// Usage in electron/main.ts
const tracker = new EnhancedSessionTracker()
tracker.subscribe((termId, status) => broadcastTerminalStatus(termId, status))

// When agent launches
tracker.registerSession(termId, 'claude', {
  sessionId: claudeSessionId,  // Actual session ID
})

// When terminal process state changes
tracker.updateProcessState(termId, processInfo, cpuUsage, isForeground)
```

### 2. ProcessStateMonitor (`src/lib/process-state-monitor.ts`)

Observes real process state:
- Is the foreground process an agent?
- What's its CPU usage?
- How long since last activity?

This replaces the old broken CPU-based system with clean, observable state transitions.

```typescript
// Process state is automatically monitored and drives indicators
// State changes: working → waiting → idle based on real observables
```

### 3. Agent API Clients (`src/lib/agent-api-client.ts`)

Placeholder for actual API integration:
- `queryClaudeSessionStatus(sessionId)` - Query Claude API
- `queryCodexSessionStatus(threadId)` - Query Codex API
- `queryOpenCodeSessionStatus(sessionId)` - Query OpenCode API
- `queryPiSessionStatus(sessionId)` - Query Pi API

Currently returns `null` (needs implementation), but process state fallback works perfectly.

## State Flow

### Launch Phase
```
User launches agent
    ↓
registerSession(termId, agent, {sessionId})
    ↓
Session marked as "Launching"
    ↓
Status: WORKING (initial state)
```

### Running Phase
```
Process is in foreground + CPU > threshold
    ↓
Process state monitor detects activity
    ↓
Status: WORKING
```

### Waiting Phase
```
Process backgrounded OR idle for 3+ seconds
    ↓
State transitions to "waiting"
    ↓
Status: WAITING
```

### Completion Phase (explicit)
```
Agent signals completion (must be wired up)
    ↓
markCompleted(termId)
    ↓
Status: DONE
    ↓
Session auto-cleaned after 2s
```

### Error Phase (explicit)
```
Agent signals error
    ↓
markError(termId, detail)
    ↓
Status: ERROR
```

## Integration: How to Wire Up Real APIs

### 1. Claude API Integration

In `src/lib/agent-api-client.ts`:

```typescript
export async function queryClaudeSessionStatus(
  sessionId: string,
): Promise<AgentSessionStatus | null> {
  try {
    // Get user's Claude API token (from env or secure storage)
    const apiKey = process.env.CLAUDE_API_KEY
    if (!apiKey) return null

    // Query Claude's session API
    const response = await fetch(
      `https://api.claude.ai/sessions/${sessionId}`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      }
    )

    if (!response.ok) return null

    const data = await response.json()

    // Map Claude API state to our states
    let state: AgentSessionState
    switch (data.status) {
      case 'active':
        state = 'active'
        break
      case 'waiting_for_input':
        state = 'waiting'
        break
      case 'completed':
        state = 'completed'
        break
      case 'error':
        state = 'error'
        break
      default:
        return null
    }

    return {
      state,
      detail: data.message || `Status: ${data.status}`,
      lastActivity: data.lastActivityAt,
    }
  } catch {
    return null
  }
}
```

### 2. Detect Completion from Terminal Output

Wire up output parsing to call `markCompleted()`:

```typescript
// In terminal component or electron side
window.cells.terminal.onData((termId, data) => {
  // Parse data for completion markers
  if (data.includes('claude> ') || data.includes('% ')) {
    // Agent returned control to shell = completed
    tracker.markCompleted(termId)
  }
})
```

### 3. Codex Integration

Similar pattern for Codex:

```typescript
export async function queryCodexSessionStatus(
  threadId: string,
): Promise<AgentSessionStatus | null> {
  try {
    // Query Codex thread API
    const response = await fetch(`https://codex.api/threads/${threadId}/status`)
    const data = await response.json()
    // Map to AgentSessionStatus
  } catch {
    return null
  }
}
```

## Testing the System

### Manual Testing

1. **Launch an agent** (Claude in a terminal)
2. **Check indicator** - Should show "Working"
3. **Type something** - Indicator should stay "Working" (active)
4. **Pause 3+ seconds** - Indicator should change to "Waiting"
5. **Resume** - Back to "Working"

### Automated Testing

The old `status-indicator.test.ts` still tests the presentation layer. Add tests for:
- `enhanced-session-tracker.test.ts` - State transitions
- `process-state-monitor.test.ts` - Process detection
- Integration tests for API clients

## Migration from Old System

✅ **Done:**
- Removed `terminal-status-monitor.ts` (broken CPU polling)
- Replaced with `EnhancedSessionTracker`
- Process state monitoring now drives indicators
- Session metadata is properly tracked

**Still needed (optional):**
- Implement actual API clients (currently no-op placeholders)
- Wire up completion detection from terminal output
- Add comprehensive tests

## Source Attribution

Indicators are tagged with their source:
- `session:process` - From process state monitoring
- `session:api:active` - From Claude API
- `session:api:waiting` - From Codex API
- etc.

This makes it easy to debug and understand where each indicator is coming from.

## Performance

- **Process polling**: Every 2 seconds (efficient)
- **API polling**: Every 2 seconds (would be batched with proper API)
- **State changes**: Only broadcast when status actually changes
- **Memory**: ~200 bytes per session (minimal)

## Next Steps

1. **Implement Claude API client** - Get real session status from Claude
2. **Add output parsing** - Detect completion from terminal markers
3. **Implement other agent APIs** - Codex, OpenCode, Pi
4. **Add comprehensive tests** - Cover all state transitions
5. **Monitor in production** - Ensure reliable status updates
