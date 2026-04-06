import type { TerminalProcessInfo } from '../src/types'

export type TerminalAttachBackend = 'replay' | 'tmux' | 'zellij'

export type TerminalAttachResult = {
  reattached: boolean
  shellPid: number
  buffer: string
  backend: TerminalAttachBackend
}

export type TerminalScrollStatus = {
  backend: TerminalAttachBackend
  paneInMode: boolean
  scrollPosition: number
  historySize: number
  mouseAnyFlag?: boolean
  alternateOn?: boolean
}

export interface TerminalSessionManager {
  spawn(
    termId: string,
    cols: number,
    rows: number,
    cwd?: string,
    projectId?: string | null,
  ): { reattached: boolean; shellPid: number }
  attach(
    termId: string,
    cols: number,
    rows: number,
    cwd?: string,
    projectId?: string | null,
    onAttached?: () => void,
  ): TerminalAttachResult
  subscribe(termId: string, onSubscribed?: () => void): string
  unsubscribe(termId: string): void
  kill(termId: string): void
  write(termId: string, data: string): void
  resize(termId: string, cols: number, rows: number): void
  handleWheel(termId: string, direction: 'up' | 'down', steps: number, sequence: string): void
  getScrollStatus(termId: string): TerminalScrollStatus | null
  has(termId: string): boolean
  list(): string[]
  getShellPid(termId: string): number | null
  getProcessInfo(termId: string): TerminalProcessInfo | null
  getCodexTitle(termId: string): string | null
  getBuffer(termId: string): string
  getHistory(termId: string): string
  clear(termId: string): void
  cleanup(): void
}
