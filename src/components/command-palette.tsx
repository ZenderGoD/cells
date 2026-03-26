import { useState, useEffect } from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'
import {
  Globe,
  Plus,
  RotateCcw,
  Palette,
  Settings,
  FolderOpen,
  Search,
  LogOut,
} from 'lucide-react'
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
      window.cells.agent.checkAvailable().then(setAgents)
    }
  }, [open])

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

  return (
    <>
      <CommandDialog open={open} onOpenChange={handleOpenChange} showCloseButton={false}>
        <Command loop>
          <CommandInput
            placeholder="Search or enter URL..."
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
                  setShowNewProject(true)
                }}
              >
                <FolderOpen className="text-muted-foreground" />
                New Project
              </CommandItem>
              <CommandItem onSelect={() => window.close()}>
                <LogOut className="text-muted-foreground" />
                Quit Cells
                <CommandShortcut>⌘Q</CommandShortcut>
              </CommandItem>
            </CommandGroup>

            {terminals.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Terminals">
                  {terminals.map((t) => (
                    <CommandItem
                      key={t.id}
                      onSelect={() => runAction(() => useStore.getState().snapToTerminal(t.id))}
                    >
                      {t.agent ?? inferAgentFromTitle(t.title) ? (
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

            {search.trim() && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Search" forceMount>
                  <CommandItem forceMount onSelect={searchInBrowser} value={`search-${search}`}>
                    <Search className="text-muted-foreground" />
                    Search for &ldquo;{search.trim()}&rdquo;
                  </CommandItem>
                </CommandGroup>
              </>
            )}

            {search.trim() && (agents.claude || agents.codex) && (
              <>
                <CommandSeparator />
                <CommandGroup heading="AI Agents" forceMount>
                  {agents.claude && (
                    <CommandItem
                      forceMount
                      value={`ask-claude-${search}`}
                      onSelect={() =>
                        runAction(() => {
                          const escaped = search.trim().replace(/'/g, "'\\''")
                          useStore
                            .getState()
                            .addTerminalWithCommand(
                              `claude '${escaped}'`,
                              `Claude: ${search.trim().slice(0, 40)}`,
                            )
                        })
                      }
                    >
                      <AgentIcon agent="claude" className="text-muted-foreground" size={16} />
                      Ask Claude Code: &ldquo;{search.trim().slice(0, 50)}&rdquo;
                    </CommandItem>
                  )}
                  {agents.codex && (
                    <CommandItem
                      forceMount
                      value={`ask-codex-${search}`}
                      onSelect={() =>
                        runAction(() => {
                          const escaped = search.trim().replace(/'/g, "'\\''")
                          useStore
                            .getState()
                            .addTerminalWithCommand(
                              `codex '${escaped}'`,
                              `Codex: ${search.trim().slice(0, 40)}`,
                            )
                        })
                      }
                    >
                      <AgentIcon agent="codex" className="text-muted-foreground" size={16} />
                      Ask Codex: &ldquo;{search.trim().slice(0, 50)}&rdquo;
                    </CommandItem>
                  )}
                </CommandGroup>
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
