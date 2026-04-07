import {
  app,
  BrowserWindow,
  MessageChannelMain,
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
import { PtyDaemonClient } from './pty-client'
import { ensureDaemon } from './daemon-lifecycle'
import { getDaemonRestartReason } from './pty-daemon-contract'
import { PerfMonitor, type RendererPerfReport, type TerminalPerfReport } from './perf-monitor'
import type { TerminalSessionManager } from './terminal-session-manager'
import type { ProjectsState, TerminalSessionBackend } from '../src/types'
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
  clearBrowserConsoleLogs,
  clearTerminalOutputRing,
} from './mcp-bridge'
import type { TerminalExitDetails } from '../src/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const RENDERER_CACHE_VERSION_FILE = '.renderer-cache-version'
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

const shouldIgnoreGpuBlocklist = process.env.CELLS_IGNORE_GPU_BLOCKLIST === '1'
if (shouldIgnoreGpuBlocklist) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
}

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

function clearRendererCachesOnVersionChangeEarly() {
  if (!app.isPackaged) return false

  const userDataDir = app.getPath('userData')
  const versionFile = path.join(userDataDir, RENDERER_CACHE_VERSION_FILE)
  const currentVersion = app.getVersion()
  let previousVersion: string | null = null

  try {
    previousVersion = fs.readFileSync(versionFile, 'utf8').trim() || null
  } catch {}

  if (previousVersion === currentVersion) return false

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

  try {
    fs.writeFileSync(versionFile, `${currentVersion}\n`, 'utf8')
  } catch {}

  return true
}

shouldRelaunchAfterEarlyCacheClear = clearRendererCachesOnVersionChangeEarly()

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
const PRELOAD_FILE = 'preload.mjs'
const BROWSER_PRELOAD_FILE = 'browser-preload.cjs'
let quitConfirmed = false
let quitDialogOpen = false
let selectedTerminalBackend: TerminalSessionBackend = DEFAULT_TERMINAL_SESSION_BACKEND
let terminalBackendSupport = getTerminalBackendSupportStatus(selectedTerminalBackend)

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
      return readStateFile(STATE_FILE)
    }
    if (fs.existsSync(LEGACY_STATE_FILE)) {
      const legacyState = readStateFile(LEGACY_STATE_FILE)
      fs.writeFileSync(STATE_FILE, JSON.stringify(legacyState, null, 2))
      return legacyState
    }
  } catch {}
  return null
})

ipcMain.handle('state:save', (_event, state) => {
  try {
    ensureStateDir()
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
    refreshTerminalBackendSelection(state)
  } catch (err) {
    console.error('Failed to save state:', err)
  }
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

function forwardTerminalExit(termId: string, details?: TerminalExitDetails) {
  const exitDetails = details ?? pendingTerminalExitDetails.get(termId)
  if (!details) {
    pendingTerminalExitDetails.delete(termId)
  }
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

ipcMain.handle('app:request-quit', () => {
  return confirmAndQuitApp()
})

ipcMain.handle('app:relaunch', () => {
  app.relaunch()
  quitConfirmed = true
  app.quit()
})

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

function parseWorktreeList(output: string): Array<{
  path: string
  branch: string
  isMain: boolean
  isBare: boolean
}> {
  const worktrees: Array<{
    path: string
    branch: string
    isMain: boolean
    isBare: boolean
  }> = []
  let current: { path?: string; branch?: string; bare?: boolean } = {}

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length)
    } else if (line.startsWith('HEAD ')) {
      // skip
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === 'bare') {
      current.bare = true
    } else if (line === 'detached') {
      current.branch = current.branch ?? '(detached)'
    } else if (line === '') {
      if (current.path) {
        worktrees.push({
          path: current.path,
          branch: current.branch ?? '(unknown)',
          isMain: worktrees.length === 0,
          isBare: current.bare ?? false,
        })
      }
      current = {}
    }
  }
  // Handle last entry if no trailing newline
  if (current.path) {
    worktrees.push({
      path: current.path,
      branch: current.branch ?? '(unknown)',
      isMain: worktrees.length === 0,
      isBare: current.bare ?? false,
    })
  }

  return worktrees
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
    const output = gitExec(['worktree', 'list', '--porcelain'], cwd)
    return parseWorktreeList(output)
  } catch {
    return []
  }
})

ipcMain.handle(
  'git:create-worktree',
  (_event, cwd: string, branch: string, targetDir?: string, baseBranch?: string) => {
    const repoRoot = gitExec(['rev-parse', '--show-toplevel'], cwd)
    const dest = targetDir
      ? path.join(targetDir, branch)
      : path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-${branch}`)

    try {
      // Try to create from existing branch first
      gitExec(['worktree', 'add', dest, branch], cwd)
    } catch {
      // Branch doesn't exist — create a new one from baseBranch (or HEAD)
      const args = ['worktree', 'add', '-b', branch, dest]
      if (baseBranch) args.push(baseBranch)
      gitExec(args, cwd)
    }

    // Return the new worktree info
    const output = gitExec(['worktree', 'list', '--porcelain'], cwd)
    const all = parseWorktreeList(output)
    const created = all.find((w) => w.path === dest)
    if (!created) throw new Error(`Worktree created but not found: ${dest}`)
    return created
  },
)

ipcMain.handle('git:remove-worktree', (_event, cwd: string, worktreePath: string) => {
  gitExec(['worktree', 'remove', worktreePath], cwd)
})

ipcMain.handle('agent:check-available', (_event, aliases?: Record<string, string>) => {
  // Use a login shell so the user's full PATH is available.
  // Packaged macOS apps inherit a minimal PATH (/usr/bin:/bin) that
  // won't include Homebrew, ~/.local/bin, nvm, etc.
  const shell = process.env.SHELL || '/bin/zsh'
  const results: Record<string, boolean> = {}
  for (const name of ['claude', 'codex', 'opencode', 'pi']) {
    const cmd = aliases?.[name]?.trim() || name
    const executable = (cmd.match(/^(".*?"|'.*?'|\S+)/)?.[0] ?? name).replace(/^['"]|['"]$/g, '')
    const escapedExecutable = executable.replace(/'/g, "'\\''")
    try {
      execFileSync(shell, ['-lc', `command -v -- '${escapedExecutable}'`], {
        stdio: 'pipe',
        timeout: 3000,
      })
      results[name] = true
    } catch {
      results[name] = false
    }
  }
  return results
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
  (
    _event,
    id: string,
    type: string,
    bounds: { x: number; y: number; width: number; height: number },
    browserUrl?: string,
  ) => {
    // Close any existing pinned window for this id
    const existing = pinnedWindows.get(id)
    if (existing && !existing.isDestroyed()) existing.close()

    const isBrowser = type === 'browser' && browserUrl
    const transparentWindow = isTransparentWindowModeEnabled()
    const needsWarmReload = !process.env.VITE_DEV_SERVER_URL && !isBrowser
    let warmReloadDone = !needsWarmReload

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
        ? { nodeIntegration: false, contextIsolation: true, webgl: true }
        : {
            preload: path.join(__dirname, PRELOAD_FILE),
            nodeIntegration: false,
            contextIsolation: true,
            webgl: true,
          },
    })

    pinnedWindows.set(id, win)
    let unpinNotified = false

    if (isBrowser) {
      // Browser pop-out: load the URL directly as a web page
      win.loadURL(browserUrl)
    } else {
      // Terminal pop-out: load the app renderer in pinned mode
      win.webContents.on('before-input-event', (event, input) => {
        if ((input.meta || input.control) && input.key.toLowerCase() === 'w') {
          event.preventDefault()
          if (!unpinNotified) {
            unpinNotified = true
            try {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('app:window-unpinned', id, type)
                mainWindow.focus()
              }
            } catch {}
          }
          if (!win.isDestroyed()) win.close()
        }
      })
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
      if (unpinNotified) return
      unpinNotified = true
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app:window-unpinned', id, type)
          mainWindow.focus()
        }
      } catch {}
    })

    win.on('closed', () => {
      pinnedWindows.delete(id)
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
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  })
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

ipcMain.handle('app:file-thumbnail', async (_event, filePath: string) => {
  try {
    const img = nativeImage.createFromPath(filePath)
    if (img.isEmpty()) return null
    // Resize to a small thumbnail to keep IPC payload small
    const thumb = img.resize({ height: 96 })
    return thumb.toDataURL()
  } catch {
    return null
  }
})

ipcMain.handle('app:get-terminal-font-data', () => {
  const overrideFontDir = process.env.CELLS_TERMINAL_FONT_DIR?.trim()
  const fontDir = overrideFontDir
    ? overrideFontDir
    : app.isPackaged
      ? path.join(process.resourcesPath, 'vendor', 'fonts')
      : path.join(__dirname, '..', 'src', 'fonts')

  const fonts = [
    'GeistMonoNerdFontMono-Regular.otf',
    'GeistMonoNerdFontMono-Bold.otf',
    'JetBrainsMonoNerdFontMono-Regular.ttf',
    'JetBrainsMonoNerdFontMono-Bold.ttf',
    'FiraCodeNerdFontMono-Regular.ttf',
    'FiraCodeNerdFontMono-Bold.ttf',
    'MesloLGSNerdFontMono-Regular.ttf',
    'MesloLGSNerdFontMono-Bold.ttf',
    'HackNerdFontMono-Regular.ttf',
    'HackNerdFontMono-Bold.ttf',
  ]

  return Object.fromEntries(
    fonts.map((filename) => {
      const fontPath = path.join(fontDir, filename)
      return [filename, fs.readFileSync(fontPath).toString('base64')]
    }),
  )
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

// Map browserId → the browserId so overscroll IPC from the preload can be relayed
const webContentsIdToBrowser = new Map<number, string>()
const browserIdToProject = new Map<string, string>()

function setupBrowserView(browserId: string, view: WebContentsView, projectId: string) {
  if (!mainWindow) return
  webContentsIdToBrowser.set(view.webContents.id, browserId)
  browserIdToProject.set(browserId, projectId)

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

    if (input.meta || input.control) {
      const key = input.key.toLowerCase()
      const shouldForwardShortcut =
        [
          'l',
          'r',
          'w',
          't',
          'q',
          ',',
          '[',
          ']',
          'h',
          'j',
          'k',
          'arrowleft',
          'arrowright',
          'arrowup',
          'arrowdown',
        ].includes(key) ||
        (key === 'o' && input.shift) ||
        (key === 'c' && input.shift)
      // Forward browser-level app shortcuts back to the renderer so they still work
      // while the embedded page owns keyboard focus.
      // Cmd+Shift+C is included so the renderer can copy the current URL and show
      // inline feedback in the address bar instead of letting the page consume it.
      if (shouldForwardShortcut) {
        _e.preventDefault()
        if (!mainWindow?.isDestroyed()) {
          mainWindow?.webContents.focus()
          mainWindow?.webContents.sendInputEvent({
            type: input.type as 'keyDown' | 'keyUp',
            keyCode: input.key,
            modifiers: [
              ...(input.meta ? ['meta' as const] : []),
              ...(input.control ? ['control' as const] : []),
              ...(input.shift ? ['shift' as const] : []),
            ],
          })
        }
      }
    }
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
    try {
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('browser:loading', browserId, true)
      }
    } catch {}
  })
  view.webContents.on('did-stop-loading', () => {
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
        try {
          if (color && !mainWindow?.isDestroyed()) {
            mainWindow?.webContents.send('browser:theme-color', browserId, color)
          }
        } catch {}
      })
      .catch(() => {})
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
    try {
      if (favicons.length > 0 && !mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('browser:favicon-updated', browserId, favicons[0])
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
      try {
        mainWindow.contentView.addChildView(existing)
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

    mainWindow.contentView.addChildView(view)
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

// Park: hide the view but keep it alive (for project switching)
ipcMain.handle('browser:park', (_event, browserId: string) => {
  const view = browserViews.get(browserId)
  if (!view) return
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(view)
    }
  } catch {}
})

// Destroy: permanently remove the view
ipcMain.handle('browser:destroy', (_event, browserId: string) => {
  const view = browserViews.get(browserId)
  if (!view) return
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(view)
    }
    ;(view.webContents as any).close?.()
  } catch {}
  webContentsIdToBrowser.delete(view.webContents.id)
  browserViews.delete(browserId)
  savedHistories.delete(browserId)
  clearBrowserConsoleLogs(browserId)
})

ipcMain.handle(
  'browser:navigate',
  (_event, browserId: string, url: string, searchEngineUrl?: string) => {
    const view = browserViews.get(browserId)
    if (!view) return
    // Auto-add protocol if missing
    let finalUrl = url
    if (!/^https?:\/\//i.test(finalUrl) && !finalUrl.startsWith('about:')) {
      if (finalUrl.includes('.') && !finalUrl.includes(' ')) {
        finalUrl = 'https://' + finalUrl
      } else {
        const engine = searchEngineUrl || 'https://www.google.com/search?q=%s'
        finalUrl = engine.replace('%s', encodeURIComponent(finalUrl))
      }
    }
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
  if (visible) {
    // Re-add if not already a child
    try {
      mainWindow.contentView.addChildView(view)
    } catch {}
  } else {
    try {
      mainWindow.contentView.removeChildView(view)
    } catch {}
  }
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
  for (const [, view] of browserViews) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.contentView.removeChildView(view)
      }
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
// Parsed from release notes for the downloaded update. Publish a line like
// `Cells-Daemon-Compat: 2` when a release should preserve daemon sessions.
// Missing metadata is treated as "unknown", which means install will warn if
// there are live daemon-managed processes.
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

  if (!daemonVersion || pendingUpdateDaemonCompatVersion == null) {
    return { sessionCount, requiresDaemonRestart: true, compatibilityKnown: false }
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

function scheduleAutomaticUpdateChecks() {
  if (!shouldEnableAutoUpdates()) return
  if (!isAutoUpdateEnabled()) return

  setTimeout(() => {
    checkForAppUpdates()
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
  // If disabling, we don't need to do anything else since auto-check only runs on launch.
  // If enabling, trigger a check now so the user gets immediate feedback.
  if (enabled && shouldEnableAutoUpdates()) {
    checkForAppUpdates()
  }
})

// ---------- Daemon management IPC ----------

ipcMain.handle('daemon:get-status', async () => {
  const connected = useDaemon && (daemonClient?.isConnected() ?? false)
  let daemonVersion: {
    protocolVersion: number
    backend?: 'tmux' | 'zellij' | null
    appVersion: string | null
    electronVersion: string | null
    nodeAbi: string | null
    pid: number
    uptime: number
  } | null = null
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
  }
})

ipcMain.handle('daemon:list-sessions', async () => {
  if (!useDaemon || !daemonClient?.isConnected()) return []
  try {
    const termIds = await daemonClient.list()
    const sessions = await Promise.all(
      termIds.map(async (termId) => {
        const processInfo = await daemonClient!.getProcessInfo(termId).catch(() => null)
        return {
          termId,
          processInfo,
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
  perfMonitor = new PerfMonitor(app.getPath('logs'))
  perfMonitor.start()

  if (shouldRelaunchAfterEarlyCacheClear) {
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
            { role: 'hide', label: `Hide ${appName}` },
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
                  for (const [id, win] of pinnedWindows.entries()) {
                    if (win === focused && !win.isDestroyed()) {
                      mainWindow?.webContents.send('app:window-unpinned', id, 'terminal')
                      mainWindow?.focus()
                      win.close()
                      return
                    }
                  }
                }
                mainWindow?.webContents.send('app:close-terminal')
              },
            },
          ],
        },
        {
          label: 'View',
          submenu: [
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
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
