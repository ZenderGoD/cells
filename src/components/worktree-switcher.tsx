import { useState, useEffect, useRef, useCallback } from 'react'
import { GitBranch, Plus, Check, Loader2, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
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
  const [creating, setCreating] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [switching, setSwitching] = useState<string | null>(null)
  const [configuring, setConfiguring] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Refresh worktrees when dropdown opens
  useEffect(() => {
    if (open) {
      refreshWorktrees()
    }
  }, [open, refreshWorktrees])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: globalThis.MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
        setConfiguring(false)
        setOverlayOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, setOverlayOpen])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setCreating(false)
        setConfiguring(false)
        setOverlayOpen(false)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, setOverlayOpen])

  // Focus input when creating
  useEffect(() => {
    if (creating && inputRef.current) {
      inputRef.current.focus()
    }
  }, [creating])

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      const next = !open
      setOpen(next)
      if (!next) {
        setCreating(false)
        setConfiguring(false)
      }
      setOverlayOpen(next)
    },
    [open, setOverlayOpen],
  )

  const handleSwitch = useCallback(
    async (wt: GitWorktree) => {
      if (wt.isBare) return
      setSwitching(wt.path)
      try {
        await switchTerminalWorktree(termId, wt.path)
      } finally {
        setSwitching(null)
        setOpen(false)
        setOverlayOpen(false)
      }
    },
    [switchTerminalWorktree, termId, setOverlayOpen],
  )

  const handleCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const branch = newBranch.trim()
      if (!branch) return
      setSwitching('__creating__')
      try {
        const created = await createWorktree(branch)
        setNewBranch('')
        setCreating(false)
        // Switch to the newly created worktree
        await switchTerminalWorktree(termId, created.path)
      } catch (err) {
        console.error('Failed to create worktree:', err)
      } finally {
        setSwitching(null)
        setOpen(false)
        setOverlayOpen(false)
      }
    },
    [newBranch, createWorktree, switchTerminalWorktree, termId, setOverlayOpen],
  )

  const handlePickDir = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      const dir = await window.cells.app.pickFolder()
      if (dir) {
        setWorktreesDir(dir)
      }
      setConfiguring(false)
    },
    [setWorktreesDir],
  )

  if (!isGitRepo) return null

  return (
    <div className={cn('relative', className)} ref={dropdownRef}>
      <button
        className="p-1 rounded-md transition-colors text-muted-foreground/40 hover:text-foreground hover:bg-muted/40"
        onClick={handleToggle}
        title="Switch worktree"
      >
        <GitBranch className="w-3 h-3" />
      </button>

      {open && (
        <div
          className="absolute bottom-full right-0 mb-1 w-64 rounded-lg bg-popover shadow-lg ring-1 ring-foreground/10 z-50 overflow-hidden"
          onMouseDown={(e) => e.stopPropagation()}
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
                  setCreating(false)
                }}
                title="Configure worktrees directory"
              >
                <FolderOpen className="w-3 h-3" />
              </button>
              <button
                className="p-1 rounded text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  setCreating(!creating)
                  setConfiguring(false)
                }}
                title="Create new worktree"
              >
                <Plus className="w-3 h-3" />
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
                    {worktrees
                      .filter((wt) => !wt.isBare)
                      .map((wt) => (
                        <option key={wt.branch} value={wt.branch}>
                          {wt.branch}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Create new worktree form */}
          {creating && (
            <form onSubmit={handleCreate} className="px-3 py-2 border-b border-foreground/5">
              <input
                ref={inputRef}
                type="text"
                className="w-full bg-muted/60 rounded px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/40 outline-none focus:ring-1 focus:ring-primary/40"
                placeholder="Branch name..."
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </form>
          )}

          {/* Worktree list */}
          <div className="max-h-48 overflow-y-auto py-1">
            {worktreesLoading ? (
              <div className="flex items-center justify-center py-3">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground/40" />
              </div>
            ) : worktrees.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground/60">
                No worktrees found
              </div>
            ) : (
              worktrees
                .filter((wt) => !wt.isBare)
                .map((wt) => (
                  <button
                    key={wt.path}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors',
                      'hover:bg-muted/40',
                      switching === wt.path && 'opacity-50',
                    )}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleSwitch(wt)
                    }}
                    disabled={switching !== null}
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
                  </button>
                ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
