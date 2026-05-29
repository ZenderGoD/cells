import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  ArrowUpRight,
  ChevronDown,
  ClipboardCopy,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestCreate,
  Globe2,
  HardDrive,
  Info,
  ListTodo,
  Loader2,
  PanelTop,
  PencilLine,
  RotateCcw,
  Search,
  SquareTerminal,
  XCircle,
} from 'lucide-react'
import type {
  AgentSessionMessage,
  AgentSessionSnapshot,
  AgentWindowNode,
  BrowserNode,
  GitWorktree,
  TerminalNode,
} from '@/types'
import { AgentIcon } from '@/components/agent-icon'
import { WorktreeManager } from '@/components/worktree-manager'
import { showToast } from '@/components/toast'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { BROWSER_SELECTION_INTRO } from '@/lib/browser-element-selection'
import { getAgentWindowStatusPresentation } from '@/lib/status-indicator'
import { hasDiffStats, type DiffStats } from '@/lib/tool-diff-stats'
import { useStore } from '@/lib/store'
import {
  findWorktreeForPath,
  formatWorktreeLocation,
  getWorktreeName,
  normalizeFsPath,
  shortenFsPath,
} from '@/lib/worktree-utils'
import { cn } from '@/lib/utils'

interface AgentOverviewChromeActions {
  title: string
  isPinned: boolean
  onRename: () => void
  onClearConversation: () => void
  onCloseSession: () => void
  onTogglePin: () => void
}

interface AgentOverviewPopoverProps {
  agentWindow: AgentWindowNode
  snapshot: AgentSessionSnapshot | null
  messages: AgentSessionMessage[]
  sessionDiffStats: DiffStats
  diffsPanelOpen: boolean
  isWindowFocused: boolean
  chromeActions: AgentOverviewChromeActions
  onToggleDiffs: () => void
}

interface TaskRow {
  id: string
  icon: ReactNode
  label: string
  detail?: string | null
  tone?: 'default' | 'attention' | 'danger'
  onSelect?: () => void
}

function agentDisplayName(agent: AgentWindowNode['agent']) {
  if (agent === 'claude') return 'Claude Code'
  if (agent === 'cursor') return 'Cursor'
  if (agent === 'copilot') return 'GitHub Copilot'
  if (agent === 'opencode') return 'OpenCode'
  return 'Codex'
}

function plural(count: number, singular: string, pluralLabel = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralLabel}`
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function compactPreview(value: string | null | undefined, fallback: string) {
  const preview = (value ?? '').replace(/\s+/g, ' ').trim()
  if (!preview) return fallback
  return preview.length > 74 ? `${preview.slice(0, 71).trimEnd()}...` : preview
}

function getToolPreview(message: AgentSessionMessage) {
  const metadata = parseJsonObject(message.metadata)
  const textObject = parseJsonObject(message.text)
  const command =
    typeof metadata?.command === 'string'
      ? metadata.command
      : typeof textObject?.command === 'string'
        ? textObject.command
        : null
  const description =
    typeof metadata?.description === 'string'
      ? metadata.description
      : typeof textObject?.description === 'string'
        ? textObject.description
        : null
  return compactPreview(description || command || message.title || message.text, 'Working')
}

function formatUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol === 'file:') return url.pathname
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return value
  }
}

function hostLabel(value: string) {
  try {
    const url = new URL(value)
    return url.hostname || value
  } catch {
    return value
  }
}

function sameOrNestedPath(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizeFsPath(left)
  const b = normalizeFsPath(right)
  if (!a || !b) return false
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function deriveTaskRows({
  snapshot,
  agentWindow,
  messages,
  terminals,
  cwd,
  snapToTerminal,
}: {
  snapshot: AgentSessionSnapshot | null
  agentWindow: AgentWindowNode
  messages: AgentSessionMessage[]
  terminals: TerminalNode[]
  cwd: string | null
  snapToTerminal: (id: string) => void
}): TaskRow[] {
  const rows: TaskRow[] = []
  if (snapshot?.pendingApproval) {
    rows.push({
      id: 'approval',
      icon: <Info className="size-3.5" />,
      label: snapshot.pendingApproval.title,
      detail:
        snapshot.pendingApproval.detail ?? snapshot.pendingApproval.reason ?? 'Approval needed',
      tone: 'attention',
    })
  }
  if (snapshot?.pendingQuestion) {
    rows.push({
      id: 'question',
      icon: <Info className="size-3.5" />,
      label:
        snapshot.pendingQuestion.questions.length === 1
          ? snapshot.pendingQuestion.questions[0]?.header || 'Question'
          : `${snapshot.pendingQuestion.questions.length} questions`,
      detail: snapshot.pendingQuestion.questions[0]?.question ?? 'Awaiting input',
      tone: 'attention',
    })
  }
  if (snapshot?.pendingPlanApproval) {
    rows.push({
      id: 'plan',
      icon: <ListTodo className="size-3.5" />,
      label: 'Plan ready',
      detail: compactPreview(snapshot.pendingPlanApproval.plan, 'Awaiting approval'),
      tone: 'attention',
    })
  }
  if (snapshot?.codexPlan?.items.length) {
    const completed = snapshot.codexPlan.items.filter((item) => item.completed).length
    const active = snapshot.codexPlan.items.find((item) => !item.completed)
    rows.push({
      id: 'codex-plan',
      icon: <ListTodo className="size-3.5" />,
      label: `Plan ${completed}/${snapshot.codexPlan.items.length}`,
      detail: active?.text ?? 'All plan items complete',
    })
  }
  const runningTools = messages
    .filter((message) => message.role === 'tool' && message.status === 'in_progress')
    .slice(-2)
    .reverse()
  for (const message of runningTools) {
    rows.push({
      id: `tool-${message.id}`,
      icon: <SquareTerminal className="size-3.5" />,
      label: message.title || 'Tool',
      detail: getToolPreview(message),
    })
  }
  const queuedCount = agentWindow.queuedMessages?.length ?? 0
  if (queuedCount > 0) {
    rows.push({
      id: 'queue',
      icon: <ListTodo className="size-3.5" />,
      label: plural(queuedCount, 'queued message'),
      detail: agentWindow.queuedMessages?.[0]?.text ?? null,
    })
  }
  const relatedTerminals = terminals
    .filter((terminal) => sameOrNestedPath(terminal.cwd, cwd))
    .filter((terminal) => terminal.processRunning || terminal.runtimeStatus)
    .slice(0, 2)
  for (const terminal of relatedTerminals) {
    rows.push({
      id: `terminal-${terminal.id}`,
      icon: <SquareTerminal className="size-3.5" />,
      label:
        terminal.runtimeStatus?.shortLabel ||
        terminal.runtimeStatus?.processLabel ||
        terminal.title,
      detail: terminal.runtimeStatus?.detail || terminal.customTitle || terminal.title,
      onSelect: () => snapToTerminal(terminal.id),
    })
  }
  return rows.slice(0, 5)
}

function getPrimaryBrowser({
  browsers,
  focusedBrowserId,
  focusHistory,
}: {
  browsers: BrowserNode[]
  focusedBrowserId: string | null
  focusHistory: string[]
}) {
  return (
    (focusedBrowserId ? browsers.find((browser) => browser.id === focusedBrowserId) : null) ??
    [...focusHistory]
      .reverse()
      .map((id) => browsers.find((browser) => browser.id === id))
      .find((browser): browser is BrowserNode => Boolean(browser)) ??
    browsers[0] ??
    null
  )
}

function OverviewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border/25 px-2 py-2 first:border-t-0">
      <div className="px-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground/55">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </section>
  )
}

function OverviewRow({
  icon,
  label,
  detail,
  trailing,
  onSelect,
  disabled,
  active,
  tone = 'default',
}: {
  icon: ReactNode
  label: string
  detail?: ReactNode
  trailing?: ReactNode
  onSelect?: () => void
  disabled?: boolean
  active?: boolean
  tone?: 'default' | 'attention' | 'danger'
}) {
  const content = (
    <>
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center text-muted-foreground/70',
          tone === 'attention' && 'text-amber-300/90',
          tone === 'danger' && 'text-red-300/90',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-[12.5px] font-medium text-foreground/90',
            disabled && 'text-muted-foreground/45',
            tone === 'danger' && !disabled && 'text-red-200',
          )}
        >
          {label}
        </span>
        {detail ? (
          <span className="mt-0.5 block truncate text-[10.5px] leading-3 text-muted-foreground/55">
            {detail}
          </span>
        ) : null}
      </span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </>
  )
  const className = cn(
    'flex min-h-8 w-full min-w-0 items-center gap-2 rounded-[7px] px-2 py-1.5 text-left transition-colors',
    active && 'bg-foreground/8',
    disabled
      ? 'cursor-default opacity-70'
      : onSelect
        ? 'hover:bg-foreground/6 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        : '',
  )

  if (!onSelect) return <div className={className}>{content}</div>
  return (
    <button type="button" disabled={disabled} onClick={onSelect} className={className}>
      {content}
    </button>
  )
}

function DiffCount({ stats }: { stats: DiffStats }) {
  const hasNumbers = stats.additions > 0 || stats.deletions > 0
  if (!hasNumbers && (stats.changedFiles ?? 0) > 0) {
    return (
      <span className="rounded-[5px] bg-foreground/6 px-1.5 py-0.5 text-[10.5px] tabular-nums text-muted-foreground/70">
        {plural(stats.changedFiles ?? 0, 'file')}
      </span>
    )
  }
  if (!hasNumbers) return null
  return (
    <span className="rounded-[5px] bg-foreground/6 px-1.5 py-0.5 text-[10.5px] tabular-nums">
      {stats.additions > 0 ? <span className="text-emerald-400/85">+{stats.additions}</span> : null}
      {stats.additions > 0 && stats.deletions > 0 ? (
        <span className="text-muted-foreground/35"> </span>
      ) : null}
      {stats.deletions > 0 ? <span className="text-rose-400/85">-{stats.deletions}</span> : null}
    </span>
  )
}

function StatusBadge({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-[6px] border px-1.5 text-[10.5px] font-medium',
        className,
      )}
    >
      {label}
    </span>
  )
}

export function AgentOverviewPopover({
  agentWindow,
  snapshot,
  messages,
  sessionDiffStats,
  diffsPanelOpen,
  isWindowFocused,
  chromeActions,
  onToggleDiffs,
}: AgentOverviewPopoverProps) {
  const [open, setOpen] = useState(false)
  const [worktreeStatus, setWorktreeStatus] = useState<GitWorktree | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const activeProjectPath = useStore((state) => state.getActiveProjectPath() ?? null)
  const worktrees = useStore((state) => state.worktrees)
  const isGitRepo = useStore((state) => state.isGitRepo)
  const worktreesLoading = useStore((state) => state.worktreesLoading)
  const refreshWorktrees = useStore((state) => state.refreshWorktrees)
  const setOverlayOpen = useStore((state) => state.setOverlayOpen)
  const focusedAgentWindowId = useStore((state) => state.focusedAgentWindowId)
  const terminals = useStore((state) => state.terminals)
  const browsers = useStore((state) => state.browsers)
  const focusedBrowserId = useStore((state) => state.focusedBrowserId)
  const focusHistory = useStore((state) => state.focusHistory)
  const snapToBrowser = useStore((state) => state.snapToBrowser)
  const snapToTerminal = useStore((state) => state.snapToTerminal)
  const addTerminalInWorktree = useStore((state) => state.addTerminalInWorktree)
  const owner = `agent-overview-${agentWindow.id}`
  const cwd = snapshot?.cwd ?? agentWindow.cwd ?? activeProjectPath ?? null
  const storedWorktree = useMemo(() => findWorktreeForPath(worktrees, cwd), [cwd, worktrees])
  const currentWorktree = worktreeStatus ?? storedWorktree
  const browser = useMemo(
    () => getPrimaryBrowser({ browsers, focusedBrowserId, focusHistory }),
    [browsers, focusHistory, focusedBrowserId],
  )
  const statusPresentation = getAgentWindowStatusPresentation(agentWindow.status, {
    hasUnviewedCompletion: agentWindow.hasUnviewedCompletion,
  })
  const hasSessionDiffs = hasDiffStats(sessionDiffStats)
  const sessionChangedFiles = sessionDiffStats.changedFiles ?? (hasSessionDiffs ? 1 : 0)
  const changedDetail = hasSessionDiffs
    ? `${plural(sessionChangedFiles, 'file')} edited in this session`
    : currentWorktree?.dirtyCount
      ? `${plural(currentWorktree.dirtyCount, 'dirty file')}`
      : 'Clean'
  const worktreeLabel =
    formatWorktreeLocation(currentWorktree, cwd) ?? (cwd ? shortenFsPath(cwd) : 'No workspace')
  const branchLabel = currentWorktree
    ? currentWorktree.branch
      ? getWorktreeName(currentWorktree)
      : 'Detached'
    : 'No branch'
  const branchDetail = currentWorktree?.upstream
    ? `${currentWorktree.upstream}${currentWorktree.ahead || currentWorktree.behind ? ` · +${currentWorktree.ahead ?? 0}/-${currentWorktree.behind ?? 0}` : ''}`
    : currentWorktree?.head
      ? currentWorktree.head.slice(0, 7)
      : null
  const taskRows = useMemo(
    () =>
      deriveTaskRows({
        snapshot,
        agentWindow,
        messages,
        terminals,
        cwd,
        snapToTerminal,
      }),
    [agentWindow, cwd, messages, snapshot, snapToTerminal, terminals],
  )
  const attachmentCount = useMemo(() => {
    const paths = new Set<string>()
    for (const message of messages) {
      for (const path of message.attachments ?? []) paths.add(path)
    }
    for (const path of agentWindow.composerAttachments ?? []) paths.add(path)
    return paths.size
  }, [agentWindow.composerAttachments, messages])
  const browserSelectionCount = useMemo(
    () => messages.filter((message) => message.text.includes(BROWSER_SELECTION_INTRO)).length,
    [messages],
  )
  const webSearchSeen = useMemo(
    () =>
      agentWindow.agent === 'codex' ||
      messages.some((message) => {
        const haystack = `${message.title ?? ''}\n${message.text ?? ''}`.toLowerCase()
        return haystack.includes('web search') || haystack.includes('web_search')
      }),
    [agentWindow.agent, messages],
  )
  const hasSources = webSearchSeen || browserSelectionCount > 0 || attachmentCount > 0
  const allowCloseRef = useRef(false)

  const forceClose = useCallback(() => {
    allowCloseRef.current = false
    setOpen(false)
    setOverlayOpen(owner, false)
  }, [owner, setOverlayOpen])

  useEffect(() => {
    return () => setOverlayOpen(owner, false)
  }, [owner, setOverlayOpen])

  useEffect(() => {
    forceClose()
    setWorktreeStatus(null)
    setStatusLoading(false)
  }, [agentWindow.id, forceClose])

  useEffect(() => {
    if (!open) return
    if (focusedAgentWindowId && focusedAgentWindowId !== agentWindow.id) forceClose()
  }, [agentWindow.id, focusedAgentWindowId, forceClose, open])

  useEffect(() => {
    if (!open) return
    void refreshWorktrees({ includeStatus: true })
  }, [open, refreshWorktrees])

  useEffect(() => {
    if (!open || !cwd) return
    let cancelled = false
    setStatusLoading(true)
    const statusPath = storedWorktree?.path ?? cwd
    window.cells.git
      .statusWorktree(statusPath)
      .then((status) => {
        if (!cancelled) setWorktreeStatus(status)
      })
      .catch(() => {
        if (!cancelled) setWorktreeStatus(null)
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, open, storedWorktree?.path])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && !allowCloseRef.current) return
      allowCloseRef.current = false
      setOpen(next)
      setOverlayOpen(owner, next)
    },
    [owner, setOverlayOpen],
  )

  const close = useCallback(() => {
    allowCloseRef.current = true
    handleOpenChange(false)
  }, [handleOpenChange])

  const runAction = useCallback((action: () => void) => {
    action()
  }, [])

  const openTerminalCommand = useCallback(
    (command: string, title: string) => {
      if (!cwd) return
      addTerminalInWorktree(command, title, cwd)
    },
    [addTerminalInWorktree, cwd],
  )

  const copyCwd = useCallback(() => {
    if (!cwd) return
    void navigator.clipboard.writeText(cwd).then(
      () => showToast('Copied working directory', 'info'),
      () => showToast('Could not copy working directory', 'error'),
    )
  }, [cwd])

  const revealCwd = useCallback(() => {
    if (!cwd) return
    void window.cells.app.revealPath(cwd)
  }, [cwd])

  const openAgentBrowser = useCallback(() => {
    const current = agentWindow.agentBrowser?.url
    const next = window.prompt(
      'Open URL',
      current && current !== 'about:blank' ? current : 'https://www.google.com',
    )
    if (next === null) return
    void window.cells.agentBrowser.ensure(agentWindow.id, { url: next, visible: true })
  }, [agentWindow.agentBrowser?.url, agentWindow.id])

  const toggleAgentBrowser = useCallback(() => {
    if (!agentWindow.agentBrowser) {
      void window.cells.agentBrowser.ensure(agentWindow.id, {
        url: 'https://www.google.com',
        visible: true,
      })
      return
    }
    void (agentWindow.agentBrowser.visible
      ? window.cells.agentBrowser.hide(agentWindow.id)
      : window.cells.agentBrowser.show(agentWindow.id))
  }, [agentWindow.agentBrowser, agentWindow.id])

  const closeAgentBrowser = useCallback(() => {
    void window.cells.agentBrowser.destroy(agentWindow.id)
  }, [agentWindow.id])

  return (
    <div
      className={cn(
        'absolute right-1.5 top-1.5 z-30 transition-opacity',
        isWindowFocused || open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
      )}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          onClick={(event) => {
            event.preventDefault()
            if (open) {
              allowCloseRef.current = true
              handleOpenChange(false)
            } else {
              handleOpenChange(true)
            }
          }}
          className="flex h-7 items-center gap-1 rounded-[8px] border border-border/35 bg-background/72 px-1.5 text-muted-foreground/75 shadow-minimal backdrop-blur-xl transition-colors hover:bg-foreground/8 hover:text-foreground data-[popup-open]:bg-foreground/10 data-[popup-open]:text-foreground"
          aria-label="Agent overview"
          title="Agent overview"
        >
          <PanelTop className="size-3.5" />
          <ChevronDown className="size-3 text-muted-foreground/55" />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="bottom"
          sideOffset={6}
          className="worktree-manager-popover no-drag w-[336px] gap-0 overflow-hidden rounded-[13px] border border-border/35 bg-popover/98 p-0 shadow-elevated"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        >
          <div className="flex items-center gap-2 px-3 py-2.5">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-[8px] border border-border/35 bg-background/55">
              <AgentIcon agent={agentWindow.agent} className="size-4" size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-semibold text-foreground">
                {chromeActions.title}
              </div>
              <div className="truncate text-[10.5px] text-muted-foreground/60">
                {agentDisplayName(agentWindow.agent)}
              </div>
            </div>
            <StatusBadge
              label={statusPresentation.label}
              className={statusPresentation.pillClass}
            />
          </div>

          <OverviewSection title="Environment">
            <OverviewRow
              icon={<FileText className="size-3.5" />}
              label="Changes"
              detail={changedDetail}
              active={diffsPanelOpen}
              onSelect={
                hasSessionDiffs
                  ? () => runAction(onToggleDiffs)
                  : cwd
                    ? () =>
                        runAction(() =>
                          openTerminalCommand(
                            'git status --short && git diff --stat',
                            'git status',
                          ),
                        )
                    : undefined
              }
              trailing={
                hasSessionDiffs ? (
                  <DiffCount stats={sessionDiffStats} />
                ) : currentWorktree?.dirtyCount ? (
                  <span className="rounded-[5px] bg-amber-400/10 px-1.5 py-0.5 text-[10.5px] text-amber-300 tabular-nums">
                    {currentWorktree.dirtyCount}
                  </span>
                ) : null
              }
            />
            <OverviewRow
              icon={<HardDrive className="size-3.5" />}
              label="Local"
              detail={cwd ? shortenFsPath(cwd) : 'No working directory'}
              disabled={!cwd}
              trailing={
                cwd ? (
                  <span className="flex items-center gap-0.5">
                    <button
                      type="button"
                      className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground/55 transition-colors hover:bg-foreground/8 hover:text-foreground"
                      title="Reveal in Finder"
                      aria-label="Reveal working directory"
                      onClick={(event) => {
                        event.stopPropagation()
                        runAction(revealCwd)
                      }}
                    >
                      <FolderOpen className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground/55 transition-colors hover:bg-foreground/8 hover:text-foreground"
                      title="Copy working directory"
                      aria-label="Copy working directory"
                      onClick={(event) => {
                        event.stopPropagation()
                        copyCwd()
                      }}
                    >
                      <ClipboardCopy className="size-3.5" />
                    </button>
                  </span>
                ) : null
              }
            />
            <OverviewRow
              icon={<GitBranch className="size-3.5" />}
              label={branchLabel}
              detail={branchDetail ?? worktreeLabel}
              disabled={!isGitRepo && !currentWorktree}
              trailing={
                statusLoading || worktreesLoading ? (
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground/50" />
                ) : (
                  <WorktreeManager
                    agentWindowId={agentWindow.id}
                    compact
                    side="left"
                    align="start"
                  />
                )
              }
            />
            <OverviewRow
              icon={<GitCommitHorizontal className="size-3.5" />}
              label="Commit"
              detail={
                currentWorktree?.isDirty ? plural(currentWorktree.dirtyCount, 'dirty file') : null
              }
              disabled={!cwd || !currentWorktree?.isDirty}
              onSelect={() =>
                runAction(() =>
                  openTerminalCommand(
                    'git status --short && git diff --stat && echo && git add -p; git commit',
                    'git commit',
                  ),
                )
              }
            />
            <OverviewRow
              icon={<GitPullRequestCreate className="size-3.5" />}
              label="Create pull request"
              detail={currentWorktree?.branch ?? null}
              disabled={!cwd || !currentWorktree?.branch}
              onSelect={() =>
                runAction(() => openTerminalCommand('gh pr create --web', 'gh pr create'))
              }
            />
          </OverviewSection>

          {taskRows.length > 0 ? (
            <OverviewSection title="Tasks">
              {taskRows.map((row) => (
                <OverviewRow
                  key={row.id}
                  icon={row.icon}
                  label={row.label}
                  detail={row.detail}
                  tone={row.tone}
                  onSelect={row.onSelect ? () => runAction(row.onSelect!) : undefined}
                />
              ))}
            </OverviewSection>
          ) : null}

          {agentWindow.agent === 'codex' ? (
            <OverviewSection title="Browser">
              <OverviewRow
                icon={<Globe2 className="size-3.5" />}
                label={
                  agentWindow.agentBrowser
                    ? agentWindow.agentBrowser.title || hostLabel(agentWindow.agentBrowser.url)
                    : 'Open browser'
                }
                detail={
                  agentWindow.agentBrowser
                    ? formatUrl(agentWindow.agentBrowser.url)
                    : 'Codex-owned browser'
                }
                onSelect={() => runAction(openAgentBrowser)}
                trailing={
                  agentWindow.agentBrowser?.isLoading ? (
                    <Loader2 className="size-3.5 animate-spin text-muted-foreground/45" />
                  ) : null
                }
              />
              <OverviewRow
                icon={
                  agentWindow.agentBrowser?.visible ? (
                    <EyeOff className="size-3.5" />
                  ) : (
                    <Eye className="size-3.5" />
                  )
                }
                label={agentWindow.agentBrowser?.visible ? 'Hide browser' : 'Show browser'}
                detail={agentWindow.agentBrowser ? 'Keeps running in background' : null}
                onSelect={() => runAction(toggleAgentBrowser)}
              />
              {agentWindow.agentBrowser ? (
                <OverviewRow
                  icon={<XCircle className="size-3.5" />}
                  label="Close browser"
                  tone="danger"
                  onSelect={() => runAction(closeAgentBrowser)}
                />
              ) : null}
            </OverviewSection>
          ) : browser ? (
            <OverviewSection title="Browser">
              <OverviewRow
                icon={<Globe2 className="size-3.5" />}
                label={browser.title || hostLabel(browser.url)}
                detail={formatUrl(browser.url)}
                onSelect={() => runAction(() => snapToBrowser(browser.id))}
                trailing={<ExternalLink className="size-3.5 text-muted-foreground/45" />}
              />
            </OverviewSection>
          ) : null}

          {hasSources ? (
            <OverviewSection title="Sources">
              {webSearchSeen ? (
                <OverviewRow icon={<Search className="size-3.5" />} label="Web search" />
              ) : null}
              {browserSelectionCount > 0 ? (
                <OverviewRow
                  icon={<Globe2 className="size-3.5" />}
                  label="Browser selections"
                  detail={plural(browserSelectionCount, 'selection')}
                />
              ) : null}
              {attachmentCount > 0 ? (
                <OverviewRow
                  icon={<FileText className="size-3.5" />}
                  label="Attachments"
                  detail={plural(attachmentCount, 'file')}
                />
              ) : null}
            </OverviewSection>
          ) : null}

          <OverviewSection title="Session">
            <OverviewRow
              icon={<PencilLine className="size-3.5" />}
              label="Rename"
              onSelect={() => runAction(chromeActions.onRename)}
            />
            <OverviewRow
              icon={
                <ArrowUpRight className={cn('size-3.5', chromeActions.isPinned && 'rotate-180')} />
              }
              label={chromeActions.isPinned ? 'Pop back in' : 'Pop out to window'}
              onSelect={() => runAction(chromeActions.onTogglePin)}
            />
            <OverviewRow
              icon={<RotateCcw className="size-3.5" />}
              label="Clear conversation"
              onSelect={() => runAction(chromeActions.onClearConversation)}
            />
            <OverviewRow
              icon={<XCircle className="size-3.5" />}
              label="Close session"
              tone="danger"
              onSelect={() => {
                chromeActions.onCloseSession()
                close()
              }}
            />
          </OverviewSection>
        </PopoverContent>
      </Popover>
    </div>
  )
}
