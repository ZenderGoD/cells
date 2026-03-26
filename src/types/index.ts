export interface CanvasTransform {
  x: number
  y: number
  scale: number
}

export type AgentStatus = 'active' | 'unread' | 'done' | null

export interface TerminalNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  title: string
  zIndex?: number
  pinned?: boolean
  agent?: 'claude' | 'codex' | null
  agentStatus?: AgentStatus
  processRunning?: boolean
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

export interface Project {
  id: string
  name: string
  path: string
  terminals: TerminalNode[]
  browsers: BrowserNode[]
  canvas: CanvasTransform
  focusedTerminalId?: string | null
  focusedBrowserId?: string | null
  lastOpenedAt: number
  worktreesDir?: string
  /** Branch to use as base when creating new worktrees (defaults to current HEAD) */
  worktreeBaseBranch?: string
  /** Per-window focus counts for usage-based grid arrangement */
  focusCounts?: Record<string, number>
  autoArrangeOnCreate?: boolean
}

export interface ProjectsState {
  version: 2
  activeProjectId: string | null
  projects: Project[]
  terminalTheme?: string
  fontSize?: number
  fontFamily?: string
  windowOpacity?: number
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
  agentAliases?: Record<string, string>
  /** Per-agent visibility override: true = always show, false = always hide, 'auto' = detect binary */
  enabledAgents?: Record<string, boolean | 'auto'>
  inputPrefixes?: InputPrefix[]
  colorScheme?: 'light' | 'dark' | 'system'
  closeUndoTimeoutMs?: number
  closeProcessSuppressions?: string[]
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
    ): Promise<{ reattached: boolean; buffer: string }>
    unsubscribe(termId: string): Promise<void>
    detach(termId: string): Promise<void>
    write(termId: string, data: string): void
    resize(termId: string, cols: number, rows: number): void
    getProcess(termId: string): Promise<string | null>
    getProcessInfo(termId: string): Promise<TerminalProcessInfo | null>
    getCodexTitle(termId: string): Promise<string | null>
    onData(callback: (termId: string, data: string) => void): () => void
    onExit(callback: (termId: string) => void): () => void
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
    getStatus(): Promise<{
      enabled: boolean
      connected: boolean
      sessionCount: number
      appVersion: string
      daemonVersion: {
        protocolVersion: number
        appVersion: string | null
        pid: number
        uptime: number
      } | null
    }>
    listSessions(): Promise<
      Array<{
        termId: string
        processInfo: TerminalProcessInfo | null
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
    install(): Promise<void>
    getVersion(): Promise<string>
    setAutoUpdate(enabled: boolean): Promise<void>
    onStatus(callback: (status: string, info?: any) => void): () => void
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
    onBeforeQuit(callback: () => void): () => void
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
    getPinnedId(): string | null
    getPinnedType(): 'terminal' | 'browser' | null
    pickFolder(): Promise<string | null>
    pickFiles(): Promise<string[] | null>
    listRecentFiles(): Promise<Array<{ path: string; name: string; mtime: number; source: string }>>
    getPathForFile(file: File): string
    saveTempFile(data: Uint8Array, filename: string): Promise<string | null>
    pasteClipboardFiles(): Promise<string[] | null>
    openExternal(url: string): Promise<void>
    requestQuit(): Promise<void>
  }
  mcp: {
    install(projectPath: string): Promise<{
      configPath: string
      symlinks: string[]
      serverPath: string
    }>
  }
}

declare global {
  interface Window {
    cells: CellsAPI
  }
}
