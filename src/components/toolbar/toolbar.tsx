import { useRef, useState, useEffect, type KeyboardEvent } from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'
import {
  ArrowLeft,
  ArrowRight,
  Check,
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
import {
  getCanvasBounds,
  getCanvasWindows,
  getClosestWindow,
  getViewportRect,
  getViewportCenter,
} from '@/lib/canvas-navigation'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { AppSettings } from '../settings/app-settings'
import { NewProjectDialog } from '../new-project-dialog'
import { Logo } from '../logo'
import { WindowOverviewMap } from '../canvas/window-overview-map'

const EMPTY_BROWSER_UI = {
  browserId: null as string | null,
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  themeColor: null as string | null,
}

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
  const windowCount = useStore((s) => s.terminals.length + s.browsers.length)
  const terminals = useStore((s) => s.terminals)
  const browsers = useStore((s) => s.browsers)
  const canvas = useStore((s) => s.canvas)
  const focusedTerminalId = useStore((s) => s.focusedTerminalId)
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
  const snapToTerminal = useStore((s) => s.snapToTerminal)
  const snapToBrowser = useStore((s) => s.snapToBrowser)
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
  const [urlInput, setUrlInput] = useState('')
  const [urlBarFocused, setUrlBarFocused] = useState(false)
  const [copiedBrowserId, setCopiedBrowserId] = useState<string | null>(null)
  const [browserUi, setBrowserUi] = useState(EMPTY_BROWSER_UI)
  const activeBrowserUi = browserUi.browserId === focusedBrowserId ? browserUi : EMPTY_BROWSER_UI
  const { canGoBack, canGoForward, isLoading, themeColor } = activeBrowserUi
  const copyResetRef = useRef<number | null>(null)
  const showCopied = !!focusedBrowser?.url && copiedBrowserId === focusedBrowser.id
  const allWindows = getCanvasWindows(terminals, browsers)
  const viewportRect = getViewportRect(canvas)
  const overviewBounds = getCanvasBounds([viewportRect, ...allWindows])
  const titleBarOverviewHeight = 38
  const titleBarOverviewWidth = overviewBounds
    ? Math.max(
        56,
        Math.min(112, Math.round((overviewBounds.width / Math.max(overviewBounds.height, 1)) * 38)),
      )
    : 72
  const viewportCenter = getViewportCenter(canvas)
  const focusedWindow =
    (focusedTerminalId
      ? allWindows.find((window) => window.id === focusedTerminalId)
      : allWindows.find((window) => window.id === focusedBrowserId)) ?? null
  const overviewAnchor = focusedWindow ?? getClosestWindow(allWindows, viewportCenter) ?? null

  const openUrlBar = () => {
    setUrlInput(focusedBrowser?.url ?? '')
    setUrlBarFocused(true)
  }

  // Cmd+L focuses the URL bar when a browser is focused
  useHotkey('Mod+L', () => {
    if (focusedBrowserId) {
      openUrlBar()
    }
  })

  useHotkey('Mod+Shift+C', () => {
    if (!focusedBrowser?.url) return
    navigator.clipboard
      .writeText(focusedBrowser.url)
      .then(() => {
        setCopiedBrowserId(focusedBrowser.id)
        if (copyResetRef.current) {
          window.clearTimeout(copyResetRef.current)
        }
        copyResetRef.current = window.setTimeout(() => {
          setCopiedBrowserId((current) => (current === focusedBrowser.id ? null : current))
          copyResetRef.current = null
        }, 3000)
      })
      .catch(() => {})
  })

  useEffect(() => {
    return () => {
      if (copyResetRef.current) {
        window.clearTimeout(copyResetRef.current)
      }
    }
  }, [])

  // Listen for nav state, loading, and theme color for focused browser
  useEffect(() => {
    if (!focusedBrowserId) return
    const unsubNav = window.cells.browser.onNavState((id, back, forward) => {
      if (id === focusedBrowserId) {
        setBrowserUi((prev) => ({
          browserId: id,
          canGoBack: back,
          canGoForward: forward,
          isLoading: prev.browserId === id ? prev.isLoading : false,
          themeColor: prev.browserId === id ? prev.themeColor : null,
        }))
      }
    })
    const unsubLoading = window.cells.browser.onLoading((id, loading) => {
      if (id === focusedBrowserId) {
        setBrowserUi((prev) => ({
          browserId: id,
          canGoBack: prev.browserId === id ? prev.canGoBack : false,
          canGoForward: prev.browserId === id ? prev.canGoForward : false,
          isLoading: loading,
          themeColor: prev.browserId === id ? prev.themeColor : null,
        }))
      }
    })
    const unsubTheme = window.cells.browser.onThemeColor((id, color) => {
      if (id === focusedBrowserId) {
        setBrowserUi((prev) => ({
          browserId: id,
          canGoBack: prev.browserId === id ? prev.canGoBack : false,
          canGoForward: prev.browserId === id ? prev.canGoForward : false,
          isLoading: prev.browserId === id ? prev.isLoading : false,
          themeColor: color,
        }))
      }
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
        className="relative h-10 shrink-0 flex items-stretch overflow-hidden border-t border-border/50 text-xs draggable-region transition-colors duration-300"
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
          title="Overview (Ctrl+Shift+O)"
        >
          <Logo className="w-3.5 h-3.5 text-foreground/80" />
        </button>

        {allWindows.length > 0 && (
          <div
            className="flex h-full items-center px-1.5 shrink-0 no-drag border-l border-r border-border/25"
            title={
              overviewAnchor
                ? `${overviewAnchor.title} • click a window to center it • Ctrl+H/J/K/L to move`
                : 'Click a window to center it • Ctrl+H/J/K/L to move around the canvas'
            }
          >
            <WindowOverviewMap
              windows={allWindows}
              currentId={overviewAnchor?.id}
              focusedId={focusedWindow?.id ?? null}
              viewport={viewportRect}
              width={titleBarOverviewWidth}
              height={titleBarOverviewHeight}
              className="border-0 bg-transparent rounded-none"
              onSelect={(window) => {
                if (window.type === 'browser') {
                  snapToBrowser(window.id)
                  return
                }
                snapToTerminal(window.id)
              }}
            />
          </div>
        )}

        {/* Project tabs — left side */}
        <div
          ref={tabsRef}
          className="flex items-stretch overflow-x-auto scrollbar-none no-drag shrink-0"
        >
          {projects.map((project) => {
            const isActive = project.id === activeProjectId
            const projectWindowCount = isActive
              ? windowCount
              : (project.terminals?.length ?? 0) + (project.browsers?.length ?? 0)

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
                {projectWindowCount > 0 && (
                  <span
                    className={cn(
                      'text-[9px] tabular-nums',
                      isActive ? 'text-muted-foreground/60' : 'text-muted-foreground/30',
                    )}
                  >
                    {projectWindowCount}
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
              onClick={openUrlBar}
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
                    openUrlBar()
                    e.target.select()
                  }}
                  onBlur={() => {
                    setUrlBarFocused(false)
                    setUrlInput('')
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
              {showCopied && (
                <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                  <Check className="w-2.5 h-2.5" />
                  Copied
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
