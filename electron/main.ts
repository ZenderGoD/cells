import { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu, nativeImage } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { execFileSync } from 'child_process'
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
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

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

function applyWindowAppearance(opacity: number, _blurRadius: number) {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const clampedOpacity = Math.min(100, Math.max(0, Math.round(opacity)))
  const hasVisibleSurface = clampedOpacity > 0

  mainWindow.setVibrancy(hasVisibleSurface ? 'under-window' : null)
  mainWindow.setHasShadow(hasVisibleSurface)
}

// ---------- State persistence ----------

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true })
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

ipcMain.handle('agent:check-available', () => {
  const results: Record<string, boolean> = {}
  for (const name of ['claude', 'codex']) {
    try {
      execFileSync('which', [name], { stdio: 'pipe' })
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

ipcMain.handle('app:set-window-appearance', (_event, opacity: number, blurRadius: number) => {
  applyWindowAppearance(opacity, blurRadius)
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
    // Forward Ctrl+Tab / Ctrl+Shift+Tab to main renderer for terminal switching
    if (input.control && input.key === 'Tab') {
      _e.preventDefault()
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.focus()
        mainWindow?.webContents.sendInputEvent({
          type: input.type as 'keyDown' | 'keyUp',
          keyCode: input.key,
          modifiers: ['control' as const, ...(input.shift ? ['shift' as const] : [])],
        })
      }
      return
    }

    if (input.meta || input.control) {
      const key = input.key.toLowerCase()
      // Cmd+L → focus URL bar, Cmd+W → close, Cmd+T → command palette
      if (['l', 'w', 't', 'q', ','].includes(key)) {
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
        navigatingFromSaved: false,
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

function shouldEnableAutoUpdates() {
  return app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))
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
  checkForAppUpdates()
})

ipcMain.handle('updater:download', () => {
  autoUpdater.downloadUpdate().catch(() => {})
})

ipcMain.handle('updater:install', () => {
  autoUpdater.quitAndInstall()
})

ipcMain.handle('updater:get-version', () => {
  return app.getVersion()
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
