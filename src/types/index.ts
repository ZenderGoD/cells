import type { TerminalCursorStyle } from '../lib/terminal-cursor'

export interface CanvasTransform {
  x: number
  y: number
  scale: number
}

export type TitleBarPosition = 'top' | 'bottom'
export type AgentName = 'claude' | 'codex' | 'opencode' | 'pi'
export type AgentStatus = 'active' | 'unread' | 'done' | null
export type AgentRuntimeState = 'working' | 'approval' | 'waiting' | 'done' | 'error'
export type TerminalRuntimeKind = 'none' | 'process' | 'agent'
export type TerminalSessionBackend = 'zellij' | 'tmux'
export type TerminalExitReason =
  | 'process-exit'
  | 'killed'
  | 'daemon-restart'
  | 'daemon-update'
  | 'daemon-disconnect'

export interface TerminalExitDetails {
  reason?: TerminalExitReason
  message?: string | null
  history?: string | null
}

export interface TerminalRuntimeStatus {
  kind: TerminalRuntimeKind
  agent?: AgentName | null
  state?: AgentRuntimeState | null
  detail: string
  shortLabel: string
  source: string
  pid?: number | null
  processLabel?: string | null
  updatedAt: number
  attention?: boolean
}

export interface TerminalNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  title: string
  customTitle?: string | null
  zIndex?: number
  pinned?: boolean
  agent?: AgentName | null
  runtimeStatus?: TerminalRuntimeStatus | null
  agentStatus?: AgentStatus
  processRunning?: boolean
  /** Runtime-only flag for a terminal window whose PTY exited but whose scrollback stays visible. */
  exited?: boolean
  /** Runtime-only status line shown when a terminal process is gone. */
  exitStatusMessage?: string | null
  /** Plain-text terminal snapshot used to restore visible history after reload/restart. */
  restoredOutput?: string
}

export interface BrowserHistoryEntry {
  url: string
  title: string
}

export interface TerminalProcessInfo {
  pid: number
  command: string
  label: string
  key: string
  isShell: boolean
}

export interface TmuxBackendProjectDetails {
  projectId: string
  sessionName: string
  windowCount: number
  termIds: string[]
}

export interface TmuxBackendDetails {
  backend: 'tmux'
  binaryPath: string | null
  version: string | null
  minimumVersion: string
  socketPath: string
  configPath: string
  terminfoDir: string | null
  terminfoCompiled: boolean
  serverReachable: boolean
  projectSessionCount: number
  viewerSessionCount: number
  projects: TmuxBackendProjectDetails[]
}

export interface DaemonVersionInfo {
  protocolVersion: number
  compatVersion?: number | null
  backend?: 'tmux' | 'zellij' | null
  appVersion: string | null
  electronVersion: string | null
  nodeAbi: string | null
  pid: number
  uptime: number
  backendDetails?: TmuxBackendDetails | null
}

export interface DaemonStatus {
  enabled: boolean
  connected: boolean
  sessionCount: number
  appVersion: string
  currentElectronVersion: string | null
  currentNodeAbi: string
  restartRecommended: boolean
  restartReason: string | null
  daemonVersion: DaemonVersionInfo | null
  backendDetails: TmuxBackendDetails | null
}

export interface GitWorktree {
  path: string
  branch: string
  isMain: boolean
  isBare?: boolean
}

export interface BrowserNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  url: string
  title: string
  zIndex?: number
  pinned?: boolean
  faviconUrl?: string
  /** Saved navigation history for restore across app restarts */
  history?: {
    entries: BrowserHistoryEntry[]
    activeIndex: number
  }
}

export type AgentModel = string

/**
 * Permission presets portable across Claude + Codex.
 *   safe       — read-only preview, nothing is written
 *   ask        — agent asks before every write / command
 *   allow-all  — agent runs tools freely (auto-accept edits, skip prompts)
 *   bypass     — nothing is gated, no confirmations ever
 */
export type AgentPermissionMode = 'safe' | 'ask' | 'allow-all' | 'bypass'

/**
 * Matches Craft's `ThinkingLevel` (../craft-agents-oss/packages/shared/src/agent/thinking-levels.ts).
 *   off     — no extended reasoning
 *   low     — lightest reasoning pass
 *   medium  — balanced (default)
 *   high    — deep reasoning
 *   max     — absolute maximum effort
 */
export type AgentThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max'

export interface AgentWindowNode {
  id: string
  agent: Extract<AgentName, 'claude' | 'codex'>
  x: number
  y: number
  width: number
  height: number
  title: string
  customTitle?: string | null
  zIndex?: number
  status?: 'idle' | 'running' | 'error'
  error?: string | null
  claudeSessionId?: string | null
  codexThreadId?: string | null
  cwd?: string | null
  initialPrompt?: string | null
  model?: AgentModel | null
  permissionMode?: AgentPermissionMode | null
  thinkingLevel?: AgentThinkingLevel | null
  fastMode?: boolean | null
  createdAt?: number | null
}

export type AgentSessionMessageRole =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'system'
  | 'error'
  | 'auth_request'

export interface AgentSessionMessage {
  id: string
  role: AgentSessionMessageRole
  text: string
  title?: string | null
  metadata?: string | null
  status?: 'in_progress' | 'completed' | 'failed'
  updatedAt?: number | null
  /** Only set for role='auth_request' — loginUrl the user needs to open. */
  authLoginUrl?: string | null
  /** Claude Agent SDK tool_use_id of this message's parent Task/Agent tool, if
   *  this message is part of a subagent's work. Used to nest subagent activity
   *  under its Task row instead of polluting the top-level timeline. */
  parentToolUseId?: string | null
  /** For role='tool' messages, the tool's own tool_use_id (raw, without the
   *  `tool-` prefix we use as the message id). Lets children resolve their
   *  parent Task id against this. */
  toolUseId?: string | null
}

export interface AgentSessionRequest {
  windowId: string
  agent: Extract<AgentName, 'claude' | 'codex'>
  title?: string | null
  cwd?: string | null
  initialPrompt?: string | null
  claudeSessionId?: string | null
  codexThreadId?: string | null
  model?: AgentModel | null
  permissionMode?: AgentPermissionMode | null
  thinkingLevel?: AgentThinkingLevel | null
  fastMode?: boolean | null
}

export interface AgentSessionSnapshot {
  windowId: string
  agent: Extract<AgentName, 'claude' | 'codex'>
  title: string
  cwd?: string | null
  status: 'idle' | 'running' | 'error'
  error?: string | null
  claudeSessionId?: string | null
  codexThreadId?: string | null
  updatedAt: number
  messages: AgentSessionMessage[]
}

export interface Project {
  id: string
  name: string
  path: string
  hiddenFromTitleBar?: boolean
  terminals: TerminalNode[]
  browsers: BrowserNode[]
  agentWindows?: AgentWindowNode[]
  canvas: CanvasTransform
  focusedTerminalId?: string | null
  focusedBrowserId?: string | null
  focusedAgentWindowId?: string | null
  lastOpenedAt: number
  worktreesDir?: string
  /** Branch to use as base when creating new worktrees (defaults to current HEAD) */
  worktreeBaseBranch?: string
  /** Per-window focus counts for usage-based grid arrangement */
  focusCounts?: Record<string, number>
  autoArrangeOnCreate?: boolean
  /** Per-project usage counts for command palette catch-all actions (search, agent-claude, agent-codex, agent-opencode, run) */
  commandActionCounts?: Record<string, number>
}

export interface ProjectsState {
  version: 4
  activeProjectId: string | null
  projects: Project[]
  appDarkTheme?: string
  appLightTheme?: string
  terminalSessionBackend?: TerminalSessionBackend
  terminalSessionBackendExplicitlySet?: boolean
  terminalTheme?: string
  fontSize?: number
  fontFamily?: string
  terminalScrollbackLines?: number
  terminalCursorStyle?: TerminalCursorStyle
  terminalCursorBlink?: boolean
  showTerminalHeaderOverlay?: boolean
  windowOpacity?: number
  useTransparentWindow?: boolean
  titleBarPosition?: TitleBarPosition
  snapOnFocus?: boolean
  tabSwitchMode?: 'recent' | 'chronological'
  projectSwitchMode?: 'recent' | 'chronological'
  reducedMotion?: boolean
  autoUpdate?: boolean
  searchEngine?: string
  homePage?: string
  terminalLinkTarget?: 'system' | 'browser'
  terminalLinkProjectId?: string | null
  linkRules?: Array<{ pattern: string; target: 'system' | 'browser'; projectId?: string }>
  directoryLinkTarget?: 'finder' | 'terminal'
  agentAliases?: Record<string, string>
  /** Per-agent visibility override: true = always show, false = always hide, 'auto' = detect binary */
  enabledAgents?: Record<string, boolean | 'auto'>
  inputPrefixes?: InputPrefix[]
  colorScheme?: 'light' | 'dark' | 'system'
  closeUndoTimeoutMs?: number
  closeProcessSuppressions?: string[]
  dimWhenUnfocused?: boolean
  hasSeenOnboardingGuide?: boolean
  /** @deprecated Moved to Project — kept for migration */
  autoArrangeOnCreate?: boolean
}

/** @deprecated Old flat state — kept for migration */
export interface AppState {
  terminals: TerminalNode[]
  canvas: CanvasTransform
  terminalTheme?: string
  fontSize?: number
  fontFamily?: string
}

export interface InputPrefix {
  prefix: string
  target: 'terminal' | 'browser' | 'agent'
  /** For agent targets, which agent to use (e.g. 'claude', 'codex') */
  agentId?: string
}

export interface RendererPerfSample {
  sampleWindowMs: number
  fps: number
  longTaskCount: number
  maxLongTaskMs: number
  liveTerminalCount: number
  cachedTerminalCount: number
  totalTerminalCount: number
  totalBrowserCount: number
  totalAgentWindowCount: number
  projectCount: number
  focusedTerminalId: string | null
  focusedBrowserId: string | null
  focusedAgentWindowId: string | null
  useTransparentWindow: boolean
  windowOpacity: number
  overlayOpen: boolean
}

export interface TerminalPerfSample {
  termId: string
  sampleWindowMs: number
  bytes: number
  writeCalls: number
  forcedFullRenders: number
  viewportY: number
  scrollbackLines: number
  isFocused: boolean
  isVisible: boolean
}

export interface PerfEventRecord {
  timestamp: number
  kind: 'sample' | 'spike' | 'renderer' | 'terminal'
  data: Record<string, unknown>
}

export interface PerfMonitorStatus {
  enabled: boolean
  logPath: string
  sampleIntervalMs: number
  hardwareAccelerationEnabled: boolean
  gpuFeatureStatus: Record<string, string>
  recentEventCount: number
}

export interface ExtensionMeta {
  id: string
  name: string
  version: string
  description: string
  sourceUrl: string
  installedAt: number
  hasPopup: boolean
  icons: Record<string, string>
}

export interface ExtensionsState {
  extensions: ExtensionMeta[]
  projectExtensions: Record<string, string[]>
}

export interface CellsAPI {
  terminal: {
    attach(
      termId: string,
      cols: number,
      rows: number,
      cwd?: string,
      projectId?: string | null,
    ): Promise<{ reattached: boolean; buffer: string; backend: 'replay' | 'tmux' | 'zellij' }>
    unsubscribe(termId: string): Promise<void>
    detach(termId: string): Promise<void>
    write(termId: string, data: string): void
    resize(termId: string, cols: number, rows: number): void
    handleWheel(
      termId: string,
      direction: 'up' | 'down',
      steps: number,
      sequence: string,
    ): Promise<void>
    getProcess(termId: string): Promise<string | null>
    getProcessInfo(termId: string): Promise<TerminalProcessInfo | null>
    getCodexTitle(termId: string): Promise<string | null>
    getScrollStatus(termId: string): Promise<{
      backend: 'replay' | 'tmux' | 'zellij'
      paneInMode: boolean
      scrollPosition: number
      historySize: number
      mouseAnyFlag?: boolean
      alternateOn?: boolean
    } | null>
    getHistory(termId: string): Promise<string>
    getHistoryPage(
      termId: string,
      token?: string | null,
      offset?: number | null,
      maxBytes?: number,
    ): Promise<{
      chunk: string
      done: boolean
      offset: number | null
      token: string | null
      totalBytes: number
    }>
    getStatus(termId: string): Promise<TerminalRuntimeStatus | null>
    registerLaunch(
      termId: string,
      launch: {
        agent?: AgentName | null
        command?: string | null
        cwd?: string | null
        startedAt?: number | null
        claudeSessionId?: string | null
        codexThreadId?: string | null
      },
    ): Promise<void>
    onData(callback: (termId: string, data: string) => void): () => void
    onStatus(callback: (termId: string, status: TerminalRuntimeStatus | null) => void): () => void
    onExit(callback: (termId: string, details?: TerminalExitDetails) => void): () => void
  }
  agentSession: {
    ensure(request: AgentSessionRequest): Promise<AgentSessionSnapshot>
    send(windowId: string, input: string): Promise<void>
    close(windowId: string): Promise<void>
    dispose(windowId: string): Promise<void>
    getAuth(agent: 'claude' | 'codex'): Promise<{
      agent: 'claude' | 'codex'
      binaryPath: string | null
      authenticated: boolean | 'unknown'
    }>
    getLoginCommand(agent: 'claude' | 'codex'): Promise<string>
    startLogin(agent: 'claude' | 'codex'): Promise<void>
    cancelLogin(agent: 'claude' | 'codex'): Promise<void>
    updatePermissionMode(windowId: string, mode: AgentPermissionMode | null): Promise<void>
    onLoginEvent(
      callback: (event: {
        agent: 'claude' | 'codex'
        phase: 'starting' | 'awaiting_browser' | 'success' | 'failed' | 'cancelled'
        url?: string | null
        message?: string | null
      }) => void,
    ): () => void
    onUpdate(callback: (snapshot: AgentSessionSnapshot) => void): () => void
  }
  git: {
    isRepo(cwd: string): Promise<boolean>
    repoRoot(cwd: string): Promise<string | null>
    listWorktrees(cwd: string): Promise<GitWorktree[]>
    createWorktree(
      cwd: string,
      branch: string,
      targetDir?: string,
      baseBranch?: string,
    ): Promise<GitWorktree>
    removeWorktree(cwd: string, worktreePath: string): Promise<void>
  }
  agent: {
    checkAvailable(aliases?: Record<string, string>): Promise<Record<string, boolean>>
  }
  daemon: {
    getStatus(): Promise<DaemonStatus>
    listSessions(): Promise<
      Array<{
        termId: string
        processInfo: TerminalProcessInfo | null
        runtimeStatus: TerminalRuntimeStatus | null
        subscribed: boolean
      }>
    >
    killSession(termId: string): Promise<void>
    killAll(): Promise<void>
    restart(): Promise<boolean>
  }
  updater: {
    getSupport(): Promise<{
      enabled: boolean
      reason?: string
      message?: string
    }>
    check(): Promise<void>
    download(): Promise<void>
    install(): Promise<boolean>
    getVersion(): Promise<string>
    setAutoUpdate(enabled: boolean): Promise<void>
    onStatus(callback: (status: string, info?: any) => void): () => void
  }
  perf: {
    reportRendererSample(sample: RendererPerfSample): Promise<void>
    reportTerminalSample(sample: TerminalPerfSample): void
    getStatus(): Promise<PerfMonitorStatus | null>
    getRecentEvents(limit?: number): Promise<PerfEventRecord[]>
  }
  state: {
    load(): Promise<ProjectsState | null>
    save(state: ProjectsState): Promise<void>
  }
  browser: {
    create(
      browserId: string,
      projectId: string,
      history?: { entries: BrowserHistoryEntry[]; activeIndex: number },
    ): Promise<any>
    destroy(browserId: string): Promise<void>
    park(browserId: string): Promise<void>
    getHistory(
      browserId: string,
    ): Promise<{ entries: BrowserHistoryEntry[]; activeIndex: number } | null>
    navigate(browserId: string, url: string, searchEngineUrl?: string): Promise<void>
    goBack(browserId: string): void
    goForward(browserId: string): void
    reload(browserId: string): void
    updateBounds(
      browserId: string,
      bounds: { x: number; y: number; width: number; height: number },
    ): void
    setVisible(browserId: string, visible: boolean): void
    setZoomFactor(browserId: string, factor: number): void
    toggleDevTools(browserId: string): void
    onTitleUpdated(callback: (browserId: string, title: string) => void): () => void
    onUrlChanged(callback: (browserId: string, url: string) => void): () => void
    onNavState(
      callback: (browserId: string, canGoBack: boolean, canGoForward: boolean) => void,
    ): () => void
    onLoading(callback: (browserId: string, loading: boolean) => void): () => void
    onNewWindow(callback: (browserId: string, url: string) => void): () => void
    onFaviconUpdated(callback: (browserId: string, faviconUrl: string) => void): () => void
    getAllHistory(): Promise<Record<
      string,
      { entries: Array<{ url: string; title: string }>; activeIndex: number }
    > | null>
    onThemeColor(callback: (browserId: string, color: string) => void): () => void
    onOverscroll(
      callback: (browserId: string, progress: number, direction: string | null) => void,
    ): () => void
    onWindowCycle(callback: (direction: 1 | -1) => void): () => void
    onProjectCycle(callback: (direction: 1 | -1) => void): () => void
  }
  extensions: {
    install(input: string): Promise<ExtensionMeta>
    uninstall(extensionId: string): Promise<void>
    list(): Promise<ExtensionsState>
    setEnabled(projectId: string, extensionId: string, enabled: boolean): Promise<void>
    showPopup(
      extensionId: string,
      projectId: string,
      bounds: { x: number; y: number; width: number; height: number },
    ): Promise<void>
    hidePopup(): Promise<void>
    onPopupClosed(callback: () => void): () => void
    onInstalled(callback: (meta: ExtensionMeta) => void): () => void
  }
  app: {
    onWindowFocus(callback: (focused: boolean) => void): () => void
    onBeforeQuit(callback: () => void): () => void
    onDaemonDisconnected(callback: () => void): () => void
    onNewTerminal(callback: () => void): () => void
    onCloseTerminal(callback: () => void): () => void
    toggleMaximize(): Promise<void>
    resizeToFit(width: number, height: number): Promise<void>
    pinWindow(
      id: string,
      type: string,
      bounds: { x: number; y: number; width: number; height: number },
      browserUrl?: string,
    ): Promise<void>
    unpinWindow(id: string): Promise<void>
    onWindowUnpinned(callback: (id: string, type: string) => void): () => void
    onWindowResized(
      callback: (id: string, type: string, width: number, height: number) => void,
    ): () => void
    getPinnedId(): string | null
    getPinnedType(): 'terminal' | 'browser' | null
    pickFolder(): Promise<string | null>
    pickFiles(): Promise<string[] | null>
    listRecentFiles(): Promise<Array<{ path: string; name: string; mtime: number; source: string }>>
    getPathForFile(file: File): string
    saveTempFile(data: Uint8Array, filename: string): Promise<string | null>
    pasteClipboardFiles(): Promise<string[] | null>
    openExternal(url: string): Promise<void>
    statPath(targetPath: string): Promise<{ kind: 'file' | 'dir' | 'missing'; resolved: string }>
    revealPath(targetPath: string): Promise<void>
    requestQuit(): Promise<void>
    relaunch(): Promise<void>
    repairTerminalFonts(): Promise<void>
    beep(): void
    getShellHistory(): Promise<string[]>
    fileThumbnail(filePath: string): Promise<string | null>
  }
  mcp: {
    install(projectPath: string): Promise<{
      configPath: string
      targets: string[]
      serverPath: string
    }>
  }
}

declare global {
  interface Window {
    cells: CellsAPI
  }
}
