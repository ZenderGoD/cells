import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type {
  BrowserNode,
  CanvasTransform,
  GitWorktree,
  Project,
  ProjectsState,
  TerminalNode,
  TerminalProcessInfo,
} from '../types'
import { inferAgentFromCommand } from './agent-command'
import { DEFAULT_THEME, DEFAULT_LIGHT_THEME } from './terminal-themes'
import { DEFAULT_WINDOW_APPEARANCE, normalizeWindowAppearance } from './window-appearance'
import {
  STATUS_BAR_HEIGHT,
  getCanvasWindows,
  getClosestWindow,
  getDirectionalWindow,
  getOverviewTransform,
  getWindowCenter,
  getViewportCenter,
} from './canvas-navigation'
import {
  destroyCachedTerminal,
  applyThemeToAllTerminals,
  reloadTerminal,
} from '@/components/terminal/cell-terminal'

interface StoreState {
  // Project management
  projects: Project[]
  activeProjectId: string | null

  // Active project working state
  terminals: TerminalNode[]
  browsers: BrowserNode[]
  canvas: CanvasTransform
  initialized: boolean
  terminalTheme: string
  fontSize: number
  fontFamily: string
  windowOpacity: number
  focusedTerminalId: string | null
  focusedBrowserId: string | null
  focusHistory: string[] // stack of recently focused IDs (most recent last)
  focusCounts: Record<string, number> // per-window focus counts for usage ranking
  topZIndex: number
  snapEnabled: boolean
  snapPaused: boolean
  snapFast: boolean // hint for canvas to use fast spring
  snapOnFocus: boolean
  selectionMode: boolean
  selectionCount: number
  selectedNodeIds: string[]
  tabSwitchMode: 'recent' | 'chronological'
  projectSwitchMode: 'recent' | 'chronological'
  reducedMotion: boolean
  autoUpdate: boolean
  overlayOpen: boolean // true when popover/dialog is open — hides browser native views
  searchEngine: string
  homePage: string
  terminalLinkTarget: 'system' | 'browser'
  terminalLinkProjectId: string | null
  linkRules: Array<{ pattern: string; target: 'system' | 'browser'; projectId?: string }>
  agentAliases: Record<string, string>
  lastUsedAgent: string | null
  colorScheme: 'light' | 'dark' | 'system'
  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
  closeUndoTimeoutMs: number
  closeProcessSuppressions: string[]
  pendingClosedWindows: PendingClosedWindow[]
  pendingCloseDialog: PendingCloseDialog | null

  // When a link opens a browser in a different project, tracks the source so we can return
  crossProjectReturn: { browserId: string; sourceProjectId: string } | null

  // Git worktree state
  worktrees: GitWorktree[]
  worktreesLoading: boolean
  isGitRepo: boolean

  init(): Promise<void>
  persist(): void

  // Project actions
  createProject(name: string, path: string): void
  switchProject(id: string): void
  removeProject(id: string): void
  renameProject(id: string, name: string): void
  reorderProjects(ids: string[]): void
  getActiveProject(): Project | undefined
  getActiveProjectPath(): string | undefined

  setTerminalTheme(name: string): void
  setFontSize(size: number): void
  setFontFamily(family: string): void
  setWindowOpacity(opacity: number): void

  addTerminal(): TerminalNode
  addTerminalWithCommand(command: string, title?: string): TerminalNode
  addTerminalInWorktree(
    command: string,
    title: string | undefined,
    worktreePath: string,
  ): TerminalNode
  updateTerminalAgent(id: string, agent: 'claude' | 'codex' | null): void
  updateTerminalAgentStatus(id: string, status: import('../types').AgentStatus): void
  removeAllTerminals(): void
  removeTerminal(id: string): void
  moveTerminal(id: string, x: number, y: number): void
  resizeTerminal(id: string, width: number, height: number): void
  updateTerminalTitle(id: string, title: string): void
  focusTerminal(id: string | null): void
  bringToFront(id: string): void
  togglePin(id: string, type?: 'terminal' | 'browser'): void
  togglePinFocused(): void
  panToTerminal(id: string): void
  panToBrowser(id: string): void
  snapToTerminal(id: string): void
  zoomToFit(id: string): void
  snapToNearest(direction: 'left' | 'right' | 'up' | 'down'): void
  snapToClosest(): void
  toggleSnap(): void
  setSnapPaused(paused: boolean): void
  setSnapOnFocus(enabled: boolean): void
  setSelectionMode(enabled: boolean): void
  setSelectionCount(count: number): void
  setSelectedNodeIds(ids: string[]): void
  setTabSwitchMode(mode: 'recent' | 'chronological'): void
  setProjectSwitchMode(mode: 'recent' | 'chronological'): void
  setReducedMotion(enabled: boolean): void
  setAutoUpdate(enabled: boolean): void

  setCanvasTransform(transform: CanvasTransform): void
  resizeWindowToFitFocused(): void
  resizeFocusedToFitViewport(): void
  zoomToFitAll(): void
  setOverlayOpen(open: boolean): void
  setSearchEngine(engine: string): void
  setHomePage(url: string): void
  setTerminalLinkTarget(target: 'system' | 'browser'): void
  setTerminalLinkProjectId(projectId: string | null): void
  setLinkRules(
    rules: Array<{ pattern: string; target: 'system' | 'browser'; projectId?: string }>,
  ): void
  setAgentAliases(aliases: Record<string, string>): void
  setLastUsedAgent(agent: string): void
  setColorScheme(scheme: 'light' | 'dark' | 'system'): void
  setCloseUndoTimeoutMs(timeoutMs: number): void
  setCloseProcessSuppressions(processes: string[]): void
  requestCloseWindow(target?: CloseWindowTarget): Promise<void>
  cancelPendingClose(): void
  confirmPendingClose(skipFuturePrompts?: boolean): void
  restoreLastClosedWindow(): void
  autoArrangeGrid(): void
  reloadFocused(): void
  getAgentCommand(agent: string): string
  getSearchUrl(query: string): string

  // Worktree actions
  refreshWorktrees(): Promise<void>
  switchTerminalWorktree(termId: string, worktreePath: string): Promise<void>
  moveTerminalsToWorktree(termIds: string[], worktreePath: string): Promise<void>
  createWorktree(branch: string): Promise<GitWorktree>
  setWorktreesDir(dir: string): void
  getWorktreesDir(): string | undefined
  setWorktreeBaseBranch(branch: string): void
  getWorktreeBaseBranch(): string | undefined

  // Browser actions
  addBrowser(): BrowserNode
  addBrowserWithUrl(url: string, projectId?: string | null): BrowserNode
  removeBrowser(id: string): void
  snapToBrowser(id: string): void
  moveBrowser(id: string, x: number, y: number): void
  resizeBrowser(id: string, width: number, height: number): void
  updateBrowserUrl(id: string, url: string): void
  updateBrowserTitle(id: string, title: string): void
  updateBrowserFavicon(id: string, faviconUrl: string): void
  focusBrowser(id: string): void
  bringBrowserToFront(id: string): void
}

const TERMINAL_PAD = 8

// Pending commands to run after terminal attaches (not persisted)
const pendingCommands = new Map<string, string>()
// Pending worktree cwd overrides for terminal reattach
const pendingWorktreePaths = new Map<string, string>()
const TERMINAL_GAP = 60
const DEFAULT_CANVAS: CanvasTransform = { x: 0, y: 0, scale: 1 }
const DEFAULT_FONT_FAMILY = '"GeistMono NF", "Geist Mono", monospace'
const DEFAULT_SEARCH_ENGINE = 'https://www.google.com/search?q=%s'
const DEFAULT_HOME_PAGE = ''
const DEFAULT_CLOSE_UNDO_TIMEOUT_MS = 15000
const SAVE_STATUS_RESET_MS = 1800

/** Apply color scheme to the document and sync with system preferences. */
let systemThemeCleanup: (() => void) | null = null
function applyColorScheme(scheme: 'light' | 'dark' | 'system') {
  // Clean up previous system listener
  if (systemThemeCleanup) {
    systemThemeCleanup()
    systemThemeCleanup = null
  }

  const apply = () => {
    const prefersDark =
      scheme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : scheme === 'dark'
    document.documentElement.classList.toggle('dark', prefersDark)
    document.documentElement.classList.toggle('light', !prefersDark)
    document.documentElement.style.colorScheme = prefersDark ? 'dark' : 'light'
  }

  apply()

  // Listen for system theme changes when in 'system' mode
  if (scheme === 'system') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => apply()
    mq.addEventListener('change', handler)
    systemThemeCleanup = () => mq.removeEventListener('change', handler)
  }
}

type CloseWindowTarget = { id: string; type: 'terminal' | 'browser' }

interface PendingCloseDialog {
  target: CloseWindowTarget
  process: TerminalProcessInfo
  title: string
}

interface PendingClosedWindow {
  id: string
  target: CloseWindowTarget
  projectId: string
  terminal?: TerminalNode
  browser?: BrowserNode
  title: string
  closedAt: number
  expiresAt: number
  processLabel?: string | null
  processKey?: string | null
}

const pendingCloseTimers = new Map<string, number>()

function clearPendingCloseTimer(id: string) {
  const timer = pendingCloseTimers.get(id)
  if (timer) {
    window.clearTimeout(timer)
    pendingCloseTimers.delete(id)
  }
}

function destroyTerminalResources(id: string) {
  destroyCachedTerminal(id)
  window.cells.terminal.detach(id).catch(() => {})
}

function destroyBrowserResources(id: string) {
  window.cells.browser.destroy(id).catch(() => {})
}

function sanitizeProjectLinkSettings(
  projects: Project[],
  terminalLinkProjectId?: string | null,
  linkRules: Array<{ pattern: string; target: 'system' | 'browser'; projectId?: string }> = [],
) {
  const validProjectIds = new Set(projects.map((project) => project.id))
  return {
    terminalLinkProjectId:
      terminalLinkProjectId && validProjectIds.has(terminalLinkProjectId)
        ? terminalLinkProjectId
        : null,
    linkRules: linkRules.map((rule) => ({
      ...rule,
      projectId:
        rule.target === 'browser' && rule.projectId && validProjectIds.has(rule.projectId)
          ? rule.projectId
          : undefined,
    })),
  }
}

function normalizeTerminals(terminals: TerminalNode[]) {
  return terminals.map((terminal, index) => ({
    ...terminal,
    zIndex: typeof terminal.zIndex === 'number' ? terminal.zIndex : index + 1,
  }))
}

function pushFocusHistory(history: string[], id: string) {
  const next = history.filter((entry) => entry !== id)
  next.push(id)
  if (next.length > 20) next.shift()
  return next
}

function getPreviousWindowId(
  history: string[],
  terminals: TerminalNode[],
  browsers: BrowserNode[],
): string | null {
  const existingIds = new Set([
    ...terminals.map((terminal) => terminal.id),
    ...browsers.map((browser) => browser.id),
  ])
  const previousFromHistory = [...history].reverse().find((id) => existingIds.has(id))
  if (previousFromHistory) return previousFromHistory

  const topWindow = [...terminals, ...browsers].reduce<(TerminalNode | BrowserNode) | null>(
    (currentTop, candidate) => {
      if (!currentTop) return candidate
      return (candidate.zIndex ?? 0) > (currentTop.zIndex ?? 0) ? candidate : currentTop
    },
    null,
  )

  return topWindow?.id ?? null
}

function getTopZIndex(terminals: TerminalNode[], browsers: BrowserNode[] = []) {
  const termMax = terminals.reduce((max, t) => Math.max(max, t.zIndex ?? 0), 1)
  const browMax = browsers.reduce((max, b) => Math.max(max, b.zIndex ?? 0), 0)
  return Math.max(termMax, browMax)
}

function upsertPendingClosedWindow(
  pending: PendingClosedWindow[],
  entry: PendingClosedWindow,
): PendingClosedWindow[] {
  return [...pending.filter((candidate) => candidate.id !== entry.id), entry].sort(
    (a, b) => b.closedAt - a.closedAt,
  )
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistStatusTimer: ReturnType<typeof setTimeout> | null = null
let persistRequestId = 0

function debouncedPersist(fn: () => void, delay = 500) {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(fn, delay)
}

function clearPersistStatusTimer() {
  if (persistStatusTimer) {
    clearTimeout(persistStatusTimer)
    persistStatusTimer = null
  }
}

/** Snapshot the current working state back into the projects array */
function snapshotActiveProject(state: StoreState): Project[] {
  if (!state.activeProjectId) return state.projects
  return state.projects.map((p) =>
    p.id === state.activeProjectId
      ? {
          ...p,
          terminals: state.terminals,
          browsers: state.browsers,
          canvas: state.canvas,
          focusedTerminalId: state.focusedTerminalId,
          focusedBrowserId: state.focusedBrowserId,
          focusCounts: state.focusCounts,
        }
      : p,
  )
}

/** Load a project's state into the working fields */
function projectToWorkingState(project: Project) {
  const terminals = normalizeTerminals(project.terminals ?? [])
  const browsers = project.browsers ?? []
  return {
    terminals,
    browsers,
    canvas: project.canvas ?? DEFAULT_CANVAS,
    topZIndex: getTopZIndex(terminals, browsers),
    focusedTerminalId: (project.focusedTerminalId ?? null) as string | null,
    focusedBrowserId: (project.focusedBrowserId ?? null) as string | null,
    focusHistory: [] as string[],
    focusCounts: (project.focusCounts ?? {}) as Record<string, number>,
  }
}

export function consumePendingCommand(termId: string): string | undefined {
  const cmd = pendingCommands.get(termId)
  pendingCommands.delete(termId)
  return cmd
}

export function consumePendingWorktreePath(termId: string): string | undefined {
  const p = pendingWorktreePaths.get(termId)
  pendingWorktreePaths.delete(termId)
  return p
}

export const useStore = create<StoreState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  terminals: [],
  browsers: [],
  canvas: DEFAULT_CANVAS,
  initialized: false,
  focusedTerminalId: null,
  focusedBrowserId: null,
  focusHistory: [],
  focusCounts: {},
  topZIndex: 1,
  snapEnabled: true,
  snapPaused: false,
  snapFast: false,
  snapOnFocus: true,
  selectionMode: false,
  selectionCount: 0,
  selectedNodeIds: [],
  tabSwitchMode: 'chronological',
  projectSwitchMode: 'recent',
  reducedMotion: false,
  autoUpdate: true,
  overlayOpen: false,
  searchEngine: DEFAULT_SEARCH_ENGINE,
  homePage: DEFAULT_HOME_PAGE,
  terminalLinkTarget: 'system',
  terminalLinkProjectId: null,
  linkRules: [],
  agentAliases: {},
  lastUsedAgent: null,
  colorScheme: 'dark' as const,
  saveStatus: 'idle',
  closeUndoTimeoutMs: DEFAULT_CLOSE_UNDO_TIMEOUT_MS,
  closeProcessSuppressions: [],
  pendingClosedWindows: [],
  pendingCloseDialog: null,
  crossProjectReturn: null,
  worktrees: [],
  worktreesLoading: false,
  isGitRepo: false,
  terminalTheme: DEFAULT_THEME,
  fontSize: 13,
  fontFamily: DEFAULT_FONT_FAMILY,
  windowOpacity: DEFAULT_WINDOW_APPEARANCE.windowOpacity,

  setTerminalTheme(name) {
    set({ terminalTheme: name })
    applyThemeToAllTerminals(name)
    get().persist()
  },
  setFontSize(size) {
    set({ fontSize: size })
    get().persist()
  },
  setFontFamily(family) {
    set({ fontFamily: family })
    get().persist()
  },
  setWindowOpacity(opacity) {
    set({
      windowOpacity: normalizeWindowAppearance({ windowOpacity: opacity }).windowOpacity,
    })
    get().persist()
  },

  async init() {
    // Listen for pinned windows being closed/unpinned — must register before
    // any early return so it works regardless of which state-loading branch runs.
    if (!window.cells.app.getPinnedId()) {
      window.cells.app.onWindowUnpinned((id, type) => {
        if (type === 'terminal') {
          set((s) => ({
            terminals: s.terminals.map((t) => (t.id === id ? { ...t, pinned: false } : t)),
          }))
        } else {
          set((s) => ({
            browsers: s.browsers.map((b) => (b.id === id ? { ...b, pinned: false } : b)),
          }))
        }
        get().persist()
      })
    }

    const saved = await window.cells.state.load()

    if (saved && (saved as any).version === 2) {
      const ps = saved as ProjectsState
      const projects = ps.projects ?? []
      const projectLinkSettings = sanitizeProjectLinkSettings(
        projects,
        ps.terminalLinkProjectId,
        ps.linkRules ?? [],
      )

      const globalSettings = {
        terminalTheme: ps.terminalTheme || DEFAULT_THEME,
        fontSize: ps.fontSize || 13,
        fontFamily: ps.fontFamily || DEFAULT_FONT_FAMILY,
        ...normalizeWindowAppearance({
          windowOpacity: ps.windowOpacity,
        }),
        snapOnFocus: ps.snapOnFocus ?? true,
        tabSwitchMode: ps.tabSwitchMode || 'chronological',
        projectSwitchMode: ps.projectSwitchMode || 'recent',
        reducedMotion: ps.reducedMotion ?? false,
        autoUpdate: ps.autoUpdate ?? true,
        searchEngine: ps.searchEngine || DEFAULT_SEARCH_ENGINE,
        homePage: ps.homePage || DEFAULT_HOME_PAGE,
        terminalLinkTarget: ps.terminalLinkTarget || 'system',
        terminalLinkProjectId: projectLinkSettings.terminalLinkProjectId,
        linkRules: projectLinkSettings.linkRules,
        agentAliases: ps.agentAliases ?? {},
        colorScheme: ps.colorScheme || 'dark',
        closeUndoTimeoutMs: Math.max(0, ps.closeUndoTimeoutMs ?? DEFAULT_CLOSE_UNDO_TIMEOUT_MS),
        closeProcessSuppressions: ps.closeProcessSuppressions ?? [],
      }

      if (projects.length === 0) {
        set({ projects: [], activeProjectId: null, ...globalSettings, initialized: true })
        applyColorScheme(globalSettings.colorScheme)
        return
      }

      // Load MRU project
      const sorted = [...projects].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
      const active = ps.activeProjectId
        ? (projects.find((p) => p.id === ps.activeProjectId) ?? sorted[0])
        : sorted[0]

      set({
        projects,
        activeProjectId: active.id,
        ...projectToWorkingState(active),
        ...globalSettings,
        initialized: true,
      })
      applyColorScheme(globalSettings.colorScheme)
      get().refreshWorktrees()
      return
    }

    if (saved) {
      // Migrate old flat AppState or workspace-based state
      let terminals: TerminalNode[] = (saved as any).terminals ?? []
      let canvas: CanvasTransform = (saved as any).canvas ?? DEFAULT_CANVAS

      if (!(saved as any).terminals && (saved as any).workspaces) {
        const ws = Object.values((saved as any).workspaces)[0] as any
        if (ws) {
          terminals = (ws.terminals ?? []).map((t: any) => ({
            id: t.id,
            x: t.x,
            y: t.y,
            width: t.width,
            height: t.height,
            title: t.title,
            zIndex: t.zIndex,
            pinned: t.pinned,
          }))
          canvas = ws.canvas ?? canvas
        }
      }

      const project: Project = {
        id: nanoid(8),
        name: 'Default',
        path: '',
        terminals: normalizeTerminals(terminals),
        browsers: [],
        canvas,
        lastOpenedAt: Date.now(),
      }

      set({
        projects: [project],
        activeProjectId: project.id,
        ...projectToWorkingState(project),
        terminalTheme: (saved as any).terminalTheme || DEFAULT_THEME,
        fontSize: (saved as any).fontSize || 13,
        fontFamily: (saved as any).fontFamily || DEFAULT_FONT_FAMILY,
        ...normalizeWindowAppearance({
          windowOpacity: (saved as any).windowOpacity,
        }),
        initialized: true,
      })
      get().persist()
      return
    }

    // First run — no state at all
    set({ initialized: true })
    applyColorScheme(get().colorScheme)
  },

  persist() {
    const requestId = ++persistRequestId
    clearPersistStatusTimer()
    set({ saveStatus: 'saving' })

    const finishPersist = (status: 'saved' | 'error') => {
      if (requestId !== persistRequestId) return
      set({ saveStatus: status })
      if (status === 'saved') {
        persistStatusTimer = setTimeout(() => {
          if (requestId === persistRequestId) {
            set({ saveStatus: 'idle' })
          }
        }, SAVE_STATUS_RESET_MS)
      }
    }

    const saveState = (state: ProjectsState) =>
      window.cells.state.save(state).then(
        () => finishPersist('saved'),
        () => finishPersist('error'),
      )

    // Fetch live navigation history from all browser views, then save
    window.cells.browser
      .getAllHistory()
      .then((allHistory) => {
        const state = get()
        let projects = snapshotActiveProject(state)

        // Merge history into every project's browser nodes before saving so
        // parked browsers keep their back/forward stacks across restarts too.
        if (allHistory && Object.keys(allHistory).length > 0) {
          const browsers = state.browsers.map((b) => {
            const h = allHistory[b.id]
            return h ? { ...b, history: h } : b
          })
          projects = projects.map((project) => ({
            ...project,
            browsers: (project.browsers ?? []).map((browser) => {
              const history = allHistory[browser.id]
              return history ? { ...browser, history } : browser
            }),
          }))
          set({ browsers, projects })
        }

        const freshState = get()
        return saveState({
          version: 2,
          activeProjectId: freshState.activeProjectId,
          projects,
          terminalTheme: freshState.terminalTheme,
          fontSize: freshState.fontSize,
          fontFamily: freshState.fontFamily,
          windowOpacity: freshState.windowOpacity,
          snapOnFocus: freshState.snapOnFocus,
          tabSwitchMode: freshState.tabSwitchMode,
          projectSwitchMode: freshState.projectSwitchMode,
          reducedMotion: freshState.reducedMotion,
          autoUpdate: freshState.autoUpdate,
          searchEngine: freshState.searchEngine,
          homePage: freshState.homePage,
          terminalLinkTarget: freshState.terminalLinkTarget,
          terminalLinkProjectId: freshState.terminalLinkProjectId,
          linkRules: freshState.linkRules,
          agentAliases: freshState.agentAliases,
          colorScheme: freshState.colorScheme,
          closeUndoTimeoutMs: freshState.closeUndoTimeoutMs,
          closeProcessSuppressions: freshState.closeProcessSuppressions,
        })
      })
      .catch(() => {
        // Fallback: save without history
        const state = get()
        const projects = snapshotActiveProject(state)
        return saveState({
          version: 2,
          activeProjectId: state.activeProjectId,
          projects,
          terminalTheme: state.terminalTheme,
          fontSize: state.fontSize,
          fontFamily: state.fontFamily,
          windowOpacity: state.windowOpacity,
          snapOnFocus: state.snapOnFocus,
          tabSwitchMode: state.tabSwitchMode,
          projectSwitchMode: state.projectSwitchMode,
          reducedMotion: state.reducedMotion,
          autoUpdate: state.autoUpdate,
          searchEngine: state.searchEngine,
          homePage: state.homePage,
          terminalLinkTarget: state.terminalLinkTarget,
          terminalLinkProjectId: state.terminalLinkProjectId,
          linkRules: state.linkRules,
          agentAliases: state.agentAliases,
          colorScheme: state.colorScheme,
          closeUndoTimeoutMs: state.closeUndoTimeoutMs,
          closeProcessSuppressions: state.closeProcessSuppressions,
        })
      })
  },

  getActiveProject() {
    const { projects, activeProjectId } = get()
    return projects.find((p) => p.id === activeProjectId)
  },

  getActiveProjectPath() {
    return get().getActiveProject()?.path || undefined
  },

  createProject(name, path) {
    const state = get()
    const projects = snapshotActiveProject(state)

    // Park browser views (keep alive for when user switches back)
    for (const b of state.browsers) {
      window.cells.browser.park(b.id).catch(() => {})
    }

    const id = nanoid(8)
    const project: Project = {
      id,
      name,
      path,
      terminals: [],
      browsers: [],
      canvas: DEFAULT_CANVAS,
      lastOpenedAt: Date.now(),
    }

    set({
      projects: [...projects, project],
      activeProjectId: id,
      ...projectToWorkingState(project),
    })
    get().persist()
    get().refreshWorktrees()
  },

  switchProject(id) {
    const state = get()
    if (id === state.activeProjectId) return

    const projects = snapshotActiveProject(state)
    const target = projects.find((p) => p.id === id)
    if (!target) return

    // Park browser views (hide but keep alive) so they restore instantly on switch-back
    for (const b of state.browsers) {
      window.cells.browser.park(b.id).catch(() => {})
    }

    const updated = projects.map((p) => (p.id === id ? { ...p, lastOpenedAt: Date.now() } : p))

    set({
      projects: updated,
      activeProjectId: id,
      ...projectToWorkingState(target),
      crossProjectReturn: null,
    })
    get().persist()
    get().refreshWorktrees()
  },

  removeProject(id) {
    const state = get()
    const remaining = state.projects.filter((p) => p.id !== id)
    const projectLinkSettings = sanitizeProjectLinkSettings(
      remaining,
      state.terminalLinkProjectId === id ? null : state.terminalLinkProjectId,
      state.linkRules,
    )

    // Kill PTYs and browser views for the removed project
    const removedProject =
      id === state.activeProjectId
        ? { terminals: state.terminals, browsers: state.browsers }
        : state.projects.find((p) => p.id === id)
    if (removedProject) {
      for (const t of removedProject.terminals) {
        clearPendingCloseTimer(t.id)
        destroyTerminalResources(t.id)
      }
      for (const b of removedProject.browsers ?? []) {
        clearPendingCloseTimer(b.id)
        destroyBrowserResources(b.id)
      }
    }

    const pendingClosedWindows = state.pendingClosedWindows.filter((entry) => {
      if (entry.projectId !== id) return true
      clearPendingCloseTimer(entry.id)
      if (entry.target.type === 'terminal') {
        destroyTerminalResources(entry.id)
      } else {
        destroyBrowserResources(entry.id)
      }
      return false
    })
    const pendingCloseDialog =
      state.pendingCloseDialog &&
      pendingClosedWindows.some((entry) => entry.id === state.pendingCloseDialog?.target.id)
        ? state.pendingCloseDialog
        : null

    if (id === state.activeProjectId) {
      if (remaining.length > 0) {
        const sorted = [...remaining].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
        const next = sorted[0]
        set({
          projects: remaining,
          activeProjectId: next.id,
          terminalLinkProjectId: projectLinkSettings.terminalLinkProjectId,
          linkRules: projectLinkSettings.linkRules,
          pendingClosedWindows,
          pendingCloseDialog,
          ...projectToWorkingState(next),
        })
      } else {
        set({
          projects: [],
          activeProjectId: null,
          terminals: [],
          browsers: [],
          canvas: DEFAULT_CANVAS,
          focusedTerminalId: null,
          focusedBrowserId: null,
          topZIndex: 1,
          terminalLinkProjectId: projectLinkSettings.terminalLinkProjectId,
          linkRules: projectLinkSettings.linkRules,
          pendingClosedWindows,
          pendingCloseDialog,
        })
      }
    } else {
      set({
        projects: remaining,
        terminalLinkProjectId: projectLinkSettings.terminalLinkProjectId,
        linkRules: projectLinkSettings.linkRules,
        pendingClosedWindows,
        pendingCloseDialog,
      })
    }
    get().persist()
  },

  renameProject(id, name) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
    }))
    get().persist()
  },

  reorderProjects(ids) {
    const { projects } = get()
    const map = new Map(projects.map((p) => [p.id, p]))
    const reordered = ids.map((id) => map.get(id)).filter(Boolean) as Project[]
    // Append any projects not in the provided ids (safety)
    for (const p of projects) {
      if (!ids.includes(p.id)) reordered.push(p)
    }
    set({ projects: reordered })
    get().persist()
  },

  addTerminal() {
    const id = nanoid(8)
    const newZ = get().topZIndex + 1
    const { terminals, focusHistory } = get()

    // Size: fill the viewport minus padding and status bar
    const width = window.innerWidth - TERMINAL_PAD * 2
    const height = window.innerHeight - STATUS_BAR_HEIGHT - TERMINAL_PAD * 2

    // Place to the right of the rightmost terminal, or at origin
    let x = TERMINAL_PAD
    const y = TERMINAL_PAD
    if (terminals.length > 0) {
      const rightEdge = Math.max(...terminals.map((t) => t.x + t.width))
      x = rightEdge + TERMINAL_GAP
    }

    const terminal: TerminalNode = {
      id,
      x,
      y,
      width,
      height,
      title: 'Terminal',
      zIndex: newZ,
    }
    set((s) => ({
      terminals: [...s.terminals, terminal],
      topZIndex: newZ,
      focusedTerminalId: id,
      focusedBrowserId: null,
      focusHistory: pushFocusHistory(focusHistory, id),
    }))
    // Reset scale to 1 and snap to the new terminal
    set({ canvas: { ...get().canvas, scale: 1 } })
    get().snapToTerminal(id)
    get().persist()
    return terminal
  },

  addTerminalWithCommand(command, title) {
    const terminal = get().addTerminal()
    const inferredAgent = inferAgentFromCommand(command)
    if (title) {
      set((s) => ({
        terminals: s.terminals.map((t) =>
          t.id === terminal.id ? { ...t, title, agent: inferredAgent ?? t.agent ?? null } : t,
        ),
      }))
    } else if (inferredAgent) {
      set((s) => ({
        terminals: s.terminals.map((t) =>
          t.id === terminal.id ? { ...t, agent: inferredAgent } : t,
        ),
      }))
    }
    pendingCommands.set(terminal.id, command)
    return terminal
  },

  addTerminalInWorktree(command, title, worktreePath) {
    const terminal = get().addTerminalWithCommand(command, title)
    pendingWorktreePaths.set(terminal.id, worktreePath)
    return terminal
  },

  updateTerminalAgent(id, agent) {
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, agent } : t)),
    }))
  },

  updateTerminalAgentStatus(id, status) {
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, agentStatus: status } : t)),
    }))
  },

  removeAllTerminals() {
    const state = get()
    for (const t of state.terminals) {
      clearPendingCloseTimer(t.id)
      destroyTerminalResources(t.id)
    }
    set({
      terminals: [],
      focusedTerminalId: null,
      focusHistory: state.focusHistory.filter((h) => !state.terminals.some((t) => t.id === h)),
      pendingClosedWindows: state.pendingClosedWindows.filter(
        (entry) => entry.target.type !== 'terminal',
      ),
      pendingCloseDialog:
        state.pendingCloseDialog?.target.type === 'terminal' ? null : state.pendingCloseDialog,
    })
    get().persist()
  },

  removeTerminal(id) {
    clearPendingCloseTimer(id)
    destroyTerminalResources(id)
    const state = get()
    const remaining = state.terminals.filter((t) => t.id !== id)
    const history = state.focusHistory.filter((h) => h !== id)
    const wasFocused = state.focusedTerminalId === id
    set({
      terminals: remaining,
      focusHistory: history,
      focusedTerminalId: wasFocused ? null : state.focusedTerminalId,
      pendingClosedWindows: state.pendingClosedWindows.filter((entry) => entry.id !== id),
      pendingCloseDialog:
        state.pendingCloseDialog?.target.id === id ? null : state.pendingCloseDialog,
    })
    if (wasFocused) {
      const previousId = getPreviousWindowId(history, remaining, state.browsers)
      if (previousId) {
        if (remaining.some((terminal) => terminal.id === previousId)) {
          const nextHistory = pushFocusHistory(history, previousId)
          get().bringToFront(previousId)
          set({
            focusedTerminalId: previousId,
            focusedBrowserId: null,
            focusHistory: nextHistory,
          })
          get().panToTerminal(previousId)
        } else {
          const nextHistory = pushFocusHistory(history, previousId)
          get().bringBrowserToFront(previousId)
          set({
            focusedTerminalId: null,
            focusedBrowserId: previousId,
            focusHistory: nextHistory,
          })
          get().panToBrowser(previousId)
        }
      } else {
        set({ focusedBrowserId: null })
      }
    }
    get().persist()
  },

  focusTerminal(id) {
    const prev = get().focusedTerminalId
    // User engaged with a terminal in this project — clear cross-project return
    if (id && get().crossProjectReturn) {
      set({ crossProjectReturn: null })
    }
    if (id && id !== prev) {
      get().bringToFront(id)
      const history = pushFocusHistory(get().focusHistory, id)
      const counts = { ...get().focusCounts, [id]: (get().focusCounts[id] ?? 0) + 1 }
      // Clear 'done' agentStatus on focus — user has acknowledged
      const terminal = get().terminals.find((t) => t.id === id)
      if (terminal?.agentStatus === 'done') {
        set((s) => ({
          focusedTerminalId: id,
          focusedBrowserId: null,
          focusHistory: history,
          focusCounts: counts,
          terminals: s.terminals.map((t) => (t.id === id ? { ...t, agentStatus: null } : t)),
        }))
      } else {
        set({
          focusedTerminalId: id,
          focusedBrowserId: null,
          focusHistory: history,
          focusCounts: counts,
        })
      }
    } else {
      set({ focusedTerminalId: id, focusedBrowserId: null })
    }
    if (id && id !== prev && get().snapOnFocus) {
      get().snapToTerminal(id)
    }
  },

  bringToFront(id) {
    const newZ = get().topZIndex + 1
    set((s) => ({
      topZIndex: newZ,
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, zIndex: newZ } : t)),
    }))
  },

  togglePin(id, type) {
    const { canvas } = get()
    const kind = type ?? 'terminal'
    const node =
      kind === 'terminal'
        ? get().terminals.find((t) => t.id === id)
        : get().browsers.find((b) => b.id === id)
    if (!node) return

    if (node.pinned) {
      // Unpin: close the system window, mark as unpinned
      void window.cells.app.unpinWindow(id)
      if (kind === 'terminal') {
        set((s) => ({
          terminals: s.terminals.map((t) => (t.id === id ? { ...t, pinned: false } : t)),
        }))
      } else {
        set((s) => ({
          browsers: s.browsers.map((b) => (b.id === id ? { ...b, pinned: false } : b)),
        }))
      }
    } else {
      // Pin: compute screen bounds and open as system window
      const screenX = node.x * canvas.scale + canvas.x
      const screenY = node.y * canvas.scale + canvas.y
      // Get the main window's screen position to compute absolute bounds
      const bounds = { x: screenX, y: screenY, width: node.width, height: node.height }
      if (kind === 'terminal') {
        set((s) => ({
          terminals: s.terminals.map((t) => (t.id === id ? { ...t, pinned: true } : t)),
        }))
      } else {
        set((s) => ({
          browsers: s.browsers.map((b) => (b.id === id ? { ...b, pinned: true } : b)),
        }))
      }
      const browserUrl = kind === 'browser' ? (node as any).url : undefined
      void window.cells.app.pinWindow(id, kind, bounds, browserUrl)
    }
    get().persist()
  },

  togglePinFocused() {
    const { focusedTerminalId, focusedBrowserId } = get()
    if (focusedTerminalId) get().togglePin(focusedTerminalId, 'terminal')
    else if (focusedBrowserId) get().togglePin(focusedBrowserId, 'browser')
  },

  reloadFocused() {
    const { focusedTerminalId, focusedBrowserId } = get()
    if (focusedTerminalId) {
      reloadTerminal(focusedTerminalId)
    } else if (focusedBrowserId) {
      window.cells.browser.reload(focusedBrowserId)
    }
  },

  moveTerminal(id, x, y) {
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, x, y } : t)),
    }))
    debouncedPersist(() => get().persist())
  },

  resizeTerminal(id, width, height) {
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, width, height } : t)),
    }))
    debouncedPersist(() => get().persist())
  },

  updateTerminalTitle(id, title) {
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, title } : t)),
    }))
  },

  panToTerminal(id) {
    const { terminals, canvas } = get()
    const terminal = terminals.find((t) => t.id === id)
    if (!terminal) return
    const viewW = window.innerWidth
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT
    get().setCanvasTransform({
      ...canvas,
      x: viewW / 2 - (terminal.x + terminal.width / 2) * canvas.scale,
      y: viewH / 2 - (terminal.y + terminal.height / 2) * canvas.scale,
    })
  },

  panToBrowser(id) {
    const { browsers, canvas } = get()
    const browser = browsers.find((entry) => entry.id === id)
    if (!browser) return
    const viewW = window.innerWidth
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT
    get().setCanvasTransform({
      ...canvas,
      x: viewW / 2 - (browser.x + browser.width / 2) * canvas.scale,
      y: viewH / 2 - (browser.y + browser.height / 2) * canvas.scale,
    })
  },

  snapToTerminal(id) {
    const { terminals } = get()
    const terminal = terminals.find((t) => t.id === id)
    if (!terminal) return
    if (id !== get().focusedTerminalId) get().bringToFront(id)
    const focusHistory = pushFocusHistory(get().focusHistory, id)
    set({
      focusedTerminalId: id,
      focusedBrowserId: null,
      snapPaused: false,
      snapFast: true,
      focusHistory,
    })
    const viewW = window.innerWidth
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT
    const scale = Math.min(
      viewW / (terminal.width + TERMINAL_PAD * 2),
      viewH / (terminal.height + TERMINAL_PAD * 2),
      1,
    )
    get().setCanvasTransform({
      x: viewW / 2 - (terminal.x + terminal.width / 2) * scale,
      y: viewH / 2 - (terminal.y + terminal.height / 2) * scale,
      scale,
    })
  },

  zoomToFit(id) {
    const { terminals } = get()
    const terminal = terminals.find((t) => t.id === id)
    if (!terminal) return
    const viewW = window.innerWidth
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT
    const scale = Math.min(
      viewW / (terminal.width + TERMINAL_PAD * 2),
      viewH / (terminal.height + TERMINAL_PAD * 2),
      1,
    )
    if (id !== get().focusedTerminalId) get().bringToFront(id)
    set({ focusedTerminalId: id, snapPaused: false, snapFast: true })
    get().setCanvasTransform({
      x: TERMINAL_PAD - terminal.x * scale,
      y: TERMINAL_PAD - terminal.y * scale,
      scale,
    })
  },

  snapToNearest(direction) {
    const { terminals, browsers, focusedTerminalId, focusedBrowserId, canvas } = get()
    const windows = getCanvasWindows(terminals, browsers)
    if (windows.length === 0) return

    const currentId = focusedTerminalId || focusedBrowserId
    const current = currentId ? windows.find((window) => window.id === currentId) : null
    const origin = current ? getWindowCenter(current) : getViewportCenter(canvas)
    const next = getDirectionalWindow(windows, direction, origin, current?.id ?? null)
    if (!next) return

    if (next.type === 'terminal') {
      get().snapToTerminal(next.id)
    } else {
      get().snapToBrowser(next.id)
    }
  },

  snapToClosest() {
    set({ snapFast: false })
    const { terminals, browsers, canvas } = get()
    const windows = getCanvasWindows(terminals, browsers)
    if (windows.length === 0) return

    const best = getClosestWindow(windows, getViewportCenter(canvas))
    if (!best) return

    if (best.type === 'terminal') {
      get().snapToTerminal(best.id)
    } else {
      get().snapToBrowser(best.id)
    }
  },

  toggleSnap() {
    set((s) => ({ snapEnabled: !s.snapEnabled }))
  },

  setSnapPaused(paused) {
    set({ snapPaused: paused })
  },

  setSnapOnFocus(enabled) {
    set({ snapOnFocus: enabled })
    get().persist()
  },

  setSelectionMode(enabled) {
    const wasEnabled = get().selectionMode
    set({
      selectionMode: enabled,
      selectionCount: enabled ? get().selectionCount : 0,
      selectedNodeIds: enabled ? get().selectedNodeIds : [],
    })

    if (enabled && !wasEnabled) {
      get().zoomToFitAll()
    }
  },

  setSelectionCount(count) {
    set({ selectionCount: Math.max(0, count) })
  },

  setSelectedNodeIds(ids) {
    set({ selectedNodeIds: ids, selectionCount: ids.length })
  },

  setTabSwitchMode(mode) {
    set({ tabSwitchMode: mode })
    get().persist()
  },

  setProjectSwitchMode(mode) {
    set({ projectSwitchMode: mode })
    get().persist()
  },

  setReducedMotion(enabled) {
    set({ reducedMotion: enabled })
    get().persist()
  },

  setAutoUpdate(enabled) {
    set({ autoUpdate: enabled })
    get().persist()
    window.cells.updater.setAutoUpdate(enabled)
  },

  resizeWindowToFitFocused() {
    const { terminals, browsers, focusedTerminalId, focusedBrowserId } = get()
    const node = focusedTerminalId
      ? terminals.find((t) => t.id === focusedTerminalId)
      : focusedBrowserId
        ? browsers.find((b) => b.id === focusedBrowserId)
        : null
    if (!node) return
    const width = node.width + TERMINAL_PAD * 2
    const height = node.height + TERMINAL_PAD * 2 + STATUS_BAR_HEIGHT
    void window.cells.app.resizeToFit(width, height)
    // Re-fit the canvas after the window resizes
    requestAnimationFrame(() => {
      if (focusedTerminalId) get().snapToTerminal(focusedTerminalId)
      else if (focusedBrowserId) get().snapToBrowser(focusedBrowserId)
    })
  },

  resizeFocusedToFitViewport() {
    const { terminals, browsers, focusedTerminalId, focusedBrowserId } = get()
    const viewW = window.innerWidth - TERMINAL_PAD * 2
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT - TERMINAL_PAD * 2
    if (focusedTerminalId) {
      const t = terminals.find((t) => t.id === focusedTerminalId)
      if (!t) return
      get().resizeTerminal(focusedTerminalId, viewW, viewH)
      get().snapToTerminal(focusedTerminalId)
    } else if (focusedBrowserId) {
      const b = browsers.find((b) => b.id === focusedBrowserId)
      if (!b) return
      get().resizeBrowser(focusedBrowserId, viewW, viewH)
      get().snapToBrowser(focusedBrowserId)
    }
  },

  zoomToFitAll() {
    const { terminals, browsers } = get()
    const allNodes = [
      ...terminals.map((t) => ({ x: t.x, y: t.y, width: t.width, height: t.height })),
      ...browsers.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height })),
    ]
    const nextTransform = getOverviewTransform(
      allNodes,
      window.innerWidth,
      window.innerHeight - STATUS_BAR_HEIGHT,
    )
    if (!nextTransform) return

    set({ snapPaused: true, focusedTerminalId: null, focusedBrowserId: null, snapFast: false })
    get().setCanvasTransform(nextTransform)
  },

  autoArrangeGrid() {
    const { terminals, browsers, focusCounts } = get()
    const allWindows = [
      ...terminals.map((t) => ({ id: t.id, type: 'terminal' as const })),
      ...browsers.map((b) => ({ id: b.id, type: 'browser' as const })),
    ]
    if (allWindows.length === 0) return

    // Sort by focus count descending (most used first)
    allWindows.sort((a, b) => (focusCounts[b.id] ?? 0) - (focusCounts[a.id] ?? 0))

    // Generate spiral positions from center outward
    const spiralPositions: Array<{ col: number; row: number }> = [{ col: 0, row: 0 }]
    let layer = 1
    while (spiralPositions.length < allWindows.length) {
      // Right column top-to-bottom
      for (let r = -layer + 1; r <= layer && spiralPositions.length < allWindows.length; r++)
        spiralPositions.push({ col: layer, row: r })
      // Bottom row right-to-left
      for (let c = layer - 1; c >= -layer && spiralPositions.length < allWindows.length; c--)
        spiralPositions.push({ col: c, row: layer })
      // Left column bottom-to-top
      for (let r = layer - 1; r >= -layer && spiralPositions.length < allWindows.length; r--)
        spiralPositions.push({ col: -layer, row: r })
      // Top row left-to-right
      for (let c = -layer + 1; c <= layer && spiralPositions.length < allWindows.length; c++)
        spiralPositions.push({ col: c, row: -layer })
      layer++
    }

    // Use uniform cell size based on max window dimensions
    const allNodes = [...terminals, ...browsers]
    const cellW = Math.max(...allNodes.map((n) => n.width))
    const cellH = Math.max(...allNodes.map((n) => n.height))
    const gap = TERMINAL_GAP

    // Place each window at its spiral grid position, centered on (0,0)
    const updatedTerminals = new Map<string, { x: number; y: number }>()
    const updatedBrowsers = new Map<string, { x: number; y: number }>()
    for (let i = 0; i < allWindows.length; i++) {
      const { col, row } = spiralPositions[i]
      const x = col * (cellW + gap)
      const y = row * (cellH + gap)
      const win = allWindows[i]
      if (win.type === 'terminal') updatedTerminals.set(win.id, { x, y })
      else updatedBrowsers.set(win.id, { x, y })
    }

    set((s) => ({
      terminals: s.terminals.map((t) => {
        const pos = updatedTerminals.get(t.id)
        return pos ? { ...t, x: pos.x, y: pos.y } : t
      }),
      browsers: s.browsers.map((b) => {
        const pos = updatedBrowsers.get(b.id)
        return pos ? { ...b, x: pos.x, y: pos.y } : b
      }),
    }))

    // Zoom to fit the new layout
    get().zoomToFitAll()
    get().persist()
  },

  setCanvasTransform(transform) {
    set({ canvas: transform })
    debouncedPersist(() => get().persist())
  },

  setOverlayOpen(open) {
    set({ overlayOpen: open })
  },

  setSearchEngine(engine) {
    set({ searchEngine: engine })
    get().persist()
  },
  setHomePage(url) {
    set({ homePage: url })
    get().persist()
  },
  setTerminalLinkTarget(target) {
    set({ terminalLinkTarget: target })
    get().persist()
  },
  setTerminalLinkProjectId(projectId) {
    set({ terminalLinkProjectId: projectId })
    get().persist()
  },
  setLinkRules(rules) {
    set({ linkRules: rules })
    get().persist()
  },
  setAgentAliases(aliases) {
    set({ agentAliases: aliases })
    get().persist()
  },
  setLastUsedAgent(agent) {
    set({ lastUsedAgent: agent })
  },
  setColorScheme(scheme) {
    const isDark =
      scheme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : scheme === 'dark'
    // Auto-switch terminal theme to match
    const currentTheme = get().terminalTheme
    if (isDark && currentTheme === DEFAULT_LIGHT_THEME) {
      set({ colorScheme: scheme, terminalTheme: DEFAULT_THEME })
      applyThemeToAllTerminals(DEFAULT_THEME)
    } else if (!isDark && currentTheme === DEFAULT_THEME) {
      set({ colorScheme: scheme, terminalTheme: DEFAULT_LIGHT_THEME })
      applyThemeToAllTerminals(DEFAULT_LIGHT_THEME)
    } else {
      set({ colorScheme: scheme })
    }
    applyColorScheme(scheme)
    get().persist()
  },
  setCloseUndoTimeoutMs(timeoutMs) {
    set({ closeUndoTimeoutMs: Math.max(0, timeoutMs) })
    get().persist()
  },
  setCloseProcessSuppressions(processes) {
    set({
      closeProcessSuppressions: [
        ...new Set(processes.map((process) => process.trim().toLowerCase())),
      ]
        .filter(Boolean)
        .sort(),
    })
    get().persist()
  },
  async requestCloseWindow(target) {
    const state = get()
    const resolvedTarget =
      target ??
      (state.focusedBrowserId
        ? { id: state.focusedBrowserId, type: 'browser' as const }
        : state.focusedTerminalId
          ? { id: state.focusedTerminalId, type: 'terminal' as const }
          : state.terminals.length > 0
            ? { id: state.terminals[state.terminals.length - 1].id, type: 'terminal' as const }
            : null)

    if (!resolvedTarget) return

    const commitClose = (processInfo?: TerminalProcessInfo | null) => {
      const current = get()
      if (!current.activeProjectId) return

      const now = Date.now()
      const timeoutMs = current.closeUndoTimeoutMs
      const expiresAt = now + timeoutMs

      if (resolvedTarget.type === 'terminal') {
        const terminal = current.terminals.find((item) => item.id === resolvedTarget.id)
        if (!terminal) return

        if (timeoutMs <= 0) {
          current.removeTerminal(terminal.id)
          return
        }

        const remaining = current.terminals.filter((item) => item.id !== terminal.id)
        const history = current.focusHistory.filter((entry) => entry !== terminal.id)
        const wasFocused = current.focusedTerminalId === terminal.id

        set({
          terminals: remaining,
          focusHistory: history,
          focusedTerminalId: wasFocused ? null : current.focusedTerminalId,
          pendingClosedWindows: upsertPendingClosedWindow(current.pendingClosedWindows, {
            id: terminal.id,
            target: resolvedTarget,
            projectId: current.activeProjectId,
            terminal,
            title: terminal.title,
            closedAt: now,
            expiresAt,
            processLabel: processInfo?.label ?? null,
            processKey: processInfo?.key ?? null,
          }),
        })

        clearPendingCloseTimer(terminal.id)
        pendingCloseTimers.set(
          terminal.id,
          window.setTimeout(() => {
            useStore.getState().removeTerminal(terminal.id)
          }, timeoutMs),
        )

        if (wasFocused) {
          const previousId = getPreviousWindowId(history, remaining, current.browsers)
          if (previousId) {
            if (remaining.some((item) => item.id === previousId)) {
              const nextHistory = pushFocusHistory(history, previousId)
              get().bringToFront(previousId)
              set({
                focusedTerminalId: previousId,
                focusedBrowserId: null,
                focusHistory: nextHistory,
              })
              get().panToTerminal(previousId)
            } else {
              const nextHistory = pushFocusHistory(history, previousId)
              get().bringBrowserToFront(previousId)
              set({
                focusedTerminalId: null,
                focusedBrowserId: previousId,
                focusHistory: nextHistory,
              })
              get().panToBrowser(previousId)
            }
          } else {
            set({ focusedBrowserId: null })
          }
        }
      } else {
        const browser = current.browsers.find((item) => item.id === resolvedTarget.id)
        if (!browser) return

        if (timeoutMs <= 0) {
          current.removeBrowser(browser.id)
          return
        }

        const returnCtx = current.crossProjectReturn
        const shouldReturn = returnCtx?.browserId === browser.id

        const remaining = current.browsers.filter((item) => item.id !== browser.id)
        const history = current.focusHistory.filter((entry) => entry !== browser.id)
        const wasFocused = current.focusedBrowserId === browser.id

        set({
          browsers: remaining,
          focusHistory: history,
          focusedBrowserId: wasFocused ? null : current.focusedBrowserId,
          pendingClosedWindows: upsertPendingClosedWindow(current.pendingClosedWindows, {
            id: browser.id,
            target: resolvedTarget,
            projectId: current.activeProjectId,
            browser,
            title: browser.title || browser.url || 'New Tab',
            closedAt: now,
            expiresAt,
          }),
          crossProjectReturn: shouldReturn ? null : current.crossProjectReturn,
        })

        clearPendingCloseTimer(browser.id)
        pendingCloseTimers.set(
          browser.id,
          window.setTimeout(() => {
            useStore.getState().removeBrowser(browser.id)
          }, timeoutMs),
        )

        // Return to source project immediately — the undo entry stays and
        // restoreLastClosedWindow already handles cross-project restoration
        if (shouldReturn) {
          set({ pendingCloseDialog: null })
          get().persist()
          get().switchProject(returnCtx.sourceProjectId)
          return
        }

        if (wasFocused) {
          const previousId = getPreviousWindowId(history, current.terminals, remaining)
          if (previousId) {
            if (current.terminals.some((item) => item.id === previousId)) {
              const nextHistory = pushFocusHistory(history, previousId)
              get().bringToFront(previousId)
              set({
                focusedTerminalId: previousId,
                focusedBrowserId: null,
                focusHistory: nextHistory,
              })
              get().panToTerminal(previousId)
            } else {
              const nextHistory = pushFocusHistory(history, previousId)
              get().bringBrowserToFront(previousId)
              set({
                focusedTerminalId: null,
                focusedBrowserId: previousId,
                focusHistory: nextHistory,
              })
              get().panToBrowser(previousId)
            }
          } else {
            set({ focusedTerminalId: null })
          }
        }
      }

      set({ pendingCloseDialog: null })
      get().persist()
    }

    if (resolvedTarget.type === 'terminal') {
      const processInfo = await window.cells.terminal
        .getProcessInfo(resolvedTarget.id)
        .catch(() => null)
      const latestState = get()
      const promptAlreadyAccepted =
        latestState.pendingCloseDialog?.target.id === resolvedTarget.id &&
        latestState.pendingCloseDialog?.target.type === resolvedTarget.type
      if (
        processInfo &&
        !processInfo.isShell &&
        !latestState.closeProcessSuppressions.includes(processInfo.key) &&
        !promptAlreadyAccepted
      ) {
        const terminal = latestState.terminals.find((item) => item.id === resolvedTarget.id)
        if (!terminal) return
        set({
          pendingCloseDialog: {
            target: resolvedTarget,
            process: processInfo,
            title: terminal.title,
          },
        })
        return
      }
      commitClose(processInfo)
      return
    }

    commitClose(null)
  },
  cancelPendingClose() {
    set({ pendingCloseDialog: null })
  },
  confirmPendingClose(skipFuturePrompts = false) {
    const dialog = get().pendingCloseDialog
    if (!dialog) return
    if (skipFuturePrompts) {
      const next = [...get().closeProcessSuppressions, dialog.process.key]
      get().setCloseProcessSuppressions(next)
    }
    get().requestCloseWindow(dialog.target)
  },
  restoreLastClosedWindow() {
    const state = get()
    const entry =
      state.pendingClosedWindows.find(
        (candidate) => candidate.projectId === state.activeProjectId,
      ) ?? state.pendingClosedWindows[0]
    if (!entry) return

    clearPendingCloseTimer(entry.id)
    set({
      pendingClosedWindows: state.pendingClosedWindows.filter(
        (candidate) => candidate.id !== entry.id,
      ),
    })

    if (entry.projectId !== get().activeProjectId) {
      get().switchProject(entry.projectId)
    }

    const current = get()
    const newZ = current.topZIndex + 1

    if (entry.terminal) {
      const restoredTerminal = { ...entry.terminal, zIndex: newZ }
      const nextHistory = pushFocusHistory(current.focusHistory, restoredTerminal.id)
      set({
        terminals: [...current.terminals, restoredTerminal],
        topZIndex: newZ,
        focusedTerminalId: restoredTerminal.id,
        focusedBrowserId: null,
        focusHistory: nextHistory,
      })
      get().snapToTerminal(restoredTerminal.id)
      get().persist()
      return
    }

    if (entry.browser) {
      const restoredBrowser = { ...entry.browser, zIndex: newZ }
      const nextHistory = pushFocusHistory(current.focusHistory, restoredBrowser.id)
      set({
        browsers: [...current.browsers, restoredBrowser],
        topZIndex: newZ,
        focusedTerminalId: null,
        focusedBrowserId: restoredBrowser.id,
        focusHistory: nextHistory,
      })
      get().snapToBrowser(restoredBrowser.id)
      get().persist()
    }
  },
  getAgentCommand(agent) {
    const alias = get().agentAliases[agent]
    return alias && alias.trim() ? alias.trim() : agent
  },

  getSearchUrl(query) {
    const engine = get().searchEngine || DEFAULT_SEARCH_ENGINE
    return engine.replace('%s', encodeURIComponent(query))
  },

  // ---- Worktree actions ----

  async refreshWorktrees() {
    const projectPath = get().getActiveProjectPath()
    if (!projectPath) {
      set({ worktrees: [], isGitRepo: false, worktreesLoading: false })
      return
    }
    set({ worktreesLoading: true })
    try {
      const isRepo = await window.cells.git.isRepo(projectPath)
      if (!isRepo) {
        set({ worktrees: [], isGitRepo: false, worktreesLoading: false })
        return
      }
      const worktrees = await window.cells.git.listWorktrees(projectPath)
      set({ worktrees, isGitRepo: true, worktreesLoading: false })
    } catch {
      set({ worktrees: [], isGitRepo: false, worktreesLoading: false })
    }
  },

  async switchTerminalWorktree(termId, worktreePath) {
    // Get the current running process before killing
    const processInfo = await window.cells.terminal.getProcessInfo(termId)
    const command = processInfo && !processInfo.isShell ? processInfo.command : null

    // Kill the PTY and destroy cached terminal
    destroyCachedTerminal(termId)
    await window.cells.terminal.detach(termId).catch(() => {})

    // Trigger reload — the terminal component will re-mount and re-attach
    // with the new cwd via the pending worktree path
    pendingWorktreePaths.set(termId, worktreePath)
    if (command) {
      pendingCommands.set(termId, command)
    }
    window.dispatchEvent(new CustomEvent('terminal-reload', { detail: { termId } }))
  },

  async moveTerminalsToWorktree(termIds, worktreePath) {
    // Move terminals sequentially to avoid race conditions with PTY management
    for (const termId of termIds) {
      await get().switchTerminalWorktree(termId, worktreePath)
    }
    // Exit selection mode after bulk move
    if (get().selectionMode) {
      set({ selectionMode: false, selectedNodeIds: [], selectionCount: 0 })
    }
  },

  async createWorktree(branch) {
    const projectPath = get().getActiveProjectPath()
    if (!projectPath) throw new Error('No active project')
    const project = get().getActiveProject()
    const worktreesDir = project?.worktreesDir || undefined
    const baseBranch = project?.worktreeBaseBranch || undefined
    const created = await window.cells.git.createWorktree(
      projectPath,
      branch,
      worktreesDir,
      baseBranch,
    )
    await get().refreshWorktrees()
    return created
  },

  setWorktreesDir(dir) {
    const { activeProjectId } = get()
    if (!activeProjectId) return
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === activeProjectId ? { ...p, worktreesDir: dir || undefined } : p,
      ),
    }))
    get().persist()
  },

  getWorktreesDir() {
    return get().getActiveProject()?.worktreesDir
  },

  setWorktreeBaseBranch(branch) {
    const { activeProjectId } = get()
    if (!activeProjectId) return
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === activeProjectId ? { ...p, worktreeBaseBranch: branch || undefined } : p,
      ),
    }))
    get().persist()
  },

  getWorktreeBaseBranch() {
    return get().getActiveProject()?.worktreeBaseBranch
  },

  // ---- Browser actions ----

  addBrowser() {
    const id = nanoid(8)
    const newZ = get().topZIndex + 1
    const { terminals, browsers, focusHistory } = get()

    const width = window.innerWidth - TERMINAL_PAD * 2
    const height = window.innerHeight - STATUS_BAR_HEIGHT - TERMINAL_PAD * 2

    // Place to the right of all nodes (terminals + browsers)
    let x = TERMINAL_PAD
    const y = TERMINAL_PAD
    const allRightEdges = [
      ...terminals.map((t) => t.x + t.width),
      ...browsers.map((b) => b.x + b.width),
    ]
    if (allRightEdges.length > 0) {
      x = Math.max(...allRightEdges) + TERMINAL_GAP
    }

    // Use configured homepage, or search engine homepage, or empty
    const homePage = get().homePage
    let defaultUrl = ''
    if (homePage) {
      defaultUrl = homePage
    } else {
      // Extract base URL from search engine (e.g. "https://www.google.com/search?q=%s" → "https://www.google.com")
      try {
        const engineUrl = new URL(get().searchEngine || DEFAULT_SEARCH_ENGINE)
        defaultUrl = engineUrl.origin
      } catch {}
    }

    const browser: BrowserNode = {
      id,
      x,
      y,
      width,
      height,
      url: defaultUrl,
      title: 'New Tab',
      zIndex: newZ,
    }
    set((s) => ({
      browsers: [...s.browsers, browser],
      topZIndex: newZ,
      focusedTerminalId: null,
      focusedBrowserId: id,
      focusHistory: pushFocusHistory(focusHistory, id),
    }))
    set({ canvas: { ...get().canvas, scale: 1 } })
    // Snap to the new browser (reuse snapToTerminal-like logic)
    const scale = get().canvas.scale
    get().setCanvasTransform({
      x: TERMINAL_PAD - browser.x * scale,
      y: TERMINAL_PAD - browser.y * scale,
      scale,
    })
    get().persist()
    return browser
  },

  addBrowserWithUrl(url, projectId) {
    const state = get()
    const isCrossProject =
      projectId &&
      projectId !== state.activeProjectId &&
      state.projects.some((p) => p.id === projectId)
    const sourceProjectId = state.activeProjectId

    if (isCrossProject) {
      get().switchProject(projectId)
    }
    const browser = get().addBrowser()
    // URL will be set after the component mounts and creates the view
    set((s) => ({
      browsers: s.browsers.map((b) => (b.id === browser.id ? { ...b, url } : b)),
    }))

    // Track return context so closing this browser returns to the source project
    if (isCrossProject && sourceProjectId) {
      set({ crossProjectReturn: { browserId: browser.id, sourceProjectId } })
    }

    get().persist()
    return browser
  },

  removeBrowser(id) {
    clearPendingCloseTimer(id)
    destroyBrowserResources(id)
    const state = get()
    const returnCtx = state.crossProjectReturn
    const shouldReturn = returnCtx?.browserId === id
    const remaining = state.browsers.filter((b) => b.id !== id)
    const history = state.focusHistory.filter((h) => h !== id)
    const wasFocused = state.focusedBrowserId === id
    set({
      browsers: remaining,
      focusHistory: history,
      focusedBrowserId: wasFocused ? null : state.focusedBrowserId,
      pendingClosedWindows: state.pendingClosedWindows.filter((entry) => entry.id !== id),
      pendingCloseDialog:
        state.pendingCloseDialog?.target.id === id ? null : state.pendingCloseDialog,
      crossProjectReturn: shouldReturn ? null : state.crossProjectReturn,
    })
    if (shouldReturn) {
      get().persist()
      get().switchProject(returnCtx.sourceProjectId)
      return
    }
    if (wasFocused) {
      const previousId = getPreviousWindowId(history, state.terminals, remaining)
      if (previousId) {
        if (state.terminals.some((terminal) => terminal.id === previousId)) {
          const nextHistory = pushFocusHistory(history, previousId)
          get().bringToFront(previousId)
          set({
            focusedTerminalId: previousId,
            focusedBrowserId: null,
            focusHistory: nextHistory,
          })
          get().panToTerminal(previousId)
        } else {
          const nextHistory = pushFocusHistory(history, previousId)
          get().bringBrowserToFront(previousId)
          set({
            focusedTerminalId: null,
            focusedBrowserId: previousId,
            focusHistory: nextHistory,
          })
          get().panToBrowser(previousId)
        }
      } else {
        set({ focusedTerminalId: null })
      }
    }
    get().persist()
  },

  moveBrowser(id, x, y) {
    set((s) => ({
      browsers: s.browsers.map((b) => (b.id === id ? { ...b, x, y } : b)),
    }))
    debouncedPersist(() => get().persist())
  },

  resizeBrowser(id, width, height) {
    set((s) => ({
      browsers: s.browsers.map((b) => (b.id === id ? { ...b, width, height } : b)),
    }))
    debouncedPersist(() => get().persist())
  },

  updateBrowserUrl(id, url) {
    set((s) => ({
      browsers: s.browsers.map((b) => (b.id === id ? { ...b, url } : b)),
    }))
    get().persist()
  },

  updateBrowserTitle(id, title) {
    set((s) => ({
      browsers: s.browsers.map((b) => (b.id === id ? { ...b, title } : b)),
    }))
  },

  updateBrowserFavicon(id, faviconUrl) {
    set((s) => ({
      browsers: s.browsers.map((b) => (b.id === id ? { ...b, faviconUrl } : b)),
    }))
  },

  focusBrowser(id) {
    const prev = get().focusedBrowserId
    // User focused a different browser in this project — clear cross-project return
    const ret = get().crossProjectReturn
    if (id && ret && id !== ret.browserId) {
      set({ crossProjectReturn: null })
    }
    if (id && id !== prev) {
      get().bringBrowserToFront(id)
      const history = pushFocusHistory(get().focusHistory, id)
      const counts = { ...get().focusCounts, [id]: (get().focusCounts[id] ?? 0) + 1 }
      set({
        focusedTerminalId: null,
        focusedBrowserId: id,
        focusHistory: history,
        focusCounts: counts,
      })
    } else {
      set({ focusedTerminalId: null, focusedBrowserId: id })
    }
    if (id && id !== prev && get().snapOnFocus) {
      get().snapToBrowser(id)
    }
  },

  snapToBrowser(id) {
    const { browsers } = get()
    const browser = browsers.find((b) => b.id === id)
    if (!browser) return
    if (id !== get().focusedBrowserId) get().bringBrowserToFront(id)
    const focusHistory = pushFocusHistory(get().focusHistory, id)
    set({
      focusedTerminalId: null,
      focusedBrowserId: id,
      snapPaused: false,
      snapFast: true,
      focusHistory,
    })
    const viewW = window.innerWidth
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT
    const scale = Math.min(
      viewW / (browser.width + TERMINAL_PAD * 2),
      viewH / (browser.height + TERMINAL_PAD * 2),
      1,
    )
    get().setCanvasTransform({
      x: viewW / 2 - (browser.x + browser.width / 2) * scale,
      y: viewH / 2 - (browser.y + browser.height / 2) * scale,
      scale,
    })
  },

  bringBrowserToFront(id) {
    const newZ = get().topZIndex + 1
    set((s) => ({
      topZIndex: newZ,
      browsers: s.browsers.map((b) => (b.id === id ? { ...b, zIndex: newZ } : b)),
    }))
  },
}))
