import { useState, useEffect, useCallback } from 'react'
import { GitBranch, Plus, Check, Loader2, FolderOpen } from 'lucide-react'
import { Command as CommandPrimitive } from 'cmdk'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import type { GitWorktree } from '@/types'

interface WorktreeSwitcherProps {
  termId: string
  className?: string
}

export function WorktreeSwitcher({ termId, className }: WorktreeSwitcherProps) {
  const isGitRepo = useStore((s) => s.isGitRepo)
  const worktrees = useStore((s) => s.worktrees)
  const worktreesLoading = useStore((s) => s.worktreesLoading)
  const refreshWorktrees = useStore((s) => s.refreshWorktrees)
  const switchTerminalWorktree = useStore((s) => s.switchTerminalWorktree)
  const createWorktree = useStore((s) => s.createWorktree)
  const setWorktreesDir = useStore((s) => s.setWorktreesDir)
  const getWorktreesDir = useStore((s) => s.getWorktreesDir)
  const setWorktreeBaseBranch = useStore((s) => s.setWorktreeBaseBranch)
  const getWorktreeBaseBranch = useStore((s) => s.getWorktreeBaseBranch)
  const setOverlayOpen = useStore((s) => s.setOverlayOpen)

  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const [configuring, setConfiguring] = useState(false)

  const nonBare = worktrees.filter((wt) => !wt.isBare)

  useEffect(() => {
    if (open) refreshWorktrees()
  }, [open, refreshWorktrees])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      setOverlayOpen(next)
      if (!next) {
        setSearch('')
        setCreating(false)
        setConfiguring(false)
      }
    },
    [setOverlayOpen],
  )

  const handleSwitch = useCallback(
    async (wt: GitWorktree) => {
      if (wt.isBare) return
      setSwitching(wt.path)
      try {
        await switchTerminalWorktree(termId, wt.path)
      } finally {
        setSwitching(null)
        handleOpenChange(false)
      }
    },
    [switchTerminalWorktree, termId, handleOpenChange],
  )

  const handleCreate = useCallback(
    async (branch: string) => {
      if (!branch.trim()) return
      setSwitching('__creating__')
      try {
        const created = await createWorktree(branch.trim())
        await switchTerminalWorktree(termId, created.path)
      } catch (err) {
        console.error('Failed to create worktree:', err)
      } finally {
        setSwitching(null)
        handleOpenChange(false)
      }
    },
    [createWorktree, switchTerminalWorktree, termId, handleOpenChange],
  )

  const handlePickDir = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      const dir = await window.cells.app.pickFolder()
      if (dir) setWorktreesDir(dir)
      setConfiguring(false)
    },
    [setWorktreesDir],
  )

  if (!isGitRepo) return null

  return (
    <div className={cn('relative', className)}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          className="p-1 rounded-md transition-colors text-muted-foreground/40 hover:text-foreground hover:bg-muted/40"
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          title="Switch worktree"
        >
          <GitBranch className="w-3 h-3" />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={4}
          className="w-64 gap-0 p-0 overflow-hidden"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <CommandPrimitive
            loop
            className="flex flex-col"
            onKeyDown={(e) => {
              // When creating, Enter submits the new branch via the combobox
              if (
                e.key === 'Enter' &&
                search.trim() &&
                !nonBare.some((wt) => wt.branch === search.trim())
              ) {
                e.preventDefault()
                handleCreate(search)
              }
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-foreground/5">
              <span className="text-[11px] font-medium text-muted-foreground">Worktrees</span>
              <div className="flex items-center gap-1">
                <button
                  className="p-1 rounded text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfiguring(!configuring)
                  }}
                  title="Configure worktrees directory"
                >
                  <FolderOpen className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Configure worktrees */}
            {configuring && (
              <div className="px-3 py-2 border-b border-foreground/5 space-y-2">
                <div>
                  <div className="text-[10px] text-muted-foreground mb-1">Worktrees directory</div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground truncate flex-1">
                      {getWorktreesDir() || 'Default (next to repo)'}
                    </span>
                    <button
                      className="text-[10px] px-2 py-0.5 rounded bg-muted/60 hover:bg-muted text-foreground transition-colors shrink-0"
                      onClick={handlePickDir}
                    >
                      Browse
                    </button>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground mb-1">Base branch</div>
                  <div className="flex items-center gap-1.5">
                    <select
                      className="flex-1 text-[11px] bg-muted/60 rounded px-1.5 py-0.5 text-foreground outline-none focus:ring-1 focus:ring-primary/40 truncate"
                      value={getWorktreeBaseBranch() || ''}
                      onChange={(e) => setWorktreeBaseBranch(e.target.value)}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <option value="">Default (HEAD)</option>
                      {nonBare.map((wt) => (
                        <option key={wt.branch} value={wt.branch}>
                          {wt.branch}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* Search input */}
            <div className="px-2 pt-2 pb-1">
              <CommandPrimitive.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search or create branch..."
                className="w-full bg-muted/60 rounded px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-1 focus:ring-primary/40"
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>

            {/* Worktree list */}
            <CommandPrimitive.List className="max-h-48 overflow-y-auto py-1">
              <CommandPrimitive.Empty className="px-3 py-2 text-[11px] text-muted-foreground/60">
                {search.trim() ? (
                  <span>
                    Press Enter to create <strong>{search.trim()}</strong>
                  </span>
                ) : (
                  'No worktrees found'
                )}
              </CommandPrimitive.Empty>

              {worktreesLoading ? (
                <div className="flex items-center justify-center py-3">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground/40" />
                </div>
              ) : (
                <>
                  {/* Create new branch option — shown when search doesn't match existing */}
                  {search.trim() && !nonBare.some((wt) => wt.branch === search.trim()) && (
                    <CommandPrimitive.Item
                      value={`create-branch ${search.trim()}`}
                      onSelect={() => handleCreate(search)}
                      className="flex items-center gap-2 px-3 py-1.5 text-left cursor-default rounded-sm mx-1 data-[selected=true]:bg-muted/60"
                    >
                      <Plus className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                      <span className="text-[11px] text-foreground truncate">
                        Create <strong>{search.trim()}</strong>
                      </span>
                    </CommandPrimitive.Item>
                  )}

                  {nonBare.map((wt) => (
                    <CommandPrimitive.Item
                      key={wt.path}
                      value={`${wt.branch} ${wt.path}`}
                      onSelect={() => handleSwitch(wt)}
                      disabled={switching !== null}
                      className={cn(
                        'flex items-center gap-2 px-3 py-1.5 text-left cursor-default rounded-sm mx-1 data-[selected=true]:bg-muted/60',
                        switching === wt.path && 'opacity-50',
                      )}
                    >
                      <GitBranch className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-medium text-foreground truncate">
                          {wt.branch}
                        </div>
                        <div className="text-[10px] text-muted-foreground/50 truncate">
                          {wt.path.replace(/^\/Users\/[^/]+/, '~')}
                        </div>
                      </div>
                      {wt.isMain && <Check className="w-3 h-3 text-primary/60 shrink-0" />}
                      {switching === wt.path && (
                        <Loader2 className="w-3 h-3 animate-spin text-muted-foreground/40 shrink-0" />
                      )}
                    </CommandPrimitive.Item>
                  ))}
                </>
              )}
            </CommandPrimitive.List>
          </CommandPrimitive>
        </PopoverContent>
      </Popover>
    </div>
  )
}
