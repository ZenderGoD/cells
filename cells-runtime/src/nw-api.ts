export interface NwWindowLike {
  showDevTools?: (iframe?: HTMLElement | null) => void
  close?: () => void
}

export interface NwGuiLike {
  Window?: {
    get?: () => NwWindowLike
  }
  Shell?: {
    openExternal?: (url: string) => void
  }
}

export function getNwGui(): NwGuiLike | null {
  const maybeRequire = globalThis.require as undefined | ((id: string) => unknown)
  if (!maybeRequire) return null
  try {
    return maybeRequire('nw.gui') as NwGuiLike
  } catch {
    return null
  }
}

export function openDevToolsFor(element?: HTMLElement | null): boolean {
  const win = getNwGui()?.Window?.get?.()
  if (!win?.showDevTools) return false
  win.showDevTools(element ?? null)
  return true
}

export function openExternal(url: string): boolean {
  const shell = getNwGui()?.Shell
  if (!shell?.openExternal) return false
  shell.openExternal(url)
  return true
}

declare global {
  var require: undefined | ((id: string) => unknown)
}
