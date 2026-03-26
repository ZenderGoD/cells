import * as pty from 'node-pty'
import { resolveShell, resolveCwd, cleanEnv, ensureSpawnHelperExecutable } from './pty-shared'

export class PtyManager {
  private ptys = new Map<string, pty.IPty>()

  /** Spawn a shell pty for a terminal */
  spawn(termId: string, cols: number, rows: number, cwd?: string): pty.IPty {
    ensureSpawnHelperExecutable()

    // Kill any existing pty with this id
    this.kill(termId)

    const p = pty.spawn(resolveShell(), ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: resolveCwd(cwd),
      env: cleanEnv(),
    })

    this.ptys.set(termId, p)
    return p
  }

  /** Kill a pty */
  kill(termId: string): void {
    const p = this.ptys.get(termId)
    if (p) {
      try {
        p.kill()
      } catch {}
      this.ptys.delete(termId)
    }
  }

  /** Write data to a pty */
  write(termId: string, data: string): void {
    try {
      this.ptys.get(termId)?.write(data)
    } catch {
      this.ptys.delete(termId)
    }
  }

  /** Resize a pty */
  resize(termId: string, cols: number, rows: number): void {
    try {
      this.ptys.get(termId)?.resize(cols, rows)
    } catch {
      this.ptys.delete(termId)
    }
  }

  /** Check if a pty exists */
  has(termId: string): boolean {
    return this.ptys.has(termId)
  }

  /** Get the pty for a terminal (used to guard stale event handlers) */
  get(termId: string): pty.IPty | undefined {
    return this.ptys.get(termId)
  }

  /** Cleanup all ptys */
  cleanup(): void {
    for (const [, p] of this.ptys) {
      try {
        p.kill()
      } catch {}
    }
    this.ptys.clear()
  }
}
