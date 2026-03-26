/**
 * PTY Daemon Client — used by Electron main process to communicate with
 * the standalone PTY daemon over a Unix domain socket.
 */

import net from 'net'
import type { TerminalProcessInfo } from '../src/types'

const REQUEST_TIMEOUT = 5000

export class PtyDaemonClient {
  private socket: net.Socket | null = null
  private requestId = 0
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private lineBuffer = ''
  private _connected = false

  private dataCallback: ((termId: string, data: string) => void) | null = null
  private exitCallback: ((termId: string) => void) | null = null
  private disconnectCallback: (() => void) | null = null

  async connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath, () => {
        this._connected = true
        resolve()
      })

      socket.on('error', (err) => {
        if (!this._connected) {
          reject(err)
          return
        }
        this._connected = false
        this.rejectAllPending('Daemon connection lost')
        this.disconnectCallback?.()
      })

      socket.on('close', () => {
        this._connected = false
        this.rejectAllPending('Daemon connection closed')
        this.disconnectCallback?.()
      })

      socket.on('data', (chunk) => {
        this.lineBuffer += chunk.toString()
        let idx: number
        while ((idx = this.lineBuffer.indexOf('\n')) !== -1) {
          const line = this.lineBuffer.slice(0, idx)
          this.lineBuffer = this.lineBuffer.slice(idx + 1)
          if (!line.trim()) continue
          try {
            this.handleMessage(JSON.parse(line))
          } catch {}
        }
      })

      this.socket = socket
    })
  }

  disconnect(): void {
    this._connected = false
    this.rejectAllPending('Client disconnecting')
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
  }

  isConnected(): boolean {
    return this._connected
  }

  // ---------- Push event listeners ----------

  onData(callback: (termId: string, data: string) => void): void {
    this.dataCallback = callback
  }

  onExit(callback: (termId: string) => void): void {
    this.exitCallback = callback
  }

  onDisconnect(callback: () => void): void {
    this.disconnectCallback = callback
  }

  // ---------- Request/response methods ----------

  async spawn(
    termId: string,
    cols: number,
    rows: number,
    cwd?: string,
  ): Promise<{ reattached: boolean; shellPid: number }> {
    return this.request('spawn', { termId, cols, rows, cwd })
  }

  async subscribe(termId: string): Promise<string> {
    const result = await this.request('subscribe', { termId })
    return result.buffer ?? ''
  }

  async kill(termId: string): Promise<void> {
    await this.request('kill', { termId })
  }

  async list(): Promise<string[]> {
    return this.request('list', {})
  }

  async getProcessInfo(termId: string): Promise<TerminalProcessInfo | null> {
    return this.request('get-process-info', { termId })
  }

  async getCodexTitle(termId: string): Promise<string | null> {
    return this.request('get-codex-title', { termId })
  }

  async getShellPid(termId: string): Promise<number | null> {
    return this.request('get-shell-pid', { termId })
  }

  async shutdown(): Promise<void> {
    try {
      await this.request('shutdown', {})
    } catch {
      // Daemon may close before responding
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.request('ping', {})
      return true
    } catch {
      return false
    }
  }

  // ---------- Fire-and-forget methods ----------

  write(termId: string, data: string): void {
    this.send({ type: 'write', termId, data })
  }

  resize(termId: string, cols: number, rows: number): void {
    this.send({ type: 'resize', termId, cols, rows })
  }

  unsubscribe(termId: string): void {
    this.send({ type: 'unsubscribe', termId })
  }

  // ---------- Internals ----------

  private handleMessage(msg: any) {
    if (msg.type === 'response') {
      const entry = this.pending.get(msg.id)
      if (entry) {
        clearTimeout(entry.timer)
        this.pending.delete(msg.id)
        if (msg.ok) {
          entry.resolve(msg.data)
        } else {
          entry.reject(new Error(msg.error || 'Daemon request failed'))
        }
      }
    } else if (msg.type === 'data') {
      this.dataCallback?.(msg.termId, msg.data)
    } else if (msg.type === 'exit') {
      this.exitCallback?.(msg.termId)
    }
  }

  private request(type: string, fields: object): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this._connected || !this.socket) {
        reject(new Error('Not connected to daemon'))
        return
      }
      const id = ++this.requestId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Daemon request '${type}' timed out`))
      }, REQUEST_TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ type, id, ...fields })
    })
  }

  private send(msg: object): void {
    if (!this._connected || !this.socket) return
    try {
      this.socket.write(JSON.stringify(msg) + '\n')
    } catch {}
  }

  private rejectAllPending(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.pending.clear()
  }
}
