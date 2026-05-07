import { useEffect } from 'react'
import type { AgentSessionQueueReport, AgentWindowNode } from '@/types'
import { useStore } from '@/lib/store'
import {
  areQueuedMessagesEqual,
  buildAgentSessionQueueReport,
  sanitizeQueuedMessages,
} from '@/lib/agent-session-queue'

function collectAgentWindows(): AgentWindowNode[] {
  const state = useStore.getState()
  const windows = new Map<string, AgentWindowNode>()
  for (const project of state.projects) {
    for (const agentWindow of project.agentWindows ?? []) {
      windows.set(agentWindow.id, agentWindow)
    }
  }
  for (const agentWindow of state.agentWindows) {
    windows.set(agentWindow.id, agentWindow)
  }
  return [...windows.values()]
}

function reportSignature(report: AgentSessionQueueReport, agentWindow: AgentWindowNode) {
  return JSON.stringify({
    report,
    status: agentWindow.status ?? null,
  })
}

export function AgentQueueReporter() {
  useEffect(() => {
    const lastReported = new Map<string, string>()

    const push = () => {
      const reports: AgentSessionQueueReport[] = []
      let changed = false

      for (const agentWindow of collectAgentWindows()) {
        const sanitized = sanitizeQueuedMessages(agentWindow.queuedMessages ?? [])
        if (!areQueuedMessagesEqual(agentWindow.queuedMessages ?? [], sanitized)) {
          useStore.getState().syncAgentWindow(agentWindow.id, { queuedMessages: sanitized })
        }

        const report = buildAgentSessionQueueReport({
          ...agentWindow,
          queuedMessages: sanitized,
        })
        reports.push(report)

        const signature = reportSignature(report, agentWindow)
        if (lastReported.get(agentWindow.id) !== signature) {
          lastReported.set(agentWindow.id, signature)
          changed = true
        }
      }

      if (changed) {
        window.cells.agentSession.reportQueues(reports)
      }
    }

    push()
    return useStore.subscribe(push)
  }, [])

  useEffect(() => {
    return window.cells.agentSession.onQueueUpdate(({ windowId, queuedMessages }) => {
      const sanitized = sanitizeQueuedMessages(queuedMessages)
      const state = useStore.getState()
      const activeWindow = state.agentWindows.find((agentWindow) => agentWindow.id === windowId)
      const projectWindow =
        activeWindow ??
        state.projects
          .flatMap((project) => project.agentWindows ?? [])
          .find((agentWindow) => agentWindow.id === windowId)
      if (!projectWindow) return
      if (areQueuedMessagesEqual(projectWindow.queuedMessages ?? [], sanitized)) return
      state.syncAgentWindow(windowId, { queuedMessages: sanitized })
    })
  }, [])

  return null
}
