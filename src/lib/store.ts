import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { BrowserNode, CanvasTransform, Project, ProjectsState, TerminalNode } from '../types'
import { DEFAULT_THEME } from './terminal-themes'
import { DEFAULT_WINDOW_APPEARANCE, normalizeWindowAppearance } from './window-appearance'
import {
  STATUS_BAR_HEIGHT,
  getCanvasWindows,
  getClosestWindow,
  getDirectionalWindow,
  getWindowCenter,
  getViewportCenter,
} from './canvas-navigation'
import {
  destroyCachedTerminal,
  applyThemeToAllTerminals,
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
  topZIndex: number
  snapEnabled: boolean
  snapPaused: boolean
  snapFast: boolean // hint for canvas to use fast spring
  snapOnFocus: boolean
  tabSwitchMode: 'recent' | 'chronological'
  overlayOpen: boolean // true when popover/dialog is open — hides browser native views
  searchEngine: string
  homePage: string
  terminalLinkTarget: 'system' | 'browser'
  linkRules: Array<{ pattern: string; target: 'system' | 'browser'; projectId?: string }>

  init(): Promise<void>
  persist(): void

  // Project actions
  createProject(name: string, path: string): void
  switchProject(id: string): void
  removeProject(id: string): void
  renameProject(id: string, name: string): void
  getActiveProject(): Project | undefined
  getActiveProjectPath(): string | undefined

  setTerminalTheme(name: string): void
  setFontSize(size: number): void
  setFontFamily(family: string): void
  setWindowOpacity(opacity: number): void

  addTerminal(): TerminalNode
  addTerminalWithCommand(command: string, title?: string): TerminalNode
  updateTerminalAgent(id: string, agent: 'claude' | 'codex' | null): void
  removeTerminal(id: string): void
  moveTerminal(id: string, x: number, y: number): void
  resizeTerminal(id: string, width: number, height: number): void
  updateTerminalTitle(id: string, title: string): void
  focusTerminal(id: string | null): void
  bringToFront(id: string): void
  togglePin(id: string): void
  panToTerminal(id: string): void
  panToBrowser(id: string): void
  snapToTerminal(id: string): void
  zoomToFit(id: string): void
  snapToNearest(direction: 'left' | 'right' | 'up' | 'down'): void
  snapToClosest(): void
  toggleSnap(): void
  setSnapPaused(paused: boolean): void
  setSnapOnFocus(enabled: boolean): void
  setTabSwitchMode(mode: 'recent' | 'chronological'): void

  setCanvasTransform(transform: CanvasTransform): void
  zoomToFitAll(): void
  setOverlayOpen(open: boolean): void
  setSearchEngine(engine: string): void
  setHomePage(url: string): void
  setTerminalLinkTarget(target: 'system' | 'browser'): void
  setLinkRules(rules: Array<{ pattern: string; target: 'system' | 'browser'; projectId?: string }>): void
  getSearchUrl(query: string): string

  // Browser actions
  addBrowser(): BrowserNode
  addBrowserWithUrl(url: string): BrowserNode
  removeBrowser(id: string): void
  snapToBrowser(id: string): void
  moveBrowser(id: string, x: number, y: number): void
  resizeBrowser(id: string, width: number, height: number): void
  updateBrowserUrl(id: string, url: string): void
  updateBrowserTitle(id: string, title: string): void
  focusBrowser(id: string): void
  bringBrowserToFront(id: string): void
}

const TERMINAL_PAD = 8

// Pending commands to run after terminal attaches (not persisted)
const pendingCommands = new Map<string, string>()
const TERMINAL_GAP = 60
const DEFAULT_CANVAS: CanvasTransform = { x: 0, y: 0, scale: 1 }
const DEFAULT_FONT_FAMILY = '"Geist Mono", "SFMono-Regular", "JetBrains Mono", "Menlo", monospace'
const DEFAULT_SEARCH_ENGINE = 'https://www.google.com/search?q=%s'
const DEFAULT_HOME_PAGE = ''

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

let persistTimer: ReturnType<typeof setTimeout> | null = null
function debouncedPersist(fn: () => void, delay = 500) {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(fn, delay)
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
  }
}

export function consumePendingCommand(termId: string): string | undefined {
  const cmd = pendingCommands.get(termId)
  pendingCommands.delete(termId)
  return cmd
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
  topZIndex: 1,
  snapEnabled: true,
  snapPaused: false,
  snapFast: false,
  snapOnFocus: true,
  tabSwitchMode: 'chronological',
  overlayOpen: false,
  searchEngine: DEFAULT_SEARCH_ENGINE,
  homePage: DEFAULT_HOME_PAGE,
  terminalLinkTarget: 'system',
  linkRules: [],
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
    const saved = await window.cells.state.load()

    if (saved && (saved as any).version === 2) {
      const ps = saved as ProjectsState
      const projects = ps.projects ?? []

      const globalSettings = {
        terminalTheme: ps.terminalTheme || DEFAULT_THEME,
        fontSize: ps.fontSize || 13,
        fontFamily: ps.fontFamily || DEFAULT_FONT_FAMILY,
        ...normalizeWindowAppearance({
          windowOpacity: ps.windowOpacity,
        }),
        snapOnFocus: ps.snapOnFocus ?? true,
        tabSwitchMode: ps.tabSwitchMode || 'chronological',
        searchEngine: ps.searchEngine || DEFAULT_SEARCH_ENGINE,
        homePage: ps.homePage || DEFAULT_HOME_PAGE,
        terminalLinkTarget: ps.terminalLinkTarget || 'system',
        linkRules: ps.linkRules || [],
      }

      if (projects.length === 0) {
        set({ projects: [], activeProjectId: null, ...globalSettings, initialized: true })
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
  },

  persist() {
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
        window.cells.state.save({
          version: 2,
          activeProjectId: freshState.activeProjectId,
          projects,
          terminalTheme: freshState.terminalTheme,
          fontSize: freshState.fontSize,
          fontFamily: freshState.fontFamily,
          windowOpacity: freshState.windowOpacity,
          snapOnFocus: freshState.snapOnFocus,
          tabSwitchMode: freshState.tabSwitchMode,
          searchEngine: freshState.searchEngine,
          homePage: freshState.homePage,
          terminalLinkTarget: freshState.terminalLinkTarget,
          linkRules: freshState.linkRules,
        })
      })
      .catch(() => {
        // Fallback: save without history
        const state = get()
        const projects = snapshotActiveProject(state)
        window.cells.state.save({
          version: 2,
          activeProjectId: state.activeProjectId,
          projects,
          terminalTheme: state.terminalTheme,
          fontSize: state.fontSize,
          fontFamily: state.fontFamily,
          windowOpacity: state.windowOpacity,
          snapOnFocus: state.snapOnFocus,
          tabSwitchMode: state.tabSwitchMode,
          searchEngine: state.searchEngine,
          homePage: state.homePage,
          terminalLinkTarget: state.terminalLinkTarget,
          linkRules: state.linkRules,
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
    })
    get().persist()
  },

  removeProject(id) {
    const state = get()
    const remaining = state.projects.filter((p) => p.id !== id)

    // Kill PTYs and browser views for the removed project
    const removedProject =
      id === state.activeProjectId
        ? { terminals: state.terminals, browsers: state.browsers }
        : state.projects.find((p) => p.id === id)
    if (removedProject) {
      for (const t of removedProject.terminals) {
        destroyCachedTerminal(t.id)
        window.cells.terminal.detach(t.id).catch(() => {})
      }
      for (const b of removedProject.browsers ?? []) {
        window.cells.browser.destroy(b.id).catch(() => {})
      }
    }

    if (id === state.activeProjectId) {
      if (remaining.length > 0) {
        const sorted = [...remaining].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
        const next = sorted[0]
        set({
          projects: remaining,
          activeProjectId: next.id,
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
        })
      }
    } else {
      set({ projects: remaining })
    }
    get().persist()
  },

  renameProject(id, name) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
    }))
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
    if (title) {
      set((s) => ({
        terminals: s.terminals.map((t) => (t.id === terminal.id ? { ...t, title } : t)),
      }))
    }
    pendingCommands.set(terminal.id, command)
    return terminal
  },

  updateTerminalAgent(id, agent) {
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, agent } : t)),
    }))
  },

  removeTerminal(id) {
    destroyCachedTerminal(id)
    window.cells.terminal.detach(id).catch(() => {})
    const state = get()
    const remaining = state.terminals.filter((t) => t.id !== id)
    const history = state.focusHistory.filter((h) => h !== id)
    const wasFocused = state.focusedTerminalId === id
    set({
      terminals: remaining,
      focusHistory: history,
      focusedTerminalId: wasFocused ? null : state.focusedTerminalId,
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
    if (id && id !== prev) {
      get().bringToFront(id)
      const history = pushFocusHistory(get().focusHistory, id)
      set({ focusedTerminalId: id, focusedBrowserId: null, focusHistory: history })
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

  togglePin(id) {
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
    }))
    get().persist()
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
    const { terminals, canvas } = get()
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
    const fitScale = Math.min(
      viewW / (terminal.width + TERMINAL_PAD * 2),
      viewH / (terminal.height + TERMINAL_PAD * 2),
      1,
    )
    // Zoomed out → zoom in to fit. Already zoomed in → keep current scale.
    const scale = canvas.scale < fitScale ? fitScale : canvas.scale
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

  setTabSwitchMode(mode) {
    set({ tabSwitchMode: mode })
    get().persist()
  },

  zoomToFitAll() {
    const { terminals, browsers } = get()
    const allNodes = [
      ...terminals.map((t) => ({ x: t.x, y: t.y, width: t.width, height: t.height })),
      ...browsers.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height })),
    ]
    if (allNodes.length === 0) return

    // Compute bounding box of all nodes
    const minX = Math.min(...allNodes.map((n) => n.x))
    const minY = Math.min(...allNodes.map((n) => n.y))
    const maxX = Math.max(...allNodes.map((n) => n.x + n.width))
    const maxY = Math.max(...allNodes.map((n) => n.y + n.height))

    const padding = 40
    const viewW = window.innerWidth
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT
    const contentW = maxX - minX + padding * 2
    const contentH = maxY - minY + padding * 2

    const scale = Math.min(viewW / contentW, viewH / contentH, 1)

    // Center the bounding box in the viewport
    const scaledW = contentW * scale
    const scaledH = contentH * scale
    const offsetX = (viewW - scaledW) / 2
    const offsetY = (viewH - scaledH) / 2

    set({ snapPaused: true, focusedTerminalId: null, focusedBrowserId: null, snapFast: false })
    get().setCanvasTransform({
      x: offsetX - (minX - padding) * scale,
      y: offsetY - (minY - padding) * scale,
      scale,
    })
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
  setLinkRules(rules) {
    set({ linkRules: rules })
    get().persist()
  },

  getSearchUrl(query) {
    const engine = get().searchEngine || DEFAULT_SEARCH_ENGINE
    return engine.replace('%s', encodeURIComponent(query))
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

  addBrowserWithUrl(url) {
    const browser = get().addBrowser()
    // URL will be set after the component mounts and creates the view
    set((s) => ({
      browsers: s.browsers.map((b) => (b.id === browser.id ? { ...b, url } : b)),
    }))
    return browser
  },

  removeBrowser(id) {
    window.cells.browser.destroy(id).catch(() => {})
    const state = get()
    const remaining = state.browsers.filter((b) => b.id !== id)
    const history = state.focusHistory.filter((h) => h !== id)
    const wasFocused = state.focusedBrowserId === id
    set({
      browsers: remaining,
      focusHistory: history,
      focusedBrowserId: wasFocused ? null : state.focusedBrowserId,
    })
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

  focusBrowser(id) {
    const prev = get().focusedBrowserId
    if (id && id !== prev) {
      get().bringBrowserToFront(id)
      const history = pushFocusHistory(get().focusHistory, id)
      set({ focusedTerminalId: null, focusedBrowserId: id, focusHistory: history })
    } else {
      set({ focusedTerminalId: null, focusedBrowserId: id })
    }
    if (id && id !== prev && get().snapOnFocus) {
      get().snapToBrowser(id)
    }
  },

  snapToBrowser(id) {
    const { browsers, canvas } = get()
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
    const fitScale = Math.min(
      viewW / (browser.width + TERMINAL_PAD * 2),
      viewH / (browser.height + TERMINAL_PAD * 2),
      1,
    )
    const scale = canvas.scale < fitScale ? fitScale : canvas.scale
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
