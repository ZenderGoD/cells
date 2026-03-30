/**
 * IMPORTANT — Ordering convention for this command palette:
 *
 * The text input sits at the BOTTOM of the palette. The command list scrolls
 * above it and is auto-scrolled to the bottom so the last rendered item is
 * the default selection (closest to the input).
 *
 * Therefore: **LAST in render order = BOTTOM of the list = MOST RELEVANT**.
 *
 * When sorting or ordering items, the most preferred / most recently used /
 * most relevant item must sort LAST (positive comparator return), NOT first.
 * This is the opposite of typical list conventions — double-check any .sort()
 * calls to ensure they follow this rule.
 */
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
  LayoutGrid,
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
} from '@/components/ui/command'
import { useStore } from '@/lib/store'
import { inferAgentFromTitle } from '@/lib/agent-command'
import { terminalThemes } from '@/lib/terminal-themes'
import { AppSettings } from './settings/app-settings'
import { NewProjectDialog } from './new-project-dialog'
import { AgentIcon } from './agent-icon'
import { Logo } from './logo'
import { Kbd } from './ui/kbd'
import { showToast } from './toast'
import { hapticNudge, hapticSuccess } from '@/lib/haptics'

const AGENT_OPTIONS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
] as const

interface Attachment {
  path: string
  name: string
  thumbnailUrl?: string
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
  useStore.getState().trackCommandAction(`agent-${id}`)
  const cmd = useStore.getState().getAgentCommand(id)
  const prompt = stripPrefix(searchText.trim())

  // Build image/file attachment flags for the CLI
  const imageAttachments = attachments.filter((a) => isImageFile(a.name))
  const fileAttachments = attachments.filter((a) => !isImageFile(a.name))

  // Only codex supports -i flag for images
  const isCodex = id === 'codex'
  const imageFlags = isCodex
    ? imageAttachments.map((a) => `-i "${a.path.replace(/"/g, '\\"')}"`).join(' ')
    : ''

  // Only include file attachments (not images) as text references
  const filePaths = fileAttachments.map((a) => `[${a.path}]`).join(' ')

  // Build the full prompt with file references (codex images are passed via flags)
  let fullPromptText = prompt
  if (filePaths) {
    fullPromptText = prompt ? `${prompt}\n\n${filePaths}` : filePaths
  }

  if (!inWorktree) {
    if (!fullPromptText && imageAttachments.length === 0) {
      useStore.getState().addTerminalWithCommand(cmd, label)
      return
    }

    let fullCommand = cmd
    if (imageFlags) fullCommand += ` ${imageFlags}`
    if (fullPromptText) {
      const escaped = fullPromptText.replace(/'/g, "'\\''")
      fullCommand += ` '${escaped}'`
    }

    useStore
      .getState()
      .addTerminalWithCommand(
        fullCommand,
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
      const branchInstruction = `First, create a descriptive git branch name for this task and switch to it with \`git checkout -b <branch-name>\`. Then delete the temporary branch that was used to set up this worktree with \`git branch -D ${tempBranch}\`. Then:\n\n`
      const finalPrompt = fullPromptText
        ? branchInstruction + fullPromptText
        : branchInstruction + 'Waiting for instructions.'

      let fullCommand = cmd
      if (imageFlags) fullCommand += ` ${imageFlags}`
      const escaped = finalPrompt.replace(/'/g, "'\\''")
      fullCommand += ` '${escaped}'`

      useStore
        .getState()
        .addTerminalInWorktree(
          fullCommand,
          `${label}: ${searchText.trim() ? searchText.trim().slice(0, 40) : 'worktree'}`,
          wt.path,
        )
    })
    .catch((err) => {
      showToast(
        `Worktree failed, launching without it: ${err instanceof Error ? err.message : err}`,
      )
      // Fallback: launch without worktree
      if (!fullPromptText && imageAttachments.length === 0) {
        useStore.getState().addTerminalWithCommand(cmd, label)
      } else {
        let fullCommand = cmd
        if (imageFlags) fullCommand += ` ${imageFlags}`
        if (fullPromptText) {
          const escaped = fullPromptText.replace(/'/g, "'\\''")
          fullCommand += ` '${escaped}'`
        }
        useStore
          .getState()
          .addTerminalWithCommand(
            fullCommand,
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

/** Strip any configured prefix from text and return just the content. */
function stripPrefix(text: string): string {
  const prefix = matchInputPrefix(text)
  if (!prefix) return text
  return text.slice(prefix.prefix.length).trim()
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
    icon = <Search className="size-4 shrink-0 opacity-70" />
  }
  if (
    !icon &&
    (selectedValue === 'run-terminal-command' || selectedValue.startsWith('shell-history '))
  ) {
    icon = <TerminalSquare className="size-4 shrink-0 opacity-70" />
  }

  // Resolved icon already found — skip the async DOM fallback entirely
  const hasKnownIcon = !!icon

  // Generic fallback: read the icon SVG from the currently selected item in the DOM.
  // This covers all item types (actions, themes, terminals, browsers, etc.) without
  // needing an explicit value→icon map for every item.
  // Uses useLayoutEffect to read synchronously after React commits, avoiding flicker.
  const [selectedIconHtml, setSelectedIconHtml] = useState<string | null>(null)
  useEffect(() => {
    if (hasKnownIcon) return
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector('[cmdk-item][data-selected="true"]')
      const svg = el?.querySelector(':scope > svg')
      setSelectedIconHtml(svg ? svg.outerHTML : null)
    })
    return () => cancelAnimationFrame(raf)
  }, [selectedValue, hasKnownIcon])

  // Fallback to the DOM-read icon for any other item type (actions, themes, etc.)
  if (!icon && selectedIconHtml) {
    icon = (
      <span
        className="flex size-4 shrink-0 opacity-70 [&>svg]:size-4"
        dangerouslySetInnerHTML={{ __html: selectedIconHtml }}
      />
    )
  }

  return <CommandInput multiline icon={icon} {...props} />
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])

function isImageFile(name: string) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

function getAttachmentIcon(name: string) {
  if (isImageFile(name)) return Image
  return FileText
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [cmdHeld, setCmdHeld] = useState(false)
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
  useEffect(() => {
    cmdkValueRef.current = cmdkValue
  }, [cmdkValue])
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
  const commandActionCounts = useStore((s) => s.commandActionCounts)
  const isGitRepo = useStore((s) => s.isGitRepo)
  const worktrees = useStore((s) => s.worktrees)
  const focusedTerminalId = useStore((s) => s.focusedTerminalId)
  const selectionMode = useStore((s) => s.selectionMode)
  const selectedNodeIds = useStore((s) => s.selectedNodeIds)
  const availableAgents = AGENT_OPTIONS.filter(({ id }) => agents[id])
  const wordCount = search.trim().split(/\s+/).filter(Boolean).length
  const isPromptMode = wordCount > 10
  // Determine which catch-all group appears at the bottom (closest to input = default selected).
  // Uses per-project usage counts first, then falls back to lastCommandAction, then heuristic.
  // Aggregate agent counts into a single "agent" bucket for group ordering.
  const agentTotal = Object.entries(commandActionCounts)
    .filter(([k]) => k.startsWith('agent-'))
    .reduce((sum, [, v]) => sum + v, 0)
  const groupCounts = {
    agent: agentTotal,
    search: commandActionCounts.search ?? 0,
    run: commandActionCounts.run ?? 0,
  }
  const hasAnyCounts = groupCounts.agent + groupCounts.search + groupCounts.run > 0
  const bottomAction: 'agent' | 'search' | 'run' = hasAnyCounts
    ? // Most used group goes to bottom (= most relevant, closest to input)
      groupCounts.agent >= groupCounts.run && groupCounts.agent >= groupCounts.search
      ? 'agent'
      : groupCounts.run >= groupCounts.search
        ? 'run'
        : 'search'
    : lastCommandAction === 'agent'
      ? 'agent'
      : lastCommandAction === 'run'
        ? 'run'
        : lastCommandAction === 'search'
          ? 'search'
          : isPromptMode || attachments.length > 0
            ? 'agent'
            : 'run'

  // Check if there are shell history matches to hide catch-all options when history matches exist
  const hasShellHistoryMatches =
    shellHistory.length > 0 &&
    (() => {
      const query = search.trim().toLowerCase()
      const filtered = query
        ? shellHistory.filter((cmd) => cmd.toLowerCase().includes(query))
        : shellHistory.slice(0, 15)
      return filtered.length > 0
    })()

  const addAttachments = useCallback(async (paths: string[]) => {
    const newAttachments = paths.map((p) => ({
      path: p,
      name: p.split('/').pop() || p,
    }))
    setAttachments((prev) => {
      const existing = new Set(prev.map((a) => a.path))
      return [...prev, ...newAttachments.filter((a) => !existing.has(a.path))]
    })
    // Insert [path] references into the search input for all attached files
    const refs = newAttachments.map((a) => `[${a.path}]`).join(' ')
    setSearch((prev) => {
      const trimmed = prev.trimEnd()
      return trimmed ? `${trimmed} ${refs} ` : `${refs} `
    })
    // Resolve thumbnails for image files in the background
    for (const a of newAttachments) {
      if (isImageFile(a.name)) {
        window.cells.app
          .fileThumbnail(a.path)
          .then((url) => {
            if (url) {
              setAttachments((prev) =>
                prev.map((att) => (att.path === a.path ? { ...att, thumbnailUrl: url } : att)),
              )
            }
          })
          .catch(() => {})
      }
    }
  }, [])

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path))
    // Remove the [path] reference from the search input
    setSearch((prev) => prev.replace(`[${path}] `, '').replace(`[${path}]`, '').trimEnd())
  }, [])

  // Sort agents by per-project usage count: most used LAST (= closest to input = most relevant).
  // Falls back to lastUsedAgent for first-time usage within a project.
  const sortedAgents = [...availableAgents].sort((a, b) => {
    const countA = commandActionCounts[`agent-${a.id}`] ?? 0
    const countB = commandActionCounts[`agent-${b.id}`] ?? 0
    if (countA !== countB) return countA - countB // higher count → later (bottom)
    // Tie-break: lastUsedAgent goes last
    if (a.id === lastUsedAgent) return 1
    if (b.id === lastUsedAgent) return -1
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
      hapticNudge()
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

  // Track whether Cmd key is held
  useEffect(() => {
    if (!open) return
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Meta') setCmdHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Meta') setCmdHeld(false)
    }
    const blur = () => setCmdHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      setCmdHeld(false)
    }
  }, [open])

  const runAction = (fn: () => any) => {
    const close = () => {
      setOpen(false)
      setSearch('')
      setAttachments([])
      setOverlayOpen(false)
      hapticSuccess()
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

  // On every search change: scroll to bottom and force-select the last visible
  // item (closest to input = most relevant). We always re-select because cmdk's
  // internal selection can land on a non-bottom item after re-filtering.
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => {
      const list = document.querySelector('[cmdk-list]') as HTMLElement | null
      if (!list) return
      list.scrollTop = list.scrollHeight
      // Find last visible item (BOTTOM = most relevant, see top-of-file comment)
      const items = list.querySelectorAll('[cmdk-item]:not([aria-hidden="true"])')
      if (items.length > 0) {
        const last = items[items.length - 1] as HTMLElement
        const val = last.getAttribute('data-value')
        if (val) setCmdkValue(val)
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
    const handlePaste = (e: ClipboardEvent) => {
      // Detect files synchronously before any async work so we can
      // preventDefault() immediately and stop the filename from being
      // pasted as text into the input.
      const hasClipboardFiles =
        (e.clipboardData?.files && e.clipboardData.files.length > 0) ||
        Array.from(e.clipboardData?.items ?? []).some((i) => i.kind === 'file')

      if (hasClipboardFiles) {
        e.preventDefault()
        e.stopPropagation()
      }

      // Async resolution of file paths
      void (async () => {
        const filePaths = await window.cells.app.pasteClipboardFiles()
        if (filePaths && filePaths.length > 0) {
          addAttachments(filePaths)
          return
        }
        // Fallback: resolve from DataTransfer files
        if (e.clipboardData?.files && e.clipboardData.files.length > 0) {
          const paths: string[] = []
          for (const file of Array.from(e.clipboardData.files)) {
            try {
              const path = window.cells.app.getPathForFile(file)
              if (path) paths.push(path)
            } catch {
              const buf = new Uint8Array(await file.arrayBuffer())
              const saved = await window.cells.app.saveTempFile(buf, file.name)
              if (saved) paths.push(saved)
            }
          }
          if (paths.length > 0) {
            addAttachments(paths)
          }
        }
      })()
    }
    document.addEventListener('paste', handlePaste, true)
    return () => document.removeEventListener('paste', handlePaste, true)
  }, [open, addAttachments])

  const searchInBrowser = () => {
    if (!search.trim()) return
    useStore.getState().setLastCommandAction('search')
    useStore.getState().trackCommandAction('search')
    const cleanSearch = stripPrefix(search.trim())
    runAction(() => useStore.getState().addBrowserWithUrl(cleanSearch))
  }

  const runAsTerminalCommand = (command: string) => {
    if (!command.trim()) return
    useStore.getState().setLastCommandAction('run')
    useStore.getState().trackCommandAction('run')
    const cleanCommand = stripPrefix(command.trim())
    const label = cleanCommand.slice(0, 40)
    runAction(() => useStore.getState().addTerminalWithCommand(cleanCommand, label))
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
            runAction(() => {
              launchAgentAction(id, label, false, search, attachments)
            })
          }}
          onMetaSelect={() => {
            runAction(() => {
              launchAgentAction(id, label, true, search, attachments)
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
          {sortedAgents.length > 1 && id === sortedAgents[sortedAgents.length - 1].id && (
            <span className="ml-auto text-[10px] text-muted-foreground/40">
              {(commandActionCounts[`agent-${id}`] ?? 0) > 0 ? 'most used' : 'recent'}
            </span>
          )}
          {isGitRepo && cmdHeld && (
            <GitBranch className="absolute right-2 size-3.5 text-muted-foreground/50" />
          )}
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
          {/* Command list ordering (top → bottom, input is at the bottom):
              1. Theme, Shell History, Recent Files — filterable, hidden when no match
              2. Browsers, Terminals, Worktrees — filterable, navigational
              3. Projects — filterable, navigational
              4–5. Catch-all groups (Search, Agents, Run) and Actions — order swaps:

              Default (no attachments):
                4. Catch-all (forceMount)  5. Actions (filterable)
                → Matching actions appear closest to input and auto-select.
                  When none match, catch-all items are nearest instead.

              With attachments:
                4. Actions (filterable)    5. Catch-all (forceMount)
                → Catch-all items (agents, search, run) are preferred since
                  they're the natural targets when files are attached. */}
          <CommandList>
            <CommandEmpty className="hidden" />

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

            {shellHistory.length > 0 &&
              (() => {
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
                        onSelect={() => addAttachments([f.path])}
                        onMetaSelect={() => {
                          navigator.clipboard.writeText(f.path).catch(() => {})
                          showToast('Copied path to clipboard')
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

            {isGitRepo &&
              (() => {
                const nonBare = worktrees.filter((w) => !w.isBare)
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
                    <CommandGroup heading="Worktrees">
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
                    </CommandGroup>
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
                  </>
                )
              })()}

            {projects.length > 1 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Projects">
                  {projects.map((p) => (
                    <CommandItem
                      key={p.id}
                      onSelect={() => runAction(() => useStore.getState().switchProject(p.id))}
                      data-checked={p.id === activeProjectId ? 'true' : undefined}
                    >
                      <FolderOpen className="text-muted-foreground" />
                      {p.name}
                      <span className="text-[10px] text-muted-foreground/40 truncate max-w-40">
                        {p.path}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {/* Ordering between catch-all and Actions groups:
                - Default (no attachments): catch-all first, Actions last (closest to input).
                  Matching action items get auto-selected; when none match, catch-all items
                  (forceMount) are the nearest visible.
                - With attachments: Actions first, catch-all last (closest to input).
                  Agents/search/run are more useful when files are attached. */}
            {(attachments.length > 0 ? ['actions', 'catchall'] : ['catchall', 'actions']).map(
              (section) => {
                if (section === 'catchall') {
                  return (
                    <React.Fragment key="catchall">
                      {/* Sort by per-project usage: highest count LAST = closest to input */}
                      {[...(['search', 'agent', 'run'] as const)]
                        .sort((a, b) => {
                          const diff = groupCounts[a] - groupCounts[b]
                          if (diff !== 0) return diff // higher count → later (bottom)
                          // Tie-break: bottomAction (from lastCommandAction) goes last
                          return a === bottomAction ? 1 : b === bottomAction ? -1 : 0
                        })
                        .map((group) => {
                          if (group === 'search') {
                            if (!search.trim()) return null
                            return (
                              <React.Fragment key="search">
                                <CommandSeparator />
                                <CommandGroup heading="Search" forceMount>
                                  <CommandItem
                                    forceMount
                                    onSelect={searchInBrowser}
                                    value="search-web"
                                  >
                                    <Search className="text-muted-foreground" />
                                    <span className="truncate">
                                      Search for &ldquo;{search.trim().slice(0, 80)}&rdquo;
                                    </span>
                                  </CommandItem>
                                </CommandGroup>
                              </React.Fragment>
                            )
                          }
                          if (group === 'agent') {
                            if (sortedAgents.length === 0 || hasShellHistoryMatches) return null
                            return (
                              <React.Fragment key="agent">
                                <CommandSeparator />
                                {renderAgentsGroup()}
                              </React.Fragment>
                            )
                          }
                          if (group === 'run') {
                            if (!search.trim()) return null
                            return (
                              <React.Fragment key="run">
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
                              </React.Fragment>
                            )
                          }
                          return null
                        })}
                    </React.Fragment>
                  )
                }
                return (
                  <React.Fragment key="actions">
                    <CommandSeparator />
                    <CommandGroup heading="Actions">
                      <CommandItem
                        onSelect={() => {
                          void window.cells.app.requestQuit()
                        }}
                      >
                        <LogOut className="text-muted-foreground" />
                        Quit Cells
                        <CommandShortcut>⌘Q</CommandShortcut>
                      </CommandItem>
                      <CommandItem
                        onSelect={() => runAction(() => useStore.getState().removeAllTerminals())}
                      >
                        <Skull className="text-muted-foreground" />
                        Kill All Processes
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
                          setShowSettings(true)
                        }}
                      >
                        <Puzzle className="text-muted-foreground" />
                        Manage Extensions
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
                        onSelect={() => runAction(() => useStore.getState().autoArrangeGrid())}
                      >
                        <LayoutGrid className="text-muted-foreground" />
                        Arrange Windows
                      </CommandItem>
                      <CommandItem
                        onSelect={() =>
                          runAction(() =>
                            useStore.getState().setCanvasTransform({ x: 0, y: 0, scale: 1 }),
                          )
                        }
                      >
                        <RotateCcw className="text-muted-foreground" />
                        Reset View
                      </CommandItem>
                      <CommandItem
                        onSelect={() => runAction(() => useStore.getState().reloadFocused())}
                      >
                        <RefreshCw className="text-muted-foreground" />
                        Reload Window
                        <CommandShortcut>⌘R</CommandShortcut>
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
                      <CommandItem
                        onSelect={() => runAction(() => useStore.getState().addBrowser())}
                      >
                        <Globe className="text-muted-foreground" />
                        New Browser
                      </CommandItem>
                      <CommandItem
                        onSelect={() => runAction(() => useStore.getState().addTerminal())}
                      >
                        <Plus className="text-muted-foreground" />
                        New Terminal
                        <CommandShortcut>↵</CommandShortcut>
                      </CommandItem>
                    </CommandGroup>
                  </React.Fragment>
                )
              },
            )}
          </CommandList>
          {/* Always render the hint container when agents are available to avoid
              layout shift — cmdk briefly resets selection on every keystroke, so
              conditional rendering causes the hint to flash in and out. */}
          {isGitRepo && sortedAgents.length > 0 && (
            <div
              className="px-1.5 py-1 text-[11px] text-muted-foreground/40 transition-opacity duration-75"
              style={{ opacity: cmdkValue.startsWith('agent-') ? 1 : 0 }}
            >
              <Kbd className="text-[10px] h-4 min-w-4">⌘↵</Kbd> to launch in a worktree
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-1.5 py-1">
              {attachments.map((a) => {
                const isImg = isImageFile(a.name)
                if (isImg) {
                  return (
                    <div key={a.path} className="relative group">
                      {a.thumbnailUrl ? (
                        <img
                          src={a.thumbnailUrl}
                          alt={a.name}
                          className="h-12 max-w-24 rounded-md object-cover border border-border/30"
                        />
                      ) : (
                        <div className="h-12 w-12 rounded-md border border-border/30 bg-muted/40 flex items-center justify-center">
                          <Image className="size-4 text-muted-foreground/50" />
                        </div>
                      )}
                      <button
                        type="button"
                        className="absolute -top-1 -right-1 rounded-full bg-background/80 border border-border/40 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeAttachment(a.path)
                        }}
                      >
                        <X className="size-2.5" />
                      </button>
                    </div>
                  )
                }
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
              if (e.key === 'Backspace' && attachments.length > 0) {
                // If the input only contains [path] references (no user text), remove the last attachment
                const withoutRefs = attachments
                  .reduce(
                    (s, a) => s.replace(`[${a.path}] `, '').replace(`[${a.path}]`, ''),
                    search,
                  )
                  .trim()
                if (!withoutRefs) {
                  e.preventDefault()
                  const last = attachments[attachments.length - 1]
                  removeAttachment(last.path)
                  return
                }
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
