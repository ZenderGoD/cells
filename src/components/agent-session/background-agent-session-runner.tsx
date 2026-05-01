import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSessionSnapshot, AgentWindowNode, QueuedAgentMessage } from '@/types'
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

function sanitizeQueuedMessages(
  messages: QueuedAgentMessage[] | null | undefined,
): QueuedAgentMessage[] {
  return (messages ?? [])
    .filter(
      (message): message is QueuedAgentMessage =>
        Boolean(message) &&
        typeof message.text === 'string' &&
        Array.isArray(message.attachments) &&
        (message.mode === 'after-turn' || message.mode === 'after-tool' || message.mode === 'stop'),
    )
    .map((message) => ({
      ...message,
      attachments: message.attachments.filter((attachment): attachment is string =>
        typeof attachment === 'string' ? attachment.trim().length > 0 : false,
      ),
    }))
}

function getStoredAgentWindow(windowId: string): AgentWindowNode | null {
  const state = useStore.getState()
  const activeWindow = state.agentWindows.find((agentWindow) => agentWindow.id === windowId)
  if (activeWindow) return activeWindow
  for (const project of state.projects) {
    const projectWindow = (project.agentWindows ?? []).find(
      (agentWindow) => agentWindow.id === windowId,
    )
    if (projectWindow) return projectWindow
  }
  return null
}

function BackgroundAgentSessionRunner({ agentWindow }: { agentWindow: AgentWindowNode }) {
  const [snapshot, setSnapshot] = useState<AgentSessionSnapshot | null>(null)
  const windowIdRef = useRef(agentWindow.id)
  const snapshotRef = useRef<AgentSessionSnapshot | null>(null)
  const prevDerivedStatusRef = useRef(agentWindow.status ?? null)
  const pendingSnapshotRef = useRef<AgentSessionSnapshot | null>(null)
  const pendingFrameRef = useRef<number | null>(null)
  const sendingQueuedRef = useRef(false)
  const awaitingRunningRef = useRef(false)
  const seenCompletedToolsRef = useRef<Set<string>>(new Set())
  const afterToolFiredRef = useRef(false)
  const autoDrainBlockedRef = useRef(false)
  const initialSnapshotHandledRef = useRef(false)

  useEffect(() => {
    windowIdRef.current = agentWindow.id
  }, [agentWindow.id])

  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  const getQueuedMessagesSnapshot = useCallback(
    () => sanitizeQueuedMessages(getStoredAgentWindow(agentWindow.id)?.queuedMessages ?? []),
    [agentWindow.id],
  )

  const setQueuedMessages = useCallback(
    (updater: (prev: QueuedAgentMessage[]) => QueuedAgentMessage[]) => {
      const prev = getQueuedMessagesSnapshot()
      const next = sanitizeQueuedMessages(updater(prev))
      useStore.getState().syncAgentWindow(agentWindow.id, { queuedMessages: next })
    },
    [agentWindow.id, getQueuedMessagesSnapshot],
  )

  const ensureSession = useCallback(async () => {
    await window.cells.agentSession.ensure({
      windowId: agentWindow.id,
      agent: agentWindow.agent,
      title: agentWindow.customTitle || agentWindow.title,
      cwd: agentWindow.cwd ?? null,
      initialPrompt: null,
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
    })
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
    agentWindow.model,
    agentWindow.permissionMode,
    agentWindow.thinkingLevel,
    agentWindow.title,
  ])

  const sendToAgent = useCallback(
    async (message: QueuedAgentMessage) => {
      const overrides = {
        model: message.model,
        thinkingLevel: message.thinkingLevel,
        permissionMode: message.permissionMode,
      }
      const trySend = () =>
        window.cells.agentSession.send(
          windowIdRef.current,
          message.text,
          message.attachments,
          overrides,
          message.replyTo ?? null,
        )
      try {
        await trySend()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/Missing agent session/i.test(msg)) {
          try {
            await ensureSession()
            await trySend()
            return
          } catch (retryErr) {
            console.error('[background-agent-session] retry failed', retryErr)
          }
        }
        throw err
      }
    },
    [ensureSession],
  )

  const handleStop = useCallback(async () => {
    try {
      await window.cells.agentSession.close(windowIdRef.current)
    } catch (err) {
      console.error('[background-agent-session] stop failed', err)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const applySnapshot = (next: AgentSessionSnapshot) => {
      if (cancelled || next.windowId !== agentWindow.id) return
      snapshotRef.current = next
      setSnapshot(next)

      const queuedMessages = getQueuedMessagesSnapshot()
      if (!initialSnapshotHandledRef.current) {
        initialSnapshotHandledRef.current = true
        seenCompletedToolsRef.current = new Set(
          next.messages
            .filter((message) => message.role === 'tool' && message.status === 'completed')
            .map((message) => message.id),
        )
        if (next.restoredFromPersist) {
          const tail = next.messages[next.messages.length - 1]
          const tailIsUser = tail?.role === 'user'
          const hasPending = next.messages.some((message) => message.status === 'in_progress')
          if (tailIsUser || hasPending || queuedMessages.length > 0) {
            autoDrainBlockedRef.current = true
          }
        }
      }

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
    getQueuedMessagesSnapshot,
  ])

  useEffect(() => {
    if (snapshot?.status === 'running') awaitingRunningRef.current = false
  }, [snapshot?.status])

  useEffect(() => {
    if (snapshot?.status !== 'running') afterToolFiredRef.current = false
  }, [snapshot?.status])

  useEffect(() => {
    if (autoDrainBlockedRef.current) return
    const messages = snapshot?.messages
    if (!messages) return
    const nextSeen = new Set<string>()
    let hasNewCompletion = false
    for (const message of messages) {
      if (message.role !== 'tool' || message.status !== 'completed') continue
      nextSeen.add(message.id)
      if (!seenCompletedToolsRef.current.has(message.id)) hasNewCompletion = true
    }
    seenCompletedToolsRef.current = nextSeen
    if (!hasNewCompletion) return
    if (snapshot?.status !== 'running') return
    if (afterToolFiredRef.current) return
    if (getQueuedMessagesSnapshot()[0]?.mode !== 'after-tool') return
    afterToolFiredRef.current = true
    void handleStop()
  }, [getQueuedMessagesSnapshot, handleStop, snapshot?.messages, snapshot?.status])

  useEffect(() => {
    if (snapshot?.status !== 'idle') return
    if (autoDrainBlockedRef.current) return
    if (sendingQueuedRef.current || awaitingRunningRef.current) return
    const queuedMessages = getQueuedMessagesSnapshot()
    if (queuedMessages.length === 0) return
    const next = queuedMessages[0]
    sendingQueuedRef.current = true
    awaitingRunningRef.current = true
    setQueuedMessages((queue) => queue.slice(1))
    useStore.getState().syncAgentWindow(agentWindow.id, { status: 'running' })
    window.cells.agentSession.notifyQueuedStart(agentWindow.id)
    void sendToAgent(next)
      .catch((err) => {
        console.error('[background-agent-session] queued send failed', err)
        setQueuedMessages((queue) => [next, ...queue])
        awaitingRunningRef.current = false
        useStore.getState().syncAgentWindow(agentWindow.id, {
          status: deriveAgentSessionWindowStatus(snapshotRef.current),
        })
      })
      .finally(() => {
        sendingQueuedRef.current = false
      })
  }, [agentWindow.id, getQueuedMessagesSnapshot, sendToAgent, setQueuedMessages, snapshot?.status])

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
