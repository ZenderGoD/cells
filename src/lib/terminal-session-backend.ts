import type { TerminalSessionBackend } from '../types'

export const DEFAULT_TERMINAL_SESSION_BACKEND: TerminalSessionBackend = 'zellij'

export const TERMINAL_SESSION_BACKEND_OPTIONS: Array<{
  value: TerminalSessionBackend
  label: string
  hint: string
}> = [
  {
    value: 'tmux',
    label: 'tmux',
    hint: 'Disabled. Existing users are migrated to Zellij.',
  },
  {
    value: 'zellij',
    label: 'Zellij',
    hint: 'Default app-scoped backend with separate server/client sessions',
  },
]

export function normalizeTerminalSessionBackend(
  value: unknown,
  fallback: TerminalSessionBackend = DEFAULT_TERMINAL_SESSION_BACKEND,
): TerminalSessionBackend {
  if (value === 'zellij') return 'zellij'
  if (value === 'tmux') return 'zellij'
  return fallback
}

export function isServerOwnedTerminalBackend(backend: string | null | undefined) {
  return backend === 'tmux' || backend === 'zellij'
}
