import {
  app,
  BrowserWindow,
  MessageChannelMain,
  Notification,
  WebContentsView,
  ipcMain,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  session,
  shell,
} from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import os from 'os'
import { randomUUID } from 'crypto'
import { execFileSync, spawnSync } from 'child_process'
import { autoUpdater } from 'electron-updater'
import { updateAgentClisForCellsUpdate } from './agent-cli-updater'
import { getPickFolderDialogOptions } from './app-dialog-options'
import { PtyDaemonClient } from './pty-client'
import { ensureDaemon } from './daemon-lifecycle'
import { getDaemonRestartReason, type PtyDaemonVersionInfo } from './pty-daemon-contract'
import { PerfMonitor, type RendererPerfReport, type TerminalPerfReport } from './perf-monitor'
import type { TerminalSessionManager } from './terminal-session-manager'
import type {
  AppShortcutPayload,
  BrowserViewFailure,
  AgentNotificationContext,
  AgentNotificationSettings,
  AgentMentionSearchResult,
  AgentSessionSnapshot,
  FocusAgentWindowRequest,
  GitWorktree,
  GitWorktreeCreateOptions,
  ProjectsState,
  TerminalSessionBackend,
} from '../src/types'
import {
  matchBrowserViewShortcut,
  shouldFocusRendererForShortcut,
} from '../src/lib/cells-shortcuts'
import {
  createTerminalSessionManager,
  describeTerminalBackendRequirement,
  getTerminalBackendSupportStatus,
} from './terminal-backend'
import {
  DEFAULT_TERMINAL_SESSION_BACKEND,
  normalizeTerminalSessionBackend,
} from '../src/lib/terminal-session-backend'
import {
  ensureExtensionsLoaded,
  installExtension,
  uninstallExtension,
  readExtensionsMeta,
  setExtensionEnabled,
  loadExtensionIntoSession,
  unloadExtensionFromSession,
  getExtensionPopupUrl,
  spoofChromeUA,
  setupCWSIntegration,
} from './extensions'
import {
  startMcpBridge,
  stopMcpBridge,
  bufferTerminalOutput,
  captureConsoleLog,
  captureNetworkRequest,
  clearBrowserConsoleLogs,
  clearBrowserNetworkRequests,
  clearTerminalOutputRing,
} from './mcp-bridge'
import type { TerminalExitDetails, TerminalRuntimeStatus } from '../src/types'
import { normalizeTerminalFontFamily } from '../src/lib/terminal-fonts'
import {
  DEFAULT_AGENT_NOTIFICATION_SETTINGS,
  normalizeAgentNotificationSettings,
} from '../src/lib/agent-notification-settings'
import { EnhancedSessionTracker } from '../src/lib/enhanced-session-tracker'
import {
  AgentSessionService,
  agentLoginManager,
  getAgentAuthStatus,
  setCustomAgentPaths,
  getAgentLoginCommand,
  listClaudeModels,
  listCodexModels,
  type LoginEvent,
} from './agent-session-service'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const RENDERER_CACHE_VERSION_FILE = '.renderer-cache-version'
const REPAIR_TERMINAL_FONTS_FILE = '.repair-terminal-fonts'
let shouldRelaunchAfterEarlyCacheClear = false

// Catch async EIO errors from dead PTYs
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EIO' && err.syscall === 'write') return
  console.error('Uncaught exception:', err)
  dialog.showErrorBox('Unexpected Error', err.stack ?? err.message)
})

if (process.platform === 'darwin') {
  app.name = 'Cells'
}

// Dev runs deliberately use an isolated data dir (`CELLS_DEV_ROOT`) so they
// should be allowed to run alongside the packaged app. The single-instance
// lock is only needed for the installed build, where duplicate app trees
// burn CPU/GPU and battery.
const hasSingleInstanceLock = app.isPackaged ? app.requestSingleInstanceLock() : true
if (!hasSingleInstanceLock) {
  app.quit()
}

const shouldIgnoreGpuBlocklist = process.env.CELLS_IGNORE_GPU_BLOCKLIST === '1'
if (shouldIgnoreGpuBlocklist) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
}

const isPerfMonitorEnabled = !app.isPackaged || process.env.CELLS_ENABLE_PERF_MONITOR === '1'

const DEV_ROOT = process.env.CELLS_DEV_ROOT
  ? path.resolve(process.env.CELLS_DEV_ROOT)
  : path.join(app.getPath('home'), '.cells-dev')

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function decodePlistString(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    switch (entity.toLowerCase()) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default: {
        const isHex = entity[0] === '#' && (entity[1] === 'x' || entity[1] === 'X')
        const numeric = isHex ? entity.slice(2) : entity.slice(1)
        const codePoint = Number.parseInt(numeric, isHex ? 16 : 10)
        return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint)
      }
    }
  })
}

function configureDevPaths() {
  if (app.isPackaged) return

  const devHomeDir = path.join(DEV_ROOT, 'home')
  const devDataDir = path.join(DEV_ROOT, 'data')
  const devConfigDir = path.join(DEV_ROOT, 'config')
  const devUserDataDir = path.join(devDataDir, app.name)
  const devSessionDataDir = path.join(devDataDir, `${app.name}-session`)
  const devLogsDir = path.join(devDataDir, 'logs')

  for (const dir of [
    DEV_ROOT,
    devHomeDir,
    devDataDir,
    devConfigDir,
    devUserDataDir,
    devSessionDataDir,
    devLogsDir,
  ]) {
    ensureDir(dir)
  }

  const realHomeDir = os.userInfo().homedir
  process.env.CELLS_REAL_XDG_CONFIG_HOME =
    process.env.XDG_CONFIG_HOME || path.join(realHomeDir, '.config')
  process.env.CELLS_REAL_XDG_DATA_HOME =
    process.env.XDG_DATA_HOME || path.join(realHomeDir, '.local', 'share')
  process.env.CELLS_REAL_XDG_CACHE_HOME =
    process.env.XDG_CACHE_HOME || path.join(realHomeDir, '.cache')
  process.env.CELLS_REAL_XDG_STATE_HOME =
    process.env.XDG_STATE_HOME || path.join(realHomeDir, '.local', 'state')
  process.env.CELLS_HOME_DIR = devHomeDir
  process.env.CELLS_DATA_DIR = devDataDir
  process.env.HOME = devHomeDir
  process.env.XDG_CONFIG_HOME = devConfigDir
  process.env.XDG_DATA_HOME = devDataDir

  app.setPath('home', devHomeDir)
  app.setPath('appData', devDataDir)
  app.setPath('userData', devUserDataDir)
  app.setPath('sessionData', devSessionDataDir)
  app.setPath('logs', devLogsDir)
}

function shouldClearRendererCachesOnVersionChangeEarly() {
  if (!app.isPackaged) return false

  const userDataDir = app.getPath('userData')
  const versionFile = path.join(userDataDir, RENDERER_CACHE_VERSION_FILE)
  const currentVersion = app.getVersion()
  let previousVersion: string | null = null

  try {
    previousVersion = fs.readFileSync(versionFile, 'utf8').trim() || null
  } catch {}

  if (previousVersion === currentVersion) return false

  return true
}

function markRendererCachesVersionHandled() {
  if (!app.isPackaged) return
  const versionFile = path.join(app.getPath('userData'), RENDERER_CACHE_VERSION_FILE)
  try {
    fs.writeFileSync(versionFile, `${app.getVersion()}\n`, 'utf8')
  } catch {}
}

function clearRendererCaches() {
  const userDataDir = app.getPath('userData')
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

  for (const entry of cacheEntries) {
    try {
      fs.rmSync(path.join(userDataDir, entry), { recursive: true, force: true })
    } catch {}
  }
}

function stopCellsOwnedBackgroundProcesses() {
  const processMatchers = [
    ['-f', path.join(process.resourcesPath, 'app.asar/dist-electron/pty-daemon.js')],
    ['-f', path.join(process.resourcesPath, 'vendor/tmux')],
    ['-f', path.join(process.resourcesPath, 'vendor/zellij')],
  ]

  for (const args of processMatchers) {
    try {
      execFileSync('pkill', args, { stdio: 'ignore' })
    } catch {}
  }
}

function consumeTerminalFontRepairRequestEarly() {
  if (!app.isPackaged) return false
  const markerFile = path.join(app.getPath('userData'), REPAIR_TERMINAL_FONTS_FILE)
  if (!fs.existsSync(markerFile)) return false
  try {
    fs.rmSync(markerFile, { force: true })
  } catch {}
  return true
}

const shouldRepairTerminalFonts = consumeTerminalFontRepairRequestEarly()
const shouldClearCachesForVersion = shouldClearRendererCachesOnVersionChangeEarly()
shouldRelaunchAfterEarlyCacheClear = shouldRepairTerminalFonts || shouldClearCachesForVersion

configureDevPaths()

// Enable elastic overscroll (rubber-band bounce) like native Chrome on macOS
app.commandLine.appendSwitch('enable-features', 'ElasticOverscroll')

let daemonClient: PtyDaemonClient | null = null
let fallbackSessions: TerminalSessionManager | null = null
let useDaemon = false
let daemonRestartInProgress = false
let daemonRecoveryPromise: Promise<void> | null = null
let mainWindow: BrowserWindow | null = null
let perfMonitor: PerfMonitor | null = null
let agentSessionTracker: EnhancedSessionTracker | null = null
const agentSessionService = new AgentSessionService()
const pendingAgentSessionSnapshots = new Map<string, AgentSessionSnapshot>()
const previousAgentSessionSnapshots = new Map<string, AgentSessionSnapshot>()
let pendingAgentSessionFlushTimer: NodeJS.Timeout | null = null
let cachedAgentNotificationSettings: AgentNotificationSettings | null = null
const cachedAgentWindowProjectIds = new Map<string, string>()
// Per-window queued-message count reported by the renderer. Used to suppress
// the "finished" notification when another queued message is about to run —
// the agent isn't really done, it's just between turns.
const cachedAgentWindowQueuedCounts = new Map<string, number>()
// Hold a strong reference to live Notification objects. Without this, the JS
// objects can be GC'd while the OS notification is still visible, so their
// 'click' handlers never fire and clicking the notification only triggers the
// OS default (raise the app) instead of our project/window focus logic.
const liveNotifications = new Set<Electron.Notification>()
let cachedAgentNotificationContext: AgentNotificationContext = {
  activeProjectId: null,
  focusedAgentWindowId: null,
}

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
    return
  }
  createWindow()
})

function flushAgentSessionSnapshots() {
  pendingAgentSessionFlushTimer = null
  if (pendingAgentSessionSnapshots.size === 0) return
  const snapshots = Array.from(pendingAgentSessionSnapshots.values())
  pendingAgentSessionSnapshots.clear()
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    const contents = window.webContents
    // During Vite HMR / navigation the render frame is briefly torn down;
    // sending would throw "Render frame was disposed before WebFrameMain
    // could be accessed". Guard with isDestroyed + try/catch.
    if (contents.isDestroyed() || contents.isCrashed()) continue
    try {
      for (const snapshot of snapshots) {
        contents.send('agent-session:update', snapshot)
      }
    } catch {
      // swallow — frame was disposed between the check and the send
    }
  }
}

agentSessionService.on('update', (snapshot) => {
  maybeNotifyForAgentSessionUpdate(snapshot)
  pendingAgentSessionSnapshots.set(snapshot.windowId, snapshot)
  if (pendingAgentSessionFlushTimer) return
  // Coalesce bursty agent-session updates into ~30fps batches instead of
  // hammering every renderer on every streaming chunk.
  pendingAgentSessionFlushTimer = setTimeout(flushAgentSessionSnapshots, 32)
})

// Per-terminal session isolation:
// - "subscribed" = renderer component mounted → data forwarded live via IPC
// - "unsubscribed" = session keeps running server-side while Cells stops
//   forwarding data to that renderer
// - attach returns the backend contract so the renderer knows whether it is
//   rejoining a replay-based terminal or a server-owned live screen
const historySnapshots = new Map<string, { buffer: string; termId: string }>()
const terminalSubscriptionCounts = new Map<string, number>()
const subscribedTerminals = new Set<string>()
const pendingTerminalExitDetails = new Map<string, TerminalExitDetails>()
const pinnedWindows = new Map<string, BrowserWindow>()
const pinnedWindowTypes = new Map<string, 'terminal' | 'browser' | 'agent'>()

// MessagePort per BrowserWindow for high-throughput terminal data.
// Bypasses Electron's main IPC event loop — structured clone over a direct
// channel is significantly faster than webContents.send for streaming data.
const terminalDataPorts = new Map<BrowserWindow, Electron.MessagePortMain>()

const STATE_DIR = path.join(app.getPath('home'), '.cells')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const LEGACY_STATE_DIR = path.join(app.getPath('home'), '.vector-ghost')
const LEGACY_STATE_FILE = path.join(LEGACY_STATE_DIR, 'state.json')
const MCP_BRIDGE_SOCKET = path.join(STATE_DIR, 'mcp-bridge.sock')
const AUTO_UPDATE_CHECK_DELAY = 15_000
const AUTO_UPDATE_CHECK_INTERVAL = 5 * 60_000
const PRELOAD_FILE = 'preload.mjs'
const BROWSER_PRELOAD_FILE = 'browser-preload.cjs'
let quitConfirmed = false
let quitDialogOpen = false
let selectedTerminalBackend: TerminalSessionBackend = DEFAULT_TERMINAL_SESSION_BACKEND
let terminalBackendSupport = getTerminalBackendSupportStatus(selectedTerminalBackend)

function sendCanvasZoomCommand(command: 'fit' | 'in' | 'out') {
  if (mainWindow?.isDestroyed()) return
  mainWindow?.webContents.send('app:canvas-zoom', command)
}

function sendShortcutToRenderer(payload: AppShortcutPayload) {
  if (mainWindow?.isDestroyed()) return
  mainWindow?.webContents.send('app:shortcut', payload)
}

function getDefaultAgentSessionTitle(agent: AgentSessionSnapshot['agent']) {
  return agent === 'claude' ? 'Claude Code' : 'Codex'
}

function getSessionNotificationLabel(snapshot: AgentSessionSnapshot) {
  const title = snapshot.title.trim()
  return title && title !== getDefaultAgentSessionTitle(snapshot.agent)
    ? title
    : getDefaultAgentSessionTitle(snapshot.agent)
}

function truncateNotificationText(text: string, max = 180) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1).trimEnd()}…`
}

function readAgentNotificationSettingsFromStateFile() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = readStateFile(STATE_FILE) as ProjectsState
      syncCachedNotificationState(state)
      return normalizeAgentNotificationSettings(state.agentNotificationSettings)
    }
  } catch {}
  syncCachedNotificationState(null)
  return DEFAULT_AGENT_NOTIFICATION_SETTINGS
}

function getAgentNotificationSettings() {
  if (cachedAgentNotificationSettings) return cachedAgentNotificationSettings
  cachedAgentNotificationSettings = readAgentNotificationSettingsFromStateFile()
  return cachedAgentNotificationSettings
}

function syncCachedNotificationState(state?: ProjectsState | null) {
  cachedAgentWindowProjectIds.clear()

  if (!state) {
    cachedAgentNotificationContext = {
      activeProjectId: null,
      focusedAgentWindowId: null,
    }
    return
  }

  for (const project of state.projects ?? []) {
    for (const agentWindow of project.agentWindows ?? []) {
      cachedAgentWindowProjectIds.set(agentWindow.id, project.id)
    }
  }

  const activeProject =
    state.activeProjectId != null
      ? (state.projects.find((project) => project.id === state.activeProjectId) ?? null)
      : null

  cachedAgentNotificationContext = {
    activeProjectId: state.activeProjectId ?? null,
    focusedAgentWindowId: activeProject?.focusedAgentWindowId ?? null,
  }
}

function getProjectIdForAgentWindow(windowId: string) {
  return cachedAgentWindowProjectIds.get(windowId) ?? null
}

function isMainWindowForeground() {
  return Boolean(
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.isVisible() &&
    !mainWindow.isMinimized() &&
    mainWindow.isFocused(),
  )
}

function shouldDeliverAgentNotification(
  snapshot: AgentSessionSnapshot,
  settings: AgentNotificationSettings,
) {
  if (!settings.enabled) return false
  if (!settings.onlyWhenUnfocused) return true
  if (!isMainWindowForeground()) return true

  const projectId = getProjectIdForAgentWindow(snapshot.windowId)
  if (!projectId) return true

  return !(
    cachedAgentNotificationContext.activeProjectId === projectId &&
    cachedAgentNotificationContext.focusedAgentWindowId === snapshot.windowId
  )
}

function focusMainWindowAndAgentWindow(request?: FocusAgentWindowRequest | null) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // On macOS a hidden app (via Cmd+H or the Hide menu item) keeps its window
  // "visible" flag true, so mainWindow.show() alone does not unhide it.
  if (process.platform === 'darwin') {
    try {
      app.show()
    } catch {}
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  try {
    app.focus({ steal: true })
  } catch {}
  if (!request?.windowId) return
  // Send after the focus chain settles so the renderer is definitely awake and
  // subscribed. Buffered IPCs can also race with the focus event, so a small
  // delay avoids reordering on the renderer side.
  const send = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    try {
      mainWindow.webContents.send('app:focus-agent-window', request)
    } catch {}
  }
  setTimeout(send, 50)
}

async function showSystemNotification(
  title: string,
  body: string,
  options?: {
    playSound?: boolean
    focusAgentWindowId?: string | null
    focusProjectId?: string | null
  },
) {
  const playSound = options?.playSound ?? true
  if (!Notification.isSupported()) {
    if (playSound) shell.beep()
    return
  }

  const notification = new Notification({
    title,
    body,
    silent: !playSound,
  })

  liveNotifications.add(notification)
  const release = () => {
    liveNotifications.delete(notification)
  }
  notification.on('close', release)
  notification.on('failed', release)

  if (options?.focusAgentWindowId) {
    const focusAgentWindowId = options.focusAgentWindowId
    const focusProjectId = options.focusProjectId
    notification.on('click', () => {
      focusMainWindowAndAgentWindow({
        windowId: focusAgentWindowId,
        projectId: focusProjectId,
      })
      release()
    })
  }

  notification.show()
}

function getAttentionKey(snapshot: AgentSessionSnapshot) {
  if (snapshot.pendingQuestion) return `question:${snapshot.pendingQuestion.createdAt}`
  if (snapshot.pendingApproval) return `approval:${snapshot.pendingApproval.createdAt}`
  if (snapshot.pendingPlanApproval) return `plan:${snapshot.pendingPlanApproval.createdAt}`
  return null
}

function isAgentSessionBusy(snapshot: AgentSessionSnapshot) {
  const inFlightMessageCount = snapshot.messages.filter((message) => {
    if (message.status !== 'in_progress') return false
    return (
      message.role === 'assistant' ||
      message.role === 'reasoning' ||
      message.role === 'tool' ||
      message.role === 'system' ||
      message.role === 'auth_request' ||
      message.role === 'compaction'
    )
  }).length

  return (
    snapshot.status === 'running' ||
    Boolean(snapshot.pendingQuestion || snapshot.pendingApproval || snapshot.pendingPlanApproval) ||
    inFlightMessageCount > 0
  )
}

function buildAgentNotificationFromSnapshot(
  previous: AgentSessionSnapshot | undefined,
  snapshot: AgentSessionSnapshot,
  settings: AgentNotificationSettings,
) {
  const label = getSessionNotificationLabel(snapshot)
  const previousAttentionKey = previous ? getAttentionKey(previous) : null
  const nextAttentionKey = getAttentionKey(snapshot)

  if (settings.notifyOnAttention && nextAttentionKey && nextAttentionKey !== previousAttentionKey) {
    if (snapshot.pendingQuestion) {
      const count = snapshot.pendingQuestion.questions.length
      return {
        title: `${label} needs input`,
        body:
          count === 1
            ? 'Open Cells to answer the question.'
            : `Open Cells to answer ${count} questions.`,
      }
    }
    if (snapshot.pendingApproval) {
      return {
        title: `${label} needs approval`,
        body: truncateNotificationText(
          snapshot.pendingApproval.title || 'Open Cells to review the approval request.',
        ),
      }
    }
    if (snapshot.pendingPlanApproval) {
      return {
        title: `${label} has a plan ready`,
        body: 'Open Cells to review the proposed plan.',
      }
    }
  }

  if (
    settings.notifyOnError &&
    snapshot.status === 'error' &&
    snapshot.error &&
    (previous?.status !== 'error' || previous.error !== snapshot.error)
  ) {
    return {
      title: `${label} hit an error`,
      body: truncateNotificationText(snapshot.error),
    }
  }

  if (
    settings.notifyOnDone &&
    previous &&
    previous.status !== 'error' &&
    isAgentSessionBusy(previous) &&
    !isAgentSessionBusy(snapshot) &&
    snapshot.status !== 'error' &&
    (cachedAgentWindowQueuedCounts.get(snapshot.windowId) ?? 0) === 0
  ) {
    return {
      title: `${label} finished`,
      body: 'Open Cells to review the latest response.',
    }
  }

  return null
}

function clearAgentSessionNotificationState(windowId: string) {
  previousAgentSessionSnapshots.delete(windowId)
  pendingAgentSessionSnapshots.delete(windowId)
  cachedAgentWindowQueuedCounts.delete(windowId)
}

function maybeNotifyForAgentSessionUpdate(snapshot: AgentSessionSnapshot) {
  const previous = previousAgentSessionSnapshots.get(snapshot.windowId)
  previousAgentSessionSnapshots.set(snapshot.windowId, snapshot)
  if (!previous) return

  const settings = getAgentNotificationSettings()
  if (!shouldDeliverAgentNotification(snapshot, settings)) return
  const notification = buildAgentNotificationFromSnapshot(previous, snapshot, settings)
  if (!notification) return

  void showSystemNotification(notification.title, notification.body, {
    playSound: settings.playSound,
    focusAgentWindowId: snapshot.windowId,
    focusProjectId: getProjectIdForAgentWindow(snapshot.windowId),
  })
}

function repairLegacyTerminalFontStateEarly() {
  const statePath = STATE_FILE
  try {
    if (!fs.existsSync(statePath)) return false
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      fontFamily?: string
      projects?: Array<Record<string, unknown>>
    }

    let changed = false
    const normalizedFontFamily = normalizeTerminalFontFamily(state.fontFamily)
    if (normalizedFontFamily !== state.fontFamily) {
      state.fontFamily = normalizedFontFamily
      changed = true
    }

    if (Array.isArray(state.projects)) {
      state.projects = state.projects.map((project) => {
        const next = { ...project }
        if (Array.isArray(next.terminals)) {
          next.terminals = next.terminals.map((terminal) => {
            const repaired = { ...terminal }
            if ('restoredOutput' in repaired) {
              delete repaired.restoredOutput
              changed = true
            }
            return repaired
          })
        }
        if ('fontFamily' in next) {
          delete next.fontFamily
          changed = true
        }
        if ('fontSize' in next) {
          delete next.fontSize
          changed = true
        }
        if ('terminalTheme' in next) {
          delete next.terminalTheme
          changed = true
        }
        return next
      })
    }

    if (changed) {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
    }
    return changed
  } catch {
    return false
  }
}

repairLegacyTerminalFontStateEarly()

function getSelectedTerminalBackendFromState(state?: Partial<ProjectsState> | null) {
  return normalizeTerminalSessionBackend(
    state?.terminalSessionBackend,
    DEFAULT_TERMINAL_SESSION_BACKEND,
  )
}

function refreshTerminalBackendSelection(state?: Partial<ProjectsState> | null) {
  selectedTerminalBackend = getSelectedTerminalBackendFromState(state ?? readSavedState())
  terminalBackendSupport = getTerminalBackendSupportStatus(selectedTerminalBackend)
}

function describeSelectedBackendRequirement() {
  return describeTerminalBackendRequirement(terminalBackendSupport)
}

async function showTerminalBackendRequirementDialog() {
  if (terminalBackendSupport.ok) return
  const messageBoxOptions = {
    type: 'warning' as const,
    buttons: ['Continue', `Install ${terminalBackendSupport.name}`],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    message: `${terminalBackendSupport.name} Required`,
    detail: `${describeSelectedBackendRequirement()}\n\nCells uses a private app-owned ${terminalBackendSupport.name} config and does not load the user's personal ${terminalBackendSupport.name} config.`,
  }
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions)
  if (result.response === 1) {
    void shell.openExternal(terminalBackendSupport.installUrl)
  }
}

function terminalsPersistOnQuit() {
  return useDaemon || fallbackSessions !== null
}

function readSavedState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return readStateFile(STATE_FILE)
    }
    if (fs.existsSync(LEGACY_STATE_FILE)) {
      return readStateFile(LEGACY_STATE_FILE)
    }
  } catch {}
  return null
}

function isTransparentWindowModeEnabled() {
  return readSavedState()?.useTransparentWindow !== false
}

function createWindow() {
  const transparentWindow = isTransparentWindowModeEnabled()
  const needsWarmReload = !process.env.VITE_DEV_SERVER_URL
  let warmReloadDone = !needsWarmReload
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false, // Don't show until ready — avoids GPU race on launch
    transparent: transparentWindow,
    backgroundColor: transparentWindow ? '#00000000' : '#15171a',
    vibrancy: transparentWindow ? 'under-window' : undefined,
    visualEffectState: transparentWindow ? 'active' : undefined,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: -20, y: -20 },
    roundedCorners: true,
    icon: path.join(__dirname, '../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, PRELOAD_FILE),
      nodeIntegration: false,
      contextIsolation: true,
      webgl: true,
    },
  })

  mainWindow.on('ready-to-show', () => {
    if (warmReloadDone) {
      mainWindow?.show()
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!warmReloadDone) {
      warmReloadDone = true
      mainWindow.webContents.reload()
      return
    }
    setupTerminalDataPort(mainWindow)
    if (!mainWindow.isVisible()) {
      mainWindow.show()
    }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (
      !(input.meta || input.control) ||
      input.alt ||
      (input.type !== 'keyDown' && input.type !== 'rawKeyDown')
    ) {
      return
    }

    const key = input.key.toLowerCase()
    const zoomIn =
      key === '+' ||
      key === '=' ||
      key === 'add' ||
      input.code === 'Equal' ||
      input.code === 'NumpadAdd'
    const zoomOut =
      key === '-' ||
      key === '_' ||
      key === 'subtract' ||
      input.code === 'Minus' ||
      input.code === 'NumpadSubtract'
    if (!zoomIn && !zoomOut) return

    event.preventDefault()
    sendCanvasZoomCommand(zoomIn ? 'in' : 'out')
  })

  // Relay native window focus/blur to the renderer so the dim overlay
  // tracks the actual BrowserWindow state, not the DOM window which
  // loses focus whenever a WebContentsView (browser panel) is active.
  mainWindow.on('focus', () => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send('app:window-focus', true)
  })
  mainWindow.on('blur', () => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send('app:window-focus', false)
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

async function cleanupOrphanedDaemonSessions() {
  if (!useDaemon || !daemonClient?.isConnected()) return

  try {
    const daemonTermIds = await daemonClient.list()
    const stateData = fs.existsSync(STATE_FILE)
      ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
      : null
    if (!stateData?.projects) return

    const knownIds = new Set<string>()
    for (const project of stateData.projects) {
      for (const t of project.terminals ?? []) knownIds.add(t.id)
    }

    for (const id of daemonTermIds) {
      if (!knownIds.has(id)) {
        daemonClient.kill(id).catch(() => {})
      }
    }
  } catch {}
}

async function confirmAndQuitApp() {
  if (quitConfirmed || quitDialogOpen) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    quitConfirmed = true
    app.quit()
    return
  }

  quitDialogOpen = true
  try {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Cancel', 'Quit'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
      message: 'Quit Cells?',
      detail: terminalsPersistOnQuit()
        ? 'Terminal sessions will continue in the background.'
        : 'This will close the app and terminate any running windows and processes.',
    })

    if (result.response === 1) {
      quitConfirmed = true
      app.quit()
    }
  } finally {
    quitDialogOpen = false
  }
}

// ---------- State persistence ----------

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    ensureDir(STATE_DIR)
  }
}

function readStateFile(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

ipcMain.handle('state:load', () => {
  try {
    ensureStateDir()
    if (fs.existsSync(STATE_FILE)) {
      const state = readStateFile(STATE_FILE)
      syncCachedNotificationState(state as ProjectsState)
      cachedAgentNotificationSettings = normalizeAgentNotificationSettings(
        (state as ProjectsState).agentNotificationSettings,
      )
      return state
    }
    if (fs.existsSync(LEGACY_STATE_FILE)) {
      const legacyState = readStateFile(LEGACY_STATE_FILE)
      fs.writeFileSync(STATE_FILE, JSON.stringify(legacyState, null, 2))
      syncCachedNotificationState(legacyState as ProjectsState)
      cachedAgentNotificationSettings = normalizeAgentNotificationSettings(
        (legacyState as ProjectsState).agentNotificationSettings,
      )
      return legacyState
    }
  } catch {}
  syncCachedNotificationState(null)
  return null
})

ipcMain.handle('state:save', (_event, state) => {
  try {
    ensureStateDir()
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
    syncCachedNotificationState(state)
    refreshTerminalBackendSelection(state)
    cachedAgentNotificationSettings = normalizeAgentNotificationSettings(
      state.agentNotificationSettings,
    )
  } catch (err) {
    console.error('Failed to save state:', err)
  }
})

ipcMain.on('app:update-notification-context', (_event, context: AgentNotificationContext) => {
  cachedAgentNotificationContext = {
    activeProjectId: context.activeProjectId ?? null,
    focusedAgentWindowId: context.focusedAgentWindowId ?? null,
  }
})

ipcMain.on('agent-session:report-queue-count', (_event, windowId: string, count: number) => {
  const normalized = Math.max(0, Math.trunc(Number(count) || 0))
  if (normalized === 0) {
    cachedAgentWindowQueuedCounts.delete(windowId)
  } else {
    cachedAgentWindowQueuedCounts.set(windowId, normalized)
  }
})

ipcMain.on('agent-session:notify-queued-start', (_event, windowId: string) => {
  const settings = getAgentNotificationSettings()
  if (!settings.enabled || !settings.notifyOnQueuedStart) return
  const snapshot = previousAgentSessionSnapshots.get(windowId)
  if (!snapshot) return
  if (!shouldDeliverAgentNotification(snapshot, settings)) return
  const label = getSessionNotificationLabel(snapshot)
  void showSystemNotification(`${label} started next message`, 'Running a queued message.', {
    playSound: false,
    focusAgentWindowId: windowId,
    focusProjectId: getProjectIdForAgentWindow(windowId),
  })
})

ipcMain.on('perf:renderer-sample', (_event, sample: RendererPerfReport) => {
  perfMonitor?.reportRendererSample(sample)
})

ipcMain.on('perf:terminal-sample', (_event, sample: TerminalPerfReport) => {
  perfMonitor?.reportTerminalSample(sample)
})

ipcMain.handle('perf:get-status', () => {
  return perfMonitor?.getStatus() ?? null
})

ipcMain.handle('perf:get-recent-events', (_event, limit?: number) => {
  return perfMonitor?.getRecentEvents(limit) ?? []
})

// ---------- Terminal IPC ----------

function ensureFallbackSessions() {
  if (fallbackSessions) return fallbackSessions

  // Fallback mode preserves the same server-owned session contract without the
  // daemon hop, so reload/reattach semantics stay identical if the daemon is
  // unavailable but the selected backend still works in-process.
  fallbackSessions = createTerminalSessionManager(selectedTerminalBackend, STATE_DIR, {
    onData(termId, data) {
      forwardTerminalData(termId, data)
    },
    onExit(termId) {
      clearHistorySnapshotsForTerm(termId)
      forwardTerminalExit(termId, { reason: 'process-exit' })
    },
  })

  return fallbackSessions
}

function clearHistorySnapshotsForTerm(termId: string) {
  for (const [token, snapshot] of historySnapshots) {
    if (snapshot.termId === termId) {
      historySnapshots.delete(token)
    }
  }
}

async function readTerminalHistory(termId: string) {
  if (useDaemon && daemonClient?.isConnected()) {
    return daemonClient.getHistory(termId)
  }
  return fallbackSessions?.getHistory(termId) ?? ''
}

async function getTerminalHistoryPage(
  termId: string,
  token?: string | null,
  offset?: number | null,
  maxBytes = 256 * 1024,
) {
  let snapshot = token ? historySnapshots.get(token) : undefined

  if (!snapshot || snapshot.termId !== termId) {
    const buffer = await readTerminalHistory(termId)
    if (!buffer) {
      return {
        chunk: '',
        done: true,
        offset: null,
        token: null,
        totalBytes: 0,
      }
    }

    token = randomUUID()
    snapshot = { buffer, termId }
    historySnapshots.set(token, snapshot)
    offset = 0
  }

  const start = Math.max(0, offset ?? 0)
  const byteLimit = Math.max(16 * 1024, Math.min(1024 * 1024, Math.floor(maxBytes)))
  const end = Math.min(snapshot.buffer.length, start + byteLimit)
  const chunk = snapshot.buffer.slice(start, end)
  const nextOffset = end >= snapshot.buffer.length ? null : end

  if (nextOffset == null && token) {
    historySnapshots.delete(token)
  }

  return {
    chunk,
    done: nextOffset == null,
    offset: nextOffset,
    token: nextOffset == null ? null : (token ?? null),
    totalBytes: snapshot.buffer.length,
  }
}

function getWindowForTerminal(termId: string): BrowserWindow | null {
  const pinned = pinnedWindows.get(termId)
  if (pinned && !pinned.isDestroyed()) return pinned
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

function addTerminalSubscription(termId: string) {
  terminalSubscriptionCounts.set(termId, (terminalSubscriptionCounts.get(termId) ?? 0) + 1)
  subscribedTerminals.add(termId)
}

function removeTerminalSubscription(termId: string) {
  const next = (terminalSubscriptionCounts.get(termId) ?? 0) - 1
  if (next > 0) {
    terminalSubscriptionCounts.set(termId, next)
  } else {
    terminalSubscriptionCounts.delete(termId)
    subscribedTerminals.delete(termId)
  }
}

function clearTerminalSubscriptions(termId: string) {
  terminalSubscriptionCounts.delete(termId)
  subscribedTerminals.delete(termId)
}

function isTerminalSubscribed(termId: string) {
  return (terminalSubscriptionCounts.get(termId) ?? 0) > 0
}

function setupTerminalDataPort(win: BrowserWindow) {
  const { port1, port2 } = new MessageChannelMain()
  terminalDataPorts.set(win, port1)
  port1.start()
  // Send port2 to the renderer. The preload script listens for this event
  // and wires incoming messages into the onData callback chain.
  win.webContents.postMessage('terminal:data-port', null, [port2])
  win.on('closed', () => {
    terminalDataPorts.delete(win)
    port1.close()
  })
}

function forwardTerminalData(termId: string, data: string) {
  bufferTerminalOutput(termId, data)
  if (!isTerminalSubscribed(termId)) return
  try {
    const target = getWindowForTerminal(termId)
    if (!target) return
    const port = terminalDataPorts.get(target)
    if (port) {
      port.postMessage({ t: termId, d: data })
    } else {
      // Fallback to standard IPC before the port is established
      target.webContents.send('terminal:data', termId, data)
    }
  } catch {}
}

function broadcastTerminalStatus(termId: string, status: TerminalRuntimeStatus | null) {
  try {
    const targets = new Set<BrowserWindow>()
    const pinned = pinnedWindows.get(termId)
    if (pinned && !pinned.isDestroyed()) {
      targets.add(pinned)
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      targets.add(mainWindow)
    }
    for (const target of targets) {
      target.webContents.send('terminal:status', termId, status)
    }
  } catch {}
}

function forwardTerminalExit(termId: string, details?: TerminalExitDetails) {
  const exitDetails = details ?? pendingTerminalExitDetails.get(termId)
  if (!details) {
    pendingTerminalExitDetails.delete(termId)
  }
  agentSessionTracker?.untrackSession(termId)
  clearTerminalSubscriptions(termId)
  clearTerminalOutputRing(termId)
  clearHistorySnapshotsForTerm(termId)
  fallbackSessions?.clear(termId)
  try {
    const targets = new Set<BrowserWindow>()
    const pinned = pinnedWindows.get(termId)
    if (pinned && !pinned.isDestroyed()) {
      targets.add(pinned)
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      targets.add(mainWindow)
    }
    for (const target of targets) {
      target.webContents.send('terminal:exit', termId, exitDetails)
    }
  } catch {}
}

async function captureTerminalExitDetails(
  termId: string,
  reason: NonNullable<TerminalExitDetails['reason']>,
): Promise<TerminalExitDetails> {
  const history = await readTerminalHistory(termId).catch(() => '')
  return {
    reason,
    history: history || null,
  }
}

async function primeTerminalExitDetails(
  termIds: string[],
  reason: NonNullable<TerminalExitDetails['reason']>,
) {
  await Promise.all(
    termIds.map(async (termId) => {
      pendingTerminalExitDetails.set(termId, await captureTerminalExitDetails(termId, reason))
    }),
  )
}

async function handleDaemonTerminalExit(termId: string) {
  if (pendingTerminalExitDetails.has(termId)) {
    forwardTerminalExit(termId)
    return
  }

  try {
    forwardTerminalExit(termId, await captureTerminalExitDetails(termId, 'process-exit'))
  } catch {
    forwardTerminalExit(termId, { reason: 'process-exit' })
  }
}

function handleDaemonDisconnect() {
  daemonClient = null
  if (daemonRestartInProgress) {
    console.info(`PTY daemon disconnected during intentional ${selectedTerminalBackend} restart`)
    useDaemon = false
    return
  }

  console.warn(
    `PTY daemon disconnected while ${selectedTerminalBackend} sessions may still be alive`,
  )
  useDaemon = false
  if (!daemonRecoveryPromise) {
    daemonRecoveryPromise = recoverFromUnexpectedDaemonDisconnect().finally(() => {
      daemonRecoveryPromise = null
    })
  }
}

async function recoverFromUnexpectedDaemonDisconnect() {
  const notifyRenderers = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('app:daemon-disconnected')
      }
    }
  }

  try {
    refreshTerminalBackendSelection()
    if (!terminalBackendSupport.ok) {
      notifyRenderers()
      return
    }

    const daemonScript = path.join(__dirname, 'pty-daemon.js')
    const recovered = await ensureDaemon(
      STATE_DIR,
      app.getVersion(),
      process.execPath,
      daemonScript,
      selectedTerminalBackend,
    )

    if (!recovered) {
      ensureFallbackSessions()
      notifyRenderers()
      return
    }

    await connectDaemonClient()
    notifyRenderers()
  } catch (error) {
    console.warn('Failed to recover PTY daemon after unexpected disconnect', error)
    if (terminalBackendSupport.ok) {
      ensureFallbackSessions()
    }
    notifyRenderers()
  }
}

async function connectDaemonClient() {
  const client = new PtyDaemonClient()
  await client.connect(path.join(STATE_DIR, 'pty-daemon.sock'))
  client.onData(forwardTerminalData)
  client.onExit((termId) => {
    void handleDaemonTerminalExit(termId)
  })
  client.onDisconnect(handleDaemonDisconnect)
  daemonClient = client
}

ipcMain.handle(
  'terminal:attach',
  async (
    _event,
    termId: string,
    cols: number,
    rows: number,
    cwd?: string,
    projectId?: string | null,
  ) => {
    clearHistorySnapshotsForTerm(termId)

    if (!terminalBackendSupport.ok && !fallbackSessions) {
      throw new Error(describeSelectedBackendRequirement())
    }

    if (useDaemon && daemonClient?.isConnected()) {
      try {
        // Mark subscribed before the daemon attaches so any live data emitted
        // after the replay boundary is forwarded and queued during renderer replay.
        addTerminalSubscription(termId)
        const result = await daemonClient.attach(termId, cols, rows, cwd, projectId)
        return { reattached: result.reattached, buffer: result.buffer, backend: result.backend }
      } catch {
        removeTerminalSubscription(termId)
        // Daemon failed — fall through to fallback below
      }
    }

    const sessions = ensureFallbackSessions()
    const result = sessions.attach(termId, cols, rows, cwd, projectId, () => {
      addTerminalSubscription(termId)
    })
    return { reattached: result.reattached, buffer: result.buffer, backend: result.backend }
  },
)

ipcMain.handle('terminal:unsubscribe', (_event, termId: string) => {
  removeTerminalSubscription(termId)
  const pinned = pinnedWindows.get(termId)
  if (isTerminalSubscribed(termId) || (pinned && !pinned.isDestroyed())) {
    return
  }
  if (useDaemon && daemonClient?.isConnected()) {
    daemonClient.unsubscribe(termId)
  } else {
    fallbackSessions?.unsubscribe(termId)
  }
})

ipcMain.handle('terminal:detach', (_event, termId: string) => {
  agentSessionTracker?.untrackSession(termId)
  clearTerminalSubscriptions(termId)
  clearHistorySnapshotsForTerm(termId)
  if (useDaemon && daemonClient?.isConnected()) {
    daemonClient.kill(termId).catch(() => {})
  } else {
    fallbackSessions?.kill(termId)
  }
})

ipcMain.handle('terminal:get-process', async (_event, termId: string) => {
  try {
    if (useDaemon && daemonClient?.isConnected()) {
      const info = await daemonClient.getProcessInfo(termId)
      return info?.command ?? null
    }
    return fallbackSessions?.getProcessInfo(termId)?.command ?? null
  } catch {
    return null
  }
})

ipcMain.handle('terminal:get-process-info', async (_event, termId: string) => {
  try {
    if (useDaemon && daemonClient?.isConnected()) {
      return daemonClient.getProcessInfo(termId)
    }
    return fallbackSessions?.getProcessInfo(termId) ?? null
  } catch {
    return null
  }
})

ipcMain.handle('terminal:get-status', async (_event, termId: string) => {
  return agentSessionTracker?.getStatus(termId) ?? null
})

ipcMain.handle(
  'terminal:register-launch',
  async (
    _event,
    termId: string,
    launch: {
      agent?: 'claude' | 'codex' | 'opencode' | 'pi' | null
      command?: string | null
      cwd?: string | null
      startedAt?: number | null
      claudeSessionId?: string | null
      codexThreadId?: string | null
    },
  ) => {
    if (launch.agent) {
      agentSessionTracker?.trackSession(termId, launch.agent, {
        sessionId: launch.claudeSessionId ?? undefined,
        threadId: launch.codexThreadId ?? undefined,
      })
    }
  },
)

ipcMain.handle('terminal:get-codex-title', async (_event, termId: string) => {
  try {
    if (useDaemon && daemonClient?.isConnected()) {
      return daemonClient.getCodexTitle(termId)
    }
    return fallbackSessions?.getCodexTitle(termId) ?? null
  } catch {
    return null
  }
})

ipcMain.handle('terminal:get-scroll-status', async (_event, termId: string) => {
  try {
    if (useDaemon && daemonClient?.isConnected()) {
      return await daemonClient.getScrollStatus(termId)
    }
    return fallbackSessions?.getScrollStatus(termId) ?? null
  } catch {
    return null
  }
})

ipcMain.handle('terminal:get-history', async (_event, termId: string) => {
  try {
    return await readTerminalHistory(termId)
  } catch {
    return ''
  }
})

ipcMain.handle(
  'terminal:get-history-page',
  async (
    _event,
    termId: string,
    token?: string | null,
    offset?: number | null,
    maxBytes?: number,
  ) => {
    try {
      return await getTerminalHistoryPage(termId, token, offset, maxBytes)
    } catch {
      return {
        chunk: '',
        done: true,
        offset: null,
        token: null,
        totalBytes: 0,
      }
    }
  },
)

ipcMain.handle('app:open-external', (_event, url: string) => {
  shell.openExternal(url)
})

function expandHomePath(input: string) {
  if (!input) return input
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  if (input.startsWith('file://')) {
    try {
      return fileURLToPath(input)
    } catch {
      return input
    }
  }
  return input
}

const AGENT_MENTION_ROOTS = ['.agents', '.claude', '.codex'] as const
const MAX_AGENT_MENTION_RESULTS = 60
const MAX_AGENT_MENTION_SCAN_ENTRIES = 2000

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
  const resolvedCwd = path.resolve(cwd)
  const found = new Map<AgentMentionRoot, string>()
  let current = resolvedCwd

  while (true) {
    for (const sourceRoot of AGENT_MENTION_ROOTS) {
      if (found.has(sourceRoot)) continue
      const candidate = path.join(current, sourceRoot)
      try {
        if (fs.statSync(candidate).isDirectory()) {
          found.set(sourceRoot, candidate)
        }
      } catch {
        /* ignore */
      }
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
    const source = fs.readFileSync(filePath, 'utf8')
    if (!source.startsWith('---\n')) return null
    const end = source.indexOf('\n---', 4)
    if (end < 0) return null
    const frontmatter = source.slice(4, end).split('\n')
    let name: string | null = null
    let description: string | null = null
    for (const line of frontmatter) {
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
  if (!rawQuery) {
    return entry.type === 'skill' ? 30 : entry.type === 'folder' ? 20 : 10
  }

  const query = rawQuery.trim().toLowerCase()
  const compactQuery = query.replace(/\s+/g, '')
  const label = entry.label.toLowerCase()
  const relativePath = entry.relativePath.toLowerCase()

  let score = 0
  if (label.startsWith(query)) score += 30
  else if (relativePath.startsWith(query)) score += 24
  else if (label.includes(query)) score += 18
  else if (relativePath.includes(query)) score += 12
  if (compactQuery && isSubsequenceMatch(relativePath.replace(/\s+/g, ''), compactQuery)) {
    score += 8
  }
  // Small tiebreaker for skills only when they already match the query.
  // The blanket type bonus used to float unrelated skills above a real
  // file match (e.g. typing "org.ts" surfaced every SKILL.md first).
  if (score > 0 && entry.type === 'skill') score += 2
  return score
}

function searchAgentMentions(cwd: string, query: string): AgentMentionSearchResult[] {
  const roots = resolveAgentMentionRoots(cwd)
  if (roots.length === 0) return []

  const candidates: Array<AgentMentionSearchResult & { score: number }> = []
  let scannedEntries = 0

  const pushCandidate = (entry: AgentMentionSearchResult) => {
    const score = getAgentMentionScore(entry, query)
    if (query.trim() && score <= 0) return
    candidates.push({ ...entry, score })
  }

  for (const { sourceRoot, rootPath } of roots) {
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

      let entries: fs.Dirent[]
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

ipcMain.handle(
  'app:stat-path',
  async (
    _event,
    targetPath: string,
  ): Promise<{ kind: 'file' | 'dir' | 'missing'; resolved: string }> => {
    const resolved = expandHomePath(targetPath)
    try {
      const stat = fs.statSync(resolved)
      if (stat.isDirectory()) return { kind: 'dir', resolved }
      if (stat.isFile()) return { kind: 'file', resolved }
      return { kind: 'missing', resolved }
    } catch {
      return { kind: 'missing', resolved }
    }
  },
)

ipcMain.handle('app:reveal-path', async (_event, targetPath: string) => {
  const resolved = expandHomePath(targetPath)
  await shell.openPath(resolved)
})

ipcMain.handle('app:copy-attachment-to-clipboard', async (_event, targetPath: string) => {
  const resolved = expandHomePath(targetPath)
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error('Attachment is not a file')

  const image = nativeImage.createFromPath(resolved)
  if (!image.isEmpty()) {
    clipboard.writeImage(image)
    return { kind: 'image' as const }
  }

  clipboard.writeText(resolved)
  return { kind: 'path' as const }
})

ipcMain.handle('app:search-agent-mentions', async (_event, cwd: string, query: string) => {
  try {
    return searchAgentMentions(cwd, query)
  } catch (error) {
    console.warn('[app] search-agent-mentions failed', error)
    return []
  }
})

ipcMain.handle('app:request-quit', () => {
  return confirmAndQuitApp()
})

ipcMain.handle('app:relaunch', () => {
  app.relaunch()
  quitConfirmed = true
  app.quit()
})

ipcMain.handle('app:repair-terminal-fonts', () => {
  const markerFile = path.join(app.getPath('userData'), REPAIR_TERMINAL_FONTS_FILE)
  fs.writeFileSync(markerFile, '1\n', 'utf8')
  stopCellsOwnedBackgroundProcesses()
  app.relaunch()
  quitConfirmed = true
  app.quit()
})

ipcMain.handle(
  'app:show-notification',
  (
    _event,
    title: string,
    body: string,
    options?: {
      playSound?: boolean
      focusAgentWindowId?: string | null
      focusProjectId?: string | null
    },
  ) => {
    return showSystemNotification(title, body, options)
  },
)

ipcMain.on('app:beep', () => {
  shell.beep()
})

// ---------- Git worktree helpers ----------

function gitExec(args: string[], cwd: string): string {
  const shell = process.env.SHELL || '/bin/zsh'
  const escaped = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
  return execFileSync(shell, ['-lc', `git ${escaped}`], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
    encoding: 'utf8',
  }).trim()
}

function parseWorktreeList(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = []
  let current: {
    path?: string
    branch?: string | null
    branchRef?: string | null
    head?: string | null
    bare?: boolean
    detached?: boolean
    lockedReason?: string | null
    prunable?: boolean
    prunableReason?: string | null
  } = {}

  const pushCurrent = () => {
    if (!current.path) return
    worktrees.push({
      path: current.path,
      repoRoot: '',
      head: current.head ?? null,
      branch: current.detached ? null : (current.branch ?? null),
      branchRef: current.branchRef ?? null,
      isMain: worktrees.length === 0,
      isBare: current.bare ?? false,
      isDetached: current.detached ?? false,
      isMissing: false,
      isDirty: false,
      dirtyCount: 0,
      ahead: null,
      behind: null,
      upstream: null,
      prunable: current.prunable ?? false,
      lockedReason: current.lockedReason ?? current.prunableReason ?? null,
    })
  }

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length)
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length) || null
    } else if (line.startsWith('branch ')) {
      const branchRef = line.slice('branch '.length)
      current.branchRef = branchRef
      current.branch = branchRef.replace(/^refs\/heads\//, '')
    } else if (line === 'bare') {
      current.bare = true
    } else if (line === 'detached') {
      current.detached = true
      current.branch = null
      current.branchRef = null
    } else if (line.startsWith('locked')) {
      current.lockedReason = line.slice('locked'.length).trim() || null
    } else if (line.startsWith('prunable')) {
      current.prunable = true
      current.prunableReason = line.slice('prunable'.length).trim() || null
    } else if (line === '') {
      pushCurrent()
      current = {}
    }
  }
  // Handle last entry if no trailing newline
  pushCurrent()

  return worktrees
}

function parseWorktreeStatus(output: string): Partial<GitWorktree> {
  let head: string | null = null
  let branch: string | null = null
  let upstream: string | null = null
  let ahead: number | null = null
  let behind: number | null = null
  let dirtyCount = 0

  for (const line of output.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.oid ')) {
      const value = line.slice('# branch.oid '.length).trim()
      head = value && value !== '(initial)' ? value : null
      continue
    }
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim()
      branch = value && value !== '(detached)' ? value : null
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim() || null
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+)\s+-(\d+)/)
      if (match) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
      continue
    }
    if (!line.startsWith('#')) dirtyCount += 1
  }

  return {
    head,
    branch,
    upstream,
    ahead,
    behind,
    dirtyCount,
    isDirty: dirtyCount > 0,
  }
}

function enrichWorktree(raw: GitWorktree, repoRoot: string): GitWorktree {
  const exists = fs.existsSync(raw.path)
  if (!exists || raw.isBare) {
    return {
      ...raw,
      repoRoot,
      isMissing: !exists,
      prunable: raw.prunable || !exists,
    }
  }

  try {
    const status = parseWorktreeStatus(gitExec(['status', '--porcelain=v2', '--branch'], raw.path))
    const branch = raw.branch ?? status.branch ?? null
    return {
      ...raw,
      ...status,
      repoRoot,
      branch,
      branchRef: raw.branchRef ?? (branch ? `refs/heads/${branch}` : null),
      isDetached: raw.isDetached || !branch,
      isMissing: false,
      prunable: raw.prunable,
      dirtyCount: status.dirtyCount ?? 0,
      isDirty: status.isDirty ?? false,
    }
  } catch {
    return {
      ...raw,
      repoRoot,
      isMissing: false,
    }
  }
}

function listEnrichedWorktrees(cwd: string): GitWorktree[] {
  const repoRoot = gitExec(['rev-parse', '--show-toplevel'], cwd)
  const output = gitExec(['worktree', 'list', '--porcelain'], cwd)
  return parseWorktreeList(output).map((worktree) => enrichWorktree(worktree, repoRoot))
}

function sanitizeWorktreeSlug(branch: string) {
  const slug = branch
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `worktree-${Date.now().toString(36)}`
}

function validateBranchName(cwd: string, branchName: string) {
  const trimmed = branchName.trim()
  if (!trimmed) return { valid: false, message: 'Branch name is required.' }
  try {
    gitExec(['check-ref-format', '--branch', trimmed], cwd)
    return { valid: true, message: null }
  } catch (err) {
    return {
      valid: false,
      message: err instanceof Error ? err.message : 'Invalid branch name.',
    }
  }
}

ipcMain.handle('git:is-repo', (_event, cwd: string) => {
  try {
    gitExec(['rev-parse', '--is-inside-work-tree'], cwd)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('git:repo-root', (_event, cwd: string) => {
  try {
    return gitExec(['rev-parse', '--show-toplevel'], cwd)
  } catch {
    return null
  }
})

ipcMain.handle('git:list-worktrees', (_event, cwd: string) => {
  try {
    return listEnrichedWorktrees(cwd)
  } catch {
    return []
  }
})

ipcMain.handle(
  'git:create-worktree',
  (_event, cwd: string, optionsOrBranch: GitWorktreeCreateOptions | string) => {
    const options: GitWorktreeCreateOptions =
      typeof optionsOrBranch === 'string' ? { branchName: optionsOrBranch } : optionsOrBranch
    const branch = options.branchName.trim()
    const validation = validateBranchName(cwd, branch)
    if (!validation.valid) {
      throw new Error(validation.message || 'Invalid branch name.')
    }
    const repoRoot = gitExec(['rev-parse', '--show-toplevel'], cwd)
    const slug = sanitizeWorktreeSlug(branch)
    const dest = options.targetDir
      ? path.join(options.targetDir, slug)
      : path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-${slug}`)

    if (fs.existsSync(dest)) {
      throw new Error(`Worktree path already exists: ${dest}`)
    }

    if (options.checkoutExistingBranch) {
      gitExec(['worktree', 'add', dest, branch], cwd)
    } else {
      const args = ['worktree', 'add', '-b', branch, dest]
      if (options.baseRef) args.push(options.baseRef)
      gitExec(args, cwd)
    }

    // Return the new worktree info
    const all = listEnrichedWorktrees(cwd)
    const created = all.find((w) => w.path === dest)
    if (!created) throw new Error(`Worktree created but not found: ${dest}`)
    return created
  },
)

ipcMain.handle(
  'git:remove-worktree',
  (_event, cwd: string, worktreePath: string, options?: { force?: boolean }) => {
    const worktree = listEnrichedWorktrees(cwd).find((entry) => entry.path === worktreePath)
    if (!worktree) throw new Error(`Worktree not found: ${worktreePath}`)
    if (worktree.isMain) throw new Error('Cannot remove the main worktree.')
    if (worktree.isDirty && !options?.force) {
      throw new Error('Worktree has uncommitted changes.')
    }
    const args = ['worktree', 'remove']
    if (options?.force) args.push('--force')
    args.push(worktreePath)
    gitExec(args, cwd)
  },
)

ipcMain.handle('git:prune-worktrees', (_event, cwd: string) => {
  gitExec(['worktree', 'prune'], cwd)
})

ipcMain.handle('git:validate-branch', (_event, cwd: string, branchName: string) => {
  return validateBranchName(cwd, branchName)
})

ipcMain.handle('git:status-worktree', (_event, worktreePath: string) => {
  try {
    const repoRoot = gitExec(['rev-parse', '--show-toplevel'], worktreePath)
    const branch = gitExec(['branch', '--show-current'], worktreePath) || null
    const raw: GitWorktree = {
      path: worktreePath,
      repoRoot,
      head: null,
      branch,
      branchRef: branch ? `refs/heads/${branch}` : null,
      isMain: false,
      isBare: false,
      isDetached: !branch,
      isMissing: !fs.existsSync(worktreePath),
      isDirty: false,
      dirtyCount: 0,
      ahead: null,
      behind: null,
      upstream: null,
      prunable: false,
      lockedReason: null,
    }
    return enrichWorktree(raw, repoRoot)
  } catch {
    return null
  }
})

ipcMain.handle(
  'agent:check-available',
  (_event, aliases?: Record<string, string>, customPaths?: Record<string, string>) => {
    // Use a login shell so the user's full PATH is available.
    // Packaged macOS apps inherit a minimal PATH (/usr/bin:/bin) that
    // won't include Homebrew, ~/.local/bin, nvm, etc.
    const shell = process.env.SHELL || '/bin/zsh'
    const home = os.homedir()
    const fallbackPaths = [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      `${home}/.local/bin`,
      `${home}/.bun/bin`,
      `${home}/.npm-global/bin`,
      `${home}/.volta/bin`,
      `${home}/.nvm/versions/node`,
    ]
    const results: Record<string, boolean> = {}
    for (const name of ['claude', 'codex', 'opencode', 'pi']) {
      // If a custom path is configured, check it directly first.
      const customPath = customPaths?.[name]?.trim()
      if (customPath) {
        try {
          results[name] = fs.existsSync(customPath)
        } catch {
          results[name] = false
        }
        continue
      }
      const cmd = aliases?.[name]?.trim() || name
      const executable = (cmd.match(/^(".*?"|'.*?'|\S+)/)?.[0] ?? name).replace(/^['"]|['"]$/g, '')
      const escapedExecutable = executable.replace(/'/g, "'\\''")
      try {
        execFileSync(shell, ['-lc', `command -v -- '${escapedExecutable}'`], {
          stdio: 'pipe',
          timeout: 3000,
        })
        results[name] = true
        continue
      } catch {
        // fall through to path probe
      }
      // Fallback: probe common install locations directly (covers packaged
      // apps where the user's login shell/rc files aren't sourced correctly).
      results[name] = fallbackPaths.some((dir) => {
        try {
          return fs.existsSync(path.join(dir, executable))
        } catch {
          return false
        }
      })
    }
    return results
  },
)

ipcMain.handle('agent:set-custom-paths', (_event, paths: Record<string, string>) => {
  setCustomAgentPaths(paths)
})

ipcMain.handle('agent-session:ensure', (_event, request) => {
  return agentSessionService.ensure(request)
})

ipcMain.handle(
  'agent-session:send',
  (
    _event,
    windowId: string,
    input: string,
    attachments?: string[],
    overrides?: Parameters<typeof agentSessionService.send>[3],
  ) => {
    return agentSessionService.send(windowId, input, attachments, overrides)
  },
)

ipcMain.handle(
  'agent-session:branch-from',
  (
    _event,
    sourceWindowId: string,
    request,
    visibleInput: string,
    providerInput: string,
    attachments?: string[],
    overrides?: Parameters<typeof agentSessionService.send>[3],
  ) => {
    return agentSessionService.branchFrom(
      sourceWindowId,
      request,
      visibleInput,
      providerInput,
      attachments,
      overrides,
    )
  },
)

ipcMain.handle('agent-session:close', (_event, windowId: string) => {
  // Stop the current turn but keep the runtime + messages around so the
  // renderer can resume on the next send.
  clearAgentSessionNotificationState(windowId)
  return agentSessionService.close(windowId)
})

ipcMain.handle('agent-session:dispose', (_event, windowId: string) => {
  // Full teardown — called when the agent window itself is destroyed.
  clearAgentSessionNotificationState(windowId)
  return agentSessionService.dispose(windowId)
})

ipcMain.handle('agent-session:get-auth', (_event, agent: 'claude' | 'codex') => {
  return getAgentAuthStatus(agent)
})

ipcMain.handle('agent-session:get-login-command', (_event, agent: 'claude' | 'codex') => {
  return getAgentLoginCommand(agent)
})

ipcMain.handle('agent-session:start-login', (_event, agent: 'claude' | 'codex') => {
  return agentLoginManager.start(agent)
})

ipcMain.handle('agent-session:cancel-login', (_event, agent: 'claude' | 'codex') => {
  agentLoginManager.cancel(agent)
})

ipcMain.handle(
  'agent-session:update-permission-mode',
  async (
    _event,
    windowId: string,
    // Accepts the current 3-mode set plus legacy values ('safe', 'allow-all')
    // which the service coerces into 'plan' / 'ask'.
    mode: 'plan' | 'ask' | 'bypass' | 'safe' | 'allow-all' | null,
  ) => {
    return agentSessionService.updatePermissionMode(windowId, mode)
  },
)

ipcMain.handle(
  'agent-session:update-context-length',
  async (_event, windowId: string, length: 'default' | 'extended' | null) => {
    return agentSessionService.updateContextLength(windowId, length)
  },
)

ipcMain.handle(
  'agent-session:respond-plan',
  async (
    _event,
    windowId: string,
    decision: 'auto-accept' | 'ask' | 'reject',
    feedback?: string,
  ) => {
    return agentSessionService.respondPlan(windowId, decision, feedback)
  },
)

ipcMain.handle(
  'agent-session:respond-question',
  async (
    _event,
    windowId: string,
    answers: Record<string, string[]> | null,
    note: string | null,
  ) => {
    return agentSessionService.respondQuestion(windowId, answers, note)
  },
)

ipcMain.handle(
  'agent-session:respond-approval',
  async (_event, windowId: string, decision: 'accept' | 'acceptForSession' | 'decline') => {
    return agentSessionService.respondApproval(windowId, decision)
  },
)

ipcMain.handle('agent-session:list-codex-models', async () => {
  try {
    return await listCodexModels()
  } catch (err) {
    console.warn('[agent-session] list-codex-models failed', err)
    return []
  }
})

ipcMain.handle('agent-session:list-claude-models', async () => {
  try {
    return await listClaudeModels()
  } catch (err) {
    console.warn('[agent-session] list-claude-models failed', err)
    return []
  }
})

ipcMain.handle('agent-session:list-saved-sessions', async () => {
  try {
    return await agentSessionService.listSavedSessions()
  } catch (err) {
    console.warn('[agent-session] list-saved-sessions failed', err)
    return []
  }
})

ipcMain.handle(
  'agent-session:list-recent-sessions',
  async (_event, agent: 'claude' | 'codex', limit?: number) => {
    try {
      return await agentSessionService.listRecentSessions(agent, limit)
    } catch (err) {
      console.warn('[agent-session] list-recent-sessions failed', err)
      return []
    }
  },
)

agentLoginManager.on('event', (event: LoginEvent) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    const contents = window.webContents
    if (contents.isDestroyed() || contents.isCrashed()) continue
    try {
      contents.send('agent-session:login-event', event)
    } catch {
      /* frame disposed */
    }
  }
})

// ---------- MCP server install ----------

function resolveMcpServerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'mcp-server', 'dist', 'index.js')
  }
  return path.join(__dirname, '..', 'mcp-server', 'dist', 'index.js')
}

/**
 * Merge the "cells" MCP entry into a JSON config file (`.agents/mcp.json`,
 * `.mcp.json`).  Only touches the `mcpServers.cells` key — everything else in
 * the file is left untouched.
 */
function upsertMcpJsonEntry(filePath: string, entry: { command: string; args: string[] }): void {
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    // file missing or invalid — start fresh
  }
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>
  servers.cells = entry
  existing.mcpServers = servers
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n')
}

/**
 * Upsert the `[mcp_servers.cells]` section in a TOML config file (Codex CLI).
 * Preserves all other content in the file — only the cells block is replaced or
 * appended.
 */
function upsertCodexTomlEntry(filePath: string, entry: { command: string; args: string[] }): void {
  let content = ''
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    // file missing — start fresh
  }

  const argsToml = `[${entry.args.map((a) => JSON.stringify(a)).join(', ')}]`
  const block = [
    `[mcp_servers.cells]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = ${argsToml}`,
  ].join('\n')

  // Replace existing [mcp_servers.cells] block, or append
  const sectionRe = /^\[mcp_servers\.cells\]\s*\n(?:[^[]*?)(?=\n\[|\s*$)/m
  if (sectionRe.test(content)) {
    content = content.replace(sectionRe, block)
  } else {
    content = content.trimEnd() + (content.length > 0 ? '\n\n' : '') + block + '\n'
  }

  fs.writeFileSync(filePath, content)
}

ipcMain.handle('mcp:install', async (_event, projectPath: string) => {
  const serverPath = resolveMcpServerPath()
  if (!fs.existsSync(serverPath)) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        message: 'MCP Server Not Found',
        detail: `Expected at:\n${serverPath}\n\nRun "pnpm build" in the mcp-server directory first.`,
      })
    }
    throw new Error('MCP server not built')
  }

  const mcpEntry = { command: 'node', args: [serverPath] }
  const targets: string[] = []

  // 1. Canonical source: .agents/mcp.json
  const agentsDir = path.join(projectPath, '.agents')
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true })
  }
  const configPath = path.join(agentsDir, 'mcp.json')
  upsertMcpJsonEntry(configPath, mcpEntry)
  targets.push('.agents/mcp.json')

  // Remove stale symlinks left by older install flow
  for (const dir of ['.claude', '.codex']) {
    const linkPath = path.join(projectPath, dir, 'mcp.json')
    try {
      if (fs.lstatSync(linkPath).isSymbolicLink()) {
        fs.unlinkSync(linkPath)
      }
    } catch {}
  }

  // 2. Claude Code: .mcp.json at project root
  const mcpJsonPath = path.join(projectPath, '.mcp.json')
  upsertMcpJsonEntry(mcpJsonPath, mcpEntry)
  targets.push('.mcp.json')

  // 3. Codex CLI: .codex/config.toml (only if .codex/ exists)
  const codexDir = path.join(projectPath, '.codex')
  if (fs.existsSync(codexDir)) {
    const codexToml = path.join(codexDir, 'config.toml')
    upsertCodexTomlEntry(codexToml, mcpEntry)
    targets.push('.codex/config.toml')
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: 'MCP Server Installed',
      detail: `Updated:\n${targets.map((t) => `  ${t}`).join('\n')}\n\nServer: ${serverPath}`,
    })
  }

  return { configPath, targets, serverPath }
})

ipcMain.handle('app:toggle-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow?.maximize()
  }
})

ipcMain.handle('app:resize-to-fit', (_event, width: number, height: number) => {
  if (!mainWindow) return
  mainWindow.setContentSize(Math.round(width), Math.round(height), true)
})

ipcMain.handle(
  'app:pin-window',
  async (
    _event,
    id: string,
    type: string,
    bounds: { x: number; y: number; width: number; height: number },
    browserUrl?: string,
    browserProjectId?: string | null,
  ) => {
    // Close any existing pinned window for this id
    const existing = pinnedWindows.get(id)
    if (existing && !existing.isDestroyed()) existing.close()

    const browserProject =
      type === 'browser' ? (browserProjectId ?? browserIdToProject.get(id) ?? null) : null
    const isBrowser = type === 'browser' && browserUrl
    const transparentWindow = isTransparentWindowModeEnabled()
    const needsWarmReload = !process.env.VITE_DEV_SERVER_URL && !isBrowser
    let warmReloadDone = !needsWarmReload

    if (browserProject) {
      spoofChromeUA(browserProject)
      await ensureExtensionsLoaded(browserProject)
    }

    const browserWebPreferences = browserProject
      ? {
          partition: `persist:browser-${browserProject}`,
          preload: browserPreloadPath,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          scrollBounce: true,
          webgl: true,
        }
      : {
          nodeIntegration: false,
          contextIsolation: true,
          webgl: true,
        }

    const win = new BrowserWindow({
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      minWidth: 320,
      minHeight: 200,
      alwaysOnTop: true,
      titleBarStyle: isBrowser ? 'hiddenInset' : 'hidden',
      trafficLightPosition: isBrowser ? { x: 12, y: 16 } : { x: 12, y: 11 },
      roundedCorners: true,
      show: false,
      transparent: isBrowser ? false : transparentWindow,
      backgroundColor: isBrowser ? '#1e1e1e' : transparentWindow ? '#00000000' : '#15171a',
      vibrancy: isBrowser || !transparentWindow ? undefined : 'under-window',
      visualEffectState: isBrowser || !transparentWindow ? undefined : 'active',
      webPreferences: isBrowser
        ? browserWebPreferences
        : {
            preload: path.join(__dirname, PRELOAD_FILE),
            nodeIntegration: false,
            contextIsolation: true,
            webgl: true,
          },
    })

    pinnedWindows.set(id, win)
    pinnedWindowTypes.set(id, type as 'terminal' | 'browser' | 'agent')
    let unpinNotified = false

    const notifyUnpinned = () => {
      if (unpinNotified) return
      unpinNotified = true
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const currentUrl = win.webContents.getURL()
          const snapshot =
            type === 'browser'
              ? {
                  url:
                    currentUrl && currentUrl !== 'about:blank' ? currentUrl : (browserUrl ?? null),
                  title: win.webContents.getTitle() || null,
                }
              : null
          mainWindow.webContents.send('app:window-unpinned', id, type, snapshot)
          mainWindow.focus()
        }
      } catch {}
    }

    win.webContents.on('before-input-event', (event, input) => {
      if ((input.meta || input.control) && input.key.toLowerCase() === 'w') {
        event.preventDefault()
        notifyUnpinned()
        if (!win.isDestroyed()) win.close()
      }
    })

    if (isBrowser) {
      // Browser pop-out: keep the same project session so cookies, extensions,
      // and auth state stay aligned with the embedded browser.
      win.loadURL(browserUrl)
    } else {
      // Terminal pop-out: load the app renderer in pinned mode
      win.webContents.on('did-finish-load', () => {
        if (win.isDestroyed()) return
        if (!warmReloadDone) {
          warmReloadDone = true
          win.webContents.reload()
          return
        }
        setupTerminalDataPort(win)
        if (!win.isVisible()) {
          win.show()
        }
      })
      const url = process.env.VITE_DEV_SERVER_URL
        ? `${process.env.VITE_DEV_SERVER_URL}?pinned=${encodeURIComponent(id)}&type=${encodeURIComponent(type)}`
        : undefined
      if (url) {
        win.loadURL(url)
      } else {
        win.loadFile(path.join(__dirname, '../dist/index.html'), {
          query: { pinned: id, type },
        })
      }
    }

    win.on('ready-to-show', () => {
      if (warmReloadDone) {
        win.show()
      }
    })

    win.on('close', () => {
      notifyUnpinned()
    })

    win.on('closed', () => {
      pinnedWindows.delete(id)
      pinnedWindowTypes.delete(id)
    })

    win.on('resize', () => {
      try {
        const bounds = win.getContentBounds()
        win.webContents.send('app:window-resized', id, type, bounds.width, bounds.height)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app:window-resized', id, type, bounds.width, bounds.height)
        }
      } catch {}
    })
  },
)

ipcMain.handle('app:unpin-window', (_event, id: string) => {
  const win = pinnedWindows.get(id)
  if (win && !win.isDestroyed()) win.close()
})

ipcMain.handle('app:pick-folder', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, getPickFolderDialogOptions())
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('app:pick-files', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
  })
  return result.canceled ? null : result.filePaths
})

ipcMain.handle('app:list-recent-files', async () => {
  const dirs = [
    {
      label: 'screenshot',
      paths: [path.join(app.getPath('desktop')), path.join(app.getPath('home'), 'Screenshots')],
    },
    { label: 'download', paths: [app.getPath('downloads')] },
  ]
  const results: Array<{ path: string; name: string; mtime: number; source: string }> = []
  const now = Date.now()
  const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days
  for (const { label, paths: dirPaths } of dirs) {
    for (const dir of dirPaths) {
      try {
        const entries = fs.readdirSync(dir)
        for (const entry of entries) {
          if (entry.startsWith('.')) continue
          const fullPath = path.join(dir, entry)
          try {
            const stat = fs.statSync(fullPath)
            if (!stat.isFile()) continue
            if (now - stat.mtimeMs > maxAge) continue
            results.push({ path: fullPath, name: entry, mtime: stat.mtimeMs, source: label })
          } catch {}
        }
      } catch {}
    }
  }
  results.sort((a, b) => b.mtime - a.mtime)
  return results.slice(0, 20)
})

ipcMain.handle('app:save-temp-file', async (_event, data: Uint8Array, filename: string) => {
  try {
    const tmpDir = path.join(app.getPath('temp'), 'cells-clipboard')
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
    const filePath = path.join(tmpDir, filename)
    fs.writeFileSync(filePath, Buffer.from(data))
    return filePath
  } catch {
    return null
  }
})

// Read shell history (bash, zsh, or fish) and return deduplicated recent commands
ipcMain.handle('app:get-shell-history', async () => {
  try {
    const homeDir = app.getPath('home')
    const userShell = process.env.SHELL || '/bin/zsh'

    // Determine history file based on the user's shell
    let historyFile: string
    let parser: (content: string) => string[]

    if (userShell.includes('fish')) {
      historyFile = path.join(homeDir, '.local', 'share', 'fish', 'fish_history')
      parser = (content) => {
        // Fish history format: "- cmd: <command>" lines
        return content
          .split('\n')
          .filter((line) => line.startsWith('- cmd: '))
          .map((line) => line.slice(7))
      }
    } else if (userShell.includes('zsh')) {
      historyFile = path.join(homeDir, '.zsh_history')
      parser = (content) => {
        return content.split('\n').map((line) => {
          // Zsh extended history format: ": <timestamp>:<elapsed>;<command>"
          const m = line.match(/^: \d+:\d+;(.*)/)
          return m ? m[1] : line
        })
      }
    } else {
      historyFile = path.join(homeDir, '.bash_history')
      parser = (content) => content.split('\n')
    }

    if (!fs.existsSync(historyFile)) return []
    const content = fs.readFileSync(historyFile, 'utf-8')
    const lines = parser(content).filter((l) => l.trim().length > 0)

    // Deduplicate, keeping the most recent occurrence, return last 100
    const seen = new Set<string>()
    const unique: string[] = []
    for (let i = lines.length - 1; i >= 0; i--) {
      const cmd = lines[i].trim()
      if (!seen.has(cmd)) {
        seen.add(cmd)
        unique.push(cmd)
      }
      if (unique.length >= 100) break
    }
    return unique
  } catch {
    return []
  }
})

// Read clipboard — returns file paths (copied files, images) or null (caller falls back to text)
ipcMain.handle('app:paste-clipboard-files', async () => {
  try {
    const { clipboard } = await import('electron')

    // 1. Check for file paths (copied files in Finder, etc.)
    if (process.platform === 'darwin') {
      const raw = clipboard.readBuffer('NSFilenamesPboardType')
      if (raw.length > 0) {
        const text = raw.toString('utf8')
        const matches = text.match(/<string>(.*?)<\/string>/g)
        if (matches && matches.length > 0) {
          const filePaths = matches
            .map((m) => decodePlistString(m.replace(/<\/?string>/g, '')))
            .filter((p) => p && fs.existsSync(p))
          if (filePaths.length > 0) return filePaths
        }
      }
    }

    // 2. Check for image in clipboard
    const image = clipboard.readImage()
    if (!image.isEmpty()) {
      const tmpDir = path.join(app.getPath('temp'), 'cells-clipboard')
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
      const filePath = path.join(tmpDir, `clipboard-${Date.now()}.png`)
      fs.writeFileSync(filePath, image.toPNG())
      return [filePath]
    }

    return null
  } catch {
    return null
  }
})

ipcMain.handle('app:file-thumbnail', async (_event, filePath: string, maxHeight?: number) => {
  try {
    const img = nativeImage.createFromPath(filePath)
    if (img.isEmpty()) return null
    const targetHeight = Math.max(32, Math.min(1600, Math.floor(maxHeight ?? 96)))
    const thumb = img.resize({ height: targetHeight })
    return thumb.toDataURL()
  } catch {
    return null
  }
})

ipcMain.on('terminal:write', (_event, termId: string, data: string) => {
  if (useDaemon && daemonClient?.isConnected()) {
    daemonClient.write(termId, data)
  } else if (fallbackSessions?.has(termId)) {
    fallbackSessions.write(termId, data)
  }
})

ipcMain.on('terminal:resize', (_event, termId: string, cols: number, rows: number) => {
  if (useDaemon && daemonClient?.isConnected()) {
    daemonClient.resize(termId, cols, rows)
  } else if (fallbackSessions?.has(termId)) {
    fallbackSessions.resize(termId, cols, rows)
  }
})

ipcMain.handle(
  'terminal:handle-wheel',
  async (_event, termId: string, direction: 'up' | 'down', steps: number, sequence: string) => {
    if (useDaemon && daemonClient?.isConnected()) {
      daemonClient.handleWheel(termId, direction, steps, sequence)
    } else if (fallbackSessions?.has(termId)) {
      fallbackSessions.handleWheel(termId, direction, steps, sequence)
    }
  },
)

// ---------- Browser IPC ----------

const browserViews = new Map<string, WebContentsView>()
const browserPreloadPath = path.join(__dirname, BROWSER_PRELOAD_FILE)

// Saved history for browsers restored after app restart.
// Used for software back/forward when native history is empty.
interface SavedHistory {
  entries: Array<{ url: string; title: string }>
  activeIndex: number
  navigatingFromSaved: boolean // true when we're navigating via saved history (suppress clear)
}
const savedHistories = new Map<string, SavedHistory>()

interface BrowserViewRuntimeState {
  loading: boolean
  themeColor: string | null
  faviconUrl: string | null
  failure: BrowserViewFailure | null
  attachedToMainWindow: boolean
  parked: boolean
  visible: boolean
}
const browserViewStates = new Map<string, BrowserViewRuntimeState>()

// Map browserId → the browserId so overscroll IPC from the preload can be relayed
const webContentsIdToBrowser = new Map<number, string>()
const browserIdToProject = new Map<string, string>()
const mcpNetworkCaptureProjects = new Set<string>()

function getBrowserViewState(browserId: string): BrowserViewRuntimeState {
  const existing = browserViewStates.get(browserId)
  if (existing) return existing
  const created: BrowserViewRuntimeState = {
    loading: false,
    themeColor: null,
    faviconUrl: null,
    failure: null,
    attachedToMainWindow: false,
    parked: false,
    visible: false,
  }
  browserViewStates.set(browserId, created)
  return created
}

function resetBrowserViewFailure(browserId: string) {
  getBrowserViewState(browserId).failure = null
}

function ensureMcpNetworkCapture(projectId: string, pageSession: Electron.Session) {
  if (mcpNetworkCaptureProjects.has(projectId)) return
  mcpNetworkCaptureProjects.add(projectId)
  try {
    pageSession.webRequest.onCompleted({ urls: ['<all_urls>'] }, (details) => {
      const rawDetails = details as any
      if (typeof details.webContentsId !== 'number') return
      const browserId = webContentsIdToBrowser.get(details.webContentsId)
      if (!browserId) return
      const headers = details.responseHeaders ?? {}
      const contentType =
        headers['content-type']?.[0] ?? headers['Content-Type']?.[0] ?? headers['Content-type']?.[0]
      captureNetworkRequest(browserId, {
        id: String(rawDetails.id ?? randomUUID()),
        url: details.url,
        method: details.method,
        statusCode: details.statusCode,
        statusLine: details.statusLine,
        resourceType: details.resourceType,
        mimeType: contentType,
        fromCache: details.fromCache,
        error: rawDetails.error,
        timestamp: Date.now(),
        elapsedMs: typeof details.timestamp === 'number' ? Date.now() - details.timestamp : null,
      })
    })
  } catch {}
}

function attachBrowserView(browserId: string, view: WebContentsView) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const state = getBrowserViewState(browserId)
  if (state.attachedToMainWindow) return
  try {
    mainWindow.contentView.addChildView(view)
  } catch {}
  state.attachedToMainWindow = true
}

function detachBrowserView(browserId: string, view: WebContentsView) {
  const state = getBrowserViewState(browserId)
  if (!mainWindow || mainWindow.isDestroyed()) {
    state.attachedToMainWindow = false
    return
  }
  if (!state.attachedToMainWindow) return
  try {
    mainWindow.contentView.removeChildView(view)
  } catch {}
  state.attachedToMainWindow = false
}

function setupBrowserView(browserId: string, view: WebContentsView, projectId: string) {
  if (!mainWindow) return
  webContentsIdToBrowser.set(view.webContents.id, browserId)
  browserIdToProject.set(browserId, projectId)
  ensureMcpNetworkCapture(projectId, view.webContents.session)
  const browserState = getBrowserViewState(browserId)

  // Intercept app shortcuts before the WebContentsView consumes them
  view.webContents.on('before-input-event', (_e, input) => {
    // Forward Ctrl+Tab / Ctrl+Shift+Tab explicitly because the first Tab press can
    // be lost if we rely on synthetic key events during the browser→renderer focus hop.
    if (input.control && input.key === 'Tab') {
      _e.preventDefault()
      if (input.type === 'keyDown' && !mainWindow?.isDestroyed()) {
        mainWindow?.webContents.focus()
        mainWindow?.webContents.send('browser:window-cycle', input.shift ? -1 : 1)
      }
      return
    }

    if (input.control && input.code === 'Backquote') {
      _e.preventDefault()
      if (input.type === 'keyDown' && !mainWindow?.isDestroyed()) {
        mainWindow?.webContents.focus()
        mainWindow?.webContents.send('browser:project-cycle', input.shift ? -1 : 1)
      }
      return
    }

    if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return

    const command = matchBrowserViewShortcut(
      {
        key: input.key,
        code: input.code,
        metaKey: input.meta,
        ctrlKey: input.control,
        shiftKey: input.shift,
        altKey: input.alt,
      },
      process.platform,
    )
    if (!command) return

    _e.preventDefault()
    if (shouldFocusRendererForShortcut(command) && !mainWindow?.isDestroyed()) {
      mainWindow?.webContents.focus()
    }
    sendShortcutToRenderer({ command, source: 'browser-view', browserId })
  })

  // Intercept new-window requests (target=_blank links, window.open)
  view.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('browser:new-window', browserId, url)
      }
    } catch {}
    return { action: 'deny' }
  })

  // Forward loading state
  view.webContents.on('did-start-loading', () => {
    browserState.loading = true
    resetBrowserViewFailure(browserId)
    try {
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('browser:loading', browserId, true)
      }
    } catch {}
  })
  view.webContents.on('did-stop-loading', () => {
    browserState.loading = false
    try {
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('browser:loading', browserId, false)
      }
    } catch {}
    view.webContents
      .executeJavaScript(
        `(function() {
        var meta = document.querySelector('meta[name="theme-color"]');
        return meta ? meta.getAttribute('content') : null;
      })()`,
      )
      .then((color) => {
        browserState.themeColor = typeof color === 'string' && color.length > 0 ? color : null
        try {
          if (!mainWindow?.isDestroyed()) {
            mainWindow?.webContents.send('browser:theme-color', browserId, browserState.themeColor)
          }
        } catch {}
      })
      .catch(() => {})
  })

  const reportLoadFailure = (
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame || errorCode === -3) return
    browserState.loading = false
    browserState.failure = {
      kind: 'load-failed',
      code: errorCode,
      message: errorDescription || 'Navigation failed.',
      url: validatedURL,
    }
    try {
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('browser:loading', browserId, false)
        mainWindow?.webContents.send('browser:load-failed', browserId, browserState.failure)
      }
    } catch {}
  }

  view.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    reportLoadFailure(code, description, url, isMainFrame)
  })
  view.webContents.on(
    'did-fail-provisional-load',
    (_event, code, description, url, isMainFrame) => {
      reportLoadFailure(code, description, url, isMainFrame)
    },
  )

  view.webContents.on('render-process-gone', (_event, details) => {
    browserState.loading = false
    browserState.failure = {
      kind: 'crashed',
      reason: details.reason,
      message:
        details.reason === 'crashed'
          ? 'This page crashed.'
          : details.reason === 'killed'
            ? 'This page was terminated.'
            : 'The page process went away.',
    }
    try {
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('browser:loading', browserId, false)
        mainWindow?.webContents.send('browser:render-gone', browserId, browserState.failure)
      }
    } catch {}
  })

  // Forward title updates
  view.webContents.on('page-title-updated', (_e, title) => {
    try {
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('browser:title-updated', browserId, title)
      }
    } catch {}
  })

  // Forward favicon updates
  view.webContents.on('page-favicon-updated', (_e, favicons) => {
    browserState.faviconUrl = favicons[0] ?? null
    try {
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('browser:favicon-updated', browserId, browserState.faviconUrl)
      }
    } catch {}
  })

  // Capture console messages for MCP bridge
  view.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    captureConsoleLog(browserId, level, message, line, sourceId)
  })

  // Forward URL changes, accounting for saved history
  const sendNavUpdate = (url: string) => {
    try {
      if (mainWindow?.isDestroyed()) return
      const saved = savedHistories.get(browserId)

      // If this navigation wasn't triggered by saved history, clear saved history
      // (user navigated to a genuinely new page)
      if (saved && !saved.navigatingFromSaved) {
        savedHistories.delete(browserId)
      }
      if (saved?.navigatingFromSaved) {
        saved.navigatingFromSaved = false
      }

      const nativeBack = view.webContents.navigationHistory.canGoBack()
      const nativeFwd = view.webContents.navigationHistory.canGoForward()
      const sh = savedHistories.get(browserId)
      const canBack = nativeBack || (sh ? sh.activeIndex > 0 : false)
      const canFwd = nativeFwd || (sh ? sh.activeIndex < sh.entries.length - 1 : false)

      mainWindow?.webContents.send('browser:url-changed', browserId, url)
      mainWindow?.webContents.send('browser:nav-state', browserId, canBack, canFwd)
    } catch {}
  }
  view.webContents.on('did-navigate', (_e, url) => sendNavUpdate(url))
  view.webContents.on('did-navigate-in-page', (_e, url) => sendNavUpdate(url))

  // Right-click context menu (Chrome-like)
  view.webContents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = []

    // Navigation
    const nativeBack = view.webContents.navigationHistory.canGoBack()
    const nativeFwd = view.webContents.navigationHistory.canGoForward()
    const sh = savedHistories.get(browserId)
    const canBack = nativeBack || (sh ? sh.activeIndex > 0 : false)
    const canFwd = nativeFwd || (sh ? sh.activeIndex < sh.entries.length - 1 : false)
    template.push(
      { label: 'Back', enabled: canBack, click: () => browserGoBack(browserId) },
      { label: 'Forward', enabled: canFwd, click: () => browserGoForward(browserId) },
      { label: 'Reload', click: () => view.webContents.reload() },
      { type: 'separator' },
    )

    // Link actions
    if (params.linkURL) {
      template.push(
        {
          label: 'Open Link in New Tab',
          click: () => {
            if (!mainWindow?.isDestroyed()) {
              mainWindow?.webContents.send('browser:new-window', browserId, params.linkURL)
            }
          },
        },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      )
    }

    // Image actions
    if (params.mediaType === 'image') {
      template.push(
        {
          label: 'Save Image As\u2026',
          click: async () => {
            let defaultName = 'image'
            try {
              defaultName = path.basename(new URL(params.srcURL).pathname) || defaultName
            } catch {}
            const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: defaultName })
            if (!result.canceled && result.filePath) {
              const savePath = result.filePath
              const ses = view.webContents.session
              const handler = (_e: Electron.Event, item: Electron.DownloadItem) => {
                item.setSavePath(savePath)
                ses.removeListener('will-download', handler)
              }
              ses.on('will-download', handler)
              view.webContents.downloadURL(params.srcURL)
            }
          },
        },
        {
          label: 'Copy Image',
          click: () => view.webContents.copyImageAt(params.x, params.y),
        },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' },
      )
    }

    // Editable field actions
    if (params.isEditable) {
      template.push(
        { label: 'Undo', enabled: params.editFlags.canUndo, role: 'undo' },
        { label: 'Redo', enabled: params.editFlags.canRedo, role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', enabled: params.editFlags.canCut, role: 'cut' },
        { label: 'Copy', enabled: params.editFlags.canCopy, role: 'copy' },
        { label: 'Paste', enabled: params.editFlags.canPaste, role: 'paste' },
        { label: 'Select All', enabled: params.editFlags.canSelectAll, role: 'selectAll' },
        { type: 'separator' },
      )
    } else if (params.selectionText) {
      template.push({ label: 'Copy', role: 'copy' }, { type: 'separator' })
    }

    // Inspect element
    template.push({
      label: 'Inspect Element',
      click: () => view.webContents.inspectElement(params.x, params.y),
    })

    Menu.buildFromTemplate(template).popup()
  })

  // CWS "Add to Chrome" interception — install extensions directly from the store
  setupCWSIntegration(view.webContents, async (extensionId) => {
    try {
      const meta = await installExtension(extensionId)
      // Auto-enable for the project that owns this browser view
      setExtensionEnabled(projectId, meta.id, true)
      await loadExtensionIntoSession(projectId, meta.id)
      // Notify renderer so toolbar extension icons refresh
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('extensions:installed', meta)
      }
      return true
    } catch (err) {
      console.error('[extensions] CWS install failed:', err)
      return false
    }
  })
}

ipcMain.handle(
  'browser:create',
  async (
    _event,
    browserId: string,
    projectId: string,
    history?: { entries: Array<{ url: string; title: string }>; activeIndex: number },
  ) => {
    if (!mainWindow) return

    // Ensure Chrome extensions are loaded into this project's session
    // Ensure Chrome extensions are loaded and UA is spoofed for CWS compat
    spoofChromeUA(projectId)
    await ensureExtensionsLoaded(projectId)

    // If the view already exists (parked from project switch), just re-add it
    const existing = browserViews.get(browserId)
    if (existing) {
      const browserState = getBrowserViewState(browserId)
      browserState.parked = false
      try {
        attachBrowserView(browserId, existing)
      } catch {}
      existing.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      // Send current nav state so the status bar updates
      try {
        mainWindow.webContents.send(
          'browser:nav-state',
          browserId,
          existing.webContents.navigationHistory.canGoBack(),
          existing.webContents.navigationHistory.canGoForward(),
        )
        const currentUrl = existing.webContents.getURL()
        if (currentUrl) {
          mainWindow.webContents.send('browser:url-changed', browserId, currentUrl)
        }
      } catch {}
      return { unparked: true }
    }

    const partition = `persist:browser-${projectId}`
    const view = new WebContentsView({
      webPreferences: {
        partition,
        preload: browserPreloadPath,
        contextIsolation: true,
        sandbox: true,
        scrollBounce: true,
      },
    })

    const browserState = getBrowserViewState(browserId)
    browserState.parked = false
    browserState.visible = false
    attachBrowserView(browserId, view)
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    view.setBorderRadius(5)
    browserViews.set(browserId, view)

    // Store saved history for software back/forward after app restart
    if (history && history.entries.length > 1) {
      savedHistories.set(browserId, {
        entries: history.entries,
        activeIndex: history.activeIndex,
        // The renderer will immediately reload the current entry after create().
        // Treat that first navigation as a restore step so we don't clear the
        // persisted history before the toolbar has a chance to use it.
        navigatingFromSaved: true,
      })
    }

    setupBrowserView(browserId, view, projectId)
  },
)

// ---------- Overscroll gesture relay (browser preload → renderer) ----------

ipcMain.on('browser:overscroll-update', (event, progress: number, direction: string | null) => {
  const browserId = webContentsIdToBrowser.get(event.sender.id)
  if (!browserId || mainWindow?.isDestroyed()) return
  mainWindow?.webContents.send('browser:overscroll', browserId, progress, direction)
})

ipcMain.on('browser:overscroll-navigate', (event, direction: string) => {
  const browserId = webContentsIdToBrowser.get(event.sender.id)
  if (!browserId) return
  if (direction === 'back') {
    browserGoBack(browserId)
  } else if (direction === 'forward') {
    browserGoForward(browserId)
  }
})

ipcMain.on(
  'browser:canvas-wheel',
  (
    event,
    gesture: {
      deltaX: number
      deltaY: number
      clientX: number
      clientY: number
      ctrlKey: boolean
      metaKey: boolean
      shiftKey: boolean
    },
  ) => {
    const browserId = webContentsIdToBrowser.get(event.sender.id)
    if (!browserId || mainWindow?.isDestroyed()) return
    mainWindow?.webContents.send('browser:canvas-wheel', browserId, gesture)
  },
)

// Get navigation history for all active browser views (for persist)
ipcMain.handle('browser:get-all-history', () => {
  const result: Record<
    string,
    { entries: Array<{ url: string; title: string }>; activeIndex: number }
  > = {}
  for (const [id, view] of browserViews) {
    try {
      const nav = view.webContents.navigationHistory
      const count = nav.length()
      const entries: Array<{ url: string; title: string }> = []
      for (let i = 0; i < count; i++) {
        const entry = nav.getEntryAtIndex(i)
        if (entry) entries.push({ url: entry.url, title: entry.title })
      }
      result[id] = { entries, activeIndex: nav.getActiveIndex() }
    } catch {}
  }
  return result
})

ipcMain.handle('browser:get-history', (_event, browserId: string) => {
  const view = browserViews.get(browserId)
  if (!view) return null
  try {
    const nav = view.webContents.navigationHistory
    const count = nav.length()
    const entries: Array<{ url: string; title: string }> = []
    for (let i = 0; i < count; i++) {
      const entry = nav.getEntryAtIndex(i)
      if (entry) entries.push({ url: entry.url, title: entry.title })
    }
    return { entries, activeIndex: nav.getActiveIndex() }
  } catch {
    return null
  }
})

ipcMain.handle('browser:get-state', async (_event, browserId: string) => {
  const view = browserViews.get(browserId)
  if (!view) return null
  const runtime = getBrowserViewState(browserId)

  let themeColor = runtime.themeColor
  if (!runtime.loading && themeColor === null) {
    try {
      const color = await view.webContents.executeJavaScript(
        `(function() {
          var meta = document.querySelector('meta[name="theme-color"]');
          return meta ? meta.getAttribute('content') : null;
        })()`,
      )
      themeColor = typeof color === 'string' && color.length > 0 ? color : null
      runtime.themeColor = themeColor
    } catch {}
  }

  try {
    const saved = savedHistories.get(browserId)
    const nativeBack = view.webContents.navigationHistory.canGoBack()
    const nativeFwd = view.webContents.navigationHistory.canGoForward()
    return {
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      canGoBack: nativeBack || (saved ? saved.activeIndex > 0 : false),
      canGoForward: nativeFwd || (saved ? saved.activeIndex < saved.entries.length - 1 : false),
      isLoading: runtime.loading,
      themeColor,
      faviconUrl: runtime.faviconUrl,
      failure: runtime.failure,
    }
  } catch {
    return null
  }
})

// Park: hide the view but keep it alive (for project switching)
ipcMain.handle('browser:park', (_event, browserId: string) => {
  const view = browserViews.get(browserId)
  if (!view) return
  const state = getBrowserViewState(browserId)
  state.parked = true
  state.visible = false
  detachBrowserView(browserId, view)
})

// Destroy: permanently remove the view
ipcMain.handle('browser:destroy', (_event, browserId: string) => {
  const view = browserViews.get(browserId)
  if (!view) return
  detachBrowserView(browserId, view)
  try {
    ;(view.webContents as any).close?.()
  } catch {}
  webContentsIdToBrowser.delete(view.webContents.id)
  browserViews.delete(browserId)
  browserIdToProject.delete(browserId)
  savedHistories.delete(browserId)
  browserViewStates.delete(browserId)
  clearBrowserConsoleLogs(browserId)
  clearBrowserNetworkRequests(browserId)
})

ipcMain.handle(
  'browser:navigate',
  (_event, browserId: string, url: string, searchEngineUrl?: string) => {
    const view = browserViews.get(browserId)
    if (!view) return
    // Auto-add protocol if missing
    let finalUrl = url
    if (
      !/^(https?:\/\/|about:|file:\/\/|chrome-extension:\/\/)/i.test(finalUrl) &&
      !finalUrl.startsWith('data:')
    ) {
      const hostLike = /^[^\s]+\.[^\s]+$/.test(finalUrl)
      const localhostLike = /^(localhost|\[::1\]|127(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i.test(
        finalUrl,
      )
      const ipv4Like = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#].*)?$/.test(finalUrl)
      const localNetworkLike =
        /^(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2}(?::\d+)?(?:[/?#].*)?$/.test(
          finalUrl,
        )
      if ((hostLike || localhostLike || ipv4Like) && !finalUrl.includes(' ')) {
        const scheme = localhostLike || ipv4Like || localNetworkLike ? 'http://' : 'https://'
        finalUrl = `${scheme}${finalUrl}`
      } else {
        const engine = searchEngineUrl || 'https://www.google.com/search?q=%s'
        finalUrl = engine.replace('%s', encodeURIComponent(finalUrl))
      }
    }
    resetBrowserViewFailure(browserId)
    view.webContents.loadURL(finalUrl)
  },
)

function browserGoBack(browserId: string) {
  const view = browserViews.get(browserId)
  if (!view) return
  if (view.webContents.navigationHistory.canGoBack()) {
    view.webContents.navigationHistory.goBack()
  } else {
    const saved = savedHistories.get(browserId)
    if (saved && saved.activeIndex > 0) {
      saved.activeIndex--
      saved.navigatingFromSaved = true
      view.webContents.loadURL(saved.entries[saved.activeIndex].url)
    }
  }
}

function browserGoForward(browserId: string) {
  const view = browserViews.get(browserId)
  if (!view) return
  if (view.webContents.navigationHistory.canGoForward()) {
    view.webContents.navigationHistory.goForward()
  } else {
    const saved = savedHistories.get(browserId)
    if (saved && saved.activeIndex < saved.entries.length - 1) {
      saved.activeIndex++
      saved.navigatingFromSaved = true
      view.webContents.loadURL(saved.entries[saved.activeIndex].url)
    }
  }
}

ipcMain.on('browser:go-back', (_event, browserId: string) => {
  browserGoBack(browserId)
})

ipcMain.on('browser:go-forward', (_event, browserId: string) => {
  browserGoForward(browserId)
})

ipcMain.on('browser:reload', (_event, browserId: string) => {
  browserViews.get(browserId)?.webContents.reload()
})

ipcMain.on('browser:focus', (_event, browserId: string) => {
  browserViews.get(browserId)?.webContents.focus()
})

ipcMain.on('browser:set-zoom-factor', (_event, browserId: string, factor: number) => {
  const view = browserViews.get(browserId)
  if (!view) return
  view.webContents.setZoomFactor(factor)
})

ipcMain.on(
  'browser:update-bounds',
  (_event, browserId: string, bounds: { x: number; y: number; width: number; height: number }) => {
    const view = browserViews.get(browserId)
    if (!view) return
    // Clamp to non-negative and integer values
    view.setBounds({
      x: Math.round(Math.max(0, bounds.x)),
      y: Math.round(Math.max(0, bounds.y)),
      width: Math.round(Math.max(0, bounds.width)),
      height: Math.round(Math.max(0, bounds.height)),
    })
  },
)

ipcMain.on('browser:set-visible', (_event, browserId: string, visible: boolean) => {
  const view = browserViews.get(browserId)
  if (!view || !mainWindow) return
  const state = getBrowserViewState(browserId)
  state.visible = visible
  if (state.parked) {
    if (!visible) detachBrowserView(browserId, view)
    return
  }
  if (visible) attachBrowserView(browserId, view)
  else detachBrowserView(browserId, view)
})

ipcMain.on('browser:toggle-devtools', (_event, browserId: string) => {
  const view = browserViews.get(browserId)
  if (!view) return
  if (view.webContents.isDevToolsOpened()) {
    view.webContents.closeDevTools()
  } else {
    view.webContents.openDevTools({ mode: 'detach' })
  }
})

// ---------- Extension management ----------

let extensionPopupWindow: BrowserWindow | null = null

ipcMain.handle('extensions:install', async (_event, input: string) => {
  return await installExtension(input)
})

ipcMain.handle('extensions:uninstall', (_event, extensionId: string) => {
  uninstallExtension(extensionId)
})

ipcMain.handle('extensions:list', () => {
  return readExtensionsMeta()
})

ipcMain.handle(
  'extensions:set-enabled',
  async (_event, projectId: string, extensionId: string, enabled: boolean) => {
    setExtensionEnabled(projectId, extensionId, enabled)

    // Live-update the session
    if (enabled) {
      await loadExtensionIntoSession(projectId, extensionId)
    } else {
      unloadExtensionFromSession(projectId, extensionId)
    }
  },
)

ipcMain.handle(
  'extensions:show-popup',
  async (
    _event,
    extensionId: string,
    projectId: string,
    _bounds: { x: number; y: number; width: number; height: number },
  ) => {
    // Ensure extensions are loaded into the session before resolving the popup URL
    await ensureExtensionsLoaded(projectId)

    const popupUrl = getExtensionPopupUrl(extensionId, projectId)
    if (!popupUrl) return

    // Close existing popup window
    if (extensionPopupWindow && !extensionPopupWindow.isDestroyed()) {
      extensionPopupWindow.close()
    }

    // IMPORTANT: Use the actual session object, not partition string.
    // Using the session object ensures the BrowserWindow shares the exact
    // session where extensions were loaded via loadExtension().
    const partition = `persist:browser-${projectId}`
    const ses = session.fromPartition(partition)

    extensionPopupWindow = new BrowserWindow({
      width: 400,
      height: 550,
      show: false,
      titleBarStyle: 'hiddenInset',
      parent: mainWindow ?? undefined,
      movable: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      roundedCorners: true,
      webPreferences: {
        session: ses,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    extensionPopupWindow.on('closed', () => {
      extensionPopupWindow = null
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('extensions:popup-closed')
      }
    })

    try {
      await extensionPopupWindow.webContents.loadURL(popupUrl)
      if (!extensionPopupWindow.isDestroyed()) extensionPopupWindow.show()
    } catch (e) {
      console.error('[extensions] Failed to load popup:', e)
      if (extensionPopupWindow && !extensionPopupWindow.isDestroyed()) {
        extensionPopupWindow.destroy()
      }
      extensionPopupWindow = null
    }
  },
)

ipcMain.handle('extensions:hide-popup', () => {
  if (extensionPopupWindow && !extensionPopupWindow.isDestroyed()) {
    extensionPopupWindow.close()
  }
  extensionPopupWindow = null
})

function cleanupBrowserViews() {
  for (const [browserId, view] of browserViews) {
    try {
      detachBrowserView(browserId, view)
      ;(view.webContents as any).close?.()
    } catch {}
  }
  browserViews.clear()
}

// ---------- Auto-updater ----------

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = false

function isAutoUpdateEnabled(): boolean {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
      return state.autoUpdate !== false
    }
  } catch {}
  return true
}

type UpdaterSupport = {
  enabled: boolean
  reason?: string
  message?: string
}

let cachedUpdaterSupport: UpdaterSupport | null = null
// Parsed from release notes for the downloaded update. Releases that change
// the daemon protocol must publish a line like `Cells-Daemon-Compat: 2` so
// the client can detect the mismatch and warn before installing. When the
// marker is absent, the release is assumed to be daemon-compatible — the vast
// majority of releases don't touch the daemon protocol.
let pendingUpdateDaemonCompatVersion: number | null = null

function extractReleaseNotesText(releaseNotes: unknown): string {
  if (!releaseNotes) return ''
  if (typeof releaseNotes === 'string') return releaseNotes
  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((note) => {
        if (typeof note === 'string') return note
        if (note && typeof note === 'object' && 'note' in note) {
          return String((note as { note?: unknown }).note ?? '')
        }
        return ''
      })
      .join('\n')
  }
  return String(releaseNotes)
}

function parsePendingUpdateDaemonCompatVersion(releaseNotes: unknown): number | null {
  const text = extractReleaseNotesText(releaseNotes)
  const match = text.match(/cells[-\s]?daemon[-\s]?compat\s*:\s*(\d+)/i)
  return match ? Number.parseInt(match[1], 10) : null
}

async function getUpdateInstallImpact() {
  if (!useDaemon || !daemonClient?.isConnected()) {
    return { sessionCount: 0, requiresDaemonRestart: false, compatibilityKnown: true }
  }

  const [daemonVersion, termIds] = await Promise.all([
    daemonClient.getDaemonVersion().catch(() => null),
    daemonClient.list().catch(() => []),
  ])
  const sessionCount = termIds.length
  if (sessionCount === 0) {
    return { sessionCount, requiresDaemonRestart: false, compatibilityKnown: true }
  }

  if (!daemonVersion) {
    return { sessionCount, requiresDaemonRestart: true, compatibilityKnown: false }
  }

  if (pendingUpdateDaemonCompatVersion == null) {
    return { sessionCount, requiresDaemonRestart: false, compatibilityKnown: true }
  }

  return {
    sessionCount,
    requiresDaemonRestart:
      (daemonVersion.compatVersion ?? null) !== pendingUpdateDaemonCompatVersion,
    compatibilityKnown: true,
  }
}

function resolveUpdaterSupport(): UpdaterSupport {
  if (!app.isPackaged) {
    return {
      enabled: false,
      reason: 'development-build',
      message: 'Auto-update is only available in packaged releases.',
    }
  }

  if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
    return {
      enabled: false,
      reason: 'missing-feed-config',
      message: 'Auto-update metadata is missing from this build.',
    }
  }

  if (process.platform === 'darwin') {
    const result = spawnSync('codesign', ['-dv', process.execPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    if (/Signature=adhoc/i.test(output) || /TeamIdentifier=not set/i.test(output)) {
      return {
        enabled: false,
        reason: 'unsigned-macos-build',
        message:
          'Auto-update requires a signed and notarized macOS build. Download new releases manually for now.',
      }
    }
  }

  return { enabled: true }
}

function getUpdaterSupport() {
  if (!cachedUpdaterSupport) {
    cachedUpdaterSupport = resolveUpdaterSupport()
  }
  return cachedUpdaterSupport
}

function shouldEnableAutoUpdates() {
  return getUpdaterSupport().enabled
}

function sendUpdateStatus(status: string, info?: any) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', status, info)
    }
  } catch {}
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'))
autoUpdater.on('update-available', (info) => {
  pendingUpdateDaemonCompatVersion = parsePendingUpdateDaemonCompatVersion(info.releaseNotes)
  sendUpdateStatus('available', {
    version: info.version,
    releaseNotes: info.releaseNotes,
    releaseDate: info.releaseDate,
    daemonCompatVersion: pendingUpdateDaemonCompatVersion,
  })
})
autoUpdater.on('update-not-available', () => {
  pendingUpdateDaemonCompatVersion = null
  sendUpdateStatus('up-to-date')
})
autoUpdater.on('download-progress', (progress) =>
  sendUpdateStatus('downloading', {
    percent: Math.round(progress.percent),
  }),
)
autoUpdater.on('update-downloaded', (info) =>
  sendUpdateStatus('ready', {
    version: info.version,
    daemonCompatVersion: pendingUpdateDaemonCompatVersion,
  }),
)
autoUpdater.on('error', (err) => {
  pendingUpdateDaemonCompatVersion = null
  sendUpdateStatus('error', {
    message: err.message,
  })
})

function checkForAppUpdates() {
  if (!shouldEnableAutoUpdates()) return
  autoUpdater.checkForUpdates().catch((err) =>
    sendUpdateStatus('error', {
      message: err.message,
    }),
  )
}

let autoUpdateInitialTimer: ReturnType<typeof setTimeout> | null = null
let autoUpdateRecurringTimer: ReturnType<typeof setInterval> | null = null

function stopAutomaticUpdateChecks() {
  if (autoUpdateInitialTimer) {
    clearTimeout(autoUpdateInitialTimer)
    autoUpdateInitialTimer = null
  }
  if (autoUpdateRecurringTimer) {
    clearInterval(autoUpdateRecurringTimer)
    autoUpdateRecurringTimer = null
  }
}

function scheduleAutomaticUpdateChecks() {
  stopAutomaticUpdateChecks()
  if (!shouldEnableAutoUpdates()) return
  if (!isAutoUpdateEnabled()) return

  autoUpdateInitialTimer = setTimeout(() => {
    autoUpdateInitialTimer = null
    checkForAppUpdates()
    autoUpdateRecurringTimer = setInterval(checkForAppUpdates, AUTO_UPDATE_CHECK_INTERVAL)
  }, AUTO_UPDATE_CHECK_DELAY)
}

ipcMain.handle('updater:check', () => {
  if (!shouldEnableAutoUpdates()) {
    sendUpdateStatus('unsupported', getUpdaterSupport())
    return
  }
  checkForAppUpdates()
})

ipcMain.handle('updater:download', () => {
  if (!shouldEnableAutoUpdates()) return
  autoUpdater.downloadUpdate().catch(() => {})
})

ipcMain.handle('updater:install', () => {
  if (!shouldEnableAutoUpdates()) return
  return (async () => {
    const impact = await getUpdateInstallImpact()
    if (impact.requiresDaemonRestart && impact.sessionCount > 0) {
      const messageBoxOptions = {
        type: 'warning' as const,
        buttons: ['Cancel', 'Install update'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
        message: 'Install update now?',
        detail: impact.compatibilityKnown
          ? `This update requires a PTY daemon restart and will kill ${impact.sessionCount} running process${impact.sessionCount === 1 ? '' : 'es'} managed by Cells.`
          : `Cells could not verify whether this update is daemon-compatible. Installing now may restart the PTY daemon and kill ${impact.sessionCount} running process${impact.sessionCount === 1 ? '' : 'es'} managed by Cells.`,
      }
      const result =
        mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showMessageBox(mainWindow, messageBoxOptions)
          : await dialog.showMessageBox(messageBoxOptions)

      if (result.response !== 1) {
        return false
      }
    }

    const cliResults = await updateAgentClisForCellsUpdate((progress) => {
      if (progress.phase === 'agent-started') {
        sendUpdateStatus('agent-cli-updating', { agent: progress.agent })
        return
      }
      if (progress.phase === 'agent-finished') {
        sendUpdateStatus('agent-cli-updated', { result: progress.result })
        return
      }
      if (progress.phase === 'finished') {
        sendUpdateStatus('agent-cli-complete', { results: progress.results })
      }
    })
    const failedCliUpdates = cliResults.filter((result) => result.status === 'failed')
    if (failedCliUpdates.length > 0) {
      console.warn('[updater] agent CLI update failures', failedCliUpdates)
    }
    sendUpdateStatus('installing', { agentCliUpdates: cliResults })
    autoUpdater.quitAndInstall()
    return true
  })()
})

ipcMain.handle('updater:get-version', () => {
  return app.getVersion()
})

ipcMain.handle('updater:get-support', () => {
  return getUpdaterSupport()
})

ipcMain.handle('updater:set-auto-update', (_event, enabled: boolean) => {
  // The renderer persists this in state.json via the store.
  if (enabled && shouldEnableAutoUpdates()) {
    checkForAppUpdates()
    scheduleAutomaticUpdateChecks()
  } else {
    stopAutomaticUpdateChecks()
  }
})

// ---------- Daemon management IPC ----------

ipcMain.handle('daemon:get-status', async () => {
  const connected = useDaemon && (daemonClient?.isConnected() ?? false)
  let daemonVersion: PtyDaemonVersionInfo | null = null
  let sessionCount = 0
  if (connected && daemonClient) {
    ;[daemonVersion, sessionCount] = await Promise.all([
      daemonClient.getDaemonVersion().catch(() => null),
      daemonClient
        .list()
        .then((ids) => ids.length)
        .catch(() => 0),
    ])
  }
  const currentElectronVersion = process.versions.electron ?? null
  const currentNodeAbi = process.versions.modules
  const restartReason = connected
    ? getDaemonRestartReason(daemonVersion, currentNodeAbi, selectedTerminalBackend)
    : null
  return {
    enabled: useDaemon,
    connected,
    sessionCount,
    appVersion: app.getVersion(),
    currentElectronVersion,
    currentNodeAbi,
    restartRecommended: restartReason !== null,
    restartReason,
    daemonVersion,
    backendDetails: daemonVersion?.backendDetails ?? null,
  }
})

ipcMain.handle('daemon:list-sessions', async () => {
  if (!useDaemon || !daemonClient?.isConnected()) return []
  try {
    const termIds = await daemonClient.list()
    const sessions = await Promise.all(
      termIds.map(async (termId) => {
        const [processInfo, runtimeStatus] = await Promise.all([
          daemonClient!.getProcessInfo(termId).catch(() => null),
          Promise.resolve(agentSessionTracker?.getStatus(termId) ?? null),
        ])
        return {
          termId,
          processInfo,
          runtimeStatus,
          subscribed: isTerminalSubscribed(termId),
        }
      }),
    )
    return sessions
  } catch {
    return []
  }
})

ipcMain.handle('daemon:kill-session', async (_event, termId: string) => {
  if (!useDaemon || !daemonClient?.isConnected()) return
  pendingTerminalExitDetails.set(termId, await captureTerminalExitDetails(termId, 'killed'))
  await daemonClient.kill(termId).catch(() => {})
  if (pendingTerminalExitDetails.has(termId)) {
    forwardTerminalExit(termId)
  }
})

ipcMain.handle('daemon:kill-all', async () => {
  if (!useDaemon || !daemonClient?.isConnected()) return
  try {
    const termIds = await daemonClient.list()
    await primeTerminalExitDetails(termIds, 'killed')
    await Promise.all(termIds.map((id) => daemonClient!.kill(id).catch(() => {})))
    for (const termId of termIds) {
      if (pendingTerminalExitDetails.has(termId)) {
        forwardTerminalExit(termId)
      }
    }
  } catch {}
})

ipcMain.handle('daemon:restart', async () => {
  daemonRestartInProgress = true
  useDaemon = false
  try {
    if (daemonClient?.isConnected()) {
      try {
        await daemonClient.shutdown()
      } catch {}
      daemonClient.disconnect()
    }

    const daemonScript = path.join(__dirname, 'pty-daemon.js')
    refreshTerminalBackendSelection()
    useDaemon = terminalBackendSupport.ok
      ? await ensureDaemon(
          STATE_DIR,
          app.getVersion(),
          process.execPath,
          daemonScript,
          selectedTerminalBackend,
        )
      : false

    if (useDaemon) {
      await connectDaemonClient()
    } else if (terminalBackendSupport.ok) {
      ensureFallbackSessions()
    }

    setTimeout(() => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload()
        }
        for (const win of pinnedWindows.values()) {
          if (!win.isDestroyed()) {
            win.webContents.reload()
          }
        }
      } catch {}
    }, 50)

    return useDaemon
  } finally {
    daemonRestartInProgress = false
  }
})

// ---------- App lifecycle ----------

app.whenReady().then(async () => {
  if (isPerfMonitorEnabled) {
    perfMonitor = new PerfMonitor(app.getPath('logs'))
    perfMonitor.start()
  }

  if (shouldRelaunchAfterEarlyCacheClear) {
    stopCellsOwnedBackgroundProcesses()
    clearRendererCaches()
    if (shouldClearCachesForVersion) {
      markRendererCachesVersionHandled()
    }
    app.relaunch()
    app.exit(0)
    return
  }

  // Start PTY daemon before creating windows
  try {
    console.log('Starting PTY daemon...')
    refreshTerminalBackendSelection()
    if (terminalBackendSupport.ok) {
      const daemonScript = path.join(__dirname, 'pty-daemon.js')
      useDaemon = await ensureDaemon(
        STATE_DIR,
        app.getVersion(),
        process.execPath,
        daemonScript,
        selectedTerminalBackend,
      )
      console.log('PTY daemon result:', useDaemon)
      if (useDaemon) {
        await connectDaemonClient()
      } else {
        ensureFallbackSessions()
      }
    } else {
      useDaemon = false
      console.warn('Skipping PTY daemon startup:', describeSelectedBackendRequirement())
    }
  } catch (err) {
    console.error('PTY daemon setup failed:', err)
    useDaemon = false
    if (terminalBackendSupport.ok) {
      ensureFallbackSessions()
    }
  }

  agentSessionTracker = new EnhancedSessionTracker()
  agentSessionTracker.subscribe(broadcastTerminalStatus)

  // Set dock icon on macOS (for dev; production uses the bundled .icns)
  if (process.platform === 'darwin') {
    const iconPath = path.join(__dirname, '../resources/icon.png')
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(iconPath))
    }
  }

  if (process.platform === 'darwin') {
    const appName = 'Cells'
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: appName,
          submenu: [
            { role: 'about', label: `About ${appName}` },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            {
              label: `Hide ${appName}`,
              click: () => app.hide(),
            },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            {
              label: `Quit ${appName}`,
              accelerator: 'CmdOrCtrl+Q',
              click: () => {
                void confirmAndQuitApp()
              },
            },
          ],
        },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: 'Window',
          submenu: [
            {
              label: 'Close Window',
              accelerator: 'CmdOrCtrl+W',
              click: () => {
                const focused = BrowserWindow.getFocusedWindow()
                if (focused) {
                  for (const [, win] of pinnedWindows.entries()) {
                    if (win === focused && !win.isDestroyed()) {
                      win.close()
                      return
                    }
                  }
                }
                sendShortcutToRenderer({ command: 'close-window', source: 'menu' })
              },
            },
          ],
        },
        {
          label: 'View',
          submenu: [
            { role: 'toggleDevTools' },
            { type: 'separator' },
            {
              label: 'Fit Focused Window',
              click: () => sendCanvasZoomCommand('fit'),
            },
            {
              label: 'Zoom Toward Focused Window',
              click: () => sendCanvasZoomCommand('in'),
            },
            {
              label: 'Zoom Away From Focused Window',
              click: () => sendCanvasZoomCommand('out'),
            },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
      ]),
    )
  }

  createWindow()
  if (!terminalBackendSupport.ok) {
    setTimeout(() => {
      void showTerminalBackendRequirementDialog()
    }, 300)
  }

  setTimeout(() => {
    startMcpBridge(MCP_BRIDGE_SOCKET, {
      browserViews,
      browserIdToProject,
      getDaemonClient: () => daemonClient,
      getFallbackSessions: () => fallbackSessions,
      getUseDaemon: () => useDaemon,
      getTerminalStatus: (termId: string) => agentSessionTracker?.getStatus(termId) ?? null,
      getAgentSessionSnapshot: (windowId: string) => agentSessionService.getSnapshot(windowId),
      sendAgentMessage: (windowId: string, input: string, attachments?: string[]) =>
        agentSessionService.send(windowId, input, attachments),
      getMainWindow: () => mainWindow,
      stateFile: STATE_FILE,
      subscribedTerminals,
    })
  }, 0)

  setTimeout(() => {
    void cleanupOrphanedDaemonSessions()
  }, 0)

  scheduleAutomaticUpdateChecks()
})

app.on('before-quit', () => {
  perfMonitor?.stop()
  agentSessionTracker?.stop()
  stopAutomaticUpdateChecks()
  quitConfirmed = true
  stopMcpBridge(MCP_BRIDGE_SOCKET)
  try {
    if (!mainWindow?.isDestroyed()) {
      mainWindow?.webContents.send('app:before-quit')
    }
  } catch {}
  cleanupBrowserViews()
  console.log(
    `before-quit: useDaemon=${useDaemon}, connected=${daemonClient?.isConnected()}, subscribed=[${[...terminalSubscriptionCounts.keys()].join(',')}]`,
  )
  if (useDaemon && daemonClient?.isConnected()) {
    // Unsubscribe all — daemon keeps PTYs alive and buffers output
    for (const termId of terminalSubscriptionCounts.keys()) {
      daemonClient.unsubscribe(termId)
    }
    daemonClient.disconnect()
    console.log('before-quit: disconnected from daemon, PTYs kept alive')
  } else {
    console.log(`before-quit: detaching fallback ${selectedTerminalBackend} clients`)
    fallbackSessions?.cleanup()
  }
})

app.on('window-all-closed', () => {
  cleanupBrowserViews()
  if (!useDaemon) {
    fallbackSessions?.cleanup()
  }
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
    if (!terminalBackendSupport.ok) {
      setTimeout(() => {
        void showTerminalBackendRequirementDialog()
      }, 300)
    }
  }
})
