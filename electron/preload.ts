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
    pickFolder: () => ipcRenderer.invoke('app:pick-folder'),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  agent: {
    checkAvailable: () => ipcRenderer.invoke('agent:check-available'),
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
    onStatus: (callback: (status: string, info?: any) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: string, info?: any) =>
        callback(status, info)
      ipcRenderer.on('updater:status', handler)
      return () => ipcRenderer.removeListener('updater:status', handler)
    },
  },
}

contextBridge.exposeInMainWorld('cells', api)
