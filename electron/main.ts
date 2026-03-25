import { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu, nativeImage } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import os from 'os'
import { execFileSync, spawnSync } from 'child_process'
import { autoUpdater } from 'electron-updater'
import { PtyManager } from './pty'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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

configureDevPaths()

// Enable elastic overscroll (rubber-band bounce) like native Chrome on macOS
app.commandLine.appendSwitch('enable-features', 'ElasticOverscroll')

const ptys = new PtyManager()
let mainWindow: BrowserWindow | null = null

// Per-terminal session isolation:
// - "subscribed" = renderer component mounted → data forwarded live via IPC
// - "unsubscribed" = other project → data buffered silently
// - On re-attach: buffer replayed then cleared, live forwarding resumes
const MAX_BUFFER = 64 * 1024
const ptyBuffers = new Map<string, string>()
const subscribedTerminals = new Set<string>()

const STATE_DIR = path.join(app.getPath('home'), '.cells')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const LEGACY_STATE_DIR = path.join(app.getPath('home'), '.vector-ghost')
const LEGACY_STATE_FILE = path.join(LEGACY_STATE_DIR, 'state.json')
const AUTO_UPDATE_CHECK_DELAY = 15_000
const AUTO_UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000
let updateCheckInterval: ReturnType<typeof setInterval> | null = null
const PRELOAD_FILE = 'preload.mjs'
const BROWSER_PRELOAD_FILE = 'browser-preload.cjs'
const CODEX_HOME_DIR = path.join(os.homedir(), '.codex')
const CODEX_LOGS_DB = path.join(CODEX_HOME_DIR, 'logs_1.sqlite')
const CODEX_STATE_DB = path.join(CODEX_HOME_DIR, 'state_5.sqlite')

function readSqliteValue(dbPath: string, query: string) {
  if (!fs.existsSync(dbPath)) return null
  try {
    const value = execFileSync('sqlite3', [dbPath, query], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim()
    return value || null
  } catch {
    return null
  }
}

function readProcessTable() {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
        if (!match) return null
        return {
          pid: Number.parseInt(match[1], 10),
          ppid: Number.parseInt(match[2], 10),
          command: match[3],
        }
      })
      .filter((entry): entry is { pid: number; ppid: number; command: string } => !!entry)
  } catch {
    return []
  }
}

function isCodexCommand(command: string) {
  const normalized = command.toLowerCase().split('/').pop() ?? command.toLowerCase()
  return normalized === 'codex' || normalized === 'codex-cli' || normalized.startsWith('codex-')
}

function resolveCodexProcessPid(shellPid: number) {
  if (!Number.isInteger(shellPid) || shellPid <= 0) return null

  const processTable = readProcessTable()
  if (processTable.length === 0) return null

  const childrenByParent = new Map<number, Array<{ pid: number; ppid: number; command: string }>>()
  for (const process of processTable) {
    const siblings = childrenByParent.get(process.ppid) ?? []
    siblings.push(process)
    childrenByParent.set(process.ppid, siblings)
  }

  const queue = [...(childrenByParent.get(shellPid) ?? [])]
  let bestMatch: { pid: number; ppid: number; command: string } | null = null

  while (queue.length > 0) {
    const current = queue.shift()!
    if (isCodexCommand(current.command)) {
      bestMatch = current
    }
    const children = childrenByParent.get(current.pid)
    if (children) queue.push(...children)
  }

  return bestMatch?.pid ?? null
}

function resolveCodexThreadId(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  return readSqliteValue(
    CODEX_LOGS_DB,
    `select thread_id from logs where process_uuid like 'pid:${pid}:%' and thread_id is not null order by ts desc, ts_nanos desc, id desc limit 1;`,
  )
}

function resolveCodexThreadTitle(pid: number) {
  const threadId = resolveCodexThreadId(pid)
  if (!threadId || !/^[A-Za-z0-9-]+$/.test(threadId)) return null
  return readSqliteValue(
    CODEX_STATE_DB,
    `select title from threads where id = '${threadId}' limit 1;`,
  )
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false, // Don't show until ready — avoids GPU race on launch
    transparent: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
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

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
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
  } catch (err) {
    console.error('Failed to save state:', err)
  }
})

// ---------- Terminal IPC ----------

function appendBuffer(termId: string, data: string) {
  const existing = ptyBuffers.get(termId) ?? ''
  const combined = existing + data
  ptyBuffers.set(termId, combined.length > MAX_BUFFER ? combined.slice(-MAX_BUFFER) : combined)
}

function setupPtyHandlers(termId: string, p: ReturnType<typeof ptys.spawn>) {
  p.onData((data) => {
    if (ptys.get(termId) !== p) return
    if (subscribedTerminals.has(termId)) {
      // Live forwarding — terminal component is mounted
      try {
        if (!mainWindow?.isDestroyed()) {
          mainWindow?.webContents.send('terminal:data', termId, data)
        }
      } catch {
        ptys.kill(termId)
      }
    } else {
      // Buffer silently — terminal is in another project
      appendBuffer(termId, data)
    }
  })

  p.onExit(() => {
    if (ptys.get(termId) !== p) return
    ptys.kill(termId)
    ptyBuffers.delete(termId)
    subscribedTerminals.delete(termId)
    try {
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send('terminal:exit', termId)
      }
    } catch {}
  })
}

ipcMain.handle(
  'terminal:attach',
  (_event, termId: string, cols: number, rows: number, cwd?: string) => {
    const existing = ptys.get(termId)
    if (existing) {
      // Grab buffer BEFORE subscribing so no data is lost or duplicated
      const buffer = ptyBuffers.get(termId) ?? ''
      ptyBuffers.delete(termId)
      subscribedTerminals.add(termId)
      // Resize triggers SIGWINCH — interactive programs redraw
      try {
        existing.resize(cols, rows)
      } catch {}
      return { reattached: true, buffer }
    }

    subscribedTerminals.add(termId)
    ptyBuffers.delete(termId)
    const p = ptys.spawn(termId, cols, rows, cwd)
    setupPtyHandlers(termId, p)

    return { reattached: false, buffer: '' }
  },
)

// Unsubscribe: stop live IPC forwarding, start buffering
ipcMain.handle('terminal:unsubscribe', (_event, termId: string) => {
  subscribedTerminals.delete(termId)
  ptyBuffers.set(termId, '')
})

ipcMain.handle('terminal:detach', (_event, termId: string) => {
  ptys.kill(termId)
  ptyBuffers.delete(termId)
  subscribedTerminals.delete(termId)
})

ipcMain.handle('terminal:get-process', (_event, termId: string) => {
  try {
    return ptys.get(termId)?.process ?? null
  } catch {
    return null
  }
})

ipcMain.handle('terminal:get-codex-title', (_event, termId: string) => {
  try {
    const shellPid = ptys.get(termId)?.pid ?? null
    const codexPid = shellPid ? resolveCodexProcessPid(shellPid) : null
    return codexPid ? resolveCodexThreadTitle(codexPid) : null
  } catch {
    return null
  }
})

ipcMain.handle('agent:check-available', () => {
  // Use a login shell so the user's full PATH is available.
  // Packaged macOS apps inherit a minimal PATH (/usr/bin:/bin) that
  // won't include Homebrew, ~/.local/bin, nvm, etc.
  const shell = process.env.SHELL || '/bin/zsh'
  const results: Record<string, boolean> = {}
  for (const name of ['claude', 'codex']) {
    try {
      execFileSync(shell, ['-lc', `which ${name}`], { stdio: 'pipe', timeout: 3000 })
      results[name] = true
    } catch {
      results[name] = false
    }
  }
  return results
})

ipcMain.handle('app:toggle-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow?.maximize()
  }
})

ipcMain.handle('app:pick-folder', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
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

ipcMain.on('terminal:write', (_event, termId: string, data: string) => {
  if (ptys.has(termId)) {
    ptys.write(termId, data)
  }
})

ipcMain.on('terminal:resize', (_event, termId: string, cols: number, rows: number) => {
  if (ptys.has(termId)) {
    ptys.resize(termId, cols, rows)
  }
})

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

function setupBrowserView(browserId: string, view: WebContentsView) {
  if (!mainWindow) return
  webContentsIdToBrowser.set(view.webContents.id, browserId)

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

    if (input.meta || input.control) {
      const key = input.key.toLowerCase()
      const shouldForwardShortcut =
        [
          'l',
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
}

ipcMain.handle(
  'browser:create',
  (
    _event,
    browserId: string,
    projectId: string,
    history?: { entries: Array<{ url: string; title: string }>; activeIndex: number },
  ) => {
    if (!mainWindow) return

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

    setupBrowserView(browserId, view)
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
autoUpdater.autoInstallOnAppQuit = true

type UpdaterSupport = {
  enabled: boolean
  reason?: string
  message?: string
}

let cachedUpdaterSupport: UpdaterSupport | null = null

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
autoUpdater.on('update-available', (info) =>
  sendUpdateStatus('available', {
    version: info.version,
    releaseNotes: info.releaseNotes,
    releaseDate: info.releaseDate,
  }),
)
autoUpdater.on('update-not-available', () => sendUpdateStatus('up-to-date'))
autoUpdater.on('download-progress', (progress) =>
  sendUpdateStatus('downloading', {
    percent: Math.round(progress.percent),
  }),
)
autoUpdater.on('update-downloaded', (info) =>
  sendUpdateStatus('ready', {
    version: info.version,
  }),
)
autoUpdater.on('error', (err) =>
  sendUpdateStatus('error', {
    message: err.message,
  }),
)

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

  setTimeout(() => {
    checkForAppUpdates()
  }, AUTO_UPDATE_CHECK_DELAY)

  if (updateCheckInterval) clearInterval(updateCheckInterval)
  updateCheckInterval = setInterval(checkForAppUpdates, AUTO_UPDATE_CHECK_INTERVAL)
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
  autoUpdater.quitAndInstall()
})

ipcMain.handle('updater:get-version', () => {
  return app.getVersion()
})

ipcMain.handle('updater:get-support', () => {
  return getUpdaterSupport()
})

// ---------- App lifecycle ----------

app.whenReady().then(() => {
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
            { role: 'quit', label: `Quit ${appName}` },
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
              click: () => mainWindow?.webContents.send('app:close-terminal'),
            },
          ],
        },
        { role: 'viewMenu' },
      ]),
    )
  }

  createWindow()
  scheduleAutomaticUpdateChecks()
})

app.on('before-quit', () => {
  try {
    if (!mainWindow?.isDestroyed()) {
      mainWindow?.webContents.send('app:before-quit')
    }
  } catch {}
  cleanupBrowserViews()
  ptys.cleanup()
})

app.on('window-all-closed', () => {
  cleanupBrowserViews()
  ptys.cleanup()
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
