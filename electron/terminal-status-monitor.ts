import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { Interface as ReadLineInterface } from 'readline'
import type { SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentName,
  AgentRuntimeState,
  TerminalExitDetails,
  TerminalProcessInfo,
  TerminalRuntimeStatus,
} from '../src/types'
import type { PtyDaemonClient } from './pty-client'
import type { TerminalSessionManager } from './terminal-session-manager'
import { inferAgentFromCommand } from '../src/lib/agent-command.ts'

const HOME_DIR = os.userInfo().homedir
const CLAUDE_HOME = path.join(HOME_DIR, '.claude')
const CLAUDE_SESSIONS_DIR = path.join(CLAUDE_HOME, 'sessions')
const CODEX_HOME = path.join(HOME_DIR, '.codex')
const CODEX_LOGS_DB = path.join(CODEX_HOME, 'logs_1.sqlite')
const POLL_INTERVAL_MS = 30000
const SQLITE_TIMEOUT_MS = 1500

type LaunchMeta = {
  agent?: AgentName | null
  command?: string | null
  cwd?: string | null
  startedAt?: number | null
  claudeSessionId?: string | null
  codexThreadId?: string | null
}

type ProcessTableEntry = {
  pid: number
  ppid: number
  command: string
}

type ClaudeSessionRecord = {
  pid?: number
  sessionId?: string
  cwd?: string
  startedAt?: number
}

type CodexThreadDiscoveryRow = {
  thread_id?: string | null
}

type OpenCodeSessionRow = {
  id?: string
  directory?: string
  title?: string
  time?: {
    created?: number
    updated?: number
    compacting?: number
  }
}

type PiSessionRow = {
  path: string
  id: string
  cwd: string
  created: Date
  modified: Date
}

type RefreshContext = {
  processTable: ProcessTableEntry[]
}

type ClaudeAttachment = {
  kind: 'claude'
  key: string
  watcher: fs.FSWatcher | null
  close: () => void
}

type CodexPendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type CodexAttachment = {
  kind: 'codex'
  key: string
  child: ChildProcessWithoutNullStreams
  output: ReadLineInterface
  pending: Map<number, CodexPendingRequest>
  nextRequestId: number
  stopped: boolean
  close: () => void
}

type OpenCodeAttachment = {
  kind: 'opencode'
  key: string
  watcher: Promise<void>
  close: () => void
}

type PiAttachment = {
  kind: 'pi'
  key: string
  watcher: fs.FSWatcher | null
  close: () => void
}

type ProviderAttachment = ClaudeAttachment | CodexAttachment | OpenCodeAttachment | PiAttachment

type CodexThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags?: string[] }

let claudeSdkPromise: Promise<typeof import('@anthropic-ai/claude-agent-sdk')> | null = null
let openCodeSdkPromise: Promise<typeof import('@opencode-ai/sdk')> | null = null
let piSdkPromise: Promise<typeof import('@mariozechner/pi-coding-agent')> | null = null

export interface TerminalStatusMonitorOptions {
  getDaemonClient: () => PtyDaemonClient | null
  getFallbackSessions: () => TerminalSessionManager | null
  getUseDaemon: () => boolean
  onStatus: (termId: string, status: TerminalRuntimeStatus | null) => void
}

function sameStatus(
  a: TerminalRuntimeStatus | null | undefined,
  b: TerminalRuntimeStatus | null | undefined,
) {
  return (
    (a?.kind ?? null) === (b?.kind ?? null) &&
    (a?.agent ?? null) === (b?.agent ?? null) &&
    (a?.state ?? null) === (b?.state ?? null) &&
    (a?.detail ?? '') === (b?.detail ?? '') &&
    (a?.shortLabel ?? '') === (b?.shortLabel ?? '') &&
    (a?.source ?? '') === (b?.source ?? '') &&
    (a?.pid ?? null) === (b?.pid ?? null) &&
    (a?.processLabel ?? null) === (b?.processLabel ?? null)
  )
}

function execFileText(
  file: string,
  args: string[],
  options: {
    timeout?: number
    maxBuffer?: number
  } = {},
) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: options.timeout ?? SQLITE_TIMEOUT_MS,
        maxBuffer: options.maxBuffer,
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout ?? '')
      },
    )
  })
}

async function loadClaudeSdk() {
  if (!claudeSdkPromise) {
    claudeSdkPromise = import('@anthropic-ai/claude-agent-sdk')
  }
  return claudeSdkPromise
}

async function loadOpenCodeSdk() {
  if (!openCodeSdkPromise) {
    openCodeSdkPromise = import('@opencode-ai/sdk')
  }
  return openCodeSdkPromise
}

async function loadPiSdk() {
  if (!piSdkPromise) {
    piSdkPromise = import('@mariozechner/pi-coding-agent')
  }
  return piSdkPromise
}

async function readProcessTable(): Promise<ProcessTableEntry[]> {
  try {
    return (await execFileText('ps', ['-axo', 'pid=,ppid=,command=']))
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
      .filter((entry): entry is ProcessTableEntry => entry !== null)
  } catch {
    return []
  }
}

function basenameCommand(command: string) {
  const trimmed = command.trim()
  if (!trimmed) return ''
  const match = trimmed.match(/^(?:"[^"]+"|'[^']+'|\S+)/)
  const token = (match?.[0] ?? trimmed).replace(/^['"]|['"]$/g, '')
  return token.split('/').pop() ?? token
}

function firstCommandToken(command: string | null | undefined) {
  const trimmed = (command ?? '').trim()
  if (!trimmed) return null
  const match = trimmed.match(/^(?:"[^"]+"|'[^']+'|\S+)/)
  if (!match) return null
  return match[0].replace(/^['"]|['"]$/g, '')
}

function escapeSql(value: string) {
  return value.replace(/'/g, "''")
}

async function querySqliteJson<T>(dbPath: string, query: string): Promise<T[]> {
  if (!fs.existsSync(dbPath)) return []
  try {
    const output = (
      await execFileText('sqlite3', ['-json', dbPath, query], {
        timeout: SQLITE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 2,
      })
    ).trim()
    if (!output) return []
    const rows = JSON.parse(output)
    return Array.isArray(rows) ? (rows as T[]) : []
  } catch {
    return []
  }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function debounce<T extends (...args: never[]) => void>(fn: T, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, waitMs)
  }
}

function formatCommandLabel(command: string | null | undefined) {
  const normalized = (command ?? '').trim()
  if (!normalized) return null
  const withoutEnv = normalized.replace(
    /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))\s+)*/,
    '',
  )
  const parts = withoutEnv.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  if (parts.length === 0) return null
  const shortened = parts.slice(0, 3).map((part) => {
    const unquoted = part.replace(/^['"]|['"]$/g, '')
    if (unquoted.startsWith('/')) {
      return path.basename(unquoted)
    }
    return unquoted
  })
  return shortened.join(' ')
}

function buildProcessStatus(
  now: number,
  processInfo: TerminalProcessInfo,
  launch?: LaunchMeta | null,
): TerminalRuntimeStatus {
  return {
    kind: 'process',
    detail: 'Running',
    shortLabel: 'Running',
    source: 'process',
    pid: processInfo.pid,
    processLabel: formatCommandLabel(launch?.command ?? processInfo.command) ?? processInfo.label,
    updatedAt: now,
  }
}

function buildAgentStatus(
  now: number,
  agent: AgentName,
  state: AgentRuntimeState,
  source: string,
  pid?: number | null,
): TerminalRuntimeStatus {
  return {
    kind: 'agent',
    agent,
    state,
    detail:
      state === 'approval'
        ? 'Approval needed'
        : state === 'waiting'
          ? 'Waiting for input'
          : state === 'done'
            ? 'Done'
            : state === 'error'
              ? 'Error'
              : 'Working',
    shortLabel:
      state === 'approval'
        ? 'Approval'
        : state === 'waiting'
          ? 'Waiting'
          : state === 'done'
            ? 'Done'
            : state === 'error'
              ? 'Error'
              : 'Working',
    source,
    pid: pid ?? null,
    processLabel: null,
    updatedAt: now,
  }
}

export function getFallbackRuntimeState(agent: AgentName): AgentRuntimeState {
  return 'waiting'
}

function encodeClaudeProjectDir(cwd: string) {
  return cwd.replace(/[\\/]/g, '-').replace(/:/g, '-')
}

function getClaudeTranscriptPath(sessionId: string, cwd: string | null | undefined) {
  if (!cwd) return null
  return path.join(CLAUDE_HOME, 'projects', encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`)
}

function resolveDescendantPid(
  shellPid: number | null,
  agent: AgentName,
  processInfo: TerminalProcessInfo | null,
  processTable: ProcessTableEntry[],
) {
  if (processInfo && inferAgentFromCommand(processInfo.command) === agent) {
    return processInfo.pid
  }
  if (!shellPid) return processInfo?.pid ?? null
  if (processTable.length === 0) return processInfo?.pid ?? null

  const childrenByParent = new Map<number, ProcessTableEntry[]>()
  for (const process of processTable) {
    const children = childrenByParent.get(process.ppid) ?? []
    children.push(process)
    childrenByParent.set(process.ppid, children)
  }

  const queue = [...(childrenByParent.get(shellPid) ?? [])]
  let best: ProcessTableEntry | null = null

  while (queue.length > 0) {
    const current = queue.shift()!
    if (inferAgentFromCommand(current.command) === agent) {
      best = current
    }
    const children = childrenByParent.get(current.pid)
    if (children) queue.push(...children)
  }

  return (
    best?.pid ??
    (processInfo && inferAgentFromCommand(processInfo.command) === agent ? processInfo.pid : null)
  )
}

function inferAgent(
  processInfo: TerminalProcessInfo | null,
  launch?: LaunchMeta | null,
): AgentName | null {
  return (
    launch?.agent ??
    inferAgentFromCommand(launch?.command ?? '') ??
    inferAgentFromCommand(processInfo?.command ?? '') ??
    null
  )
}

function inferClaudeSessionId(launch?: LaunchMeta | null) {
  if (launch?.claudeSessionId) return launch.claudeSessionId
  const command = launch?.command ?? ''
  const match = command.match(/(?:^|\s)--session-id\s+([0-9a-fA-F-]{36})(?:\s|$)/)
  return match?.[1] ?? null
}

function inferClaudeModel(command?: string | null) {
  const match = (command ?? '').match(/(?:^|\s)--model\s+([^\s]+)/)
  return match?.[1] ?? 'sonnet'
}

function inferCodexThreadId(launch?: LaunchMeta | null) {
  return launch?.codexThreadId ?? null
}

async function discoverCodexThreadId(pid: number, launch?: LaunchMeta | null) {
  const launchThreadId = inferCodexThreadId(launch)
  if (launchThreadId) return launchThreadId
  const rows = await querySqliteJson<CodexThreadDiscoveryRow>(
    CODEX_LOGS_DB,
    `select thread_id from logs where process_uuid like 'pid:${pid}:%' and thread_id is not null order by ts desc, ts_nanos desc, id desc limit 10;`,
  )
  return rows.find((row) => row.thread_id)?.thread_id ?? null
}

function discoverClaudeSessionFromTranscripts(
  cwd: string | null | undefined,
  startedAt: number | null | undefined,
): { sessionId: string; cwd: string } | null {
  if (!cwd) return null
  const projectDir = path.join(CLAUDE_HOME, 'projects', encodeClaudeProjectDir(cwd))

  let files: Array<{ sessionId: string; mtimeMs: number }>
  try {
    if (!fs.existsSync(projectDir)) return null
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        try {
          const stat = fs.statSync(path.join(projectDir, f))
          return { sessionId: f.replace(/\.jsonl$/, ''), mtimeMs: stat.mtimeMs }
        } catch {
          return null
        }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)
  } catch {
    return null
  }

  if (files.length === 0) return null

  // If we know when the agent launched, prefer the transcript modified closest after that time.
  if (startedAt) {
    const recent = files
      .filter((f) => f.mtimeMs >= startedAt - 5000)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    if (recent.length > 0) {
      return { sessionId: recent[0].sessionId, cwd }
    }
  }

  // Otherwise pick the most recently modified transcript.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { sessionId: files[0].sessionId, cwd }
}

function readClaudeSessionRecord(pid: number, launch?: LaunchMeta | null) {
  // 1. Explicit --session-id flag in the command
  const inferredSessionId = inferClaudeSessionId(launch)
  if (inferredSessionId) {
    return {
      sessionId: inferredSessionId,
      cwd: launch?.cwd ?? null,
    }
  }

  // 2. PID-based session file (written by SDK-spawned sessions)
  const session = readJsonFile<ClaudeSessionRecord>(path.join(CLAUDE_SESSIONS_DIR, `${pid}.json`))
  if (session?.sessionId) return session

  // 3. Scan transcript directory for the most recent .jsonl matching the CWD
  return discoverClaudeSessionFromTranscripts(launch?.cwd, launch?.startedAt)
}

async function discoverOpenCodeSession(
  cwd: string,
  launch?: LaunchMeta | null,
): Promise<OpenCodeSessionRow | null> {
  const sdk = await loadOpenCodeSdk()
  const server = await sdk.createOpencodeServer()
  try {
    const client = sdk.createOpencodeClient({ baseUrl: server.url, directory: cwd })
    const response = await client.session.list({ query: { directory: cwd } })
    const sessions = Array.isArray(response.data) ? (response.data as OpenCodeSessionRow[]) : []
    if (sessions.length === 0) return null
    const chosen =
      launch?.startedAt != null
        ? [...sessions].sort((a, b) => {
            const aDistance = Math.abs((a.time?.created ?? 0) - launch.startedAt!)
            const bDistance = Math.abs((b.time?.created ?? 0) - launch.startedAt!)
            return aDistance - bDistance
          })[0]
        : [...sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0]
    return chosen ?? null
  } finally {
    server.close()
  }
}

async function discoverPiSession(
  cwd: string,
  launch?: LaunchMeta | null,
): Promise<PiSessionRow | null> {
  const sdk = await loadPiSdk()
  const response = await sdk.SessionManager.list(cwd)
  const sessions = Array.isArray(response) ? (response as PiSessionRow[]) : []
  if (sessions.length === 0) return null
  const chosen =
    launch?.startedAt != null
      ? [...sessions].sort((a, b) => {
          const aDistance = Math.abs(a.created.getTime() - launch.startedAt!)
          const bDistance = Math.abs(b.created.getTime() - launch.startedAt!)
          return aDistance - bDistance
        })[0]
      : [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime())[0]
  return chosen ?? null
}

export function classifyClaudeEntries(
  entries: Array<Record<string, unknown>>,
): AgentRuntimeState | null {
  let lastPermissionMode: string | null = null

  for (const entry of entries) {
    if (entry.type === 'user' && typeof entry.permissionMode === 'string') {
      lastPermissionMode = entry.permissionMode
    }
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.type === 'assistant') {
      const message =
        typeof entry.message === 'object' && entry.message !== null
          ? (entry.message as Record<string, unknown>)
          : null
      const stopReason = typeof message?.stop_reason === 'string' ? message.stop_reason : null
      if (stopReason === 'end_turn') return 'waiting'
      if (stopReason === 'tool_use') {
        return lastPermissionMode && lastPermissionMode !== 'bypassPermissions'
          ? 'approval'
          : 'working'
      }
      return 'working'
    }

    if (entry.type === 'user') {
      return 'working'
    }
  }

  return null
}

export function classifyClaudeSessionMessages(entries: SessionMessage[]): AgentRuntimeState | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.type === 'assistant') {
      const message =
        typeof entry.message === 'object' && entry.message !== null
          ? (entry.message as Record<string, unknown>)
          : null
      const stopReason =
        typeof message?.stop_reason === 'string'
          ? message.stop_reason
          : typeof message?.stopReason === 'string'
            ? message.stopReason
            : null
      if (stopReason === 'end_turn' || stopReason === 'stop') return 'waiting'
      return 'working'
    }

    if (entry.type === 'user') {
      return 'working'
    }
  }

  return null
}

export function classifyCodexLogBody(
  body: string,
  _approvalMode: string | null,
): AgentRuntimeState | null {
  if (!body) return null
  if (body.includes('app-server event: turn/completed')) return 'waiting'
  if (body.includes('app-server event: item/started')) return 'working'
  return null
}

export function classifyOpenCodePartData(data: string): AgentRuntimeState | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    const type = typeof parsed.type === 'string' ? parsed.type : null
    if (type === 'step-finish') {
      const reason = typeof parsed.reason === 'string' ? parsed.reason : null
      if (reason === 'stop') return 'waiting'
      if (reason === 'tool-calls') return 'working'
    }
    if (type === 'step-start') return 'working'
    if (type === 'tool') {
      const state =
        typeof parsed.state === 'object' && parsed.state !== null
          ? (parsed.state as Record<string, unknown>)
          : null
      const status = typeof state?.status === 'string' ? state.status : null
      if (status === 'completed' || status === 'running') return 'working'
      if (status === 'pending-approval' || status === 'approval-required') return 'approval'
    }
  } catch {}

  return null
}

export function mapOpenCodeSessionStatus(
  status:
    | {
        type?: string
        attempt?: number
        message?: string
        next?: number
      }
    | null
    | undefined,
): AgentRuntimeState | null {
  if (!status?.type) return null
  if (status.type === 'idle') return 'waiting'
  if (status.type === 'busy' || status.type === 'retry') return 'working'
  return null
}

export function classifyPiSessionEntries(
  entries: Array<Record<string, unknown> | { [key: string]: unknown }>,
): AgentRuntimeState | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.type !== 'message') continue
    const message =
      typeof entry.message === 'object' && entry.message !== null
        ? (entry.message as Record<string, unknown>)
        : null
    const role = typeof message?.role === 'string' ? message.role : null
    if (role === 'user') return 'working'
    if (role === 'assistant') {
      const stopReason = typeof message?.stopReason === 'string' ? message.stopReason : null
      if (stopReason === 'stop' || stopReason === 'end_turn') return 'waiting'
      return 'working'
    }
  }

  return null
}

export function classifyAgentOutputActivity(
  _agent: AgentName,
  _chunk: string,
): AgentRuntimeState | null {
  return null
}

export function mapClaudeSdkMessageState(message: SDKMessage): AgentRuntimeState | null {
  if (message.type === 'system' && message.subtype === 'session_state_changed') {
    if (message.state === 'running') return 'working'
    if (message.state === 'requires_action') return 'approval'
    if (message.state === 'idle') return 'waiting'
  }

  if (message.type === 'system' && message.subtype === 'status') {
    return message.status === 'compacting' ? 'working' : null
  }

  if (message.type === 'system' && message.subtype === 'task_started') {
    return 'working'
  }

  if (message.type === 'system' && message.subtype === 'task_progress') {
    return 'working'
  }

  if (message.type === 'tool_progress') {
    return 'working'
  }

  if (message.type === 'result') {
    return message.subtype === 'success' && !message.is_error ? 'waiting' : 'error'
  }

  return null
}

export function mapCodexThreadStatusState(status: CodexThreadStatus | null | undefined) {
  if (!status) return null
  if (status.type === 'systemError') return 'error'
  if (status.type === 'idle') return 'waiting'
  if (status.type !== 'active') return null
  if (status.activeFlags?.includes('waitingOnApproval')) return 'approval'
  if (status.activeFlags?.includes('waitingOnUserInput')) return 'waiting'
  return 'working'
}

export function mapCodexAppServerEventState(
  method: string,
  params: Record<string, unknown> | null | undefined,
): AgentRuntimeState | null {
  if (method === 'thread/status/changed') {
    return mapCodexThreadStatusState((params?.status as CodexThreadStatus | undefined) ?? null)
  }

  if (method === 'turn/started') return 'working'

  if (method === 'turn/completed') {
    const turn =
      typeof params?.turn === 'object' && params.turn !== null
        ? (params.turn as Record<string, unknown>)
        : null
    const status = typeof turn?.status === 'string' ? turn.status : null
    if (status === 'failed') return 'error'
    return 'waiting'
  }

  if (method === 'thread/closed') return 'done'

  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval' ||
    method === 'applyPatchApproval' ||
    method === 'execCommandApproval'
  ) {
    return 'approval'
  }

  if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
    return 'waiting'
  }

  return null
}

function extractRouteThreadId(params: Record<string, unknown> | null | undefined) {
  if (!params) return null
  if (typeof params.threadId === 'string') return params.threadId
  const thread =
    typeof params.thread === 'object' && params.thread !== null
      ? (params.thread as Record<string, unknown>)
      : null
  if (thread && typeof thread.id === 'string') return thread.id
  return null
}

export class TerminalStatusMonitor {
  private readonly knownTermIds = new Set<string>()
  private readonly statuses = new Map<string, TerminalRuntimeStatus | null>()
  private readonly launchMeta = new Map<string, LaunchMeta>()
  private readonly providerAttachments = new Map<string, ProviderAttachment>()
  private readonly providerAttachPromises = new Map<string, Promise<void>>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private refreshPromise: Promise<void> | null = null
  private readonly options: TerminalStatusMonitorOptions

  constructor(options: TerminalStatusMonitorOptions) {
    this.options = options
  }

  trackTerminal(termId: string, launch?: LaunchMeta | null) {
    this.knownTermIds.add(termId)
    if (launch) {
      const previous = this.launchMeta.get(termId) ?? {}
      this.launchMeta.set(termId, { ...previous, ...launch })
    }
    this.ensurePolling()
    void this.refreshTerm(termId)
  }

  setLaunchMeta(termId: string, launch: LaunchMeta) {
    this.trackTerminal(termId, launch)
  }

  forgetTerminal(termId: string) {
    this.knownTermIds.delete(termId)
    this.launchMeta.delete(termId)
    this.disposeProviderAttachment(termId)
    this.providerAttachPromises.delete(termId)
    this.statuses.delete(termId)
    if (this.knownTermIds.size === 0) {
      this.stop()
    }
  }

  async getStatus(termId: string) {
    this.trackTerminal(termId)
    const context = await this.createRefreshContext()
    await this.refreshTerm(termId, context)
    return this.statuses.get(termId) ?? null
  }

  handleTerminalExit(termId: string, details?: TerminalExitDetails) {
    const previous = this.statuses.get(termId)
    const agent =
      previous?.kind === 'agent'
        ? (previous.agent ?? null)
        : inferAgent(null, this.launchMeta.get(termId))
    const now = Date.now()
    const finalStatus: TerminalRuntimeStatus | null = agent
      ? buildAgentStatus(
          now,
          agent,
          details?.reason === 'daemon-disconnect' ? 'error' : 'done',
          details?.reason ? `exit:${details.reason}` : 'exit',
          previous?.pid ?? null,
        )
      : null
    this.disposeProviderAttachment(termId)
    this.commitStatus(termId, finalStatus)
  }

  handleTerminalData(_termId: string, _data: string) {}

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    for (const termId of [...this.providerAttachments.keys()]) {
      this.disposeProviderAttachment(termId)
    }
  }

  private ensurePolling() {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.refreshAll()
    }, POLL_INTERVAL_MS)
  }

  private async refreshAll() {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = (async () => {
      const context = await this.createRefreshContext()
      await Promise.all([...this.knownTermIds].map((termId) => this.refreshTerm(termId, context)))
    })().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  private async refreshTerm(termId: string, context?: RefreshContext) {
    try {
      const nextStatus = await this.resolveTerminalStatus(
        termId,
        context ?? (await this.createRefreshContext()),
      )
      this.commitStatus(termId, nextStatus)
    } catch {
      // If resolution throws (SDK import failure, network error, etc.),
      // emit a default 'working' status for known agents so the UI
      // doesn't stay stuck on "Detecting session".
      const launch = this.launchMeta.get(termId)
      const agent = launch?.agent ?? null
      if (agent) {
        const previous = this.statuses.get(termId)
        if (!previous || previous.kind !== 'agent') {
          this.commitStatus(
            termId,
            buildAgentStatus(Date.now(), agent, 'working', 'process:fallback', null),
          )
        }
      }
    }
  }

  private async createRefreshContext(): Promise<RefreshContext> {
    return {
      processTable: await readProcessTable(),
    }
  }

  private commitStatus(termId: string, nextStatus: TerminalRuntimeStatus | null) {
    const previous = this.statuses.get(termId)
    if (sameStatus(previous, nextStatus)) return
    this.statuses.set(termId, nextStatus)
    this.options.onStatus(termId, nextStatus)
  }

  private async getProcessInfo(termId: string) {
    try {
      if (this.options.getUseDaemon()) {
        const daemon = this.options.getDaemonClient()
        if (daemon?.isConnected()) {
          return await daemon.getProcessInfo(termId)
        }
      }
      return this.options.getFallbackSessions()?.getProcessInfo(termId) ?? null
    } catch {
      return null
    }
  }

  private async getShellPid(termId: string) {
    try {
      if (this.options.getUseDaemon()) {
        const daemon = this.options.getDaemonClient()
        if (daemon?.isConnected()) {
          return await daemon.getShellPid(termId)
        }
      }
      return this.options.getFallbackSessions()?.getShellPid(termId) ?? null
    } catch {
      return null
    }
  }

  private disposeProviderAttachment(termId: string) {
    const attachment = this.providerAttachments.get(termId)
    if (!attachment) return
    this.providerAttachments.delete(termId)
    try {
      attachment.close()
    } catch {}
  }

  private async ensureClaudeAttachment(
    termId: string,
    sessionId: string,
    agentPid: number | null,
    launch: LaunchMeta | null,
    sessionCwd: string | null,
  ) {
    const existing = this.providerAttachments.get(termId)
    if (existing?.kind === 'claude' && existing.key === sessionId) return

    const inFlight = this.providerAttachPromises.get(termId)
    if (inFlight) return inFlight

    const attachPromise = (async () => {
      this.disposeProviderAttachment(termId)
      const sdk = await loadClaudeSdk()
      const refresh = debounce(async () => {
        const current = this.providerAttachments.get(termId)
        if (!current || current.kind !== 'claude' || current.key !== sessionId) return
        try {
          const messages = await sdk.getSessionMessages(sessionId, {
            dir: sessionCwd ?? launch?.cwd ?? undefined,
            includeSystemMessages: true,
          })
          const state = classifyClaudeSessionMessages(messages)
          if (!state) return
          this.commitStatus(
            termId,
            buildAgentStatus(Date.now(), 'claude', state, 'claude:sdk', agentPid),
          )
        } catch {
          const live = this.providerAttachments.get(termId)
          if (live && live.kind === 'claude' && live.key === sessionId) {
            this.commitStatus(
              termId,
              buildAgentStatus(Date.now(), 'claude', 'error', 'claude:sdk-error', agentPid),
            )
          }
        }
      }, 80)

      const transcriptPath = getClaudeTranscriptPath(sessionId, sessionCwd ?? launch?.cwd ?? null)
      let watcher: fs.FSWatcher | null = null
      if (transcriptPath && fs.existsSync(transcriptPath)) {
        watcher = fs.watch(transcriptPath, () => {
          void refresh()
        })
      }

      let closed = false
      const attachment: ClaudeAttachment = {
        kind: 'claude',
        key: sessionId,
        watcher,
        close: () => {
          if (closed) return
          closed = true
          try {
            watcher?.close()
          } catch {}
        },
      }
      this.providerAttachments.set(termId, attachment)
      await refresh()
    })()
      .catch(() => {
        this.commitStatus(
          termId,
          buildAgentStatus(Date.now(), 'claude', 'error', 'claude:sdk-error', agentPid),
        )
      })
      .finally(() => {
        this.providerAttachPromises.delete(termId)
      })

    this.providerAttachPromises.set(termId, attachPromise)
    return attachPromise
  }

  private async ensureCodexAttachment(termId: string, threadId: string, agentPid: number | null) {
    const existing = this.providerAttachments.get(termId)
    if (existing?.kind === 'codex' && existing.key === threadId) return

    const inFlight = this.providerAttachPromises.get(termId)
    if (inFlight) return inFlight

    const attachPromise = (async () => {
      this.disposeProviderAttachment(termId)

      const child = spawn('codex', ['app-server'], {
        cwd: this.launchMeta.get(termId)?.cwd ?? process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      })
      const output = readline.createInterface({ input: child.stdout })
      const attachment: CodexAttachment = {
        kind: 'codex',
        key: threadId,
        child,
        output,
        pending: new Map(),
        nextRequestId: 1,
        stopped: false,
        close: () => {
          if (attachment.stopped) return
          attachment.stopped = true
          try {
            output.close()
          } catch {}
          try {
            child.kill()
          } catch {}
          for (const pending of attachment.pending.values()) {
            pending.reject(new Error('Codex app-server session closed'))
          }
          attachment.pending.clear()
        },
      }

      this.providerAttachments.set(termId, attachment)
      this.attachCodexListeners(termId, attachment, agentPid)
      await this.sendCodexRequest(attachment, 'initialize', {
        clientInfo: {
          name: 'cells',
          version: '0.0.0',
        },
        capabilities: null,
      })
      this.writeCodexMessage(attachment, { method: 'initialized' })
      const resumeResult = (await this.sendCodexRequest(attachment, 'thread/resume', {
        threadId,
        persistExtendedHistory: false,
      })) as Record<string, unknown> | null
      const thread =
        resumeResult && typeof resumeResult.thread === 'object' && resumeResult.thread !== null
          ? (resumeResult.thread as Record<string, unknown>)
          : null
      const status =
        thread && typeof thread.status === 'object' && thread.status !== null
          ? (thread.status as CodexThreadStatus)
          : null
      const state = mapCodexThreadStatusState(status)
      if (state) {
        this.commitStatus(
          termId,
          buildAgentStatus(Date.now(), 'codex', state, 'codex:app-server', agentPid),
        )
      }
    })()
      .catch((error) => {
        this.commitStatus(
          termId,
          buildAgentStatus(Date.now(), 'codex', 'error', 'codex:app-server-error', agentPid),
        )
        throw error
      })
      .finally(() => {
        this.providerAttachPromises.delete(termId)
      })

    this.providerAttachPromises.set(termId, attachPromise)
    return attachPromise
  }

  private attachCodexListeners(
    termId: string,
    attachment: CodexAttachment,
    agentPid: number | null,
  ) {
    attachment.output.on('line', (line) => {
      this.handleCodexStdoutLine(termId, attachment, line, agentPid)
    })
    attachment.child.on('exit', () => {
      const current = this.providerAttachments.get(termId)
      if (current !== attachment) return
      this.commitStatus(
        termId,
        buildAgentStatus(Date.now(), 'codex', 'error', 'codex:app-server-exit', agentPid),
      )
    })
  }

  private handleCodexStdoutLine(
    termId: string,
    attachment: CodexAttachment,
    line: string,
    agentPid: number | null,
  ) {
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }

    if (!parsed) return

    if (
      (typeof parsed.id === 'number' || typeof parsed.id === 'string') &&
      typeof parsed.method !== 'string'
    ) {
      const requestId =
        typeof parsed.id === 'number' ? parsed.id : Number.parseInt(String(parsed.id), 10)
      const pending = attachment.pending.get(requestId)
      if (!pending) return
      attachment.pending.delete(requestId)
      if ('error' in parsed && parsed.error) {
        pending.reject(new Error(String(parsed.error)))
      } else {
        pending.resolve(parsed.result)
      }
      return
    }

    if (typeof parsed.method !== 'string') return
    const method = parsed.method
    const params =
      typeof parsed.params === 'object' && parsed.params !== null
        ? (parsed.params as Record<string, unknown>)
        : null

    if ('id' in parsed) {
      const state = mapCodexAppServerEventState(method, params)
      if (!state) return
      this.commitStatus(
        termId,
        buildAgentStatus(Date.now(), 'codex', state, 'codex:app-server', agentPid),
      )
      return
    }

    const threadId = extractRouteThreadId(params)
    if (threadId && threadId !== attachment.key) return

    const state = mapCodexAppServerEventState(method, params)
    if (!state) return
    this.commitStatus(
      termId,
      buildAgentStatus(Date.now(), 'codex', state, 'codex:app-server', agentPid),
    )
  }

  private writeCodexMessage(attachment: CodexAttachment, message: Record<string, unknown>) {
    if (attachment.stopped) return
    attachment.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private sendCodexRequest(
    attachment: CodexAttachment,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const requestId = attachment.nextRequestId++
    return new Promise((resolve, reject) => {
      attachment.pending.set(requestId, { resolve, reject })
      this.writeCodexMessage(attachment, { id: requestId, method, params })
    })
  }

  private async ensureOpenCodeAttachment(
    termId: string,
    sessionId: string,
    cwd: string,
    agentPid: number | null,
  ) {
    const existing = this.providerAttachments.get(termId)
    if (existing?.kind === 'opencode' && existing.key === sessionId) return

    const inFlight = this.providerAttachPromises.get(termId)
    if (inFlight) return inFlight

    const attachPromise = (async () => {
      this.disposeProviderAttachment(termId)
      const sdk = await loadOpenCodeSdk()
      const server = await sdk.createOpencodeServer()
      const client = sdk.createOpencodeClient({ baseUrl: server.url, directory: cwd })

      const refresh = async () => {
        const current = this.providerAttachments.get(termId)
        if (!current || current.kind !== 'opencode' || current.key !== sessionId) return
        const response = await client.session.status({ query: { directory: cwd } })
        const record =
          response.data && typeof response.data === 'object'
            ? (response.data as Record<string, { type?: string }>)
            : {}
        const state = mapOpenCodeSessionStatus(record[sessionId] ?? { type: 'idle' })
        if (!state) return
        this.commitStatus(
          termId,
          buildAgentStatus(Date.now(), 'opencode', state, 'opencode:sdk', agentPid),
        )
      }

      const events = await client.event.subscribe()
      const attachment: OpenCodeAttachment = {
        kind: 'opencode',
        key: sessionId,
        watcher: (async () => {
          for await (const event of events.stream) {
            const current = this.providerAttachments.get(termId)
            if (current?.kind !== 'opencode' || current.key !== sessionId) break
            if (event.type === 'session.status' && event.properties.sessionID === sessionId) {
              const state = mapOpenCodeSessionStatus(event.properties.status)
              if (state) {
                this.commitStatus(
                  termId,
                  buildAgentStatus(Date.now(), 'opencode', state, 'opencode:sdk', agentPid),
                )
              }
              continue
            }
            if (event.type === 'session.idle' && event.properties.sessionID === sessionId) {
              this.commitStatus(
                termId,
                buildAgentStatus(Date.now(), 'opencode', 'waiting', 'opencode:sdk', agentPid),
              )
              continue
            }
            if (event.type === 'session.error' && event.properties.sessionID === sessionId) {
              this.commitStatus(
                termId,
                buildAgentStatus(Date.now(), 'opencode', 'error', 'opencode:sdk', agentPid),
              )
            }
          }
        })(),
        close: () => {
          server.close()
        },
      }
      this.providerAttachments.set(termId, attachment)
      await refresh()
    })()
      .catch(() => {
        this.commitStatus(
          termId,
          buildAgentStatus(Date.now(), 'opencode', 'error', 'opencode:sdk-error', agentPid),
        )
      })
      .finally(() => {
        this.providerAttachPromises.delete(termId)
      })

    this.providerAttachPromises.set(termId, attachPromise)
    return attachPromise
  }

  private async ensurePiAttachment(termId: string, sessionFile: string, agentPid: number | null) {
    const existing = this.providerAttachments.get(termId)
    if (existing?.kind === 'pi' && existing.key === sessionFile) return

    const inFlight = this.providerAttachPromises.get(termId)
    if (inFlight) return inFlight

    const attachPromise = (async () => {
      this.disposeProviderAttachment(termId)
      const sdk = await loadPiSdk()
      const refresh = debounce(() => {
        const current = this.providerAttachments.get(termId)
        if (!current || current.kind !== 'pi' || current.key !== sessionFile) return
        try {
          const content = fs.readFileSync(sessionFile, 'utf8')
          const entries = sdk.parseSessionEntries(content) as unknown as Array<
            Record<string, unknown>
          >
          const state = classifyPiSessionEntries(entries) ?? 'waiting'
          this.commitStatus(termId, buildAgentStatus(Date.now(), 'pi', state, 'pi:sdk', agentPid))
        } catch {
          this.commitStatus(
            termId,
            buildAgentStatus(Date.now(), 'pi', 'error', 'pi:sdk-error', agentPid),
          )
        }
      }, 80)

      const watcher = fs.existsSync(sessionFile)
        ? fs.watch(sessionFile, () => {
            refresh()
          })
        : null
      const attachment: PiAttachment = {
        kind: 'pi',
        key: sessionFile,
        watcher,
        close: () => {
          try {
            watcher?.close()
          } catch {}
        },
      }
      this.providerAttachments.set(termId, attachment)
      refresh()
    })()
      .catch(() => {
        this.commitStatus(
          termId,
          buildAgentStatus(Date.now(), 'pi', 'error', 'pi:sdk-error', agentPid),
        )
      })
      .finally(() => {
        this.providerAttachPromises.delete(termId)
      })

    this.providerAttachPromises.set(termId, attachPromise)
    return attachPromise
  }

  private async resolveTerminalStatus(
    termId: string,
    context: RefreshContext,
  ): Promise<TerminalRuntimeStatus | null> {
    const launch = this.launchMeta.get(termId) ?? null
    const processInfo = await this.getProcessInfo(termId)
    const previous = this.statuses.get(termId) ?? null

    if (!processInfo || processInfo.isShell) {
      const launchAgent = launch?.agent ?? null
      const previousAgent = previous?.kind === 'agent' ? (previous.agent ?? null) : null
      const isShell = processInfo?.isShell ?? false

      // A different agent is registered — user switched CLIs (e.g. Ctrl+C codex → claude)
      if (launchAgent && launchAgent !== previousAgent) {
        this.disposeProviderAttachment(termId)
        return buildAgentStatus(Date.now(), launchAgent, 'working', 'process:launching', null)
      }

      // Shell confirmed foreground and agent was active → agent exited (Ctrl+C, /exit, etc.)
      if (isShell && previous?.kind === 'agent' && previousAgent) {
        this.disposeProviderAttachment(termId)
        // Clear launch agent so subsequent polls don't re-trigger the badge
        if (launch && launch.agent === previousAgent) {
          this.launchMeta.set(termId, { ...launch, agent: null })
        }
        return null
      }

      // processInfo temporarily unavailable but agent was active → preserve status
      if (!isShell && previous?.kind === 'agent') {
        return previous
      }

      // No prior agent status, but a launch is pending — agent about to spawn
      if (launchAgent) {
        return buildAgentStatus(Date.now(), launchAgent, 'working', 'process:launching', null)
      }

      return null
    }

    const agent = inferAgent(processInfo, launch)
    if (!agent) {
      return buildProcessStatus(Date.now(), processInfo, launch)
    }

    if (agent === 'claude') {
      return this.resolveClaudeStatus(termId, processInfo, launch, context, previous)
    }

    if (agent === 'codex') {
      return this.resolveCodexStatus(termId, processInfo, launch, context, previous)
    }

    if (agent === 'opencode') {
      return this.resolveOpenCodeStatus(termId, launch, processInfo)
    }

    if (agent === 'pi') {
      return this.resolvePiStatus(termId, launch, processInfo)
    }

    return buildProcessStatus(Date.now(), processInfo, launch)
  }

  private async resolveClaudeStatus(
    termId: string,
    processInfo: TerminalProcessInfo,
    launch: LaunchMeta | null,
    context: RefreshContext,
    previous: TerminalRuntimeStatus | null,
  ) {
    const shellPid = await this.getShellPid(termId)
    const agentPid = resolveDescendantPid(shellPid, 'claude', processInfo, context.processTable)
    if (!agentPid) {
      return previous?.kind === 'agent' && previous.agent === 'claude' ? previous : null
    }

    // Try fast sync discovery (--session-id flag, PID file, transcript scan)
    let session = readClaudeSessionRecord(agentPid, launch)

    // Async fallback: use SDK listSessions to find the active session by CWD
    if (!session?.sessionId && launch?.cwd) {
      try {
        const sdk = await loadClaudeSdk()
        const sessions = await sdk.listSessions({ dir: launch.cwd })
        if (sessions.length > 0) {
          // Sort by most recently modified first
          const sorted = [...sessions].sort(
            (a: { lastModified: number }, b: { lastModified: number }) =>
              b.lastModified - a.lastModified,
          )
          // If we know the launch time, prefer the session created around then
          if (launch.startedAt) {
            const match = sorted.find(
              (s: { createdAt: number }) => s.createdAt >= launch.startedAt! - 10_000,
            )
            if (match) {
              session = { sessionId: (match as { sessionId: string }).sessionId, cwd: launch.cwd }
            }
          }
          if (!session?.sessionId) {
            session = { sessionId: (sorted[0] as { sessionId: string }).sessionId, cwd: launch.cwd }
          }
        }
      } catch {
        // SDK not available or listSessions failed — continue with fallback
      }
    }

    if (!session?.sessionId) {
      // Agent process alive but session not discoverable yet — show working.
      return previous?.kind === 'agent' && previous.agent === 'claude'
        ? previous
        : buildAgentStatus(Date.now(), 'claude', 'working', 'process:claude', agentPid)
    }

    await this.ensureClaudeAttachment(
      termId,
      session.sessionId,
      agentPid,
      launch,
      session.cwd ?? launch?.cwd ?? null,
    )

    const live = this.statuses.get(termId) ?? null
    if (live?.kind === 'agent' && live.agent === 'claude') {
      return {
        ...live,
        pid: agentPid,
      }
    }

    // Attachment created but SDK hasn't reported state yet — show working.
    return previous?.kind === 'agent' && previous.agent === 'claude'
      ? previous
      : buildAgentStatus(Date.now(), 'claude', 'working', 'process:claude', agentPid)
  }

  private async resolveCodexStatus(
    termId: string,
    processInfo: TerminalProcessInfo,
    launch: LaunchMeta | null,
    context: RefreshContext,
    previous: TerminalRuntimeStatus | null,
  ) {
    const shellPid = await this.getShellPid(termId)
    const agentPid = resolveDescendantPid(shellPid, 'codex', processInfo, context.processTable)
    if (!agentPid) {
      return previous?.kind === 'agent' && previous.agent === 'codex' ? previous : null
    }

    const threadId = await discoverCodexThreadId(agentPid, launch)
    if (!threadId) {
      // Agent process alive but thread not discoverable yet — show working.
      return previous?.kind === 'agent' && previous.agent === 'codex'
        ? previous
        : buildAgentStatus(Date.now(), 'codex', 'working', 'process:codex', agentPid)
    }

    await this.ensureCodexAttachment(termId, threadId, agentPid)

    const live = this.statuses.get(termId) ?? null
    if (live?.kind === 'agent' && live.agent === 'codex') {
      return {
        ...live,
        pid: agentPid,
      }
    }

    // Attachment created but app-server hasn't reported state yet — show working.
    return previous?.kind === 'agent' && previous.agent === 'codex'
      ? previous
      : buildAgentStatus(Date.now(), 'codex', 'working', 'process:codex', agentPid)
  }

  private async resolveOpenCodeStatus(
    termId: string,
    launch: LaunchMeta | null,
    processInfo: TerminalProcessInfo | null,
  ) {
    const cwd = launch?.cwd ?? null
    const previous = this.statuses.get(termId) ?? null
    const pid = processInfo?.pid ?? null
    const fallback = () =>
      previous?.kind === 'agent' && previous.agent === 'opencode'
        ? previous
        : buildAgentStatus(Date.now(), 'opencode', 'working', 'process:opencode', pid)

    if (!cwd) return fallback()

    let session: OpenCodeSessionRow | null = null
    try {
      session = await discoverOpenCodeSession(cwd, launch)
    } catch {
      return fallback()
    }

    if (!session?.id) return fallback()

    await this.ensureOpenCodeAttachment(termId, session.id, cwd, pid)
    const live = this.statuses.get(termId) ?? null
    if (live?.kind === 'agent' && live.agent === 'opencode') {
      return {
        ...live,
        pid,
      }
    }

    return previous?.kind === 'agent' && previous.agent === 'opencode'
      ? previous
      : buildAgentStatus(Date.now(), 'opencode', 'working', 'process:opencode', pid)
  }

  private async resolvePiStatus(
    termId: string,
    launch: LaunchMeta | null,
    processInfo: TerminalProcessInfo | null,
  ) {
    const cwd = launch?.cwd ?? null
    const previous = this.statuses.get(termId) ?? null
    const pid = processInfo?.pid ?? null
    const fallback = () =>
      previous?.kind === 'agent' && previous.agent === 'pi'
        ? previous
        : buildAgentStatus(Date.now(), 'pi', 'working', 'process:pi', pid)

    if (!cwd) return fallback()

    let session: PiSessionRow | null = null
    try {
      session = await discoverPiSession(cwd, launch)
    } catch {
      return fallback()
    }

    if (!session?.path || !session.id) return fallback()

    await this.ensurePiAttachment(termId, session.path, pid)
    const live = this.statuses.get(termId) ?? null
    if (live?.kind === 'agent' && live.agent === 'pi') {
      return {
        ...live,
        pid,
      }
    }

    return previous?.kind === 'agent' && previous.agent === 'pi'
      ? previous
      : buildAgentStatus(Date.now(), 'pi', 'working', 'process:pi', pid)
  }
}
