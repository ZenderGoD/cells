type TerminalCacheApi = {
  applyThemeToAllTerminals(themeName: string): void
  destroyCachedTerminal(termId: string): void
  refreshAllTerminalFonts(): void
  getCachedTerminalCount(): number
  getTerminalPreviewSnapshot(
    termId: string,
    options?: { lines?: number; columns?: number },
  ): string[]
  getTerminalRestoreSnapshot(termId: string): string | null
  reloadAllTerminals(): void
  reloadTerminal(termId: string): void
}

const noopApi: TerminalCacheApi = {
  applyThemeToAllTerminals() {},
  destroyCachedTerminal() {},
  refreshAllTerminalFonts() {},
  getCachedTerminalCount() {
    return 0
  },
  getTerminalPreviewSnapshot() {
    return []
  },
  getTerminalRestoreSnapshot() {
    return null
  },
  reloadAllTerminals() {},
  reloadTerminal() {},
}

let terminalCacheApi: TerminalCacheApi = noopApi

export function registerTerminalCacheApi(api: TerminalCacheApi) {
  terminalCacheApi = api
}

export function applyThemeToAllTerminals(themeName: string) {
  terminalCacheApi.applyThemeToAllTerminals(themeName)
}

export function destroyCachedTerminal(termId: string) {
  terminalCacheApi.destroyCachedTerminal(termId)
}

export function getCachedTerminalCount() {
  return terminalCacheApi.getCachedTerminalCount()
}

export function refreshAllTerminalFonts() {
  terminalCacheApi.refreshAllTerminalFonts()
}

export function getTerminalPreviewSnapshot(
  termId: string,
  options?: { lines?: number; columns?: number },
) {
  return terminalCacheApi.getTerminalPreviewSnapshot(termId, options)
}

export function getTerminalRestoreSnapshot(termId: string) {
  return terminalCacheApi.getTerminalRestoreSnapshot(termId)
}

export function reloadTerminal(termId: string) {
  terminalCacheApi.reloadTerminal(termId)
}

export function reloadAllTerminals() {
  terminalCacheApi.reloadAllTerminals()
}
