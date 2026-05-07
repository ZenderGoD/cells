import { useEffect, useRef, useState } from 'react'
import type { AgentSessionSnapshot, AgentWindowNode } from '@/types'
import { deriveAgentSessionWindowStatus } from '@/lib/agent-session-activity'
import { useStore } from '@/lib/store'
import { useShallow } from 'zustand/react/shallow'

function shouldRunInBackground(agentWindow: AgentWindowNode) {
  return (
    Boolean(agentWindow.initialPrompt) ||
    (agentWindow.queuedMessages?.length ?? 0) > 0 ||
    (agentWindow.status ?? 'idle') !== 'idle'
  )
}

function BackgroundAgentSessionRunner({ agentWindow }: { agentWindow: AgentWindowNode }) {
  const [snapshot, setSnapshot] = useState<AgentSessionSnapshot | null>(null)
  const windowIdRef = useRef(agentWindow.id)
  const snapshotRef = useRef<AgentSessionSnapshot | null>(null)
  const prevDerivedStatusRef = useRef(agentWindow.status ?? null)
  const pendingSnapshotRef = useRef<AgentSessionSnapshot | null>(null)
  const pendingFrameRef = useRef<number | null>(null)

  useEffect(() => {
    windowIdRef.current = agentWindow.id
  }, [agentWindow.id])

  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  useEffect(() => {
    let cancelled = false

    const applySnapshot = (next: AgentSessionSnapshot) => {
      if (cancelled || next.windowId !== agentWindow.id) return
      snapshotRef.current = next
      setSnapshot(next)

      const shouldClearInitialPrompt =
        Boolean(agentWindow.initialPrompt) &&
        (next.messages.some((message) => message.role === 'user') ||
          next.status === 'running' ||
          Boolean(next.claudeSessionId) ||
          Boolean(next.codexThreadId) ||
          Boolean(next.cursorAgentId) ||
          Boolean(next.copilotSessionId) ||
          Boolean(next.opencodeSessionId))
      const derivedStatus = deriveAgentSessionWindowStatus(next)
      const prevStatus = prevDerivedStatusRef.current
      prevDerivedStatusRef.current = derivedStatus
      const justCompleted = prevStatus !== null && prevStatus !== 'idle' && derivedStatus === 'idle'
      const storeState = useStore.getState()
      const isViewed =
        storeState.appWindowFocused && storeState.focusedAgentWindowId === agentWindow.id
      const patch: Partial<AgentWindowNode> = {
        title: next.title,
        cwd: next.cwd ?? agentWindow.cwd ?? null,
        status: derivedStatus,
        error: next.error ?? null,
        claudeSessionId: next.claudeSessionId ?? null,
        codexThreadId: next.codexThreadId ?? null,
        cursorAgentId: next.cursorAgentId ?? null,
        cursorRunId: next.cursorRunId ?? null,
        copilotSessionId: next.copilotSessionId ?? null,
        opencodeSessionId: next.opencodeSessionId ?? null,
        initialPrompt: shouldClearInitialPrompt ? null : (agentWindow.initialPrompt ?? null),
      }
      if (justCompleted && !isViewed) {
        patch.hasUnviewedCompletion = true
      }
      storeState.syncAgentWindow(agentWindow.id, patch)
    }

    const sync = (next: AgentSessionSnapshot) => {
      if (next.windowId !== agentWindow.id) return
      pendingSnapshotRef.current = next
      if (pendingFrameRef.current !== null) return
      pendingFrameRef.current = window.requestAnimationFrame(() => {
        pendingFrameRef.current = null
        const pending = pendingSnapshotRef.current
        pendingSnapshotRef.current = null
        if (pending) applySnapshot(pending)
      })
    }

    const ensureArgs = {
      windowId: agentWindow.id,
      agent: agentWindow.agent,
      title: agentWindow.customTitle || agentWindow.title,
      cwd: agentWindow.cwd ?? null,
      initialPrompt: agentWindow.initialPrompt ?? null,
      claudeSessionId: agentWindow.claudeSessionId ?? null,
      codexThreadId: agentWindow.codexThreadId ?? null,
      cursorAgentId: agentWindow.cursorAgentId ?? null,
      cursorRunId: agentWindow.cursorRunId ?? null,
      copilotSessionId: agentWindow.copilotSessionId ?? null,
      opencodeSessionId: agentWindow.opencodeSessionId ?? null,
      model: agentWindow.model ?? null,
      permissionMode: agentWindow.permissionMode ?? null,
      thinkingLevel: agentWindow.thinkingLevel ?? null,
      contextLength: agentWindow.contextLength ?? null,
    }

    let subscribed = false
    void window.cells.agentSession
      .subscribeUpdates(agentWindow.id)
      .then(() => {
        subscribed = true
        if (cancelled) {
          void window.cells.agentSession.unsubscribeUpdates(agentWindow.id).catch(() => {})
          return
        }
        void window.cells.agentSession
          .ensure(ensureArgs)
          .then(sync)
          .catch((err) => console.error('[background-agent-session] ensure failed', err))
      })
      .catch((err) => {
        console.error('[background-agent-session] subscribeUpdates failed', err)
        if (!cancelled) {
          void window.cells.agentSession
            .ensure(ensureArgs)
            .then(sync)
            .catch((ensureErr) =>
              console.error('[background-agent-session] ensure failed', ensureErr),
            )
        }
      })

    const unsubscribe = window.cells.agentSession.onUpdate(sync)
    return () => {
      cancelled = true
      pendingSnapshotRef.current = null
      if (pendingFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingFrameRef.current)
        pendingFrameRef.current = null
      }
      unsubscribe()
      if (subscribed) {
        void window.cells.agentSession
          .unsubscribeUpdates(agentWindow.id)
          .catch((err) => console.error('[background-agent-session] unsubscribe failed', err))
      }
    }
  }, [
    agentWindow.agent,
    agentWindow.claudeSessionId,
    agentWindow.codexThreadId,
    agentWindow.cursorAgentId,
    agentWindow.cursorRunId,
    agentWindow.copilotSessionId,
    agentWindow.opencodeSessionId,
    agentWindow.contextLength,
    agentWindow.cwd,
    agentWindow.customTitle,
    agentWindow.id,
    agentWindow.initialPrompt,
    agentWindow.model,
    agentWindow.permissionMode,
    agentWindow.thinkingLevel,
    agentWindow.title,
  ])

  return null
}

export function BackgroundAgentSessionHosts() {
  const inactiveAgentWindows = useStore(
    useShallow((state) =>
      state.projects.flatMap((project) =>
        project.id === state.activeProjectId
          ? []
          : (project.agentWindows ?? []).filter(shouldRunInBackground),
      ),
    ),
  )

  return (
    <>
      {inactiveAgentWindows.map((agentWindow) => (
        <BackgroundAgentSessionRunner key={agentWindow.id} agentWindow={agentWindow} />
      ))}
    </>
  )
}
