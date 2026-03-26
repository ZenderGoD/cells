import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import * as pty from 'node-pty'

const HOME_DIR = os.homedir()
const require = createRequire(import.meta.url)

function isExecutable(filePath: string | undefined): filePath is string {
  if (!filePath) return false
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveShell(): string {
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh']
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate
  }
  return '/bin/sh'
}

function resolveCwd(cwd?: string): string {
  if (!cwd) return HOME_DIR
  try {
    if (fs.statSync(cwd).isDirectory()) return cwd
  } catch {}
  return HOME_DIR
}

let didRepairSpawnHelper = false

function ensureSpawnHelperExecutable(): void {
  if (didRepairSpawnHelper || process.platform !== 'darwin') return
  didRepairSpawnHelper = true

  try {
    const unixTerminalPath = require.resolve('node-pty/lib/unixTerminal.js')
    const helperPath = path
      .resolve(
        path.dirname(unixTerminalPath),
        `../prebuilds/${process.platform}-${process.arch}/spawn-helper`,
      )
      .replace('app.asar', 'app.asar.unpacked')
      .replace('node_modules.asar', 'node_modules.asar.unpacked')

    const stat = fs.statSync(helperPath)
    const expectedMode = stat.mode | 0o755
    if ((stat.mode & 0o111) === 0) {
      fs.chmodSync(helperPath, expectedMode)
    }
  } catch (error) {
    console.warn('Failed to ensure node-pty spawn-helper is executable', error)
  }
}

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
