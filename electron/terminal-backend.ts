import type { TerminalSessionBackend } from '../src/types'
import type { TerminalSessionManager } from './terminal-session-manager'
import { TmuxSessionManager, type TmuxSessionManagerHooks } from './tmux-session-manager'
import { ZellijSessionManager, type ZellijSessionManagerHooks } from './zellij-session-manager'
import { TMUX_INSTALL_URL, getTmuxSupportStatus } from './tmux-shared'
import { ZELLIJ_INSTALL_URL, getZellijSupportStatus } from './zellij-shared'

export type TerminalBackendSupportStatus = {
  backend: TerminalSessionBackend
  ok: boolean
  reason: 'missing' | 'too-old' | null
  binaryPath: string | null
  version: string | null
  minimumVersion: string
  installUrl: string
  name: string
}

export function getTerminalBackendSupportStatus(
  backend: TerminalSessionBackend,
): TerminalBackendSupportStatus {
  if (backend === 'tmux') {
    const support = getTmuxSupportStatus()
    return {
      backend,
      ...support,
      installUrl: TMUX_INSTALL_URL,
      name: 'tmux',
    }
  }

  const support = getZellijSupportStatus()
  return {
    backend,
    ...support,
    installUrl: ZELLIJ_INSTALL_URL,
    name: 'Zellij',
  }
}

export function createTerminalSessionManager(
  backend: TerminalSessionBackend,
  stateDir: string,
  hooks: TmuxSessionManagerHooks | ZellijSessionManagerHooks,
): TerminalSessionManager {
  // Both backends satisfy the same Cells contract:
  // detach drops only the renderer-side client PTY, while the backend keeps
  // the canonical terminal session alive for later reattach.
  if (backend === 'tmux') {
    return new TmuxSessionManager(stateDir, hooks)
  }
  return new ZellijSessionManager(stateDir, hooks)
}

export function describeTerminalBackendRequirement(support: TerminalBackendSupportStatus) {
  if (support.reason === 'too-old') {
    return `Cells requires ${support.name} ${support.minimumVersion}+.\nDetected: ${support.version ?? 'unknown'}${
      support.binaryPath ? ` at ${support.binaryPath}` : ''
    }`
  }
  return `Cells requires ${support.name} ${support.minimumVersion}+ to run terminal sessions.\nInstall ${support.name}, then relaunch Cells.`
}
