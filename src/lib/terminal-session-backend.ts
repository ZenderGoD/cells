import type { TerminalSessionBackend } from '../types'

export const DEFAULT_TERMINAL_SESSION_BACKEND: TerminalSessionBackend = 'zellij'

export const TERMINAL_SESSION_BACKEND_OPTIONS: Array<{
  value: TerminalSessionBackend
  label: string
  hint: string
}> = [
  {
    value: 'zellij',
    label: 'Zellij',
    hint: 'Modern session backend with app-scoped config',
  },
  {
    value: 'tmux',
    label: 'tmux',
    hint: 'Battle-tested fallback with private socket + config',
  },
]

export function normalizeTerminalSessionBackend(
  value: unknown,
  fallback: TerminalSessionBackend = DEFAULT_TERMINAL_SESSION_BACKEND,
): TerminalSessionBackend {
  return value === 'tmux' || value === 'zellij' ? value : fallback
}

export function isServerOwnedTerminalBackend(backend: string | null | undefined) {
  return backend === 'tmux' || backend === 'zellij'
}
