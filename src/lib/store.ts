import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type {
  AgentNotificationSettings,
  AgentSessionDefaults,
  AgentWindowNode,
  AgentName,
  BrowserNode,
  CanvasTransform,
  GitWorktree,
  InputPrefix,
  Project,
  ProjectsState,
  TerminalRuntimeStatus,
  TerminalSessionBackend,
  TerminalNode,
  TerminalProcessInfo,
  TitleBarPosition,
} from '../types'
import {
  DEFAULT_AGENT_NOTIFICATION_SETTINGS,
  normalizeAgentNotificationSettings,
} from './agent-notification-settings'
import { inferAgentFromCommand } from './agent-command'
import { DEFAULT_THEME, terminalThemes } from './terminal-themes'
import {
  DEFAULT_APP_DARK_THEME,
  DEFAULT_APP_LIGHT_THEME,
  buildAppThemeVariables,
  getActiveAppThemeKey,
  normalizeAppThemeKey,
  resolveAppColorScheme,
} from './app-themes'
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
  getTerminalRestoreSnapshot,
  reloadTerminal,
  reloadAllTerminals,
} from '@/components/terminal/terminal-cache-api'
import { showToast } from '@/components/toast'
import {
  DEFAULT_TERMINAL_SCROLLBACK_LINES,
  normalizeTerminalScrollbackLines,
} from './terminal-scrollback'
import { formatTerminalExitMessage } from './terminal-exit'
import {
  DEFAULT_TERMINAL_CURSOR_SETTINGS,
  normalizeTerminalCursorSettings,
  normalizeTerminalCursorStyle,
  type TerminalCursorStyle,
} from './terminal-cursor'
import { DEFAULT_TERMINAL_FONT_FAMILY, normalizeTerminalFontFamily } from './terminal-fonts'
import {
  DEFAULT_TERMINAL_SESSION_BACKEND,
  normalizeTerminalSessionBackend,
} from './terminal-session-backend'
import {
  getProjectCloseTransition,
  getRunningProjectProcessLabels,
  insertRestoredProject,
} from './project-close'

interface StoreState {
  // Project management
  projects: Project[]
  activeProjectId: string | null

  // Active project working state
  terminals: TerminalNode[]
  browsers: BrowserNode[]
  agentWindows: AgentWindowNode[]
  canvas: CanvasTransform
  initialized: boolean
  terminalTheme: string
  terminalSessionBackend: TerminalSessionBackend
  terminalSessionBackendExplicitlySet: boolean
  fontSize: number
  fontFamily: string
  terminalScrollbackLines: number
  terminalCursorStyle: TerminalCursorStyle
  terminalCursorBlink: boolean
  showTerminalHeaderOverlay: boolean
  windowOpacity: number
  useTransparentWindow: boolean
  titleBarPosition: TitleBarPosition
  dimWhenUnfocused: boolean
  hasSeenOnboardingGuide: boolean
  showOnboardingGuide: boolean
  terminalFindOpen: boolean
  terminalFindQuery: string
  terminalFindResultTermId: string | null
  terminalFindResultCount: number
  terminalFindActiveIndex: number
  terminalFindResultLimitHit: boolean
  focusedTerminalId: string | null
  focusedBrowserId: string | null
  focusedAgentWindowId: string | null
  focusHistory: string[] // stack of recently focused IDs (most recent last)
  focusCounts: Record<string, number> // per-window focus counts for usage ranking
  commandActionCounts: Record<string, number> // per-project catch-all action usage (search, agent-claude, agent-opencode, run, etc.)
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
  agentNotificationSettings: AgentNotificationSettings
  autoArrangeOnCreate: boolean
  overlayOpen: boolean // true when popover/dialog is open — hides browser native views
  searchEngine: string
  homePage: string
  terminalLinkTarget: 'system' | 'browser'
  terminalLinkProjectId: string | null
  linkRules: Array<{ pattern: string; target: 'system' | 'browser'; projectId?: string }>
  directoryLinkTarget: 'finder' | 'terminal'
  agentAliases: Record<string, string>
  agentPaths: Record<string, string>
  enabledAgents: Record<string, boolean | 'auto'>
  inputPrefixes: InputPrefix[]
  lastUsedAgent: string | null
  lastAgentSessionDefaults: Record<Extract<AgentName, 'claude' | 'codex'>, AgentSessionDefaults>
  lastCommandAction: 'search' | 'agent' | 'run' | null
  colorScheme: 'light' | 'dark' | 'system'
  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
  updateStatus: string // 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error'
  updateVersion: string | null
  closeUndoTimeoutMs: number
  closeProcessSuppressions: string[]
  pendingClosedWindows: PendingClosedWindow[]
  pendingCloseDialog: PendingCloseDialog | null
  pendingClosedProjects: PendingClosedProject[]
  pendingProjectCloseDialog: PendingProjectCloseDialog | null
  arrangeAnimating: boolean // true while auto-arrange is animating positions

  // When a link opens a browser in a different project, tracks the source so we can return
  crossProjectReturn: { browserId: string; sourceProjectId: string } | null

  // Timestamp when the currently focused terminal gained focus (runtime-only, not persisted)
  focusedTerminalSince: number

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
  requestCloseProject(id: string): Promise<void>
  cancelPendingProjectClose(): void
  confirmPendingProjectClose(): void
  restoreLastClosedProject(): void
  renameProject(id: string, name: string): void
  reorderProjects(ids: string[]): void
  setProjectTitleBarHidden(id: string, hidden: boolean): void
  getActiveProject(): Project | undefined
  getActiveProjectPath(): string | undefined

  setTerminalTheme(name: string): void
  setTerminalSessionBackend(backend: TerminalSessionBackend): void
  setFontSize(size: number): void
  setFontFamily(family: string): void
  setTerminalScrollbackLines(lines: number): void
  setTerminalCursorStyle(style: TerminalCursorStyle): void
  setTerminalCursorBlink(enabled: boolean): void
  setShowTerminalHeaderOverlay(enabled: boolean): void
  markTerminalExited(id: string, message?: string | null, restoredOutput?: string | null): void
  restartTerminalSession(id: string): void
  setWindowOpacity(opacity: number): void
  setUseTransparentWindow(enabled: boolean): void
  setTitleBarPosition(position: TitleBarPosition): void
  setDimWhenUnfocused(enabled: boolean): void
  openTerminalFind(): void
  closeTerminalFind(): void
  setTerminalFindQuery(query: string): void
  setTerminalFindResults(
    termId: string,
    resultCount: number,
    activeIndex: number,
    limitHit?: boolean,
  ): void

  addTerminal(): TerminalNode
  addTerminalWithCommand(command: string, title?: string): TerminalNode
  addTerminalInWorktree(
    command: string,
    title: string | undefined,
    worktreePath: string,
  ): TerminalNode
  updateTerminalAgent(id: string, agent: AgentName | null): void
  updateTerminalRuntimeStatus(id: string, status: TerminalRuntimeStatus | null): void
  clearTerminalRuntimeAttention(id: string): void
  updateTerminalAgentStatus(id: string, status: import('../types').AgentStatus): void
  updateTerminalProcessRunning(id: string, running: boolean): void
  removeAllTerminals(): void
  removeTerminal(id: string): void
  moveTerminal(id: string, x: number, y: number): void
  resizeTerminal(id: string, width: number, height: number): void
  updateTerminalTitle(id: string, title: string): void
  setCustomTitle(id: string, customTitle: string | null): void
  focusTerminal(id: string | null): void
  bringToFront(id: string): void
  togglePin(id: string, type?: 'terminal' | 'browser'): void
  togglePinFocused(): void
  panToTerminal(id: string): void
  panToBrowser(id: string): void
  addAgentWindow(
    agent: Extract<AgentName, 'claude' | 'codex'>,
    options?: {
      id?: string
      title?: string
      customTitle?: string | null
      cwd?: string | null
      initialPrompt?: string | null
      composerDraft?: string | null
      composerAttachments?: string[]
      claudeSessionId?: string | null
      codexThreadId?: string | null
      model?: string | null
      permissionMode?: import('../types').AgentPermissionMode | null
      thinkingLevel?: import('../types').AgentThinkingLevel | null
      contextLength?: import('../types').AgentContextLength | null
      createdAt?: number | null
    },
  ): AgentWindowNode
  removeAgentWindow(id: string): void
  moveAgentWindow(id: string, x: number, y: number): void
  moveCanvasNodes(
    updates: Array<{ id: string; kind: 'terminal' | 'browser' | 'agent'; x: number; y: number }>,
  ): void
  resizeAgentWindow(id: string, width: number, height: number): void
  focusAgentWindow(id: string | null): void
  bringAgentWindowToFront(id: string): void
  panToAgentWindow(id: string): void
  snapToAgentWindow(id: string, options?: { keepScale?: boolean }): void
  syncAgentWindow(id: string, patch: Partial<AgentWindowNode>): void
  snapToTerminal(id: string, options?: { keepScale?: boolean }): void
  zoomToFit(id: string): void
  zoomFocusedWindow(direction: 'in' | 'out'): void
  snapToNearest(
    direction: 'left' | 'right' | 'up' | 'down',
    options?: { keepScale?: boolean },
  ): void
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
  setAgentNotificationSettings(settings: Partial<AgentNotificationSettings>): void
  setAutoArrangeOnCreate(enabled: boolean): void

  setCanvasTransform(transform: CanvasTransform): void
  resizeWindowToFitFocused(): void
  resizeFocusedToFitViewport(): void
  zoomToFitAll(): void
  exitOverview(): void
  setOverlayOpen(open: boolean): void
  dismissOnboardingGuide(): void
  openOnboardingGuide(): void
  setSearchEngine(engine: string): void
  setHomePage(url: string): void
  setTerminalLinkTarget(target: 'system' | 'browser'): void
  setTerminalLinkProjectId(projectId: string | null): void
  setDirectoryLinkTarget(target: 'finder' | 'terminal'): void
  setLinkRules(
    rules: Array<{ pattern: string; target: 'system' | 'browser'; projectId?: string }>,
  ): void
  setAgentAliases(aliases: Record<string, string>): void
  setAgentPaths(paths: Record<string, string>): void
  setEnabledAgents(agents: Record<string, boolean | 'auto'>): void
  setInputPrefixes(prefixes: InputPrefix[]): void
  setLastUsedAgent(agent: string): void
  setLastAgentSessionDefaults(
    agent: Extract<AgentName, 'claude' | 'codex'>,
    patch: Partial<AgentSessionDefaults>,
  ): void
  setLastCommandAction(action: 'search' | 'agent' | 'run'): void
  trackCommandAction(key: string): void
  appDarkTheme: string
  appLightTheme: string
  setAppTheme(name: string): void
  setColorScheme(scheme: 'light' | 'dark' | 'system'): void
  setCloseUndoTimeoutMs(timeoutMs: number): void
  setCloseProcessSuppressions(processes: string[]): void
  requestCloseWindow(target?: CloseWindowTarget): Promise<void>
  cancelPendingClose(): void
  confirmPendingClose(skipFuturePrompts?: boolean): void
  restoreLastClosedWindow(): void
  autoArrangeGrid(skipOverview?: boolean): void
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
  snapToBrowser(id: string, options?: { keepScale?: boolean }): void
  moveBrowser(id: string, x: number, y: number): void
  resizeBrowser(id: string, width: number, height: number): void
  updateBrowserUrl(id: string, url: string): void
  updateBrowserTitle(id: string, title: string): void
  updateBrowserFavicon(id: string, faviconUrl: string): void
  updateBrowserHistory(
    id: string,
    history: { entries: Array<{ url: string; title: string }>; activeIndex: number } | undefined,
  ): void
  focusBrowser(id: string): void
  bringBrowserToFront(id: string): void
}

const TERMINAL_PAD = 8
const FOCUS_READ_DELAY_MS = 2000
const CANVAS_MIN_ZOOM = 0.15
const CANVAS_MAX_ZOOM = 1.5
const CANVAS_KEYBOARD_ZOOM_FACTOR = 1.2

// Timer for delayed runtime-attention clear on focus
let _runtimeAttentionClearTimer: ReturnType<typeof setTimeout> | null = null

// Pending commands to run after terminal attaches (not persisted)
const pendingCommands = new Map<string, string>()
// Pending worktree cwd overrides for terminal reattach
const pendingWorktreePaths = new Map<string, string>()
const TERMINAL_GAP = 60
const DEFAULT_CANVAS: CanvasTransform = { x: 0, y: 0, scale: 1 }
const DEFAULT_SEARCH_ENGINE = 'https://www.google.com/search?q=%s'
const DEFAULT_HOME_PAGE = ''
const DEFAULT_CLOSE_UNDO_TIMEOUT_MS = 15000
const PROJECT_CLOSE_GRACE_MS = 15000
const DEFAULT_INPUT_PREFIXES: InputPrefix[] = [{ prefix: '!', target: 'terminal' }]
const DEFAULT_TITLE_BAR_POSITION: TitleBarPosition = 'bottom'
const SAVE_STATUS_RESET_MS = 1800
const DEFAULT_AGENT_SESSION_DEFAULTS: Record<
  Extract<AgentName, 'claude' | 'codex'>,
  AgentSessionDefaults
> = {
  claude: {
    model: null,
    permissionMode: null,
    thinkingLevel: null,
    contextLength: null,
  },
  codex: {
    model: null,
    permissionMode: null,
    thinkingLevel: null,
    contextLength: null,
  },
}

function normalizeAgentSessionDefaults(
  value:
    | Partial<Record<Extract<AgentName, 'claude' | 'codex'>, AgentSessionDefaults>>
    | null
    | undefined,
): Record<Extract<AgentName, 'claude' | 'codex'>, AgentSessionDefaults> {
  return {
    claude: {
      ...DEFAULT_AGENT_SESSION_DEFAULTS.claude,
      ...(value?.claude ?? {}),
    },
    codex: {
      ...DEFAULT_AGENT_SESSION_DEFAULTS.codex,
      ...(value?.codex ?? {}),
    },
  }
}

/** Apply color scheme to the document and sync with system preferences. */
let systemThemeCleanup: (() => void) | null = null
function applyColorScheme(
  scheme: 'light' | 'dark' | 'system',
  options: { syncTerminalTheme?: boolean } = {},
) {
  // Clean up previous system listener
  if (systemThemeCleanup) {
    systemThemeCleanup()
    systemThemeCleanup = null
  }

  const apply = (persistSyncedTerminalTheme = false) => {
    const state = useStore.getState()
    const activeThemeKey = getActiveAppThemeKey({
      colorScheme: scheme,
      appDarkTheme: state.appDarkTheme,
      appLightTheme: state.appLightTheme,
    })
    const prefersDark = resolveAppColorScheme(scheme) === 'dark'

    document.documentElement.classList.toggle('dark', prefersDark)
    document.documentElement.classList.toggle('light', !prefersDark)
    document.documentElement.style.colorScheme = prefersDark ? 'dark' : 'light'

    for (const [key, value] of Object.entries(buildAppThemeVariables(activeThemeKey))) {
      document.documentElement.style.setProperty(key, value)
    }

    if (options.syncTerminalTheme && state.terminalTheme !== activeThemeKey) {
      useStore.setState({ terminalTheme: activeThemeKey })
      applyThemeToAllTerminals(activeThemeKey)
      if (persistSyncedTerminalTheme) {
        useStore.getState().persist()
      }
    }
  }

  apply()

  // Listen for system theme changes when in 'system' mode
  if (
    scheme === 'system' &&
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
  ) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => apply(options.syncTerminalTheme === true)
    mq.addEventListener('change', handler)
    systemThemeCleanup = () => mq.removeEventListener('change', handler)
  }
}

type CloseWindowTarget = { id: string; type: 'terminal' | 'browser' | 'agent' }

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
  agentWindow?: AgentWindowNode
  title: string
  closedAt: number
  expiresAt: number
  processLabel?: string | null
  processKey?: string | null
}

interface PendingProjectCloseDialog {
  projectId: string
  projectName: string
  windowCount: number
  runningProcessLabels: string[]
}

interface PendingClosedProject {
  id: string
  project: Project
  closedIndex: number
  closedAt: number
  expiresAt: number
  runningProcessLabels: string[]
}

const pendingCloseTimers = new Map<string, number>()
const pendingProjectCloseTimers = new Map<string, number>()

function clearPendingCloseTimer(id: string) {
  const timer = pendingCloseTimers.get(id)
  if (timer) {
    window.clearTimeout(timer)
    pendingCloseTimers.delete(id)
  }
}

function clearPendingProjectCloseTimer(id: string) {
  const timer = pendingProjectCloseTimers.get(id)
  if (timer) {
    window.clearTimeout(timer)
    pendingProjectCloseTimers.delete(id)
  }
}

function destroyTerminalResources(id: string) {
  destroyCachedTerminal(id)
  window.cells.terminal.detach(id).catch(() => {})
}

function destroyBrowserResources(id: string) {
  window.cells.browser.destroy(id).catch(() => {})
}

function destroyAgentWindowResources(id: string) {
  // Full teardown — the agent window is being removed from the project.
  window.cells.agentSession.dispose(id).catch(() => {})
}

function parkProjectBrowsers(project: Pick<Project, 'browsers'>) {
  for (const browser of project.browsers ?? []) {
    window.cells.browser.park(browser.id).catch(() => {})
  }
}

function destroyProjectResources(
  project: Pick<Project, 'terminals' | 'browsers' | 'agentWindows'>,
) {
  for (const terminal of project.terminals ?? []) {
    clearPendingCloseTimer(terminal.id)
    destroyTerminalResources(terminal.id)
  }
  for (const browser of project.browsers ?? []) {
    clearPendingCloseTimer(browser.id)
    destroyBrowserResources(browser.id)
  }
  for (const agentWindow of project.agentWindows ?? []) {
    clearPendingCloseTimer(agentWindow.id)
    destroyAgentWindowResources(agentWindow.id)
  }
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

function cloneRuntimeStatus(
  status: TerminalRuntimeStatus | null | undefined,
): TerminalRuntimeStatus | null {
  if (!status) return null
  return { ...status }
}

function stripTerminalRuntimeFields(terminal: TerminalNode) {
  const {
    runtimeStatus: _runtimeStatus,
    agentStatus: _agentStatus,
    processRunning: _processRunning,
    exited: _exited,
    exitStatusMessage: _exitStatusMessage,
    ...persisted
  } = terminal
  return persisted
}

function normalizeLegacyRuntimeStatus(terminal: TerminalNode): TerminalRuntimeStatus | null {
  const now = Date.now()
  if (terminal.runtimeStatus) {
    return {
      ...terminal.runtimeStatus,
      attention: terminal.runtimeStatus.attention === true,
    }
  }
  if (terminal.agentStatus === 'active') {
    return {
      kind: 'agent',
      agent: terminal.agent ?? null,
      state: 'working',
      detail: 'Working',
      shortLabel: 'Working',
      source: 'legacy',
      updatedAt: now,
      attention: true,
    }
  }
  if (terminal.agentStatus === 'unread') {
    return {
      kind: 'agent',
      agent: terminal.agent ?? null,
      state: 'waiting',
      detail: 'Waiting for input',
      shortLabel: 'Waiting',
      source: 'legacy',
      updatedAt: now,
      attention: true,
    }
  }
  if (terminal.agentStatus === 'done') {
    return {
      kind: 'agent',
      agent: terminal.agent ?? null,
      state: 'done',
      detail: 'Done',
      shortLabel: 'Done',
      source: 'legacy',
      updatedAt: now,
      attention: true,
    }
  }
  if (!terminal.agent && terminal.processRunning) {
    return {
      kind: 'process',
      detail: 'Running',
      shortLabel: 'Running',
      source: 'legacy',
      updatedAt: now,
      attention: false,
    }
  }
  return null
}

function normalizeTerminals(terminals: TerminalNode[]) {
  return terminals.map((terminal, index) => ({
    ...terminal,
    zIndex: typeof terminal.zIndex === 'number' ? terminal.zIndex : index + 1,
    runtimeStatus: normalizeLegacyRuntimeStatus(terminal),
    agentStatus: null,
    processRunning: false,
    exited: false,
    exitStatusMessage: null,
  }))
}

function mapTerminalsEverywhere(
  terminals: TerminalNode[],
  projects: Project[],
  id: string,
  updater: (terminal: TerminalNode) => TerminalNode,
) {
  return {
    terminals: terminals.map((terminal) => (terminal.id === id ? updater(terminal) : terminal)),
    projects: projects.map((project) => ({
      ...project,
      terminals: (project.terminals ?? []).map((terminal) =>
        terminal.id === id ? updater(terminal) : terminal,
      ),
    })),
  }
}

function mapAgentWindowsEverywhere(
  agentWindows: AgentWindowNode[],
  projects: Project[],
  id: string,
  updater: (agentWindow: AgentWindowNode) => AgentWindowNode,
) {
  return {
    agentWindows: agentWindows.map((agentWindow) =>
      agentWindow.id === id ? updater(agentWindow) : agentWindow,
    ),
    projects: projects.map((project) => ({
      ...project,
      agentWindows: (project.agentWindows ?? []).map((agentWindow) =>
        agentWindow.id === id ? updater(agentWindow) : agentWindow,
      ),
    })),
  }
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
  agentWindows: AgentWindowNode[] = [],
): string | null {
  const existingIds = new Set([
    ...terminals.map((terminal) => terminal.id),
    ...browsers.map((browser) => browser.id),
    ...agentWindows.map((agentWindow) => agentWindow.id),
  ])
  const previousFromHistory = [...history].reverse().find((id) => existingIds.has(id))
  if (previousFromHistory) return previousFromHistory

  const topWindow = [...terminals, ...browsers, ...agentWindows].reduce<
    TerminalNode | BrowserNode | AgentWindowNode | null
  >((currentTop, candidate) => {
    if (!currentTop) return candidate
    return (candidate.zIndex ?? 0) > (currentTop.zIndex ?? 0) ? candidate : currentTop
  }, null)

  return topWindow?.id ?? null
}

function getTopZIndex(
  terminals: TerminalNode[],
  browsers: BrowserNode[] = [],
  agentWindows: AgentWindowNode[] = [],
) {
  const termMax = terminals.reduce((max, t) => Math.max(max, t.zIndex ?? 0), 1)
  const browMax = browsers.reduce((max, b) => Math.max(max, b.zIndex ?? 0), 0)
  const agentMax = agentWindows.reduce(
    (max, agentWindow) => Math.max(max, agentWindow.zIndex ?? 0),
    0,
  )
  return Math.max(termMax, browMax, agentMax)
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
          agentWindows: state.agentWindows,
          canvas: state.canvas,
          focusedTerminalId: state.focusedTerminalId,
          focusedBrowserId: state.focusedBrowserId,
          focusedAgentWindowId: state.focusedAgentWindowId,
          focusCounts: state.focusCounts,
          commandActionCounts: state.commandActionCounts,
          autoArrangeOnCreate: state.autoArrangeOnCreate,
        }
      : p,
  )
}

/** Load a project's state into the working fields */
function projectToWorkingState(project: Project, preserveRuntime = false) {
  const terminals = preserveRuntime
    ? (project.terminals ?? []).map((terminal, index) => ({
        ...terminal,
        zIndex: typeof terminal.zIndex === 'number' ? terminal.zIndex : index + 1,
      }))
    : normalizeTerminals(project.terminals ?? [])
  const browsers = project.browsers ?? []
  const agentWindows = (project.agentWindows ?? []).map((agentWindow, index) => ({
    ...agentWindow,
    zIndex: typeof agentWindow.zIndex === 'number' ? agentWindow.zIndex : index + 1,
    status: agentWindow.status ?? 'idle',
    error: agentWindow.error ?? null,
    composerDraft: agentWindow.composerDraft ?? null,
    composerAttachments: agentWindow.composerAttachments ?? [],
  }))
  return {
    terminals,
    browsers,
    agentWindows,
    canvas: project.canvas ?? DEFAULT_CANVAS,
    topZIndex: getTopZIndex(terminals, browsers, agentWindows),
    focusedTerminalId: (project.focusedTerminalId ?? null) as string | null,
    focusedBrowserId: (project.focusedBrowserId ?? null) as string | null,
    focusedAgentWindowId: (project.focusedAgentWindowId ?? null) as string | null,
    focusHistory: [] as string[],
    focusCounts: (project.focusCounts ?? {}) as Record<string, number>,
    commandActionCounts: (project.commandActionCounts ?? {}) as Record<string, number>,
    autoArrangeOnCreate: project.autoArrangeOnCreate ?? false,
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
  agentWindows: [],
  canvas: DEFAULT_CANVAS,
  initialized: false,
  focusedTerminalId: null,
  focusedBrowserId: null,
  focusedAgentWindowId: null,
  focusHistory: [],
  focusCounts: {},
  commandActionCounts: {},
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
  agentNotificationSettings: DEFAULT_AGENT_NOTIFICATION_SETTINGS,
  autoArrangeOnCreate: false,
  overlayOpen: false,
  searchEngine: DEFAULT_SEARCH_ENGINE,
  homePage: DEFAULT_HOME_PAGE,
  terminalLinkTarget: 'system',
  terminalLinkProjectId: null,
  linkRules: [],
  directoryLinkTarget: 'finder',
  agentAliases: {},
  agentPaths: {},
  enabledAgents: {},
  inputPrefixes: DEFAULT_INPUT_PREFIXES,
  lastUsedAgent: null,
  lastAgentSessionDefaults: DEFAULT_AGENT_SESSION_DEFAULTS,
  lastCommandAction: null,
  appDarkTheme: DEFAULT_APP_DARK_THEME,
  appLightTheme: DEFAULT_APP_LIGHT_THEME,
  colorScheme: 'dark' as const,
  saveStatus: 'idle',
  updateStatus: 'idle',
  updateVersion: null,
  closeUndoTimeoutMs: DEFAULT_CLOSE_UNDO_TIMEOUT_MS,
  closeProcessSuppressions: [],
  pendingClosedWindows: [],
  pendingCloseDialog: null,
  pendingClosedProjects: [],
  pendingProjectCloseDialog: null,
  arrangeAnimating: false,
  crossProjectReturn: null,
  focusedTerminalSince: 0,
  worktrees: [],
  worktreesLoading: false,
  isGitRepo: false,
  terminalTheme: DEFAULT_THEME,
  terminalSessionBackend: DEFAULT_TERMINAL_SESSION_BACKEND,
  terminalSessionBackendExplicitlySet: false,
  fontSize: 13,
  fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  terminalScrollbackLines: DEFAULT_TERMINAL_SCROLLBACK_LINES,
  terminalCursorStyle: DEFAULT_TERMINAL_CURSOR_SETTINGS.terminalCursorStyle,
  terminalCursorBlink: DEFAULT_TERMINAL_CURSOR_SETTINGS.terminalCursorBlink,
  showTerminalHeaderOverlay: true,
  windowOpacity: DEFAULT_WINDOW_APPEARANCE.windowOpacity,
  useTransparentWindow: DEFAULT_WINDOW_APPEARANCE.useTransparentWindow,
  titleBarPosition: DEFAULT_TITLE_BAR_POSITION,
  dimWhenUnfocused: true,
  hasSeenOnboardingGuide: false,
  showOnboardingGuide: false,
  terminalFindOpen: false,
  terminalFindQuery: '',
  terminalFindResultTermId: null,
  terminalFindResultCount: 0,
  terminalFindActiveIndex: 0,
  terminalFindResultLimitHit: false,

  setTerminalTheme(name) {
    const normalizedName = terminalThemes[name] ? name : DEFAULT_THEME
    set({ terminalTheme: normalizedName })
    applyThemeToAllTerminals(normalizedName)
    get().persist()
  },
  setAppTheme(name) {
    const scheme = terminalThemes[name]?.scheme ?? 'dark'
    const normalizedName = normalizeAppThemeKey(name, scheme)

    if (scheme === 'dark') {
      set({
        appDarkTheme: normalizedName,
        colorScheme: 'dark',
        terminalTheme: normalizedName,
      })
      applyThemeToAllTerminals(normalizedName)
      applyColorScheme('dark')
    } else {
      set({
        appLightTheme: normalizedName,
        colorScheme: 'light',
        terminalTheme: normalizedName,
      })
      applyThemeToAllTerminals(normalizedName)
      applyColorScheme('light')
    }

    get().persist()
  },
  setTerminalSessionBackend(backend) {
    const next = normalizeTerminalSessionBackend(backend)
    const current = get()
    if (next === current.terminalSessionBackend && current.terminalSessionBackendExplicitlySet)
      return
    set({
      terminalSessionBackend: next,
      terminalSessionBackendExplicitlySet: true,
    })
    get().persist()
    if (next !== current.terminalSessionBackend) {
      showToast(`Terminal backend set to ${next}. Relaunch Cells to switch live sessions.`, 'info')
    }
  },
  setFontSize(size) {
    set({ fontSize: size })
    get().persist()
  },
  setFontFamily(family) {
    set({ fontFamily: normalizeTerminalFontFamily(family) })
    get().persist()
  },
  setTerminalScrollbackLines(lines) {
    const next = normalizeTerminalScrollbackLines(lines)
    if (next === get().terminalScrollbackLines) return
    set({ terminalScrollbackLines: next })
    reloadAllTerminals()
    showToast(`Terminal history limit set to ${next.toLocaleString()} lines`, 'info')
    get().persist()
  },
  setTerminalCursorStyle(style) {
    const next = normalizeTerminalCursorStyle(style)
    if (next === get().terminalCursorStyle) return
    set({ terminalCursorStyle: next })
    get().persist()
  },
  setTerminalCursorBlink(enabled) {
    if (enabled === get().terminalCursorBlink) return
    set({ terminalCursorBlink: enabled })
    get().persist()
  },
  setShowTerminalHeaderOverlay(enabled) {
    if (enabled === get().showTerminalHeaderOverlay) return
    set({ showTerminalHeaderOverlay: enabled })
    get().persist()
  },
  markTerminalExited(id, message, restoredOutput) {
    const snapshot = restoredOutput ?? getTerminalRestoreSnapshot(id)
    set((s) =>
      mapTerminalsEverywhere(s.terminals, s.projects, id, (terminal) => ({
        ...terminal,
        exited: true,
        exitStatusMessage: message ?? 'Process exited',
        restoredOutput: snapshot ?? terminal.restoredOutput,
      })),
    )
    debouncedPersist(() => get().persist())
  },
  restartTerminalSession(id) {
    const snapshot = getTerminalRestoreSnapshot(id)
    set((s) =>
      mapTerminalsEverywhere(s.terminals, s.projects, id, (terminal) => ({
        ...terminal,
        exited: false,
        exitStatusMessage: null,
        restoredOutput: snapshot ?? terminal.restoredOutput,
      })),
    )
    reloadTerminal(id)
    get().focusTerminal(id)
    debouncedPersist(() => get().persist())
  },
  setWindowOpacity(opacity) {
    set({
      windowOpacity: normalizeWindowAppearance({ windowOpacity: opacity }).windowOpacity,
    })
    get().persist()
  },
  setUseTransparentWindow(enabled) {
    set({ useTransparentWindow: enabled })
    showToast('Window transparency changes apply after restarting Cells', 'info')
    get().persist()
  },
  setTitleBarPosition(position) {
    if (position === get().titleBarPosition) return
    set({ titleBarPosition: position })
    get().persist()
  },
  setDimWhenUnfocused(enabled) {
    set({ dimWhenUnfocused: enabled })
    get().persist()
  },
  openTerminalFind() {
    if (!get().focusedTerminalId) return
    set({ terminalFindOpen: true })
  },
  closeTerminalFind() {
    set({
      terminalFindOpen: false,
      terminalFindQuery: '',
      terminalFindResultTermId: null,
      terminalFindResultCount: 0,
      terminalFindActiveIndex: 0,
      terminalFindResultLimitHit: false,
    })
  },
  setTerminalFindQuery(query) {
    set({
      terminalFindOpen: true,
      terminalFindQuery: query,
      terminalFindResultTermId: null,
      terminalFindResultCount: 0,
      terminalFindActiveIndex: 0,
      terminalFindResultLimitHit: false,
    })
  },
  setTerminalFindResults(termId, resultCount, activeIndex, limitHit = false) {
    set({
      terminalFindResultTermId: termId,
      terminalFindResultCount: resultCount,
      terminalFindActiveIndex: activeIndex,
      terminalFindResultLimitHit: limitHit,
    })
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

      window.cells.app.onWindowResized((id, type, width, height) => {
        if (type === 'terminal') {
          set((s) => ({
            terminals: s.terminals.map((t) =>
              t.id === id
                ? { ...t, width: Math.max(320, width), height: Math.max(200, height) }
                : t,
            ),
          }))
        } else {
          set((s) => ({
            browsers: s.browsers.map((b) =>
              b.id === id
                ? { ...b, width: Math.max(320, width), height: Math.max(200, height) }
                : b,
            ),
          }))
        }
        debouncedPersist(() => get().persist())
      })
    }

    window.cells.terminal.onExit((termId, details) => {
      const state = get()
      const exists =
        state.terminals.some((terminal) => terminal.id === termId) ||
        state.projects.some((project) =>
          (project.terminals ?? []).some((terminal) => terminal.id === termId),
        )
      if (!exists) return
      state.markTerminalExited(termId, formatTerminalExitMessage(details), details?.history ?? null)
    })

    window.cells.terminal.onStatus((termId, status) => {
      const state = get()
      const exists =
        state.terminals.some((terminal) => terminal.id === termId) ||
        state.projects.some((project) =>
          (project.terminals ?? []).some((terminal) => terminal.id === termId),
        )
      if (!exists) return
      state.updateTerminalRuntimeStatus(termId, status)
    })

    const hydrateRuntimeStatuses = (projects: Project[]) => {
      const termIds = [
        ...new Set(projects.flatMap((project) => project.terminals.map((t) => t.id))),
      ]
      for (const termId of termIds) {
        window.cells.terminal
          .getStatus(termId)
          .then((status) => {
            const latest = get()
            const stillExists =
              latest.terminals.some((terminal) => terminal.id === termId) ||
              latest.projects.some((project) =>
                (project.terminals ?? []).some((terminal) => terminal.id === termId),
              )
            if (!stillExists) return
            latest.updateTerminalRuntimeStatus(termId, status)
          })
          .catch(() => {})
      }
    }

    const saved = await window.cells.state.load()

    if (
      saved &&
      typeof (saved as any).version === 'number' &&
      (saved as any).version >= 2 &&
      Array.isArray((saved as any).projects)
    ) {
      const ps = saved as ProjectsState
      // Migrate old global autoArrangeOnCreate into per-project field
      let didStripLegacyProjectSettings = false
      const projects = (ps.projects ?? []).map((p) => {
        const legacyProject = p as Project & {
          fontFamily?: string
          fontSize?: number
          terminalTheme?: string
        }
        const {
          fontFamily: _legacyFontFamily,
          fontSize: _legacyFontSize,
          terminalTheme: _legacyTheme,
          ...rest
        } = legacyProject
        if (
          _legacyFontFamily !== undefined ||
          _legacyFontSize !== undefined ||
          _legacyTheme !== undefined
        ) {
          didStripLegacyProjectSettings = true
        }
        return rest.autoArrangeOnCreate == null && ps.autoArrangeOnCreate != null
          ? { ...rest, autoArrangeOnCreate: ps.autoArrangeOnCreate }
          : rest
      })
      const projectLinkSettings = sanitizeProjectLinkSettings(
        projects,
        ps.terminalLinkProjectId,
        ps.linkRules ?? [],
      )
      const terminalSessionBackendExplicitlySet = ps.terminalSessionBackendExplicitlySet === true
      const terminalSessionBackend = terminalSessionBackendExplicitlySet
        ? normalizeTerminalSessionBackend(ps.terminalSessionBackend)
        : DEFAULT_TERMINAL_SESSION_BACKEND

      const normalizedFontFamily = normalizeTerminalFontFamily(ps.fontFamily)
      const globalSettings = {
        appDarkTheme: normalizeAppThemeKey(ps.appDarkTheme, 'dark'),
        appLightTheme: normalizeAppThemeKey(ps.appLightTheme, 'light'),
        terminalSessionBackend,
        terminalSessionBackendExplicitlySet,
        terminalTheme: terminalThemes[ps.terminalTheme ?? ''] ? ps.terminalTheme! : DEFAULT_THEME,
        fontSize: ps.fontSize || 13,
        fontFamily: normalizedFontFamily,
        terminalScrollbackLines: normalizeTerminalScrollbackLines(ps.terminalScrollbackLines),
        ...normalizeTerminalCursorSettings({
          terminalCursorStyle: ps.terminalCursorStyle,
          terminalCursorBlink: ps.terminalCursorBlink,
        }),
        showTerminalHeaderOverlay: ps.showTerminalHeaderOverlay ?? true,
        ...normalizeWindowAppearance({
          windowOpacity: ps.windowOpacity,
          useTransparentWindow: ps.useTransparentWindow,
        }),
        titleBarPosition: ps.titleBarPosition ?? DEFAULT_TITLE_BAR_POSITION,
        snapOnFocus: ps.snapOnFocus ?? true,
        tabSwitchMode: ps.tabSwitchMode || 'chronological',
        projectSwitchMode: ps.projectSwitchMode || 'recent',
        reducedMotion: ps.reducedMotion ?? false,
        autoUpdate: ps.autoUpdate ?? true,
        agentNotificationSettings: normalizeAgentNotificationSettings(ps.agentNotificationSettings),
        searchEngine: ps.searchEngine || DEFAULT_SEARCH_ENGINE,
        homePage: ps.homePage || DEFAULT_HOME_PAGE,
        terminalLinkTarget: ps.terminalLinkTarget || 'system',
        terminalLinkProjectId: projectLinkSettings.terminalLinkProjectId,
        linkRules: projectLinkSettings.linkRules,
        directoryLinkTarget: (ps.directoryLinkTarget === 'terminal' ? 'terminal' : 'finder') as
          | 'finder'
          | 'terminal',
        agentAliases: ps.agentAliases ?? {},
        agentPaths: ps.agentPaths ?? {},
        enabledAgents: ps.enabledAgents ?? {},
        inputPrefixes: ps.inputPrefixes ?? DEFAULT_INPUT_PREFIXES,
        lastAgentSessionDefaults: normalizeAgentSessionDefaults(ps.lastAgentSessionDefaults),
        colorScheme: ps.colorScheme || 'dark',
        closeUndoTimeoutMs: Math.max(0, ps.closeUndoTimeoutMs ?? DEFAULT_CLOSE_UNDO_TIMEOUT_MS),
        closeProcessSuppressions: ps.closeProcessSuppressions ?? [],
        dimWhenUnfocused: ps.dimWhenUnfocused ?? true,
        hasSeenOnboardingGuide: ps.hasSeenOnboardingGuide ?? false,
      }

      if (Object.keys(globalSettings.agentPaths).length > 0) {
        void window.cells.agent.setCustomPaths(globalSettings.agentPaths)
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
      setTimeout(() => {
        hydrateRuntimeStatuses(projects)
      }, 0)
      applyColorScheme(globalSettings.colorScheme)
      if (
        didStripLegacyProjectSettings ||
        normalizedFontFamily !== (ps.fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY)
      ) {
        setTimeout(() => {
          get().persist()
        }, 0)
      }
      setTimeout(() => {
        void get().refreshWorktrees()
      }, 0)
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
        agentWindows: [],
        canvas,
        lastOpenedAt: Date.now(),
      }

      set({
        projects: [project],
        activeProjectId: project.id,
        ...projectToWorkingState(project),
        appDarkTheme: DEFAULT_APP_DARK_THEME,
        appLightTheme: DEFAULT_APP_LIGHT_THEME,
        terminalSessionBackend: DEFAULT_TERMINAL_SESSION_BACKEND,
        terminalSessionBackendExplicitlySet: false,
        terminalTheme: terminalThemes[(saved as any).terminalTheme ?? '']
          ? (saved as any).terminalTheme
          : DEFAULT_THEME,
        fontSize: (saved as any).fontSize || 13,
        fontFamily: normalizeTerminalFontFamily((saved as any).fontFamily),
        terminalScrollbackLines: normalizeTerminalScrollbackLines(
          (saved as any).terminalScrollbackLines,
        ),
        ...normalizeTerminalCursorSettings({
          terminalCursorStyle: (saved as any).terminalCursorStyle,
          terminalCursorBlink: (saved as any).terminalCursorBlink,
        }),
        ...normalizeWindowAppearance({
          windowOpacity: (saved as any).windowOpacity,
          useTransparentWindow: (saved as any).useTransparentWindow,
        }),
        titleBarPosition: (saved as any).titleBarPosition ?? DEFAULT_TITLE_BAR_POSITION,
        agentNotificationSettings: DEFAULT_AGENT_NOTIFICATION_SETTINGS,
        initialized: true,
      })
      setTimeout(() => {
        hydrateRuntimeStatuses([project])
      }, 0)
      applyColorScheme(get().colorScheme)
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
        } else {
          set({ projects })
        }

        const freshState = get()
        const persistedProjects = projects.map((project) => ({
          ...project,
          terminals: (project.terminals ?? []).map(stripTerminalRuntimeFields),
        }))
        return saveState({
          version: 4,
          activeProjectId: freshState.activeProjectId,
          projects: persistedProjects,
          appDarkTheme: freshState.appDarkTheme,
          appLightTheme: freshState.appLightTheme,
          terminalSessionBackend: freshState.terminalSessionBackend,
          terminalSessionBackendExplicitlySet: freshState.terminalSessionBackendExplicitlySet,
          terminalTheme: freshState.terminalTheme,
          fontSize: freshState.fontSize,
          fontFamily: freshState.fontFamily,
          terminalScrollbackLines: freshState.terminalScrollbackLines,
          terminalCursorStyle: freshState.terminalCursorStyle,
          terminalCursorBlink: freshState.terminalCursorBlink,
          showTerminalHeaderOverlay: freshState.showTerminalHeaderOverlay,
          windowOpacity: freshState.windowOpacity,
          useTransparentWindow: freshState.useTransparentWindow,
          titleBarPosition: freshState.titleBarPosition,
          snapOnFocus: freshState.snapOnFocus,
          tabSwitchMode: freshState.tabSwitchMode,
          projectSwitchMode: freshState.projectSwitchMode,
          reducedMotion: freshState.reducedMotion,
          autoUpdate: freshState.autoUpdate,
          agentNotificationSettings: freshState.agentNotificationSettings,
          searchEngine: freshState.searchEngine,
          homePage: freshState.homePage,
          terminalLinkTarget: freshState.terminalLinkTarget,
          terminalLinkProjectId: freshState.terminalLinkProjectId,
          linkRules: freshState.linkRules,
          directoryLinkTarget: freshState.directoryLinkTarget,
          agentAliases: freshState.agentAliases,
          agentPaths: freshState.agentPaths,
          enabledAgents: freshState.enabledAgents,
          inputPrefixes: freshState.inputPrefixes,
          lastAgentSessionDefaults: freshState.lastAgentSessionDefaults,
          colorScheme: freshState.colorScheme,
          closeUndoTimeoutMs: freshState.closeUndoTimeoutMs,
          closeProcessSuppressions: freshState.closeProcessSuppressions,
          dimWhenUnfocused: freshState.dimWhenUnfocused,
          hasSeenOnboardingGuide: freshState.hasSeenOnboardingGuide,
        })
      })
      .catch(() => {
        // Fallback: save without history
        const state = get()
        const projects = snapshotActiveProject(state)
        set({ projects })
        const persistedProjects = projects.map((project) => ({
          ...project,
          terminals: (project.terminals ?? []).map(stripTerminalRuntimeFields),
        }))
        return saveState({
          version: 4,
          activeProjectId: state.activeProjectId,
          projects: persistedProjects,
          appDarkTheme: state.appDarkTheme,
          appLightTheme: state.appLightTheme,
          terminalSessionBackend: state.terminalSessionBackend,
          terminalSessionBackendExplicitlySet: state.terminalSessionBackendExplicitlySet,
          terminalTheme: state.terminalTheme,
          fontSize: state.fontSize,
          fontFamily: state.fontFamily,
          terminalScrollbackLines: state.terminalScrollbackLines,
          terminalCursorStyle: state.terminalCursorStyle,
          terminalCursorBlink: state.terminalCursorBlink,
          showTerminalHeaderOverlay: state.showTerminalHeaderOverlay,
          windowOpacity: state.windowOpacity,
          useTransparentWindow: state.useTransparentWindow,
          titleBarPosition: state.titleBarPosition,
          snapOnFocus: state.snapOnFocus,
          tabSwitchMode: state.tabSwitchMode,
          projectSwitchMode: state.projectSwitchMode,
          reducedMotion: state.reducedMotion,
          autoUpdate: state.autoUpdate,
          agentNotificationSettings: state.agentNotificationSettings,
          searchEngine: state.searchEngine,
          homePage: state.homePage,
          terminalLinkTarget: state.terminalLinkTarget,
          terminalLinkProjectId: state.terminalLinkProjectId,
          linkRules: state.linkRules,
          directoryLinkTarget: state.directoryLinkTarget,
          agentAliases: state.agentAliases,
          agentPaths: state.agentPaths,
          enabledAgents: state.enabledAgents,
          inputPrefixes: state.inputPrefixes,
          lastAgentSessionDefaults: state.lastAgentSessionDefaults,
          colorScheme: state.colorScheme,
          closeUndoTimeoutMs: state.closeUndoTimeoutMs,
          closeProcessSuppressions: state.closeProcessSuppressions,
          dimWhenUnfocused: state.dimWhenUnfocused,
          hasSeenOnboardingGuide: state.hasSeenOnboardingGuide,
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
      hiddenFromTitleBar: false,
      terminals: [],
      browsers: [],
      agentWindows: [],
      canvas: DEFAULT_CANVAS,
      lastOpenedAt: Date.now(),
    }

    set({
      projects: [...projects, project],
      activeProjectId: id,
      ...projectToWorkingState(project),
    })
    get().persist()

    // Auto-trigger disabled due to infinite loop issue
    // if (isFirstProject) {
    //   setTimeout(() => get().openOnboardingGuide(), 400)
    // }

    setTimeout(() => {
      void get().refreshWorktrees()
    }, 0)
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

    const workingState = projectToWorkingState(target, true)
    set({
      projects: updated,
      activeProjectId: id,
      ...workingState,
      crossProjectReturn: null,
    })
    get().persist()
    setTimeout(() => {
      void get().refreshWorktrees()
    }, 0)

    // Saved canvas transforms can drift — e.g. a window added since last
    // switch, or a viewport resize — leaving the restored view framing
    // nothing. Recenter onto the focused window (or nearest window) so
    // the project always opens on actual content.
    const after = get()
    if (after.focusedTerminalId) {
      after.snapToTerminal(after.focusedTerminalId)
    } else if (after.focusedBrowserId) {
      after.snapToBrowser(after.focusedBrowserId)
    } else if (after.focusedAgentWindowId) {
      after.snapToAgentWindow(after.focusedAgentWindowId)
    } else if (after.terminals.length + after.browsers.length + after.agentWindows.length > 0) {
      after.snapToClosest()
    }

    // Do not recreate the focused terminal on project switch.
    // The renderer cache is the only thing preserving fullscreen / alternate-
    // screen state across switches; forcing a reload destroys that state.
  },

  async requestCloseProject(id) {
    const state = get()
    const projects = snapshotActiveProject(state)
    const project = projects.find((candidate) => candidate.id === id)
    if (!project) return

    const processInfos = await Promise.all(
      (project.terminals ?? []).map((terminal) =>
        window.cells.terminal.getProcessInfo(terminal.id).catch(() => null),
      ),
    )

    const latest = get()
    const latestProjects = snapshotActiveProject(latest)
    const latestProject = latestProjects.find((candidate) => candidate.id === id)
    if (!latestProject) return

    set({
      pendingProjectCloseDialog: {
        projectId: id,
        projectName: latestProject.name,
        windowCount:
          (latestProject.terminals?.length ?? 0) +
          (latestProject.browsers?.length ?? 0) +
          (latestProject.agentWindows?.length ?? 0),
        runningProcessLabels: getRunningProjectProcessLabels(processInfos),
      },
    })
  },

  cancelPendingProjectClose() {
    set({ pendingProjectCloseDialog: null })
  },

  confirmPendingProjectClose() {
    const dialog = get().pendingProjectCloseDialog
    if (!dialog) return

    const state = get()
    const projects = snapshotActiveProject(state)
    const project = projects.find((candidate) => candidate.id === dialog.projectId)
    if (!project) {
      set({ pendingProjectCloseDialog: null })
      return
    }

    const closedAt = Date.now()
    const expiresAt = closedAt + PROJECT_CLOSE_GRACE_MS
    const closedIndex = projects.findIndex((candidate) => candidate.id === project.id)
    const transition = getProjectCloseTransition(projects, state.activeProjectId, project.id)
    const projectLinkSettings = sanitizeProjectLinkSettings(
      transition.remainingProjects,
      state.terminalLinkProjectId === project.id ? null : state.terminalLinkProjectId,
      state.linkRules,
    )

    parkProjectBrowsers(project)

    const pendingClosedWindows = state.pendingClosedWindows.filter((entry) => {
      if (entry.projectId !== project.id) return true
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
    const closingBrowserIds = new Set((project.browsers ?? []).map((browser) => browser.id))
    const crossProjectReturn =
      state.crossProjectReturn &&
      (state.crossProjectReturn.sourceProjectId === project.id ||
        closingBrowserIds.has(state.crossProjectReturn.browserId))
        ? null
        : state.crossProjectReturn

    const pendingEntry: PendingClosedProject = {
      id: project.id,
      project,
      closedIndex,
      closedAt,
      expiresAt,
      runningProcessLabels: dialog.runningProcessLabels,
    }

    clearPendingProjectCloseTimer(project.id)
    pendingProjectCloseTimers.set(
      project.id,
      window.setTimeout(() => {
        const latestState = useStore.getState()
        const closingProject = latestState.pendingClosedProjects.find(
          (entry) => entry.id === project.id,
        )
        if (!closingProject) return
        destroyProjectResources(closingProject.project)
        useStore.setState({
          pendingClosedProjects: latestState.pendingClosedProjects.filter(
            (entry) => entry.id !== project.id,
          ),
        })
        useStore.getState().persist()
      }, PROJECT_CLOSE_GRACE_MS),
    )

    const pendingClosedProjects = [
      ...state.pendingClosedProjects.filter((entry) => entry.id !== project.id),
      pendingEntry,
    ].sort((a, b) => b.closedAt - a.closedAt)
    const closeMessage =
      dialog.runningProcessLabels.length > 0
        ? `Closing ${project.name}. Running services stop in 15s.`
        : `Closing ${project.name}. You can undo it for 15s.`

    if (transition.nextActiveProjectId) {
      const nextProject = transition.remainingProjects.find(
        (candidate) => candidate.id === transition.nextActiveProjectId,
      )
      if (!nextProject) return
      set({
        projects: transition.remainingProjects,
        activeProjectId: nextProject.id,
        terminalLinkProjectId: projectLinkSettings.terminalLinkProjectId,
        linkRules: projectLinkSettings.linkRules,
        pendingClosedWindows,
        pendingCloseDialog,
        pendingClosedProjects,
        pendingProjectCloseDialog: null,
        crossProjectReturn,
        ...projectToWorkingState(nextProject, true),
      })
      get().persist()
      showToast(closeMessage, 'info')
      setTimeout(() => {
        void get().refreshWorktrees()
      }, 0)
      return
    }

    set({
      projects: transition.remainingProjects,
      activeProjectId: null,
      terminals: [],
      browsers: [],
      agentWindows: [],
      canvas: DEFAULT_CANVAS,
      focusedTerminalId: null,
      focusedBrowserId: null,
      focusedAgentWindowId: null,
      topZIndex: 1,
      terminalLinkProjectId: projectLinkSettings.terminalLinkProjectId,
      linkRules: projectLinkSettings.linkRules,
      pendingClosedWindows,
      pendingCloseDialog,
      pendingClosedProjects,
      pendingProjectCloseDialog: null,
      crossProjectReturn,
      worktrees: [],
      isGitRepo: false,
      worktreesLoading: false,
    })
    get().persist()
    showToast(closeMessage, 'info')
  },

  restoreLastClosedProject() {
    const state = get()
    const entry = state.pendingClosedProjects[0]
    if (!entry) return

    clearPendingProjectCloseTimer(entry.id)

    const projects = insertRestoredProject(
      snapshotActiveProject(state),
      entry.project,
      entry.closedIndex,
    )
    set({
      projects,
      activeProjectId: entry.project.id,
      pendingClosedProjects: state.pendingClosedProjects.filter(
        (candidate) => candidate.id !== entry.id,
      ),
      pendingProjectCloseDialog:
        state.pendingProjectCloseDialog?.projectId === entry.id
          ? null
          : state.pendingProjectCloseDialog,
      ...projectToWorkingState(entry.project, true),
    })
    get().persist()
    showToast(`Restored ${entry.project.name}.`, 'info')
    setTimeout(() => {
      void get().refreshWorktrees()
    }, 0)
  },

  removeProject(id) {
    const state = get()
    const projects = snapshotActiveProject(state)
    const transition = getProjectCloseTransition(projects, state.activeProjectId, id)
    const projectLinkSettings = sanitizeProjectLinkSettings(
      transition.remainingProjects,
      state.terminalLinkProjectId === id ? null : state.terminalLinkProjectId,
      state.linkRules,
    )

    // Kill PTYs and browser views for the removed project
    const removedProject =
      id === state.activeProjectId
        ? { terminals: state.terminals, browsers: state.browsers }
        : projects.find((p) => p.id === id)
    if (removedProject) {
      destroyProjectResources(removedProject)
    }

    clearPendingProjectCloseTimer(id)

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
    const pendingClosedProjects = state.pendingClosedProjects.filter((entry) => entry.id !== id)
    const pendingProjectCloseDialog =
      state.pendingProjectCloseDialog?.projectId === id ? null : state.pendingProjectCloseDialog
    const closingBrowserIds = new Set((removedProject?.browsers ?? []).map((browser) => browser.id))
    const crossProjectReturn =
      state.crossProjectReturn &&
      (state.crossProjectReturn.sourceProjectId === id ||
        closingBrowserIds.has(state.crossProjectReturn.browserId))
        ? null
        : state.crossProjectReturn

    if (id === state.activeProjectId) {
      if (transition.remainingProjects.length > 0) {
        const next = transition.remainingProjects.find(
          (project) => project.id === transition.nextActiveProjectId,
        )
        if (!next) return
        set({
          projects: transition.remainingProjects,
          activeProjectId: next.id,
          terminalLinkProjectId: projectLinkSettings.terminalLinkProjectId,
          linkRules: projectLinkSettings.linkRules,
          pendingClosedWindows,
          pendingCloseDialog,
          pendingClosedProjects,
          pendingProjectCloseDialog,
          crossProjectReturn,
          ...projectToWorkingState(next, true),
        })
      } else {
        set({
          projects: [],
          activeProjectId: null,
          terminals: [],
          browsers: [],
          agentWindows: [],
          canvas: DEFAULT_CANVAS,
          focusedTerminalId: null,
          focusedBrowserId: null,
          focusedAgentWindowId: null,
          topZIndex: 1,
          terminalLinkProjectId: projectLinkSettings.terminalLinkProjectId,
          linkRules: projectLinkSettings.linkRules,
          pendingClosedWindows,
          pendingCloseDialog,
          pendingClosedProjects,
          pendingProjectCloseDialog,
          crossProjectReturn,
          worktrees: [],
          isGitRepo: false,
          worktreesLoading: false,
        })
      }
    } else {
      set({
        projects: transition.remainingProjects,
        terminalLinkProjectId: projectLinkSettings.terminalLinkProjectId,
        linkRules: projectLinkSettings.linkRules,
        pendingClosedWindows,
        pendingCloseDialog,
        pendingClosedProjects,
        pendingProjectCloseDialog,
        crossProjectReturn,
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

  setProjectTitleBarHidden(id, hidden) {
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, hiddenFromTitleBar: hidden } : project,
      ),
    }))
    get().persist()
  },

  addTerminal() {
    const id = nanoid(8)
    const newZ = get().topZIndex + 1
    const { terminals, browsers, agentWindows, focusHistory } = get()

    // Size: fill the viewport minus padding and status bar
    const width = window.innerWidth - TERMINAL_PAD * 2
    const height = window.innerHeight - STATUS_BAR_HEIGHT - TERMINAL_PAD * 2

    // Place to the right of the rightmost *any* window, or at origin.
    let x = TERMINAL_PAD
    const y = TERMINAL_PAD
    const rightEdges = [
      ...terminals.map((t) => t.x + t.width),
      ...browsers.map((b) => b.x + b.width),
      ...agentWindows.map((a) => a.x + a.width),
    ]
    if (rightEdges.length > 0) {
      x = Math.max(...rightEdges) + TERMINAL_GAP
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
      focusedAgentWindowId: null,
      focusHistory: pushFocusHistory(focusHistory, id),
    }))
    if (get().autoArrangeOnCreate) {
      get().autoArrangeGrid(true)
      // Stay focused on the new terminal — no overview zoom
      set({
        focusedTerminalId: id,
        focusedBrowserId: null,
        focusedAgentWindowId: null,
        canvas: { ...get().canvas, scale: 1 },
      })
      get().snapToTerminal(id)
    } else {
      // Reset scale to 1 and snap to the new terminal
      set({ canvas: { ...get().canvas, scale: 1 } })
      get().snapToTerminal(id)
    }
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
    set((s) =>
      mapTerminalsEverywhere(s.terminals, s.projects, id, (terminal) => ({ ...terminal, agent })),
    )
  },

  updateTerminalRuntimeStatus(id, status) {
    const state = get()
    const current = state.terminals.find((terminal) => terminal.id === id)
    if (!current) return

    const nextStatus = cloneRuntimeStatus(status)
    const previous = current.runtimeStatus ?? null
    const focused = state.focusedTerminalId === id
    const sameRuntime =
      previous?.kind === nextStatus?.kind &&
      previous?.agent === nextStatus?.agent &&
      previous?.state === nextStatus?.state &&
      previous?.detail === nextStatus?.detail &&
      previous?.shortLabel === nextStatus?.shortLabel &&
      previous?.source === nextStatus?.source &&
      (previous?.pid ?? null) === (nextStatus?.pid ?? null) &&
      (previous?.processLabel ?? null) === (nextStatus?.processLabel ?? null)

    if (sameRuntime && (previous?.attention === true) === (nextStatus?.attention === true)) {
      return
    }

    let mergedStatus = nextStatus
    if (mergedStatus) {
      const shouldGainAttention =
        !focused &&
        mergedStatus.kind === 'agent' &&
        (mergedStatus.state === 'approval' ||
          mergedStatus.state === 'error' ||
          mergedStatus.state === 'waiting' ||
          mergedStatus.state === 'done')
      mergedStatus = {
        ...mergedStatus,
        attention: focused ? false : previous?.attention === true || shouldGainAttention,
      }
    }

    const updater = (terminal: TerminalNode) => ({
      ...terminal,
      runtimeStatus: mergedStatus,
      agent:
        mergedStatus?.kind === 'agent'
          ? (mergedStatus.agent ?? terminal.agent ?? null)
          : mergedStatus
            ? terminal.agent
            : null,
      agentStatus: null as TerminalNode['agentStatus'],
      processRunning: false,
    })

    // Only map the active terminals array for runtime status changes.
    // Skip the expensive projects-wide mapping — project terminals get
    // their status synced on persist/snapshot instead.
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? updater(t) : t)),
    }))
  },

  clearTerminalRuntimeAttention(id) {
    const current = get().terminals.find((terminal) => terminal.id === id)
    if (!current?.runtimeStatus?.attention) return
    set((s) =>
      mapTerminalsEverywhere(s.terminals, s.projects, id, (terminal) => ({
        ...terminal,
        runtimeStatus: terminal.runtimeStatus
          ? { ...terminal.runtimeStatus, attention: false }
          : null,
      })),
    )
  },

  updateTerminalAgentStatus(id, status) {
    const current = get().terminals.find((terminal) => terminal.id === id)
    if (!current) return

    if (status === 'active') {
      get().updateTerminalRuntimeStatus(id, {
        kind: 'agent',
        agent: current.agent ?? null,
        state: 'working',
        detail: 'Working',
        shortLabel: 'Working',
        source: 'legacy',
        updatedAt: Date.now(),
      })
      return
    }
    if (status === 'unread') {
      get().updateTerminalRuntimeStatus(id, {
        kind: 'agent',
        agent: current.agent ?? null,
        state: 'waiting',
        detail: 'Waiting for input',
        shortLabel: 'Waiting',
        source: 'legacy',
        updatedAt: Date.now(),
        attention: true,
      })
      return
    }
    if (status === 'done') {
      get().updateTerminalRuntimeStatus(id, {
        kind: 'agent',
        agent: current.agent ?? null,
        state: 'done',
        detail: 'Done',
        shortLabel: 'Done',
        source: 'legacy',
        updatedAt: Date.now(),
      })
      return
    }
    get().updateTerminalRuntimeStatus(id, null)
  },

  updateTerminalProcessRunning(id, running) {
    const current = get().terminals.find((terminal) => terminal.id === id)
    if (!current) return
    if (running) {
      get().updateTerminalRuntimeStatus(id, {
        kind: 'process',
        detail: 'Running',
        shortLabel: 'Running',
        source: 'legacy',
        updatedAt: Date.now(),
      })
      return
    }
    if (current.runtimeStatus?.kind === 'process') {
      get().updateTerminalRuntimeStatus(id, null)
    }
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
      const previousId = getPreviousWindowId(history, remaining, state.browsers, state.agentWindows)
      if (previousId) {
        if (remaining.some((terminal) => terminal.id === previousId)) {
          const nextHistory = pushFocusHistory(history, previousId)
          get().bringToFront(previousId)
          set({
            focusedTerminalId: previousId,
            focusedBrowserId: null,
            focusedAgentWindowId: null,
            focusHistory: nextHistory,
          })
          get().panToTerminal(previousId)
        } else if (state.agentWindows.some((agentWindow) => agentWindow.id === previousId)) {
          const nextHistory = pushFocusHistory(history, previousId)
          get().bringAgentWindowToFront(previousId)
          set({
            focusedTerminalId: null,
            focusedBrowserId: null,
            focusedAgentWindowId: previousId,
            focusHistory: nextHistory,
          })
          get().panToAgentWindow(previousId)
        } else {
          const nextHistory = pushFocusHistory(history, previousId)
          get().bringBrowserToFront(previousId)
          set({
            focusedTerminalId: null,
            focusedBrowserId: previousId,
            focusedAgentWindowId: null,
            focusHistory: nextHistory,
          })
          get().panToBrowser(previousId)
        }
      } else {
        set({ focusedBrowserId: null, focusedAgentWindowId: null })
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

    // Cancel any pending delayed attention clear from a previous focus
    if (_runtimeAttentionClearTimer) {
      clearTimeout(_runtimeAttentionClearTimer)
      _runtimeAttentionClearTimer = null
    }

    if (id && id !== prev) {
      // When snapOnFocus is enabled, skip the separate bringToFront + set
      // and let snapToTerminal handle everything in a single set() call.
      if (get().snapOnFocus) {
        get().snapToTerminal(id)
      } else {
        get().bringToFront(id)
        const history = pushFocusHistory(get().focusHistory, id)
        const counts = { ...get().focusCounts, [id]: (get().focusCounts[id] ?? 0) + 1 }
        set({
          focusedTerminalId: id,
          focusedBrowserId: null,
          focusedAgentWindowId: null,
          focusHistory: history,
          focusCounts: counts,
          focusedTerminalSince: Date.now(),
        })
      }
    } else {
      set({
        focusedTerminalId: id,
        focusedBrowserId: null,
        focusedAgentWindowId: null,
        focusedTerminalSince: id ? Date.now() : 0,
      })
    }

    // Delayed clear of unseen attention. Runtime state stays intact.
    if (id) {
      _runtimeAttentionClearTimer = setTimeout(() => {
        _runtimeAttentionClearTimer = null
        const store = get()
        if (store.focusedTerminalId !== id) return
        store.clearTerminalRuntimeAttention(id)
      }, FOCUS_READ_DELAY_MS)
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
      const terminal = get().terminals.find((candidate) => candidate.id === focusedTerminalId)
      if (terminal?.exited) {
        get().restartTerminalSession(focusedTerminalId)
      } else {
        reloadTerminal(focusedTerminalId)
      }
    } else if (focusedBrowserId) {
      window.cells.browser.reload(focusedBrowserId)
    }
  },

  moveTerminal(id, x, y) {
    if (get().autoArrangeOnCreate) {
      get().setAutoArrangeOnCreate(false)
      showToast('Auto-arrange disabled', 'info')
    }
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, x, y } : t)),
    }))
    debouncedPersist(() => get().persist())
  },

  moveCanvasNodes(updates) {
    if (updates.length === 0) return

    if (get().autoArrangeOnCreate) {
      get().setAutoArrangeOnCreate(false)
      showToast('Auto-arrange disabled', 'info')
    }

    const terminalUpdates = new Map<string, { x: number; y: number }>()
    const browserUpdates = new Map<string, { x: number; y: number }>()
    const agentUpdates = new Map<string, { x: number; y: number }>()

    for (const update of updates) {
      if (update.kind === 'browser') {
        browserUpdates.set(update.id, { x: update.x, y: update.y })
      } else if (update.kind === 'agent') {
        agentUpdates.set(update.id, { x: update.x, y: update.y })
      } else {
        terminalUpdates.set(update.id, { x: update.x, y: update.y })
      }
    }

    set((state) => ({
      terminals:
        terminalUpdates.size === 0
          ? state.terminals
          : state.terminals.map((terminal) => {
              const next = terminalUpdates.get(terminal.id)
              return next ? { ...terminal, x: next.x, y: next.y } : terminal
            }),
      browsers:
        browserUpdates.size === 0
          ? state.browsers
          : state.browsers.map((browser) => {
              const next = browserUpdates.get(browser.id)
              return next ? { ...browser, x: next.x, y: next.y } : browser
            }),
      agentWindows:
        agentUpdates.size === 0
          ? state.agentWindows
          : state.agentWindows.map((agentWindow) => {
              const next = agentUpdates.get(agentWindow.id)
              return next ? { ...agentWindow, x: next.x, y: next.y } : agentWindow
            }),
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
      terminals: s.terminals.map((t) => (t.id === id && !t.customTitle ? { ...t, title } : t)),
    }))
  },

  setCustomTitle(id, customTitle) {
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === id ? { ...t, customTitle: customTitle || null } : t,
      ),
    }))
    debouncedPersist(() => get().persist())
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

  snapToTerminal(id, options) {
    const state = get()
    const terminal = state.terminals.find((t) => t.id === id)
    if (!terminal) return

    const shouldBringToFront = id !== state.focusedTerminalId
    const nextTopZIndex = shouldBringToFront ? state.topZIndex + 1 : state.topZIndex
    const focusHistory = pushFocusHistory(state.focusHistory, id)
    const focusCounts = shouldBringToFront
      ? { ...state.focusCounts, [id]: (state.focusCounts[id] ?? 0) + 1 }
      : state.focusCounts
    const viewW = window.innerWidth
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT
    const scale = options?.keepScale
      ? state.canvas.scale
      : Math.min(
          viewW / (terminal.width + TERMINAL_PAD * 2),
          viewH / (terminal.height + TERMINAL_PAD * 2),
          1,
        )

    set({
      terminals: shouldBringToFront
        ? state.terminals.map((t) => (t.id === id ? { ...t, zIndex: nextTopZIndex } : t))
        : state.terminals,
      focusedTerminalId: id,
      focusedBrowserId: null,
      focusedAgentWindowId: null,
      focusedTerminalSince: Date.now(),
      snapPaused: false,
      snapFast: true,
      focusHistory,
      focusCounts,
      topZIndex: nextTopZIndex,
      canvas: {
        x: viewW / 2 - (terminal.x + terminal.width / 2) * scale,
        y: viewH / 2 - (terminal.y + terminal.height / 2) * scale,
        scale,
      },
    })
    debouncedPersist(() => get().persist())
  },

  zoomToFit(id) {
    const { terminals, browsers, agentWindows } = get()
    const node =
      terminals.find((terminal) => terminal.id === id) ??
      browsers.find((browser) => browser.id === id) ??
      agentWindows.find((agentWindow) => agentWindow.id === id)
    if (!node) return
    const viewW = window.innerWidth
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT
    const scale = Math.min(
      viewW / (node.width + TERMINAL_PAD * 2),
      viewH / (node.height + TERMINAL_PAD * 2),
      1,
    )
    if (terminals.some((terminal) => terminal.id === id)) {
      if (id !== get().focusedTerminalId) get().bringToFront(id)
      set({
        focusedTerminalId: id,
        focusedBrowserId: null,
        focusedAgentWindowId: null,
        snapPaused: false,
        snapFast: true,
      })
    } else if (browsers.some((browser) => browser.id === id)) {
      if (id !== get().focusedBrowserId) get().bringBrowserToFront(id)
      set({
        focusedTerminalId: null,
        focusedBrowserId: id,
        focusedAgentWindowId: null,
        snapPaused: false,
        snapFast: true,
      })
    } else {
      if (id !== get().focusedAgentWindowId) get().bringAgentWindowToFront(id)
      set({
        focusedTerminalId: null,
        focusedBrowserId: null,
        focusedAgentWindowId: id,
        snapPaused: false,
        snapFast: true,
      })
    }
    get().setCanvasTransform({
      x: TERMINAL_PAD - node.x * scale,
      y: TERMINAL_PAD - node.y * scale,
      scale,
    })
  },

  zoomFocusedWindow(direction) {
    const state = get()
    const id =
      state.focusedTerminalId ||
      state.focusedBrowserId ||
      state.focusedAgentWindowId ||
      state.terminals[0]?.id ||
      state.browsers[0]?.id ||
      state.agentWindows[0]?.id
    if (!id) return

    const node =
      state.terminals.find((terminal) => terminal.id === id) ??
      state.browsers.find((browser) => browser.id === id) ??
      state.agentWindows.find((agentWindow) => agentWindow.id === id)
    if (!node) return

    const viewW = window.innerWidth
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT
    const scale = Math.max(
      CANVAS_MIN_ZOOM,
      Math.min(
        CANVAS_MAX_ZOOM,
        direction === 'in'
          ? state.canvas.scale * CANVAS_KEYBOARD_ZOOM_FACTOR
          : state.canvas.scale / CANVAS_KEYBOARD_ZOOM_FACTOR,
      ),
    )
    const centerX = node.x + node.width / 2
    const centerY = node.y + node.height / 2
    let nextX = viewW / 2 - centerX * scale
    let nextY = viewH / 2 - centerY * scale
    const scaledWidth = node.width * scale
    const scaledHeight = node.height * scale
    const minX = viewW - TERMINAL_PAD - (node.x + node.width) * scale
    const maxX = TERMINAL_PAD - node.x * scale
    const minY = viewH - TERMINAL_PAD - (node.y + node.height) * scale
    const maxY = TERMINAL_PAD - node.y * scale

    if (scaledWidth <= viewW - TERMINAL_PAD * 2) {
      nextX = Math.max(minX, Math.min(maxX, nextX))
    }
    if (scaledHeight <= viewH - TERMINAL_PAD * 2) {
      nextY = Math.max(minY, Math.min(maxY, nextY))
    }

    const fitScale = Math.min(
      viewW / (node.width + TERMINAL_PAD * 2),
      viewH / (node.height + TERMINAL_PAD * 2),
      1,
    )
    const shouldFitViewport = direction === 'out' && scale >= fitScale
    const finalScale = shouldFitViewport ? fitScale : scale
    const finalX = shouldFitViewport ? TERMINAL_PAD - node.x * fitScale : nextX
    const finalY = shouldFitViewport ? TERMINAL_PAD - node.y * fitScale : nextY

    if (state.terminals.some((terminal) => terminal.id === id)) {
      if (id !== state.focusedTerminalId) get().bringToFront(id)
      set({
        focusedTerminalId: id,
        focusedBrowserId: null,
        focusedAgentWindowId: null,
        snapPaused: false,
        snapFast: true,
      })
    } else if (state.browsers.some((browser) => browser.id === id)) {
      if (id !== state.focusedBrowserId) get().bringBrowserToFront(id)
      set({
        focusedTerminalId: null,
        focusedBrowserId: id,
        focusedAgentWindowId: null,
        snapPaused: false,
        snapFast: true,
      })
    } else {
      if (id !== state.focusedAgentWindowId) get().bringAgentWindowToFront(id)
      set({
        focusedTerminalId: null,
        focusedBrowserId: null,
        focusedAgentWindowId: id,
        snapPaused: false,
        snapFast: true,
      })
    }

    get().setCanvasTransform({
      x: finalX,
      y: finalY,
      scale: finalScale,
    })
  },

  snapToNearest(direction, options) {
    const {
      terminals,
      browsers,
      agentWindows,
      focusedTerminalId,
      focusedBrowserId,
      focusedAgentWindowId,
      canvas,
    } = get()
    const windows = getCanvasWindows(terminals, browsers, agentWindows)
    if (windows.length === 0) return

    const currentId = focusedTerminalId || focusedBrowserId || focusedAgentWindowId
    const current = currentId ? windows.find((window) => window.id === currentId) : null
    const origin = current ? getWindowCenter(current) : getViewportCenter(canvas)
    const next = getDirectionalWindow(windows, direction, origin, current?.id ?? null)
    if (!next) {
      window.cells.app.beep()
      return
    }

    if (next.type === 'terminal') {
      get().snapToTerminal(next.id, options)
    } else if (next.type === 'agent') {
      get().snapToAgentWindow(next.id, options)
    } else {
      get().snapToBrowser(next.id, options)
    }
  },

  snapToClosest() {
    set({ snapFast: false })
    const { terminals, browsers, agentWindows, canvas } = get()
    const windows = getCanvasWindows(terminals, browsers, agentWindows)
    if (windows.length === 0) return

    const best = getClosestWindow(windows, getViewportCenter(canvas))
    if (!best) return

    if (best.type === 'terminal') {
      get().snapToTerminal(best.id)
    } else if (best.type === 'agent') {
      get().snapToAgentWindow(best.id)
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

  setAgentNotificationSettings(settings) {
    set((state) => ({
      agentNotificationSettings: normalizeAgentNotificationSettings({
        ...state.agentNotificationSettings,
        ...settings,
      }),
    }))
    get().persist()
  },

  setAutoArrangeOnCreate(enabled) {
    set({ autoArrangeOnCreate: enabled })
    get().persist()
  },

  resizeWindowToFitFocused() {
    const {
      terminals,
      browsers,
      agentWindows,
      focusedTerminalId,
      focusedBrowserId,
      focusedAgentWindowId,
    } = get()
    const node = focusedTerminalId
      ? terminals.find((t) => t.id === focusedTerminalId)
      : focusedBrowserId
        ? browsers.find((b) => b.id === focusedBrowserId)
        : focusedAgentWindowId
          ? agentWindows.find((entry) => entry.id === focusedAgentWindowId)
          : null
    if (!node) return
    const width = node.width + TERMINAL_PAD * 2
    const height = node.height + TERMINAL_PAD * 2 + STATUS_BAR_HEIGHT
    void window.cells.app.resizeToFit(width, height)
    // Re-fit the canvas after the window resizes
    requestAnimationFrame(() => {
      if (focusedTerminalId) get().snapToTerminal(focusedTerminalId)
      else if (focusedBrowserId) get().snapToBrowser(focusedBrowserId)
      else if (focusedAgentWindowId) get().snapToAgentWindow(focusedAgentWindowId)
    })
  },

  resizeFocusedToFitViewport() {
    const {
      terminals,
      browsers,
      agentWindows,
      focusedTerminalId,
      focusedBrowserId,
      focusedAgentWindowId,
    } = get()
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
    } else if (focusedAgentWindowId) {
      const agentWindow = agentWindows.find((entry) => entry.id === focusedAgentWindowId)
      if (!agentWindow) return
      get().resizeAgentWindow(focusedAgentWindowId, viewW, viewH)
      get().snapToAgentWindow(focusedAgentWindowId)
    }
  },

  zoomToFitAll() {
    const { terminals, browsers, agentWindows } = get()
    const allNodes = [
      ...terminals.map((t) => ({ x: t.x, y: t.y, width: t.width, height: t.height })),
      ...browsers.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height })),
      ...agentWindows.map((entry) => ({
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height,
      })),
    ]
    const nextTransform = getOverviewTransform(
      allNodes,
      window.innerWidth,
      window.innerHeight - STATUS_BAR_HEIGHT,
    )
    if (!nextTransform) return

    set({
      snapPaused: true,
      focusedTerminalId: null,
      focusedBrowserId: null,
      focusedAgentWindowId: null,
      snapFast: false,
    })
    get().setCanvasTransform(nextTransform)
  },

  exitOverview() {
    const {
      focusedTerminalId,
      focusedBrowserId,
      focusedAgentWindowId,
      focusHistory,
      terminals,
      browsers,
      agentWindows,
    } = get()
    // Only meaningful when no window is focused (i.e. in overview)
    if (focusedTerminalId || focusedBrowserId || focusedAgentWindowId) return

    // Restore focus to the most recently focused window from history
    for (let i = focusHistory.length - 1; i >= 0; i--) {
      const id = focusHistory[i]
      if (terminals.some((t) => t.id === id)) {
        get().focusTerminal(id)
        get().snapToTerminal(id)
        return
      }
      if (browsers.some((b) => b.id === id)) {
        get().focusBrowser(id)
        get().snapToBrowser(id)
        return
      }
      if (agentWindows.some((entry) => entry.id === id)) {
        get().focusAgentWindow(id)
        get().snapToAgentWindow(id)
        return
      }
    }
    // Fallback: focus the first terminal or browser
    if (terminals.length > 0) {
      get().focusTerminal(terminals[0].id)
      get().snapToTerminal(terminals[0].id)
    } else if (browsers.length > 0) {
      get().focusBrowser(browsers[0].id)
      get().snapToBrowser(browsers[0].id)
    } else if (agentWindows.length > 0) {
      get().focusAgentWindow(agentWindows[0].id)
      get().snapToAgentWindow(agentWindows[0].id)
    }
  },

  autoArrangeGrid(skipOverview?: boolean) {
    const { terminals, browsers, agentWindows } = get()
    const allNodes: Array<{
      id: string
      type: 'terminal' | 'browser' | 'agent'
      x: number
      y: number
      width: number
      height: number
    }> = [
      ...terminals.map((t) => ({
        id: t.id,
        type: 'terminal' as const,
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
      })),
      ...browsers.map((b) => ({
        id: b.id,
        type: 'browser' as const,
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
      })),
      ...agentWindows.map((entry) => ({
        id: entry.id,
        type: 'agent' as const,
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height,
      })),
    ]
    if (allNodes.length === 0) return

    const gap = TERMINAL_GAP

    // Sort by Y first, then X to detect rows
    const sorted = [...allNodes].sort((a, b) => a.y - b.y || a.x - b.x)

    // Group into rows by Y-proximity: windows within half the tallest
    // node's height are considered the same row
    const maxH = Math.max(...allNodes.map((n) => n.height))
    const rowThreshold = maxH * 0.5
    const rows: Array<typeof sorted> = []
    let currentRow: typeof sorted = [sorted[0]]
    for (let i = 1; i < sorted.length; i++) {
      const rowCenterY = currentRow.reduce((s, n) => s + n.y, 0) / currentRow.length
      if (Math.abs(sorted[i].y - rowCenterY) <= rowThreshold) {
        currentRow.push(sorted[i])
      } else {
        rows.push(currentRow)
        currentRow = [sorted[i]]
      }
    }
    rows.push(currentRow)

    // Within each row, sort by X position (preserve left-to-right order)
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x)
    }

    // Tidy: snap each row to consistent positions with uniform gaps
    // Center the whole layout around the centroid of all windows
    const centroidX = allNodes.reduce((s, n) => s + n.x + n.width / 2, 0) / allNodes.length
    const centroidY = allNodes.reduce((s, n) => s + n.y + n.height / 2, 0) / allNodes.length

    // Calculate total grid height first
    let totalH = 0
    for (const row of rows) {
      const rowH = Math.max(...row.map((n) => n.height))
      totalH += rowH
    }
    totalH += (rows.length - 1) * gap

    const updatedTerminals = new Map<string, { x: number; y: number }>()
    const updatedBrowsers = new Map<string, { x: number; y: number }>()
    const updatedAgentWindows = new Map<string, { x: number; y: number }>()
    let curY = centroidY - totalH / 2

    for (const row of rows) {
      const rowH = Math.max(...row.map((n) => n.height))
      // Total row width
      const totalW = row.reduce((s, n) => s + n.width, 0) + (row.length - 1) * gap
      let curX = centroidX - totalW / 2

      for (const node of row) {
        const pos = { x: curX, y: curY }
        if (node.type === 'terminal') updatedTerminals.set(node.id, pos)
        else if (node.type === 'agent') updatedAgentWindows.set(node.id, pos)
        else updatedBrowsers.set(node.id, pos)
        curX += node.width + gap
      }
      curY += rowH + gap
    }

    // Enable CSS transition on nodes, then update positions
    set({ arrangeAnimating: true })
    // RAF ensures the animating class is applied before positions change
    requestAnimationFrame(() => {
      set((s) => ({
        terminals: s.terminals.map((t) => {
          const pos = updatedTerminals.get(t.id)
          return pos ? { ...t, x: pos.x, y: pos.y } : t
        }),
        browsers: s.browsers.map((b) => {
          const pos = updatedBrowsers.get(b.id)
          return pos ? { ...b, x: pos.x, y: pos.y } : b
        }),
        agentWindows: s.agentWindows.map((agentWindow) => {
          const pos = updatedAgentWindows.get(agentWindow.id)
          return pos ? { ...agentWindow, x: pos.x, y: pos.y } : agentWindow
        }),
      }))

      // Only zoom to overview when explicitly arranged (not on create)
      if (!skipOverview) get().zoomToFitAll()
      get().persist()

      // Clear animation flag after transition completes
      setTimeout(() => set({ arrangeAnimating: false }), 350)
    })
  },

  setCanvasTransform(transform) {
    set({ canvas: transform })
    debouncedPersist(() => get().persist())
  },

  setOverlayOpen(open) {
    set({ overlayOpen: open })
  },

  dismissOnboardingGuide() {
    set({ hasSeenOnboardingGuide: true, showOnboardingGuide: false })
    get().setOverlayOpen(false)
    get().persist()
  },

  openOnboardingGuide() {
    set({ showOnboardingGuide: true })
    get().setOverlayOpen(true)
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
  setDirectoryLinkTarget(target) {
    set({ directoryLinkTarget: target })
    get().persist()
  },
  setAgentAliases(aliases) {
    set({ agentAliases: aliases })
    get().persist()
  },
  setAgentPaths(paths) {
    set({ agentPaths: paths })
    get().persist()
    void window.cells.agent.setCustomPaths(paths)
  },
  setEnabledAgents(agents) {
    set({ enabledAgents: agents })
    get().persist()
  },
  setInputPrefixes(prefixes) {
    set({ inputPrefixes: prefixes })
    get().persist()
  },
  setLastUsedAgent(agent) {
    set({ lastUsedAgent: agent })
  },
  setLastAgentSessionDefaults(agent, patch) {
    set((state) => ({
      lastAgentSessionDefaults: {
        ...state.lastAgentSessionDefaults,
        [agent]: {
          ...state.lastAgentSessionDefaults[agent],
          ...patch,
        },
      },
    }))
    debouncedPersist(() => get().persist())
  },
  setLastCommandAction(action) {
    set({ lastCommandAction: action })
  },
  trackCommandAction(key) {
    const counts = { ...get().commandActionCounts }
    counts[key] = (counts[key] ?? 0) + 1
    set({ commandActionCounts: counts })
    get().persist()
  },
  setColorScheme(scheme) {
    set({ colorScheme: scheme })
    applyColorScheme(scheme, { syncTerminalTheme: true })
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
      (state.focusedAgentWindowId
        ? { id: state.focusedAgentWindowId, type: 'agent' as const }
        : state.focusedBrowserId
          ? { id: state.focusedBrowserId, type: 'browser' as const }
          : state.focusedTerminalId
            ? { id: state.focusedTerminalId, type: 'terminal' as const }
            : state.agentWindows.length > 0
              ? {
                  id: state.agentWindows[state.agentWindows.length - 1].id,
                  type: 'agent' as const,
                }
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
          const previousId = getPreviousWindowId(
            history,
            remaining,
            current.browsers,
            current.agentWindows,
          )
          if (previousId) {
            if (remaining.some((item) => item.id === previousId)) {
              const nextHistory = pushFocusHistory(history, previousId)
              get().bringToFront(previousId)
              set({
                focusedTerminalId: previousId,
                focusedBrowserId: null,
                focusedAgentWindowId: null,
                focusHistory: nextHistory,
              })
              get().panToTerminal(previousId)
            } else if (current.agentWindows.some((item) => item.id === previousId)) {
              const nextHistory = pushFocusHistory(history, previousId)
              get().bringAgentWindowToFront(previousId)
              set({
                focusedTerminalId: null,
                focusedBrowserId: null,
                focusedAgentWindowId: previousId,
                focusHistory: nextHistory,
              })
              get().panToAgentWindow(previousId)
            } else {
              const nextHistory = pushFocusHistory(history, previousId)
              get().bringBrowserToFront(previousId)
              set({
                focusedTerminalId: null,
                focusedBrowserId: previousId,
                focusedAgentWindowId: null,
                focusHistory: nextHistory,
              })
              get().panToBrowser(previousId)
            }
          } else {
            set({ focusedBrowserId: null, focusedAgentWindowId: null })
          }
        }
      } else if (resolvedTarget.type === 'browser') {
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
          const previousId = getPreviousWindowId(
            history,
            current.terminals,
            remaining,
            current.agentWindows,
          )
          if (previousId) {
            if (current.terminals.some((item) => item.id === previousId)) {
              const nextHistory = pushFocusHistory(history, previousId)
              get().bringToFront(previousId)
              set({
                focusedTerminalId: previousId,
                focusedBrowserId: null,
                focusedAgentWindowId: null,
                focusHistory: nextHistory,
              })
              get().panToTerminal(previousId)
            } else if (current.agentWindows.some((item) => item.id === previousId)) {
              const nextHistory = pushFocusHistory(history, previousId)
              get().bringAgentWindowToFront(previousId)
              set({
                focusedTerminalId: null,
                focusedBrowserId: null,
                focusedAgentWindowId: previousId,
                focusHistory: nextHistory,
              })
              get().panToAgentWindow(previousId)
            } else {
              const nextHistory = pushFocusHistory(history, previousId)
              get().bringBrowserToFront(previousId)
              set({
                focusedTerminalId: null,
                focusedBrowserId: previousId,
                focusedAgentWindowId: null,
                focusHistory: nextHistory,
              })
              get().panToBrowser(previousId)
            }
          } else {
            set({ focusedTerminalId: null, focusedAgentWindowId: null })
          }
        }
      } else {
        const agentWindow = current.agentWindows.find((item) => item.id === resolvedTarget.id)
        if (!agentWindow) return

        if (timeoutMs <= 0) {
          current.removeAgentWindow(agentWindow.id)
          return
        }

        const remaining = current.agentWindows.filter((item) => item.id !== agentWindow.id)
        const history = current.focusHistory.filter((entry) => entry !== agentWindow.id)
        const wasFocused = current.focusedAgentWindowId === agentWindow.id

        set({
          agentWindows: remaining,
          focusHistory: history,
          focusedAgentWindowId: wasFocused ? null : current.focusedAgentWindowId,
          pendingClosedWindows: upsertPendingClosedWindow(current.pendingClosedWindows, {
            id: agentWindow.id,
            target: resolvedTarget,
            projectId: current.activeProjectId,
            agentWindow,
            title: agentWindow.customTitle || agentWindow.title,
            closedAt: now,
            expiresAt,
          }),
        })

        clearPendingCloseTimer(agentWindow.id)
        pendingCloseTimers.set(
          agentWindow.id,
          window.setTimeout(() => {
            useStore.getState().removeAgentWindow(agentWindow.id)
          }, timeoutMs),
        )

        if (wasFocused) {
          const previousId = getPreviousWindowId(
            history,
            current.terminals,
            current.browsers,
            remaining,
          )
          if (previousId) {
            if (remaining.some((item) => item.id === previousId)) {
              const nextHistory = pushFocusHistory(history, previousId)
              get().bringAgentWindowToFront(previousId)
              set({
                focusedTerminalId: null,
                focusedBrowserId: null,
                focusedAgentWindowId: previousId,
                focusHistory: nextHistory,
              })
              get().panToAgentWindow(previousId)
            } else if (current.terminals.some((item) => item.id === previousId)) {
              const nextHistory = pushFocusHistory(history, previousId)
              get().bringToFront(previousId)
              set({
                focusedTerminalId: previousId,
                focusedBrowserId: null,
                focusedAgentWindowId: null,
                focusHistory: nextHistory,
              })
              get().panToTerminal(previousId)
            } else {
              const nextHistory = pushFocusHistory(history, previousId)
              get().bringBrowserToFront(previousId)
              set({
                focusedTerminalId: null,
                focusedBrowserId: previousId,
                focusedAgentWindowId: null,
                focusHistory: nextHistory,
              })
              get().panToBrowser(previousId)
            }
          } else {
            set({ focusedTerminalId: null, focusedBrowserId: null })
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
        focusedAgentWindowId: null,
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
        focusedAgentWindowId: null,
        focusHistory: nextHistory,
      })
      get().snapToBrowser(restoredBrowser.id)
      get().persist()
      return
    }

    if (entry.agentWindow) {
      const restoredAgentWindow = { ...entry.agentWindow, zIndex: newZ }
      const nextHistory = pushFocusHistory(current.focusHistory, restoredAgentWindow.id)
      set({
        agentWindows: [...current.agentWindows, restoredAgentWindow],
        topZIndex: newZ,
        focusedTerminalId: null,
        focusedBrowserId: null,
        focusedAgentWindowId: restoredAgentWindow.id,
        focusHistory: nextHistory,
      })
      get().snapToAgentWindow(restoredAgentWindow.id)
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

  // ---- Agent window actions ----

  addAgentWindow(agent, options) {
    const requestedId = options?.id ?? null
    const existing = requestedId
      ? get().agentWindows.find((entry) => entry.id === requestedId)
      : null
    if (existing) {
      get().bringAgentWindowToFront(existing.id)
      get().snapToAgentWindow(existing.id)
      return existing
    }

    const id = requestedId ?? nanoid(8)
    const newZ = get().topZIndex + 1
    const { terminals, browsers, agentWindows, focusHistory } = get()
    const savedDefaults =
      get().lastAgentSessionDefaults[agent] ?? DEFAULT_AGENT_SESSION_DEFAULTS[agent]
    const width = window.innerWidth - TERMINAL_PAD * 2
    const height = window.innerHeight - STATUS_BAR_HEIGHT - TERMINAL_PAD * 2

    let x = TERMINAL_PAD
    const y = TERMINAL_PAD
    const allRightEdges = [
      ...terminals.map((t) => t.x + t.width),
      ...browsers.map((b) => b.x + b.width),
      ...agentWindows.map((entry) => entry.x + entry.width),
    ]
    if (allRightEdges.length > 0) {
      x = Math.max(...allRightEdges) + TERMINAL_GAP
    }

    const agentWindow: AgentWindowNode = {
      id,
      agent,
      x,
      y,
      width,
      height,
      title: options?.title ?? (agent === 'claude' ? 'Claude Code' : 'Codex'),
      customTitle: options?.customTitle ?? null,
      cwd: options?.cwd ?? get().getActiveProjectPath() ?? null,
      initialPrompt: options?.initialPrompt ?? null,
      composerDraft: options?.composerDraft ?? null,
      composerAttachments: options?.composerAttachments ?? [],
      claudeSessionId: options?.claudeSessionId ?? null,
      codexThreadId: options?.codexThreadId ?? null,
      model: options?.model ?? savedDefaults.model ?? null,
      permissionMode: options?.permissionMode ?? savedDefaults.permissionMode ?? null,
      thinkingLevel: options?.thinkingLevel ?? savedDefaults.thinkingLevel ?? null,
      contextLength: options?.contextLength ?? savedDefaults.contextLength ?? null,
      status: 'idle',
      error: null,
      zIndex: newZ,
      createdAt: options?.createdAt ?? Date.now(),
    }

    set((s) => ({
      agentWindows: [...s.agentWindows, agentWindow],
      topZIndex: newZ,
      focusedTerminalId: null,
      focusedBrowserId: null,
      focusedAgentWindowId: id,
      focusHistory: pushFocusHistory(focusHistory, id),
    }))
    if (get().autoArrangeOnCreate) {
      get().autoArrangeGrid(true)
      set({
        focusedTerminalId: null,
        focusedBrowserId: null,
        focusedAgentWindowId: id,
        canvas: { ...get().canvas, scale: 1 },
      })
      get().snapToAgentWindow(id)
    } else {
      set({ canvas: { ...get().canvas, scale: 1 } })
      get().snapToAgentWindow(id)
    }
    get().persist()
    return agentWindow
  },

  removeAgentWindow(id) {
    clearPendingCloseTimer(id)
    void window.cells.agentSession.dispose(id).catch(() => {})
    const state = get()
    const remaining = state.agentWindows.filter((entry) => entry.id !== id)
    const history = state.focusHistory.filter((entry) => entry !== id)
    const wasFocused = state.focusedAgentWindowId === id
    set({
      agentWindows: remaining,
      focusHistory: history,
      focusedAgentWindowId: wasFocused ? null : state.focusedAgentWindowId,
      pendingClosedWindows: state.pendingClosedWindows.filter((entry) => entry.id !== id),
      pendingCloseDialog:
        state.pendingCloseDialog?.target.id === id ? null : state.pendingCloseDialog,
    })
    if (wasFocused) {
      const previousId = getPreviousWindowId(history, state.terminals, state.browsers, remaining)
      if (previousId) {
        if (remaining.some((entry) => entry.id === previousId)) {
          const nextHistory = pushFocusHistory(history, previousId)
          get().bringAgentWindowToFront(previousId)
          set({
            focusedTerminalId: null,
            focusedBrowserId: null,
            focusedAgentWindowId: previousId,
            focusHistory: nextHistory,
          })
          get().panToAgentWindow(previousId)
        } else if (state.terminals.some((terminal) => terminal.id === previousId)) {
          const nextHistory = pushFocusHistory(history, previousId)
          get().bringToFront(previousId)
          set({
            focusedTerminalId: previousId,
            focusedBrowserId: null,
            focusedAgentWindowId: null,
            focusHistory: nextHistory,
          })
          get().panToTerminal(previousId)
        } else {
          const nextHistory = pushFocusHistory(history, previousId)
          get().bringBrowserToFront(previousId)
          set({
            focusedTerminalId: null,
            focusedBrowserId: previousId,
            focusedAgentWindowId: null,
            focusHistory: nextHistory,
          })
          get().panToBrowser(previousId)
        }
      } else {
        set({ focusedTerminalId: null, focusedBrowserId: null, focusedAgentWindowId: null })
      }
    }
    get().persist()
  },

  moveAgentWindow(id, x, y) {
    if (get().autoArrangeOnCreate) {
      get().setAutoArrangeOnCreate(false)
      showToast('Auto-arrange disabled', 'info')
    }
    set((s) => ({
      agentWindows: s.agentWindows.map((agentWindow) =>
        agentWindow.id === id ? { ...agentWindow, x, y } : agentWindow,
      ),
    }))
    debouncedPersist(() => get().persist())
  },

  resizeAgentWindow(id, width, height) {
    set((s) => ({
      agentWindows: s.agentWindows.map((agentWindow) =>
        agentWindow.id === id ? { ...agentWindow, width, height } : agentWindow,
      ),
    }))
    debouncedPersist(() => get().persist())
  },

  focusAgentWindow(id) {
    const prev = get().focusedAgentWindowId
    if (id && id !== prev) {
      if (get().snapOnFocus) {
        get().snapToAgentWindow(id)
      } else {
        get().bringAgentWindowToFront(id)
        const history = pushFocusHistory(get().focusHistory, id)
        const counts = { ...get().focusCounts, [id]: (get().focusCounts[id] ?? 0) + 1 }
        set({
          focusedTerminalId: null,
          focusedBrowserId: null,
          focusedAgentWindowId: id,
          focusHistory: history,
          focusCounts: counts,
        })
      }
    } else {
      set({
        focusedTerminalId: null,
        focusedBrowserId: null,
        focusedAgentWindowId: id,
      })
    }
  },

  bringAgentWindowToFront(id) {
    const newZ = get().topZIndex + 1
    set((s) => ({
      topZIndex: newZ,
      agentWindows: s.agentWindows.map((agentWindow) =>
        agentWindow.id === id ? { ...agentWindow, zIndex: newZ } : agentWindow,
      ),
    }))
  },

  panToAgentWindow(id) {
    const { agentWindows, canvas } = get()
    const agentWindow = agentWindows.find((entry) => entry.id === id)
    if (!agentWindow) return
    const viewW = window.innerWidth
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT
    get().setCanvasTransform({
      ...canvas,
      x: viewW / 2 - (agentWindow.x + agentWindow.width / 2) * canvas.scale,
      y: viewH / 2 - (agentWindow.y + agentWindow.height / 2) * canvas.scale,
    })
  },

  snapToAgentWindow(id, options) {
    const state = get()
    const agentWindow = state.agentWindows.find((entry) => entry.id === id)
    if (!agentWindow) return

    const shouldBringToFront = id !== state.focusedAgentWindowId
    const nextTopZIndex = shouldBringToFront ? state.topZIndex + 1 : state.topZIndex
    const focusHistory = pushFocusHistory(state.focusHistory, id)
    const focusCounts = shouldBringToFront
      ? { ...state.focusCounts, [id]: (state.focusCounts[id] ?? 0) + 1 }
      : state.focusCounts
    const viewW = window.innerWidth
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT
    const scale = options?.keepScale
      ? state.canvas.scale
      : Math.min(
          viewW / (agentWindow.width + TERMINAL_PAD * 2),
          viewH / (agentWindow.height + TERMINAL_PAD * 2),
          1,
        )

    set({
      agentWindows: shouldBringToFront
        ? state.agentWindows.map((entry) =>
            entry.id === id ? { ...entry, zIndex: nextTopZIndex } : entry,
          )
        : state.agentWindows,
      focusedTerminalId: null,
      focusedBrowserId: null,
      focusedAgentWindowId: id,
      snapPaused: false,
      snapFast: true,
      focusHistory,
      focusCounts,
      topZIndex: nextTopZIndex,
      canvas: {
        x: viewW / 2 - (agentWindow.x + agentWindow.width / 2) * scale,
        y: viewH / 2 - (agentWindow.y + agentWindow.height / 2) * scale,
        scale,
      },
    })
    debouncedPersist(() => get().persist())
  },

  syncAgentWindow(id, patch) {
    set((s) =>
      mapAgentWindowsEverywhere(s.agentWindows, s.projects, id, (agentWindow) => ({
        ...agentWindow,
        ...patch,
      })),
    )
    debouncedPersist(() => get().persist())
  },

  // ---- Browser actions ----

  addBrowser() {
    const id = nanoid(8)
    const newZ = get().topZIndex + 1
    const { terminals, browsers, agentWindows, focusHistory } = get()

    const width = window.innerWidth - TERMINAL_PAD * 2
    const height = window.innerHeight - STATUS_BAR_HEIGHT - TERMINAL_PAD * 2

    // Place to the right of all nodes
    let x = TERMINAL_PAD
    const y = TERMINAL_PAD
    const allRightEdges = [
      ...terminals.map((t) => t.x + t.width),
      ...browsers.map((b) => b.x + b.width),
      ...agentWindows.map((agentWindow) => agentWindow.x + agentWindow.width),
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
      focusedAgentWindowId: null,
      focusHistory: pushFocusHistory(focusHistory, id),
    }))
    if (get().autoArrangeOnCreate) {
      get().autoArrangeGrid(true)
      // Stay focused on the new browser — no overview zoom
      set({
        focusedTerminalId: null,
        focusedBrowserId: id,
        focusedAgentWindowId: null,
        canvas: { ...get().canvas, scale: 1 },
      })
      const s = get().canvas.scale
      get().setCanvasTransform({
        x: TERMINAL_PAD - browser.x * s,
        y: TERMINAL_PAD - browser.y * s,
        scale: s,
      })
    } else {
      set({ canvas: { ...get().canvas, scale: 1 } })
      const s = get().canvas.scale
      get().setCanvasTransform({
        x: TERMINAL_PAD - browser.x * s,
        y: TERMINAL_PAD - browser.y * s,
        scale: s,
      })
    }
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
      const previousId = getPreviousWindowId(
        history,
        state.terminals,
        remaining,
        state.agentWindows,
      )
      if (previousId) {
        if (state.terminals.some((terminal) => terminal.id === previousId)) {
          const nextHistory = pushFocusHistory(history, previousId)
          get().bringToFront(previousId)
          set({
            focusedTerminalId: previousId,
            focusedBrowserId: null,
            focusedAgentWindowId: null,
            focusHistory: nextHistory,
          })
          get().panToTerminal(previousId)
        } else if (state.agentWindows.some((agentWindow) => agentWindow.id === previousId)) {
          const nextHistory = pushFocusHistory(history, previousId)
          get().bringAgentWindowToFront(previousId)
          set({
            focusedTerminalId: null,
            focusedBrowserId: null,
            focusedAgentWindowId: previousId,
            focusHistory: nextHistory,
          })
          get().panToAgentWindow(previousId)
        } else {
          const nextHistory = pushFocusHistory(history, previousId)
          get().bringBrowserToFront(previousId)
          set({
            focusedTerminalId: null,
            focusedBrowserId: previousId,
            focusedAgentWindowId: null,
            focusHistory: nextHistory,
          })
          get().panToBrowser(previousId)
        }
      } else {
        set({ focusedTerminalId: null, focusedAgentWindowId: null })
      }
    }
    get().persist()
  },

  moveBrowser(id, x, y) {
    if (get().autoArrangeOnCreate) {
      get().setAutoArrangeOnCreate(false)
      showToast('Auto-arrange disabled', 'info')
    }
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

  updateBrowserHistory(id, history) {
    set((s) => ({
      browsers: s.browsers.map((b) => (b.id === id ? { ...b, history } : b)),
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
        focusedAgentWindowId: null,
        focusHistory: history,
        focusCounts: counts,
      })
    } else {
      set({ focusedTerminalId: null, focusedBrowserId: id, focusedAgentWindowId: null })
    }
    if (id && id !== prev && get().snapOnFocus) {
      get().snapToBrowser(id)
    }
  },

  snapToBrowser(id: string, options?: { keepScale?: boolean }) {
    const state = get()
    const browser = state.browsers.find((b) => b.id === id)
    if (!browser) return

    const shouldBringToFront = id !== state.focusedBrowserId
    const nextTopZIndex = shouldBringToFront ? state.topZIndex + 1 : state.topZIndex
    const focusHistory = pushFocusHistory(state.focusHistory, id)
    const viewW = window.innerWidth
    const viewH = window.innerHeight - STATUS_BAR_HEIGHT
    const scale = options?.keepScale
      ? state.canvas.scale
      : Math.min(
          viewW / (browser.width + TERMINAL_PAD * 2),
          viewH / (browser.height + TERMINAL_PAD * 2),
          1,
        )

    set({
      browsers: shouldBringToFront
        ? state.browsers.map((b) => (b.id === id ? { ...b, zIndex: nextTopZIndex } : b))
        : state.browsers,
      focusedTerminalId: null,
      focusedBrowserId: id,
      focusedAgentWindowId: null,
      snapPaused: false,
      snapFast: true,
      focusHistory,
      topZIndex: nextTopZIndex,
      canvas: {
        x: viewW / 2 - (browser.x + browser.width / 2) * scale,
        y: viewH / 2 - (browser.y + browser.height / 2) * scale,
        scale,
      },
    })
    debouncedPersist(() => get().persist())
  },

  bringBrowserToFront(id) {
    const newZ = get().topZIndex + 1
    set((s) => ({
      topZIndex: newZ,
      browsers: s.browsers.map((b) => (b.id === id ? { ...b, zIndex: newZ } : b)),
    }))
  },
}))
