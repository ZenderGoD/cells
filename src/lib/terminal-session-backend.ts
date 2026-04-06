import type { TerminalSessionBackend } from '../types'

export const DEFAULT_TERMINAL_SESSION_BACKEND: TerminalSessionBackend = 'tmux'

export const TERMINAL_SESSION_BACKEND_OPTIONS: Array<{
  value: TerminalSessionBackend
  label: string
  hint: string
}> = [
  {
    value: 'tmux',
    label: 'tmux',
    hint: 'Default private server with the best Cells compatibility',
  },
  {
    value: 'zellij',
    label: 'Zellij',
    hint: 'Optional app-scoped backend with separate server/client sessions',
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
