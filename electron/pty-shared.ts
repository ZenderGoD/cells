import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import type { TerminalProcessInfo } from '../src/types'

// Use userInfo().homedir instead of os.homedir() — the latter reads the HOME
// env var which dev mode overrides to a sandbox directory. userInfo() reads
// from the system password database, always returning the real user home.
export const HOME_DIR = os.userInfo().homedir
export const MAX_BUFFER = 64 * 1024

const CODEX_HOME_DIR = path.join(HOME_DIR, '.codex')
const CODEX_LOGS_DB = path.join(CODEX_HOME_DIR, 'logs_1.sqlite')
const CODEX_STATE_DB = path.join(CODEX_HOME_DIR, 'state_5.sqlite')

const require = createRequire(import.meta.url)

// ---------- PTY helpers ----------

export function isExecutable(filePath: string | undefined): filePath is string {
  if (!filePath) return false
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveShell(): string {
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh']
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate
  }
  return '/bin/sh'
}

export function resolveCwd(cwd?: string): string {
  if (!cwd) return HOME_DIR
  try {
    if (fs.statSync(cwd).isDirectory()) return cwd
  } catch {}
  return HOME_DIR
}

let didRepairSpawnHelper = false

export function ensureSpawnHelperExecutable(): void {
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
export function cleanEnv(): Record<string, string> {
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

// ---------- Process info ----------

function readSqliteValue(dbPath: string, query: string) {
  if (!fs.existsSync(dbPath)) return null
  try {
    const value = execFileSync('sqlite3', [dbPath, query], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim()
    return value || null
  } catch {
    return null
  }
}

function readProcessTable() {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
        if (!match) return null
        return {
          pid: Number.parseInt(match[1], 10),
          ppid: Number.parseInt(match[2], 10),
          command: match[3],
        }
      })
      .filter((entry): entry is { pid: number; ppid: number; command: string } => !!entry)
  } catch {
    return []
  }
}

function basenameCommand(command: string) {
  const trimmed = command.trim()
  if (!trimmed) return ''
  return trimmed.split('/').pop() ?? trimmed
}

function isShellProcess(command: string) {
  const normalized = basenameCommand(command).toLowerCase()
  return (
    normalized === 'sh' ||
    normalized === 'bash' ||
    normalized === 'zsh' ||
    normalized === 'fish' ||
    normalized === 'login'
  )
}

export function resolveTerminalProcessInfo(
  shellPid: number,
  shellCommand?: string | null,
): TerminalProcessInfo | null {
  if (!Number.isInteger(shellPid) || shellPid <= 0) return null

  const processTable = readProcessTable()
  const shellEntry =
    processTable.find((process) => process.pid === shellPid) ??
    (shellCommand
      ? {
          pid: shellPid,
          ppid: 0,
          command: shellCommand,
        }
      : null)

  if (!shellEntry) return null

  const childrenByParent = new Map<number, Array<{ pid: number; ppid: number; command: string }>>()
  for (const process of processTable) {
    const siblings = childrenByParent.get(process.ppid) ?? []
    siblings.push(process)
    siblings.sort((a, b) => b.pid - a.pid)
    childrenByParent.set(process.ppid, siblings)
  }

  const queue = (childrenByParent.get(shellPid) ?? []).map((process) => ({
    ...process,
    depth: 1,
  }))
  let activeProcess: { pid: number; command: string; depth: number } | null = null

  while (queue.length > 0) {
    const current = queue.shift()!
    if (!isShellProcess(current.command)) {
      activeProcess = current
      break
    }
    const children = childrenByParent.get(current.pid) ?? []
    queue.push(...children.map((process) => ({ ...process, depth: current.depth + 1 })))
  }

  const resolved = activeProcess ?? { pid: shellEntry.pid, command: shellEntry.command }
  const label = basenameCommand(resolved.command)
  return {
    pid: resolved.pid,
    command: resolved.command,
    label,
    key: label.toLowerCase(),
    isShell: isShellProcess(resolved.command),
  }
}

function isCodexCommand(command: string) {
  const normalized = command.toLowerCase().split('/').pop() ?? command.toLowerCase()
  return normalized === 'codex' || normalized === 'codex-cli' || normalized.startsWith('codex-')
}

export function resolveCodexProcessPid(shellPid: number) {
  if (!Number.isInteger(shellPid) || shellPid <= 0) return null

  const processTable = readProcessTable()
  if (processTable.length === 0) return null

  const childrenByParent = new Map<number, Array<{ pid: number; ppid: number; command: string }>>()
  for (const process of processTable) {
    const siblings = childrenByParent.get(process.ppid) ?? []
    siblings.push(process)
    childrenByParent.set(process.ppid, siblings)
  }

  const queue = [...(childrenByParent.get(shellPid) ?? [])]
  let bestMatch: { pid: number; ppid: number; command: string } | null = null

  while (queue.length > 0) {
    const current = queue.shift()!
    if (isCodexCommand(current.command)) {
      bestMatch = current
    }
    const children = childrenByParent.get(current.pid)
    if (children) queue.push(...children)
  }

  return bestMatch?.pid ?? null
}

export function resolveCodexThreadTitle(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const threadId = readSqliteValue(
    CODEX_LOGS_DB,
    `select thread_id from logs where process_uuid like 'pid:${pid}:%' and thread_id is not null order by ts desc, ts_nanos desc, id desc limit 1;`,
  )
  if (!threadId || !/^[A-Za-z0-9-]+$/.test(threadId)) return null
  return readSqliteValue(
    CODEX_STATE_DB,
    `select title from threads where id = '${threadId}' limit 1;`,
  )
}
