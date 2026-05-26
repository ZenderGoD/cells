import type {
  AgentName,
  AgentSessionMessage,
  AgentSessionName,
  AgentSessionRequest,
  AgentSessionSnapshot,
  AppShortcutPayload,
  AgentMentionSearchResult,
  AgentContextLength,
  AgentNotificationContext,
  AgentPermissionMode,
  BrowserCanvasWheelGesture,
  BrowserElementSelection,
  BrowserHistoryEntry,
  BrowserViewFailure,
  CellsAPI,
  EditorLspDiagnosticsPayload,
  EditorLspOpenRequest,
  EditorLspPosition,
  ExtensionMeta,
  ExtensionsState,
  FocusAgentWindowRequest,
  GitBranchValidation,
  GitWorktree,
  GitWorktreeCreateOptions,
  PerfEventRecord,
  PerfMonitorStatus,
  ProjectsState,
  ProjectFileSearchResult,
  RendererPerfSample,
  TerminalExitDetails,
  TerminalProcessInfo,
  TerminalPerfSample,
  TerminalRuntimeStatus,
  QueuedAgentMessage,
} from './types'
import type { CellsShortcutCommand } from './lib/cells-shortcuts'
import { sanitizeQueuedMessages } from './lib/agent-session-queue'
import { useStore } from './lib/store'

type Listener<T extends (...args: any[]) => void> = T
type PinnedWindowType = 'terminal' | 'browser' | 'agent' | 'editor' | 'section'
type NwWindowHandle = {
  close(force?: boolean): void
  focus?(): void
  show?(): void
  hide?(): void
  minimize?(): void
  enterFullscreen?(): void
  leaveFullscreen?(): void
  toggleFullscreen?(): void
  isFullscreen?: boolean
  on?(event: string, callback: (...args: any[]) => void): void
  window?: Window
}

interface NwGui {
  Menu: new (options?: { type?: string }) => {
    append(item: unknown): void
    popup?(x?: number, y?: number): void
  }
  MenuItem: new (options: {
    label?: string
    submenu?: unknown
    key?: string
    modifiers?: string
    type?: 'separator'
    enabled?: boolean
    click?: () => void
  }) => unknown
  Window: {
    get(): NwWindowHandle & {
      menu?: unknown
      isMaximized?: boolean
      maximize?: () => void
      unmaximize?: () => void
      showDevTools?: (target?: unknown) => void
    }
    open?(
      url: string,
      options: Record<string, unknown>,
      callback?: (win: NwWindowHandle) => void,
    ): void
  }
  Shell?: {
    openExternal?: (url: string) => void
  }
}

const NW_SHORTCUT_MENU_ITEMS: Array<{
  label: string
  command: CellsShortcutCommand
  key: string
  modifiers: string
}> = [
  { label: 'Command Palette', command: 'toggle-command-palette', key: 't', modifiers: 'cmd' },
  { label: 'Settings', command: 'open-settings', key: ',', modifiers: 'cmd' },
  { label: 'Project Switcher', command: 'toggle-project-switcher', key: 'a', modifiers: 'ctrl' },
  { label: 'Selection Mode', command: 'toggle-selection-mode', key: 's', modifiers: 'ctrl' },
  { label: 'Close Window', command: 'close-window', key: 'w', modifiers: 'cmd' },
  {
    label: 'Restore Closed Window',
    command: 'restore-last-closed',
    key: 't',
    modifiers: 'cmd-shift',
  },
  { label: 'Pin Focused Window', command: 'toggle-pin-focused', key: 'p', modifiers: 'cmd-shift' },
  { label: 'Quit Cells', command: 'quit-app', key: 'q', modifiers: 'cmd' },
  { label: 'Reload Focused Browser', command: 'reload-focused', key: 'r', modifiers: 'cmd' },
  { label: 'Browser Back', command: 'browser-back', key: '[', modifiers: 'cmd' },
  { label: 'Browser Forward', command: 'browser-forward', key: ']', modifiers: 'cmd' },
  { label: 'Open Browser Location', command: 'open-browser-location', key: 'l', modifiers: 'cmd' },
  { label: 'Copy Browser URL', command: 'copy-browser-url', key: 'c', modifiers: 'cmd-shift' },
  { label: 'Toggle Title Bar', command: 'toggle-title-bar-hidden', key: 's', modifiers: 'cmd' },
  {
    label: 'Toggle Title Bar Position',
    command: 'toggle-title-bar-position',
    key: 's',
    modifiers: 'cmd-shift',
  },
  { label: 'Zoom To Fit Focused', command: 'zoom-to-fit-focused', key: '0', modifiers: 'cmd' },
  { label: 'Zoom To Fit All', command: 'zoom-to-fit-all', key: 'o', modifiers: 'cmd' },
  { label: 'Zoom Focused In', command: 'zoom-focused-window-in', key: '=', modifiers: 'cmd' },
  { label: 'Zoom Focused Out', command: 'zoom-focused-window-out', key: '-', modifiers: 'cmd' },
  { label: 'Snap Focused Window', command: 'snap-focused-window', key: 'Enter', modifiers: 'cmd' },
  {
    label: 'Fit Focused To Viewport',
    command: 'resize-focused-to-fit-viewport',
    key: 'Enter',
    modifiers: 'cmd-shift',
  },
  {
    label: 'Resize App To Focused',
    command: 'resize-window-to-fit-focused',
    key: '0',
    modifiers: 'cmd-shift',
  },
  { label: 'Snap Left', command: 'snap-left', key: 'Left', modifiers: 'cmd' },
  { label: 'Snap Right', command: 'snap-right', key: 'Right', modifiers: 'cmd' },
  { label: 'Snap Up', command: 'snap-up', key: 'Up', modifiers: 'cmd' },
  { label: 'Snap Down', command: 'snap-down', key: 'Down', modifiers: 'cmd' },
]

const NW_MENU_LABELS = {
  app: 'Cells',
  edit: 'Edit',
  window: 'Window',
  view: 'View',
  appItems: ['About Cells', 'Hide Cells', 'Quit Cells'],
  editItems: ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All'],
  windowItems: ['Close Window', 'Minimize', 'Zoom'],
  viewItems: [
    'Toggle Developer Tools',
    'Fit Focused Window',
    'Zoom Toward Focused Window',
    'Zoom Away From Focused Window',
    'Toggle Full Screen',
  ],
}
type NwPopoutMessage =
  | {
      kind: 'unpinned'
      id: string
      type: PinnedWindowType
      snapshot?: { url?: string | null; title?: string | null } | null
    }
  | { kind: 'resized'; id: string; type: PinnedWindowType; width: number; height: number }

function createEmitter<T extends (...args: any[]) => void>() {
  const listeners = new Set<Listener<T>>()
  return {
    emit: (...args: Parameters<T>) => {
      for (const listener of listeners) listener(...args)
    },
    on: (listener: Listener<T>) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const browserTitle = createEmitter<(browserId: string, title: string) => void>()
const browserUrl = createEmitter<(browserId: string, url: string) => void>()
const browserNav =
  createEmitter<(browserId: string, canGoBack: boolean, canGoForward: boolean) => void>()
const browserLoading = createEmitter<(browserId: string, loading: boolean) => void>()
const browserFocused = createEmitter<(browserId: string) => void>()
const browserNewWindow = createEmitter<(browserId: string, url: string) => void>()
const browserFavicon = createEmitter<(browserId: string, faviconUrl: string | null) => void>()
const browserFailure = createEmitter<(browserId: string, failure: BrowserViewFailure) => void>()
const browserRenderGone = createEmitter<(browserId: string, failure: BrowserViewFailure) => void>()
const browserTheme = createEmitter<(browserId: string, color: string | null) => void>()
const browserOverscroll =
  createEmitter<(browserId: string, progress: number, direction: string | null) => void>()
const browserCanvasWheel =
  createEmitter<(browserId: string, gesture: BrowserCanvasWheelGesture) => void>()
const browserWindowCycle = createEmitter<(direction: 1 | -1) => void>()
const browserProjectCycle = createEmitter<(direction: 1 | -1) => void>()
const browserElementSelected =
  createEmitter<
    (
      browserId: string,
      targetAgentWindowId: string | null,
      selection: BrowserElementSelection,
    ) => void
  >()
const browserPickerCancelled =
  createEmitter<(browserId: string, targetAgentWindowId: string | null) => void>()

const appWindowFocus = createEmitter<(focused: boolean) => void>()
const focusAgentWindow = createEmitter<(request: FocusAgentWindowRequest) => void>()
const canvasZoom = createEmitter<(command: 'fit' | 'in' | 'out') => void>()
const beforeQuit = createEmitter<() => void>()
const daemonDisconnected = createEmitter<() => void>()
const systemResume = createEmitter<(reason: 'resume' | 'unlock-screen') => void>()
const newTerminal = createEmitter<() => void>()
const closeTerminal = createEmitter<() => void>()
const appShortcut = createEmitter<(payload: AppShortcutPayload) => void>()
const openFiles = createEmitter<(paths: string[]) => void>()
const windowUnpinned =
  createEmitter<
    (
      id: string,
      type: string,
      snapshot?: { url?: string | null; title?: string | null } | null,
    ) => void
  >()
const windowResized =
  createEmitter<(id: string, type: string, width: number, height: number) => void>()
const extensionInstalled = createEmitter<(meta: ExtensionMeta) => void>()
const extensionPopupClosed = createEmitter<() => void>()
const updaterStatus = createEmitter<(status: string, info?: any) => void>()
const terminalData = createEmitter<(termId: string, data: string) => void>()
const terminalStatus =
  createEmitter<(termId: string, status: TerminalRuntimeStatus | null) => void>()
const terminalExit = createEmitter<(termId: string, details?: TerminalExitDetails) => void>()
const lspDiagnostics = createEmitter<(payload: EditorLspDiagnosticsPayload) => void>()
const agentUpdate = createEmitter<(snapshot: AgentSessionSnapshot) => void>()
const agentQueueUpdate =
  createEmitter<(update: { windowId: string; queuedMessages: QueuedAgentMessage[] }) => void>()
const agentLoginEvent =
  createEmitter<
    (event: {
      agent: AgentSessionName
      phase: 'starting' | 'awaiting_browser' | 'success' | 'failed' | 'cancelled'
      url?: string | null
      message?: string | null
    }) => void
  >()

let cachedAgentNotificationContext: AgentNotificationContext = {
  activeProjectId: null,
  focusedAgentWindowId: null,
}

interface NwPtySession {
  termId: string
  pty: {
    pid: number
    process?: string
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(signal?: string): void
    onData(callback: (data: string) => void): { dispose(): void }
    onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
  }
  cwd: string
  shell: string
  cols: number
  rows: number
  buffer: string
  exited: boolean
  exitDetails?: TerminalExitDetails
  launch?: {
    agent?: AgentName | null
    command?: string | null
    cwd?: string | null
    startedAt?: number | null
  }
}

interface NwBrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  themeColor: string | null
  faviconUrl: string | null
  failure: BrowserViewFailure | null
  history: { entries: BrowserHistoryEntry[]; activeIndex: number }
}

const browserStates = new Map<string, NwBrowserState>()
const extensionState: ExtensionsState = { extensions: [], projectExtensions: {} }
const extensionPopupPaths = new Map<string, string>()
const ptySessions = new Map<string, NwPtySession>()
const terminalSubscriptionCounts = new Map<string, number>()
const terminalLaunches = new Map<
  string,
  {
    agent?: AgentName | null
    command?: string | null
    cwd?: string | null
    startedAt?: number | null
  }
>()
const agentSessions = new Map<string, AgentSessionSnapshot>()
const agentProcesses = new Map<string, import('node:child_process').ChildProcess>()
const agentQueues = new Map<string, QueuedAgentMessage[]>()
const agentQueueRequests = new Map<string, AgentSessionRequest>()
const agentQueuePauseReasons = new Map<string, Set<string>>()
const pinnedWindows = new Map<string, NwWindowHandle>()
const pinnedWindowTypes = new Map<string, PinnedWindowType>()
const pinnedUnpinNotified = new Set<string>()
let customAgentPaths: Record<string, string> = {}
let messageCounter = 0
let lastNwWebviewFocusAt = 0
let nwAppBlurTimer: number | null = null
let beforeQuitEmitted = false

function emitBeforeQuitOnce() {
  if (beforeQuitEmitted) return
  beforeQuitEmitted = true
  beforeQuit.emit()
}

const AGENT_BINARY_CANDIDATES: Record<AgentSessionName, string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  cursor: ['cursor-agent', 'cursor'],
  copilot: ['copilot'],
  opencode: ['opencode'],
}

const AGENT_LOGIN_COMMANDS: Record<AgentSessionName, string> = {
  claude: 'claude',
  codex: 'codex login',
  cursor: 'cursor-agent login',
  copilot: 'copilot auth login',
  opencode: 'opencode auth login',
}

function defaultBrowserState(): NwBrowserState {
  return {
    url: '',
    title: '',
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    themeColor: null,
    faviconUrl: null,
    failure: null,
    history: { entries: [], activeIndex: -1 },
  }
}

function getBrowserState(browserId: string) {
  const existing = browserStates.get(browserId)
  if (existing) return existing
  const created = defaultBrowserState()
  browserStates.set(browserId, created)
  return created
}

function dispatchBrowserCommand(
  browserId: string,
  command: string,
  detail: Record<string, unknown> = {},
) {
  window.dispatchEvent(
    new CustomEvent('cells-nw-browser-command', {
      detail: { browserId, command, ...detail },
    }),
  )
}

function writeClipboardText(text: string) {
  if (!text) return
  try {
    const gui = requireNode<
      NwGui & { Clipboard?: { get?: () => { set?: (text: string, type?: string) => void } } }
    >('nw.gui')
    const clipboard = gui.Clipboard?.get?.()
    if (clipboard?.set) {
      clipboard.set(text, 'text')
      return
    }
  } catch {}
  void navigator.clipboard?.writeText(text).catch(() => {})
}

function imageDefaultName(imageUrl: string) {
  try {
    const name = requireNode<typeof import('node:path')>('node:path').basename(
      new URL(imageUrl).pathname,
    )
    return name && name !== '/' ? name : 'image'
  } catch {
    return 'image'
  }
}

function isImagePath(filePath: string) {
  return /\.(apng|avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(filePath)
}

function mimeTypeForPath(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'apng':
      return 'image/apng'
    case 'avif':
      return 'image/avif'
    case 'bmp':
      return 'image/bmp'
    case 'gif':
      return 'image/gif'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'svg':
      return 'image/svg+xml'
    case 'webp':
      return 'image/webp'
    default:
      return 'image/png'
  }
}

function plistDecodeString(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

async function readUrlBytes(url: string): Promise<Buffer> {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/)
    if (!match) throw new Error('Invalid data URL.')
    const [, , base64, payload] = match
    return Buffer.from(decodeURIComponent(payload), base64 ? 'base64' : 'utf8')
  }
  if (url.startsWith('file://')) {
    const fs = requireNode<typeof import('node:fs')>('node:fs')
    const { fileURLToPath } = requireNode<typeof import('node:url')>('node:url')
    return fs.readFileSync(fileURLToPath(url))
  }
  if (!/^https?:\/\//i.test(url)) throw new Error(`Unsupported image URL: ${url}`)

  const protocol = url.startsWith('https:') ? 'node:https' : 'node:http'
  const client = requireNode<typeof import('node:https') | typeof import('node:http')>(protocol)
  return new Promise((resolve, reject) => {
    client
      .get(url, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume()
          readUrlBytes(new URL(response.headers.location, url).toString()).then(resolve, reject)
          return
        }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume()
          reject(new Error(`Image download failed with HTTP ${response.statusCode ?? 'unknown'}.`))
          return
        }
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolve(Buffer.concat(chunks)))
      })
      .on('error', reject)
  })
}

function readDarwinClipboardFilePaths() {
  if (getNodeProcess()?.platform !== 'darwin') return []
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const childProcess = requireNode<typeof import('node:child_process')>('node:child_process')

  try {
    const result = childProcess.spawnSync(
      'osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        `
      ObjC.import('AppKit')
      const pb = $.NSPasteboard.generalPasteboard
      const urls = pb.readObjectsForClassesOptions($([$.NSURL.class]), $())
      const out = []
      if (urls) {
        for (let i = 0; i < urls.count; i++) {
          const url = urls.objectAtIndex(i)
          if (url.isFileURL) out.push(ObjC.unwrap(url.path))
        }
      }
      out.join('\\n')
    `,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry && fs.existsSync(entry))
    }
  } catch {}

  try {
    const result = childProcess.spawnSync('pbpaste', ['-Prefer', 'file'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout
        .split(/\r?\n/)
        .map((entry) => {
          const match = entry.match(/<string>(.*?)<\/string>/)
          return match ? plistDecodeString(match[1]) : entry.trim()
        })
        .filter((entry) => entry && fs.existsSync(entry))
    }
  } catch {}

  return []
}

function readDarwinClipboardImageToTempFile() {
  if (getNodeProcess()?.platform !== 'darwin') return null
  const childProcess = requireNode<typeof import('node:child_process')>('node:child_process')
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const os = requireNode<typeof import('node:os')>('node:os')
  const path = requireNode<typeof import('node:path')>('node:path')
  if (!commandExists('pngpaste')) return null
  const dir = path.join(os.tmpdir(), 'cells-nw-clipboard')
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `clipboard-${Date.now()}.png`)
  const result = childProcess.spawnSync('pngpaste', [target], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  return result.status === 0 && fs.existsSync(target) ? target : null
}

function chooseImageSavePath(defaultName: string) {
  const path = requireNode<typeof import('node:path')>('node:path')
  const os = requireNode<typeof import('node:os')>('node:os')
  const nodeProcess = getNodeProcess()
  if (nodeProcess?.platform === 'darwin') {
    const childProcess = requireNode<typeof import('node:child_process')>('node:child_process')
    const script = [
      `set savePath to choose file name with prompt "Save Image As" default name ${JSON.stringify(defaultName)}`,
      'POSIX path of savePath',
    ].join('\n')
    const result = childProcess.spawnSync('osascript', ['-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const selected = result.status === 0 ? result.stdout.trim() : ''
    if (selected) return selected
    return null
  }
  return path.join(os.homedir(), 'Downloads', defaultName)
}

async function saveImageAs(imageUrl: string) {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  const savePath = chooseImageSavePath(imageDefaultName(imageUrl))
  if (!savePath) return
  const bytes = await readUrlBytes(imageUrl)
  fs.mkdirSync(path.dirname(savePath), { recursive: true })
  fs.writeFileSync(savePath, bytes)
}

async function copyImageToClipboard(imageUrl: string) {
  const nodeProcess = getNodeProcess()
  if (nodeProcess?.platform === 'darwin') {
    try {
      const fs = requireNode<typeof import('node:fs')>('node:fs')
      const os = requireNode<typeof import('node:os')>('node:os')
      const path = requireNode<typeof import('node:path')>('node:path')
      const childProcess = requireNode<typeof import('node:child_process')>('node:child_process')
      const bytes = await readUrlBytes(imageUrl)
      const target = path.join(
        os.tmpdir(),
        `cells-nw-image-${Date.now()}-${imageDefaultName(imageUrl)}`,
      )
      fs.writeFileSync(target, bytes)
      const script = `set the clipboard to (read (POSIX file ${JSON.stringify(target)}))`
      const result = childProcess.spawnSync('osascript', ['-e', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      fs.rmSync(target, { force: true })
      if (result.status === 0) return
    } catch {}
  }
  writeClipboardText(imageUrl)
}

function runWebviewEditCommand(browserId: string, command: string) {
  dispatchBrowserCommand(browserId, 'script', {
    code: `document.execCommand(${JSON.stringify(command)}); true`,
  })
}

function getNwBrowserContextMenuLabels(params: {
  linkUrl?: string | null
  imageUrl?: string | null
  isEditable?: boolean
  selectionText?: string
}) {
  const labels = ['Back', 'Forward', 'Reload']
  if (params.linkUrl) labels.push('Open Link in New Browser', 'Copy Link Address')
  if (params.imageUrl) labels.push('Save Image As...', 'Copy Image', 'Copy Image Address')
  if (params.isEditable) {
    labels.push('Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All')
  } else if (params.selectionText) {
    labels.push('Copy')
  }
  labels.push('Inspect Element')
  return labels
}

function showNwBrowserContextMenu(
  browserId: string,
  params: {
    x?: number
    y?: number
    linkUrl?: string | null
    imageUrl?: string | null
    isEditable?: boolean
    selectionText?: string
  },
) {
  const menuItems = getNwBrowserContextMenuLabels(params)
  window.dispatchEvent(
    new CustomEvent('cells-nw-browser-context-menu-shown', {
      detail: { browserId, ...params, menuItems },
    }),
  )
  if (getNodeProcess()?.env.CELLS_NW_CONTEXT_MENU_TEST_MODE === '1') return
  try {
    const gui = requireNode<NwGui>('nw.gui')
    const menu = new gui.Menu()
    const state = getBrowserState(browserId)
    const append = (options: ConstructorParameters<NwGui['MenuItem']>[0]) => {
      menu.append(new gui.MenuItem(options))
    }
    const separator = () => append({ type: 'separator' })

    append({
      label: 'Back',
      enabled: state.canGoBack,
      click: () => dispatchBrowserCommand(browserId, 'back'),
    })
    append({
      label: 'Forward',
      enabled: state.canGoForward,
      click: () => dispatchBrowserCommand(browserId, 'forward'),
    })
    append({ label: 'Reload', click: () => dispatchBrowserCommand(browserId, 'reload') })
    separator()

    if (params.linkUrl) {
      append({
        label: 'Open Link in New Browser',
        click: () => browserNewWindow.emit(browserId, params.linkUrl!),
      })
      append({ label: 'Copy Link Address', click: () => writeClipboardText(params.linkUrl!) })
      separator()
    }

    if (params.imageUrl) {
      append({
        label: 'Save Image As...',
        click: () => {
          void saveImageAs(params.imageUrl!).catch((error) => {
            console.warn('[nw] failed to save image', error)
          })
        },
      })
      append({
        label: 'Copy Image',
        click: () => {
          void copyImageToClipboard(params.imageUrl!).catch((error) => {
            console.warn('[nw] failed to copy image', error)
            writeClipboardText(params.imageUrl!)
          })
        },
      })
      append({ label: 'Copy Image Address', click: () => writeClipboardText(params.imageUrl!) })
      separator()
    }

    if (params.isEditable) {
      append({ label: 'Undo', click: () => runWebviewEditCommand(browserId, 'undo') })
      append({ label: 'Redo', click: () => runWebviewEditCommand(browserId, 'redo') })
      separator()
      append({ label: 'Cut', click: () => runWebviewEditCommand(browserId, 'cut') })
      append({ label: 'Copy', click: () => runWebviewEditCommand(browserId, 'copy') })
      append({ label: 'Paste', click: () => runWebviewEditCommand(browserId, 'paste') })
      append({ label: 'Select All', click: () => runWebviewEditCommand(browserId, 'selectAll') })
      separator()
    } else if (params.selectionText) {
      append({ label: 'Copy', click: () => runWebviewEditCommand(browserId, 'copy') })
      separator()
    }

    append({
      label: 'Inspect Element',
      click: () =>
        dispatchBrowserCommand(browserId, 'inspect', {
          x: Math.max(0, Math.round(params.x ?? 0)),
          y: Math.max(0, Math.round(params.y ?? 0)),
        }),
    })
    menu.popup?.()
  } catch (error) {
    console.warn('[nw] failed to show browser context menu', error)
  }
}

function normalizeUrl(rawUrl: string, searchEngineUrl?: string) {
  const trimmed = rawUrl.trim()
  if (!trimmed) return 'about:blank'
  if (/^(https?:\/\/|file:\/\/|about:|data:|chrome-extension:\/\/)/i.test(trimmed)) return trimmed
  if (
    /^[^\s]+\.[^\s]+$/.test(trimmed) ||
    /^(localhost|127\.0\.0\.1|\[::1])(?::\d+)?/i.test(trimmed)
  ) {
    return `https://${trimmed}`
  }
  return (searchEngineUrl || 'https://www.google.com/search?q=%s').replace(
    '%s',
    encodeURIComponent(trimmed),
  )
}

function getNodeRequire(): NodeRequire | null {
  return typeof window.require === 'function' ? window.require : null
}

function requireNode<T = unknown>(id: string): T {
  const require = getNodeRequire()
  if (!require) throw new Error('Node integration is unavailable in NW.js.')
  return require(id) as T
}

function getNodeProcess(): NodeJS.Process | null {
  return typeof globalThis.process === 'object' ? globalThis.process : null
}

function getHomeDir() {
  const require = getNodeRequire()
  if (!require) return ''
  const nodeProcess = getNodeProcess()
  if (nodeProcess?.env.CELLS_HOME_DIR) return nodeProcess.env.CELLS_HOME_DIR
  if (nodeProcess?.env.HOME) return nodeProcess.env.HOME
  return (require('node:os') as typeof import('node:os')).homedir()
}

function getRealHomeDir() {
  const require = getNodeRequire()
  if (!require) return ''
  const nodeProcess = getNodeProcess()
  if (nodeProcess?.env.CELLS_REAL_HOME) return nodeProcess.env.CELLS_REAL_HOME
  try {
    return (require('node:os') as typeof import('node:os')).userInfo().homedir
  } catch {}
  return nodeProcess?.env.HOME || ''
}

function getUserHomeDir() {
  return getRealHomeDir() || getHomeDir()
}

function getShellPath() {
  const require = getNodeRequire()
  if (!require) return '/bin/zsh'
  const os = require('node:os') as typeof import('node:os')
  return getNodeProcess()?.env.SHELL || (os.platform() === 'win32' ? 'cmd.exe' : '/bin/zsh')
}

function cleanTerminalEnv() {
  const require = getNodeRequire()
  const path = require?.('node:path') as typeof import('node:path') | undefined
  const nodeEnv = { ...(getNodeProcess()?.env ?? {}) } as Record<string, string>
  const realHome = getRealHomeDir()
  const appVersion = nodeEnv.CELLS_APP_VERSION
  const realXdgConfigHome =
    nodeEnv.CELLS_REAL_XDG_CONFIG_HOME?.trim() ||
    (realHome && path ? path.join(realHome, '.config') : nodeEnv.XDG_CONFIG_HOME)
  const realXdgDataHome =
    nodeEnv.CELLS_REAL_XDG_DATA_HOME?.trim() ||
    (realHome && path ? path.join(realHome, '.local', 'share') : nodeEnv.XDG_DATA_HOME)
  const realXdgCacheHome =
    nodeEnv.CELLS_REAL_XDG_CACHE_HOME?.trim() ||
    (realHome && path ? path.join(realHome, '.cache') : nodeEnv.XDG_CACHE_HOME)
  const realXdgStateHome =
    nodeEnv.CELLS_REAL_XDG_STATE_HOME?.trim() ||
    (realHome && path ? path.join(realHome, '.local', 'state') : nodeEnv.XDG_STATE_HOME)

  for (const key of Object.keys(nodeEnv)) {
    if (
      key.startsWith('ELECTRON') ||
      key.startsWith('VITE') ||
      key.startsWith('CHROME_') ||
      key.startsWith('ORIGINAL_XDG_') ||
      key.startsWith('CELLS_')
    ) {
      delete nodeEnv[key]
    }
  }

  delete nodeEnv.NODE_OPTIONS
  if (realHome) nodeEnv.HOME = realHome
  if (realXdgConfigHome) nodeEnv.XDG_CONFIG_HOME = realXdgConfigHome
  if (realXdgDataHome) nodeEnv.XDG_DATA_HOME = realXdgDataHome
  if (realXdgCacheHome) nodeEnv.XDG_CACHE_HOME = realXdgCacheHome
  if (realXdgStateHome) nodeEnv.XDG_STATE_HOME = realXdgStateHome
  nodeEnv.PATH = buildNwUserPathEnv()
  nodeEnv.TERM = 'xterm-256color'
  nodeEnv.COLORTERM = 'truecolor'
  nodeEnv.TERM_PROGRAM = nodeEnv.TERM_PROGRAM || 'ghostty'
  if (appVersion && !nodeEnv.TERM_PROGRAM_VERSION) nodeEnv.TERM_PROGRAM_VERSION = appVersion
  return nodeEnv
}

function execFileText(command: string, args: string[], options: { cwd?: string } = {}) {
  const childProcess = requireNode<typeof import('node:child_process')>('node:child_process')
  try {
    return childProcess
      .execFileSync(command, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      .trim()
  } catch (error) {
    const err = error as Error & { stderr?: Buffer | string }
    const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : err.stderr
    throw new Error(stderr?.trim() || err.message, { cause: error })
  }
}

function execFileStatus(command: string, args: string[], options: { cwd?: string } = {}) {
  const childProcess = requireNode<typeof import('node:child_process')>('node:child_process')
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
    status: result.status,
  }
}

function commandExists(command: string) {
  if (command.includes('/')) {
    const fs = requireNode<typeof import('node:fs')>('node:fs')
    try {
      fs.accessSync(command, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (getNodeProcess()?.platform === 'win32') return execFileStatus('where', [command]).ok
  return resolveNwCommand(command) !== null
}

function resolveAgentBinary(agent: AgentSessionName) {
  const custom = customAgentPaths[agent]?.trim()
  if (custom) return resolveNwCommand(custom)
  for (const candidate of AGENT_BINARY_CANDIDATES[agent] ?? [agent]) {
    const resolved = resolveNwCommand(candidate)
    if (resolved) return resolved
  }
  return null
}

function isProbablyHidden(name: string) {
  return name.startsWith('.') && name !== '.git'
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function createPtySession(termId: string, cols: number, rows: number, cwd?: string | null) {
  const require = getNodeRequire()
  if (!require) throw new Error('Node integration is required for the NW.js terminal backend.')
  const pty = require('node-pty') as typeof import('node-pty')
  const shell = getShellPath()
  const resolvedCwd = cwd || getRealHomeDir() || getHomeDir()
  const env = cleanTerminalEnv()
  const child = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: Math.max(2, cols),
    rows: Math.max(1, rows),
    cwd: resolvedCwd,
    env,
  })

  const session: NwPtySession = {
    termId,
    pty: child,
    cwd: resolvedCwd,
    shell,
    cols,
    rows,
    buffer: '',
    exited: false,
  }
  child.onData((data) => {
    session.buffer += data
    if (session.buffer.length > 500_000) session.buffer = session.buffer.slice(-400_000)
    terminalData.emit(termId, data)
  })
  child.onExit((event) => {
    session.exited = true
    session.exitDetails = {
      reason: 'process-exit',
      message: `Process exited with code ${event.exitCode}`,
      history: session.buffer,
    }
    terminalExit.emit(termId, session.exitDetails)
    terminalStatus.emit(termId, null)
  })
  ptySessions.set(termId, session)
  terminalStatus.emit(termId, buildTerminalStatus(session))
  return session
}

function buildTerminalStatus(session: NwPtySession): TerminalRuntimeStatus | null {
  if (session.exited) return null
  if (session.launch?.agent) {
    return {
      kind: 'agent',
      agent: session.launch.agent,
      state: 'working',
      detail: session.launch.command || session.shell,
      shortLabel: session.launch.agent,
      source: 'nw:pty',
      pid: session.pty.pid,
      processLabel: session.launch.command || session.shell.split('/').pop() || session.shell,
      updatedAt: Date.now(),
    }
  }
  return {
    kind: 'process',
    detail: session.shell,
    shortLabel: 'shell',
    source: 'nw:pty',
    pid: session.pty.pid,
    processLabel: session.shell.split('/').pop() ?? session.shell,
    updatedAt: Date.now(),
  }
}

function getTerminalProcessInfo(session: NwPtySession): TerminalProcessInfo {
  const label = session.shell.split('/').pop() ?? session.shell
  return {
    pid: session.pty.pid,
    command: session.shell,
    label,
    key: label,
    isShell: true,
  }
}

function addTerminalSubscription(termId: string) {
  terminalSubscriptionCounts.set(termId, (terminalSubscriptionCounts.get(termId) ?? 0) + 1)
}

function removeTerminalSubscription(termId: string) {
  const next = (terminalSubscriptionCounts.get(termId) ?? 0) - 1
  if (next > 0) terminalSubscriptionCounts.set(termId, next)
  else terminalSubscriptionCounts.delete(termId)
}

function clearTerminalSubscriptions(termId: string) {
  terminalSubscriptionCounts.delete(termId)
}

function isTerminalSubscribed(termId: string) {
  return (terminalSubscriptionCounts.get(termId) ?? 0) > 0
}

function getStatePath() {
  const require = getNodeRequire()
  if (!require) return null
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const nodeProcess = getNodeProcess()
  const explicitStatePath = nodeProcess?.env.CELLS_STATE_FILE
  if (explicitStatePath) return path.resolve(explicitStatePath)
  const realHomeDir = os.homedir()
  if (
    nodeProcess?.execPath.includes('Cells Dev.app') ||
    nodeProcess?.cwd().includes(`${path.sep}release`)
  ) {
    return path.join(realHomeDir, '.cells-dev', 'home', '.cells', 'state.json')
  }
  const productionHomeDir = getRealHomeDir() || os.homedir() || getHomeDir()
  return path.join(productionHomeDir, '.cells', 'state.json')
}

function getExtensionsMetaPath() {
  const statePath = getStatePath()
  if (!statePath) return null
  const path = requireNode<typeof import('node:path')>('node:path')
  return path.join(path.dirname(statePath), 'extensions.json')
}

function getExtensionsDir() {
  const statePath = getStatePath()
  if (!statePath) return null
  const path = requireNode<typeof import('node:path')>('node:path')
  return path.join(path.dirname(statePath), 'extensions')
}

function readExtensionsState(): ExtensionsState {
  const metaPath = getExtensionsMetaPath()
  if (!metaPath) return { extensions: [], projectExtensions: {} }
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ExtensionsState
  } catch {
    return { extensions: [], projectExtensions: {} }
  }
}

function writeExtensionsState(state: ExtensionsState) {
  const metaPath = getExtensionsMetaPath()
  if (!metaPath) return
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  fs.mkdirSync(path.dirname(metaPath), { recursive: true })
  fs.writeFileSync(metaPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function clearNwRendererCaches() {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  const candidates = [
    path.join(getHomeDir(), 'Library', 'Application Support', 'Cells Dev'),
    path.join(getHomeDir(), 'Library', 'Application Support', 'nwjs'),
  ]
  const cacheEntries = [
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'blob_storage',
    'Session Storage',
    'Shared Dictionary',
    'Network Persistent State',
  ]
  for (const dir of candidates) {
    for (const entry of cacheEntries) {
      try {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
      } catch {}
    }
  }
}

async function repairNwTerminalFonts() {
  const statePath = getStatePath()
  if (statePath) {
    const fs = requireNode<typeof import('node:fs')>('node:fs')
    const legacyNonNerdFonts = new Set([
      '"Geist Mono", "SFMono-Regular", "JetBrains Mono", "Menlo", monospace',
      '"JetBrains Mono", "SFMono-Regular", "Menlo", monospace',
    ])
    const nextFont = '"GeistMono NFM", "Geist Mono", monospace'
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as ProjectsState
      if (!state.fontFamily || legacyNonNerdFonts.has(String(state.fontFamily).trim())) {
        state.fontFamily = nextFont
      }
      if (Array.isArray(state.projects)) {
        state.projects = state.projects.map((project) => {
          const next = { ...project } as ProjectsState['projects'][number] & {
            fontFamily?: unknown
            fontSize?: unknown
            terminalTheme?: unknown
          }
          if (Array.isArray(next.terminals)) {
            next.terminals = next.terminals.map((terminal) => {
              const repaired = { ...terminal } as typeof terminal & { restoredOutput?: unknown }
              delete repaired.restoredOutput
              return repaired
            })
          }
          delete next.fontFamily
          delete next.fontSize
          delete next.terminalTheme
          return next
        })
      }
      fs.copyFileSync(statePath, `${statePath}.bak-repair-${Date.now()}`)
      fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch {}
  }
  clearNwRendererCaches()
  await window.cells.app.relaunch()
}

function beepNw() {
  try {
    if (getNodeProcess()?.platform === 'darwin') {
      requireNode<typeof import('node:child_process')>('node:child_process')
        .spawn('osascript', ['-e', 'beep'], { detached: true, stdio: 'ignore' })
        .unref()
      return
    }
  } catch {}
  try {
    const audio = new Audio(
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=',
    )
    void audio.play().catch(() => {})
  } catch {}
}

function focusNwMainWindowAndAgentWindow(request?: FocusAgentWindowRequest | null) {
  try {
    const win = requireNode<NwGui>('nw.gui').Window.get()
    win.show?.()
    win.focus?.()
  } catch {}
  if (request?.windowId) {
    window.setTimeout(() => focusAgentWindow.emit(request), 50)
  }
}

async function showNwNotification(
  title: string,
  body: string,
  options?: {
    playSound?: boolean
    focusAgentWindowId?: string | null
    focusProjectId?: string | null
  },
) {
  const playSound = options?.playSound ?? true
  const focusRequest =
    options?.focusAgentWindowId || cachedAgentNotificationContext.focusedAgentWindowId
      ? {
          windowId:
            options?.focusAgentWindowId ?? cachedAgentNotificationContext.focusedAgentWindowId!,
          projectId: options?.focusProjectId ?? cachedAgentNotificationContext.activeProjectId,
        }
      : null

  if (!('Notification' in window)) {
    if (playSound) beepNw()
    return
  }

  try {
    if (Notification.permission === 'default') {
      await Notification.requestPermission()
    }
    if (Notification.permission !== 'granted') {
      if (playSound) beepNw()
      return
    }
    const notification = new Notification(title, { body, silent: !playSound })
    notification.onclick = () => focusNwMainWindowAndAgentWindow(focusRequest)
  } catch {
    if (playSound) beepNw()
  }
}

async function readState(): Promise<ProjectsState | null> {
  const require = getNodeRequire()
  const statePath = getStatePath()
  if (!require || !statePath) return createDefaultState()
  const fs = require('node:fs') as typeof import('node:fs')
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as ProjectsState
  } catch {
    return createDefaultState()
  }
}

async function writeState(state: ProjectsState) {
  const require = getNodeRequire()
  const statePath = getStatePath()
  if (!require || !statePath) return
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function createDefaultState(): ProjectsState {
  const now = Date.now()
  return {
    version: 4,
    activeProjectId: 'nw-demo',
    projects: [
      {
        id: 'nw-demo',
        name: 'Cells Demo',
        path: getNodeRequire()?.('node:os').homedir?.() ?? '',
        titleBarPinned: false,
        hiddenFromTitleBar: false,
        terminals: [
          {
            id: 'nw-terminal',
            x: 80,
            y: 740,
            width: 980,
            height: 360,
            title: 'Cells Terminal',
            cwd: getHomeDir(),
            zIndex: 2,
          },
        ],
        browsers: [
          {
            id: 'nw-browser',
            x: 80,
            y: 80,
            width: 980,
            height: 620,
            url: 'https://example.com',
            title: 'Example Domain',
            zIndex: 1,
            history: {
              entries: [{ url: 'https://example.com', title: 'Example Domain' }],
              activeIndex: 0,
            },
          },
        ],
        textEditors: [],
        agentWindows: [],
        canvas: { x: 80, y: 40, scale: 0.72 },
        focusedBrowserId: 'nw-browser',
        focusedTerminalId: null,
        focusedTextEditorId: null,
        focusedAgentWindowId: null,
        lastOpenedAt: now,
        windowSections: [],
      },
    ],
    colorScheme: 'dark',
    titleBarPosition: 'top',
    titleBarHidden: false,
    searchEngine: 'https://www.google.com/search?q=%s',
    homePage: 'https://example.com',
    terminalLinkTarget: 'browser',
    autoUpdate: false,
    hasSeenOnboardingGuide: true,
  }
}

function getConfiguredExtensionDirs() {
  const nodeProcess = getNodeProcess()
  return (nodeProcess?.env.CELLS_NW_EXTENSION_DIRS ?? '')
    .split(nodeProcess?.platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function emitNwMenuCommand(command: CellsShortcutCommand) {
  appShortcut.emit({
    command,
    source: 'menu',
    browserId: null,
  })
}

function runDocumentEditCommand(command: string) {
  try {
    document.execCommand(command)
  } catch {}
}

function installNwShortcutMenu() {
  try {
    const gui = requireNode<NwGui>('nw.gui')
    const win = gui.Window.get()
    const menu = new gui.Menu({ type: 'menubar' })
    const appMenu = new gui.Menu()
    const editMenu = new gui.Menu()
    const windowMenu = new gui.Menu()
    const viewMenu = new gui.Menu()
    const separator = (target: InstanceType<NwGui['Menu']>) =>
      target.append(new gui.MenuItem({ type: 'separator' }))

    appMenu.append(new gui.MenuItem({ label: 'About Cells', enabled: false }))
    separator(appMenu)
    for (const item of NW_SHORTCUT_MENU_ITEMS) {
      appMenu.append(
        new gui.MenuItem({
          label: item.label,
          key: item.key,
          modifiers: item.modifiers,
          click: () => emitNwMenuCommand(item.command),
        }),
      )
    }
    separator(appMenu)
    appMenu.append(new gui.MenuItem({ label: 'Hide Cells', click: () => win.hide?.() }))
    appMenu.append(
      new gui.MenuItem({ label: 'Quit Cells', click: () => emitNwMenuCommand('quit-app') }),
    )

    editMenu.append(
      new gui.MenuItem({
        label: 'Undo',
        key: 'z',
        modifiers: 'cmd',
        click: () => runDocumentEditCommand('undo'),
      }),
    )
    editMenu.append(
      new gui.MenuItem({
        label: 'Redo',
        key: 'z',
        modifiers: 'cmd-shift',
        click: () => runDocumentEditCommand('redo'),
      }),
    )
    separator(editMenu)
    editMenu.append(
      new gui.MenuItem({
        label: 'Cut',
        key: 'x',
        modifiers: 'cmd',
        click: () => runDocumentEditCommand('cut'),
      }),
    )
    editMenu.append(
      new gui.MenuItem({
        label: 'Copy',
        key: 'c',
        modifiers: 'cmd',
        click: () => runDocumentEditCommand('copy'),
      }),
    )
    editMenu.append(
      new gui.MenuItem({
        label: 'Paste',
        key: 'v',
        modifiers: 'cmd',
        click: () => runDocumentEditCommand('paste'),
      }),
    )
    editMenu.append(
      new gui.MenuItem({
        label: 'Select All',
        key: 'a',
        modifiers: 'cmd',
        click: () => runDocumentEditCommand('selectAll'),
      }),
    )

    windowMenu.append(
      new gui.MenuItem({
        label: 'Close Window',
        key: 'w',
        modifiers: 'cmd',
        click: () => emitNwMenuCommand('close-window'),
      }),
    )
    windowMenu.append(
      new gui.MenuItem({
        label: 'Minimize',
        key: 'm',
        modifiers: 'cmd',
        click: () => win.minimize?.(),
      }),
    )
    windowMenu.append(
      new gui.MenuItem({
        label: 'Zoom',
        click: () => {
          const anyWin = win as NwWindowHandle & {
            isMaximized?: boolean
            maximize?: () => void
            unmaximize?: () => void
          }
          if (anyWin.isMaximized) anyWin.unmaximize?.()
          else anyWin.maximize?.()
        },
      }),
    )

    viewMenu.append(
      new gui.MenuItem({
        label: 'Toggle Developer Tools',
        key: 'i',
        modifiers: 'cmd-alt',
        click: () => win.showDevTools?.(),
      }),
    )
    separator(viewMenu)
    viewMenu.append(
      new gui.MenuItem({ label: 'Fit Focused Window', click: () => canvasZoom.emit('fit') }),
    )
    viewMenu.append(
      new gui.MenuItem({ label: 'Zoom Toward Focused Window', click: () => canvasZoom.emit('in') }),
    )
    viewMenu.append(
      new gui.MenuItem({
        label: 'Zoom Away From Focused Window',
        click: () => canvasZoom.emit('out'),
      }),
    )
    separator(viewMenu)
    viewMenu.append(
      new gui.MenuItem({
        label: 'Toggle Full Screen',
        key: 'f',
        modifiers: 'cmd-ctrl',
        click: () => {
          if (typeof win.toggleFullscreen === 'function') {
            win.toggleFullscreen()
          } else {
            win.enterFullscreen?.()
          }
        },
      }),
    )

    menu.append(new gui.MenuItem({ label: NW_MENU_LABELS.app, submenu: appMenu }))
    menu.append(new gui.MenuItem({ label: NW_MENU_LABELS.edit, submenu: editMenu }))
    menu.append(new gui.MenuItem({ label: NW_MENU_LABELS.window, submenu: windowMenu }))
    menu.append(new gui.MenuItem({ label: NW_MENU_LABELS.view, submenu: viewMenu }))
    win.menu = menu
    ;(
      window as typeof window & { __cellsNwMenuLabels?: typeof NW_MENU_LABELS }
    ).__cellsNwMenuLabels = NW_MENU_LABELS
  } catch (error) {
    console.warn('[nw] failed to install shortcut menu', error)
  }
}

function initializeExtensionState() {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  const persisted = readExtensionsState()
  const extensionsById = new Map<string, ExtensionMeta>()
  for (const extension of persisted.extensions ?? []) {
    extensionsById.set(extension.id, extension)
    if (extension.hasPopup) {
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(extension.sourceUrl, 'manifest.json'), 'utf8'),
        )
        const action = manifest.action || manifest.browser_action || {}
        if (typeof action.default_popup === 'string' && action.default_popup.length > 0) {
          extensionPopupPaths.set(extension.id, action.default_popup)
        }
      } catch {}
    }
  }
  for (const dir of getConfiguredExtensionDirs()) {
    try {
      const meta = buildNwExtensionMeta(dir)
      extensionsById.set(meta.id, meta)
    } catch {}
  }
  const extensions = [...extensionsById.values()]
  extensionState.extensions = extensions
  extensionState.projectExtensions = {
    ...persisted.projectExtensions,
    'nw-demo': [
      ...new Set([
        ...(persisted.projectExtensions?.['nw-demo'] ?? []),
        ...extensions.map((extension) => extension.id),
      ]),
    ],
  }
  writeExtensionsState(extensionState)
}

function resolveNwExtensionInput(input: string) {
  const path = requireNode<typeof import('node:path')>('node:path')
  const { fileURLToPath } = requireNode<typeof import('node:url')>('node:url')
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Extension path is required.')
  const rawPath = trimmed.startsWith('file://') ? fileURLToPath(trimmed) : trimmed
  return path.resolve(rawPath.replace(/^~(?=$|\/)/, getHomeDir()))
}

function resolveNwManifestText(value: string, extensionDir: string, manifest: Record<string, any>) {
  if (!value || !value.startsWith('__MSG_')) return value
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  const key = value.replace(/^__MSG_/, '').replace(/__$/, '')
  const locales = [manifest.default_locale || 'en', 'en']
  for (const locale of locales) {
    try {
      const messagesPath = path.join(extensionDir, '_locales', locale, 'messages.json')
      const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'))
      const found = Object.keys(messages).find((entry) => entry.toLowerCase() === key.toLowerCase())
      if (found && messages[found]?.message) return String(messages[found].message)
    } catch {}
  }
  return value
}

function buildNwExtensionMeta(extensionDir: string): ExtensionMeta {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  const manifestPath = path.join(extensionDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const action = manifest.action || manifest.browser_action || {}
  const icons = typeof manifest.icons === 'object' && manifest.icons ? manifest.icons : {}
  const id =
    typeof manifest.key === 'string' && manifest.key.trim()
      ? manifest.key
          .trim()
          .slice(0, 32)
          .replace(/[^a-z0-9_-]+/gi, '-')
      : path.basename(extensionDir)
  if (typeof action.default_popup === 'string' && action.default_popup.length > 0) {
    extensionPopupPaths.set(id, action.default_popup)
  }
  return {
    id,
    name: resolveNwManifestText(manifest.name || id, extensionDir, manifest),
    version: manifest.version || '0.0.0',
    description: resolveNwManifestText(manifest.description || '', extensionDir, manifest),
    sourceUrl: extensionDir,
    installedAt: Date.now(),
    hasPopup: typeof action.default_popup === 'string' && action.default_popup.length > 0,
    icons,
  }
}

function copyNwExtensionIntoStore(sourceDir: string, extensionId: string) {
  const extensionsDir = getExtensionsDir()
  if (!extensionsDir) return sourceDir
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  const target = path.join(extensionsDir, extensionId)
  if (path.resolve(sourceDir) === path.resolve(target)) return target
  fs.mkdirSync(extensionsDir, { recursive: true })
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(sourceDir, target, { recursive: true })
  return target
}

function getGitRoot(cwd: string) {
  const result = execFileStatus('git', ['rev-parse', '--show-toplevel'], { cwd })
  return result.ok ? result.stdout : null
}

function parsePorcelainDirtyCount(output: string) {
  if (!output) return 0
  return output.split('\n').filter((line) => line.trim().length > 0).length
}

function getAheadBehind(cwd: string) {
  const upstream = execFileStatus(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    {
      cwd,
    },
  )
  if (!upstream.ok) return { upstream: null, ahead: null, behind: null }
  const counts = execFileStatus('git', ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], {
    cwd,
  })
  if (!counts.ok) return { upstream: upstream.stdout, ahead: null, behind: null }
  const [aheadRaw, behindRaw] = counts.stdout.split(/\s+/)
  return {
    upstream: upstream.stdout,
    ahead: Number.parseInt(aheadRaw, 10),
    behind: Number.parseInt(behindRaw, 10),
  }
}

function getWorktreeStatus(worktreePath: string, repoRoot?: string, isMain = false): GitWorktree {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const exists = fs.existsSync(worktreePath)
  const root = repoRoot ?? getGitRoot(worktreePath) ?? worktreePath
  if (!exists) {
    return {
      path: worktreePath,
      repoRoot: root,
      head: null,
      branch: null,
      branchRef: null,
      isMain,
      isBare: false,
      isDetached: false,
      isMissing: true,
      isDirty: false,
      dirtyCount: 0,
      ahead: null,
      behind: null,
      upstream: null,
      prunable: true,
      lockedReason: null,
    }
  }

  const branchRef = execFileStatus('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: worktreePath })
  const branch = branchRef.ok ? branchRef.stdout.replace(/^refs\/heads\//, '') : null
  const head = execFileStatus('git', ['rev-parse', '--short', 'HEAD'], { cwd: worktreePath })
  const dirtyOutput = execFileStatus('git', ['status', '--porcelain'], { cwd: worktreePath })
  const dirtyCount = parsePorcelainDirtyCount(dirtyOutput.stdout)
  const aheadBehind = getAheadBehind(worktreePath)

  return {
    path: worktreePath,
    repoRoot: root,
    head: head.ok ? head.stdout : null,
    branch,
    branchRef: branchRef.ok ? branchRef.stdout : null,
    isMain,
    isBare: false,
    isDetached: !branch,
    isMissing: false,
    isDirty: dirtyCount > 0,
    dirtyCount,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    upstream: aheadBehind.upstream,
    prunable: false,
    lockedReason: null,
  }
}

function parseWorktreeList(cwd: string): GitWorktree[] {
  const root = getGitRoot(cwd)
  if (!root) return []
  const output = execFileStatus('git', ['worktree', 'list', '--porcelain'], { cwd: root })
  if (!output.ok || !output.stdout) return [getWorktreeStatus(root, root, true)]
  const entries: Array<Record<string, string | boolean>> = []
  let current: Record<string, string | boolean> = {}
  for (const line of output.stdout.split('\n')) {
    if (!line.trim()) {
      if (Object.keys(current).length) entries.push(current)
      current = {}
      continue
    }
    const [key, ...rest] = line.split(' ')
    current[key] = rest.length ? rest.join(' ') : true
  }
  if (Object.keys(current).length) entries.push(current)
  return entries.map((entry) =>
    getWorktreeStatus(
      String(entry.worktree ?? root),
      root,
      String(entry.worktree ?? root) === root,
    ),
  )
}

function validateBranchName(cwd: string, branchName: string): GitBranchValidation {
  const trimmed = branchName.trim()
  if (!trimmed) return { valid: false, message: 'Branch name is required.' }
  const check = execFileStatus('git', ['check-ref-format', '--branch', trimmed], { cwd })
  if (!check.ok) return { valid: false, message: check.stderr || 'Invalid branch name.' }
  return { valid: true, message: null }
}

function searchProjectFiles(rootPath: string, query = ''): ProjectFileSearchResult[] {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  const normalizedQuery = query.trim().toLowerCase()
  const results: ProjectFileSearchResult[] = []
  const maxResults = 80
  const maxVisited = 12_000
  let visited = 0

  const visit = (dir: string) => {
    if (results.length >= maxResults || visited >= maxVisited) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= maxResults || visited >= maxVisited) return
      if (entry.name === 'node_modules' || entry.name === '.git' || isProbablyHidden(entry.name))
        continue
      const fullPath = path.join(dir, entry.name)
      visited += 1
      if (entry.isDirectory()) {
        visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = path.relative(rootPath, fullPath)
      if (normalizedQuery && !relativePath.toLowerCase().includes(normalizedQuery)) continue
      try {
        const stat = fs.statSync(fullPath)
        results.push({
          path: fullPath,
          name: entry.name,
          relativePath,
          directory: path.dirname(relativePath),
          mtime: stat.mtimeMs,
          size: stat.size,
        })
      } catch {}
    }
  }

  visit(rootPath)
  return results.sort((a, b) => b.mtime - a.mtime)
}

function resolveNwMcpServerPath(): string {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  const process = getNodeProcess()
  const repoRoot = process?.env.CELLS_REPO_ROOT
  const candidates = [
    repoRoot ? path.join(repoRoot, 'mcp-server', 'dist', 'index.js') : '',
    path.join(process?.cwd?.() ?? '', 'mcp-server', 'dist', 'index.js'),
    path.resolve('mcp-server', 'dist', 'index.js'),
    path.join(path.dirname(window.location.pathname), 'mcp-server', 'dist', 'index.js'),
  ].filter(Boolean)
  const found = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  })
  return found ?? candidates[0]
}

function upsertMcpJsonEntry(filePath: string, entry: { command: string; args: string[] }) {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {}
  const servers =
    existing.mcpServers && typeof existing.mcpServers === 'object'
      ? (existing.mcpServers as Record<string, unknown>)
      : {}
  servers.cells = entry
  existing.mcpServers = servers
  fs.mkdirSync(requireNode<typeof import('node:path')>('node:path').dirname(filePath), {
    recursive: true,
  })
  fs.writeFileSync(filePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
}

function upsertCodexTomlEntry(filePath: string, entry: { command: string; args: string[] }) {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  let content = ''
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {}

  const argsToml = `[${entry.args.map((arg) => JSON.stringify(arg)).join(', ')}]`
  const block = [
    '[mcp_servers.cells]',
    `command = ${JSON.stringify(entry.command)}`,
    `args = ${argsToml}`,
  ].join('\n')
  const sectionRe = /^\[mcp_servers\.cells\]\s*\n(?:[^[]*?)(?=\n\[|\s*$)/m
  const nextContent = sectionRe.test(content)
    ? content.replace(sectionRe, block)
    : `${content.trimEnd()}${content.length > 0 ? '\n\n' : ''}${block}\n`
  fs.mkdirSync(requireNode<typeof import('node:path')>('node:path').dirname(filePath), {
    recursive: true,
  })
  fs.writeFileSync(filePath, nextContent, 'utf8')
}

function installNwMcpServer(projectPath: string) {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  const root = path.resolve(projectPath || getHomeDir())
  const serverPath = resolveNwMcpServerPath()
  if (!fs.existsSync(serverPath)) {
    throw new Error(`MCP server not built. Expected at: ${serverPath}`)
  }

  const mcpEntry = { command: 'node', args: [serverPath] }
  const targets: string[] = []
  const agentsDir = path.join(root, '.agents')
  fs.mkdirSync(agentsDir, { recursive: true })
  const configPath = path.join(agentsDir, 'mcp.json')
  upsertMcpJsonEntry(configPath, mcpEntry)
  targets.push('.agents/mcp.json')

  for (const dir of ['.claude', '.codex', '.cursor', '.github', '.opencode']) {
    const linkPath = path.join(root, dir, 'mcp.json')
    try {
      if (fs.lstatSync(linkPath).isSymbolicLink()) fs.unlinkSync(linkPath)
    } catch {}
  }

  upsertMcpJsonEntry(path.join(root, '.mcp.json'), mcpEntry)
  targets.push('.mcp.json')

  if (fs.existsSync(path.join(root, '.codex'))) {
    upsertCodexTomlEntry(path.join(root, '.codex', 'config.toml'), mcpEntry)
    targets.push('.codex/config.toml')
  }

  if (fs.existsSync(path.join(root, '.cursor'))) {
    upsertMcpJsonEntry(path.join(root, '.cursor', 'mcp.json'), mcpEntry)
    targets.push('.cursor/mcp.json')
  }

  void showNwNotification('MCP Server Installed', `Updated ${targets.join(', ')}`, {
    playSound: false,
  })
  return { configPath, targets, serverPath }
}

function getNwAppVersion() {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  const process = getNodeProcess()
  const candidates = [
    process?.env.CELLS_REPO_ROOT ? path.join(process.env.CELLS_REPO_ROOT, 'package.json') : '',
    path.resolve('package.json'),
    path.join(path.dirname(window.location.pathname), 'package.json'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown }
      if (typeof manifest.version === 'string' && manifest.version.trim()) return manifest.version
    } catch {}
  }
  return '0.0.0'
}

function isNwDevelopmentBuild() {
  const process = getNodeProcess()
  return Boolean(process?.env.CELLS_REPO_ROOT) || getNwAppVersion() === '0.0.0'
}

function getNwUpdaterSupport() {
  if (!isNwDevelopmentBuild()) {
    return {
      enabled: false,
      reason: 'manual-install-required',
      message: 'Install updates from the latest signed Cells DMG on GitHub Releases.',
    }
  }
  return {
    enabled: false,
    reason: 'development-build',
    message: 'Auto-update is only available in packaged Cells releases.',
  }
}

function emitNwUpdaterUnsupported() {
  updaterStatus.emit('unsupported', getNwUpdaterSupport())
}

const nwPerfEvents: PerfEventRecord[] = []
let nwPerfTimer: number | null = null
let nwPerfLogPath: string | null = null

function getNwPerfLogPath() {
  if (nwPerfLogPath) return nwPerfLogPath
  const path = requireNode<typeof import('node:path')>('node:path')
  const process = getNodeProcess()
  const logDir =
    process?.env.CELLS_LOG_DIR ||
    (process?.env.CELLS_DATA_DIR
      ? path.join(process.env.CELLS_DATA_DIR, 'logs')
      : path.join(getHomeDir(), 'Library', 'Logs', 'Cells'))
  nwPerfLogPath = path.join(logDir, 'nw-perf.ndjson')
  return nwPerfLogPath
}

function recordNwPerfEvent(kind: PerfEventRecord['kind'], data: Record<string, unknown>) {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  const event: PerfEventRecord = { timestamp: Date.now(), kind, data }
  nwPerfEvents.push(event)
  if (nwPerfEvents.length > NW_PERF_RECENT_EVENT_LIMIT) {
    nwPerfEvents.splice(0, nwPerfEvents.length - NW_PERF_RECENT_EVENT_LIMIT)
  }
  try {
    const logPath = getNwPerfLogPath()
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, 'utf8')
  } catch {}
}

function readNwProcessMemory() {
  const process = getNodeProcess()
  try {
    const memory = process?.memoryUsage?.()
    if (!memory) return null
    return {
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    }
  } catch {
    return null
  }
}

function captureNwPerfSample() {
  recordNwPerfEvent('sample', {
    runtime: 'nw',
    ptySessionCount: ptySessions.size,
    activePtySessionCount: [...ptySessions.values()].filter((session) => !session.exited).length,
    browserCount: browserStates.size,
    agentSessionCount: agentSessions.size,
    memory: readNwProcessMemory(),
  })
}

function startNwPerfMonitor() {
  if (nwPerfTimer !== null) return
  captureNwPerfSample()
  nwPerfTimer = window.setInterval(captureNwPerfSample, NW_PERF_SAMPLE_INTERVAL_MS)
}

function getNwPerfStatus(): PerfMonitorStatus {
  let gpuFeatureStatus: Record<string, string> = {}
  try {
    const chromeGpu = (globalThis as typeof globalThis & { chrome?: any }).chrome?.gpuBenchmarking
    if (chromeGpu) gpuFeatureStatus = { gpuBenchmarking: 'available' }
  } catch {}
  return {
    enabled: nwPerfTimer !== null,
    logPath: getNwPerfLogPath(),
    sampleIntervalMs: NW_PERF_SAMPLE_INTERVAL_MS,
    hardwareAccelerationEnabled: true,
    gpuFeatureStatus,
    recentEventCount: nwPerfEvents.length,
  }
}

function reportNwRendererPerfSample(sample: RendererPerfSample) {
  recordNwPerfEvent('renderer', {
    fps: sample.fps,
    longTaskCount: sample.longTaskCount,
    maxLongTaskMs: sample.maxLongTaskMs,
    liveTerminalCount: sample.liveTerminalCount,
    cachedTerminalCount: sample.cachedTerminalCount,
    totalTerminalCount: sample.totalTerminalCount,
    totalBrowserCount: sample.totalBrowserCount,
    totalTextEditorCount: sample.totalTextEditorCount,
    totalAgentWindowCount: sample.totalAgentWindowCount,
    projectCount: sample.projectCount,
    focusedTerminalId: sample.focusedTerminalId,
    focusedBrowserId: sample.focusedBrowserId,
    focusedTextEditorId: sample.focusedTextEditorId,
    focusedAgentWindowId: sample.focusedAgentWindowId,
    useTransparentWindow: sample.useTransparentWindow,
    windowOpacity: sample.windowOpacity,
    overlayOpen: sample.overlayOpen,
  })
}

function reportNwTerminalPerfSample(sample: TerminalPerfSample) {
  recordNwPerfEvent('terminal', sample as unknown as Record<string, unknown>)
}

interface NwLanguageServerSpec {
  languages: string[]
  command: string
  args: string[]
}

interface NwLspDocument {
  uri: string
  filePath: string
  languageId: string
  version: number
  server: NwLspServer
}

const NW_LANGUAGE_SERVER_SPECS: NwLanguageServerSpec[] = [
  {
    languages: ['typescript', 'javascript'],
    command: 'typescript-language-server',
    args: ['--stdio'],
  },
  { languages: ['python'], command: 'pyright-langserver', args: ['--stdio'] },
  { languages: ['python'], command: 'pylsp', args: [] },
  { languages: ['go'], command: 'gopls', args: [] },
  { languages: ['rust'], command: 'rust-analyzer', args: [] },
  { languages: ['css', 'scss', 'less'], command: 'vscode-css-language-server', args: ['--stdio'] },
  { languages: ['html'], command: 'vscode-html-language-server', args: ['--stdio'] },
  { languages: ['json'], command: 'vscode-json-language-server', args: ['--stdio'] },
  { languages: ['yaml'], command: 'yaml-language-server', args: ['--stdio'] },
  { languages: ['shell'], command: 'bash-language-server', args: ['start'] },
  { languages: ['lua'], command: 'lua-language-server', args: [] },
  { languages: ['ruby'], command: 'ruby-lsp', args: [] },
  { languages: ['ruby'], command: 'solargraph', args: ['stdio'] },
  { languages: ['c', 'cpp'], command: 'clangd', args: [] },
  { languages: ['csharp'], command: 'csharp-ls', args: [] },
  { languages: ['swift'], command: 'sourcekit-lsp', args: [] },
  { languages: ['kotlin'], command: 'kotlin-language-server', args: [] },
  { languages: ['markdown'], command: 'marksman', args: ['server'] },
  { languages: ['toml'], command: 'taplo', args: ['lsp', 'stdio'] },
]

function nwShellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildNwUserPathEnv() {
  const path = requireNode<typeof import('node:path')>('node:path')
  const home = getUserHomeDir()
  const entries = [
    getNodeProcess()?.env.PATH ?? '',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(home, '.local/bin'),
    path.join(home, '.cargo/bin'),
    path.join(home, 'go/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.volta/bin'),
    path.join(home, 'Library/pnpm'),
    '/Applications/Codex.app/Contents/Resources',
  ]
  return [...new Set(entries.flatMap((entry) => entry.split(path.delimiter)).filter(Boolean))].join(
    path.delimiter,
  )
}

function buildNwUserEnv(extra: Record<string, string | undefined> = {}) {
  const path = requireNode<typeof import('node:path')>('node:path')
  const process = getNodeProcess()
  const env = { ...(process?.env ?? {}) } as Record<string, string>
  const home = getUserHomeDir()
  if (home) {
    env.HOME = home
    env.XDG_CONFIG_HOME =
      process?.env.CELLS_REAL_XDG_CONFIG_HOME?.trim() || path.join(home, '.config')
    env.XDG_DATA_HOME =
      process?.env.CELLS_REAL_XDG_DATA_HOME?.trim() || path.join(home, '.local/share')
    env.XDG_CACHE_HOME = process?.env.CELLS_REAL_XDG_CACHE_HOME?.trim() || path.join(home, '.cache')
    env.XDG_STATE_HOME =
      process?.env.CELLS_REAL_XDG_STATE_HOME?.trim() || path.join(home, '.local/state')
  }
  env.PATH = buildNwUserPathEnv()
  env.TERM = env.TERM && env.TERM !== 'dumb' ? env.TERM : 'xterm-256color'
  env.COLORTERM = env.COLORTERM || 'truecolor'
  for (const [key, value] of Object.entries(extra)) {
    if (value != null) env[key] = value
  }
  return env
}

function resolveNwCommand(command: string) {
  const childProcess = requireNode<typeof import('node:child_process')>('node:child_process')
  const path = requireNode<typeof import('node:path')>('node:path')
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  if (command.includes('/')) {
    const resolved = path.resolve(command.replace(/^~(?=$|\/)/, getUserHomeDir()))
    try {
      fs.accessSync(resolved, fs.constants.X_OK)
      return resolved
    } catch {
      return null
    }
  }
  const process = getNodeProcess()
  const shell = process?.env.SHELL || '/bin/zsh'
  try {
    const output = childProcess
      .execFileSync(shell, ['-lc', `command -v -- ${nwShellQuote(command)}`], {
        encoding: 'utf8',
        env: buildNwUserEnv(),
        timeout: 1500,
      })
      .trim()
      .split('\n')[0]
    return output && path.isAbsolute(output) && fs.existsSync(output) ? output : null
  } catch {
    return null
  }
}

function nwFilePathToUri(filePath: string) {
  const path = requireNode<typeof import('node:path')>('node:path')
  const { pathToFileURL } = requireNode<typeof import('node:url')>('node:url')
  return pathToFileURL(path.resolve(filePath)).toString()
}

function nwRootPathFor(filePath: string, rootPath?: string | null) {
  const path = requireNode<typeof import('node:path')>('node:path')
  return rootPath ? path.resolve(rootPath) : path.dirname(path.resolve(filePath))
}

function nwLspLanguageId(languageId: string, filePath: string) {
  const lower = filePath.toLowerCase()
  if (languageId === 'typescript' && lower.endsWith('.tsx')) return 'typescriptreact'
  if (languageId === 'javascript' && lower.endsWith('.jsx')) return 'javascriptreact'
  if (languageId === 'shell') return 'shellscript'
  return languageId
}

function nwSpecsForLanguage(languageId: string) {
  return NW_LANGUAGE_SERVER_SPECS.filter((spec) => spec.languages.includes(languageId))
}

class NwLspServer {
  private process: import('node:child_process').ChildProcessWithoutNullStreams
  private buffer: Buffer = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: number
    }
  >()
  private initialized = false

  constructor(
    private readonly commandPath: string,
    private readonly args: string[],
    private readonly rootPath: string,
    private readonly onDiagnostics: (payload: EditorLspDiagnosticsPayload) => void,
  ) {
    const childProcess = requireNode<typeof import('node:child_process')>('node:child_process')
    this.process = childProcess.spawn(commandPath, args, {
      cwd: rootPath,
      env: buildNwUserEnv({ PWD: rootPath }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
    this.process.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) console.warn(`[nw-editor-lsp] ${commandPath}: ${text}`)
    })
    this.process.on('exit', (code, signal) => {
      const error = new Error(`Language server exited (${code ?? signal ?? 'unknown'})`)
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      this.pending.clear()
    })
  }

  async initialize() {
    if (this.initialized) return
    const path = requireNode<typeof import('node:path')>('node:path')
    const { pathToFileURL } = requireNode<typeof import('node:url')>('node:url')
    const rootUri = pathToFileURL(this.rootPath).toString()
    await this.request('initialize', {
      processId: getNodeProcess()?.pid ?? null,
      rootPath: this.rootPath,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.rootPath) || this.rootPath }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: { relatedInformation: true },
          completion: {
            dynamicRegistration: false,
            completionItem: {
              snippetSupport: false,
              documentationFormat: ['markdown', 'plaintext'],
            },
          },
          hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
          definition: { dynamicRegistration: false, linkSupport: false },
        },
        workspace: { workspaceFolders: true, configuration: true },
      },
      initializationOptions: {},
      trace: 'off',
    })
    this.notify('initialized', {})
    this.initialized = true
  }

  notify(method: string, params?: unknown) {
    this.write({ jsonrpc: '2.0', method, params })
  }

  request(method: string, params?: unknown) {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, NW_LSP_REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  stop() {
    try {
      this.notify('shutdown')
      this.notify('exit')
    } catch {}
    try {
      this.process.kill()
    } catch {}
  }

  private write(payload: unknown) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
    this.process.stdin.write(Buffer.concat([header, body]))
  }

  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.slice(0, headerEnd).toString('ascii')
      const match = header.match(/Content-Length:\s*(\d+)/i)
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const messageStart = headerEnd + 4
      const messageEnd = messageStart + length
      if (this.buffer.length < messageEnd) return
      const raw = this.buffer.slice(messageStart, messageEnd).toString('utf8')
      this.buffer = this.buffer.slice(messageEnd)
      try {
        this.handleMessage(JSON.parse(raw) as Record<string, unknown>)
      } catch (error) {
        console.warn('[nw-editor-lsp] failed to parse message', error)
      }
    }
  }

  private handleMessage(message: Record<string, unknown>) {
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri?: string; diagnostics?: unknown[] } | undefined
      if (params?.uri)
        this.onDiagnostics({ uri: params.uri, diagnostics: params.diagnostics ?? [] })
    }
  }
}

class NwEditorLspManager {
  private servers = new Map<string, NwLspServer>()
  private docs = new Map<string, NwLspDocument>()
  private commandCache = new Map<string, string | null>()

  constructor(private readonly onDiagnostics: (payload: EditorLspDiagnosticsPayload) => void) {}

  async openDocument(request: EditorLspOpenRequest) {
    const server = await this.ensureServer(request.languageId, request.filePath, request.rootPath)
    if (!server) return { enabled: false }
    const uri = nwFilePathToUri(request.filePath)
    const existing = this.docs.get(uri)
    if (existing) {
      existing.server = server
      existing.version += 1
      existing.languageId = request.languageId
      server.notify('textDocument/didChange', {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text: request.content }],
      })
      return { enabled: true, uri }
    }

    const doc: NwLspDocument = {
      uri,
      filePath: request.filePath,
      languageId: request.languageId,
      version: 1,
      server,
    }
    this.docs.set(uri, doc)
    server.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: nwLspLanguageId(request.languageId, request.filePath),
        version: doc.version,
        text: request.content,
      },
    })
    return { enabled: true, uri }
  }

  changeDocument(uri: string, content: string, version?: number) {
    const doc = this.docs.get(uri)
    if (!doc) return { enabled: false }
    doc.version = typeof version === 'number' ? version : doc.version + 1
    doc.server.notify('textDocument/didChange', {
      textDocument: { uri, version: doc.version },
      contentChanges: [{ text: content }],
    })
    return { enabled: true }
  }

  closeDocument(uri: string) {
    const doc = this.docs.get(uri)
    if (!doc) return
    this.docs.delete(uri)
    doc.server.notify('textDocument/didClose', { textDocument: { uri } })
    this.onDiagnostics({ uri, diagnostics: [] })
  }

  completion(uri: string, position: EditorLspPosition) {
    const doc = this.docs.get(uri)
    if (!doc) return null
    return doc.server.request('textDocument/completion', { textDocument: { uri }, position })
  }

  hover(uri: string, position: EditorLspPosition) {
    const doc = this.docs.get(uri)
    if (!doc) return null
    return doc.server.request('textDocument/hover', { textDocument: { uri }, position })
  }

  definition(uri: string, position: EditorLspPosition) {
    const doc = this.docs.get(uri)
    if (!doc) return null
    return doc.server.request('textDocument/definition', { textDocument: { uri }, position })
  }

  private async ensureServer(languageId: string, filePath: string, rootPath?: string | null) {
    const specs = nwSpecsForLanguage(languageId)
    if (specs.length === 0) return null
    const root = nwRootPathFor(filePath, rootPath)

    for (const spec of specs) {
      const commandPath = this.resolveCachedCommand(spec.command)
      if (!commandPath) continue
      const key = `${commandPath}\u241f${root}`
      const existing = this.servers.get(key)
      if (existing) return existing
      const server = new NwLspServer(commandPath, spec.args, root, this.onDiagnostics)
      try {
        await server.initialize()
        this.servers.set(key, server)
        return server
      } catch (error) {
        console.warn(`[nw-editor-lsp] failed to initialize ${spec.command}`, error)
        server.stop()
      }
    }
    return null
  }

  private resolveCachedCommand(command: string) {
    if (!this.commandCache.has(command)) this.commandCache.set(command, resolveNwCommand(command))
    return this.commandCache.get(command) ?? null
  }
}

let nwEditorLspManager: NwEditorLspManager | null = null

function getNwEditorLspManager() {
  nwEditorLspManager ??= new NwEditorLspManager((payload) => lspDiagnostics.emit(payload))
  return nwEditorLspManager
}

const AGENT_MENTION_ROOTS = [
  '.agents',
  '.claude',
  '.codex',
  '.cursor',
  '.github',
  '.opencode',
] as const
const MAX_AGENT_MENTION_RESULTS = 60
const MAX_AGENT_MENTION_SCAN_ENTRIES = 2000
const NW_PERF_SAMPLE_INTERVAL_MS = 5_000
const NW_PERF_RECENT_EVENT_LIMIT = 200
const NW_LSP_REQUEST_TIMEOUT_MS = 10_000

type AgentMentionRoot = (typeof AGENT_MENTION_ROOTS)[number]

function isSubsequenceMatch(target: string, query: string) {
  if (!query) return true
  let index = 0
  for (const char of target) {
    if (char === query[index]) index += 1
    if (index === query.length) return true
  }
  return false
}

function resolveAgentMentionRoots(
  cwd: string,
): Array<{ sourceRoot: AgentMentionRoot; rootPath: string }> {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  const resolvedCwd = path.resolve(cwd || getHomeDir())
  const found = new Map<AgentMentionRoot, string>()
  let current = resolvedCwd

  while (true) {
    for (const sourceRoot of AGENT_MENTION_ROOTS) {
      if (found.has(sourceRoot)) continue
      const candidate = path.join(current, sourceRoot)
      try {
        if (fs.statSync(candidate).isDirectory()) found.set(sourceRoot, candidate)
      } catch {}
    }
    if (found.size === AGENT_MENTION_ROOTS.length) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return AGENT_MENTION_ROOTS.flatMap((sourceRoot) => {
    const rootPath = found.get(sourceRoot)
    return rootPath ? [{ sourceRoot, rootPath }] : []
  })
}

function readSkillFrontmatter(filePath: string) {
  try {
    const fs = requireNode<typeof import('node:fs')>('node:fs')
    const source = fs.readFileSync(filePath, 'utf8')
    if (!source.startsWith('---\n')) return null
    const end = source.indexOf('\n---', 4)
    if (end < 0) return null
    let name: string | null = null
    let description: string | null = null
    for (const line of source.slice(4, end).split('\n')) {
      const match = line.match(/^([a-zA-Z_-]+):\s*(.+)$/)
      if (!match) continue
      const [, key, value] = match
      if (key === 'name') name = value.trim()
      if (key === 'description') description = value.trim()
    }
    return { name, description }
  } catch {
    return null
  }
}

function getAgentMentionScore(entry: AgentMentionSearchResult, rawQuery: string) {
  if (!rawQuery) return entry.type === 'skill' ? 30 : entry.type === 'folder' ? 20 : 10

  const query = rawQuery.trim().toLowerCase()
  const compactQuery = query.replace(/\s+/g, '')
  const label = entry.label.toLowerCase()
  const relativePath = entry.relativePath.toLowerCase()

  let score = 0
  if (label.startsWith(query)) score += 30
  else if (relativePath.startsWith(query)) score += 24
  else if (label.includes(query)) score += 18
  else if (relativePath.includes(query)) score += 12
  if (compactQuery && isSubsequenceMatch(relativePath.replace(/\s+/g, ''), compactQuery)) score += 8
  if (score > 0 && entry.type === 'skill') score += 2
  return score
}

function searchAgentMentionFiles(cwd: string, query = ''): AgentMentionSearchResult[] {
  const fs = requireNode<typeof import('node:fs')>('node:fs')
  const path = requireNode<typeof import('node:path')>('node:path')
  const candidates: Array<AgentMentionSearchResult & { score: number }> = []
  let scannedEntries = 0

  const pushCandidate = (entry: AgentMentionSearchResult) => {
    const score = getAgentMentionScore(entry, query)
    if (query.trim() && score <= 0) return
    candidates.push({ ...entry, score })
  }

  for (const { sourceRoot, rootPath } of resolveAgentMentionRoots(cwd)) {
    pushCandidate({
      type: 'folder',
      label: sourceRoot,
      relativePath: sourceRoot,
      absolutePath: rootPath,
      description: null,
      sourceRoot,
    })

    const queue: Array<{ absolutePath: string; relativePath: string }> = [
      { absolutePath: rootPath, relativePath: sourceRoot },
    ]
    while (queue.length > 0 && scannedEntries < MAX_AGENT_MENTION_SCAN_ENTRIES) {
      const current = queue.shift()
      if (!current) break
      let entries: import('node:fs').Dirent[]
      try {
        entries = fs.readdirSync(current.absolutePath, { withFileTypes: true })
      } catch {
        continue
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))

      for (const entry of entries) {
        if (scannedEntries >= MAX_AGENT_MENTION_SCAN_ENTRIES) break
        scannedEntries += 1
        const absolutePath = path.join(current.absolutePath, entry.name)
        const relativePath = `${current.relativePath}/${entry.name}`

        if (entry.isDirectory()) {
          queue.push({ absolutePath, relativePath })
          pushCandidate({
            type: 'folder',
            label: entry.name,
            relativePath,
            absolutePath,
            description: null,
            sourceRoot,
          })
          continue
        }

        if (!entry.isFile() && !entry.isSymbolicLink()) continue
        if (entry.name === 'SKILL.md') {
          const frontmatter = readSkillFrontmatter(absolutePath)
          pushCandidate({
            type: 'skill',
            label: frontmatter?.name || path.basename(path.dirname(absolutePath)),
            relativePath,
            absolutePath,
            description: frontmatter?.description ?? null,
            sourceRoot,
          })
          continue
        }

        pushCandidate({
          type: 'file',
          label: entry.name,
          relativePath,
          absolutePath,
          description: null,
          sourceRoot,
        })
      }
    }
  }

  candidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.type !== b.type) {
      const priority = { skill: 0, file: 1, folder: 2 }
      return priority[a.type] - priority[b.type]
    }
    return a.relativePath.localeCompare(b.relativePath)
  })

  return candidates.slice(0, MAX_AGENT_MENTION_RESULTS).map(({ score: _score, ...entry }) => entry)
}

function pickFileFromInput(options: { directory?: boolean; multiple?: boolean } = {}) {
  return new Promise<string[] | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (options.multiple) input.multiple = true
    if (options.directory) {
      input.setAttribute('webkitdirectory', '')
      input.setAttribute('directory', '')
    }
    input.style.display = 'none'
    document.body.appendChild(input)
    input.addEventListener(
      'change',
      () => {
        const paths = [...(input.files ?? [])].map((file) => window.cells.app.getPathForFile(file))
        input.remove()
        resolve(paths.length ? paths : null)
      },
      { once: true },
    )
    input.click()
  })
}

function nextMessageId(prefix: string) {
  messageCounter += 1
  return `${prefix}-${Date.now()}-${messageCounter}`
}

const NW_CODEX_MODELS: Awaited<ReturnType<CellsAPI['agentSession']['listCodexModels']>> = [
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    description: 'Strong model for everyday coding.',
    isDefault: true,
    hidden: false,
    supportedReasoningEfforts: [
      { effort: 'low', description: 'Fastest reasoning.' },
      { effort: 'medium', description: 'Balanced reasoning.' },
      { effort: 'high', description: 'Deeper reasoning.' },
      { effort: 'xhigh', description: 'Maximum available reasoning.' },
    ],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
    isDefault: false,
    hidden: false,
    supportedReasoningEfforts: [
      { effort: 'low', description: 'Fastest reasoning.' },
      { effort: 'medium', description: 'Balanced reasoning.' },
      { effort: 'high', description: 'Deeper reasoning.' },
      { effort: 'xhigh', description: 'Maximum available reasoning.' },
    ],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
    isDefault: false,
    hidden: false,
    supportedReasoningEfforts: [
      { effort: 'low', description: 'Fastest reasoning.' },
      { effort: 'medium', description: 'Balanced reasoning.' },
      { effort: 'high', description: 'Deeper reasoning.' },
      { effort: 'xhigh', description: 'Maximum available reasoning.' },
    ],
    defaultReasoningEffort: 'medium',
  },
]

const NW_CLAUDE_MODELS: Awaited<ReturnType<CellsAPI['agentSession']['listClaudeModels']>> = [
  {
    id: 'claude-opus-4-7',
    displayName: 'Opus 4.7',
    description: 'Most capable for complex work',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Sonnet 4.6',
    description: 'Best for everyday tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'max'],
    supportsAdaptiveThinking: true,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku 4.5',
    description: 'Fastest for quick answers',
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsAdaptiveThinking: false,
  },
]

const NW_CURSOR_MODELS: Awaited<ReturnType<CellsAPI['agentSession']['listCursorModels']>> = [
  {
    id: 'auto',
    displayName: 'Auto',
    description: 'Cursor account default',
    variants: [{ params: [], displayName: 'Auto', isDefault: true }],
  },
  {
    id: 'sonnet-4',
    displayName: 'Sonnet 4',
    description: 'Claude Sonnet through Cursor',
  },
]

const NW_COPILOT_MODELS: Awaited<ReturnType<CellsAPI['agentSession']['listCopilotModels']>> = [
  {
    id: 'auto',
    displayName: 'Auto',
    description: 'GitHub Copilot account default',
    isDefault: true,
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'off',
    contextWindow: null,
  },
]

const NW_OPENCODE_MODELS: Awaited<ReturnType<CellsAPI['agentSession']['listOpencodeModels']>> = [
  {
    id: 'opencode/gpt-5-nano',
    displayName: 'GPT-5 Nano',
    description: 'OpenCode default',
    isDefault: true,
    hidden: false,
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    contextWindow: null,
  },
]

function createAgentMessage(
  role: AgentSessionMessage['role'],
  text: string,
  options: Partial<AgentSessionMessage> = {},
): AgentSessionMessage {
  const now = Date.now()
  return {
    id: nextMessageId(role),
    role,
    text,
    startedAt: now,
    updatedAt: now,
    status: role === 'assistant' ? 'completed' : undefined,
    ...options,
  }
}

function createAgentSnapshot(request: AgentSessionRequest): AgentSessionSnapshot {
  const now = Date.now()
  const messages: AgentSessionMessage[] = []
  if (request.initialPrompt?.trim()) {
    messages.push(
      createAgentMessage('user', request.initialPrompt.trim(), {
        attachments: [],
        replyTo: null,
      }),
    )
  }
  return {
    windowId: request.windowId,
    agent: request.agent,
    title: request.title || `${request.agent} session`,
    cwd: request.cwd ?? getHomeDir() ?? null,
    status: 'idle',
    error: null,
    claudeSessionId: request.claudeSessionId ?? null,
    codexThreadId: request.codexThreadId ?? null,
    cursorAgentId: request.cursorAgentId ?? null,
    cursorRunId: request.cursorRunId ?? null,
    copilotSessionId: request.copilotSessionId ?? null,
    opencodeSessionId: request.opencodeSessionId ?? null,
    updatedAt: now,
    messages,
    usage: null,
    pendingPlanApproval: null,
    pendingQuestion: null,
    pendingApproval: null,
    codexPlan: null,
    codexGoal: null,
  }
}

function emitAgentSnapshot(snapshot: AgentSessionSnapshot) {
  snapshot.updatedAt = Date.now()
  agentSessions.set(snapshot.windowId, snapshot)
  agentUpdate.emit({ ...snapshot, messages: [...snapshot.messages] })
}

function summarizeAgentSnapshot(snapshot: AgentSessionSnapshot) {
  const lastMessage = [...snapshot.messages].reverse().find((message) => message.text?.trim())
  return {
    windowId: snapshot.windowId,
    agent: snapshot.agent,
    title: snapshot.title,
    cwd: snapshot.cwd ?? null,
    claudeSessionId: snapshot.claudeSessionId ?? null,
    codexThreadId: snapshot.codexThreadId ?? null,
    cursorAgentId: snapshot.cursorAgentId ?? null,
    cursorRunId: snapshot.cursorRunId ?? null,
    copilotSessionId: snapshot.copilotSessionId ?? null,
    opencodeSessionId: snapshot.opencodeSessionId ?? null,
    model: null,
    updatedAt: snapshot.updatedAt,
    messageCount: snapshot.messages.length,
    lastMessageText: lastMessage?.text ?? null,
  }
}

function appendAgentSystemMessage(snapshot: AgentSessionSnapshot, text: string) {
  snapshot.messages.push(createAgentMessage('system', text, { status: 'completed' }))
}

function clearAgentPendingState(
  windowId: string,
  kind: 'plan' | 'question' | 'approval',
  summary: string,
) {
  const snapshot = agentSessions.get(windowId)
  if (!snapshot) throw new Error(`Missing agent session ${windowId}.`)
  if (kind === 'plan') snapshot.pendingPlanApproval = null
  if (kind === 'question') snapshot.pendingQuestion = null
  if (kind === 'approval') snapshot.pendingApproval = null
  appendAgentSystemMessage(snapshot, summary)
  emitAgentSnapshot(snapshot)
}

function getAgentQueuePauseSet(windowId: string) {
  let set = agentQueuePauseReasons.get(windowId)
  if (!set) {
    set = new Set<string>()
    agentQueuePauseReasons.set(windowId, set)
  }
  return set
}

function isAgentQueuePaused(windowId: string) {
  return (agentQueuePauseReasons.get(windowId)?.size ?? 0) > 0
}

function setAgentQueuePaused(windowId: string, reason: string, paused: boolean) {
  const set = getAgentQueuePauseSet(windowId)
  if (paused) set.add(reason)
  else set.delete(reason)
  if (set.size === 0) agentQueuePauseReasons.delete(windowId)
}

function setNwAgentQueue(windowId: string, messages: QueuedAgentMessage[]) {
  const sanitized = sanitizeQueuedMessages(messages)
  if (sanitized.length === 0) agentQueues.delete(windowId)
  else agentQueues.set(windowId, sanitized)
  agentQueueUpdate.emit({ windowId, queuedMessages: sanitized })
  return sanitized
}

function updateAgentQueueRequest(
  windowId: string,
  updates: {
    permissionMode?: AgentPermissionMode | null
    contextLength?: AgentContextLength | null
  },
) {
  const existing = agentQueueRequests.get(windowId)
  if (!existing) return
  agentQueueRequests.set(windowId, { ...existing, ...updates })
}

function maybeDrainNwAgentQueue(windowId: string) {
  if (isAgentQueuePaused(windowId)) return
  const queue = agentQueues.get(windowId) ?? []
  if (queue.length === 0) return
  let snapshot = agentSessions.get(windowId)
  if (snapshot?.status === 'running') return
  const request = agentQueueRequests.get(windowId)
  if (!snapshot) {
    if (!request) return
    snapshot = createAgentSnapshot({ ...request, initialPrompt: null })
    emitAgentSnapshot(snapshot)
  }
  const [next, ...remaining] = queue
  setNwAgentQueue(windowId, remaining)
  if (next.mode === 'stop') {
    void window.cells.agentSession.close(windowId).finally(() => maybeDrainNwAgentQueue(windowId))
    return
  }
  const input = next.text.trim()
  if (!input && next.attachments.length === 0) {
    window.setTimeout(() => maybeDrainNwAgentQueue(windowId), 0)
    return
  }
  snapshot.messages.push(
    createAgentMessage('user', next.text, {
      attachments: next.attachments,
      replyTo: next.replyTo ?? null,
    }),
  )
  emitAgentSnapshot(snapshot)
  runAgentTurn(snapshot, next.text)
}

function getAgentBinary(agent: AgentSessionName) {
  return (
    (resolveAgentBinary(agent) ?? customAgentPaths[agent]?.trim()) ||
    AGENT_BINARY_CANDIDATES[agent]?.[0] ||
    agent
  )
}

function discoverRuntimeExtensionId(extension: ExtensionMeta) {
  return new Promise<string | null>((resolve) => {
    const chromeApi = (
      globalThis as typeof globalThis & {
        chrome?: {
          management?: {
            getAll(
              callback: (
                items: Array<{ id: string; name?: string; description?: string; path?: string }>,
              ) => void,
            ): void
          }
        }
      }
    ).chrome
    const management = chromeApi?.management
    if (!management?.getAll) {
      resolve(null)
      return
    }
    try {
      management.getAll((items) => {
        const sourcePath = extension.sourceUrl
        const match = items.find((item) => {
          return (
            item.name === extension.name ||
            item.id === extension.id ||
            item.path === sourcePath ||
            item.description === extension.description
          )
        })
        resolve(match?.id ?? null)
      })
    } catch {
      resolve(null)
    }
  })
}

function buildAgentArgs(agent: AgentSessionName, input: string) {
  switch (agent) {
    case 'codex':
      return ['exec', input]
    case 'claude':
      return ['-p', input]
    case 'opencode':
      return ['run', input]
    case 'copilot':
      return ['suggest', input]
    case 'cursor':
      return [input]
    default:
      return [input]
  }
}

type NwAgentAuthStatus = {
  agent: AgentSessionName
  binaryPath: string | null
  authenticated: boolean | 'unknown'
  account?: string | null
}

type NwCapturedCommandResult = {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
}

const ANSI_COLOR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

function appendBoundedOutput(current: string, next: string, max = 16_000) {
  return (current + next).slice(-max)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseJsonRecord(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return null
  const candidates = [trimmed]
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  }
  for (const candidate of candidates) {
    try {
      return asRecord(JSON.parse(candidate))
    } catch {}
  }
  return null
}

async function runNwCapturedCommand(
  binary: string,
  args: string[],
  options: {
    timeoutMs?: number
    cwd?: string | null
    env?: Record<string, string | undefined>
  } = {},
): Promise<NwCapturedCommandResult> {
  const childProcess = requireNode<typeof import('node:child_process')>('node:child_process')
  const timeoutMs = options.timeoutMs ?? 5_000
  return await new Promise<NwCapturedCommandResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child: import('node:child_process').ChildProcess
    try {
      child = childProcess.spawn(binary, args, {
        cwd: options.cwd ?? (getUserHomeDir() || undefined),
        env: buildNwUserEnv({ NO_COLOR: '1', FORCE_COLOR: '0', ...options.env }),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    const finish = (result: NwCapturedCommandResult | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const timer = window.setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish(new Error(`${binary} ${args.join(' ')} timed out`))
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendBoundedOutput(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendBoundedOutput(stderr, chunk)
    })
    child.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))))
    child.on('close', (code, signal) => finish({ stdout, stderr, code, signal }))
  })
}

async function probeNwAgentAuth(agent: AgentSessionName): Promise<NwAgentAuthStatus> {
  const binaryPath = resolveAgentBinary(agent)
  if (!binaryPath) return { agent, binaryPath: null, authenticated: false, account: null }
  try {
    if (agent === 'claude') {
      const result = await runNwCapturedCommand(binaryPath, ['auth', 'status'])
      const payload = parseJsonRecord(`${result.stdout}\n${result.stderr}`)
      const loggedIn = payload && typeof payload.loggedIn === 'boolean' ? payload.loggedIn : null
      return {
        agent,
        binaryPath,
        authenticated: loggedIn ?? 'unknown',
        account: asString(payload?.email),
      }
    }
    if (agent === 'codex') {
      const result = await runNwCapturedCommand(binaryPath, ['login', 'status'])
      const output = `${result.stdout}\n${result.stderr}`.replace(ANSI_COLOR_RE, '')
      return {
        agent,
        binaryPath,
        authenticated:
          result.code === 0 && /logged in|authenticated|chatgpt|api key/i.test(output)
            ? true
            : /not logged|not authenticated|login required|missing credentials/i.test(output)
              ? false
              : 'unknown',
        account: null,
      }
    }
    if (agent === 'cursor') {
      const result = await runNwCapturedCommand(binaryPath, ['status', '--format', 'json'])
      const payload = parseJsonRecord(`${result.stdout}\n${result.stderr}`)
      const userInfo = asRecord(payload?.userInfo)
      const status = asString(payload?.status)
      const authenticated =
        payload && typeof payload.isAuthenticated === 'boolean'
          ? payload.isAuthenticated
          : status === 'authenticated'
            ? true
            : status === 'unauthenticated'
              ? false
              : 'unknown'
      return {
        agent,
        binaryPath,
        authenticated,
        account: asString(userInfo?.email),
      }
    }
    if (agent === 'opencode') {
      const result = await runNwCapturedCommand(binaryPath, ['auth', 'list'])
      const output = `${result.stdout}\n${result.stderr}`.replace(ANSI_COLOR_RE, '')
      return {
        agent,
        binaryPath,
        authenticated:
          /\bcredentials?\b/i.test(output) && !/\b0 credentials?\b/i.test(output)
            ? true
            : /not logged in|no credentials|login/i.test(output)
              ? false
              : 'unknown',
        account: null,
      }
    }
    return { agent, binaryPath, authenticated: 'unknown', account: null }
  } catch {
    return { agent, binaryPath, authenticated: 'unknown', account: null }
  }
}

function getAgentLoginCommand(agent: AgentSessionName) {
  const binary = resolveAgentBinary(agent)
  const fallback = AGENT_LOGIN_COMMANDS[agent] ?? getAgentBinary(agent)
  if (!binary) return fallback
  switch (agent) {
    case 'claude':
      return `${shellQuote(binary)}`
    case 'codex':
      return `${shellQuote(binary)} login`
    case 'cursor':
      return `${shellQuote(binary)} login`
    case 'opencode':
      return `${shellQuote(binary)} auth login`
    default:
      return fallback
  }
}

function appendAgentError(snapshot: AgentSessionSnapshot, message: string) {
  snapshot.status = 'error'
  snapshot.error = message
  snapshot.messages.push(createAgentMessage('error', message, { status: 'failed' }))
  emitAgentSnapshot(snapshot)
}

function runAgentTurn(snapshot: AgentSessionSnapshot, input: string) {
  const childProcess = requireNode<typeof import('node:child_process')>('node:child_process')
  const command = getAgentBinary(snapshot.agent)
  const args = buildAgentArgs(snapshot.agent, input)
  const assistant = createAgentMessage('assistant', '', { status: 'in_progress' })

  snapshot.status = 'running'
  snapshot.error = null
  snapshot.messages.push(assistant)
  emitAgentSnapshot(snapshot)

  let child: import('node:child_process').ChildProcess
  try {
    child = childProcess.spawn(command, args, {
      cwd: snapshot.cwd ?? (getUserHomeDir() || getHomeDir()),
      env: buildNwUserEnv(snapshot.cwd ? { PWD: snapshot.cwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    snapshot.messages = snapshot.messages.filter((message) => message.id !== assistant.id)
    appendAgentError(snapshot, error instanceof Error ? error.message : String(error))
    return
  }

  agentProcesses.set(snapshot.windowId, child)
  const append = (chunk: Buffer | string) => {
    assistant.text += chunk.toString()
    assistant.updatedAt = Date.now()
    emitAgentSnapshot(snapshot)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.on('error', (error) => {
    agentProcesses.delete(snapshot.windowId)
    assistant.status = 'failed'
    appendAgentError(snapshot, error.message)
    window.setTimeout(() => maybeDrainNwAgentQueue(snapshot.windowId), 0)
  })
  child.on('close', (code, signal) => {
    agentProcesses.delete(snapshot.windowId)
    assistant.updatedAt = Date.now()
    assistant.status = code === 0 ? 'completed' : 'failed'
    snapshot.status = code === 0 ? 'idle' : 'error'
    snapshot.error =
      code === 0
        ? null
        : `${snapshot.agent} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`
    if (!assistant.text.trim() && snapshot.error) assistant.text = snapshot.error
    emitAgentSnapshot(snapshot)
    if (code === 0) window.setTimeout(() => maybeDrainNwAgentQueue(snapshot.windowId), 0)
  })
}

function getPinnedIdFromLocation() {
  return new URLSearchParams(window.location.search).get('pinned')
}

function getPinnedTypeFromLocation(): PinnedWindowType | null {
  const type = new URLSearchParams(window.location.search).get('type')
  return type === 'terminal' ||
    type === 'browser' ||
    type === 'agent' ||
    type === 'editor' ||
    type === 'section'
    ? type
    : null
}

function createPopoutChannel() {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('cells-nw-popouts')
  } catch {
    return null
  }
}

const popoutChannel = createPopoutChannel()

function postPopoutMessage(message: NwPopoutMessage) {
  try {
    popoutChannel?.postMessage(message)
  } catch {}
}

function emitNwWindowUnpinned(
  id: string,
  type: PinnedWindowType,
  snapshot?: { url?: string | null; title?: string | null } | null,
) {
  if (pinnedUnpinNotified.has(id)) return
  pinnedUnpinNotified.add(id)
  windowUnpinned.emit(id, type, snapshot ?? null)
  postPopoutMessage({ kind: 'unpinned', id, type, snapshot: snapshot ?? null })
}

function getNwBrowserWindowSnapshot(win?: NwWindowHandle | null, fallbackUrl?: string | null) {
  try {
    const currentUrl = win?.window?.location?.href
    const title = win?.window?.document?.title || null
    return {
      url: currentUrl && currentUrl !== 'about:blank' ? currentUrl : (fallbackUrl ?? null),
      title,
    }
  } catch {
    return { url: fallbackUrl ?? null, title: null }
  }
}

function openNwPinnedWindow(
  id: string,
  type: PinnedWindowType,
  bounds: { x: number; y: number; width: number; height: number },
  browserUrl?: string,
) {
  const gui = requireNode<any>('nw.gui')
  const existing = pinnedWindows.get(id)
  if (existing) existing.close(true)
  pinnedWindows.delete(id)
  pinnedWindowTypes.delete(id)
  pinnedUnpinNotified.delete(id)

  const isBrowser = type === 'browser' && Boolean(browserUrl)
  const url = isBrowser ? browserUrl! : new URL('cells.html', window.location.href).toString()
  const pinnedUrl = new URL(url, window.location.href)
  if (!isBrowser) {
    pinnedUrl.searchParams.set('pinned', id)
    pinnedUrl.searchParams.set('type', type)
  }

  gui.Window.open(
    pinnedUrl.toString(),
    {
      id: `cells-popout-${id}`,
      title: isBrowser ? 'Cells Browser' : 'Cells',
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      min_width: 320,
      min_height: 200,
      frame: isBrowser,
      show: true,
      always_on_top: true,
      new_instance: false,
    },
    (win: NwWindowHandle) => {
      pinnedWindows.set(id, win)
      pinnedWindowTypes.set(id, type)
      win.focus?.()
      win.show?.()
      win.on?.('close', function (this: NwWindowHandle) {
        const snapshot = isBrowser ? getNwBrowserWindowSnapshot(this, browserUrl ?? null) : null
        emitNwWindowUnpinned(id, type, snapshot)
        this.close(true)
      })
      win.on?.('closed', () => {
        pinnedWindows.delete(id)
        pinnedWindowTypes.delete(id)
      })
      win.on?.('resize', (width: number, height: number) => {
        windowResized.emit(id, type, Math.round(width), Math.round(height))
        postPopoutMessage({
          kind: 'resized',
          id,
          type,
          width: Math.round(width),
          height: Math.round(height),
        })
      })
    },
  )
}

function setupPinnedNwWindowLifecycle() {
  const id = getPinnedIdFromLocation()
  const type = getPinnedTypeFromLocation()
  if (!id || !type) return
  try {
    const gui = requireNode<any>('nw.gui')
    const win = gui.Window.get()
    let closing = false
    win.on?.('close', function (this: NwWindowHandle) {
      if (closing) {
        this.close(true)
        return
      }
      closing = true
      postPopoutMessage({ kind: 'unpinned', id, type, snapshot: null })
      this.close(true)
    })
    win.on?.('resize', (width: number, height: number) => {
      postPopoutMessage({
        kind: 'resized',
        id,
        type,
        width: Math.round(width),
        height: Math.round(height),
      })
    })
  } catch {}
}

function setupMainNwWindowLifecycle() {
  if (getPinnedIdFromLocation()) return
  try {
    const gui = requireNode<NwGui>('nw.gui')
    const win = gui.Window.get()
    let closing = false
    win.on?.('focus', () => {
      if (nwAppBlurTimer !== null) {
        window.clearTimeout(nwAppBlurTimer)
        nwAppBlurTimer = null
      }
      appWindowFocus.emit(true)
    })
    win.on?.('blur', () => {
      if (nwAppBlurTimer !== null) window.clearTimeout(nwAppBlurTimer)
      nwAppBlurTimer = window.setTimeout(() => {
        nwAppBlurTimer = null
        if (Date.now() - lastNwWebviewFocusAt < 1000) {
          appWindowFocus.emit(true)
          return
        }
        appWindowFocus.emit(false)
      }, 250)
    })
    win.on?.('close', function (this: NwWindowHandle) {
      if (closing) {
        this.close(true)
        return
      }
      closing = true
      emitBeforeQuitOnce()
      this.close(true)
    })
  } catch (error) {
    console.warn('[nw] failed to install main window lifecycle', error)
  }
}

function setupNwSmokeHooks() {
  if (getNodeProcess()?.env.CELLS_NW_CONTEXT_MENU_TEST_MODE !== '1') return
  ;(
    window as typeof window & {
      __cellsNwSetAgentPending?: (
        windowId: string,
        kind: 'plan' | 'question' | 'approval',
      ) => boolean
    }
  ).__cellsNwSetAgentPending = (windowId, kind) => {
    const snapshot = agentSessions.get(windowId)
    if (!snapshot) return false

    const createdAt = Date.now()
    if (kind === 'plan') {
      snapshot.pendingPlanApproval = { plan: 'NW smoke plan', createdAt }
    } else if (kind === 'question') {
      snapshot.pendingQuestion = {
        createdAt,
        questions: [
          {
            id: 'nw-smoke-question',
            question: 'Proceed?',
            header: 'NW smoke',
            options: [{ label: 'Yes', description: 'Continue' }],
            multiSelect: false,
          },
        ],
      }
    } else {
      snapshot.pendingApproval = {
        kind: 'command',
        title: 'Run smoke command',
        command: 'echo smoke',
        cwd: snapshot.cwd ?? null,
        canApproveForSession: true,
        createdAt,
      }
    }

    emitAgentSnapshot(snapshot)
    return true
  }
}

export function installNwCellsAdapter() {
  window.cellsRuntime = 'nw'
  initializeExtensionState()
  startNwPerfMonitor()
  setupPinnedNwWindowLifecycle()
  setupMainNwWindowLifecycle()
  installNwShortcutMenu()
  setupNwSmokeHooks()

  window.addEventListener('focus', () => {
    if (nwAppBlurTimer !== null) {
      window.clearTimeout(nwAppBlurTimer)
      nwAppBlurTimer = null
    }
    appWindowFocus.emit(true)
  })
  window.addEventListener('blur', () => {
    if (nwAppBlurTimer !== null) window.clearTimeout(nwAppBlurTimer)
    nwAppBlurTimer = window.setTimeout(() => {
      nwAppBlurTimer = null
      if (Date.now() - lastNwWebviewFocusAt < 1000) {
        appWindowFocus.emit(true)
        return
      }
      appWindowFocus.emit(false)
    }, 250)
  })
  window.addEventListener('cells-nw-webview-focused', () => {
    lastNwWebviewFocusAt = Date.now()
    if (nwAppBlurTimer !== null) {
      window.clearTimeout(nwAppBlurTimer)
      nwAppBlurTimer = null
    }
    appWindowFocus.emit(true)
  })
  window.addEventListener('beforeunload', () => emitBeforeQuitOnce())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') systemResume.emit('resume')
  })
  popoutChannel?.addEventListener('message', (event) => {
    const message = event.data as NwPopoutMessage
    if (!message || typeof message !== 'object') return
    if (message.kind === 'unpinned') {
      emitNwWindowUnpinned(message.id, message.type, message.snapshot ?? null)
      return
    }
    if (message.kind === 'resized') {
      windowResized.emit(message.id, message.type, message.width, message.height)
    }
  })

  window.addEventListener('cells-nw-browser-event', (event) => {
    const detail = (event as CustomEvent).detail ?? {}
    const browserId = String(detail.browserId ?? '')
    if (!browserId) return
    const state = getBrowserState(browserId)
    if (typeof detail.url === 'string') state.url = detail.url
    if (typeof detail.title === 'string') state.title = detail.title
    if (typeof detail.canGoBack === 'boolean') state.canGoBack = detail.canGoBack
    if (typeof detail.canGoForward === 'boolean') state.canGoForward = detail.canGoForward
    if (typeof detail.loading === 'boolean') state.isLoading = detail.loading
    if (typeof detail.themeColor === 'string' || detail.themeColor === null) {
      state.themeColor = detail.themeColor
    }
    if (typeof detail.faviconUrl === 'string' || detail.faviconUrl === null) {
      state.faviconUrl = detail.faviconUrl
    }
    if ('failure' in detail) state.failure = detail.failure ?? null
    if (Array.isArray(detail.historyEntries) && typeof detail.activeIndex === 'number') {
      state.history = { entries: detail.historyEntries, activeIndex: detail.activeIndex }
    }

    switch (detail.kind) {
      case 'focus':
        browserFocused.emit(browserId)
        break
      case 'title':
        browserTitle.emit(browserId, state.title)
        break
      case 'url':
        browserUrl.emit(browserId, state.url)
        browserNav.emit(browserId, state.canGoBack, state.canGoForward)
        break
      case 'loading':
        browserLoading.emit(browserId, state.isLoading)
        break
      case 'nav':
        browserNav.emit(browserId, state.canGoBack, state.canGoForward)
        break
      case 'new-window':
        if (typeof detail.url === 'string') browserNewWindow.emit(browserId, detail.url)
        break
      case 'failure':
        if (state.failure) browserFailure.emit(browserId, state.failure)
        break
      case 'theme-color':
        browserTheme.emit(browserId, state.themeColor)
        break
      case 'favicon':
        browserFavicon.emit(browserId, state.faviconUrl)
        break
      case 'element-selected':
        if (detail.selection && typeof detail.selection === 'object') {
          browserElementSelected.emit(
            browserId,
            typeof detail.targetAgentWindowId === 'string' ? detail.targetAgentWindowId : null,
            detail.selection as BrowserElementSelection,
          )
        }
        break
      case 'element-picker-cancelled':
        browserPickerCancelled.emit(
          browserId,
          typeof detail.targetAgentWindowId === 'string' ? detail.targetAgentWindowId : null,
        )
        break
      case 'shortcut':
        if (detail.command === 'window-cycle-forward') {
          browserWindowCycle.emit(1)
          break
        }
        if (detail.command === 'window-cycle-back') {
          browserWindowCycle.emit(-1)
          break
        }
        if (detail.command === 'project-cycle-forward') {
          browserProjectCycle.emit(1)
          break
        }
        if (detail.command === 'project-cycle-back') {
          browserProjectCycle.emit(-1)
          break
        }
        if (typeof detail.command === 'string') {
          appShortcut.emit({
            command: detail.command as CellsShortcutCommand,
            source: 'browser-view',
            browserId,
          })
        }
        break
      case 'canvas-wheel':
        if (detail.gesture && typeof detail.gesture === 'object') {
          browserCanvasWheel.emit(browserId, detail.gesture as BrowserCanvasWheelGesture)
        }
        break
      case 'overscroll': {
        const progress = typeof detail.progress === 'number' ? detail.progress : 0
        const direction = typeof detail.direction === 'string' ? detail.direction : null
        browserOverscroll.emit(browserId, progress, direction)
        if (detail.commit === true) {
          if (direction === 'back') dispatchBrowserCommand(browserId, 'back')
          else if (direction === 'forward') dispatchBrowserCommand(browserId, 'forward')
        }
        break
      }
      case 'context-menu':
        showNwBrowserContextMenu(browserId, {
          x: typeof detail.x === 'number' ? detail.x : 0,
          y: typeof detail.y === 'number' ? detail.y : 0,
          linkUrl: typeof detail.linkUrl === 'string' ? detail.linkUrl : null,
          imageUrl: typeof detail.imageUrl === 'string' ? detail.imageUrl : null,
          isEditable: Boolean(detail.isEditable),
          selectionText: typeof detail.selectionText === 'string' ? detail.selectionText : '',
        })
        break
    }
  })

  const api: CellsAPI = {
    terminal: {
      attach: async (termId, cols, rows, cwd) => {
        addTerminalSubscription(termId)
        const existing = ptySessions.get(termId)
        if (existing && !existing.exited) {
          existing.cols = cols
          existing.rows = rows
          try {
            existing.pty.resize(cols, rows)
          } catch {}
          setTimeout(() => terminalStatus.emit(termId, buildTerminalStatus(existing)), 0)
          return { reattached: true, buffer: existing.buffer, backend: 'replay' }
        }
        const session = createPtySession(termId, cols, rows, cwd)
        const launch = terminalLaunches.get(termId)
        if (launch) session.launch = launch
        return { reattached: false, buffer: session.buffer, backend: 'replay' }
      },
      unsubscribe: async (termId) => {
        removeTerminalSubscription(termId)
      },
      detach: async (termId) => {
        clearTerminalSubscriptions(termId)
        const session = ptySessions.get(termId)
        if (!session) return
        try {
          session.pty.kill()
        } catch {}
        ptySessions.delete(termId)
      },
      write: (termId, data) => {
        const session = ptySessions.get(termId)
        if (!session || session.exited) return
        session.pty.write(data)
      },
      resize: (termId, cols, rows) => {
        const session = ptySessions.get(termId)
        if (!session || session.exited) return
        session.cols = cols
        session.rows = rows
        try {
          session.pty.resize(cols, rows)
        } catch {}
      },
      handleWheel: async (termId, _direction, _steps, sequence) => {
        const session = ptySessions.get(termId)
        if (!session || session.exited || !sequence) return
        session.pty.write(sequence)
      },
      getProcess: async (termId) => ptySessions.get(termId)?.shell ?? null,
      getProcessInfo: async (termId) => {
        const session = ptySessions.get(termId)
        return session && !session.exited ? getTerminalProcessInfo(session) : null
      },
      getCodexTitle: async (termId) => {
        const launch = ptySessions.get(termId)?.launch ?? terminalLaunches.get(termId)
        return launch?.agent === 'codex' ? (launch.command ?? null) : null
      },
      getScrollStatus: async (termId) => {
        const session = ptySessions.get(termId)
        if (!session) return null
        return {
          backend: 'replay' as const,
          paneInMode: false,
          scrollPosition: 0,
          historySize: session.buffer.length,
          mouseAnyFlag: false,
          alternateOn: false,
        }
      },
      getHistory: async (termId) => ptySessions.get(termId)?.buffer ?? '',
      getHistoryPage: async (termId, _token, offset, maxBytes = 64_000) => {
        const history = ptySessions.get(termId)?.buffer ?? ''
        const start = Math.max(0, offset ?? 0)
        const chunk = history.slice(start, start + maxBytes)
        const nextOffset = start + chunk.length
        return {
          chunk,
          done: nextOffset >= history.length,
          offset: nextOffset >= history.length ? null : nextOffset,
          token: null,
          totalBytes: history.length,
        }
      },
      getStatus: async (termId) => {
        const session = ptySessions.get(termId)
        return session ? buildTerminalStatus(session) : null
      },
      registerLaunch: async (termId, launch) => {
        terminalLaunches.set(termId, launch)
        const session = ptySessions.get(termId)
        if (session) {
          session.launch = launch
          terminalStatus.emit(termId, buildTerminalStatus(session))
        }
      },
      onData: terminalData.on,
      onStatus: terminalStatus.on,
      onExit: terminalExit.on,
    },
    agentSession: {
      ensure: async (request) => {
        const existing = agentSessions.get(request.windowId)
        if (existing) {
          emitAgentSnapshot(existing)
          return existing
        }
        const snapshot = createAgentSnapshot(request)
        emitAgentSnapshot(snapshot)
        if (request.initialPrompt?.trim()) runAgentTurn(snapshot, request.initialPrompt.trim())
        return snapshot
      },
      subscribeUpdates: async () => {},
      unsubscribeUpdates: async () => {},
      send: async (windowId, input, attachments = [], _overrides, replyTo = null) => {
        const snapshot = agentSessions.get(windowId)
        if (!snapshot) throw new Error(`Missing agent session ${windowId}.`)
        if (snapshot.status === 'running') throw new Error('Agent session is already running.')
        const trimmed = input.trim()
        if (!trimmed && attachments.length === 0) return
        snapshot.messages.push(
          createAgentMessage('user', input, {
            attachments,
            replyTo,
          }),
        )
        emitAgentSnapshot(snapshot)
        runAgentTurn(snapshot, input)
      },
      branchFrom: async (
        _sourceWindowId,
        request,
        visibleInput,
        providerInput,
        attachments = [],
        overrides,
        replyTo,
      ) => {
        const snapshot = createAgentSnapshot(request)
        agentSessions.set(request.windowId, snapshot)
        emitAgentSnapshot(snapshot)
        await window.cells.agentSession.send(
          request.windowId,
          providerInput || visibleInput,
          attachments,
          overrides,
          replyTo ?? null,
        )
      },
      close: async (windowId) => {
        const child = agentProcesses.get(windowId)
        if (child) {
          child.kill()
          agentProcesses.delete(windowId)
        }
        const snapshot = agentSessions.get(windowId)
        if (snapshot) {
          snapshot.status = 'idle'
          emitAgentSnapshot(snapshot)
        }
      },
      dispose: async (windowId) => {
        await window.cells.agentSession.close(windowId)
        agentSessions.delete(windowId)
      },
      reportQueues: (reports) => {
        for (const report of reports) {
          if (!report || report.windowId !== report.request?.windowId) continue
          agentQueueRequests.set(report.windowId, report.request)
          setNwAgentQueue(report.windowId, report.queuedMessages)
          maybeDrainNwAgentQueue(report.windowId)
        }
      },
      startQueuedDrain: (windowId) => {
        setAgentQueuePaused(windowId, 'missing-runtime', false)
        setAgentQueuePaused(windowId, 'resume-gate', false)
        maybeDrainNwAgentQueue(windowId)
      },
      setQueueDrainPaused: (windowId, reason, paused) => {
        setAgentQueuePaused(windowId, reason, paused)
        if (!paused) maybeDrainNwAgentQueue(windowId)
      },
      reportQueueCount: (windowId, count) => {
        if (count <= 0 && !agentQueues.has(windowId))
          agentQueueUpdate.emit({ windowId, queuedMessages: [] })
      },
      notifyQueuedStart: (windowId) => {
        void showNwNotification('Queued agent turn starting', windowId, { playSound: false })
      },
      getAuth: async (agent: AgentSessionName) => probeNwAgentAuth(agent),
      getLoginCommand: async (agent) => getAgentLoginCommand(agent),
      startLogin: async (agent) => {
        const command = await window.cells.agentSession.getLoginCommand(agent)
        agentLoginEvent.emit({
          agent,
          phase: 'starting',
          message: command
            ? `Opening a terminal login command for ${agent}.`
            : `No login command is configured for ${agent}.`,
        })
        if (command) {
          const state = useStore.getState()
          const terminal = state.addTerminalWithCommand(command, `${agent} login`)
          await window.cells.terminal.registerLaunch(terminal.id, {
            agent,
            command,
            cwd: state.getActiveProjectPath() ?? null,
            startedAt: Date.now(),
          })
          agentLoginEvent.emit({
            agent,
            phase: 'success',
            message: 'Login command opened in a Cells terminal.',
          })
        } else {
          agentLoginEvent.emit({ agent, phase: 'failed', message: 'Login command unavailable.' })
        }
      },
      cancelLogin: async (agent) => {
        agentLoginEvent.emit({ agent, phase: 'cancelled' })
      },
      updatePermissionMode: async (windowId, mode) => {
        updateAgentQueueRequest(windowId, { permissionMode: mode })
      },
      updateContextLength: async (windowId, length) => {
        updateAgentQueueRequest(windowId, { contextLength: length })
      },
      respondPlan: async (windowId, decision, feedback) => {
        clearAgentPendingState(
          windowId,
          'plan',
          `Plan response: ${decision}${feedback?.trim() ? ` - ${feedback.trim()}` : ''}`,
        )
      },
      respondQuestion: async (windowId, answers, note) => {
        const count = answers ? Object.keys(answers).length : 0
        clearAgentPendingState(
          windowId,
          'question',
          answers
            ? `Question response submitted (${count}).${note?.trim() ? ` ${note.trim()}` : ''}`
            : `Question response cancelled.${note?.trim() ? ` ${note.trim()}` : ''}`,
        )
      },
      respondApproval: async (windowId, decision) => {
        clearAgentPendingState(windowId, 'approval', `Approval response: ${decision}`)
      },
      listCodexModels: async () => NW_CODEX_MODELS,
      listClaudeModels: async () => NW_CLAUDE_MODELS,
      listCursorModels: async () => NW_CURSOR_MODELS,
      listCopilotModels: async () => NW_COPILOT_MODELS,
      listOpencodeModels: async () => NW_OPENCODE_MODELS,
      listSavedSessions: async () =>
        [...agentSessions.values()]
          .map(summarizeAgentSnapshot)
          .sort((a, b) => b.updatedAt - a.updatedAt),
      listRecentSessions: async (agent, limit = 20) =>
        [...agentSessions.values()]
          .filter((snapshot) => snapshot.agent === agent)
          .map((snapshot) => ({
            ...summarizeAgentSnapshot(snapshot),
            origin: 'cells' as const,
            nativeId: null,
            sourceLabel: 'Cells session',
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, limit),
      onLoginEvent: agentLoginEvent.on,
      onUpdate: agentUpdate.on,
      onQueueUpdate: agentQueueUpdate.on,
    },
    git: {
      isRepo: async (cwd) => getGitRoot(cwd) !== null,
      repoRoot: async (cwd) => getGitRoot(cwd),
      listWorktrees: async (cwd) => parseWorktreeList(cwd),
      createWorktree: async (cwd, options: GitWorktreeCreateOptions) => {
        const root = getGitRoot(cwd)
        if (!root) throw new Error('Not inside a Git repository.')
        const validation = validateBranchName(root, options.branchName)
        if (!validation.valid) throw new Error(validation.message ?? 'Invalid branch name.')
        const path = requireNode<typeof import('node:path')>('node:path')
        const targetDir =
          options.targetDir ||
          path.join(
            path.dirname(root),
            `${path.basename(root)}-${options.branchName.replace(/[^a-z0-9._-]+/gi, '-')}`,
          )
        const args = ['worktree', 'add']
        if (!options.checkoutExistingBranch) args.push('-b')
        args.push(options.branchName, targetDir)
        if (options.baseRef) args.push(options.baseRef)
        execFileText('git', args, { cwd: root })
        return getWorktreeStatus(targetDir, root, false)
      },
      removeWorktree: async (cwd, worktreePath, options) => {
        const root = getGitRoot(cwd)
        if (!root) throw new Error('Not inside a Git repository.')
        execFileText(
          'git',
          ['worktree', 'remove', ...(options?.force ? ['--force'] : []), worktreePath],
          {
            cwd: root,
          },
        )
      },
      pruneWorktrees: async (cwd) => {
        const root = getGitRoot(cwd)
        if (!root) return
        execFileText('git', ['worktree', 'prune'], { cwd: root })
      },
      validateBranch: async (cwd, branchName) => validateBranchName(cwd, branchName),
      statusWorktree: async (worktreePath) => {
        const root = getGitRoot(worktreePath)
        return root ? getWorktreeStatus(worktreePath, root, worktreePath === root) : null
      },
    },
    agent: {
      checkAvailable: async (aliases, paths) => {
        const result: Record<string, boolean> = {}
        const agents = Object.keys(AGENT_BINARY_CANDIDATES) as AgentSessionName[]
        for (const agent of agents) {
          const explicitPath = paths?.[agent]?.trim()
          const alias = aliases?.[agent]?.trim()
          const custom = customAgentPaths[agent]?.trim()
          const candidates = [
            explicitPath,
            custom,
            alias,
            ...(AGENT_BINARY_CANDIDATES[agent] ?? []),
          ].filter(Boolean) as string[]
          result[agent] = candidates.some((candidate) => commandExists(candidate))
        }
        return result
      },
      setCustomPaths: async (paths) => {
        customAgentPaths = paths
      },
    },
    daemon: {
      getStatus: async () => ({
        enabled: false,
        connected: false,
        sessionCount: [...ptySessions.values()].filter((session) => !session.exited).length,
        appVersion: 'dev',
        currentElectronVersion: null,
        currentNodeAbi: getNodeProcess()?.versions.modules ?? '',
        restartRecommended: false,
        restartReason: null,
        daemonVersion: null,
        backendDetails: null,
      }),
      listSessions: async () =>
        [...ptySessions.values()]
          .filter((session) => !session.exited)
          .map((session) => ({
            termId: session.termId,
            processInfo: getTerminalProcessInfo(session),
            runtimeStatus: buildTerminalStatus(session),
            subscribed: isTerminalSubscribed(session.termId),
          })),
      killSession: async (termId) => {
        const session = ptySessions.get(termId)
        if (!session || session.exited) return
        clearTerminalSubscriptions(termId)
        session.pty.kill()
      },
      killAll: async () => {
        for (const session of ptySessions.values()) {
          if (!session.exited) {
            clearTerminalSubscriptions(session.termId)
            session.pty.kill()
          }
        }
      },
      restart: async () => false,
    },
    updater: {
      getSupport: async () => getNwUpdaterSupport(),
      check: async () => emitNwUpdaterUnsupported(),
      download: async () => emitNwUpdaterUnsupported(),
      install: async () => false,
      getVersion: async () => getNwAppVersion(),
      setAutoUpdate: async (enabled) => {
        if (enabled) emitNwUpdaterUnsupported()
      },
      onStatus: updaterStatus.on,
    },
    perf: {
      enabled: true,
      reportRendererSample: async (sample) => reportNwRendererPerfSample(sample),
      reportTerminalSample: (sample) => reportNwTerminalPerfSample(sample),
      getStatus: async () => getNwPerfStatus(),
      getRecentEvents: async (limit = 50) => nwPerfEvents.slice(-Math.max(1, limit)),
    },
    state: {
      load: readState,
      save: writeState,
    },
    browser: {
      create: async (browserId, _projectId, history) => {
        const state = getBrowserState(browserId)
        if (history?.entries?.length) state.history = history
        dispatchBrowserCommand(browserId, 'create', { history })
        return { created: true }
      },
      destroy: async (browserId) => {
        dispatchBrowserCommand(browserId, 'destroy')
        browserStates.delete(browserId)
      },
      park: async (browserId) => dispatchBrowserCommand(browserId, 'park'),
      getHistory: async (browserId) => getBrowserState(browserId).history,
      getState: async (browserId) => getBrowserState(browserId),
      navigate: async (browserId, url, searchEngineUrl) => {
        const finalUrl = normalizeUrl(url, searchEngineUrl)
        getBrowserState(browserId).url = finalUrl
        dispatchBrowserCommand(browserId, 'navigate', { url: finalUrl })
      },
      focus: (browserId) => dispatchBrowserCommand(browserId, 'focus'),
      goBack: (browserId) => dispatchBrowserCommand(browserId, 'back'),
      goForward: (browserId) => dispatchBrowserCommand(browserId, 'forward'),
      reload: (browserId) => dispatchBrowserCommand(browserId, 'reload'),
      startElementPicker: async (browserId, targetAgentWindowId = null) => {
        dispatchBrowserCommand(browserId, 'picker-start', { targetAgentWindowId })
        return true
      },
      cancelElementPicker: (browserId) => {
        dispatchBrowserCommand(browserId, 'picker-cancel')
      },
      updateBounds: () => {},
      setVisible: () => {},
      setZoomFactor: (browserId, factor) => dispatchBrowserCommand(browserId, 'zoom', { factor }),
      toggleDevTools: (browserId) => dispatchBrowserCommand(browserId, 'devtools'),
      onViewFocused: browserFocused.on,
      onTitleUpdated: browserTitle.on,
      onUrlChanged: browserUrl.on,
      onNavState: browserNav.on,
      onLoading: browserLoading.on,
      onNewWindow: browserNewWindow.on,
      onFaviconUpdated: browserFavicon.on,
      onLoadFailed: browserFailure.on,
      onRenderGone: browserRenderGone.on,
      getAllHistory: async () => {
        const result: Record<string, { entries: BrowserHistoryEntry[]; activeIndex: number }> = {}
        for (const [browserId, state] of browserStates) result[browserId] = state.history
        return result
      },
      onThemeColor: browserTheme.on,
      onOverscroll: browserOverscroll.on,
      onCanvasWheel: browserCanvasWheel.on,
      onWindowCycle: browserWindowCycle.on,
      onProjectCycle: browserProjectCycle.on,
      onElementSelected: browserElementSelected.on,
      onElementPickerCancelled: browserPickerCancelled.on,
    },
    editor: {
      readFile: async (filePath) => {
        const require = getNodeRequire()
        if (!require) throw new Error('Node filesystem unavailable.')
        const fs = require('node:fs') as typeof import('node:fs')
        const path = require('node:path') as typeof import('node:path')
        const stat = fs.statSync(filePath)
        return {
          path: filePath,
          name: path.basename(filePath),
          content: fs.readFileSync(filePath, 'utf8'),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        }
      },
      writeFile: async (filePath, content) => {
        const require = getNodeRequire()
        if (!require) throw new Error('Node filesystem unavailable.')
        const fs = require('node:fs') as typeof import('node:fs')
        const path = require('node:path') as typeof import('node:path')
        fs.writeFileSync(filePath, content, 'utf8')
        const stat = fs.statSync(filePath)
        return {
          path: filePath,
          name: path.basename(filePath),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        }
      },
      saveFileAs: async (content, defaultPath, defaultDirectory) => {
        const path = requireNode<typeof import('node:path')>('node:path')
        const target =
          defaultPath ||
          path.join(
            defaultDirectory || getHomeDir(),
            `cells-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
          )
        await window.cells.editor.writeFile(target, content)
        return window.cells.editor.readFile(target)
      },
      lspOpen: async (request) => getNwEditorLspManager().openDocument(request),
      lspChange: async (uri, content, version) =>
        getNwEditorLspManager().changeDocument(uri, content, version),
      lspClose: async (uri) => getNwEditorLspManager().closeDocument(uri),
      lspCompletion: async (uri, position) => getNwEditorLspManager().completion(uri, position),
      lspHover: async (uri, position) => getNwEditorLspManager().hover(uri, position),
      lspDefinition: async (uri, position) => getNwEditorLspManager().definition(uri, position),
      onLspDiagnostics: lspDiagnostics.on,
    },
    extensions: {
      install: async (input) => {
        const fs = requireNode<typeof import('node:fs')>('node:fs')
        const path = requireNode<typeof import('node:path')>('node:path')
        const sourceDir = resolveNwExtensionInput(input)
        const manifestPath = path.join(sourceDir, 'manifest.json')
        if (!fs.existsSync(manifestPath)) {
          throw new Error(
            'Cells currently installs unpacked extensions from a local directory containing manifest.json.',
          )
        }
        const initialMeta = buildNwExtensionMeta(sourceDir)
        const storedDir = copyNwExtensionIntoStore(sourceDir, initialMeta.id)
        const meta = buildNwExtensionMeta(storedDir)
        meta.installedAt = Date.now()
        extensionState.extensions = [
          ...extensionState.extensions.filter((extension) => extension.id !== meta.id),
          meta,
        ]
        writeExtensionsState(extensionState)
        extensionInstalled.emit(meta)
        return meta
      },
      uninstall: async (extensionId) => {
        const fs = requireNode<typeof import('node:fs')>('node:fs')
        extensionState.extensions = extensionState.extensions.filter(
          (extension) => extension.id !== extensionId,
        )
        for (const [projectId, ids] of Object.entries(extensionState.projectExtensions)) {
          extensionState.projectExtensions[projectId] = ids.filter((id) => id !== extensionId)
        }
        const extensionsDir = getExtensionsDir()
        if (extensionsDir) {
          const path = requireNode<typeof import('node:path')>('node:path')
          fs.rmSync(path.join(extensionsDir, extensionId), { recursive: true, force: true })
        }
        writeExtensionsState(extensionState)
      },
      list: async () => ({ ...extensionState, extensions: [...extensionState.extensions] }),
      setEnabled: async (projectId, extensionId, enabled) => {
        const existing = extensionState.projectExtensions[projectId] ?? []
        extensionState.projectExtensions[projectId] = enabled
          ? [...new Set([...existing, extensionId])]
          : existing.filter((id) => id !== extensionId)
        writeExtensionsState(extensionState)
      },
      showPopup: async (extensionId) => {
        const extension = extensionState.extensions.find((entry) => entry.id === extensionId)
        if (!extension?.hasPopup) return
        const runtimeId = await discoverRuntimeExtensionId(extension)
        const popupPath = extensionPopupPaths.get(extensionId) ?? 'popup.html'
        if (!runtimeId) {
          throw new Error(
            `Cells could not discover a runtime ID for ${extension.name}. Open chrome://extensions in DevTools and navigate to chrome-extension://<id>/${popupPath}.`,
          )
        }
        await window.cells.app.openExternal(`chrome-extension://${runtimeId}/${popupPath}`)
      },
      hidePopup: async () => extensionPopupClosed.emit(),
      onPopupClosed: extensionPopupClosed.on,
      onInstalled: extensionInstalled.on,
    },
    app: {
      onWindowFocus: appWindowFocus.on,
      onFocusAgentWindow: focusAgentWindow.on,
      onCanvasZoom: canvasZoom.on,
      updateNotificationContext: (context) => {
        cachedAgentNotificationContext = {
          activeProjectId: context.activeProjectId ?? null,
          focusedAgentWindowId: context.focusedAgentWindowId ?? null,
        }
        ;(
          window as typeof window & {
            __cellsNwNotificationContext?: AgentNotificationContext
          }
        ).__cellsNwNotificationContext = cachedAgentNotificationContext
      },
      onBeforeQuit: beforeQuit.on,
      onDaemonDisconnected: daemonDisconnected.on,
      onSystemResume: systemResume.on,
      onNewTerminal: newTerminal.on,
      onCloseTerminal: closeTerminal.on,
      onShortcut: appShortcut.on,
      toggleMaximize: async () => {
        try {
          const gui = requireNode<any>('nw.gui')
          const win = gui.Window.get()
          if (win.isMaximized) win.unmaximize()
          else win.maximize()
        } catch {}
      },
      toggleFullscreen: async () => {
        try {
          const win = requireNode<NwGui>('nw.gui').Window.get()
          if (typeof win.toggleFullscreen === 'function') {
            win.toggleFullscreen()
          } else if (win.isFullscreen) {
            win.leaveFullscreen?.()
          } else {
            win.enterFullscreen?.()
          }
        } catch {}
      },
      resizeToFit: async (width, height) => window.resizeTo(width, height),
      pinWindow: async (id, type, bounds, browserUrl) => {
        openNwPinnedWindow(id, type as PinnedWindowType, bounds, browserUrl)
      },
      unpinWindow: async (id) => {
        const localPinnedId = getPinnedIdFromLocation()
        const localPinnedType = getPinnedTypeFromLocation()
        if (localPinnedId === id && localPinnedType) {
          postPopoutMessage({ kind: 'unpinned', id, type: localPinnedType, snapshot: null })
          try {
            requireNode<any>('nw.gui').Window.get().close(true)
          } catch {
            window.close()
          }
          return
        }

        const win = pinnedWindows.get(id)
        const type = pinnedWindowTypes.get(id) ?? 'browser'
        const snapshot = type === 'browser' ? getNwBrowserWindowSnapshot(win, null) : null
        if (win) {
          win.close(true)
          pinnedWindows.delete(id)
          pinnedWindowTypes.delete(id)
        }
        emitNwWindowUnpinned(id, type, snapshot)
      },
      onWindowUnpinned: windowUnpinned.on,
      onWindowResized: windowResized.on,
      getPinnedId: getPinnedIdFromLocation,
      getPinnedType: getPinnedTypeFromLocation,
      onOpenFiles: openFiles.on,
      pickFolder: async () => (await pickFileFromInput({ directory: true }))?.[0] ?? null,
      pickFiles: async () => pickFileFromInput({ multiple: true }),
      listRecentFiles: async () => {
        const home = getHomeDir()
        return searchProjectFiles(home, '')
          .slice(0, 30)
          .map((file) => ({ path: file.path, name: file.name, mtime: file.mtime, source: 'home' }))
      },
      searchProjectFiles: async (rootPath, query) => searchProjectFiles(rootPath, query),
      copyRichTextToClipboard: async (text, html) => {
        try {
          const gui = requireNode<
            NwGui & { Clipboard?: { get?: () => { set?: (value: string, type?: string) => void } } }
          >('nw.gui')
          const clipboard = gui.Clipboard?.get?.()
          if (clipboard?.set) {
            clipboard.set(text, 'text')
            if (html?.trim()) clipboard.set(html, 'html')
            return
          }
        } catch {}
        await navigator.clipboard?.writeText(text)
      },
      searchAgentMentions: async (cwd, query) => searchAgentMentionFiles(cwd, query),
      getPathForFile: (file) => (file as any).path ?? file.name,
      saveTempFile: async (data, filename) => {
        const fs = requireNode<typeof import('node:fs')>('node:fs')
        const os = requireNode<typeof import('node:os')>('node:os')
        const path = requireNode<typeof import('node:path')>('node:path')
        const dir = path.join(os.tmpdir(), 'cells-nw-attachments')
        fs.mkdirSync(dir, { recursive: true })
        const target = path.join(dir, filename.replace(/[\\/]/g, '_'))
        fs.writeFileSync(target, Buffer.from(data))
        return target
      },
      pasteClipboardFiles: async () => {
        const files = readDarwinClipboardFilePaths()
        if (files.length > 0) return files
        const imagePath = readDarwinClipboardImageToTempFile()
        return imagePath ? [imagePath] : null
      },
      openExternal: async (url) => {
        const require = getNodeRequire()
        try {
          const gui = require?.('nw.gui') as any
          gui?.Shell?.openExternal?.(url)
        } catch {
          window.open(url, '_blank')
        }
      },
      statPath: async (targetPath) => {
        const require = getNodeRequire()
        if (!require) return { kind: 'missing', resolved: targetPath }
        const fs = require('node:fs') as typeof import('node:fs')
        try {
          const stat = fs.statSync(targetPath)
          return { kind: stat.isDirectory() ? 'dir' : 'file', resolved: targetPath }
        } catch {
          return { kind: 'missing', resolved: targetPath }
        }
      },
      revealPath: async (targetPath) => {
        const childProcess = requireNode<typeof import('node:child_process')>('node:child_process')
        if (getNodeProcess()?.platform === 'darwin')
          childProcess
            .spawn('open', ['-R', targetPath], { detached: true, stdio: 'ignore' })
            .unref()
        else
          childProcess.spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' }).unref()
      },
      copyAttachmentToClipboard: async (targetPath) => {
        const fs = requireNode<typeof import('node:fs')>('node:fs')
        const path = requireNode<typeof import('node:path')>('node:path')
        const resolved = path.resolve(targetPath.replace(/^~(?=$|\/)/, getHomeDir()))
        const stat = fs.statSync(resolved)
        if (!stat.isFile()) throw new Error('Attachment is not a file')
        if (isImagePath(resolved)) {
          const { pathToFileURL } = requireNode<typeof import('node:url')>('node:url')
          await copyImageToClipboard(pathToFileURL(resolved).toString())
          return { kind: 'image' }
        }
        await navigator.clipboard?.writeText(resolved)
        return { kind: 'path' }
      },
      requestQuit: async () => {
        emitBeforeQuitOnce()
        try {
          requireNode<NwGui>('nw.gui').Window.get().close(true)
        } catch {
          window.close()
        }
      },
      relaunch: async () => {
        emitBeforeQuitOnce()
        window.location.reload()
      },
      repairTerminalFonts: repairNwTerminalFonts,
      showNotification: showNwNotification,
      beep: beepNw,
      getShellHistory: async () => {
        const fs = requireNode<typeof import('node:fs')>('node:fs')
        const path = requireNode<typeof import('node:path')>('node:path')
        const candidates = ['.zsh_history', '.bash_history'].map((name) =>
          path.join(getHomeDir(), name),
        )
        const lines: string[] = []
        for (const candidate of candidates) {
          try {
            lines.push(...fs.readFileSync(candidate, 'utf8').split('\n'))
          } catch {}
        }
        return [
          ...new Set(lines.map((line) => line.replace(/^: \\d+:\\d+;/, '').trim()).filter(Boolean)),
        ].slice(-500)
      },
      fileThumbnail: async (filePath, maxHeight) => {
        const fs = requireNode<typeof import('node:fs')>('node:fs')
        const path = requireNode<typeof import('node:path')>('node:path')
        const resolved = path.resolve(filePath.replace(/^~(?=$|\/)/, getHomeDir()))
        if (!isImagePath(resolved)) return null
        try {
          const stat = fs.statSync(resolved)
          if (!stat.isFile() || stat.size > 12_000_000) return null
          const bytes = fs.readFileSync(resolved)
          const dataUrl = `data:${mimeTypeForPath(resolved)};base64,${bytes.toString('base64')}`
          if (!maxHeight || maxHeight <= 0) return dataUrl
          return dataUrl
        } catch {
          return null
        }
      },
    },
    mcp: {
      install: async (projectPath) => installNwMcpServer(projectPath),
    },
  }

  window.cells = api
}

declare global {
  interface Window {
    cellsRuntime?: 'electron' | 'nw'
    require?: NodeRequire
  }
}
