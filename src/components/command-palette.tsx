import React, { useState, useEffect, useMemo, type ReactNode } from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'
import {
  Globe,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Palette,
  Settings,
  FolderOpen,
  Search,
  LogOut,
  Skull,
  Cable,
  GitBranch,
} from 'lucide-react'
import { useCommandState } from 'cmdk'
import {
  CommandDialog,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
  wasLastSelectWithMeta,
} from '@/components/ui/command'
import { useStore } from '@/lib/store'
import { inferAgentFromTitle } from '@/lib/agent-command'
import { terminalThemes } from '@/lib/terminal-themes'
import { AppSettings } from './settings/app-settings'
import { NewProjectDialog } from './new-project-dialog'
import { AgentIcon } from './agent-icon'
import { Logo } from './logo'

const AGENT_OPTIONS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
] as const

/** Reads the cmdk selected value to show a contextual icon in the input. Must be inside <Command>. */
function DynamicCommandInput(
  props: React.ComponentProps<typeof CommandInput> & { multiline?: boolean },
) {
  const selectedValue = useCommandState((state) => state.value) ?? ''

  const icon: ReactNode = useMemo(() => {
    for (const { id } of AGENT_OPTIONS) {
      if (selectedValue.startsWith(`ask-${id}`) || selectedValue.startsWith(`new-${id}`)) {
        return <AgentIcon agent={id} className="size-4 shrink-0 opacity-70" size={16} />
      }
    }
    if (selectedValue.startsWith('search-')) {
      return <Search className="size-4 shrink-0 opacity-50" />
    }
    return undefined
  }, [selectedValue])

  return <CommandInput multiline icon={icon} {...props} />
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [showSettingsRaw, setShowSettingsRaw] = useState(false)
  const [showNewProjectRaw, setShowNewProjectRaw] = useState(false)
  const [search, setSearch] = useState('')
  const [agents, setAgents] = useState<Record<string, boolean>>({})
  const terminals = useStore((s) => s.terminals)
  const browsers = useStore((s) => s.browsers)
  const terminalTheme = useStore((s) => s.terminalTheme)
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const setOverlayOpen = useStore((s) => s.setOverlayOpen)
  const agentAliases = useStore((s) => s.agentAliases)
  const lastUsedAgent = useStore((s) => s.lastUsedAgent)
  const isGitRepo = useStore((s) => s.isGitRepo)
  const worktrees = useStore((s) => s.worktrees)
  const focusedTerminalId = useStore((s) => s.focusedTerminalId)
  const selectionMode = useStore((s) => s.selectionMode)
  const selectedNodeIds = useStore((s) => s.selectedNodeIds)
  const availableAgents = AGENT_OPTIONS.filter(({ id }) => agents[id])
  const wordCount = search.trim().split(/\s+/).filter(Boolean).length
  const isPromptMode = wordCount > 10

  // Sort agents: last used agent first
  const sortedAgents = [...availableAgents].sort((a, b) => {
    if (a.id === lastUsedAgent) return -1
    if (b.id === lastUsedAgent) return 1
    return 0
  })

  const getAgentCommandLabel = (agent: (typeof AGENT_OPTIONS)[number]['id']) => {
    const alias = agentAliases[agent]?.trim()
    return alias && alias.length > 0 ? alias : agent
  }

  const setShowSettings = (v: boolean) => {
    setShowSettingsRaw(v)
    setOverlayOpen(v)
  }
  const setShowNewProject = (v: boolean) => {
    setShowNewProjectRaw(v)
    setOverlayOpen(v)
  }

  useHotkey('Mod+T', () => {
    setOpen((o) => {
      const next = !o
      setOverlayOpen(next)
      if (!next) setSearch('')
      return next
    })
  })
  useHotkey('Mod+,', () => setShowSettings(true))

  useEffect(() => {
    if (open) {
      window.cells.agent.checkAvailable(agentAliases).then(setAgents)
      useStore.getState().refreshWorktrees()
    }
  }, [open, agentAliases])

  const runAction = (fn: () => void) => {
    fn()
    setOpen(false)
    setSearch('')
    setOverlayOpen(false)
  }

  const handleOpenChange = (o: boolean) => {
    setOpen(o)
    setOverlayOpen(o)
    if (!o) setSearch('')
  }

  const searchInBrowser = () => {
    if (!search.trim()) return
    runAction(() => useStore.getState().addBrowserWithUrl(search.trim()))
  }

  const launchAgent = async (id: string, label: string, inWorktree: boolean) => {
    useStore.getState().setLastUsedAgent(id)
    const cmd = useStore.getState().getAgentCommand(id)
    const prompt = search.trim()

    if (!inWorktree) {
      if (!prompt) {
        useStore.getState().addTerminalWithCommand(cmd, label)
        return
      }
      const escaped = prompt.replace(/'/g, "'\\''")
      useStore
        .getState()
        .addTerminalWithCommand(`${cmd} '${escaped}'`, `${label}: ${prompt.slice(0, 40)}`)
      return
    }

    // Create a worktree with a generated temp branch, then launch the agent in it
    try {
      const tempBranch = `ghost-${Date.now().toString(36)}`
      const wt = await useStore.getState().createWorktree(tempBranch)
      const branchInstruction =
        'First, create a descriptive git branch name for this task and switch to it with `git checkout -b <branch-name>`. Then:\n\n'
      const fullPrompt = prompt
        ? branchInstruction + prompt
        : branchInstruction + 'Waiting for instructions.'
      const escaped = fullPrompt.replace(/'/g, "'\\''")
      useStore
        .getState()
        .addTerminalInWorktree(
          `${cmd} '${escaped}'`,
          `${label}: ${prompt ? prompt.slice(0, 40) : 'worktree'}`,
          wt.path,
        )
    } catch (err) {
      console.error('Failed to create worktree for agent:', err)
      // Fallback: launch without worktree
      if (!prompt) {
        useStore.getState().addTerminalWithCommand(cmd, label)
      } else {
        const escaped = prompt.replace(/'/g, "'\\''")
        useStore
          .getState()
          .addTerminalWithCommand(`${cmd} '${escaped}'`, `${label}: ${prompt.slice(0, 40)}`)
      }
    }
  }

  const renderAgentsGroup = () => (
    <CommandGroup heading="AI Agents" forceMount>
      {sortedAgents.map(({ id, label }) => (
        <CommandItem
          key={`${id}-${search.trim() || 'new'}`}
          forceMount
          value={
            search.trim()
              ? `ask-${id}-${getAgentCommandLabel(id)}-${search}`
              : `new-${id}-${getAgentCommandLabel(id)}`
          }
          onSelect={() => {
            const withWorktree = wasLastSelectWithMeta()
            runAction(() => {
              launchAgent(id, label, withWorktree)
            })
          }}
        >
          <AgentIcon agent={id} className="text-muted-foreground" size={16} />
          {search.trim()
            ? `Ask ${label}: "${search.trim().slice(0, 50)}"`
            : `New ${label} Terminal`}
          <span className="ml-auto max-w-40 truncate text-[10px] font-mono text-muted-foreground/40">
            {getAgentCommandLabel(id)}
          </span>
          {id === lastUsedAgent && (
            <span className="text-[10px] text-muted-foreground/40">recent</span>
          )}
          {isGitRepo && <CommandShortcut>⌘↵ worktree</CommandShortcut>}
        </CommandItem>
      ))}
    </CommandGroup>
  )

  return (
    <>
      <CommandDialog open={open} onOpenChange={handleOpenChange} showCloseButton={false}>
        <Command loop>
          <DynamicCommandInput
            placeholder="Search, enter URL, or type a prompt..."
            value={search}
            onValueChange={setSearch}
            onKeyDown={(e) => {
              // Enter with no matching command → search in new browser tab
              if (e.key === 'Enter' && search.trim()) {
                const list = (e.target as HTMLElement)
                  .closest('[cmdk-root]')
                  ?.querySelector('[cmdk-item][data-selected="true"]')
                if (!list) {
                  e.preventDefault()
                  searchInBrowser()
                }
              }
            }}
          />
          <CommandList>
            <CommandEmpty className="hidden" />

            {projects.length > 1 && (
              <>
                <CommandGroup heading="Projects">
                  {projects.map((p) => (
                    <CommandItem
                      key={p.id}
                      onSelect={() => runAction(() => useStore.getState().switchProject(p.id))}
                      data-checked={p.id === activeProjectId ? 'true' : undefined}
                    >
                      <FolderOpen className="text-muted-foreground" />
                      {p.name}
                      <span className="ml-auto text-[10px] text-muted-foreground/40 truncate max-w-40">
                        {p.path}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            <CommandGroup heading="Actions">
              <CommandItem onSelect={() => runAction(() => useStore.getState().addTerminal())}>
                <Plus className="text-muted-foreground" />
                New Terminal
                <CommandShortcut>↵</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => runAction(() => useStore.getState().addBrowser())}>
                <Globe className="text-muted-foreground" />
                New Browser
              </CommandItem>
              <CommandItem onSelect={() => runAction(() => useStore.getState().reloadFocused())}>
                <RefreshCw className="text-muted-foreground" />
                Reload Window
                <CommandShortcut>⌘R</CommandShortcut>
              </CommandItem>
              <CommandItem
                onSelect={() =>
                  runAction(() => useStore.getState().setCanvasTransform({ x: 0, y: 0, scale: 1 }))
                }
              >
                <RotateCcw className="text-muted-foreground" />
                Reset View
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setOpen(false)
                  setSearch('')
                  setShowSettings(true)
                }}
              >
                <Settings className="text-muted-foreground" />
                Settings
                <CommandShortcut>⌘,</CommandShortcut>
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setOpen(false)
                  setSearch('')
                  setShowSettings(true)
                }}
              >
                <Puzzle className="text-muted-foreground" />
                Manage Extensions
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  const project = useStore
                    .getState()
                    .projects.find((p) => p.id === useStore.getState().activeProjectId)
                  if (!project) return
                  runAction(() => {
                    window.cells.mcp.install(project.path).catch(() => {})
                  })
                }}
              >
                <Cable className="text-muted-foreground" />
                Install MCP Server
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setOpen(false)
                  setSearch('')
                  setShowNewProject(true)
                }}
              >
                <FolderOpen className="text-muted-foreground" />
                New Project
              </CommandItem>
              <CommandItem
                onSelect={() => runAction(() => useStore.getState().removeAllTerminals())}
              >
                <Skull className="text-muted-foreground" />
                Kill All Processes
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  void window.cells.app.requestQuit()
                }}
              >
                <LogOut className="text-muted-foreground" />
                Quit Cells
                <CommandShortcut>⌘Q</CommandShortcut>
              </CommandItem>
            </CommandGroup>

            {isGitRepo &&
              (() => {
                const nonBare = worktrees.filter((w) => !w.isBare)
                // Determine which terminal IDs will be moved
                const selectedTermIds =
                  selectionMode && selectedNodeIds.length > 0
                    ? selectedNodeIds.filter((id) => terminals.some((t) => t.id === id))
                    : focusedTerminalId
                      ? [focusedTerminalId]
                      : []
                const hasMoveTargets = selectedTermIds.length > 0 && nonBare.length > 1
                const moveLabel =
                  selectionMode && selectedTermIds.length > 1
                    ? `Move ${selectedTermIds.length} terminals to`
                    : 'Move to worktree'

                return (
                  <>
                    <CommandSeparator />
                    {hasMoveTargets && (
                      <CommandGroup heading={moveLabel}>
                        {nonBare.map((wt) => (
                          <CommandItem
                            key={`wt-${wt.path}`}
                            value={`move to worktree ${wt.branch} ${wt.path}`}
                            onSelect={() =>
                              runAction(() => {
                                useStore
                                  .getState()
                                  .moveTerminalsToWorktree(selectedTermIds, wt.path)
                              })
                            }
                          >
                            <GitBranch className="text-muted-foreground" />
                            {wt.branch}
                            {wt.isMain && (
                              <span className="ml-1 text-[10px] text-muted-foreground/40">
                                main
                              </span>
                            )}
                            <span className="ml-auto text-[10px] text-muted-foreground/40 truncate max-w-40">
                              {wt.path.replace(/^\/Users\/[^/]+/, '~')}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                    <CommandGroup heading="Worktrees">
                      {search.trim() && !nonBare.some((wt) => wt.branch === search.trim()) && (
                        <CommandItem
                          forceMount
                          value={`create worktree new branch ${search}`}
                          onSelect={() =>
                            runAction(() => {
                              useStore.getState().createWorktree(search.trim()).catch(console.error)
                            })
                          }
                        >
                          <Plus className="text-muted-foreground" />
                          Create worktree &ldquo;{search.trim()}&rdquo;
                        </CommandItem>
                      )}
                      {nonBare.map((wt) => (
                        <CommandItem
                          key={`wt-open-${wt.path}`}
                          value={`open worktree terminal ${wt.branch} ${wt.path}`}
                          onSelect={() =>
                            runAction(() => {
                              const term = useStore.getState().addTerminal()
                              useStore.getState().switchTerminalWorktree(term.id, wt.path)
                            })
                          }
                        >
                          <GitBranch className="text-muted-foreground" />
                          Open terminal in {wt.branch}
                          <span className="ml-auto text-[10px] text-muted-foreground/40 truncate max-w-40">
                            {wt.path.replace(/^\/Users\/[^/]+/, '~')}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )
              })()}

            {terminals.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Terminals">
                  {terminals.map((t) => (
                    <CommandItem
                      key={t.id}
                      onSelect={() => runAction(() => useStore.getState().snapToTerminal(t.id))}
                    >
                      {(t.agent ?? inferAgentFromTitle(t.title)) ? (
                        <AgentIcon
                          agent={t.agent ?? inferAgentFromTitle(t.title)}
                          className="text-muted-foreground"
                          size={16}
                        />
                      ) : (
                        <Logo className="h-4 w-4 text-muted-foreground" />
                      )}
                      {t.title}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {browsers.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Browsers">
                  {browsers.map((b) => (
                    <CommandItem
                      key={b.id}
                      onSelect={() => runAction(() => useStore.getState().snapToBrowser(b.id))}
                    >
                      <Globe className="text-muted-foreground" />
                      {b.title || b.url || 'New Tab'}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {/* When prompt is long (>10 words), show AI Agents first, then Search */}
            {isPromptMode && sortedAgents.length > 0 && (
              <>
                <CommandSeparator />
                {renderAgentsGroup()}
              </>
            )}

            {search.trim() && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Search" forceMount>
                  <CommandItem forceMount onSelect={searchInBrowser} value={`search-${search}`}>
                    <Search className="text-muted-foreground" />
                    Search for &ldquo;{search.trim().slice(0, 80)}&rdquo;
                  </CommandItem>
                </CommandGroup>
              </>
            )}

            {!isPromptMode && sortedAgents.length > 0 && (
              <>
                <CommandSeparator />
                {renderAgentsGroup()}
              </>
            )}

            <CommandSeparator />
            <CommandGroup heading="Theme">
              {Object.entries(terminalThemes).map(([key, theme]) => (
                <CommandItem
                  key={key}
                  onSelect={() => runAction(() => useStore.getState().setTerminalTheme(key))}
                  data-checked={key === terminalTheme ? 'true' : undefined}
                >
                  <Palette className="text-muted-foreground" />
                  {theme.name}
                  <div className="ml-auto flex items-center gap-1">
                    <div
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ background: theme.background }}
                    />
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: theme.red }} />
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: theme.green }} />
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: theme.blue }} />
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>

      <AppSettings open={showSettingsRaw} onOpenChange={setShowSettings} />
      <NewProjectDialog open={showNewProjectRaw} onOpenChange={setShowNewProject} />
    </>
  )
}
