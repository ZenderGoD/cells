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

export interface BrowserCanvasWheelGesture {
  deltaX: number
  deltaY: number
  clientX: number
  clientY: number
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
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
 *   plan    — read-only planning; agent can look but cannot write or run commands
 *   ask     — agent asks before every write / command
 *   bypass  — yolo; nothing is gated, no confirmations ever
 *
 * Legacy values ('safe', 'allow-all') from older sessions are coerced into
 * this set at the UI and backend boundaries ('safe' → 'plan', 'allow-all' → 'ask').
 */
export type AgentPermissionMode = 'plan' | 'ask' | 'bypass'

/**
 * Matches Craft's `ThinkingLevel` (../craft-agents-oss/packages/shared/src/agent/thinking-levels.ts).
 *   off     — no extended reasoning
 *   low     — lightest reasoning pass
 *   medium  — balanced (default)
 *   high    — deep reasoning
 *   max     — absolute maximum effort
 *   xhigh   — Codex-side extra-high tier (surfaced when the CLI reports it)
 */
export type AgentThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max' | 'xhigh'

/** A user message queued while the agent was running. Persisted on the
 *  AgentWindowNode so the queue survives app restart. */
export interface QueuedAgentMessage {
  /** Stable id for React keys + Framer layoutIds — two entries with
   *  identical content would otherwise collide and one would be hidden. */
  id: string
  text: string
  attachments: string[]
  /**
   * How this message should interrupt the in-flight turn:
   * - 'after-turn' (↩): wait for the current turn to finish naturally.
   * - 'after-tool' (⌥↩): cut in after the next tool call completes.
   * - 'stop' (⌘↩): interrupt immediately.
   */
  mode: 'after-turn' | 'after-tool' | 'stop'
  /** Snapshot of the selected model/thinking/permission at queue time.
   *  Forwarded as overrides so the queued message runs against the settings
   *  the user chose when enqueuing, not whatever is currently active. */
  model: string | null
  thinkingLevel: AgentThinkingLevel | null
  permissionMode: AgentPermissionMode | null
}

/** Minimap/overview status for an agent window. Richer than the main-process
 *  session status so the minimap can differentiate approval/input needs from
 *  plain "working" — derived from the session snapshot in the renderer. */
export type AgentWindowStatus =
  | 'idle'
  | 'running'
  | 'error'
  | 'awaiting-approval'
  | 'awaiting-input'
  | 'plan-ready'

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
  status?: AgentWindowStatus
  error?: string | null
  claudeSessionId?: string | null
  codexThreadId?: string | null
  cwd?: string | null
  initialPrompt?: string | null
  model?: AgentModel | null
  permissionMode?: AgentPermissionMode | null
  thinkingLevel?: AgentThinkingLevel | null
  fastMode?: boolean | null
  /** Claude-only: opt into the 1M-token context-window beta (Sonnet 4/4.5).
   *  When 'default' (or null), the regular 200k window is used. */
  contextLength?: AgentContextLength | null
  createdAt?: number | null
  /** Draft currently sitting in the composer for this window. Persisted so
   *  switching projects/windows or restarting the app doesn't wipe in-progress
   *  user input. */
  composerDraft?: string | null
  /** Absolute paths of files/images currently attached in the composer draft. */
  composerAttachments?: string[]
  /** Messages the user queued while a prior turn was in flight. Persisted so
   *  they survive app restart — the chat panel drains them in order on the
   *  next idle. */
  queuedMessages?: QueuedAgentMessage[]
  /** Set when the agent finishes a turn while the user isn't viewing this
   *  window, cleared when the window regains focus. Surfaces a distinct
   *  "done and unchecked" indicator so users can spot completed work. */
  hasUnviewedCompletion?: boolean
  /** Optional color accent so users can visually group agent windows. See
   *  `lib/agent-window-colors.ts` for the palette. */
  color?: import('../lib/agent-window-colors').AgentWindowColorId | null
}

export interface AgentSessionDefaults {
  model?: AgentModel | null
  permissionMode?: AgentPermissionMode | null
  thinkingLevel?: AgentThinkingLevel | null
  contextLength?: AgentContextLength | null
}

/** Context-window variant the user has selected. Only 'extended' (1M) and
 *  'default' (whatever the model's native window is) are meaningful today;
 *  Claude Sonnet 4/4.5 is the only model that accepts 'extended'. */
export type AgentContextLength = 'default' | 'extended'

/** Rolling per-session token accounting, sourced from the agent's latest
 *  turn-completion event. `usedTokens` is the best available approximation of
 *  the active context load and is capped to `contextWindow` when known.
 *  `totalProcessedTokens` is the full token volume handled during the latest
 *  completed turn, which can exceed the active context window after
 *  compaction/truncation. `inputTokens` already includes cached reads. */
export interface AgentUsageStats {
  model: string | null
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  contextWindow: number | null
  usedTokens: number | null
  totalProcessedTokens: number | null
  compactsAutomatically: boolean
  updatedAt: number
}

export type AgentSessionMessageRole =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'system'
  | 'error'
  | 'auth_request'
  | 'compaction'

export interface AgentSessionMessage {
  id: string
  role: AgentSessionMessageRole
  text: string
  title?: string | null
  metadata?: string | null
  status?: 'in_progress' | 'completed' | 'failed'
  startedAt?: number | null
  updatedAt?: number | null
  /** Absolute paths of files the user attached to this message. Images render
   * as thumbnails inline in the bubble; the same paths are forwarded to the
   * agent as proper multimodal content blocks rather than `[path]` strings. */
  attachments?: string[]
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
  contextLength?: AgentContextLength | null
}

/** When the Claude agent invokes `ExitPlanMode` and we're waiting for the
 *  user to approve/reject the plan. The backend holds the `canUseTool`
 *  promise open; the UI renders a banner and calls `respondPlan` with
 *  the user's choice to resolve it. Cleared the moment the user responds. */
export interface PendingPlanApproval {
  /** Markdown plan body the agent produced. */
  plan: string
  /** Unix ms when the plan landed; lets the UI show "prepared N s ago". */
  createdAt: number
}

/** One choice in an AskUserQuestion prompt. Mirrors the SDK's option shape. */
export interface PendingQuestionOption {
  label: string
  description: string
  preview?: string
}

/** One question in an AskUserQuestion prompt. */
export interface PendingQuestion {
  id?: string
  question: string
  header: string
  options: PendingQuestionOption[]
  multiSelect: boolean
}

/** Backend-held snapshot of the AskUserQuestion invocation. The renderer
 *  displays a Q&A banner and calls `respondQuestion` to resolve. */
export interface PendingQuestionApproval {
  questions: PendingQuestion[]
  createdAt: number
}

export interface PendingAgentApproval {
  kind: 'command' | 'file-change'
  title: string
  detail?: string | null
  reason?: string | null
  command?: string | null
  cwd?: string | null
  grantRoot?: string | null
  canApproveForSession?: boolean
  createdAt: number
}

/** One entry in Codex's rolling todo_list. */
export interface CodexPlanItem {
  text: string
  completed: boolean
}

/** Latest Codex todo_list snapshot — surfaced as a persistent banner above
 *  the composer while the agent works. Cleared when the turn ends. */
export interface CodexPlanSnapshot {
  items: CodexPlanItem[]
  updatedAt: number
}

export interface AgentSessionSnapshot {
  windowId: string
  agent: Extract<AgentName, 'claude' | 'codex'>
  title: string
  cwd?: string | null
  /** True only on the first snapshot returned after we reconstruct a session
   *  from on-disk state during app startup. Lets the UI show "resume" affordances
   *  for recovered sessions without re-triggering them on ordinary remounts. */
  restoredFromPersist?: boolean
  status: 'idle' | 'running' | 'error'
  error?: string | null
  claudeSessionId?: string | null
  codexThreadId?: string | null
  updatedAt: number
  messages: AgentSessionMessage[]
  usage?: AgentUsageStats | null
  pendingPlanApproval?: PendingPlanApproval | null
  pendingQuestion?: PendingQuestionApproval | null
  pendingApproval?: PendingAgentApproval | null
  codexPlan?: CodexPlanSnapshot | null
}

export interface SavedAgentSessionSummary {
  windowId: string
  agent: Extract<AgentName, 'claude' | 'codex'>
  title: string
  cwd?: string | null
  claudeSessionId?: string | null
  codexThreadId?: string | null
  model?: string | null
  updatedAt: number
  messageCount: number
  lastMessageText?: string | null
}

export interface RecentAgentSessionSummary {
  origin: 'cells' | 'native'
  windowId?: string | null
  nativeId?: string | null
  agent: Extract<AgentName, 'claude' | 'codex'>
  title: string
  cwd?: string | null
  claudeSessionId?: string | null
  codexThreadId?: string | null
  model?: string | null
  updatedAt: number
  messageCount?: number | null
  lastMessageText?: string | null
  sourceLabel: string
}

export interface AgentNotificationSettings {
  enabled: boolean
  playSound: boolean
  onlyWhenUnfocused: boolean
  notifyOnDone: boolean
  notifyOnAttention: boolean
  notifyOnError: boolean
}

export interface AgentNotificationContext {
  activeProjectId: string | null
  focusedAgentWindowId: string | null
}

export interface FocusAgentWindowRequest {
  windowId: string
  projectId?: string | null
}

export interface AgentMentionSearchResult {
  type: 'skill' | 'file' | 'folder'
  label: string
  relativePath: string
  absolutePath: string
  description?: string | null
  sourceRoot: '.agents' | '.claude' | '.codex'
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
  lastAgentSessionDefaults?: Partial<
    Record<Extract<AgentName, 'claude' | 'codex'>, AgentSessionDefaults>
  >
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
  agentNotificationSettings?: Partial<AgentNotificationSettings>
  searchEngine?: string
  homePage?: string
  terminalLinkTarget?: 'system' | 'browser'
  terminalLinkProjectId?: string | null
  linkRules?: Array<{ pattern: string; target: 'system' | 'browser'; projectId?: string }>
  directoryLinkTarget?: 'finder' | 'terminal'
  agentAliases?: Record<string, string>
  agentPaths?: Record<string, string>
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
    send(
      windowId: string,
      input: string,
      attachments?: string[],
      overrides?: {
        model?: string | null
        thinkingLevel?: AgentThinkingLevel | null
        permissionMode?: AgentPermissionMode | null
      },
    ): Promise<void>
    close(windowId: string): Promise<void>
    dispose(windowId: string): Promise<void>
    getAuth(agent: 'claude' | 'codex'): Promise<{
      agent: 'claude' | 'codex'
      binaryPath: string | null
      authenticated: boolean | 'unknown'
      account?: string | null
    }>
    getLoginCommand(agent: 'claude' | 'codex'): Promise<string>
    startLogin(agent: 'claude' | 'codex'): Promise<void>
    cancelLogin(agent: 'claude' | 'codex'): Promise<void>
    updatePermissionMode(windowId: string, mode: AgentPermissionMode | null): Promise<void>
    updateContextLength(windowId: string, length: AgentContextLength | null): Promise<void>
    respondPlan(
      windowId: string,
      decision: 'auto-accept' | 'ask' | 'reject',
      feedback?: string,
    ): Promise<void>
    /** Resolve an AskUserQuestion prompt with the user's answers.
     *  Key = original question text (matches SDK output schema).
     *  Value = array of chosen option labels (single entry for single-select).
     *  Pass `null` to cancel the prompt (treated as declined). */
    respondQuestion(windowId: string, answers: Record<string, string[]> | null): Promise<void>
    respondApproval(
      windowId: string,
      decision: 'accept' | 'acceptForSession' | 'decline',
    ): Promise<void>
    listCodexModels(): Promise<
      Array<{
        id: string
        displayName: string
        description: string
        isDefault: boolean
        hidden: boolean
        supportedReasoningEfforts: Array<{ effort: string; description: string }>
        defaultReasoningEffort: string
      }>
    >
    listClaudeModels(): Promise<
      Array<{
        id: string
        displayName: string
        description: string
        supportsEffort: boolean
        supportedEffortLevels: string[]
        supportsAdaptiveThinking: boolean
      }>
    >
    listSavedSessions(): Promise<SavedAgentSessionSummary[]>
    listRecentSessions(
      agent: 'claude' | 'codex',
      limit?: number,
    ): Promise<RecentAgentSessionSummary[]>
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
    checkAvailable(
      aliases?: Record<string, string>,
      paths?: Record<string, string>,
    ): Promise<Record<string, boolean>>
    setCustomPaths(paths: Record<string, string>): Promise<void>
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
    enabled: boolean
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
    onCanvasWheel(
      callback: (browserId: string, gesture: BrowserCanvasWheelGesture) => void,
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
    onFocusAgentWindow(callback: (request: FocusAgentWindowRequest) => void): () => void
    onCanvasZoom(callback: (command: 'fit' | 'in' | 'out') => void): () => void
    updateNotificationContext(context: AgentNotificationContext): void
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
    searchAgentMentions(cwd: string, query: string): Promise<AgentMentionSearchResult[]>
    getPathForFile(file: File): string
    saveTempFile(data: Uint8Array, filename: string): Promise<string | null>
    pasteClipboardFiles(): Promise<string[] | null>
    openExternal(url: string): Promise<void>
    statPath(targetPath: string): Promise<{ kind: 'file' | 'dir' | 'missing'; resolved: string }>
    revealPath(targetPath: string): Promise<void>
    requestQuit(): Promise<void>
    relaunch(): Promise<void>
    repairTerminalFonts(): Promise<void>
    showNotification(
      title: string,
      body: string,
      options?: {
        playSound?: boolean
        focusAgentWindowId?: string | null
        focusProjectId?: string | null
      },
    ): Promise<void>
    beep(): void
    getShellHistory(): Promise<string[]>
    fileThumbnail(filePath: string, maxHeight?: number): Promise<string | null>
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
