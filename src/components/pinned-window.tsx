import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownLeft } from 'lucide-react'
import { CellTerminal } from './terminal/cell-terminal'
import { AgentChatPanel } from './agent-session/agent-chat-panel'
import { useStore } from '@/lib/store'
import { getTerminalTheme } from '@/lib/terminal-themes'
import { hapticBuzz } from '@/lib/haptics'
import { getStatusPresentation } from '@/lib/status-indicator'
import { inferAgentFromTitle } from '@/lib/agent-command'
import { hasPrimaryModifier } from '@/lib/keyboard-shortcuts'
import { cn } from '@/lib/utils'
import type { AgentWindowNode, BrowserNode, TerminalNode } from '@/types'

const TITLE_BAR_HEIGHT = 38

type PinnedSectionNode =
  | { kind: 'terminal'; node: TerminalNode }
  | { kind: 'agent'; node: AgentWindowNode }
  | { kind: 'browser'; node: BrowserNode }

export function PinnedWindow({
  termId,
  type,
}: {
  termId: string
  type: 'terminal' | 'browser' | 'agent' | 'section'
}) {
  const init = useStore((s) => s.init)
  const initialized = useStore((s) => s.initialized)
  const themeName = useStore((s) => s.terminalTheme)
  const projects = useStore((s) => s.projects)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({
    width: window.innerWidth,
    height: Math.max(0, window.innerHeight - TITLE_BAR_HEIGHT),
  })
  const customTitle = useStore((s) =>
    type === 'agent'
      ? (s.agentWindows.find((a) => a.id === termId)?.customTitle ?? null)
      : type === 'terminal'
        ? (s.terminals.find((t) => t.id === termId)?.customTitle ?? null)
        : null,
  )
  const terminal = useStore((s) =>
    type === 'terminal' ? (s.terminals.find((t) => t.id === termId) ?? null) : null,
  )
  const agentWindow = useStore((s) =>
    type === 'agent' ? (s.agentWindows.find((a) => a.id === termId) ?? null) : null,
  )
  const section = useStore((s) =>
    type === 'section' ? (s.windowSections.find((entry) => entry.id === termId) ?? null) : null,
  )
  const [inferredTitle, setInferredTitle] = useState(type === 'agent' ? 'Agent' : 'Terminal')
  const [agentReloadKey, setAgentReloadKey] = useState(0)
  const title = section?.name || customTitle || agentWindow?.title || inferredTitle
  const status = getStatusPresentation(terminal?.runtimeStatus, {
    agent: terminal?.agent ?? inferAgentFromTitle(title),
    agentStatus: terminal?.agentStatus,
    processRunning: terminal?.processRunning,
  })

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => {
    document.title = title
  }, [title])

  useEffect(() => {
    const off = window.cells.app.onWindowResized((id, _type, width, height) => {
      if (id !== termId) return
      setSize({
        width: Math.max(0, Math.round(width)),
        height: Math.max(0, Math.round(height)),
      })
    })
    return () => off()
  }, [termId])

  useEffect(() => {
    if (type !== 'agent') return
    let active = true
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 'r' ||
        !hasPrimaryModifier(event) ||
        event.shiftKey ||
        event.altKey
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      void (async () => {
        try {
          await window.cells.agentSession.close(termId)
          await window.cells.agentSession.dispose(termId)
        } catch (err) {
          console.error('[pinned-window] agent reload failed', err)
        } finally {
          if (active) setAgentReloadKey((key) => key + 1)
        }
      })()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      active = false
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [termId, type])

  if (!initialized) return null

  const theme = getTerminalTheme(themeName)
  const terminalProject =
    type === 'terminal'
      ? projects.find((project) => project.terminals.some((terminal) => terminal.id === termId))
      : null

  // Browser pop-outs are handled by the main process (loads URL directly),
  // so this component only renders for terminal and agent pop-outs.
  if (type === 'browser') return null

  return (
    <div
      className="w-screen h-screen flex flex-col overflow-hidden"
      style={{ background: theme.background }}
    >
      {/* Custom title bar */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: TITLE_BAR_HEIGHT,
          background: theme.background,
          borderBottom: `1px solid ${theme.foreground}12`,
          // @ts-expect-error -- Electron-specific CSS
          WebkitAppRegion: 'drag',
        }}
      >
        {/* Spacer for traffic lights */}
        <div className="w-[78px] shrink-0" />

        <div className="flex flex-1 items-center justify-center gap-2 px-3 min-w-0">
          <span
            className="min-w-0 truncate text-center text-[11px] font-medium select-none"
            style={{ color: theme.foreground, opacity: 0.5 }}
          >
            {title}
          </span>
          {status.detail ? (
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none',
                status.pillClass,
              )}
              title={status.label}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', status.dotClass)} />
              <span className="truncate max-w-40">{status.detail}</span>
            </span>
          ) : null}
        </div>

        <div
          className="flex items-center gap-1 px-3 shrink-0"
          style={{
            // @ts-expect-error -- Electron-specific CSS
            WebkitAppRegion: 'no-drag',
          }}
        >
          <button
            onClick={() => {
              hapticBuzz()
              void window.cells.app.unpinWindow(termId)
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] transition-colors"
            style={{ color: `${theme.foreground}80` }}
            onMouseEnter={(e) => (e.currentTarget.style.color = theme.foreground)}
            onMouseLeave={(e) => (e.currentTarget.style.color = `${theme.foreground}80`)}
            title="Pop back into canvas"
          >
            <ArrowDownLeft className="w-3 h-3" />
            Pop in
          </button>
        </div>
      </div>

      {/* Content */}
      <div
        ref={contentRef}
        className="flex-1 min-h-0 min-w-0"
        style={{ background: type === 'agent' ? undefined : theme.background }}
      >
        {type === 'agent' ? (
          agentWindow ? (
            <div className="h-full w-full bg-gradient-to-b from-background/30 to-background/55">
              <AgentChatPanel key={agentReloadKey} agentWindow={agentWindow} />
            </div>
          ) : null
        ) : type === 'section' ? (
          section ? (
            <PinnedSectionContent sectionId={section.id} size={size} />
          ) : null
        ) : (
          <CellTerminal
            termId={termId}
            width={size.width}
            height={size.height}
            isVisible={true}
            isFocused={true}
            projectId={terminalProject?.id ?? null}
            projectPath={terminalProject?.path ?? null}
            onTitleChange={(newTitle) => {
              setInferredTitle(newTitle)
              document.title = customTitle || newTitle
            }}
          />
        )}
      </div>
    </div>
  )
}

function PinnedSectionContent({
  sectionId,
  size,
}: {
  sectionId: string
  size: { width: number; height: number }
}) {
  const section = useStore((s) => s.windowSections.find((entry) => entry.id === sectionId) ?? null)
  const terminals = useStore((s) => s.terminals)
  const browsers = useStore((s) => s.browsers)
  const agentWindows = useStore((s) => s.agentWindows)
  const projects = useStore((s) => s.projects)
  const focusedTerminalId = useStore((s) => s.focusedTerminalId)

  const nodes = useMemo<PinnedSectionNode[]>(() => {
    if (!section) return []
    return section.windowIds
      .map((id) => {
        const terminal = terminals.find((entry) => entry.id === id)
        if (terminal) return { kind: 'terminal' as const, node: terminal }
        const agentWindow = agentWindows.find((entry) => entry.id === id)
        if (agentWindow) return { kind: 'agent' as const, node: agentWindow }
        const browser = browsers.find((entry) => entry.id === id)
        if (browser) return { kind: 'browser' as const, node: browser }
        return null
      })
      .filter((entry): entry is PinnedSectionNode => Boolean(entry))
      .sort((left, right) => (left.node.zIndex ?? 0) - (right.node.zIndex ?? 0))
  }, [agentWindows, browsers, section, terminals])

  if (!section) return null

  const baseWidth = Math.max(1, section.width ?? size.width)
  const baseHeight = Math.max(1, section.height ?? size.height)
  const scaleX = size.width / baseWidth
  const scaleY = size.height / baseHeight

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      {nodes.map((entry) => {
        if (!entry) return null
        const node = entry.node
        const left = (node.x - section.x) * scaleX
        const top = (node.y - section.y) * scaleY
        const width = Math.max(1, node.width * scaleX)
        const height = Math.max(1, node.height * scaleY)
        const style = {
          left,
          top,
          width,
          height,
          zIndex: node.zIndex ?? 1,
        }

        if (entry.kind === 'terminal') {
          const project = projects.find((candidate) =>
            candidate.terminals.some((terminal) => terminal.id === node.id),
          )
          return (
            <div key={node.id} className="absolute overflow-hidden rounded-md" style={style}>
              <CellTerminal
                termId={node.id}
                width={width}
                height={height}
                isVisible={true}
                isFocused={focusedTerminalId === node.id}
                projectId={project?.id ?? null}
                projectPath={project?.path ?? null}
              />
            </div>
          )
        }

        if (entry.kind === 'agent') {
          const agentNode = entry.node
          return (
            <div
              key={agentNode.id}
              className="absolute overflow-hidden rounded-md bg-gradient-to-b from-background/30 to-background/55"
              style={style}
            >
              <AgentChatPanel agentWindow={agentNode} />
            </div>
          )
        }

        const browserNode = entry.node
        return (
          <div
            key={browserNode.id}
            className="absolute flex flex-col overflow-hidden rounded-md border border-border/50 bg-card/80"
            style={style}
          >
            <div className="border-b border-border/40 px-3 py-2 text-[11px] font-medium text-foreground/75">
              {browserNode.title || 'Browser'}
            </div>
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
              <div className="text-xs font-medium text-foreground/75">Browser in section</div>
              <div className="max-w-72 truncate text-[11px] text-muted-foreground/60">
                {browserNode.url}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
