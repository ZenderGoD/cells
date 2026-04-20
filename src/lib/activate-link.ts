import { useStore } from '@/lib/store'
import { extractLocalPathCandidate } from '@/lib/terminal-links'

// Shared URL-activation logic. Originally lived inline in cell-terminal.tsx
// (the xterm link-provider wrapper). Extracted so agent chat messages route
// clicked links through the same rules — linkRules → terminalLinkTarget
// fallback → openExternal — and so local paths get the same
// statPath/revealPath/addTerminalInWorktree treatment.

async function openLocalPath(pathCandidate: string) {
  try {
    const result = await window.cells.app.statPath(pathCandidate)
    if (result.kind === 'missing') return
    if (result.kind === 'file') {
      await window.cells.app.revealPath(result.resolved)
      return
    }
    const directoryTarget = useStore.getState().directoryLinkTarget
    if (directoryTarget === 'terminal') {
      useStore.getState().addTerminalInWorktree('', undefined, result.resolved)
      return
    }
    await window.cells.app.revealPath(result.resolved)
  } catch {
    // IPC failure — silently drop; the click just doesn't do anything.
  }
}

export function activateLink(url: string): void {
  const pathCandidate = extractLocalPathCandidate(url)
  if (pathCandidate) {
    void openLocalPath(pathCandidate)
    return
  }

  const state = useStore.getState()
  const rules = state.linkRules
  for (const rule of rules) {
    try {
      if (new RegExp(rule.pattern, 'i').test(url)) {
        if (rule.target === 'system') {
          window.cells.app.openExternal(url)
        } else {
          state.addBrowserWithUrl(url, rule.projectId ?? null)
        }
        return
      }
    } catch {
      // Invalid regex, skip
    }
  }
  if (state.terminalLinkTarget === 'browser') {
    state.addBrowserWithUrl(url, state.terminalLinkProjectId)
  } else {
    window.cells.app.openExternal(url)
  }
}
