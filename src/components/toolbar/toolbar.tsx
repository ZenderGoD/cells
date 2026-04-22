import { useRef, useState, useEffect, useCallback, type KeyboardEvent } from 'react'
import { useHotkey } from '@tanstack/react-hotkeys'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Code,
  GitBranch,
  Globe,
  LayoutGrid,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Magnet,
  ArrowUpRight,
  ArrowDownLeft,
  Plus,
  Puzzle,
  RotateCw,
  Search,
  Settings,
  TerminalSquare,
  X,
} from 'lucide-react'
import type { ExtensionMeta } from '@/types'
import { motion, AnimatePresence, Reorder, useDragControls, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import {
  getCanvasBounds,
  getCanvasWindows,
  getClosestWindow,
  getViewportRect,
  getViewportCenter,
} from '@/lib/canvas-navigation'
import { Kbd, KbdGroup } from '../ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { AppSettings } from '../settings/app-settings'
import { NewProjectDialog } from '../new-project-dialog'
import { Logo } from '../logo'
import { WindowOverviewMap } from '../canvas/window-overview-map'
import { WorktreeSwitcher } from '../worktree-switcher'
import { AgentIcon } from '../agent-icon'
import { inferAgentFromTitle } from '@/lib/agent-command'
import { hapticNudge, hapticSuccess, hapticBuzz } from '@/lib/haptics'
import { getPrimaryModifierLabel, isMacPlatform } from '@/lib/keyboard-shortcuts'
import {
  getAgentWindowStatusPresentation,
  getProjectRuntimeAttention,
  getStatusPresentation,
  type ProjectAttention,
} from '@/lib/status-indicator'

const EASE_OUT = [0.25, 0.46, 0.45, 0.94] as const
const EASE_IN_OUT = [0.645, 0.045, 0.355, 1] as const

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

function shortenPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

function getAgentLocationLabel(
  cwd: string | null | undefined,
  worktrees: Array<{ path: string; branch: string; isBare?: boolean }>,
): string | null {
  if (!cwd) return null
  const normalizedCwd = cwd.replace(/\\/g, '/')
  const matchingWorktree = worktrees
    .filter((worktree) => !worktree.isBare)
    .filter(
      (worktree) =>
        normalizedCwd === worktree.path || normalizedCwd.startsWith(`${worktree.path}/`),
    )
    .sort((left, right) => right.path.length - left.path.length)[0]

  if (matchingWorktree) {
    const relativePath = normalizedCwd.slice(matchingWorktree.path.length).replace(/^\/+/, '')
    return relativePath ? `${matchingWorktree.branch} · ${relativePath}` : matchingWorktree.branch
  }

  const shortened = shortenPath(normalizedCwd)
  const segments = shortened.split('/').filter(Boolean)
  if (segments.length === 0) return shortened
  return segments.length === 1 ? segments[0] : segments.slice(-2).join('/')
}

function ProjectTab({
  project,
  isActive,
  projectWindowCount,
  switchProject,
  setProjectTitleBarHidden,
  requestCloseProject,
  allWindows,
  titleBarOverviewWidth,
  titleBarOverviewHeight,
  overviewAnchor,
  focusedWindow,
  viewportRect,
  snapToTerminal,
  snapToBrowser,
  snapToAgentWindow,
  moveTerminal,
  moveBrowser,
  moveAgentWindow,
  attention,
}: {
  project: { id: string; name: string; hiddenFromTitleBar?: boolean }
  isActive: boolean
  projectWindowCount: number
  switchProject: (id: string) => void
  setProjectTitleBarHidden: (id: string, hidden: boolean) => void
  requestCloseProject: (id: string) => Promise<void>
  allWindows: import('@/lib/canvas-navigation').CanvasWindow[]
  titleBarOverviewWidth: number
  titleBarOverviewHeight: number
  overviewAnchor: import('@/lib/canvas-navigation').CanvasWindow | null | undefined
  focusedWindow: import('@/lib/canvas-navigation').CanvasWindow | null | undefined
  viewportRect: import('@/lib/canvas-navigation').CanvasRect | undefined
  snapToTerminal: (id: string) => void
  snapToBrowser: (id: string) => void
  snapToAgentWindow: (id: string) => void
  moveTerminal: (id: string, x: number, y: number) => void
  moveBrowser: (id: string, x: number, y: number) => void
  moveAgentWindow: (id: string, x: number, y: number) => void
  attention: ProjectAttention
}) {
  const reduceMotion = useReducedMotion()
  const dragControls = useDragControls()
  const itemRef = useRef<HTMLDivElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && itemRef.current?.contains(target)) return
      setMenuOpen(false)
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [menuOpen])

  return (
    <Reorder.Item
      value={project}
      as="div"
      ref={itemRef}
      dragControls={dragControls}
      dragListener={false}
      className={cn('relative flex items-center border-r border-border/30 shrink-0')}
      whileDrag={{ opacity: 0.5, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
    >
      <button
        onClick={() => {
          hapticNudge()
          if (isActive) {
            setMenuOpen((open) => !open)
            return
          }
          setMenuOpen(false)
          switchProject(project.id)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          hapticNudge()
          setMenuOpen(true)
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          dragControls.start(event)
        }}
        className={cn(
          'flex h-full items-center gap-2 px-4 transition-colors cursor-grab active:cursor-grabbing',
          isActive
            ? 'text-foreground bg-white/40 dark:bg-black/35'
            : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-white/15 dark:hover:bg-muted/30',
        )}
        title={isActive ? `${project.name} actions` : project.name}
      >
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
        {!isActive && attention && (
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              attention === 'working' && 'bg-primary/90 animate-pulse',
              attention === 'waiting' && 'bg-sky-400',
              attention === 'approval' && 'bg-amber-400',
              attention === 'error' && 'bg-rose-400',
              attention === 'done' && 'bg-emerald-400',
            )}
          />
        )}
      </button>
      {menuOpen ? (
        <div className="absolute right-1 top-[calc(100%+4px)] z-20 min-w-36 rounded-lg border border-border/40 bg-popover/95 p-1 shadow-md backdrop-blur no-drag">
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setMenuOpen(false)
              hapticNudge()
              setProjectTitleBarHidden(project.id, !project.hiddenFromTitleBar)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px] text-popover-foreground transition-colors hover:bg-muted/60"
          >
            {project.hiddenFromTitleBar ? (
              <Eye className="h-3 w-3 text-muted-foreground" />
            ) : (
              <EyeOff className="h-3 w-3 text-muted-foreground" />
            )}
            <span>{project.hiddenFromTitleBar ? 'Show in title bar' : 'Hide from title bar'}</span>
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setMenuOpen(false)
              hapticBuzz()
              void requestCloseProject(project.id)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px] text-popover-foreground transition-colors hover:bg-muted/60"
          >
            <X className="h-3 w-3 text-muted-foreground" />
            <span>Close project</span>
          </button>
        </div>
      ) : null}
      <AnimatePresence>
        {isActive && allWindows.length > 0 && (
          <motion.div
            // Width animation triggers layout (skill's golden rule prefers
            // transform/opacity), but the overview reveals only on project
            // switch — a rare-enough trigger that the natural expand/collapse
            // outweighs the cost. Uses ease-in-out because the element is
            // morphing its own size on screen, not entering/exiting.
            initial={reduceMotion ? false : { opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: titleBarOverviewWidth }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, width: 0 }}
            transition={{ duration: 0.2, ease: EASE_IN_OUT }}
            className={cn(
              'flex items-center overflow-hidden',
              isActive ? 'bg-white/40 dark:bg-black/35' : '',
            )}
            title={
              overviewAnchor
                ? `${overviewAnchor.title} • drag to reposition, click to focus`
                : 'Drag to reposition, click to focus'
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
                if (window.type === 'agent') {
                  snapToAgentWindow(window.id)
                  return
                }
                snapToTerminal(window.id)
              }}
              onMove={(window, x, y) => {
                if (window.type === 'browser') {
                  moveBrowser(window.id, x, y)
                } else if (window.type === 'agent') {
                  moveAgentWindow(window.id, x, y)
                } else {
                  moveTerminal(window.id, x, y)
                }
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </Reorder.Item>
  )
}

export function StatusBar() {
  const reduceMotion = useReducedMotion()
  const titleBarPosition = useStore((s) => s.titleBarPosition)
  const addTerminal = useStore((s) => s.addTerminal)
  const addBrowser = useStore((s) => s.addBrowser)
  const requestCloseWindow = useStore((s) => s.requestCloseWindow)
  const requestCloseProject = useStore((s) => s.requestCloseProject)
  const setProjectTitleBarHidden = useStore((s) => s.setProjectTitleBarHidden)
  const windowCount = useStore((s) => s.terminals.length + s.browsers.length)
  const terminals = useStore((s) => s.terminals)
  const browsers = useStore((s) => s.browsers)
  const agentWindows = useStore((s) => s.agentWindows)
  const canvas = useStore((s) => s.canvas)
  const focusedTerminalId = useStore((s) => s.focusedTerminalId)
  const focusedAgentWindowId = useStore((s) => s.focusedAgentWindowId)
  const focusedBrowser = useStore((s) =>
    s.focusedBrowserId ? s.browsers.find((b) => b.id === s.focusedBrowserId) : undefined,
  )
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const worktrees = useStore((s) => s.worktrees)
  const switchProject = useStore((s) => s.switchProject)
  const reorderProjects = useStore((s) => s.reorderProjects)
  const snapEnabled = useStore((s) => s.snapEnabled)
  const snapPaused = useStore((s) => s.snapPaused)
  const toggleSnap = useStore((s) => s.toggleSnap)
  const selectionMode = useStore((s) => s.selectionMode)
  const selectionCount = useStore((s) => s.selectionCount)
  const setSelectionMode = useStore((s) => s.setSelectionMode)
  const togglePinFocused = useStore((s) => s.togglePinFocused)
  const focusedWindowPinned = useStore((s) => {
    if (s.focusedTerminalId)
      return s.terminals.find((t) => t.id === s.focusedTerminalId)?.pinned ?? false
    if (s.focusedBrowserId)
      return s.browsers.find((b) => b.id === s.focusedBrowserId)?.pinned ?? false
    return false
  })
  const hasFocusedWindow = useStore(
    (s) => !!(s.focusedTerminalId || s.focusedBrowserId || s.focusedAgentWindowId),
  )
  const syncAgentWindow = useStore((s) => s.syncAgentWindow)
  const [editingTitleForAgentId, setEditingTitleForAgentId] = useState<string | null>(null)
  const zoomToFitAll = useStore((s) => s.zoomToFitAll)
  const autoArrangeGrid = useStore((s) => s.autoArrangeGrid)
  const autoArrangeOnCreate = useStore((s) => s.autoArrangeOnCreate)
  const setAutoArrangeOnCreate = useStore((s) => s.setAutoArrangeOnCreate)
  const snapToTerminal = useStore((s) => s.snapToTerminal)
  const snapToBrowser = useStore((s) => s.snapToBrowser)
  const snapToAgentWindow = useStore((s) => s.snapToAgentWindow)
  const moveTerminal = useStore((s) => s.moveTerminal)
  const moveBrowser = useStore((s) => s.moveBrowser)
  const moveAgentWindow = useStore((s) => s.moveAgentWindow)
  const focusedBrowserId = useStore((s) => s.focusedBrowserId)
  const closeUndoTimeoutMs = useStore((s) => s.closeUndoTimeoutMs)
  const restoreLastClosedWindow = useStore((s) => s.restoreLastClosedWindow)
  const restoreLastClosedProject = useStore((s) => s.restoreLastClosedProject)
  const pendingClosedWindows = useStore((s) => s.pendingClosedWindows)
  const pendingClosedProjects = useStore((s) => s.pendingClosedProjects)
  const setOverlayOpen = useStore((s) => s.setOverlayOpen)
  const updateStatus = useStore((s) => s.updateStatus)
  const updateVersion = useStore((s) => s.updateVersion)
  const [showSettings, setShowSettingsRaw] = useState(false)
  const [showNewProject, setShowNewProjectRaw] = useState(false)
  const setShowSettings = (v: boolean) => {
    setShowSettingsRaw(v)
    setOverlayOpen(v)
    if (!v) requestAnimationFrame(() => window.dispatchEvent(new Event('terminal-refocus')))
  }
  const setShowNewProject = (v: boolean) => {
    setShowNewProjectRaw(v)
    setOverlayOpen(v)
    if (!v) requestAnimationFrame(() => window.dispatchEvent(new Event('terminal-refocus')))
  }
  const [plusOpen, setPlusOpen] = useState(false)
  const tabsRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const [urlInput, setUrlInput] = useState('')
  const [urlBarFocused, setUrlBarFocused] = useState(false)
  const [copiedBrowserId, setCopiedBrowserId] = useState<string | null>(null)
  const [editingTitleForTermId, setEditingTitleForTermId] = useState<string | null>(null)
  const [editTitleValue, setEditTitleValue] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)
  const terminalFindOpen = useStore((s) => s.terminalFindOpen)
  const terminalFindQuery = useStore((s) => s.terminalFindQuery)
  const terminalFindResultTermId = useStore((s) => s.terminalFindResultTermId)
  const terminalFindResultCount = useStore((s) => s.terminalFindResultCount)
  const terminalFindActiveIndex = useStore((s) => s.terminalFindActiveIndex)
  const terminalFindResultLimitHit = useStore((s) => s.terminalFindResultLimitHit)
  const setTerminalFindQuery = useStore((s) => s.setTerminalFindQuery)
  const closeTerminalFind = useStore((s) => s.closeTerminalFind)
  const setCustomTitle = useStore((s) => s.setCustomTitle)
  const isEditingTitle = editingTitleForTermId === focusedTerminalId && !!focusedTerminalId
  const findInputRef = useRef<HTMLInputElement>(null)
  const [browserUi, setBrowserUi] = useState(EMPTY_BROWSER_UI)
  const activeBrowserUi = browserUi.browserId === focusedBrowserId ? browserUi : EMPTY_BROWSER_UI
  const { canGoBack, canGoForward, isLoading, themeColor } = activeBrowserUi

  // Extension popup icons for the focused browser's project
  const [popupExtensions, setPopupExtensions] = useState<ExtensionMeta[]>([])
  const refreshExtensions = useCallback(async () => {
    if (!focusedBrowserId || !activeProjectId) {
      setPopupExtensions([])
      return
    }
    const state = await window.cells.extensions.list()
    const enabledIds = state.projectExtensions[activeProjectId] ?? []
    const withPopup = state.extensions.filter((ext) => enabledIds.includes(ext.id) && ext.hasPopup)
    setPopupExtensions(withPopup)
  }, [focusedBrowserId, activeProjectId])
  useEffect(() => {
    void Promise.resolve().then(refreshExtensions)
    // Also refresh when an extension is installed from CWS
    const unsub = window.cells.extensions.onInstalled(() => {
      void refreshExtensions()
    })
    return unsub
  }, [refreshExtensions])
  const copyResetRef = useRef<number | null>(null)
  const showCopied = !!focusedBrowser?.url && copiedBrowserId === focusedBrowser.id
  const allWindows = getCanvasWindows(terminals, browsers, agentWindows)
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
      : focusedBrowserId
        ? allWindows.find((window) => window.id === focusedBrowserId)
        : allWindows.find((window) => window.id === focusedAgentWindowId)) ?? null
  const overviewAnchor = focusedWindow ?? getClosestWindow(allWindows, viewportCenter) ?? null
  const latestClosedWindow =
    pendingClosedWindows.find((entry) => entry.projectId === activeProjectId) ?? null
  const latestClosedProject = pendingClosedProjects[0] ?? null
  const [undoNow, setUndoNow] = useState(() => Date.now())
  const visibleProjects = projects.filter(
    (project) => !project.hiddenFromTitleBar || project.id === activeProjectId,
  )
  const undoSecondsLeft = latestClosedWindow
    ? Math.max(0, Math.ceil((latestClosedWindow.expiresAt - undoNow) / 1000))
    : 0
  const projectUndoSecondsLeft = latestClosedProject
    ? Math.max(0, Math.ceil((latestClosedProject.expiresAt - undoNow) / 1000))
    : 0
  const macPlatform = isMacPlatform()
  const primaryModifierLabel = getPrimaryModifierLabel()
  const shiftModifierLabel = macPlatform ? '⇧' : 'Shift'
  const formatShortcutLabel = (...keys: string[]) => (macPlatform ? keys.join('') : keys.join('+'))
  const canvasShortcutHints = [
    { label: 'Move', keys: [primaryModifierLabel], suffix: 'drag' },
    { label: 'Pan', keys: [shiftModifierLabel], suffix: 'swipe' },
    { label: 'Zoom', keys: [primaryModifierLabel], suffix: 'scroll' },
  ] as const

  // --- Project tab drag-to-reorder ---
  const handleReorder = useCallback(
    (reordered: typeof visibleProjects) => {
      const reorderedVisibleIds = reordered.map((project) => project.id)
      let visibleIndex = 0
      const mergedIds = projects.map((project) => {
        if (project.hiddenFromTitleBar && project.id !== activeProjectId) {
          return project.id
        }
        const reorderedId = reorderedVisibleIds[visibleIndex]
        visibleIndex += 1
        return reorderedId ?? project.id
      })
      reorderProjects(mergedIds)
    },
    [activeProjectId, projects, reorderProjects, visibleProjects],
  )

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

  useEffect(() => {
    if (!latestClosedWindow && !latestClosedProject) return
    const interval = window.setInterval(() => setUndoNow(Date.now()), 250)
    return () => window.clearInterval(interval)
  }, [latestClosedProject, latestClosedWindow])

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

  const showTerminalFind = !!focusedTerminalId && terminalFindOpen
  const terminalFindWaitingForResults =
    !!focusedTerminalId &&
    terminalFindOpen &&
    !!terminalFindQuery.trim() &&
    terminalFindResultTermId !== focusedTerminalId
  const terminalFindResultLabel = !terminalFindQuery.trim()
    ? 'Type to search'
    : terminalFindWaitingForResults
      ? '…'
      : terminalFindResultCount > 0
        ? `${terminalFindActiveIndex}/${terminalFindResultCount}${terminalFindResultLimitHit ? '+' : ''}`
        : terminalFindResultLimitHit
          ? `0/${terminalFindResultCount}+`
          : '0 results'

  const focusTerminalFindInput = useCallback(() => {
    requestAnimationFrame(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    })
  }, [])

  useEffect(() => {
    const handleFocus = () => {
      if (!useStore.getState().focusedTerminalId) return
      useStore.getState().openTerminalFind()
      focusTerminalFindInput()
    }

    window.addEventListener('terminal-find-focus', handleFocus)
    return () => window.removeEventListener('terminal-find-focus', handleFocus)
  }, [focusTerminalFindInput])

  useEffect(() => {
    if (showTerminalFind) {
      focusTerminalFindInput()
    }
  }, [focusTerminalFindInput, showTerminalFind])

  const navigateTerminalFind = useCallback((direction: 1 | -1) => {
    window.dispatchEvent(
      new CustomEvent('terminal-find-navigate', {
        detail: { direction },
      }),
    )
  }, [])

  const dismissTerminalFind = useCallback(() => {
    closeTerminalFind()
    requestAnimationFrame(() => window.dispatchEvent(new Event('terminal-refocus')))
  }, [closeTerminalFind])

  return (
    <>
      <div
        className={cn(
          'relative z-10 h-10 shrink-0 flex items-stretch overflow-visible text-xs draggable-region transition-colors duration-300',
          titleBarPosition === 'top' ? 'border-b border-border/50' : 'border-t border-border/50',
        )}
        style={{
          backgroundColor: themeColor
            ? `color-mix(in oklch, ${themeColor} 15%, var(--background))`
            : undefined,
        }}
        onDoubleClick={() => window.cells.app.toggleMaximize()}
        onMouseDown={(e) => {
          // Prevent toolbar clicks from stealing focus from the terminal,
          // but allow the URL input to be focused normally.
          const target = e.target as HTMLElement
          if (!target.closest('[data-allow-focus]')) {
            e.preventDefault()
          }
        }}
      >
        {/* Logo — click to zoom out and see all windows */}
        <button
          className="flex items-center px-3 shrink-0 no-drag hover:bg-muted/30 transition-colors"
          onClick={() => {
            hapticNudge()
            zoomToFitAll()
          }}
          title={`Overview (${formatShortcutLabel(primaryModifierLabel, shiftModifierLabel, 'O')})`}
        >
          <Logo className="w-3.5 h-3.5 text-foreground/80" />
        </button>

        {/* Project tabs — left side */}
        <Reorder.Group
          as="div"
          axis="x"
          values={visibleProjects}
          onReorder={handleReorder}
          ref={tabsRef}
          className="flex items-stretch overflow-x-auto scrollbar-none no-drag shrink-0"
        >
          {visibleProjects.map((project) => {
            const isActive = project.id === activeProjectId
            const projectWindowCount = isActive
              ? windowCount
              : (project.terminals?.length ?? 0) + (project.browsers?.length ?? 0)

            const projectTerminals = isActive ? terminals : (project.terminals ?? [])
            const attention = getProjectRuntimeAttention(projectTerminals)

            return (
              <ProjectTab
                key={project.id}
                project={project}
                isActive={isActive}
                projectWindowCount={projectWindowCount}
                switchProject={switchProject}
                setProjectTitleBarHidden={setProjectTitleBarHidden}
                requestCloseProject={requestCloseProject}
                allWindows={allWindows}
                titleBarOverviewWidth={titleBarOverviewWidth}
                titleBarOverviewHeight={titleBarOverviewHeight}
                overviewAnchor={overviewAnchor}
                focusedWindow={focusedWindow}
                viewportRect={viewportRect}
                snapToTerminal={snapToTerminal}
                snapToBrowser={snapToBrowser}
                snapToAgentWindow={snapToAgentWindow}
                moveTerminal={moveTerminal}
                moveBrowser={moveBrowser}
                moveAgentWindow={moveAgentWindow}
                attention={attention}
              />
            )
          })}
          <button
            onClick={() => setShowNewProject(true)}
            className="flex items-center px-3 text-muted-foreground/30 hover:text-muted-foreground hover:bg-muted/30 transition-colors shrink-0"
          >
            <Plus className="w-3 h-3" />
          </button>
        </Reorder.Group>

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
              data-allow-focus
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

            {popupExtensions.map((ext) => (
              <button
                key={ext.id}
                className="p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
                onClick={(e) => {
                  if (!activeProjectId) return
                  const rect = (e.target as HTMLElement).closest('button')!.getBoundingClientRect()
                  window.cells.extensions.showPopup(ext.id, activeProjectId, {
                    x: Math.round(rect.left - 150),
                    y: Math.round(rect.bottom + 4),
                    width: 360,
                    height: 500,
                  })
                }}
                title={ext.name}
              >
                <Puzzle className="w-3 h-3" />
              </button>
            ))}
            <button
              className="p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
              onClick={() => window.cells.browser.toggleDevTools(focusedBrowser.id)}
              title="Toggle DevTools"
            >
              <Code className="w-3 h-3" />
            </button>
            <button
              className="p-1 rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors shrink-0"
              onClick={() => void requestCloseWindow({ id: focusedBrowser.id, type: 'browser' })}
              title="Close Browser"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ) : focusedTerminalId ? (
          (() => {
            const ft = terminals.find((t) => t.id === focusedTerminalId)
            const ftTitle = ft?.customTitle || ft?.title || 'Terminal'
            const ftAgent = ft?.agent ?? inferAgentFromTitle(ftTitle)
            const ftStatus = getStatusPresentation(ft?.runtimeStatus, {
              agent: ftAgent,
              agentStatus: ft?.agentStatus,
              processRunning: ft?.processRunning,
            })
            return (
              <div className="flex-1 flex items-center gap-2 px-3 min-w-0 no-drag">
                {ftAgent ? (
                  <AgentIcon agent={ftAgent} className="h-3 w-3 shrink-0" size={12} />
                ) : (
                  <Logo className="h-3 w-3 text-primary/60 shrink-0" />
                )}
                {isEditingTitle ? (
                  <input
                    ref={titleInputRef}
                    className="text-[11px] font-medium text-muted-foreground bg-transparent border-b border-muted-foreground/40 outline-none min-w-0 flex-1 max-w-48"
                    value={editTitleValue}
                    onChange={(e) => setEditTitleValue(e.target.value)}
                    onBlur={() => {
                      setEditingTitleForTermId(null)
                      const trimmed = editTitleValue.trim()
                      if (trimmed && trimmed !== (ft?.title ?? '')) {
                        setCustomTitle(focusedTerminalId, trimmed)
                      } else if (!trimmed) {
                        setCustomTitle(focusedTerminalId, null)
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        e.currentTarget.blur()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditingTitleForTermId(null)
                      }
                    }}
                  />
                ) : (
                  <span
                    className="text-[11px] font-medium truncate min-w-0 text-muted-foreground cursor-text"
                    onDoubleClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setEditTitleValue(ftTitle)
                      setEditingTitleForTermId(focusedTerminalId)
                      requestAnimationFrame(() => {
                        titleInputRef.current?.focus()
                        titleInputRef.current?.select()
                      })
                    }}
                    title="Double-click to rename"
                  >
                    {ftTitle}
                  </span>
                )}
                <WorktreeSwitcher termId={focusedTerminalId} />
                {ftStatus.detail ? (
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none',
                      ftStatus.pillClass,
                    )}
                    title={ftStatus.label}
                  >
                    <span className={cn('h-1.5 w-1.5 rounded-full', ftStatus.dotClass)} />
                    <span className="truncate max-w-44">{ftStatus.detail}</span>
                  </span>
                ) : null}
                {showTerminalFind ? (
                  <div className="flex min-w-0 flex-[0_1_360px] items-center gap-1.5 rounded-md border border-border/25 bg-background/45 px-1.5 py-1">
                    <Search className="h-3 w-3 shrink-0 text-muted-foreground/45" />
                    <input
                      ref={findInputRef}
                      value={terminalFindQuery}
                      onChange={(event) => setTerminalFindQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          navigateTerminalFind(event.shiftKey ? -1 : 1)
                          return
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          dismissTerminalFind()
                        }
                      }}
                      placeholder="Find in terminal"
                      className="h-6 min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground/35"
                    />
                    <span className="shrink-0 text-[10px] text-muted-foreground/45">
                      {terminalFindResultLabel}
                    </span>
                    <button
                      onClick={() => navigateTerminalFind(-1)}
                      className="rounded-md p-1 text-muted-foreground/40 transition-colors hover:bg-muted/40 hover:text-foreground"
                      title="Previous match"
                    >
                      <ChevronUp className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => navigateTerminalFind(1)}
                      className="rounded-md p-1 text-muted-foreground/40 transition-colors hover:bg-muted/40 hover:text-foreground"
                      title="Next match"
                    >
                      <ChevronDown className="h-3 w-3" />
                    </button>
                    <button
                      onClick={dismissTerminalFind}
                      className="rounded-md p-1 text-muted-foreground/40 transition-colors hover:bg-muted/40 hover:text-foreground"
                      title="Close search"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })()
        ) : focusedAgentWindowId ? (
          (() => {
            const aw = agentWindows.find((a) => a.id === focusedAgentWindowId)
            if (!aw) return <div className="flex-1" />
            const awTitle =
              aw.customTitle || aw.title || (aw.agent === 'claude' ? 'Claude Code' : 'Codex')
            const awStatus = aw.status || 'idle'
            const awLocation = getAgentLocationLabel(aw.cwd ?? null, worktrees)
            const isEditingAgentTitle = editingTitleForAgentId === focusedAgentWindowId
            const awStatusPill = getAgentWindowStatusPresentation(awStatus, {
              hasUnviewedCompletion: aw.hasUnviewedCompletion,
            })
            return (
              <div className="flex-1 flex items-center gap-2 px-3 min-w-0 no-drag">
                <span className="relative inline-flex shrink-0" title={awStatusPill.label}>
                  <AgentIcon agent={aw.agent} className="h-3 w-3 shrink-0" size={12} />
                  {awStatusPill.dotClass ? (
                    <span
                      className={cn(
                        'pointer-events-none absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full ring-[1.5px] ring-background',
                        awStatusPill.dotClass,
                      )}
                    />
                  ) : null}
                </span>
                {isEditingAgentTitle ? (
                  <input
                    ref={titleInputRef}
                    className="text-[11px] font-medium text-muted-foreground bg-transparent border-b border-muted-foreground/40 outline-none min-w-0 flex-1 max-w-48"
                    value={editTitleValue}
                    onChange={(e) => setEditTitleValue(e.target.value)}
                    onBlur={() => {
                      setEditingTitleForAgentId(null)
                      const trimmed = editTitleValue.trim()
                      syncAgentWindow(focusedAgentWindowId, {
                        customTitle: trimmed || null,
                      })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        e.currentTarget.blur()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditingTitleForAgentId(null)
                      }
                    }}
                  />
                ) : (
                  <span
                    className="text-[11px] font-medium truncate min-w-0 text-muted-foreground cursor-text"
                    onDoubleClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setEditTitleValue(awTitle)
                      setEditingTitleForAgentId(focusedAgentWindowId)
                      requestAnimationFrame(() => {
                        titleInputRef.current?.focus()
                        titleInputRef.current?.select()
                      })
                    }}
                    title="Double-click to rename"
                  >
                    {awTitle}
                  </span>
                )}
                {awLocation ? (
                  <span
                    className="inline-flex min-w-0 max-w-52 shrink items-center gap-1 text-[10px] leading-none text-muted-foreground/55"
                    title={shortenPath(aw.cwd ?? awLocation)}
                  >
                    <GitBranch className="h-2.5 w-2.5 shrink-0 opacity-60" />
                    <span className="truncate">{awLocation}</span>
                  </span>
                ) : null}
                <button
                  className="p-1 rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors shrink-0"
                  onClick={() =>
                    void requestCloseWindow({ id: focusedAgentWindowId, type: 'agent' })
                  }
                  title="Close Agent Window"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )
          })()
        ) : (
          <div className="flex-1" />
        )}

        {/* Draggable spacer - allows dragging from the title bar */}
        <div className="flex-1" />

        {/* Right side controls */}
        <div className="flex items-center gap-3 px-3 shrink-0 no-drag">
          <AnimatePresence initial={false}>
            {latestClosedProject && projectUndoSecondsLeft > 0 ? (
              <motion.button
                key="undo-close-project"
                layout
                initial={reduceMotion ? false : { opacity: 0, x: 12, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 12, scale: 0.96 }}
                transition={{ duration: 0.2, ease: EASE_OUT }}
                onClick={() => {
                  hapticSuccess()
                  restoreLastClosedProject()
                }}
                className="flex shrink-0 items-center gap-2 rounded-md border border-amber-500/15 bg-amber-500/6 px-2.5 py-1 text-[10px] text-muted-foreground/75 transition-colors hover:bg-amber-500/10 hover:text-foreground"
                title="Restore closed project"
              >
                <span className="font-medium text-foreground/85">Undo project close</span>
                <span className="max-w-24 truncate">{latestClosedProject.project.name}</span>
                <span className="text-[9px] text-muted-foreground/70">
                  {projectUndoSecondsLeft}s
                </span>
              </motion.button>
            ) : null}
            {latestClosedWindow && closeUndoTimeoutMs > 0 && undoSecondsLeft > 0 ? (
              <motion.button
                key="undo-close"
                layout
                initial={reduceMotion ? false : { opacity: 0, x: 12, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 12, scale: 0.96 }}
                transition={{ duration: 0.2, ease: EASE_OUT }}
                onClick={() => {
                  hapticSuccess()
                  restoreLastClosedWindow()
                }}
                className="flex shrink-0 items-center gap-2 rounded-md border border-border/30 bg-background/40 px-2.5 py-1 text-[10px] text-muted-foreground/65 transition-colors hover:bg-muted/45 hover:text-foreground"
                title="Restore closed window"
              >
                <span className="font-medium text-foreground/80">Undo close</span>
                <span className="max-w-24 truncate">{latestClosedWindow.title}</span>
                <KbdGroup className="gap-0.5">
                  <Kbd className="h-3.5 min-w-0 px-1 text-[9px]">{primaryModifierLabel}</Kbd>
                  <Kbd className="h-3.5 min-w-0 px-1 text-[9px]">{shiftModifierLabel}</Kbd>
                  <Kbd className="h-3.5 min-w-0 px-1 text-[9px]">T</Kbd>
                  <span className="ml-0.5 text-[9px] text-muted-foreground/70">
                    {undoSecondsLeft}s
                  </span>
                </KbdGroup>
              </motion.button>
            ) : null}
          </AnimatePresence>

          {/* Plus button with popover */}
          <Popover
            open={plusOpen}
            onOpenChange={(open) => {
              setPlusOpen(open)
              setOverlayOpen(open)
              if (!open)
                requestAnimationFrame(() => window.dispatchEvent(new Event('terminal-refocus')))
            }}
          >
            <PopoverTrigger className="text-muted-foreground/40 hover:text-foreground transition-colors">
              <Plus className="w-3.5 h-3.5" />
            </PopoverTrigger>
            <PopoverContent side="top" sideOffset={8} className="w-40 p-1">
              <button
                onClick={() => {
                  hapticSuccess()
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
                  hapticSuccess()
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

          {/* Auto-arrange grid */}
          {windowCount > 1 && (
            <Popover>
              <PopoverTrigger
                className={cn(
                  'transition-colors relative',
                  autoArrangeOnCreate
                    ? 'text-primary/70 hover:text-primary'
                    : 'text-muted-foreground/40 hover:text-foreground',
                )}
                title="Auto-arrange grid"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                {autoArrangeOnCreate && (
                  <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary" />
                )}
              </PopoverTrigger>
              <PopoverContent side="top" sideOffset={8} className="w-48 p-1">
                <button
                  onClick={() => {
                    hapticSuccess()
                    autoArrangeGrid()
                  }}
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-[11px] text-foreground hover:bg-muted/60 transition-colors"
                >
                  <LayoutGrid className="w-3.5 h-3.5 text-muted-foreground" />
                  Arrange now
                </button>
                <button
                  onClick={() => {
                    hapticBuzz()
                    setAutoArrangeOnCreate(!autoArrangeOnCreate)
                  }}
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-[11px] text-foreground hover:bg-muted/60 transition-colors"
                >
                  {autoArrangeOnCreate ? (
                    <Check className="w-3.5 h-3.5 text-primary" />
                  ) : (
                    <span className="w-3.5 h-3.5" />
                  )}
                  Auto on create
                </button>
              </PopoverContent>
            </Popover>
          )}

          {/* Pin toggle */}
          {hasFocusedWindow && (
            <button
              onClick={() => {
                hapticBuzz()
                togglePinFocused()
              }}
              className={cn(
                'p-1 rounded-md transition-colors',
                focusedWindowPinned
                  ? 'text-primary/70 hover:text-primary'
                  : 'text-muted-foreground/40 hover:text-foreground',
              )}
              title={
                focusedWindowPinned
                  ? `Pop back in (${formatShortcutLabel(primaryModifierLabel, shiftModifierLabel, 'P')})`
                  : `Pop out (${formatShortcutLabel(primaryModifierLabel, shiftModifierLabel, 'P')})`
              }
            >
              {focusedWindowPinned ? (
                <ArrowDownLeft className="w-3 h-3" />
              ) : (
                <ArrowUpRight className="w-3 h-3" />
              )}
            </button>
          )}

          {/* Snap toggle — selection mode keeps its pill (the count matters and
              the state is transient); normal snap states drop the pill chrome
              to match the other icon-only controls in this cluster. */}
          <button
            onClick={() => {
              hapticBuzz()
              if (selectionMode) {
                setSelectionMode(false)
                return
              }
              toggleSnap()
            }}
            className={cn(
              'flex items-center gap-1.5 rounded-md transition-colors',
              selectionMode ? 'bg-primary/15 px-2 py-1 text-primary' : 'px-1 py-1',
              !selectionMode &&
                (!snapEnabled
                  ? 'text-muted-foreground/35 hover:text-muted-foreground'
                  : snapPaused
                    ? 'text-amber-400/80 hover:text-amber-300'
                    : 'text-primary/80 hover:text-primary'),
            )}
            title={
              selectionMode
                ? 'Selection mode active. Click to exit.'
                : !snapEnabled
                  ? 'Snap off — windows move freely'
                  : snapPaused
                    ? 'Snap paused'
                    : 'Snap on'
            }
          >
            <Magnet className="w-3 h-3" />
            {selectionMode ? (
              <span className="text-[10px]">
                {`Select ${selectionCount > 0 ? `(${selectionCount})` : ''}`}
              </span>
            ) : !snapEnabled || snapPaused ? (
              <span className="text-[10px] lowercase text-muted-foreground/55">
                {snapPaused ? 'paused' : 'free'}
              </span>
            ) : null}
          </button>

          <div
            className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground/55"
            title={canvasShortcutHints
              .map((hint) => `${hint.label}: ${formatShortcutLabel(...hint.keys)} ${hint.suffix}`)
              .join(' • ')}
          >
            {canvasShortcutHints.map((hint, index) => (
              <div key={hint.label} className="flex items-center gap-1 whitespace-nowrap">
                {index > 0 && (
                  <span aria-hidden className="mr-1 size-0.5 rounded-full bg-muted-foreground/25" />
                )}
                <span className="text-muted-foreground/55">{hint.label}</span>
                <KbdGroup className="gap-0.5">
                  {hint.keys.map((key) => (
                    <Kbd
                      key={`${hint.label}-${key}`}
                      className="h-3.5 min-w-0 border-border/25 bg-background/30 px-1 text-[9px] text-muted-foreground/70"
                    >
                      {key}
                    </Kbd>
                  ))}
                </KbdGroup>
                <span className="lowercase text-muted-foreground/45">{hint.suffix}</span>
              </div>
            ))}
          </div>

          {/* Update indicator */}
          <AnimatePresence initial={false}>
            {updateStatus === 'available' && (
              <motion.button
                key="update-download"
                layout
                initial={reduceMotion ? false : { opacity: 0, x: 8, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 8, scale: 0.96 }}
                transition={{ duration: 0.2, ease: EASE_OUT }}
                onClick={() => {
                  hapticNudge()
                  window.cells.updater.download()
                }}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] text-primary transition-colors hover:bg-primary/20"
              >
                <Download className="w-2.5 h-2.5" />
                <span className="font-medium">v{updateVersion}</span>
              </motion.button>
            )}
            {updateStatus === 'downloading' && (
              <motion.span
                key="update-downloading"
                layout
                initial={reduceMotion ? false : { opacity: 0, x: 8, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 8, scale: 0.96 }}
                transition={{ duration: 0.2, ease: EASE_OUT }}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/30 bg-background/40 px-2 py-0.5 text-[10px] text-muted-foreground/65"
              >
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                Updating...
              </motion.span>
            )}
            {updateStatus === 'ready' && (
              <motion.button
                key="update-ready"
                layout
                initial={reduceMotion ? false : { opacity: 0, x: 8, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 8, scale: 0.96 }}
                transition={{ duration: 0.2, ease: EASE_OUT }}
                onClick={() => {
                  hapticSuccess()
                  window.cells.updater.install()
                }}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] text-primary transition-colors hover:bg-primary/20"
                title="Compatible daemon updates preserve sessions. Incompatible ones will warn before restart."
              >
                <RotateCw className="w-2.5 h-2.5" />
                <span className="font-medium">Restart to update</span>
              </motion.button>
            )}
          </AnimatePresence>

          <button
            onClick={() => setShowSettings(true)}
            className="text-muted-foreground/40 hover:text-foreground transition-colors relative"
          >
            <Settings className="w-3.5 h-3.5" />
            {(updateStatus === 'available' || updateStatus === 'ready') && (
              <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary" />
            )}
          </button>
        </div>
      </div>

      <AppSettings open={showSettings} onOpenChange={setShowSettings} />
      <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
    </>
  )
}
