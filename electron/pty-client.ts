/**
 * PTY Daemon Client — used by Electron main process to communicate with
 * the standalone PTY daemon over a Unix domain socket.
 *
 * The daemon sends terminal data as compact binary frames (marker 0x02) and
 * everything else as newline-delimited JSON. The parser below handles both
 * formats transparently.
 */

import net from 'net'
import type { TerminalProcessInfo } from '../src/types'
import type { TerminalScrollStatus } from './terminal-session-manager'

const REQUEST_TIMEOUT = 5000

/** Must match the marker byte used in pty-daemon.ts sendBinaryData(). */
const BINARY_DATA_MARKER = 0x02

export class PtyDaemonClient {
  private socket: net.Socket | null = null
  private requestId = 0
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }
  >()
  /** Buffer for incoming socket data (binary + JSON mix). */
  private recvBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0)
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

      socket.on('data', (chunk: Buffer) => {
        this.recvBuf = this.recvBuf.length === 0 ? chunk : Buffer.concat([this.recvBuf, chunk])
        this.drainRecvBuffer()
      })

      this.socket = socket
    })
  }

  /**
   * Drain the receive buffer, dispatching complete binary frames and JSON
   * lines as they become available.
   */
  private drainRecvBuffer() {
    while (this.recvBuf.length > 0) {
      if (this.recvBuf[0] === BINARY_DATA_MARKER) {
        // Binary data frame: [0x02][uint16 termIdLen][termId][uint32 dataLen][data]
        const MIN_HEADER = 1 + 2 // marker + termId length
        if (this.recvBuf.length < MIN_HEADER) return // need more bytes
        const termIdLen = this.recvBuf.readUInt16BE(1)
        const fullHeader = MIN_HEADER + termIdLen + 4 // + data length field
        if (this.recvBuf.length < fullHeader) return
        const dataLen = this.recvBuf.readUInt32BE(MIN_HEADER + termIdLen)
        const totalLen = fullHeader + dataLen
        if (this.recvBuf.length < totalLen) return

        const termId = this.recvBuf.toString('utf-8', MIN_HEADER, MIN_HEADER + termIdLen)
        const data = this.recvBuf.toString('utf-8', fullHeader, totalLen)
        this.recvBuf = this.recvBuf.subarray(totalLen)
        this.dataCallback?.(termId, data)
      } else {
        // JSON line — scan for newline delimiter
        const nlIdx = this.recvBuf.indexOf(0x0a) // '\n'
        if (nlIdx === -1) return // incomplete line, wait for more data
        const line = this.recvBuf.toString('utf-8', 0, nlIdx)
        this.recvBuf = this.recvBuf.subarray(nlIdx + 1)
        if (!line.trim()) continue
        try {
          this.handleMessage(JSON.parse(line))
        } catch {}
      }
    }
  }

  disconnect(): void {
    this._connected = false
    // Clear callback before destroying socket to prevent crash-recovery
    // from triggering during intentional disconnect
    this.disconnectCallback = null
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

  async attach(
    termId: string,
    cols: number,
    rows: number,
    cwd?: string,
    projectId?: string | null,
  ): Promise<{
    reattached: boolean
    shellPid: number
    buffer: string
    backend: 'replay' | 'tmux' | 'zellij'
  }> {
    return this.request('attach', { termId, cols, rows, cwd, projectId })
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

  async getBuffer(termId: string): Promise<string> {
    const result = await this.request('get-buffer', { termId })
    return result.buffer ?? ''
  }

  async getHistory(termId: string): Promise<string> {
    const result = await this.request('get-history', { termId })
    return result.buffer ?? ''
  }

  async getShellPid(termId: string): Promise<number | null> {
    return this.request('get-shell-pid', { termId })
  }

  async getScrollStatus(termId: string): Promise<TerminalScrollStatus | null> {
    return this.request('get-scroll-status', { termId })
  }

  async getDaemonVersion(): Promise<{
    protocolVersion: number
    compatVersion?: number | null
    backend?: 'tmux' | 'zellij' | null
    appVersion: string | null
    electronVersion: string | null
    nodeAbi: string | null
    pid: number
    uptime: number
  } | null> {
    try {
      return await this.request('get-daemon-version', {})
    } catch {
      // Keep diagnostics non-fatal if the daemon is mid-restart or unhealthy.
      return null
    }
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

  handleWheel(termId: string, direction: 'up' | 'down', steps: number, sequence: string): void {
    this.send({ type: 'handle-wheel', termId, direction, steps, sequence })
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
