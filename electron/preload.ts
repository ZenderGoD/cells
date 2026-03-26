import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CellsAPI, ProjectsState } from '../src/types'

const api: CellsAPI = {
  terminal: {
    attach: (termId: string, cols: number, rows: number, cwd?: string) =>
      ipcRenderer.invoke('terminal:attach', termId, cols, rows, cwd),
    unsubscribe: (termId: string) => ipcRenderer.invoke('terminal:unsubscribe', termId),
    detach: (termId: string) => ipcRenderer.invoke('terminal:detach', termId),
    write: (termId: string, data: string) => ipcRenderer.send('terminal:write', termId, data),
    resize: (termId: string, cols: number, rows: number) =>
      ipcRenderer.send('terminal:resize', termId, cols, rows),
    getProcess: (termId: string) => ipcRenderer.invoke('terminal:get-process', termId),
    getProcessInfo: (termId: string) => ipcRenderer.invoke('terminal:get-process-info', termId),
    getCodexTitle: (termId: string) => ipcRenderer.invoke('terminal:get-codex-title', termId),
    onData: (callback: (termId: string, data: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, termId: string, data: string) =>
        callback(termId, data)
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.removeListener('terminal:data', handler)
    },
    onExit: (callback: (termId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, termId: string) => callback(termId)
      ipcRenderer.on('terminal:exit', handler)
      return () => ipcRenderer.removeListener('terminal:exit', handler)
    },
  },
  browser: {
    create: (
      browserId: string,
      projectId: string,
      history?: { entries: Array<{ url: string; title: string }>; activeIndex: number },
    ) => ipcRenderer.invoke('browser:create', browserId, projectId, history),
    destroy: (browserId: string) => ipcRenderer.invoke('browser:destroy', browserId),
    park: (browserId: string) => ipcRenderer.invoke('browser:park', browserId),
    navigate: (browserId: string, url: string, searchEngineUrl?: string) =>
      ipcRenderer.invoke('browser:navigate', browserId, url, searchEngineUrl),
    goBack: (browserId: string) => ipcRenderer.send('browser:go-back', browserId),
    goForward: (browserId: string) => ipcRenderer.send('browser:go-forward', browserId),
    reload: (browserId: string) => ipcRenderer.send('browser:reload', browserId),
    updateBounds: (
      browserId: string,
      bounds: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.send('browser:update-bounds', browserId, bounds),
    setVisible: (browserId: string, visible: boolean) =>
      ipcRenderer.send('browser:set-visible', browserId, visible),
    setZoomFactor: (browserId: string, factor: number) =>
      ipcRenderer.send('browser:set-zoom-factor', browserId, factor),
    toggleDevTools: (browserId: string) => ipcRenderer.send('browser:toggle-devtools', browserId),
    onTitleUpdated: (callback: (browserId: string, title: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, browserId: string, title: string) =>
        callback(browserId, title)
      ipcRenderer.on('browser:title-updated', handler)
      return () => ipcRenderer.removeListener('browser:title-updated', handler)
    },
    onUrlChanged: (callback: (browserId: string, url: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, browserId: string, url: string) =>
        callback(browserId, url)
      ipcRenderer.on('browser:url-changed', handler)
      return () => ipcRenderer.removeListener('browser:url-changed', handler)
    },
    onNavState: (
      callback: (browserId: string, canGoBack: boolean, canGoForward: boolean) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        browserId: string,
        canGoBack: boolean,
        canGoForward: boolean,
      ) => callback(browserId, canGoBack, canGoForward)
      ipcRenderer.on('browser:nav-state', handler)
      return () => ipcRenderer.removeListener('browser:nav-state', handler)
    },
    onLoading: (callback: (browserId: string, loading: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, browserId: string, loading: boolean) =>
        callback(browserId, loading)
      ipcRenderer.on('browser:loading', handler)
      return () => ipcRenderer.removeListener('browser:loading', handler)
    },
    onNewWindow: (callback: (browserId: string, url: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, browserId: string, url: string) =>
        callback(browserId, url)
      ipcRenderer.on('browser:new-window', handler)
      return () => ipcRenderer.removeListener('browser:new-window', handler)
    },
    onThemeColor: (callback: (browserId: string, color: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, browserId: string, color: string) =>
        callback(browserId, color)
      ipcRenderer.on('browser:theme-color', handler)
      return () => ipcRenderer.removeListener('browser:theme-color', handler)
    },
    onFaviconUpdated: (callback: (browserId: string, faviconUrl: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, browserId: string, faviconUrl: string) =>
        callback(browserId, faviconUrl)
      ipcRenderer.on('browser:favicon-updated', handler)
      return () => ipcRenderer.removeListener('browser:favicon-updated', handler)
    },
    getAllHistory: () =>
      ipcRenderer.invoke('browser:get-all-history') as Promise<Record<
        string,
        { entries: Array<{ url: string; title: string }>; activeIndex: number }
      > | null>,
    onOverscroll: (
      callback: (browserId: string, progress: number, direction: string | null) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        browserId: string,
        progress: number,
        direction: string | null,
      ) => callback(browserId, progress, direction)
      ipcRenderer.on('browser:overscroll', handler)
      return () => ipcRenderer.removeListener('browser:overscroll', handler)
    },
    onWindowCycle: (callback: (direction: 1 | -1) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, direction: 1 | -1) => callback(direction)
      ipcRenderer.on('browser:window-cycle', handler)
      return () => ipcRenderer.removeListener('browser:window-cycle', handler)
    },
  },
  state: {
    load: () => ipcRenderer.invoke('state:load'),
    save: (state: ProjectsState) => ipcRenderer.invoke('state:save', state),
  },
  app: {
    onBeforeQuit: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:before-quit', handler)
      return () => ipcRenderer.removeListener('app:before-quit', handler)
    },
    onNewTerminal: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:new-terminal', handler)
      return () => ipcRenderer.removeListener('app:new-terminal', handler)
    },
    onCloseTerminal: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:close-terminal', handler)
      return () => ipcRenderer.removeListener('app:close-terminal', handler)
    },
    toggleMaximize: () => ipcRenderer.invoke('app:toggle-maximize'),
    resizeToFit: (width: number, height: number) =>
      ipcRenderer.invoke('app:resize-to-fit', width, height),
    pickFolder: () => ipcRenderer.invoke('app:pick-folder'),
    pickFiles: () => ipcRenderer.invoke('app:pick-files') as Promise<string[] | null>,
    listRecentFiles: () =>
      ipcRenderer.invoke('app:list-recent-files') as Promise<
        Array<{ path: string; name: string; mtime: number; source: string }>
      >,
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    saveTempFile: (data: Uint8Array, filename: string) =>
      ipcRenderer.invoke('app:save-temp-file', data, filename) as Promise<string | null>,
    pasteClipboardFiles: () =>
      ipcRenderer.invoke('app:paste-clipboard-files') as Promise<string[] | null>,
    openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
    requestQuit: () => ipcRenderer.invoke('app:request-quit'),
    pinWindow: (
      id: string,
      type: string,
      bounds: { x: number; y: number; width: number; height: number },
      browserUrl?: string,
    ) => ipcRenderer.invoke('app:pin-window', id, type, bounds, browserUrl),
    unpinWindow: (id: string) => ipcRenderer.invoke('app:unpin-window', id),
    onWindowUnpinned: (callback: (id: string, type: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, id: string, type: string) =>
        callback(id, type)
      ipcRenderer.on('app:window-unpinned', handler)
      return () => ipcRenderer.removeListener('app:window-unpinned', handler)
    },
    getPinnedId: () => {
      const params = new URLSearchParams(window.location.search)
      return params.get('pinned')
    },
    getPinnedType: () => {
      const params = new URLSearchParams(window.location.search)
      return params.get('type') as 'terminal' | 'browser' | null
    },
  },
  git: {
    isRepo: (cwd: string) => ipcRenderer.invoke('git:is-repo', cwd),
    repoRoot: (cwd: string) => ipcRenderer.invoke('git:repo-root', cwd),
    listWorktrees: (cwd: string) => ipcRenderer.invoke('git:list-worktrees', cwd),
    createWorktree: (cwd: string, branch: string, targetDir?: string, baseBranch?: string) =>
      ipcRenderer.invoke('git:create-worktree', cwd, branch, targetDir, baseBranch),
    removeWorktree: (cwd: string, worktreePath: string) =>
      ipcRenderer.invoke('git:remove-worktree', cwd, worktreePath),
  },
  agent: {
    checkAvailable: (aliases?: Record<string, string>) =>
      ipcRenderer.invoke('agent:check-available', aliases),
  },
  mcp: {
    install: (projectPath: string) => ipcRenderer.invoke('mcp:install', projectPath),
  },
  extensions: {
    install: (input: string) => ipcRenderer.invoke('extensions:install', input),
    uninstall: (extensionId: string) => ipcRenderer.invoke('extensions:uninstall', extensionId),
    list: () => ipcRenderer.invoke('extensions:list'),
    setEnabled: (projectId: string, extensionId: string, enabled: boolean) =>
      ipcRenderer.invoke('extensions:set-enabled', projectId, extensionId, enabled),
    showPopup: (
      extensionId: string,
      projectId: string,
      bounds: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke('extensions:show-popup', extensionId, projectId, bounds),
    hidePopup: () => ipcRenderer.invoke('extensions:hide-popup'),
    onPopupClosed: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('extensions:popup-closed', handler)
      return () => ipcRenderer.removeListener('extensions:popup-closed', handler)
    },
    onInstalled: (callback: (meta: any) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, meta: any) => callback(meta)
      ipcRenderer.on('extensions:installed', handler)
      return () => ipcRenderer.removeListener('extensions:installed', handler)
    },
  },
  daemon: {
    getStatus: () =>
      ipcRenderer.invoke('daemon:get-status') as Promise<{
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
      }>,
    listSessions: () =>
      ipcRenderer.invoke('daemon:list-sessions') as Promise<
        Array<{
          termId: string
          processInfo: {
            pid: number
            command: string
            label: string
            key: string
            isShell: boolean
          } | null
          subscribed: boolean
        }>
      >,
    killSession: (termId: string) => ipcRenderer.invoke('daemon:kill-session', termId),
    killAll: () => ipcRenderer.invoke('daemon:kill-all'),
    restart: () => ipcRenderer.invoke('daemon:restart') as Promise<boolean>,
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    getVersion: () => ipcRenderer.invoke('updater:get-version') as Promise<string>,
    getSupport: () =>
      ipcRenderer.invoke('updater:get-support') as Promise<{
        enabled: boolean
        reason?: string
        message?: string
      }>,
    setAutoUpdate: (enabled: boolean) => ipcRenderer.invoke('updater:set-auto-update', enabled),
    onStatus: (callback: (status: string, info?: any) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: string, info?: any) =>
        callback(status, info)
      ipcRenderer.on('updater:status', handler)
      return () => ipcRenderer.removeListener('updater:status', handler)
    },
  },
}

contextBridge.exposeInMainWorld('cells', api)
