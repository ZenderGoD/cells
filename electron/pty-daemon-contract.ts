export const PTY_DAEMON_PROTOCOL_VERSION = 2

// Bump this when a new Cells build can no longer safely reuse a daemon from an
// older build even if the socket protocol still parses. This is the session
// ownership / replay semantics compatibility contract.
export const PTY_DAEMON_COMPAT_VERSION = 8

export interface PtyDaemonVersionInfo {
  protocolVersion: number
  compatVersion?: number | null
  backend?: 'tmux' | 'zellij' | null
  appVersion: string | null
  electronVersion: string | null
  nodeAbi: string | null
  pid: number
  uptime: number
}

export type PtyDaemonRestartReason =
  | 'protocol-mismatch'
  | 'compat-version-mismatch'
  | 'backend-mismatch'
  | 'node-abi-mismatch'

export function getDaemonRestartReason(
  daemonVersion: PtyDaemonVersionInfo | null | undefined,
  currentNodeAbi: string,
  currentBackend: 'tmux' | 'zellij',
): PtyDaemonRestartReason | null {
  if (!daemonVersion || daemonVersion.protocolVersion !== PTY_DAEMON_PROTOCOL_VERSION) {
    return 'protocol-mismatch'
  }

  if ((daemonVersion.compatVersion ?? null) !== PTY_DAEMON_COMPAT_VERSION) {
    return 'compat-version-mismatch'
  }

  if ((daemonVersion.backend ?? null) !== currentBackend) {
    return 'backend-mismatch'
  }

  if (daemonVersion.nodeAbi && daemonVersion.nodeAbi !== currentNodeAbi) {
    return 'node-abi-mismatch'
  }

  return null
}
