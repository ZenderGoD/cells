import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  Check,
  Copy,
  FolderOpen,
  GitBranch,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import type { AgentSessionName, AgentSessionSnapshot, GitWorktree } from '@/types'
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
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
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
  triggerVariant?: 'default' | 'toolbar'
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
}

interface WorktreeBranchOption {
  value: string
  label: string
  hint?: string
}

function WorktreeBranchCombobox({
  value,
  options,
  onValueChange,
  placeholder = 'HEAD',
  className,
}: {
  value: string
  options: WorktreeBranchOption[]
  onValueChange(value: string): void
  placeholder?: string
  className?: string
}) {
  const selected =
    options.find((option) => option.value === value) ??
    (value ? { value, label: value, hint: 'Saved branch' } : options[0]) ??
    null
  const visibleOptions =
    selected && !options.some((option) => option.value === selected.value)
      ? [selected, ...options]
      : options

  return (
    <Combobox<WorktreeBranchOption>
      value={selected}
      onValueChange={(next) => onValueChange(next?.value ?? '')}
      itemToStringLabel={(item) => item.label}
      itemToStringValue={(item) => item.value}
      isItemEqualToValue={(item, selectedItem) => item.value === selectedItem.value}
    >
      <ComboboxInput
        placeholder={placeholder}
        className={cn(
          'w-full border-border/35 bg-background/45 dark:bg-background/45',
          '[&_[data-slot=input-group-control]]:h-8 [&_[data-slot=input-group-control]]:px-2 [&_[data-slot=input-group-control]]:text-[11px] [&_[data-slot=input-group-control]]:text-foreground',
          className,
        )}
      />
      <ComboboxContent className="worktree-manager-popover">
        <ComboboxEmpty className="py-2 text-[11px]">No branches</ComboboxEmpty>
        <ComboboxList>
          {visibleOptions.map((option) => (
            <ComboboxItem
              key={option.value}
              value={option}
              className="items-start gap-2 px-2 py-1.5 text-[11px]"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-foreground">{option.label}</div>
                {option.hint ? (
                  <div className="truncate text-[10px] text-muted-foreground/45">{option.hint}</div>
                ) : null}
              </div>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
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

function WorktreeActionMenu({
  worktree,
  canRemove,
  onOpenTerminal,
  onOpenCodex,
  onOpenClaude,
  onOpenCursor,
  onOpenCopilot,
  onOpenOpencode,
  onCopyPath,
  onReveal,
  onRemove,
}: {
  worktree: GitWorktree
  canRemove: boolean
  onOpenTerminal(): void
  onOpenCodex(): void
  onOpenClaude(): void
  onOpenCursor(): void
  onOpenCopilot(): void
  onOpenOpencode(): void
  onCopyPath(): void
  onReveal(): void
  onRemove(): void
}) {
  const [open, setOpen] = useState(false)
  const run = (action: () => void) => {
    action()
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground data-[popup-open]:bg-muted/60 data-[popup-open]:text-foreground"
        title={`Actions for ${getWorktreeName(worktree)}`}
        onClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="left"
        sideOffset={8}
        className="worktree-manager-popover no-drag w-56 gap-0 overflow-hidden p-1"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          variant="ghost"
          className="h-8 w-full justify-start gap-2 px-2 text-left text-[12px] text-foreground/85"
          onClick={() => run(onOpenTerminal)}
        >
          <TerminalSquare className="size-4" />
          Open terminal
        </Button>
        <Button
          variant="ghost"
          className="h-8 w-full justify-start gap-2 px-2 text-left text-[12px] text-foreground/85"
          onClick={() => run(onOpenCodex)}
        >
          <AgentIcon agent="codex" className="size-4" size={16} />
          Open Codex
        </Button>
        <Button
          variant="ghost"
          className="h-8 w-full justify-start gap-2 px-2 text-left text-[12px] text-foreground/85"
          onClick={() => run(onOpenClaude)}
        >
          <AgentIcon agent="claude" className="size-4" size={16} />
          Open Claude
        </Button>
        <Button
          variant="ghost"
          className="h-8 w-full justify-start gap-2 px-2 text-left text-[12px] text-foreground/85"
          onClick={() => run(onOpenCursor)}
        >
          <AgentIcon agent="cursor" className="size-4" size={16} />
          Open Cursor
        </Button>
        <Button
          variant="ghost"
          className="h-8 w-full justify-start gap-2 px-2 text-left text-[12px] text-foreground/85"
          onClick={() => run(onOpenCopilot)}
        >
          <AgentIcon agent="copilot" className="size-4" size={16} />
          Open Copilot
        </Button>
        <Button
          variant="ghost"
          className="h-8 w-full justify-start gap-2 px-2 text-left text-[12px] text-foreground/85"
          onClick={() => run(onOpenOpencode)}
        >
          <AgentIcon agent="opencode" className="size-4" size={16} />
          Open OpenCode
        </Button>
        <Button
          variant="ghost"
          className="h-8 w-full justify-start gap-2 px-2 text-left text-[12px] text-foreground/85"
          onClick={() => run(onCopyPath)}
        >
          <Copy className="size-4" />
          Copy path
        </Button>
        <Button
          variant="ghost"
          className="h-8 w-full justify-start gap-2 px-2 text-left text-[12px] text-foreground/85"
          onClick={() => run(onReveal)}
        >
          <FolderOpen className="size-4" />
          Reveal in Finder
        </Button>
        {canRemove ? (
          <Button
            variant="ghost"
            className="h-8 w-full justify-start gap-2 px-2 text-left text-[12px] text-red-300 hover:bg-red-500/10 hover:text-red-200"
            onClick={() => run(onRemove)}
          >
            <Trash2 className="size-4" />
            Remove worktree
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

export function WorktreeManager({
  terminalId,
  agentWindowId,
  className,
  compact = false,
  triggerVariant = 'default',
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
  const [search, setSearch] = useState('')
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
  const branchOptions = useMemo<WorktreeBranchOption[]>(() => {
    const seen = new Set<string>()
    const options: WorktreeBranchOption[] = [{ value: '', label: 'HEAD', hint: 'Current commit' }]
    for (const worktree of nonBare) {
      if (!worktree.branch || seen.has(worktree.branch)) continue
      seen.add(worktree.branch)
      options.push({
        value: worktree.branch,
        label: worktree.branch,
        hint: worktree.isMain ? 'Main worktree' : shortenFsPath(worktree.path),
      })
    }
    return options
  }, [nonBare])
  const searchQuery = search.trim().toLowerCase()
  const filteredWorktrees = nonBare.filter((worktree) => {
    if (!searchQuery) return true
    return [
      getWorktreeName(worktree),
      worktree.branch,
      worktree.path,
      worktree.upstream,
      worktree.isMain ? 'main' : null,
      worktree.isDetached ? 'detached' : null,
      worktree.isMissing ? 'missing' : null,
      worktree.isDirty ? 'dirty' : null,
      worktree.prunable ? 'prunable' : null,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(searchQuery)
  })

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
        setSearch('')
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

  const openTerminal = (worktree: GitWorktree) => {
    openTerminalInWorktree(worktree.path)
    handleOpenChange(false)
  }

  const openAgent = (agent: AgentSessionName, worktree: GitWorktree) => {
    openAgentInWorktree(agent, worktree.path, {
      title:
        agent === 'claude'
          ? 'Claude Code'
          : agent === 'cursor'
            ? 'Cursor'
            : agent === 'copilot'
              ? 'GitHub Copilot'
              : agent === 'opencode'
                ? 'OpenCode'
                : 'Codex',
    })
    handleOpenChange(false)
  }

  const setCleanup = (worktree: GitWorktree) => {
    setCleanupTarget(worktree)
    setForceCleanup(false)
    setMoveAttachedToMain(Boolean(mainWorktree))
    setCloseAttached(false)
  }

  const moveFocusedAgent = async (worktree: GitWorktree) => {
    if (!agentWindow) return
    const hasSession = Boolean(
      agentWindow.claudeSessionId ||
      agentWindow.codexThreadId ||
      agentWindow.cursorAgentId ||
      agentWindow.copilotSessionId ||
      agentWindow.opencodeSessionId,
    )
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
        cursorAgentId: agentWindow.cursorAgentId ?? null,
        cursorRunId: agentWindow.cursorRunId ?? null,
        copilotSessionId: agentWindow.copilotSessionId ?? null,
        opencodeSessionId: agentWindow.opencodeSessionId ?? null,
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
      copilotSessionId: agentWindow.copilotSessionId ?? null,
      opencodeSessionId: agentWindow.opencodeSessionId ?? null,
    })
    handleOpenChange(false)
  }

  const runPrimaryAction = async (worktree: GitWorktree) => {
    if (terminalId) {
      await moveTerminalToWorktree(terminalId, worktree.path, {
        relaunchProcess: true,
      })
      hapticSuccess()
      handleOpenChange(false)
      return
    }
    if (agentWindowId) {
      await moveFocusedAgent(worktree)
      return
    }
    openTerminal(worktree)
  }

  const pickDir = async () => {
    const dir = await window.cells.app.pickFolder()
    if (dir) setWorktreesDir(dir)
  }

  const primaryActionLabel = terminalId
    ? 'Move terminal'
    : agentWindowId
      ? 'Move or branch agent'
      : 'Open terminal'

  if (!isGitRepo) return null

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          className={cn(
            compact
              ? 'inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/45 transition-colors hover:bg-muted/40 hover:text-foreground'
              : triggerVariant === 'toolbar'
                ? 'inline-flex h-6 max-w-40 shrink-0 items-center gap-1 rounded-md bg-foreground/5 px-1.5 text-[10.5px] font-medium text-muted-foreground/75 transition-colors hover:bg-foreground/10 hover:text-foreground'
                : 'inline-flex h-6 max-w-56 shrink items-center gap-1.5 rounded-md bg-foreground/5 px-2 text-[10.5px] font-medium text-muted-foreground/75 transition-colors hover:bg-foreground/10 hover:text-foreground',
            currentWorktree?.isDirty && 'text-amber-300/90',
            className,
          )}
          title="Worktrees"
        >
          <GitBranch className={compact ? 'size-3' : 'size-3 shrink-0'} />
          {!compact ? <span className="truncate">{currentLabel}</span> : null}
        </PopoverTrigger>
        <PopoverContent
          side={side}
          align={align}
          sideOffset={6}
          className="worktree-manager-popover no-drag w-[600px] gap-0 p-0"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-border/35 px-3 py-2">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-foreground">Worktrees</div>
              <div className="truncate text-[10.5px] text-muted-foreground/60">
                {activeProjectPath ? shortenFsPath(activeProjectPath) : 'No project path'}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground/55 hover:bg-muted/50 hover:text-foreground"
              title="Refresh worktrees"
              aria-label="Refresh worktrees"
              onClick={() => void refreshWorktrees({ includeStatus: true })}
            >
              {worktreesLoading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </Button>
          </div>

          <div className="border-b border-border/35 p-2">
            <div className="flex h-8 items-center gap-2 rounded-lg border border-border/35 bg-background/45 px-2 focus-within:ring-1 focus-within:ring-primary/35">
              <Search className="size-4 shrink-0 text-muted-foreground/50" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search worktrees by branch, path, or status"
                className="h-7 min-w-0 flex-1 border-0 bg-transparent px-0 text-[12px] text-foreground shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
              />
            </div>
          </div>

          <ScrollArea className="max-h-80" maskHeight={16}>
            <div className="p-1.5">
              <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
                {primaryActionLabel}
              </div>
              {nonBare.length === 0 ? (
                <div className="px-2 py-6 text-center text-[12px] text-muted-foreground/65">
                  No worktrees found.
                </div>
              ) : filteredWorktrees.length === 0 ? (
                <div className="px-2 py-6 text-center text-[12px] text-muted-foreground/65">
                  No worktrees match.
                </div>
              ) : (
                filteredWorktrees.map((worktree) => {
                  const selected = currentWorktree?.path === worktree.path
                  return (
                    <div
                      key={worktree.path}
                      className={cn(
                        'group flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-foreground/5',
                        selected && 'bg-foreground/6',
                      )}
                    >
                      <Button
                        variant="ghost"
                        className="h-auto min-w-0 flex-1 justify-start gap-2 px-0 py-0 text-left hover:bg-transparent"
                        onClick={() => void runPrimaryAction(worktree)}
                      >
                        <GitBranch className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/65" />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-[12.5px] font-medium text-foreground/90">
                              {getWorktreeName(worktree)}
                            </span>
                            {selected ? (
                              <Check className="size-3 shrink-0 text-primary/70" />
                            ) : null}
                            <AttachedWindows worktreePath={worktree.path} />
                          </div>
                          <div className="truncate font-mono text-[10.5px] text-muted-foreground/55">
                            {shortenFsPath(worktree.path)}
                          </div>
                          <WorktreeBadges worktree={worktree} />
                        </div>
                      </Button>
                      <span className="mt-0.5 hidden shrink-0 text-[10.5px] text-muted-foreground/55 group-hover:inline">
                        {primaryActionLabel}
                      </span>
                      <WorktreeActionMenu
                        worktree={worktree}
                        canRemove={!worktree.isMain}
                        onOpenTerminal={() => openTerminal(worktree)}
                        onOpenCodex={() => openAgent('codex', worktree)}
                        onOpenClaude={() => openAgent('claude', worktree)}
                        onOpenCursor={() => openAgent('cursor', worktree)}
                        onOpenCopilot={() => openAgent('copilot', worktree)}
                        onOpenOpencode={() => openAgent('opencode', worktree)}
                        onCopyPath={() => void navigator.clipboard.writeText(worktree.path)}
                        onReveal={() => void window.cells.app.revealPath(worktree.path)}
                        onRemove={() => setCleanup(worktree)}
                      />
                    </div>
                  )
                })
              )}
            </div>
          </ScrollArea>

          <div className="border-t border-border/35 p-2">
            <div className="flex items-center gap-1.5">
              <Input
                value={branchName}
                onChange={(event) => setBranchName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void create()
                  }
                }}
                placeholder="new branch name"
                className="h-8 min-w-0 flex-1 rounded-md border-border/35 bg-background/45 px-2 text-[12px] placeholder:text-muted-foreground/40 dark:bg-background/45"
              />
              <WorktreeBranchCombobox
                value={baseRef}
                options={branchOptions}
                onValueChange={setBaseRef}
                className="max-w-36"
              />
              <Button
                disabled={!branchName.trim() || creating}
                onClick={() => void create()}
                className="h-8 shrink-0 gap-1.5 px-2.5 text-[11px]"
              >
                {creating ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Plus className="size-3" />
                )}
                Create
              </Button>
            </div>
            <Button
              variant="ghost"
              size="xs"
              role="checkbox"
              aria-checked={checkoutExistingBranch}
              className="mt-1.5 h-6 gap-1.5 px-0 text-[10.5px] font-normal text-muted-foreground/70 hover:bg-transparent hover:text-foreground"
              onClick={() => setCheckoutExistingBranch((checked) => !checked)}
            >
              <span
                className={cn(
                  'flex size-3.5 items-center justify-center rounded-[3px] border border-muted-foreground/45',
                  checkoutExistingBranch && 'border-primary bg-primary text-primary-foreground',
                )}
              >
                {checkoutExistingBranch ? <Check className="size-2.5" /> : null}
              </span>
              Check out an existing branch instead of creating one
            </Button>
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
              <Button
                variant="ghost"
                size="sm"
                className="h-7 bg-foreground/5 px-2 text-[11px] text-muted-foreground/85 hover:bg-foreground/10 hover:text-foreground"
                onClick={() => void pickDir()}
              >
                Browse
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/55">
                Default base
              </span>
              <WorktreeBranchCombobox
                value={getWorktreeBaseBranch() || ''}
                options={branchOptions}
                onValueChange={setWorktreeBaseBranch}
                className="min-w-0 flex-1 [&_[data-slot=input-group-control]]:h-7"
              />
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
                  <Button
                    variant="ghost"
                    role="radio"
                    aria-checked={moveAttachedToMain}
                    disabled={!mainWorktree}
                    className="h-7 w-full justify-start gap-2 px-1.5 text-[12px] font-normal text-muted-foreground/85"
                    onClick={() => {
                      if (mainWorktree) {
                        setMoveAttachedToMain(true)
                        setCloseAttached(false)
                      }
                    }}
                  >
                    <span
                      className={cn(
                        'size-3.5 rounded-full border border-muted-foreground/45',
                        moveAttachedToMain &&
                          'border-primary bg-primary shadow-[inset_0_0_0_3px_var(--background)]',
                      )}
                    />
                    Move attached windows to main worktree
                  </Button>
                  <Button
                    variant="ghost"
                    role="radio"
                    aria-checked={closeAttached}
                    className="h-7 w-full justify-start gap-2 px-1.5 text-[12px] font-normal text-muted-foreground/85"
                    onClick={() => {
                      setMoveAttachedToMain(false)
                      setCloseAttached(true)
                    }}
                  >
                    <span
                      className={cn(
                        'size-3.5 rounded-full border border-muted-foreground/45',
                        closeAttached &&
                          'border-primary bg-primary shadow-[inset_0_0_0_3px_var(--background)]',
                      )}
                    />
                    Close attached windows
                  </Button>
                </div>
              ) : null}
              {cleanupTarget.isDirty ? (
                <Button
                  variant="ghost"
                  role="checkbox"
                  aria-checked={forceCleanup}
                  className="h-auto w-full justify-start gap-2 rounded-lg border border-amber-400/20 bg-amber-500/10 p-2 text-[12px] font-normal text-amber-200 hover:bg-amber-500/15 hover:text-amber-100"
                  onClick={() => setForceCleanup((checked) => !checked)}
                >
                  <span
                    className={cn(
                      'flex size-3.5 items-center justify-center rounded-[3px] border border-amber-200/55',
                      forceCleanup && 'bg-amber-200 text-background',
                    )}
                  >
                    {forceCleanup ? <Check className="size-2.5" /> : null}
                  </span>
                  Discard uncommitted changes and remove
                </Button>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="ghost"
              className="h-8 px-3 text-[12px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              onClick={() => setCleanupTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!canRemoveCleanup || !cleanupTarget}
              className="h-8 px-3 text-[12px]"
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
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
