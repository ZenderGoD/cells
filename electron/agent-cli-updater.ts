import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

type AgentCliName = 'claude' | 'codex'

export type AgentCliUpdateStatus = 'updated' | 'skipped' | 'failed'

export interface AgentCliUpdateResult {
  agent: AgentCliName
  status: AgentCliUpdateStatus
  command?: string
  message: string
}

export interface AgentCliUpdateProgress {
  phase: 'started' | 'agent-started' | 'agent-finished' | 'finished'
  agent?: AgentCliName
  result?: AgentCliUpdateResult
  results?: AgentCliUpdateResult[]
}

const COMMAND_TIMEOUT_MS = 5 * 60_000
const DETECTION_TIMEOUT_MS = 8_000
const MAX_CAPTURED_OUTPUT = 4_000

function appendBoundedText(base: string, next: string): string {
  const combined = base + next
  if (combined.length <= MAX_CAPTURED_OUTPUT) return combined
  return combined.slice(combined.length - MAX_CAPTURED_OUTPUT)
}

function buildCliUpdateEnv(): NodeJS.ProcessEnv {
  const home = os.homedir()
  const pathEntries = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.volta/bin`,
    process.env.PATH ?? '',
  ]
    .flatMap((entry) => entry.split(path.delimiter))
    .filter(Boolean)

  return {
    ...process.env,
    PATH: Array.from(new Set(pathEntries)).join(path.delimiter),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function commandSummary(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ')
}

async function runCapturedCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      env: buildCliUpdateEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      try {
        child.kill('SIGTERM')
      } catch {}
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, 1_000).unref()
    }, timeoutMs)
    timeout.unref()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBoundedText(stdout, chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBoundedText(stderr, chunk)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ code: null, signal: null, stdout, stderr: err.message })
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

async function runShellCommand(command: string, timeoutMs: number) {
  const shell = process.env.SHELL || '/bin/sh'
  return await runCapturedCommand(shell, ['-lc', command], timeoutMs)
}

async function resolveCommandPath(command: string): Promise<string | null> {
  const result = await runShellCommand(`command -v -- ${shellQuote(command)}`, DETECTION_TIMEOUT_MS)
  if (result.code !== 0) return null
  return result.stdout.split(/\r?\n/)[0]?.trim() || null
}

function resolveRealPath(binaryPath: string): string {
  try {
    return fs.realpathSync.native(binaryPath)
  } catch {
    return binaryPath
  }
}

async function hasHomebrewCodexCask(brewPath: string): Promise<boolean> {
  const result = await runCapturedCommand(
    brewPath,
    ['list', '--cask', 'codex'],
    DETECTION_TIMEOUT_MS,
  )
  return result.code === 0
}

function looksLikeHomebrewCodex(_binaryPath: string, realPath: string): boolean {
  if (realPath.includes('/Homebrew/Caskroom/codex/')) return true
  if (realPath.includes('/homebrew/Caskroom/codex/')) return true
  return false
}

async function getNpmGlobalRoot(npmPath: string): Promise<string | null> {
  const result = await runCapturedCommand(npmPath, ['root', '-g'], DETECTION_TIMEOUT_MS)
  if (result.code !== 0) return null
  return result.stdout.split(/\r?\n/)[0]?.trim() || null
}

function looksLikeNpmCodex(binaryPath: string, realPath: string, npmGlobalRoot: string | null) {
  if (binaryPath.includes('/node_modules/.bin/codex')) return true
  if (realPath.includes('/node_modules/@openai/codex/')) return true
  if (!npmGlobalRoot) return false
  return fs.existsSync(path.join(npmGlobalRoot, '@openai', 'codex'))
}

function buildResult(
  agent: AgentCliName,
  status: AgentCliUpdateStatus,
  message: string,
  command?: string,
): AgentCliUpdateResult {
  return command ? { agent, status, message, command } : { agent, status, message }
}

async function updateClaudeCli(): Promise<AgentCliUpdateResult> {
  const claudePath = await resolveCommandPath('claude')
  if (!claudePath) {
    return buildResult('claude', 'skipped', 'Claude CLI was not found on PATH.')
  }

  const args = ['update']
  const result = await runCapturedCommand(claudePath, args, COMMAND_TIMEOUT_MS)
  const summary = commandSummary(claudePath, args)
  if (result.code === 0) {
    return buildResult('claude', 'updated', 'Claude CLI update completed.', summary)
  }
  const detail = (result.stderr || result.stdout).trim() || `exited with code ${result.code}`
  return buildResult('claude', 'failed', detail, summary)
}

async function updateCodexCli(): Promise<AgentCliUpdateResult> {
  const codexPath = await resolveCommandPath('codex')
  if (!codexPath) {
    return buildResult('codex', 'skipped', 'Codex CLI was not found on PATH.')
  }

  const realPath = resolveRealPath(codexPath)
  const brewPath = await resolveCommandPath('brew')
  const activeCodexLooksHomebrew = looksLikeHomebrewCodex(codexPath, realPath)
  const homebrewCodexCaskInstalled =
    brewPath && activeCodexLooksHomebrew ? await hasHomebrewCodexCask(brewPath) : false
  if (brewPath && activeCodexLooksHomebrew && homebrewCodexCaskInstalled) {
    const command = `${shellQuote(brewPath)} update --quiet && ${shellQuote(
      brewPath,
    )} upgrade --cask codex`
    const result = await runShellCommand(command, COMMAND_TIMEOUT_MS)
    if (result.code === 0) {
      return buildResult('codex', 'updated', 'Codex Homebrew cask update completed.', command)
    }
    const detail = (result.stderr || result.stdout).trim() || `exited with code ${result.code}`
    return buildResult('codex', 'failed', detail, command)
  }

  const npmPath = await resolveCommandPath('npm')
  const npmGlobalRoot = npmPath ? await getNpmGlobalRoot(npmPath) : null
  if (npmPath && looksLikeNpmCodex(codexPath, realPath, npmGlobalRoot)) {
    const args = ['install', '-g', '@openai/codex@latest']
    const result = await runCapturedCommand(npmPath, args, COMMAND_TIMEOUT_MS)
    const summary = commandSummary(npmPath, args)
    if (result.code === 0) {
      return buildResult('codex', 'updated', 'Codex npm package update completed.', summary)
    }
    const detail = (result.stderr || result.stdout).trim() || `exited with code ${result.code}`
    return buildResult('codex', 'failed', detail, summary)
  }

  return buildResult(
    'codex',
    'skipped',
    `Codex CLI install source was not recognized: ${codexPath}`,
  )
}

export async function updateAgentClisForCellsUpdate(
  onProgress?: (progress: AgentCliUpdateProgress) => void,
): Promise<AgentCliUpdateResult[]> {
  onProgress?.({ phase: 'started' })
  const updaters: Array<[AgentCliName, () => Promise<AgentCliUpdateResult>]> = [
    ['claude', updateClaudeCli],
    ['codex', updateCodexCli],
  ]
  const results: AgentCliUpdateResult[] = []

  for (const [agent, updater] of updaters) {
    onProgress?.({ phase: 'agent-started', agent })
    let result: AgentCliUpdateResult
    try {
      result = await updater()
    } catch (err) {
      result = buildResult(agent, 'failed', err instanceof Error ? err.message : String(err))
    }
    results.push(result)
    onProgress?.({ phase: 'agent-finished', agent, result })
  }

  onProgress?.({ phase: 'finished', results })
  return results
}
