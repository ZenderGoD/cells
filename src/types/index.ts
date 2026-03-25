export interface CanvasTransform {
  x: number
  y: number
  scale: number
}

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
}

export interface BrowserHistoryEntry {
  url: string
  title: string
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
  searchEngine?: string
  homePage?: string
}

/** @deprecated Old flat state — kept for migration */
export interface AppState {
  terminals: TerminalNode[]
  canvas: CanvasTransform
  terminalTheme?: string
  fontSize?: number
  fontFamily?: string
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
    onData(callback: (termId: string, data: string) => void): () => void
    onExit(callback: (termId: string) => void): () => void
  }
  agent: {
    checkAvailable(): Promise<Record<string, boolean>>
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
    getAllHistory(): Promise<Record<
      string,
      { entries: Array<{ url: string; title: string }>; activeIndex: number }
    > | null>
    onThemeColor(callback: (browserId: string, color: string) => void): () => void
    onOverscroll(
      callback: (browserId: string, progress: number, direction: string | null) => void,
    ): () => void
    onWindowCycle(callback: (direction: 1 | -1) => void): () => void
    onProjectCycle(callback: () => void): () => void
  }
  app: {
    onBeforeQuit(callback: () => void): () => void
    onNewTerminal(callback: () => void): () => void
    onCloseTerminal(callback: () => void): () => void
    toggleMaximize(): Promise<void>
    pickFolder(): Promise<string | null>
    getPathForFile(file: File): string
    saveTempFile(data: Uint8Array, filename: string): Promise<string | null>
    pasteClipboardFiles(): Promise<string[] | null>
  }
}

declare global {
  interface Window {
    cells: CellsAPI
  }
}
