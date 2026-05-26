import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const require = createRequire(import.meta.url)
const releaseAppPath = path.join(root, 'release', 'Cells.app')
const smokeAppPath = path.join(root, 'release', 'Cells Smoke.app')
let appPath = releaseAppPath
let executablePath = path.join(appPath, 'Contents', 'MacOS', 'nwjs')
const logPath = path.join(os.tmpdir(), 'cells-smoke.log')
const smokeStateDir = path.join(os.tmpdir(), `cells-smoke-${process.pid}`)
const smokeStatePath = path.join(smokeStateDir, 'state.json')
const remoteDebuggingUrl = 'http://127.0.0.1:9224/json'

const expectedCellsApi = {
  terminal: [
    'attach',
    'unsubscribe',
    'detach',
    'write',
    'resize',
    'handleWheel',
    'getProcess',
    'getProcessInfo',
    'getCodexTitle',
    'getScrollStatus',
    'getHistory',
    'getHistoryPage',
    'getStatus',
    'registerLaunch',
    'onData',
    'onStatus',
    'onExit',
  ],
  agentSession: [
    'ensure',
    'subscribeUpdates',
    'unsubscribeUpdates',
    'send',
    'branchFrom',
    'close',
    'dispose',
    'reportQueues',
    'startQueuedDrain',
    'setQueueDrainPaused',
    'reportQueueCount',
    'notifyQueuedStart',
    'getAuth',
    'getLoginCommand',
    'startLogin',
    'cancelLogin',
    'updatePermissionMode',
    'updateContextLength',
    'respondPlan',
    'respondQuestion',
    'respondApproval',
    'listCodexModels',
    'listClaudeModels',
    'listCursorModels',
    'listCopilotModels',
    'listOpencodeModels',
    'listSavedSessions',
    'listRecentSessions',
    'onLoginEvent',
    'onUpdate',
    'onQueueUpdate',
  ],
  git: [
    'isRepo',
    'repoRoot',
    'listWorktrees',
    'createWorktree',
    'removeWorktree',
    'pruneWorktrees',
    'validateBranch',
    'statusWorktree',
  ],
  agent: ['checkAvailable', 'setCustomPaths'],
  daemon: ['getStatus', 'listSessions', 'killSession', 'killAll', 'restart'],
  updater: [
    'getSupport',
    'check',
    'download',
    'install',
    'getVersion',
    'setAutoUpdate',
    'onStatus',
  ],
  perf: ['reportRendererSample', 'reportTerminalSample', 'getStatus', 'getRecentEvents'],
  state: ['load', 'save'],
  browser: [
    'create',
    'destroy',
    'park',
    'getHistory',
    'getState',
    'navigate',
    'focus',
    'goBack',
    'goForward',
    'reload',
    'startElementPicker',
    'cancelElementPicker',
    'updateBounds',
    'setVisible',
    'setZoomFactor',
    'toggleDevTools',
    'onViewFocused',
    'onTitleUpdated',
    'onUrlChanged',
    'onNavState',
    'onLoading',
    'onNewWindow',
    'onFaviconUpdated',
    'onLoadFailed',
    'onRenderGone',
    'getAllHistory',
    'onThemeColor',
    'onOverscroll',
    'onCanvasWheel',
    'onWindowCycle',
    'onProjectCycle',
    'onElementSelected',
    'onElementPickerCancelled',
  ],
  editor: [
    'readFile',
    'writeFile',
    'saveFileAs',
    'lspOpen',
    'lspChange',
    'lspClose',
    'lspCompletion',
    'lspHover',
    'lspDefinition',
    'onLspDiagnostics',
  ],
  extensions: [
    'install',
    'uninstall',
    'list',
    'setEnabled',
    'showPopup',
    'hidePopup',
    'onPopupClosed',
    'onInstalled',
  ],
  app: [
    'onWindowFocus',
    'onFocusAgentWindow',
    'onCanvasZoom',
    'updateNotificationContext',
    'onBeforeQuit',
    'onDaemonDisconnected',
    'onSystemResume',
    'onNewTerminal',
    'onCloseTerminal',
    'onShortcut',
    'toggleMaximize',
    'toggleFullscreen',
    'resizeToFit',
    'pinWindow',
    'unpinWindow',
    'onWindowUnpinned',
    'onWindowResized',
    'getPinnedId',
    'getPinnedType',
    'onOpenFiles',
    'pickFolder',
    'pickFiles',
    'listRecentFiles',
    'searchProjectFiles',
    'copyRichTextToClipboard',
    'searchAgentMentions',
    'getPathForFile',
    'saveTempFile',
    'pasteClipboardFiles',
    'openExternal',
    'statPath',
    'revealPath',
    'copyAttachmentToClipboard',
    'requestQuit',
    'relaunch',
    'repairTerminalFonts',
    'showNotification',
    'beep',
    'getShellHistory',
    'fileThumbnail',
  ],
  mcp: ['install'],
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`))
        return
      }
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function getTargets() {
  const response = await fetch(remoteDebuggingUrl)
  if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`)
  return response.json()
}

async function waitForAppPage() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const targets = await getTargets()
      const page = targets.find(
        (target) => target.type === 'page' && target.url.includes('cells.html'),
      )
      if (page) return { page, targets }
    } catch {}
    await wait(1000)
  }
  throw new Error('Timed out waiting for Cells page target.')
}

async function waitForTarget(predicate, label, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    const targets = await getTargets()
    const target = targets.find(predicate)
    if (target) return target
    await wait(500)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function waitForTargetGone(predicate, label, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    const targets = await getTargets()
    if (!targets.some(predicate)) return
    await wait(500)
  }
  throw new Error(`Timed out waiting for ${label} to close.`)
}

async function cdpEval(wsUrl, expression, timeoutMs = 10_000) {
  const result = await cdpCall(
    wsUrl,
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    timeoutMs,
  )
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed')
  return result.result.value
}

async function runQuiet(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: process.platform === 'win32',
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`))
        return
      }
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

async function ensureSdkRuntime() {
  const packageJson = require.resolve('nw/package.json')
  const nwPackageDir = path.dirname(packageJson)
  const entries = fs.existsSync(nwPackageDir) ? fs.readdirSync(nwPackageDir) : []
  const runtimeDir = entries.find((entry) => entry.startsWith('nwjs-sdk-v0.109.0-'))
  if (runtimeDir) return path.join(nwPackageDir, runtimeDir, 'nwjs.app')

  await run('pnpm', ['rebuild', 'nw'])

  const rebuiltEntries = fs.readdirSync(nwPackageDir)
  const rebuiltRuntimeDir = rebuiltEntries.find((entry) => entry.startsWith('nwjs-sdk-v0.109.0-'))
  if (!rebuiltRuntimeDir) throw new Error('Unable to find Cells SDK runtime for smoke testing.')
  return path.join(nwPackageDir, rebuiltRuntimeDir, 'nwjs.app')
}

async function stageSmokeSdkApp() {
  const sdkApp = await ensureSdkRuntime()
  fs.rmSync(smokeAppPath, { recursive: true, force: true })
  fs.cpSync(sdkApp, smokeAppPath, { recursive: true })

  const resourcesDir = path.join(smokeAppPath, 'Contents', 'Resources')
  const appNwDir = path.join(resourcesDir, 'app.nw')
  fs.rmSync(appNwDir, { recursive: true, force: true })
  fs.cpSync(path.join(root, 'dist-cells'), appNwDir, { recursive: true })
  fs.copyFileSync(path.join(root, 'resources', 'icon.icns'), path.join(resourcesDir, 'cells.icns'))

  const plistPath = path.join(smokeAppPath, 'Contents', 'Info.plist')
  await runQuiet('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Cells Smoke', plistPath])
  await runQuiet('plutil', ['-replace', 'CFBundleName', '-string', 'Cells Smoke', plistPath])
  await runQuiet('plutil', [
    '-replace',
    'CFBundleIdentifier',
    '-string',
    'com.cells.app.smoke',
    plistPath,
  ])
  await runQuiet('plutil', ['-replace', 'CFBundleIconFile', '-string', 'cells.icns', plistPath])

  appPath = smokeAppPath
  executablePath = path.join(appPath, 'Contents', 'MacOS', 'nwjs')
}

async function describeTargetsForError() {
  try {
    const targets = await getTargets()
    return targets.map((target) => `${target.type}:${target.id}:${target.url}`).join(' | ')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function cdpCall(wsUrl, method, params = {}, timeoutMs = 10_000) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener(
      'error',
      () => {
        void describeTargetsForError().then((targets) =>
          reject(
            new Error(`Failed to open CDP websocket for ${method}: ${wsUrl}\nTargets: ${targets}`),
          ),
        )
      },
      { once: true },
    )
  })

  let id = 0
  const send = (nextMethod, nextParams = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id
      const timer = setTimeout(() => reject(new Error(`CDP ${nextMethod} timed out`)), timeoutMs)
      const onMessage = (event) => {
        const data = JSON.parse(event.data)
        if (data.id !== msgId) return
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)))
        else resolve(data.result)
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ id: msgId, method: nextMethod, params: nextParams }))
    })

  try {
    return await send(method, params)
  } finally {
    ws.close()
  }
}

async function waitForRuntimeSnapshot(wsUrl) {
  let lastError = null
  for (let i = 0; i < 30; i += 1) {
    try {
      const runtime = await cdpEval(
        wsUrl,
        `(() => {
          const draggableRegion = document.querySelector('.draggable-region');
          return {
            title: document.title,
            runtime: window.cellsRuntime,
            hasCellsApi: Boolean(window.cells?.browser && window.cells?.terminal && window.cells?.app),
            nwButtons: document.querySelectorAll('button[title="Close"],button[title="Minimize"],button[title="Maximize"]').length,
            draggableRegion: draggableRegion ? getComputedStyle(draggableRegion).webkitAppRegion : null
          };
        })()`,
      )
      if (runtime.runtime === 'nw' && runtime.hasCellsApi && runtime.draggableRegion) {
        return runtime
      }
    } catch (error) {
      lastError = error
    }
    await wait(500)
  }
  if (lastError) throw lastError
  throw new Error('Timed out waiting for Cells runtime shell.')
}

async function waitForPinnedRuntime(wsUrl, expectedId, expectedType) {
  let lastError = null
  for (let i = 0; i < 30; i += 1) {
    try {
      const runtime = await cdpEval(
        wsUrl,
        `(() => ({
          runtime: window.cellsRuntime,
          pinnedId: window.cells?.app?.getPinnedId?.() ?? null,
          pinnedType: window.cells?.app?.getPinnedType?.() ?? null
        }))()`,
      )
      if (
        runtime.runtime === 'nw' &&
        runtime.pinnedId === expectedId &&
        runtime.pinnedType === expectedType
      ) {
        return runtime
      }
    } catch (error) {
      lastError = error
    }
    await wait(500)
  }
  if (lastError) throw lastError
  throw new Error(`Timed out waiting for pinned ${expectedType} runtime ${expectedId}.`)
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('test:cells:smoke currently verifies the staged macOS Cells.app bundle.')
  }

  await run('pnpm', ['pack:cells'])
  await stageSmokeSdkApp()

  fs.rmSync(smokeStateDir, { recursive: true, force: true })
  fs.mkdirSync(smokeStateDir, { recursive: true })
  const smokeChromiumProfileDir = path.join(smokeStateDir, 'chromium')
  fs.mkdirSync(smokeChromiumProfileDir, { recursive: true })
  const manifestPath = path.join(appPath, 'Contents', 'Resources', 'app.nw', 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const expectedVersion = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ).version
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Staged app manifest version mismatch: expected ${expectedVersion}, got ${manifest.version}`,
    )
  }
  const chromiumArgs = String(manifest['chromium-args'] ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((arg) => !arg.startsWith('--user-data-dir='))
  chromiumArgs.push(`--user-data-dir=${smokeChromiumProfileDir}`)
  manifest['chromium-args'] = chromiumArgs.join(' ')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const mentionRoot = path.join(smokeStateDir, 'mention-project')
  const skillDir = path.join(mentionRoot, '.agents', 'skills', 'nw-smoke')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: nw-smoke-skill\ndescription: NW smoke mention skill\n---\n',
    'utf8',
  )
  fs.rmSync(logPath, { force: true })
  const log = fs.openSync(logPath, 'a')
  const child = spawn(executablePath, [], {
    cwd: root,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      CELLS_REPO_ROOT: root,
      CELLS_STATE_FILE: smokeStatePath,
      CELLS_NW_CONTEXT_MENU_TEST_MODE: '1',
    },
  })

  try {
    const { page, targets } = await waitForAppPage()
    const runtime = await waitForRuntimeSnapshot(page.webSocketDebuggerUrl)

    if (runtime.title !== 'Cells') throw new Error(`Expected Cells title, got ${runtime.title}`)
    if (runtime.runtime !== 'nw') throw new Error(`Expected Cells runtime, got ${runtime.runtime}`)
    if (!runtime.hasCellsApi) throw new Error('window.cells API is incomplete.')
    if (runtime.nwButtons !== 0)
      throw new Error(`Expected no custom NW window buttons, got ${runtime.nwButtons}`)
    if (runtime.draggableRegion !== 'drag') throw new Error('Toolbar drag region is not active.')

    const apiContract = await cdpEval(
      page.webSocketDebuggerUrl,
      `(() => {
        const expected = ${JSON.stringify(expectedCellsApi)}
        const missing = []
        const wrongType = []
        for (const [section, methods] of Object.entries(expected)) {
          const target = window.cells?.[section]
          if (!target) {
            missing.push(section)
            continue
          }
          for (const method of methods) {
            if (!(method in target)) {
              missing.push(section + '.' + method)
              continue
            }
            if (typeof target[method] !== 'function') wrongType.push(section + '.' + method + ':' + typeof target[method])
          }
        }
        return {
          ok: missing.length === 0 && wrongType.length === 0 && window.cells.perf.enabled === true,
          missing,
          wrongType,
          perfEnabled: window.cells.perf.enabled,
          sections: Object.keys(window.cells || {})
        }
      })()`,
    )
    if (!apiContract.ok)
      throw new Error(`Cells window.cells contract mismatch: ${JSON.stringify(apiContract)}`)

    const menu = await cdpEval(
      page.webSocketDebuggerUrl,
      `(() => {
        const labels = window.__cellsNwMenuLabels || null
        return {
          ok: Boolean(
            labels &&
            labels.app === 'Cells' &&
            labels.edit === 'Edit' &&
            labels.window === 'Window' &&
            labels.view === 'View' &&
            labels.editItems?.includes('Paste') &&
            labels.windowItems?.includes('Minimize') &&
            labels.viewItems?.includes('Toggle Full Screen')
          ),
          labels
        }
      })()`,
    )
    if (!menu.ok) throw new Error(`Cells application menu parity failed: ${JSON.stringify(menu)}`)

    await cdpEval(
      page.webSocketDebuggerUrl,
      `window.cells.app.pinWindow('nw-popout-terminal-smoke', 'terminal', { x: 140, y: 140, width: 640, height: 420 })`,
    )
    const pinnedTerminal = await waitForTarget(
      (target) =>
        target.type === 'page' &&
        target.url.includes('cells.html') &&
        target.url.includes('pinned=nw-popout-terminal-smoke'),
      'terminal popout page',
    )
    const pinnedRuntime = await waitForPinnedRuntime(
      pinnedTerminal.webSocketDebuggerUrl,
      'nw-popout-terminal-smoke',
      'terminal',
    )
    if (pinnedRuntime.runtime !== 'nw') throw new Error('Pinned window did not load Cells runtime.')
    if (pinnedRuntime.pinnedId !== 'nw-popout-terminal-smoke') {
      throw new Error(`Pinned id mismatch: ${JSON.stringify(pinnedRuntime)}`)
    }
    if (pinnedRuntime.pinnedType !== 'terminal') {
      throw new Error(`Pinned type mismatch: ${JSON.stringify(pinnedRuntime)}`)
    }
    const terminalUnpin = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise((resolve) => {
        const off = window.cells.app.onWindowUnpinned((id, type) => {
          if (id !== 'nw-popout-terminal-smoke') return
          off()
          resolve({ ok: true, id, type })
        })
        window.cells.app.unpinWindow('nw-popout-terminal-smoke')
        setTimeout(() => {
          off()
          resolve({ ok: false })
        }, 5000)
      })`,
      7000,
    )
    if (!terminalUnpin.ok || terminalUnpin.type !== 'terminal') {
      throw new Error(`Terminal popout unpin failed: ${JSON.stringify(terminalUnpin)}`)
    }
    await waitForTargetGone(
      (target) =>
        target.type === 'page' &&
        target.url.includes('cells.html') &&
        target.url.includes('pinned=nw-popout-terminal-smoke'),
      'terminal popout page',
    )

    await cdpEval(
      page.webSocketDebuggerUrl,
      `window.cells.app.pinWindow('nw-popout-agent-smoke', 'agent', { x: 160, y: 160, width: 640, height: 520 })`,
    )
    const pinnedAgent = await waitForTarget(
      (target) =>
        target.type === 'page' &&
        target.url.includes('cells.html') &&
        target.url.includes('pinned=nw-popout-agent-smoke'),
      'agent popout page',
    )
    const pinnedAgentRuntime = await waitForPinnedRuntime(
      pinnedAgent.webSocketDebuggerUrl,
      'nw-popout-agent-smoke',
      'agent',
    )
    if (pinnedAgentRuntime.runtime !== 'nw') {
      throw new Error('Pinned agent window did not load Cells runtime.')
    }
    if (
      pinnedAgentRuntime.pinnedId !== 'nw-popout-agent-smoke' ||
      pinnedAgentRuntime.pinnedType !== 'agent'
    ) {
      throw new Error(`Pinned agent mismatch: ${JSON.stringify(pinnedAgentRuntime)}`)
    }
    const agentUnpin = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise((resolve) => {
        const off = window.cells.app.onWindowUnpinned((id, type) => {
          if (id !== 'nw-popout-agent-smoke') return
          off()
          resolve({ ok: true, id, type })
        })
        window.cells.app.unpinWindow('nw-popout-agent-smoke')
        setTimeout(() => {
          off()
          resolve({ ok: false })
        }, 5000)
      })`,
      7000,
    )
    if (!agentUnpin.ok || agentUnpin.type !== 'agent') {
      throw new Error(`Agent popout unpin failed: ${JSON.stringify(agentUnpin)}`)
    }
    await waitForTargetGone(
      (target) =>
        target.type === 'page' &&
        target.url.includes('cells.html') &&
        target.url.includes('pinned=nw-popout-agent-smoke'),
      'agent popout page',
    )

    await cdpEval(
      page.webSocketDebuggerUrl,
      `window.cells.app.pinWindow('nw-popout-browser-smoke', 'browser', { x: 180, y: 180, width: 640, height: 420 }, 'https://example.com/')`,
    )
    const browserPopout = await waitForTarget(
      (target) => target.type === 'page' && /^https:\/\/example\.com\/?/.test(target.url),
      'browser popout page',
    )
    await cdpEval(
      browserPopout.webSocketDebuggerUrl,
      `history.replaceState(null, '', '/?cells-nw-popout-smoke=1'); document.title = 'NW Browser Popout Smoke'; true`,
    )
    const browserUnpin = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise((resolve) => {
        const off = window.cells.app.onWindowUnpinned((id, type, snapshot) => {
          if (id !== 'nw-popout-browser-smoke') return
          off()
          resolve({ ok: true, id, type, snapshot })
        })
        window.cells.app.unpinWindow('nw-popout-browser-smoke')
        setTimeout(() => {
          off()
          resolve({ ok: false })
        }, 5000)
      })`,
      7000,
    )
    if (!browserUnpin.ok || browserUnpin.type !== 'browser') {
      throw new Error(`Browser popout unpin failed: ${JSON.stringify(browserUnpin)}`)
    }
    if (!browserUnpin.snapshot?.url?.includes('cells-nw-popout-smoke=1')) {
      throw new Error(
        `Browser popout did not preserve current URL: ${JSON.stringify(browserUnpin)}`,
      )
    }
    if (browserUnpin.snapshot?.title !== 'NW Browser Popout Smoke') {
      throw new Error(
        `Browser popout did not preserve current title: ${JSON.stringify(browserUnpin)}`,
      )
    }
    await waitForTargetGone((target) => target.id === browserPopout.id, 'browser popout page')

    await cdpEval(
      page.webSocketDebuggerUrl,
      `(() => {
        const browserNode = document.querySelector('[data-browser-id="nw-browser"]')
        if (!browserNode) return false
        browserNode.dispatchEvent(new MouseEvent('mousedown', {
          clientX: 500,
          clientY: 320,
          bubbles: true,
          cancelable: true
        }))
        browserNode.dispatchEvent(new MouseEvent('mouseup', {
          clientX: 500,
          clientY: 320,
          bubbles: true,
          cancelable: true
        }))
        return true
      })()`,
      5000,
    )

    const webview = await waitForTarget(
      (target) => target.type === 'webview' && /^https:\/\/example\.com\/?/.test(target.url),
      'embedded browser webview',
      30,
    )
    await wait(1000)
    const shortcutResult = await Promise.all([
      cdpEval(
        page.webSocketDebuggerUrl,
        `new Promise((resolve) => {
          const off = window.cells.app.onShortcut((payload) => {
            if (payload.command !== 'open-settings') return
            off()
            resolve({ ok: true, payload })
          })
          setTimeout(() => {
            off()
            resolve({ ok: false })
          }, 5000)
        })`,
        7000,
      ),
      cdpEval(
        webview.webSocketDebuggerUrl,
        `(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: ',',
            code: 'Comma',
            metaKey: true,
            bubbles: true,
            cancelable: true
          }));
          return true;
        })()`,
      ),
    ]).then(([result]) => result)
    if (!shortcutResult.ok || shortcutResult.payload?.source !== 'browser-view') {
      throw new Error(`Browser webview shortcut bridge failed: ${JSON.stringify(shortcutResult)}`)
    }
    const browserCycleShortcut = await Promise.all([
      cdpEval(
        page.webSocketDebuggerUrl,
        `new Promise((resolve) => {
          const events = []
          const offWindow = window.cells.browser.onWindowCycle((direction) => {
            events.push({ type: 'window', direction })
          })
          const offProject = window.cells.browser.onProjectCycle((direction) => {
            events.push({ type: 'project', direction })
          })
          setTimeout(() => {
            offWindow()
            offProject()
            resolve({
              ok:
                events.some((event) => event.type === 'window' && event.direction === 1) &&
                events.some((event) => event.type === 'window' && event.direction === -1) &&
                events.some((event) => event.type === 'project' && event.direction === 1),
              events
            })
          }, 1200)
        })`,
        3000,
      ),
      cdpEval(
        webview.webSocketDebuggerUrl,
        `(() => {
          for (const event of [
            new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }),
            new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
            new KeyboardEvent('keydown', { key: '\`', code: 'Backquote', ctrlKey: true, bubbles: true, cancelable: true })
          ]) {
            document.dispatchEvent(event);
          }
          return true;
        })()`,
      ),
    ]).then(([result]) => result)
    if (!browserCycleShortcut.ok) {
      throw new Error(
        `Browser webview cycle shortcut bridge failed: ${JSON.stringify(browserCycleShortcut)}`,
      )
    }
    const wheelResult = await Promise.all([
      cdpEval(
        page.webSocketDebuggerUrl,
        `new Promise((resolve) => {
          const off = window.cells.browser.onCanvasWheel((browserId, gesture) => {
            if (browserId !== 'nw-browser') return
            off()
            resolve({ ok: true, browserId, gesture })
          })
          setTimeout(() => {
            off()
            resolve({ ok: false })
          }, 5000)
        })`,
        7000,
      ),
      cdpEval(
        webview.webSocketDebuggerUrl,
        `(() => {
          document.dispatchEvent(new WheelEvent('wheel', {
            deltaX: 12,
            deltaY: 34,
            metaKey: true,
            clientX: 123,
            clientY: 234,
            bubbles: true,
            cancelable: true
          }));
          return true;
        })()`,
      ),
    ]).then(([result]) => result)
    if (
      !wheelResult.ok ||
      wheelResult.browserId !== 'nw-browser' ||
      wheelResult.gesture?.deltaX !== 12 ||
      wheelResult.gesture?.deltaY !== 34 ||
      wheelResult.gesture?.metaKey !== true
    ) {
      throw new Error(`Browser webview wheel bridge failed: ${JSON.stringify(wheelResult)}`)
    }
    const contextMenuResult = await Promise.all([
      cdpEval(
        page.webSocketDebuggerUrl,
        `new Promise((resolve) => {
          const onContext = (event) => {
            window.removeEventListener('cells-nw-browser-context-menu-shown', onContext)
            resolve({ ok: true, detail: event.detail })
          }
          window.addEventListener('cells-nw-browser-context-menu-shown', onContext)
          setTimeout(() => {
            window.removeEventListener('cells-nw-browser-context-menu-shown', onContext)
            resolve({ ok: false })
          }, 5000)
        })`,
        7000,
      ),
      cdpEval(
        webview.webSocketDebuggerUrl,
        `(() => {
          const link = document.querySelector('a[href]') || document.body;
          link.dispatchEvent(new MouseEvent('contextmenu', {
            clientX: 44,
            clientY: 55,
            bubbles: true,
            cancelable: true,
            button: 2
          }));
          return true;
        })()`,
      ),
    ]).then(([result]) => result)
    if (
      !contextMenuResult.ok ||
      contextMenuResult.detail?.browserId !== 'nw-browser' ||
      contextMenuResult.detail?.x !== 44 ||
      contextMenuResult.detail?.y !== 55 ||
      !contextMenuResult.detail?.menuItems?.includes('Open Link in New Browser') ||
      !contextMenuResult.detail?.menuItems?.includes('Copy Link Address')
    ) {
      throw new Error(
        `Browser webview context menu bridge failed: ${JSON.stringify(contextMenuResult)}`,
      )
    }

    const imageContextMenuResult = await Promise.all([
      cdpEval(
        page.webSocketDebuggerUrl,
        `new Promise((resolve) => {
          const onContext = (event) => {
            window.removeEventListener('cells-nw-browser-context-menu-shown', onContext)
            resolve({ ok: true, detail: event.detail })
          }
          window.addEventListener('cells-nw-browser-context-menu-shown', onContext)
          setTimeout(() => {
            window.removeEventListener('cells-nw-browser-context-menu-shown', onContext)
            resolve({ ok: false })
          }, 5000)
        })`,
        7000,
      ),
      cdpEval(
        webview.webSocketDebuggerUrl,
        `(() => {
          const img = document.createElement('img');
          img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
          img.alt = 'NW image smoke';
          document.body.appendChild(img);
          img.dispatchEvent(new MouseEvent('contextmenu', {
            clientX: 66,
            clientY: 77,
            bubbles: true,
            cancelable: true,
            button: 2
          }));
          img.remove();
          return true;
        })()`,
      ),
    ]).then(([result]) => result)
    if (
      !imageContextMenuResult.ok ||
      imageContextMenuResult.detail?.browserId !== 'nw-browser' ||
      !imageContextMenuResult.detail?.imageUrl?.startsWith('data:image/gif') ||
      !imageContextMenuResult.detail?.menuItems?.includes('Save Image As...') ||
      !imageContextMenuResult.detail?.menuItems?.includes('Copy Image') ||
      !imageContextMenuResult.detail?.menuItems?.includes('Copy Image Address')
    ) {
      throw new Error(
        `Browser webview image context menu bridge failed: ${JSON.stringify(imageContextMenuResult)}`,
      )
    }

    const urlBridgeResult = await Promise.all([
      cdpEval(
        page.webSocketDebuggerUrl,
        `new Promise((resolve) => {
          const off = window.cells.browser.onUrlChanged((browserId, url) => {
            if (browserId !== 'nw-browser' || !url.includes('cells-nw-url-smoke=1')) return
            off()
            resolve({ ok: true, browserId, url })
          })
          setTimeout(() => {
            off()
            resolve({ ok: false })
          }, 5000)
        })`,
        7000,
      ),
      cdpEval(
        webview.webSocketDebuggerUrl,
        `(() => {
          history.pushState(null, '', '/?cells-nw-url-smoke=1');
          return location.href;
        })()`,
      ),
    ]).then(([result]) => result)
    if (!urlBridgeResult.ok) {
      throw new Error(`Browser in-page URL bridge failed: ${JSON.stringify(urlBridgeResult)}`)
    }
    const browserHistory = await cdpEval(
      page.webSocketDebuggerUrl,
      `window.cells.browser.getHistory('nw-browser').then((history) => ({
        ok: Boolean(
          history &&
          history.entries.length >= 2 &&
          history.activeIndex === history.entries.length - 1 &&
          history.entries.some((entry) => entry.url.includes('cells-nw-url-smoke=1'))
        ),
        history
      }))`,
      5000,
    )
    if (!browserHistory.ok) {
      throw new Error(`Cells browser history smoke failed: ${JSON.stringify(browserHistory)}`)
    }

    const newWindowResult = await Promise.all([
      cdpEval(
        page.webSocketDebuggerUrl,
        `new Promise((resolve) => {
          const off = window.cells.browser.onNewWindow((browserId, url) => {
            if (browserId !== 'nw-browser' || !url.includes('cells-nw-new-window-smoke=1')) return
            off()
            resolve({ ok: true, browserId, url })
          })
          setTimeout(() => {
            off()
            resolve({ ok: false })
          }, 5000)
        })`,
        7000,
      ),
      cdpEval(
        webview.webSocketDebuggerUrl,
        `(() => {
          console.log('[cells-nw-new-window]' + JSON.stringify({ url: 'https://example.com/?cells-nw-new-window-smoke=1' }));
          return true;
        })()`,
      ),
    ]).then(([result]) => result)
    if (!newWindowResult.ok) {
      throw new Error(`Browser new-window bridge failed: ${JSON.stringify(newWindowResult)}`)
    }

    const overscrollResult = await Promise.all([
      cdpEval(
        page.webSocketDebuggerUrl,
        `new Promise((resolve) => {
          const off = window.cells.browser.onOverscroll((browserId, progress, direction) => {
            if (browserId !== 'nw-browser' || direction !== 'back' || progress <= 0) return
            off()
            resolve({ ok: true, browserId, progress, direction })
          })
          setTimeout(() => {
            off()
            resolve({ ok: false })
          }, 5000)
        })`,
        7000,
      ),
      cdpEval(
        page.webSocketDebuggerUrl,
        `(() => {
          window.dispatchEvent(new CustomEvent('cells-nw-browser-event', {
            detail: {
              browserId: 'nw-browser',
              kind: 'overscroll',
              progress: 1.18,
              direction: 'back',
              commit: false
            }
          }));
          return true;
        })()`,
      ),
    ]).then(([result]) => result)
    if (!overscrollResult.ok) {
      throw new Error(`Browser overscroll bridge failed: ${JSON.stringify(overscrollResult)}`)
    }

    const terminal = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise(async (resolve) => {
        const termId = 'nw-terminal-smoke-' + Date.now()
        const marker = 'CELLS_BETA_TERMINAL_PROBE_' + Date.now()
        try {
          await window.cells.terminal.attach(termId, 80, 24, null)
          window.cells.terminal.write(termId, 'printf "' + marker + '\\\\n"\\\\r')
          const started = Date.now()
          const poll = async () => {
            const history = await window.cells.terminal.getHistory(termId)
            if (history.includes(marker)) {
              const status = await window.cells.terminal.getStatus(termId)
              const before = await window.cells.daemon.listSessions()
              await window.cells.terminal.unsubscribe(termId)
              const after = await window.cells.daemon.listSessions()
              await window.cells.terminal.detach(termId)
              resolve({
                ok: true,
                statusKind: status?.kind ?? null,
                subscribedBefore: before.find((entry) => entry.termId === termId)?.subscribed ?? null,
                subscribedAfter: after.find((entry) => entry.termId === termId)?.subscribed ?? null
              })
              return
            }
            if (Date.now() - started > 6000) {
              resolve({ ok: false, historyTail: history.slice(-300) })
              return
            }
            setTimeout(poll, 250)
          }
          poll()
        } catch (error) {
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })`,
    )
    if (
      !terminal.ok ||
      terminal.statusKind !== 'process' ||
      terminal.subscribedBefore !== true ||
      terminal.subscribedAfter !== false
    ) {
      throw new Error(`Terminal smoke failed: ${JSON.stringify(terminal)}`)
    }

    const agent = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise(async (resolve) => {
        const windowId = 'nw-agent-smoke'
        const marker = 'CELLS_BETA_AGENT_PROBE_' + Date.now()
        const updates = []
        try {
          await window.cells.agent.setCustomPaths({ codex: '/bin/echo' })
          const unsubscribe = window.cells.agentSession.onUpdate((snapshot) => {
            if (snapshot.windowId !== windowId) return
            updates.push({
              status: snapshot.status,
              messageCount: snapshot.messages.length,
              roles: snapshot.messages.map((message) => message.role),
              last: snapshot.messages.at(-1)?.text ?? ''
            })
          })
          await window.cells.agentSession.ensure({ windowId, agent: 'codex', title: 'NW Agent Smoke', cwd: null })
          await window.cells.agentSession.send(windowId, marker)
          const started = Date.now()
          const poll = () => {
            const done = updates.find((entry) =>
              entry.status === 'idle' &&
              entry.messageCount >= 2 &&
              entry.roles.includes('assistant') &&
              entry.last.includes(marker)
            )
            const failed = updates.find((entry) => entry.status === 'error')
            if (done || failed || Date.now() - started > 7000) {
              unsubscribe()
              resolve({ ok: Boolean(done), updates: updates.slice(-12) })
              return
            }
            setTimeout(poll, 250)
          }
          poll()
        } catch (error) {
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error), updates })
        }
      })`,
      12_000,
    )
    if (!agent.ok) throw new Error(`Agent smoke failed: ${JSON.stringify(agent)}`)

    const agentApi = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise(async (resolve) => {
        try {
          const [codex, claude, cursor, copilot, opencode, saved, recent] = await Promise.all([
            window.cells.agentSession.listCodexModels(),
            window.cells.agentSession.listClaudeModels(),
            window.cells.agentSession.listCursorModels(),
            window.cells.agentSession.listCopilotModels(),
            window.cells.agentSession.listOpencodeModels(),
            window.cells.agentSession.listSavedSessions(),
            window.cells.agentSession.listRecentSessions('codex', 5)
          ])
          const loginEvents = []
          const off = window.cells.agentSession.onLoginEvent((event) => loginEvents.push(event.phase))
          const originalOpenExternal = window.cells.app.openExternal
          window.cells.app.openExternal = async () => {}
          try {
            await window.cells.agentSession.startLogin('codex')
            await window.cells.agentSession.cancelLogin('codex')
          } finally {
            window.cells.app.openExternal = originalOpenExternal
            off()
          }
          resolve({
            ok:
              codex.length > 0 &&
              claude.length > 0 &&
              cursor.length > 0 &&
              copilot.length > 0 &&
              opencode.length > 0 &&
              saved.some((entry) => entry.windowId === 'nw-agent-smoke') &&
              recent.some((entry) => entry.windowId === 'nw-agent-smoke' && entry.origin === 'cells') &&
              loginEvents.includes('starting') &&
              loginEvents.includes('cancelled'),
            counts: {
              codex: codex.length,
              claude: claude.length,
              cursor: cursor.length,
              copilot: copilot.length,
              opencode: opencode.length,
              saved: saved.length,
              recent: recent.length
            },
            loginEvents
          })
        } catch (error) {
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })`,
      5000,
    )
    if (!agentApi.ok) throw new Error(`Agent API parity smoke failed: ${JSON.stringify(agentApi)}`)

    const agentAuth = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise(async (resolve) => {
        const fs = window.require('node:fs')
        const os = window.require('node:os')
        const path = window.require('node:path')
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cells-nw-agent-auth-'))
        const writeBin = (name, body) => {
          const filePath = path.join(dir, name)
          fs.writeFileSync(filePath, body, { mode: 0o755 })
          return filePath
        }
        const codex = writeBin('codex', '#!/bin/sh\\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi\\necho "$@"\\n')
        const claude = writeBin('claude', '#!/bin/sh\\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo "{\\\\\\"loggedIn\\\\\\":true,\\\\\\"email\\\\\\":\\\\\\"smoke@example.test\\\\\\"}"; exit 0; fi\\necho "$@"\\n')
        const cursor = writeBin('cursor-agent', '#!/bin/sh\\nif [ "$1" = "status" ]; then echo "{\\\\\\"status\\\\\\":\\\\\\"authenticated\\\\\\",\\\\\\"isAuthenticated\\\\\\":true,\\\\\\"userInfo\\\\\\":{\\\\\\"email\\\\\\":\\\\\\"smoke@example.test\\\\\\"}}"; exit 0; fi\\necho "$@"\\n')
        const opencode = writeBin('opencode', '#!/bin/sh\\nif [ "$1" = "auth" ] && [ "$2" = "list" ]; then echo "Credentials"; echo "1 credentials"; exit 0; fi\\necho "$@"\\n')
        try {
          await window.cells.agent.setCustomPaths({ codex, claude, cursor, opencode })
          const [available, claudeAuth, codexAuth, cursorAuth, opencodeAuth] = await Promise.all([
            window.cells.agent.checkAvailable({}, {}),
            window.cells.agentSession.getAuth('claude'),
            window.cells.agentSession.getAuth('codex'),
            window.cells.agentSession.getAuth('cursor'),
            window.cells.agentSession.getAuth('opencode')
          ])
          resolve({
            ok:
              available.claude === true &&
              available.codex === true &&
              available.cursor === true &&
              available.opencode === true &&
              claudeAuth.authenticated === true &&
              codexAuth.authenticated === true &&
              cursorAuth.authenticated === true &&
              opencodeAuth.authenticated === true,
            available,
            statuses: { claude: claudeAuth, codex: codexAuth, cursor: cursorAuth, opencode: opencodeAuth }
          })
        } catch (error) {
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
        } finally {
          fs.rmSync(dir, { recursive: true, force: true })
        }
      })`,
      10_000,
    )
    if (!agentAuth.ok) throw new Error(`Agent auth smoke failed: ${JSON.stringify(agentAuth)}`)

    const agentResponses = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise(async (resolve) => {
        const windowId = 'nw-agent-smoke'
        const snapshots = []
        const off = window.cells.agentSession.onUpdate((snapshot) => {
          if (snapshot.windowId !== windowId) return
          snapshots.push({
            plan: Boolean(snapshot.pendingPlanApproval),
            question: Boolean(snapshot.pendingQuestion),
            approval: Boolean(snapshot.pendingApproval),
            lastRole: snapshot.messages.at(-1)?.role ?? null,
            last: snapshot.messages.at(-1)?.text ?? ''
          })
        })
        try {
          const setPending = window.__cellsNwSetAgentPending
          if (typeof setPending !== 'function') throw new Error('pending test hook missing')
          if (!setPending(windowId, 'plan')) throw new Error('plan pending state was not created')
          await window.cells.agentSession.respondPlan(windowId, 'auto-accept', 'ok')
          if (!setPending(windowId, 'question')) throw new Error('question pending state was not created')
          await window.cells.agentSession.respondQuestion(windowId, { 'Proceed?': ['Yes'] }, 'noted')
          if (!setPending(windowId, 'approval')) throw new Error('approval pending state was not created')
          await window.cells.agentSession.respondApproval(windowId, 'accept')
          off()
          const final = snapshots.at(-1)
          resolve({
            ok:
              snapshots.some((snapshot) => snapshot.plan) &&
              snapshots.some((snapshot) => snapshot.question) &&
              snapshots.some((snapshot) => snapshot.approval) &&
              final &&
              !final.plan &&
              !final.question &&
              !final.approval &&
              final.lastRole === 'system' &&
              final.last.includes('Approval response: accept'),
            snapshots: snapshots.slice(-12)
          })
        } catch (error) {
          off()
          resolve({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            snapshots
          })
        }
      })`,
      5000,
    )
    if (!agentResponses.ok) {
      throw new Error(`Agent response parity smoke failed: ${JSON.stringify(agentResponses)}`)
    }

    const mcpInstall = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise(async (resolve) => {
        try {
          const fs = window.require('node:fs')
          const os = window.require('node:os')
          const path = window.require('node:path')
          const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cells-nw-mcp-'))
          fs.mkdirSync(path.join(projectPath, '.codex'), { recursive: true })
          fs.mkdirSync(path.join(projectPath, '.cursor'), { recursive: true })
          const result = await window.cells.mcp.install(projectPath)
          const agents = JSON.parse(fs.readFileSync(path.join(projectPath, '.agents', 'mcp.json'), 'utf8'))
          const root = JSON.parse(fs.readFileSync(path.join(projectPath, '.mcp.json'), 'utf8'))
          const codex = fs.readFileSync(path.join(projectPath, '.codex', 'config.toml'), 'utf8')
          const cursor = JSON.parse(fs.readFileSync(path.join(projectPath, '.cursor', 'mcp.json'), 'utf8'))
          fs.rmSync(projectPath, { recursive: true, force: true })
          resolve({
            ok:
              result.targets.includes('.agents/mcp.json') &&
              result.targets.includes('.mcp.json') &&
              result.targets.includes('.codex/config.toml') &&
              result.targets.includes('.cursor/mcp.json') &&
              agents.mcpServers?.cells?.args?.[0] === result.serverPath &&
              root.mcpServers?.cells?.args?.[0] === result.serverPath &&
              cursor.mcpServers?.cells?.args?.[0] === result.serverPath &&
              codex.includes('[mcp_servers.cells]') &&
              codex.includes(result.serverPath),
            result
          })
        } catch (error) {
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })`,
      5000,
    )
    if (!mcpInstall.ok)
      throw new Error(`MCP install parity smoke failed: ${JSON.stringify(mcpInstall)}`)

    const updater = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise(async (resolve) => {
        try {
          const statusEvents = []
          const off = window.cells.updater.onStatus((status, info) => {
            statusEvents.push({ status, info })
          })
          const [version, support] = await Promise.all([
            window.cells.updater.getVersion(),
            window.cells.updater.getSupport()
          ])
          await window.cells.updater.check()
          await window.cells.updater.download()
          await window.cells.updater.setAutoUpdate(true)
          const installed = await window.cells.updater.install()
          setTimeout(() => {
            off()
            resolve({
              ok:
                version === ${JSON.stringify(expectedVersion)} &&
                support?.enabled === false &&
                support?.reason === 'development-build' &&
                statusEvents.length >= 3 &&
                statusEvents.every((event) =>
                  event.status === 'unsupported' &&
                  event.info?.reason === 'development-build'
                ) &&
                installed === false,
              version,
              support,
              statusEvents,
              installed
            })
          }, 100)
        } catch (error) {
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })`,
      5000,
    )
    if (!updater.ok) throw new Error(`Updater parity smoke failed: ${JSON.stringify(updater)}`)

    const perf = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise(async (resolve) => {
        try {
          await window.cells.perf.reportRendererSample({
            sampleWindowMs: 1000,
            fps: 59,
            longTaskCount: 1,
            maxLongTaskMs: 12,
            liveTerminalCount: 1,
            cachedTerminalCount: 0,
            totalTerminalCount: 1,
            totalBrowserCount: 1,
            totalTextEditorCount: 0,
            totalAgentWindowCount: 1,
            projectCount: 1,
            focusedTerminalId: null,
            focusedBrowserId: 'nw-browser',
            focusedTextEditorId: null,
            focusedAgentWindowId: 'nw-agent-smoke',
            useTransparentWindow: false,
            windowOpacity: 100,
            overlayOpen: false
          })
          window.cells.perf.reportTerminalSample({
            termId: 'nw-terminal-smoke',
            sampleWindowMs: 1000,
            bytes: 12,
            writeCalls: 1,
            forcedFullRenders: 0,
            viewportY: 0,
            scrollbackLines: 1,
            isFocused: true,
            isVisible: true
          })
          const status = await window.cells.perf.getStatus()
          const events = await window.cells.perf.getRecentEvents(10)
          resolve({
            ok:
              window.cells.perf.enabled === true &&
              status?.enabled === true &&
              typeof status?.logPath === 'string' &&
              status.logPath.includes('perf') &&
              events.some((event) => event.kind === 'renderer' && event.data.fps === 59) &&
              events.some((event) => event.kind === 'terminal' && event.data.termId === 'nw-terminal-smoke'),
            status,
            events
          })
        } catch (error) {
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })`,
      5000,
    )
    if (!perf.ok) throw new Error(`Perf parity smoke failed: ${JSON.stringify(perf)}`)

    const editorLsp = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise(async (resolve) => {
        try {
          const fs = window.require('node:fs')
          const os = window.require('node:os')
          const path = window.require('node:path')
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cells-nw-lsp-'))
          const bin = path.join(dir, 'typescript-language-server')
          const server = ${JSON.stringify(`#!/usr/bin/env node
let buffer = Buffer.alloc(0)
function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n')
  process.stdout.write(body)
}
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {
      textDocumentSync: 1,
      completionProvider: { triggerCharacters: ['.'] },
      hoverProvider: true,
      definitionProvider: true
    } } })
    return
  }
  if (message.method === 'textDocument/completion') {
    send({ jsonrpc: '2.0', id: message.id, result: [{ label: 'nwCompletion', kind: 6, insertText: 'nwCompletion' }] })
    return
  }
  if (message.method === 'textDocument/hover') {
    send({ jsonrpc: '2.0', id: message.id, result: { contents: { kind: 'markdown', value: 'NW hover' } } })
    return
  }
  if (message.method === 'textDocument/definition') {
    send({ jsonrpc: '2.0', id: message.id, result: null })
    return
  }
  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null })
    return
  }
  if (message.id) send({ jsonrpc: '2.0', id: message.id, result: null })
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n')
    if (headerEnd < 0) return
    const header = buffer.slice(0, headerEnd).toString('ascii')
    const match = header.match(/Content-Length:\\s*(\\d+)/i)
    if (!match) {
      buffer = buffer.slice(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    const start = headerEnd + 4
    const end = start + length
    if (buffer.length < end) return
    const raw = buffer.slice(start, end).toString('utf8')
    buffer = buffer.slice(end)
    handle(JSON.parse(raw))
  }
})
`)};
          fs.writeFileSync(bin, server, { mode: 0o755 })
          process.env.PATH = dir + path.delimiter + process.env.PATH
          const filePath = path.join(dir, 'sample.ts')
          fs.writeFileSync(filePath, 'const value = 1\\n', 'utf8')
          const opened = await window.cells.editor.lspOpen({
            filePath,
            languageId: 'typescript',
            content: 'const value = 1\\n',
            rootPath: dir
          })
          const changed = opened.enabled
            ? await window.cells.editor.lspChange(opened.uri, 'const value = 2\\n', 2)
            : { enabled: false }
          const completion = opened.enabled
            ? await window.cells.editor.lspCompletion(opened.uri, { line: 0, character: 6 })
            : null
          const hover = opened.enabled
            ? await window.cells.editor.lspHover(opened.uri, { line: 0, character: 6 })
            : null
          if (opened.uri) await window.cells.editor.lspClose(opened.uri)
          fs.rmSync(dir, { recursive: true, force: true })
          resolve({
            ok:
              opened.enabled === true &&
              opened.uri?.startsWith('file://') &&
              changed.enabled === true &&
              Array.isArray(completion) &&
              completion.some((item) => item.label === 'nwCompletion') &&
              hover?.contents?.value === 'NW hover',
            opened,
            changed,
            completion,
            hover
          })
        } catch (error) {
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })`,
      12_000,
    )
    if (!editorLsp.ok)
      throw new Error(`Editor LSP parity smoke failed: ${JSON.stringify(editorLsp)}`)

    const agentQueue = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise(async (resolve) => {
        const windowId = 'nw-agent-smoke'
        const marker = 'CELLS_BETA_AGENT_QUEUE_' + Date.now()
        const updates = []
        const queueUpdates = []
        const offUpdate = window.cells.agentSession.onUpdate((snapshot) => {
          if (snapshot.windowId !== windowId) return
          updates.push({
            status: snapshot.status,
            last: snapshot.messages.at(-1)?.text ?? '',
            roles: snapshot.messages.map((message) => message.role)
          })
        })
        const offQueue = window.cells.agentSession.onQueueUpdate((update) => {
          if (update.windowId !== windowId) return
          queueUpdates.push(update.queuedMessages.length)
        })
        try {
          window.cells.agentSession.reportQueues([{
            windowId,
            request: {
              windowId,
              agent: 'codex',
              title: 'NW Agent Smoke',
              cwd: null,
              initialPrompt: null
            },
            queuedMessages: [{
              id: 'nw-queue-' + Date.now(),
              text: marker,
              attachments: [],
              mode: 'after-turn',
              model: null,
              thinkingLevel: null,
              permissionMode: null,
              fastMode: null,
              replyTo: null
            }]
          }])
          const started = Date.now()
          const poll = () => {
            const done = updates.find((entry) =>
              entry.status === 'idle' &&
              entry.roles.includes('assistant') &&
              entry.last.includes(marker)
            )
            if (done || Date.now() - started > 8000) {
              offUpdate()
              offQueue()
              resolve({ ok: Boolean(done) && queueUpdates.includes(0), updates: updates.slice(-10), queueUpdates })
              return
            }
            setTimeout(poll, 250)
          }
          poll()
        } catch (error) {
          offUpdate()
          offQueue()
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error), updates, queueUpdates })
        }
      })`,
      12_000,
    )
    if (!agentQueue.ok) throw new Error(`Agent queue smoke failed: ${JSON.stringify(agentQueue)}`)

    const mentions = await cdpEval(
      page.webSocketDebuggerUrl,
      `window.cells.app.searchAgentMentions(${JSON.stringify(mentionRoot)}, 'nw-smoke').then((results) => ({
        ok: results.some((entry) => entry.type === 'skill' && entry.label === 'nw-smoke-skill'),
        results: results.slice(0, 5)
      }))`,
      5000,
    )
    if (!mentions.ok) throw new Error(`Agent mention smoke failed: ${JSON.stringify(mentions)}`)

    const fileAndGitApis = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise(async (resolve) => {
        try {
          const fs = window.require('node:fs')
          const os = window.require('node:os')
          const path = window.require('node:path')
          const childProcess = window.require('node:child_process')
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cells-nw-files-'))
          const filePath = path.join(dir, 'smoke.txt')
          const write = await window.cells.editor.writeFile(filePath, 'hello nw')
          const read = await window.cells.editor.readFile(filePath)
          const statFile = await window.cells.app.statPath(filePath)
          const statMissing = await window.cells.app.statPath(path.join(dir, 'missing.txt'))
          const search = await window.cells.app.searchProjectFiles(dir, 'smoke')
          await window.cells.app.copyRichTextToClipboard('hello nw', '<b>hello nw</b>')
          childProcess.execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
          const realDir = fs.realpathSync(dir)
          const isRepo = await window.cells.git.isRepo(dir)
          const root = await window.cells.git.repoRoot(dir)
          const validation = await window.cells.git.validateBranch(dir, 'nw-smoke-branch')
          const worktrees = await window.cells.git.listWorktrees(dir)
          const status = await window.cells.git.statusWorktree(dir)
          fs.rmSync(dir, { recursive: true, force: true })
          resolve({
            ok:
              write.name === 'smoke.txt' &&
              read.content === 'hello nw' &&
              statFile.kind === 'file' &&
              statMissing.kind === 'missing' &&
              search.some((entry) => entry.name === 'smoke.txt') &&
              isRepo === true &&
              root === realDir &&
              validation.valid === true &&
              Array.isArray(worktrees) &&
              worktrees.length >= 1 &&
              status?.path === dir,
            write,
            read,
            statFile,
            statMissing,
            search: search.slice(0, 5),
            git: { isRepo, root, validation, worktreeCount: worktrees.length, status }
          })
        } catch (error) {
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })`,
      8000,
    )
    if (!fileAndGitApis.ok) {
      throw new Error(`NW file/git API smoke failed: ${JSON.stringify(fileAndGitApis)}`)
    }

    const attachments = await cdpEval(
      page.webSocketDebuggerUrl,
      `window.cells.app.saveTempFile(
        Uint8Array.from([71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,33,249,4,1,0,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]),
        'nw-smoke.gif'
      ).then(async (filePath) => {
        const thumbnail = filePath ? await window.cells.app.fileThumbnail(filePath, 48) : null
        const copied = filePath ? await window.cells.app.copyAttachmentToClipboard(filePath) : null
        return {
          ok: Boolean(filePath && thumbnail?.startsWith('data:image/gif;base64,') && copied?.kind === 'image'),
          filePath,
          thumbnailPrefix: thumbnail ? thumbnail.slice(0, 32) : null,
          copied
        }
      })`,
      5000,
    )
    if (!attachments.ok) {
      throw new Error(
        `NW attachment clipboard/thumbnail smoke failed: ${JSON.stringify(attachments)}`,
      )
    }

    const themeChange = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise((resolve) => {
        window.dispatchEvent(new Event('cells:open-settings'))
        const readTheme = () => ({
          background: getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
          foreground: getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim(),
          className: document.documentElement.className
        })
        const started = Date.now()
        const poll = () => {
          const buttons = [...document.querySelectorAll('button[data-theme-key]')]
          if (buttons.length > 1) {
            const before = readTheme()
            const original = buttons.find((button) => button.getAttribute('aria-pressed') === 'true') || null
            const target = buttons.find((button) => button.getAttribute('aria-pressed') !== 'true') || buttons[0]
            const themeKey = target.getAttribute('data-theme-key')
            target.click()
            setTimeout(() => {
              const after = readTheme()
              if (original && original !== target) original.click()
              resolve({
                ok: before.background !== after.background || before.foreground !== after.foreground || before.className !== after.className,
                themeKey,
                before,
                after
              })
            }, 250)
            return
          }
          if (Date.now() - started > 5000) {
            resolve({ ok: false, reason: 'theme buttons not found', count: buttons.length })
            return
          }
          setTimeout(poll, 100)
        }
        poll()
      })`,
      7000,
    )
    if (!themeChange.ok) {
      throw new Error(`Cells settings theme change smoke failed: ${JSON.stringify(themeChange)}`)
    }

    const extensionInstall = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise(async (resolve) => {
        const extensionPath = ${JSON.stringify(path.join(root, 'cells-runtime', 'test-extensions', 'content-script-probe-extension'))}
        const installedEvents = []
        const off = window.cells.extensions.onInstalled((meta) => installedEvents.push(meta.id))
        try {
          const meta = await window.cells.extensions.install(extensionPath)
          await window.cells.extensions.setEnabled('nw-demo', meta.id, true)
          const state = await window.cells.extensions.list()
          off()
          resolve({
            ok:
              Boolean(meta.id) &&
              state.extensions.some((entry) => entry.id === meta.id && entry.sourceUrl.includes(meta.id)) &&
              state.projectExtensions['nw-demo']?.includes(meta.id) &&
              installedEvents.includes(meta.id),
            meta,
            installedEvents,
            projectExtensions: state.projectExtensions['nw-demo'] || []
          })
        } catch (error) {
          off()
          resolve({ ok: false, error: error instanceof Error ? error.message : String(error), installedEvents })
        }
      })`,
      5000,
    )
    if (!extensionInstall.ok) {
      throw new Error(`Cells extension install smoke failed: ${JSON.stringify(extensionInstall)}`)
    }

    const appHooks = await cdpEval(
      page.webSocketDebuggerUrl,
      `(() => {
        window.cells.app.updateNotificationContext({
          activeProjectId: 'nw-demo',
          focusedAgentWindowId: 'nw-agent-smoke'
        })
        window.cells.app.beep()
        return {
          ok:
            window.__cellsNwNotificationContext?.activeProjectId === 'nw-demo' &&
            window.__cellsNwNotificationContext?.focusedAgentWindowId === 'nw-agent-smoke',
          context: window.__cellsNwNotificationContext || null
        }
      })()`,
      2000,
    )
    if (!appHooks.ok) {
      throw new Error(`Cells app notification/beep hooks smoke failed: ${JSON.stringify(appHooks)}`)
    }

    const lifecycle = await cdpEval(
      page.webSocketDebuggerUrl,
      `new Promise((resolve) => {
        let calls = 0
        const off = window.cells.app.onBeforeQuit(() => { calls += 1 })
        window.dispatchEvent(new Event('beforeunload'))
        window.dispatchEvent(new Event('beforeunload'))
        setTimeout(() => {
          off()
          resolve({ ok: calls === 1, calls })
        }, 100)
      })`,
      2000,
    )
    if (!lifecycle.ok) throw new Error(`Cells lifecycle smoke failed: ${JSON.stringify(lifecycle)}`)

    console.log(
      JSON.stringify(
        {
          app: path.relative(root, appPath),
          page: page.url,
          webview: webview?.url ?? null,
          webviewTargets: targets
            .filter((target) => target.type === 'webview')
            .map((target) => target.url),
          browserShortcut: shortcutResult,
          browserCycleShortcut,
          browserWheel: wheelResult,
          browserContextMenu: contextMenuResult,
          browserImageContextMenu: imageContextMenuResult,
          browserUrlBridge: urlBridgeResult,
          browserHistory,
          browserNewWindow: newWindowResult,
          browserOverscroll: overscrollResult,
          runtime,
          menu,
          popout: { terminal: terminalUnpin, agent: agentUnpin, browser: browserUnpin },
          terminal,
          agent: { ok: agent.ok },
          agentApi,
          agentAuth,
          agentResponses,
          mcpInstall,
          updater,
          perf: {
            ok: perf.ok,
            status: perf.status,
            events: perf.events?.map((event) => event.kind),
          },
          editorLsp: { ok: editorLsp.ok, opened: editorLsp.opened, changed: editorLsp.changed },
          agentQueue: { ok: agentQueue.ok },
          mentions: { ok: mentions.ok },
          fileAndGitApis,
          attachments,
          themeChange,
          extensionInstall,
          appHooks,
          lifecycle,
        },
        null,
        2,
      ),
    )
  } finally {
    child.kill()
    fs.closeSync(log)
    await wait(1000)
    try {
      process.kill(child.pid, 0)
      child.kill('SIGKILL')
    } catch {}
    fs.rmSync(smokeStateDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  if (fs.existsSync(logPath)) {
    console.error(`\nCells log tail (${logPath}):`)
    console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n'))
  }
  process.exit(1)
})
