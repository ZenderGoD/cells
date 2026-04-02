import type { TerminalExitDetails } from '@/types'

export function formatTerminalExitMessage(details?: TerminalExitDetails) {
  if (details?.message) return details.message

  switch (details?.reason) {
    case 'killed':
      return 'Process killed'
    case 'daemon-restart':
    case 'daemon-update':
      return 'Process killed because the PTY daemon was restarted'
    case 'daemon-disconnect':
      return 'PTY daemon disconnected and the process is no longer running'
    case 'process-exit':
    default:
      return 'Process exited'
  }
}
