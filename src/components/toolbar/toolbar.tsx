import { useRef, useState, useEffect, type KeyboardEvent } from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'
import {
  ArrowLeft,
  ArrowRight,
  Code,
  Globe,
  Loader2,
  Magnet,
  Plus,
  RotateCw,
  Settings,
  TerminalSquare,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { AppSettings } from '../settings/app-settings'
import { NewProjectDialog } from '../new-project-dialog'
import { Logo } from '../logo'

function shortenUrl(url?: string): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    let host = u.hostname
    // Strip www.
    if (host.startsWith('www.')) host = host.slice(4)
    return host
  } catch {
    return url
  }
}

export function StatusBar() {
  const addTerminal = useStore((s) => s.addTerminal)
  const addBrowser = useStore((s) => s.addBrowser)
  const removeBrowser = useStore((s) => s.removeBrowser)
  const terminalCount = useStore((s) => s.terminals.length)
  const browserCount = useStore((s) => s.browsers.length)
  const focusedBrowser = useStore((s) =>
    s.focusedBrowserId ? s.browsers.find((b) => b.id === s.focusedBrowserId) : undefined,
  )
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const switchProject = useStore((s) => s.switchProject)
  const snapEnabled = useStore((s) => s.snapEnabled)
  const snapPaused = useStore((s) => s.snapPaused)
  const toggleSnap = useStore((s) => s.toggleSnap)
  const zoomToFitAll = useStore((s) => s.zoomToFitAll)
  const focusedBrowserId = useStore((s) => s.focusedBrowserId)
  const setOverlayOpen = useStore((s) => s.setOverlayOpen)
  const [showSettings, setShowSettingsRaw] = useState(false)
  const [showNewProject, setShowNewProjectRaw] = useState(false)
  const setShowSettings = (v: boolean) => {
    setShowSettingsRaw(v)
    setOverlayOpen(v)
  }
  const setShowNewProject = (v: boolean) => {
    setShowNewProjectRaw(v)
    setOverlayOpen(v)
  }
  const [plusOpen, setPlusOpen] = useState(false)
  const tabsRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)

  // Cmd+L focuses the URL bar when a browser is focused
  useHotkey('Mod+L', () => {
    if (focusedBrowserId) {
      setUrlBarFocused(true)
    }
  })

  // Browser controls state
  const [urlInput, setUrlInput] = useState(focusedBrowser?.url ?? '')
  const [urlBarFocused, setUrlBarFocused] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [themeColor, setThemeColor] = useState<string | null>(null)

  // Sync URL input when focused browser changes
  useEffect(() => {
    setUrlInput(focusedBrowser?.url ?? '')
    setCanGoBack(false)
    setCanGoForward(false)
    setIsLoading(false)
    setThemeColor(null)
  }, [focusedBrowserId])

  // Sync URL when it changes externally
  useEffect(() => {
    if (focusedBrowser?.url) setUrlInput(focusedBrowser.url)
  }, [focusedBrowser?.url])

  // Listen for nav state, loading, and theme color for focused browser
  useEffect(() => {
    if (!focusedBrowserId) return
    const unsubNav = window.cells.browser.onNavState((id, back, forward) => {
      if (id === focusedBrowserId) {
        setCanGoBack(back)
        setCanGoForward(forward)
      }
    })
    const unsubLoading = window.cells.browser.onLoading((id, loading) => {
      if (id === focusedBrowserId) setIsLoading(loading)
    })
    const unsubTheme = window.cells.browser.onThemeColor((id, color) => {
      if (id === focusedBrowserId) setThemeColor(color)
    })
    return () => {
      unsubNav()
      unsubLoading()
      unsubTheme()
    }
  }, [focusedBrowserId])

  const handleNavigate = (url: string) => {
    if (!url.trim() || !focusedBrowserId) return
    const searchEngine = useStore.getState().searchEngine
    window.cells.browser.navigate(focusedBrowserId, url.trim(), searchEngine)
  }

  const handleUrlKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleNavigate(urlInput)
    }
  }

  return (
    <>
      <div
        className="h-10 shrink-0 flex items-stretch border-t border-border/50 text-xs draggable-region transition-colors duration-300"
        style={{
          backgroundColor: themeColor
            ? `color-mix(in oklch, ${themeColor} 15%, var(--background))`
            : undefined,
        }}
        onDoubleClick={() => window.cells.app.toggleMaximize()}
      >
        {/* Logo — click to zoom out and see all windows */}
        <button
          className="flex items-center px-3 shrink-0 no-drag hover:bg-muted/30 transition-colors"
          onClick={zoomToFitAll}
          title="Overview — see all windows"
        >
          <Logo className="w-3.5 h-3.5 text-foreground/80" />
        </button>

        {/* Project tabs — left side */}
        <div
          ref={tabsRef}
          className="flex items-stretch overflow-x-auto scrollbar-none no-drag shrink-0"
        >
          {projects.map((project) => {
            const isActive = project.id === activeProjectId
            const termCount = isActive ? terminalCount : (project.terminals?.length ?? 0)

            return (
              <button
                key={project.id}
                onClick={() => switchProject(project.id)}
                className={cn(
                  'relative flex items-center gap-2 px-4 transition-colors border-r border-border/30 shrink-0',
                  isActive
                    ? 'bg-muted/60 text-foreground'
                    : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/30',
                )}
              >
                {isActive && (
                  <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary/60" />
                )}
                <span className="text-[11px] font-medium truncate max-w-28">{project.name}</span>
                {termCount > 0 && (
                  <span
                    className={cn(
                      'text-[9px] tabular-nums',
                      isActive ? 'text-muted-foreground/60' : 'text-muted-foreground/30',
                    )}
                  >
                    {termCount}
                  </span>
                )}
              </button>
            )
          })}
          <button
            onClick={() => setShowNewProject(true)}
            className="flex items-center px-3 text-muted-foreground/30 hover:text-muted-foreground hover:bg-muted/30 transition-colors shrink-0"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>

        {/* Center — browser controls when a browser is focused */}
        {focusedBrowser ? (
          <div className="flex-1 flex items-center gap-1 px-2 min-w-0 no-drag">
            <button
              className={cn(
                'p-1 rounded transition-colors shrink-0',
                canGoBack
                  ? 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  : 'text-muted-foreground/20',
              )}
              disabled={!canGoBack}
              onClick={() => window.cells.browser.goBack(focusedBrowser.id)}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
            <button
              className={cn(
                'p-1 rounded transition-colors shrink-0',
                canGoForward
                  ? 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  : 'text-muted-foreground/20',
              )}
              disabled={!canGoForward}
              onClick={() => window.cells.browser.goForward(focusedBrowser.id)}
            >
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
            <button
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
              onClick={() => window.cells.browser.reload(focusedBrowser.id)}
            >
              {isLoading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RotateCw className="w-3 h-3" />
              )}
            </button>

            {/* URL bar */}
            <div
              className="flex-1 flex items-center gap-1.5 mx-1 px-2 py-1 rounded-md bg-background/60 border border-border/30 min-w-0 cursor-text"
              onClick={() => setUrlBarFocused(true)}
            >
              <Globe className="w-3 h-3 text-muted-foreground/50 shrink-0" />
              {urlBarFocused ? (
                <input
                  ref={urlInputRef}
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={handleUrlKeyDown}
                  onFocus={(e) => {
                    setUrlBarFocused(true)
                    e.target.select()
                  }}
                  onBlur={() => {
                    setUrlBarFocused(false)
                    setUrlInput(focusedBrowser?.url ?? '')
                  }}
                  placeholder="Enter URL or search..."
                  className="flex-1 bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground/40 outline-none min-w-0"
                  autoFocus
                />
              ) : (
                <span className="flex-1 text-[11px] text-muted-foreground truncate min-w-0">
                  {shortenUrl(focusedBrowser?.url) || 'Enter URL or search...'}
                </span>
              )}
              {isLoading && <Loader2 className="w-3 h-3 text-primary/60 animate-spin shrink-0" />}
            </div>

            <button
              className="p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
              onClick={() => window.cells.browser.toggleDevTools(focusedBrowser.id)}
              title="Toggle DevTools"
            >
              <Code className="w-3 h-3" />
            </button>
            <button
              className="p-1 rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors shrink-0"
              onClick={() => removeBrowser(focusedBrowser.id)}
              title="Close Browser"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {/* Right side controls */}
        <div className="flex items-center gap-3 px-3 shrink-0 no-drag">
          {/* Plus button with popover */}
          <Popover
            open={plusOpen}
            onOpenChange={(open) => {
              setPlusOpen(open)
              setOverlayOpen(open)
            }}
          >
            <PopoverTrigger className="text-muted-foreground/40 hover:text-foreground transition-colors">
              <Plus className="w-3.5 h-3.5" />
            </PopoverTrigger>
            <PopoverContent side="top" sideOffset={8} className="w-40 p-1">
              <button
                onClick={() => {
                  addTerminal()
                  setPlusOpen(false)
                }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-[11px] text-foreground hover:bg-muted/60 transition-colors"
              >
                <TerminalSquare className="w-3.5 h-3.5 text-muted-foreground" />
                Terminal
              </button>
              <button
                onClick={() => {
                  addBrowser()
                  setPlusOpen(false)
                }}
                className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-[11px] text-foreground hover:bg-muted/60 transition-colors"
              >
                <Globe className="w-3.5 h-3.5 text-muted-foreground" />
                Browser
              </button>
            </PopoverContent>
          </Popover>

          {/* Snap toggle */}
          <button
            onClick={toggleSnap}
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors',
              !snapEnabled
                ? 'text-muted-foreground/30 hover:text-muted-foreground hover:bg-muted/50'
                : snapPaused
                  ? 'bg-yellow-500/10 text-yellow-500/70'
                  : 'bg-primary/15 text-primary',
            )}
          >
            <Magnet className="w-3 h-3" />
            <span className="text-[10px]">
              {!snapEnabled ? 'Free' : snapPaused ? 'Paused' : 'Snap'}
            </span>
          </button>

          <span className="text-muted-foreground/30">⌘T</span>

          <button
            onClick={() => setShowSettings(true)}
            className="text-muted-foreground/40 hover:text-foreground transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <AppSettings open={showSettings} onOpenChange={setShowSettings} />
      <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
    </>
  )
}
