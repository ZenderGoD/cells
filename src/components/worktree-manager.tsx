import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  Copy,
  FolderOpen,
  GitBranch,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import type { AgentName, AgentSessionSnapshot, GitWorktree } from '@/types'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import {
  findWorktreeForPath,
  formatWorktreeLocation,
  getWorktreeName,
  shortenFsPath,
} from '@/lib/worktree-utils'
import { hapticNudge, hapticSuccess } from '@/lib/haptics'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { AgentIcon } from '@/components/agent-icon'

interface WorktreeManagerProps {
  terminalId?: string | null
  agentWindowId?: string | null
  className?: string
  compact?: boolean
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
}

function AttachedWindows({ worktreePath }: { worktreePath: string }) {
  const terminals = useStore((state) => state.terminals)
  const agentWindows = useStore((state) => state.agentWindows)
  const attachedTerminals = terminals.filter((terminal) => terminal.cwd === worktreePath)
  const attachedAgents = agentWindows.filter((agentWindow) => agentWindow.cwd === worktreePath)
  const count = attachedTerminals.length + attachedAgents.length
  if (count === 0) return null
  return (
    <div className="flex shrink-0 items-center gap-1">
      {attachedTerminals.slice(0, 3).map((terminal) => (
        <span
          key={terminal.id}
          className="inline-flex h-5 items-center gap-1 rounded-[6px] bg-foreground/5 px-1.5 text-[10px] text-muted-foreground/75"
          title={terminal.customTitle || terminal.title}
        >
          <TerminalSquare className="size-3" />
        </span>
      ))}
      {attachedAgents.slice(0, 3).map((agentWindow) => (
        <span
          key={agentWindow.id}
          className="inline-flex h-5 items-center rounded-[6px] bg-foreground/5 px-1.5 text-muted-foreground/75"
          title={agentWindow.customTitle || agentWindow.title}
        >
          <AgentIcon agent={agentWindow.agent} className="size-3" size={12} />
        </span>
      ))}
      {count > 6 ? (
        <span className="text-[10px] text-muted-foreground/55">+{count - 6}</span>
      ) : null}
    </div>
  )
}

function WorktreeBadges({ worktree }: { worktree: GitWorktree }) {
  const badges: string[] = []
  if (worktree.isMain) badges.push('main')
  if (worktree.isDetached) badges.push('detached')
  if (worktree.isBare) badges.push('bare')
  if (worktree.isMissing) badges.push('missing')
  if (worktree.prunable) badges.push('prunable')
  if (worktree.dirtyCount > 0) badges.push(`${worktree.dirtyCount} dirty`)
  if (worktree.ahead || worktree.behind) {
    badges.push(`+${worktree.ahead ?? 0}/-${worktree.behind ?? 0}`)
  }
  if (badges.length === 0) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {badges.map((badge) => (
        <span
          key={badge}
          className={cn(
            'rounded-[5px] border px-1.5 py-0.5 text-[9.5px] leading-none',
            badge.includes('dirty') || badge === 'missing'
              ? 'border-amber-400/20 bg-amber-500/10 text-amber-300'
              : 'border-border/35 bg-background/45 text-muted-foreground/70',
          )}
        >
          {badge}
        </span>
      ))}
    </div>
  )
}

function buildSessionImportPrompt(snapshot: AgentSessionSnapshot, sourceTitle: string) {
  const transcript = (snapshot.messages ?? [])
    .map((message) => {
      const text = message.text?.trim()
      if (!text) return null
      return `## ${message.role}\n\n${text}`
    })
    .filter((entry): entry is string => Boolean(entry))
    .join('\n\n')
    .slice(-70_000)

  return [
    `We are continuing work from "${sourceTitle}" in a new worktree.`,
    snapshot.cwd ? `Previous working directory: ${snapshot.cwd}` : null,
    transcript ? `Conversation transcript follows:\n\n${transcript}` : null,
    'Continue from this context. Inspect the repository state in this worktree before making changes.',
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join('\n\n')
}

export function WorktreeManager({
  terminalId,
  agentWindowId,
  className,
  compact = false,
  side = 'top',
  align = 'end',
}: WorktreeManagerProps) {
  const isGitRepo = useStore((state) => state.isGitRepo)
  const worktrees = useStore((state) => state.worktrees)
  const worktreesLoading = useStore((state) => state.worktreesLoading)
  const terminals = useStore((state) => state.terminals)
  const agentWindows = useStore((state) => state.agentWindows)
  const activeProjectPath = useStore((state) => state.getActiveProjectPath())
  const refreshWorktrees = useStore((state) => state.refreshWorktrees)
  const moveTerminalToWorktree = useStore((state) => state.moveTerminalToWorktree)
  const openTerminalInWorktree = useStore((state) => state.openTerminalInWorktree)
  const openAgentInWorktree = useStore((state) => state.openAgentInWorktree)
  const syncAgentWindow = useStore((state) => state.syncAgentWindow)
  const createWorktree = useStore((state) => state.createWorktree)
  const removeWorktreeSafely = useStore((state) => state.removeWorktreeSafely)
  const setWorktreesDir = useStore((state) => state.setWorktreesDir)
  const getWorktreesDir = useStore((state) => state.getWorktreesDir)
  const setWorktreeBaseBranch = useStore((state) => state.setWorktreeBaseBranch)
  const getWorktreeBaseBranch = useStore((state) => state.getWorktreeBaseBranch)
  const setOverlayOpen = useStore((state) => state.setOverlayOpen)

  const [open, setOpen] = useState(false)
  const [branchName, setBranchName] = useState('')
  const [checkoutExistingBranch, setCheckoutExistingBranch] = useState(false)
  const [baseRef, setBaseRef] = useState('')
  const [creating, setCreating] = useState(false)
  const [cleanupTarget, setCleanupTarget] = useState<GitWorktree | null>(null)
  const [forceCleanup, setForceCleanup] = useState(false)
  const [moveAttachedToMain, setMoveAttachedToMain] = useState(true)
  const [closeAttached, setCloseAttached] = useState(false)

  const terminal = terminalId ? terminals.find((entry) => entry.id === terminalId) : null
  const agentWindow = agentWindowId
    ? agentWindows.find((entry) => entry.id === agentWindowId)
    : null
  const currentCwd = terminal?.cwd ?? agentWindow?.cwd ?? activeProjectPath ?? null
  const currentWorktree = findWorktreeForPath(worktrees, currentCwd)
  const currentLabel = formatWorktreeLocation(currentWorktree, currentCwd) ?? 'Worktrees'
  const nonBare = worktrees.filter((worktree) => !worktree.isBare)
  const mainWorktree = nonBare.find((worktree) => worktree.isMain) ?? nonBare[0] ?? null

  useEffect(() => {
    if (open) void refreshWorktrees({ includeStatus: true })
  }, [open, refreshWorktrees])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      setOverlayOpen('worktree-manager', next)
      if (next) hapticNudge()
      if (!next) {
        setBranchName('')
        setCheckoutExistingBranch(false)
        setBaseRef('')
      }
    },
    [setOverlayOpen],
  )

  const attachedToCleanup = useMemo(() => {
    if (!cleanupTarget) return { terminals: 0, agents: 0, total: 0 }
    const terminalCount = terminals.filter((entry) => entry.cwd === cleanupTarget.path).length
    const agentCount = agentWindows.filter((entry) => entry.cwd === cleanupTarget.path).length
    return { terminals: terminalCount, agents: agentCount, total: terminalCount + agentCount }
  }, [agentWindows, cleanupTarget, terminals])

  const canRemoveCleanup =
    cleanupTarget &&
    !cleanupTarget.isMain &&
    (!cleanupTarget.isDirty || forceCleanup) &&
    (attachedToCleanup.total === 0 || moveAttachedToMain || closeAttached)

  const create = async () => {
    const name = branchName.trim()
    if (!name) return
    setCreating(true)
    try {
      await createWorktree({
        branchName: name,
        baseRef: baseRef || null,
        checkoutExistingBranch,
      })
      setBranchName('')
      setCheckoutExistingBranch(false)
      setBaseRef('')
      hapticSuccess()
    } finally {
      setCreating(false)
    }
  }

  const openAgent = (agent: Extract<AgentName, 'claude' | 'codex'>, worktree: GitWorktree) => {
    openAgentInWorktree(agent, worktree.path, {
      title: agent === 'claude' ? 'Claude Code' : 'Codex',
    })
    handleOpenChange(false)
  }

  const moveFocusedAgent = async (worktree: GitWorktree) => {
    if (!agentWindow) return
    const hasSession = Boolean(agentWindow.claudeSessionId || agentWindow.codexThreadId)
    if (!hasSession) {
      syncAgentWindow(agentWindow.id, { cwd: worktree.path })
      hapticSuccess()
      handleOpenChange(false)
      return
    }
    const sourceTitle = agentWindow.customTitle || agentWindow.title
    let initialPrompt: string | null = null
    try {
      const snapshot = await window.cells.agentSession.ensure({
        windowId: agentWindow.id,
        agent: agentWindow.agent,
        title: sourceTitle,
        cwd: agentWindow.cwd ?? null,
        initialPrompt: null,
        claudeSessionId: agentWindow.claudeSessionId ?? null,
        codexThreadId: agentWindow.codexThreadId ?? null,
        model: agentWindow.model ?? null,
        permissionMode: agentWindow.permissionMode ?? null,
        thinkingLevel: agentWindow.thinkingLevel ?? null,
        contextLength: agentWindow.contextLength ?? null,
      })
      initialPrompt = buildSessionImportPrompt(snapshot, sourceTitle)
    } catch (error) {
      console.error('[worktree-manager] failed to import agent session context', error)
    }
    openAgentInWorktree(agentWindow.agent, worktree.path, {
      title: `${sourceTitle} (${getWorktreeName(worktree)})`,
      initialPrompt,
      model: agentWindow.model ?? null,
      permissionMode: agentWindow.permissionMode ?? null,
      thinkingLevel: agentWindow.thinkingLevel ?? null,
      contextLength: agentWindow.contextLength ?? null,
    })
    handleOpenChange(false)
  }

  const pickDir = async () => {
    const dir = await window.cells.app.pickFolder()
    if (dir) setWorktreesDir(dir)
  }

  if (!isGitRepo) return null

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          className={cn(
            compact
              ? 'inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/45 transition-colors hover:bg-muted/40 hover:text-foreground'
              : 'inline-flex h-6 max-w-56 shrink items-center gap-1.5 rounded-md bg-foreground/5 px-2 text-[10.5px] font-medium text-muted-foreground/75 transition-colors hover:bg-foreground/10 hover:text-foreground',
            currentWorktree?.isDirty && 'text-amber-300/90',
            className,
          )}
          title="Worktrees"
        >
          <GitBranch className={compact ? 'size-3' : 'size-3 shrink-0'} />
          {!compact ? <span className="truncate">{currentLabel}</span> : null}
        </PopoverTrigger>
        <PopoverContent side={side} align={align} sideOffset={6} className="w-[520px] gap-0 p-0">
          <div className="flex items-center justify-between border-b border-border/35 px-3 py-2">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-foreground">Worktrees</div>
              <div className="truncate text-[10.5px] text-muted-foreground/60">
                {activeProjectPath ? shortenFsPath(activeProjectPath) : 'No project path'}
              </div>
            </div>
            <button
              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/55 transition-colors hover:bg-muted/50 hover:text-foreground"
              title="Refresh worktrees"
              onClick={() => void refreshWorktrees({ includeStatus: true })}
            >
              {worktreesLoading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </button>
          </div>

          <div className="border-b border-border/35 p-2">
            <div className="flex items-center gap-1.5">
              <input
                value={branchName}
                onChange={(event) => setBranchName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void create()
                  }
                }}
                placeholder="new branch name"
                className="h-8 min-w-0 flex-1 rounded-md border border-border/35 bg-background/45 px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/40 focus:ring-1 focus:ring-primary/35"
              />
              <select
                value={baseRef}
                onChange={(event) => setBaseRef(event.target.value)}
                className="h-8 max-w-36 rounded-md border border-border/35 bg-background/45 px-2 text-[11px] text-muted-foreground outline-none"
                title="Base branch"
              >
                <option value="">HEAD</option>
                {nonBare
                  .filter((worktree) => worktree.branch)
                  .map((worktree) => (
                    <option key={worktree.path} value={worktree.branch ?? ''}>
                      {worktree.branch}
                    </option>
                  ))}
              </select>
              <button
                disabled={!branchName.trim() || creating}
                onClick={() => void create()}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] font-medium text-primary-foreground transition-opacity disabled:opacity-45"
              >
                {creating ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Plus className="size-3" />
                )}
                Create
              </button>
            </div>
            <label className="mt-1.5 inline-flex items-center gap-1.5 text-[10.5px] text-muted-foreground/70">
              <input
                type="checkbox"
                checked={checkoutExistingBranch}
                onChange={(event) => setCheckoutExistingBranch(event.target.checked)}
              />
              Check out an existing branch instead of creating one
            </label>
          </div>

          <div className="max-h-72 overflow-y-auto p-1.5">
            {nonBare.length === 0 ? (
              <div className="px-2 py-6 text-center text-[12px] text-muted-foreground/65">
                No worktrees found.
              </div>
            ) : (
              nonBare.map((worktree) => {
                const selected = currentWorktree?.path === worktree.path
                return (
                  <div
                    key={worktree.path}
                    className={cn(
                      'group flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-foreground/5',
                      selected && 'bg-foreground/6',
                    )}
                  >
                    <GitBranch className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/65" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[12.5px] font-medium text-foreground/90">
                          {getWorktreeName(worktree)}
                        </span>
                        {selected ? <Check className="size-3 shrink-0 text-primary/70" /> : null}
                        <AttachedWindows worktreePath={worktree.path} />
                      </div>
                      <div className="truncate font-mono text-[10.5px] text-muted-foreground/55">
                        {shortenFsPath(worktree.path)}
                      </div>
                      <WorktreeBadges worktree={worktree} />
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-80 transition-opacity group-hover:opacity-100">
                      {terminalId ? (
                        <button
                          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground"
                          title="Move focused terminal here"
                          onClick={() => {
                            void moveTerminalToWorktree(terminalId, worktree.path, {
                              relaunchProcess: true,
                            }).then(() => handleOpenChange(false))
                          }}
                        >
                          <MoreHorizontal className="size-3.5" />
                        </button>
                      ) : null}
                      {agentWindowId ? (
                        <button
                          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground"
                          title="Move or branch focused agent here"
                          onClick={() => void moveFocusedAgent(worktree)}
                        >
                          <MoreHorizontal className="size-3.5" />
                        </button>
                      ) : null}
                      <button
                        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground"
                        title="Open terminal here"
                        onClick={() => {
                          openTerminalInWorktree(worktree.path)
                          handleOpenChange(false)
                        }}
                      >
                        <TerminalSquare className="size-3.5" />
                      </button>
                      <button
                        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground"
                        title="Open Codex here"
                        onClick={() => openAgent('codex', worktree)}
                      >
                        <AgentIcon agent="codex" className="size-3.5" size={14} />
                      </button>
                      <button
                        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground"
                        title="Open Claude here"
                        onClick={() => openAgent('claude', worktree)}
                      >
                        <AgentIcon agent="claude" className="size-3.5" size={14} />
                      </button>
                      <button
                        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground"
                        title="Copy path"
                        onClick={() => void navigator.clipboard.writeText(worktree.path)}
                      >
                        <Copy className="size-3.5" />
                      </button>
                      <button
                        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground"
                        title="Reveal in Finder"
                        onClick={() => void window.cells.app.revealPath(worktree.path)}
                      >
                        <FolderOpen className="size-3.5" />
                      </button>
                      {!worktree.isMain ? (
                        <button
                          className="inline-flex size-6 items-center justify-center rounded-md text-red-300/75 hover:bg-red-500/10 hover:text-red-200"
                          title="Remove worktree"
                          onClick={() => {
                            setCleanupTarget(worktree)
                            setForceCleanup(false)
                            setMoveAttachedToMain(Boolean(mainWorktree))
                            setCloseAttached(false)
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              })
            )}
          </div>

          <div className="space-y-2 border-t border-border/35 p-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/55">
                  Worktrees directory
                </div>
                <div className="truncate text-[11px] text-muted-foreground/75">
                  {getWorktreesDir() || 'Default next to repo'}
                </div>
              </div>
              <button
                className="h-7 rounded-md bg-foreground/5 px-2 text-[11px] text-muted-foreground/85 transition-colors hover:bg-foreground/10 hover:text-foreground"
                onClick={() => void pickDir()}
              >
                Browse
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/55">
                Default base
              </span>
              <select
                value={getWorktreeBaseBranch() || ''}
                onChange={(event) => setWorktreeBaseBranch(event.target.value)}
                className="h-7 min-w-0 flex-1 rounded-md border border-border/35 bg-background/45 px-2 text-[11px] text-muted-foreground outline-none"
              >
                <option value="">HEAD</option>
                {nonBare
                  .filter((worktree) => worktree.branch)
                  .map((worktree) => (
                    <option key={worktree.path} value={worktree.branch ?? ''}>
                      {worktree.branch}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Dialog
        open={Boolean(cleanupTarget)}
        onOpenChange={(next) => !next && setCleanupTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove worktree</DialogTitle>
            <DialogDescription>
              {cleanupTarget
                ? `${getWorktreeName(cleanupTarget)} at ${shortenFsPath(cleanupTarget.path)}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {cleanupTarget ? (
            <div className="space-y-3 text-[12px]">
              <div className="rounded-lg border border-border/45 bg-background/35 p-2">
                <WorktreeBadges worktree={cleanupTarget} />
                <div className="mt-2 text-muted-foreground/75">
                  {attachedToCleanup.total > 0
                    ? `${attachedToCleanup.total} attached window${attachedToCleanup.total === 1 ? '' : 's'}`
                    : 'No attached windows'}
                </div>
              </div>
              {attachedToCleanup.total > 0 ? (
                <div className="space-y-1.5">
                  <label className="flex items-center gap-2 text-muted-foreground/85">
                    <input
                      type="radio"
                      checked={moveAttachedToMain}
                      disabled={!mainWorktree}
                      onChange={() => {
                        setMoveAttachedToMain(true)
                        setCloseAttached(false)
                      }}
                    />
                    Move attached windows to main worktree
                  </label>
                  <label className="flex items-center gap-2 text-muted-foreground/85">
                    <input
                      type="radio"
                      checked={closeAttached}
                      onChange={() => {
                        setMoveAttachedToMain(false)
                        setCloseAttached(true)
                      }}
                    />
                    Close attached windows
                  </label>
                </div>
              ) : null}
              {cleanupTarget.isDirty ? (
                <label className="flex items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-500/10 p-2 text-amber-200">
                  <input
                    type="checkbox"
                    checked={forceCleanup}
                    onChange={(event) => setForceCleanup(event.target.checked)}
                  />
                  Discard uncommitted changes and remove
                </label>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <button
              className="h-8 rounded-md px-3 text-[12px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              onClick={() => setCleanupTarget(null)}
            >
              Cancel
            </button>
            <button
              disabled={!canRemoveCleanup || !cleanupTarget}
              className="h-8 rounded-md bg-red-500/15 px-3 text-[12px] font-medium text-red-200 transition-opacity hover:bg-red-500/20 disabled:opacity-45"
              onClick={() => {
                if (!cleanupTarget) return
                void removeWorktreeSafely(cleanupTarget.path, {
                  force: forceCleanup,
                  moveAttachedToMain,
                  closeAttached,
                }).then(() => {
                  setCleanupTarget(null)
                  handleOpenChange(false)
                })
              }}
            >
              Remove
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
