/**
 * Shared PTY session owner for both daemon mode and in-process fallback mode.
 *
 * Invariants:
 * - `history` is the full replayable transcript window, regardless of whether a
 *   renderer is currently attached.
 * - `buffer` is only the detached replay delta: output produced while nobody is
 *   actively attached to the session.
 * - `attach`/`subscribe` flip a session from detached replay buffering into live
 *   forwarding at a single boundary so reattach cannot duplicate already-seen
 *   bytes over fresh output.
 */
import * as pty from 'node-pty'
import {
  cleanEnv,
  ensureSpawnHelperExecutable,
  resolveCwd,
  resolveCodexProcessPid,
  resolveCodexThreadTitle,
  resolveTerminalProcessInfo,
  resolveShell,
  MAX_BUFFER,
  MAX_REPLAY_HISTORY_BYTES,
} from './pty-shared'
import type { TerminalProcessInfo } from '../src/types'
import type {
  TerminalAttachResult,
  TerminalScrollStatus,
  TerminalSessionManager,
} from './terminal-session-manager'

type SessionMetadata = {
  shellPid: number
  replayBuffering: boolean
}

type SpawnOptions = {
  replayBuffering?: boolean
}

export interface PtySessionManagerHooks {
  onData?: (termId: string, data: string) => void
  onExit?: (termId: string) => void
}

export class PtySessionManager implements TerminalSessionManager {
  private readonly ptys = new Map<string, pty.IPty>()
  private readonly buffers = new Map<string, string>()
  private readonly histories = new Map<string, { chunks: string[]; length: number }>()
  private readonly metadata = new Map<string, SessionMetadata>()

  constructor(private readonly hooks: PtySessionManagerHooks = {}) {}

  spawn(
    termId: string,
    cols: number,
    rows: number,
    cwd?: string,
    _projectId?: string | null,
    options: SpawnOptions = {},
  ): { reattached: boolean; shellPid: number } {
    ensureSpawnHelperExecutable()
    const replayBuffering = options.replayBuffering ?? true

    const existing = this.ptys.get(termId)
    if (existing) {
      // Reattach to the existing shell instead of tearing it down. Session
      // lifetime is owned here; callers are only changing the attachment mode.
      try {
        existing.resize(cols, rows)
      } catch {}
      this.setReplayBuffering(termId, replayBuffering)
      return { reattached: true, shellPid: this.metadata.get(termId)?.shellPid ?? existing.pid }
    }

    const session = pty.spawn(resolveShell(), ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: resolveCwd(cwd),
      env: cleanEnv(),
    })

    this.ptys.set(termId, session)
    this.buffers.set(termId, '')
    this.metadata.set(termId, { shellPid: session.pid, replayBuffering })

    session.onData((data) => {
      if (this.ptys.get(termId) !== session) return
      this.appendHistory(termId, data)
      if (this.metadata.get(termId)?.replayBuffering) {
        this.appendBuffer(termId, data)
      }
      this.hooks.onData?.(termId, data)
    })

    session.onExit(() => {
      if (this.ptys.get(termId) !== session) return
      this.ptys.delete(termId)
      this.buffers.delete(termId)
      this.histories.delete(termId)
      this.metadata.delete(termId)
      this.hooks.onExit?.(termId)
    })

    return { reattached: false, shellPid: session.pid }
  }

  attach(
    termId: string,
    cols: number,
    rows: number,
    cwd?: string,
    projectId?: string | null,
    onAttached?: () => void,
  ): TerminalAttachResult {
    // Atomic renderer attach boundary:
    // 1. stop detached replay buffering
    // 2. drain the detached delta
    // 3. hand control to the live subscriber
    //
    // The callback lets the caller mark its subscription live in the same
    // synchronous boundary, which prevents replay/live overlap in fallback mode.
    const result = this.spawn(termId, cols, rows, cwd, projectId, { replayBuffering: false })
    const buffer = result.reattached ? this.drainBuffer(termId) : ''
    onAttached?.()
    return {
      ...result,
      buffer,
      backend: 'replay',
    }
  }

  subscribe(termId: string, onSubscribed?: () => void): string {
    // Equivalent to `attach`, but used when spawn and subscribe are separate
    // protocol messages. The subscription callback is part of the same replay
    // boundary so late detached bytes cannot be lost or duplicated.
    const buffer = this.drainBuffer(termId)
    this.setReplayBuffering(termId, false)
    onSubscribed?.()
    return buffer
  }

  unsubscribe(termId: string): void {
    if (!this.ptys.has(termId)) return
    // Detaching starts a fresh replay window. Older live bytes are already in
    // terminal state/history and should not be replayed again on next attach.
    this.buffers.set(termId, '')
    this.setReplayBuffering(termId, true)
  }

  kill(termId: string): void {
    const session = this.ptys.get(termId)
    if (session) {
      try {
        session.kill()
      } catch {}
      this.ptys.delete(termId)
    }
    this.buffers.delete(termId)
    this.histories.delete(termId)
    this.metadata.delete(termId)
  }

  write(termId: string, data: string): void {
    try {
      this.ptys.get(termId)?.write(data)
    } catch {
      this.ptys.delete(termId)
    }
  }

  resize(termId: string, cols: number, rows: number): void {
    try {
      this.ptys.get(termId)?.resize(cols, rows)
    } catch {
      this.ptys.delete(termId)
    }
  }

  handleWheel(termId: string, _direction: 'up' | 'down', _steps: number, sequence: string): void {
    if (!sequence) return
    this.write(termId, sequence)
  }

  getScrollStatus(termId: string): TerminalScrollStatus | null {
    if (!this.has(termId)) return null
    return {
      backend: 'replay',
      paneInMode: false,
      scrollPosition: 0,
      historySize: this.getHistory(termId).split('\n').length,
    }
  }

  has(termId: string): boolean {
    return this.ptys.has(termId)
  }

  list(): string[] {
    return [...this.ptys.keys()]
  }

  getShellPid(termId: string): number | null {
    const metadata = this.metadata.get(termId)
    const session = this.ptys.get(termId)
    return metadata?.shellPid ?? session?.pid ?? null
  }

  getProcessInfo(termId: string): TerminalProcessInfo | null {
    const shellPid = this.getShellPid(termId)
    if (!shellPid) return null
    const session = this.ptys.get(termId)
    return resolveTerminalProcessInfo(shellPid, session?.process)
  }

  getCodexTitle(termId: string): string | null {
    const shellPid = this.getShellPid(termId)
    if (!shellPid) return null
    const codexPid = resolveCodexProcessPid(shellPid)
    return codexPid ? resolveCodexThreadTitle(codexPid) : null
  }

  getBuffer(termId: string): string {
    return this.buffers.get(termId) ?? ''
  }

  drainBuffer(termId: string): string {
    const buffer = this.getBuffer(termId)
    this.buffers.set(termId, '')
    return buffer
  }

  getHistory(termId: string): string {
    const history = this.histories.get(termId)
    return history ? history.chunks.join('') : ''
  }

  clear(termId: string): void {
    this.buffers.delete(termId)
    this.histories.delete(termId)
    this.metadata.delete(termId)
  }

  cleanup(): void {
    this.shutdown()
  }

  shutdown(): void {
    for (const termId of [...this.ptys.keys()]) {
      this.kill(termId)
    }
  }

  private appendBuffer(termId: string, data: string) {
    const existing = this.buffers.get(termId) ?? ''
    const combined = existing + data
    this.buffers.set(termId, combined.length > MAX_BUFFER ? combined.slice(-MAX_BUFFER) : combined)
  }

  private setReplayBuffering(termId: string, replayBuffering: boolean) {
    const metadata = this.metadata.get(termId)
    if (!metadata) return
    metadata.replayBuffering = replayBuffering
  }

  private appendHistory(termId: string, data: string) {
    if (!data) return

    let history = this.histories.get(termId)
    if (!history) {
      history = { chunks: [], length: 0 }
      this.histories.set(termId, history)
    }

    history.chunks.push(data)
    history.length += data.length

    while (history.length > MAX_REPLAY_HISTORY_BYTES && history.chunks.length > 0) {
      const excess = history.length - MAX_REPLAY_HISTORY_BYTES
      const first = history.chunks[0]
      if (first.length <= excess) {
        history.chunks.shift()
        history.length -= first.length
        continue
      }

      history.chunks[0] = first.slice(excess)
      history.length -= excess
      break
    }
  }
}
