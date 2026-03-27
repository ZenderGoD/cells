import React, { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
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
  TerminalSquare,
  X,
  Image,
  FileText,
  Paperclip,
  Camera,
  Download,
  Copy,
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
import { showToast } from './toast'

const AGENT_OPTIONS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
] as const

interface Attachment {
  path: string
  name: string
}

function shellEscapePath(filePath: string) {
  if (/^[A-Za-z0-9_./-]+$/.test(filePath)) return filePath
  return `'${filePath.replace(/'/g, `'\\''`)}'`
}

function buildPromptWithAttachments(prompt: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return prompt
  const filePaths = attachments.map((a) => shellEscapePath(a.path)).join(' ')
  if (!prompt) return filePaths
  return `${prompt}\n\n${filePaths}`
}

function launchAgentAction(
  id: string,
  label: string,
  inWorktree: boolean,
  searchText: string,
  attachments: Attachment[] = [],
) {
  useStore.getState().setLastUsedAgent(id)
  useStore.getState().setLastCommandAction('agent')
  const cmd = useStore.getState().getAgentCommand(id)
  const prompt = buildPromptWithAttachments(searchText.trim(), attachments)

  if (!inWorktree) {
    if (!prompt) {
      useStore.getState().addTerminalWithCommand(cmd, label)
      return
    }
    const escaped = prompt.replace(/'/g, "'\\''")
    useStore
      .getState()
      .addTerminalWithCommand(
        `${cmd} '${escaped}'`,
        `${label}: ${searchText.trim().slice(0, 40) || 'attachments'}`,
      )
    return
  }

  // Create a worktree with a generated temp branch, then launch the agent in it
  const tempBranch = `ghost-${Date.now().toString(36)}`
  useStore
    .getState()
    .createWorktree(tempBranch)
    .then((wt) => {
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
          `${label}: ${searchText.trim() ? searchText.trim().slice(0, 40) : 'worktree'}`,
          wt.path,
        )
    })
    .catch((err) => {
      showToast(
        `Worktree failed, launching without it: ${err instanceof Error ? err.message : err}`,
      )
      // Fallback: launch without worktree
      if (!prompt) {
        useStore.getState().addTerminalWithCommand(cmd, label)
      } else {
        const escaped = prompt.replace(/'/g, "'\\''")
        useStore
          .getState()
          .addTerminalWithCommand(
            `${cmd} '${escaped}'`,
            `${label}: ${searchText.trim().slice(0, 40) || 'attachments'}`,
          )
      }
    })
}

/** Returns the matched prefix config for the current input, if any. */
function matchInputPrefix(text: string) {
  const prefixes = useStore.getState().inputPrefixes
  // Match longest prefix first so e.g. '!!' beats '!'
  const sorted = [...prefixes].sort((a, b) => b.prefix.length - a.prefix.length)
  for (const p of sorted) {
    if (p.prefix && text.startsWith(p.prefix)) return p
  }
  return null
}

/** Reads the cmdk selected value to show a contextual icon in the input. Must be inside <Command>. */
function DynamicCommandInput({
  searchText,
  ...props
}: React.ComponentProps<typeof CommandInput> & { multiline?: boolean; searchText?: string }) {
  const selectedValue = useCommandState((state) => state.value) ?? ''
  const prefix = searchText ? matchInputPrefix(searchText) : null

  let icon: ReactNode = undefined

  // Prefix-based icon takes priority
  if (prefix) {
    if (prefix.target === 'terminal') {
      icon = <TerminalSquare className="size-4 shrink-0 opacity-70" />
    } else if (prefix.target === 'browser') {
      icon = <Globe className="size-4 shrink-0 opacity-70" />
    } else if (prefix.target === 'agent' && prefix.agentId) {
      icon = (
        <AgentIcon
          agent={prefix.agentId as 'claude' | 'codex'}
          className="size-4 shrink-0 opacity-70"
          size={16}
        />
      )
    }
  }

  if (!icon) {
    for (const { id } of AGENT_OPTIONS) {
      if (selectedValue.startsWith(`agent-${id}`)) {
        icon = <AgentIcon agent={id} className="size-4 shrink-0 opacity-70" size={16} />
        break
      }
    }
  }
  if (!icon && selectedValue.startsWith('search-')) {
    icon = <Search className="size-4 shrink-0 opacity-50" />
  }

  return <CommandInput multiline icon={icon} {...props} />
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])

function getAttachmentIcon(name: string) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return Image
  return FileText
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [showSettingsRaw, setShowSettingsRaw] = useState(false)
  const [showNewProjectRaw, setShowNewProjectRaw] = useState(false)
  const [search, setSearch] = useState('')
  const [agents, setAgents] = useState<Record<string, boolean>>({})
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [recentFiles, setRecentFiles] = useState<
    Array<{ path: string; name: string; mtime: number; source: string }>
  >([])
  const [shellHistory, setShellHistory] = useState<string[]>([])
  const [cmdkValue, setCmdkValue] = useState('')
  const cmdkValueRef = useRef(cmdkValue)
  cmdkValueRef.current = cmdkValue
  const terminals = useStore((s) => s.terminals)
  const browsers = useStore((s) => s.browsers)
  const terminalTheme = useStore((s) => s.terminalTheme)
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const setOverlayOpen = useStore((s) => s.setOverlayOpen)
  const agentAliases = useStore((s) => s.agentAliases)
  const enabledAgents = useStore((s) => s.enabledAgents)
  const lastUsedAgent = useStore((s) => s.lastUsedAgent)
  const lastCommandAction = useStore((s) => s.lastCommandAction)
  const isGitRepo = useStore((s) => s.isGitRepo)
  const worktrees = useStore((s) => s.worktrees)
  const focusedTerminalId = useStore((s) => s.focusedTerminalId)
  const selectionMode = useStore((s) => s.selectionMode)
  const selectedNodeIds = useStore((s) => s.selectedNodeIds)
  const availableAgents = AGENT_OPTIONS.filter(({ id }) => agents[id])
  const wordCount = search.trim().split(/\s+/).filter(Boolean).length
  const isPromptMode = wordCount > 10
  // Show agents before search if user recently used an agent, or fall back to prompt-mode heuristic
  const agentsFirst =
    lastCommandAction === 'agent' ||
    (lastCommandAction !== 'search' && (isPromptMode || attachments.length > 0))

  const addAttachments = useCallback(async (paths: string[]) => {
    const newAttachments = paths.map((p) => ({
      path: p,
      name: p.split('/').pop() || p,
    }))
    setAttachments((prev) => {
      const existing = new Set(prev.map((a) => a.path))
      return [...prev, ...newAttachments.filter((a) => !existing.has(a.path))]
    })
  }, [])

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path))
  }, [])

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
      window.cells.agent.checkAvailable(agentAliases).then((detected) => {
        // Apply enabledAgents overrides: true = force on, false = force off, 'auto'/undefined = use detected
        const merged = { ...detected }
        for (const { id } of AGENT_OPTIONS) {
          const override = enabledAgents[id]
          if (override === true) merged[id] = true
          else if (override === false) merged[id] = false
          // 'auto' or undefined → keep detected value
        }
        setAgents(merged)
      })
      useStore.getState().refreshWorktrees()
      window.cells.app
        .listRecentFiles()
        .then(setRecentFiles)
        .catch(() => {})
      window.cells.app
        .getShellHistory()
        .then(setShellHistory)
        .catch(() => {})
    }
  }, [open, agentAliases, enabledAgents])

  const runAction = (fn: () => any) => {
    const close = () => {
      setOpen(false)
      setSearch('')
      setAttachments([])
      setOverlayOpen(false)
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('terminal-refocus'))
      })
    }
    const handleError = (err: Error | string) => {
      const raw = err instanceof Error ? err.message : err
      // Extract the most useful line from verbose git/command errors
      const fatal = raw.match(/fatal:\s*(.+)/)?.[1]
      const error = raw.match(/error:\s*(.+)/)?.[1]
      showToast(fatal ?? error ?? raw)
    }
    try {
      const result = fn()
      if (result instanceof Promise) {
        result.then(close, handleError)
      } else {
        close()
      }
    } catch (err) {
      handleError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value)
  }, [])

  // Scroll to top and fix dropped selection when search text changes
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => {
      const list = document.querySelector('[cmdk-list]') as HTMLElement | null
      if (!list) return
      list.scrollTop = 0
      const selected = list.querySelector('[cmdk-item][data-selected="true"]') as HTMLElement | null
      if (!selected || selected.offsetParent === null) {
        const items = list.querySelectorAll('[cmdk-item]')
        if (items.length > 0) {
          // When searching, select the last item (closest to the input at bottom)
          const target = search.trim()
            ? (items[items.length - 1] as HTMLElement)
            : (items[0] as HTMLElement)
          const val = target.getAttribute('data-value')
          if (val) setCmdkValue(val)
        }
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [search, open])

  const handleOpenChange = (o: boolean) => {
    setOpen(o)
    setOverlayOpen(o)
    if (!o) {
      setSearch('')
      setAttachments([])
      // Re-focus the active terminal so keyboard input works immediately
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('terminal-refocus'))
      })
    }
  }

  // Handle paste events when the palette is open
  useEffect(() => {
    if (!open) return
    const handlePaste = async (e: ClipboardEvent) => {
      // Check for files/images in clipboard
      const filePaths = await window.cells.app.pasteClipboardFiles()
      if (filePaths && filePaths.length > 0) {
        e.preventDefault()
        e.stopPropagation()
        addAttachments(filePaths)
        return
      }
      // Check for files in the DataTransfer (drag-pasted files)
      if (e.clipboardData?.files && e.clipboardData.files.length > 0) {
        const paths: string[] = []
        for (const file of Array.from(e.clipboardData.files)) {
          try {
            const path = window.cells.app.getPathForFile(file)
            if (path) paths.push(path)
          } catch {
            // If getPathForFile fails, try saving as temp file
            const buf = new Uint8Array(await file.arrayBuffer())
            const saved = await window.cells.app.saveTempFile(buf, file.name)
            if (saved) paths.push(saved)
          }
        }
        if (paths.length > 0) {
          e.preventDefault()
          e.stopPropagation()
          addAttachments(paths)
          return
        }
      }
      // Let text paste through to the input naturally
    }
    document.addEventListener('paste', handlePaste, true)
    return () => document.removeEventListener('paste', handlePaste, true)
  }, [open, addAttachments])

  const searchInBrowser = () => {
    if (!search.trim()) return
    useStore.getState().setLastCommandAction('search')
    runAction(() => useStore.getState().addBrowserWithUrl(search.trim()))
  }

  const runAsTerminalCommand = (command: string) => {
    if (!command.trim()) return
    const label = command.trim().slice(0, 40)
    runAction(() => useStore.getState().addTerminalWithCommand(command.trim(), label))
  }

  /** Execute the action for a matched prefix, returning true if handled. */
  const executePrefixAction = (text: string): boolean => {
    const prefix = matchInputPrefix(text)
    if (!prefix) return false
    const body = text.slice(prefix.prefix.length).trim()
    if (!body) return false

    if (prefix.target === 'terminal') {
      runAsTerminalCommand(body)
      return true
    }
    if (prefix.target === 'browser') {
      runAction(() => useStore.getState().addBrowserWithUrl(body))
      return true
    }
    if (prefix.target === 'agent' && prefix.agentId) {
      const agent = AGENT_OPTIONS.find((a) => a.id === prefix.agentId)
      if (agent) {
        runAction(() => launchAgentAction(agent.id, agent.label, false, body, attachments))
        return true
      }
    }
    return false
  }

  const renderAgentsGroup = () => (
    <CommandGroup heading="AI Agents" forceMount>
      {sortedAgents.map(({ id, label }) => (
        <CommandItem
          key={id}
          forceMount
          value={`agent-${id}-${getAgentCommandLabel(id)}`}
          onSelect={() => {
            const withWorktree = wasLastSelectWithMeta()
            runAction(() => {
              launchAgentAction(id, label, withWorktree, search, attachments)
            })
          }}
        >
          <AgentIcon agent={id} className="text-muted-foreground" size={16} />
          <span className="truncate">
            {search.trim() && attachments.length > 0
              ? `Ask ${label} with ${attachments.length} file${attachments.length > 1 ? 's' : ''}: "${search.trim().slice(0, 40)}"`
              : search.trim()
                ? `Ask ${label}: "${search.trim().slice(0, 50)}"`
                : attachments.length > 0
                  ? `Send ${attachments.length} file${attachments.length > 1 ? 's' : ''} to ${label}`
                  : `New ${label} Terminal`}
          </span>
          <span className="ml-auto max-w-40 shrink-0 truncate text-[10px] font-mono text-muted-foreground/40">
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
        <Command
          loop
          value={cmdkValue}
          onValueChange={setCmdkValue}
          filter={(value, search) => {
            // Give forceMount items a non-zero score so cmdk includes them in
            // auto-selection when no other items match the search text.
            if (
              value.startsWith('agent-') ||
              value === 'search-web' ||
              value === 'run-terminal-command' ||
              value === 'create-worktree-new-branch'
            ) {
              return 1
            }
            if (!search) return 1
            const v = value.toLowerCase()
            const s = search.toLowerCase()
            if (v.includes(s)) return 1
            // Basic fuzzy: all search chars appear in order
            let j = 0
            for (let i = 0; i < v.length && j < s.length; i++) {
              if (v[i] === s[j]) j++
            }
            return j === s.length ? 1 : 0
          }}
          onDragOver={(e) => {
            if (e.dataTransfer?.types.some((t) => t === 'Files' || t === 'text/uri-list')) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
            }
          }}
          onDrop={(e) => {
            e.preventDefault()
            const paths: string[] = []
            if (e.dataTransfer?.files) {
              for (const file of Array.from(e.dataTransfer.files)) {
                try {
                  const p = window.cells.app.getPathForFile(file)
                  if (p) paths.push(p)
                } catch {}
              }
            }
            if (paths.length === 0 && e.dataTransfer) {
              const uriList = e.dataTransfer.getData('text/uri-list')
              if (uriList) {
                uriList
                  .split(/\r?\n/)
                  .map((l) => l.trim())
                  .filter((l) => l && !l.startsWith('#') && l.startsWith('file://'))
                  .forEach((l) => {
                    try {
                      paths.push(decodeURIComponent(new URL(l).pathname))
                    } catch {}
                  })
              }
            }
            if (paths.length > 0) addAttachments(paths)
          }}
        >
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
              <CommandItem
                value="attach-file-from-finder"
                onSelect={async () => {
                  const paths = await window.cells.app.pickFiles()
                  if (paths && paths.length > 0) {
                    addAttachments(paths)
                  }
                }}
              >
                <Paperclip className="text-muted-foreground" />
                Attach File...
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
                          value="create-worktree-new-branch"
                          onSelect={() =>
                            runAction(() => useStore.getState().createWorktree(search.trim()))
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

            {recentFiles.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Recent Files">
                  {recentFiles.map((f) => {
                    const Icon = f.source === 'screenshot' ? Camera : Download
                    const isAttached = attachments.some((a) => a.path === f.path)
                    return (
                      <CommandItem
                        key={f.path}
                        value={`recent-file ${f.name} ${f.source}`}
                        data-checked={isAttached ? 'true' : undefined}
                        onSelect={() => {
                          if (wasLastSelectWithMeta()) {
                            navigator.clipboard.writeText(f.path).catch(() => {})
                            showToast('Copied path to clipboard')
                          } else {
                            addAttachments([f.path])
                          }
                        }}
                      >
                        <Icon className="text-muted-foreground" size={16} />
                        <span className="truncate">{f.name}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground/40">
                          {f.source}
                        </span>
                        <CommandShortcut>⌘↵ copy path</CommandShortcut>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </>
            )}

            {/* Dynamic ordering: show recently-used action type (agent/search) first */}
            {agentsFirst ? (
              <>
                {sortedAgents.length > 0 && (
                  <>
                    <CommandSeparator />
                    {renderAgentsGroup()}
                  </>
                )}
                {search.trim() && (
                  <>
                    <CommandSeparator />
                    <CommandGroup heading="Search" forceMount>
                      <CommandItem forceMount onSelect={searchInBrowser} value="search-web">
                        <Search className="text-muted-foreground" />
                        <span className="truncate">
                          Search for &ldquo;{search.trim().slice(0, 80)}&rdquo;
                        </span>
                      </CommandItem>
                    </CommandGroup>
                  </>
                )}
              </>
            ) : (
              <>
                {search.trim() && (
                  <>
                    <CommandSeparator />
                    <CommandGroup heading="Search" forceMount>
                      <CommandItem forceMount onSelect={searchInBrowser} value="search-web">
                        <Search className="text-muted-foreground" />
                        <span className="truncate">
                          Search for &ldquo;{search.trim().slice(0, 80)}&rdquo;
                        </span>
                      </CommandItem>
                    </CommandGroup>
                  </>
                )}
                {sortedAgents.length > 0 && (
                  <>
                    <CommandSeparator />
                    {renderAgentsGroup()}
                  </>
                )}
              </>
            )}

            {search.trim() && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Run" forceMount>
                  <CommandItem
                    forceMount
                    value="run-terminal-command"
                    onSelect={() => runAsTerminalCommand(search)}
                  >
                    <TerminalSquare className="text-muted-foreground" />
                    <span className="truncate">
                      Run in Terminal: &ldquo;{search.trim().slice(0, 80)}&rdquo;
                    </span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}

            {shellHistory.length > 0 &&
              (() => {
                // Pre-filter in React so non-matching items never enter the DOM.
                // This avoids confusing cmdk's auto-selection with many hidden items.
                const query = search.trim().toLowerCase()
                const filtered = query
                  ? shellHistory.filter((cmd) => cmd.toLowerCase().includes(query))
                  : shellHistory.slice(0, 15)
                if (filtered.length === 0) return null
                return (
                  <>
                    <CommandSeparator />
                    <CommandGroup heading="Shell History">
                      {filtered.slice(0, 15).map((cmd) => (
                        <CommandItem
                          key={`history-${cmd}`}
                          value={`shell-history ${cmd}`}
                          onSelect={() => runAsTerminalCommand(cmd)}
                        >
                          <TerminalSquare className="text-muted-foreground" />
                          <span className="truncate font-mono text-xs">{cmd}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )
              })()}

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
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2 py-1.5 border-t border-border/30">
              {attachments.map((a) => {
                const Icon = getAttachmentIcon(a.name)
                return (
                  <span
                    key={a.path}
                    className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    <Icon className="size-3 shrink-0" />
                    <span className="max-w-32 truncate">{a.name}</span>
                    <button
                      type="button"
                      className="ml-0.5 rounded-sm hover:bg-muted-foreground/20 p-0.5"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeAttachment(a.path)
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                )
              })}
            </div>
          )}
          <DynamicCommandInput
            placeholder="Search, enter URL, or type a prompt..."
            value={search}
            searchText={search}
            onValueChange={handleSearchChange}
            onKeyDown={(e) => {
              if (e.key === 'Backspace' && !search && attachments.length > 0) {
                e.preventDefault()
                setAttachments((prev) => prev.slice(0, -1))
                return
              }
              if (e.key === 'Enter' && search.trim()) {
                // Prefix match → execute prefix action directly
                if (matchInputPrefix(search)) {
                  e.preventDefault()
                  executePrefixAction(search)
                  return
                }
                // Enter with no matching command → search in new browser tab
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
        </Command>
      </CommandDialog>

      <AppSettings open={showSettingsRaw} onOpenChange={setShowSettings} />
      <NewProjectDialog open={showNewProjectRaw} onOpenChange={setShowNewProject} />
    </>
  )
}
