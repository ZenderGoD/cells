import os from 'os'
import * as pty from 'node-pty'

const HOME_DIR = os.homedir()
const DEFAULT_SHELL = process.env.SHELL || '/bin/zsh'

/** Strip Electron/Vite/Node dev variables so they don't leak into terminals.
 *  HOME stays as the real user home — CELLS_HOME_DIR is only for app config storage. */
function cleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('ELECTRON') ||
      key.startsWith('VITE') ||
      key.startsWith('CHROME_') ||
      key.startsWith('ORIGINAL_XDG_') ||
      key.startsWith('CELLS_')
    ) {
      delete env[key]
    }
  }
  delete env['NODE_OPTIONS']
  // Restore real user paths — don't leak dev sandbox into terminal sessions
  env.HOME = HOME_DIR
  delete env['XDG_CONFIG_HOME']
  delete env['XDG_DATA_HOME']
  // Ensure full color support
  env.COLORTERM = 'truecolor'
  // Don't claim to be native ghostty — ghostty-web (WASM) has different capabilities
  delete env['TERM_PROGRAM']
  return env
}

export class PtyManager {
  private ptys = new Map<string, pty.IPty>()

  /** Spawn a shell pty for a terminal */
  spawn(termId: string, cols: number, rows: number, cwd?: string): pty.IPty {
    // Kill any existing pty with this id
    this.kill(termId)

    const p = pty.spawn(DEFAULT_SHELL, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || HOME_DIR,
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
