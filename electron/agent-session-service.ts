import { EventEmitter } from 'node:events'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs, existsSync, mkdirSync, readFileSync, type Dirent } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import * as path from 'node:path'
import { app, shell } from 'electron'
import {
  query,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKMessage,
  type SDKSession,
} from '@anthropic-ai/claude-agent-sdk'
import { Codex, type Thread, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk'
import type {
  AgentSessionMessage,
  AgentSessionRequest,
  AgentSessionSnapshot,
  AgentThinkingLevel,
} from '../src/types'

// Maps Cells's portable 5-tier thinking level onto each backend's primitive.
// Mirrors Craft's THINKING_TO_EFFORT — ../craft-agents-oss/packages/shared/src/agent/thinking-levels.ts.
//   Claude — uses adaptive thinking config + effort ('off' → disabled).
//   Codex  — maps to `modelReasoningEffort` ('off' → 'minimal' per Codex SDK).
function claudeThinkingOptions(level: AgentThinkingLevel | null | undefined, model: string) {
  const isHaiku = /haiku/i.test(model)
  const effortMap: Record<
    Exclude<AgentThinkingLevel, 'off'>,
    'low' | 'medium' | 'high' | 'xhigh' | 'max'
  > = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'max',
    xhigh: 'xhigh',
  }
  if (!level || level === 'off') {
    return isHaiku ? { maxThinkingTokens: 0 as const } : { thinking: { type: 'disabled' as const } }
  }
  if (isHaiku) {
    const budgets: Record<Exclude<AgentThinkingLevel, 'off'>, number> = {
      low: 2000,
      medium: 4000,
      high: 6000,
      max: 8000,
      xhigh: 8000,
    }
    return { maxThinkingTokens: budgets[level] }
  }
  return { thinking: { type: 'adaptive' as const }, effort: effortMap[level] }
}

function codexThinkingEffort(
  level: AgentThinkingLevel | null | undefined,
): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  switch (level) {
    case 'off':
      return 'minimal'
    case 'low':
      return 'low'
    case 'high':
      return 'high'
    case 'max':
    case 'xhigh':
      return 'xhigh'
    case 'medium':
    default:
      return 'medium'
  }
}

// Copied and adapted from Craft Agents OSS session runtime flow:
// ../craft-agents-oss/packages/server-core/src/sessions/SessionManager.ts
// ../craft-agents-oss/packages/server-core/src/handlers/rpc/sessions.ts

// Matches Craft's authoritative model list — ../craft-agents-oss/packages/shared/src/config/models.ts
const DEFAULT_CLAUDE_MODEL = process.env.CELLS_CLAUDE_MODEL || 'claude-sonnet-4-6'

// Claude Agent SDK beta flag that opts the prompt into the 1M-token context
// window. Documented in `@anthropic-ai/claude-agent-sdk` as `SdkBeta =
// 'context-1m-2025-08-07'` and only applies to Sonnet 4 / 4.5. Passed via
// `SDKSessionOptions.betas`.
const CLAUDE_CONTEXT_1M_BETA = 'context-1m-2025-08-07' as const

// Fold legacy ('safe' / 'allow-all') values from older saved sessions into
// the current 3-mode set so the rest of the service only has to reason about
// 'plan' | 'ask' | 'bypass'.
function normalizePermissionMode(
  mode: AgentSessionRequest['permissionMode'] | 'safe' | 'allow-all' | null | undefined,
): AgentSessionRequest['permissionMode'] {
  if (mode === 'safe') return 'plan'
  if (mode === 'allow-all') return 'ask'
  return (mode ?? null) as AgentSessionRequest['permissionMode']
}

// Codex SDK doesn't surface per-model context windows, so we use a known
// GPT-5 family capacity (272k input tokens per the public API) as the
// denominator for the % indicator. Good enough for a rough readout.
const CODEX_DEFAULT_CONTEXT_WINDOW = 272_000

// Extensions Anthropic accepts as image content blocks.
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function imageMediaType(filePath: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

type ClaudeImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
type ClaudeImageBlock = {
  type: 'image'
  source: { type: 'base64'; media_type: ClaudeImageMediaType; data: string }
}

// Read local image files and wrap them as Anthropic image content blocks.
// The Claude Agent SDK's `session.send(SDKUserMessage)` path forwards
// `message.content` straight to the Messages API, so base64 source is the
// simplest portable form — no URL hosting required.
async function buildClaudeImageBlocks(paths: string[]): Promise<ClaudeImageBlock[]> {
  const blocks: ClaudeImageBlock[] = []
  for (const p of paths) {
    try {
      const buf = await fs.readFile(p)
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: imageMediaType(p),
          data: buf.toString('base64'),
        },
      })
    } catch (err) {
      log('claude.image.readFailed', {
        path: p,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return blocks
}

// Claude tools that can write, execute, or otherwise modify the host. Safe
// mode denies these in canUseTool; other modes let them through.
const CLAUDE_WRITE_TOOLS = new Set<string>([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'BashOutput',
])

// Packaged macOS apps ship with a minimal PATH (/usr/bin:/bin). The user's
// real PATH lives in their login shell, so resolve agent binaries through
// `/bin/zsh -lc 'command -v …'` the same way the command-palette availability
// check does.
function resolveSystemBinary(name: string): string | null {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(shell, ['-lc', `command -v -- ${JSON.stringify(name)}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
      encoding: 'utf8',
    }).trim()
    if (!out) return null
    // `command -v` can print an alias or function definition. Only accept a
    // path that actually exists on disk.
    if (out.startsWith('/') && existsSync(out)) return out
    return null
  } catch {
    return null
  }
}

let cachedClaudePath: string | null | undefined
let cachedCodexPath: string | null | undefined

function getSystemClaudePath(): string | null {
  if (cachedClaudePath === undefined) cachedClaudePath = resolveSystemBinary('claude')
  return cachedClaudePath
}

function getSystemCodexPath(): string | null {
  if (cachedCodexPath === undefined) cachedCodexPath = resolveSystemBinary('codex')
  return cachedCodexPath
}

export interface AgentAuthStatus {
  agent: 'claude' | 'codex'
  binaryPath: string | null
  authenticated: boolean | 'unknown'
  account?: string | null
}

function fileExists(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

/**
 * Best-effort auth status — we can't actually probe the SDK without
 * consuming a turn, but the CLIs both drop credential files in well-known
 * paths after `login`, so presence there is a good heuristic.
 */
export function getAgentAuthStatus(agent: 'claude' | 'codex'): AgentAuthStatus {
  const home = process.env.HOME || ''
  if (agent === 'claude') {
    const binaryPath = getSystemClaudePath()
    const candidates = [
      path.join(home, '.claude', '.credentials.json'),
      path.join(home, '.claude', 'credentials.json'),
      path.join(home, '.config', 'claude', 'credentials.json'),
    ]
    return {
      agent,
      binaryPath,
      authenticated: candidates.some(fileExists),
    }
  }
  const binaryPath = getSystemCodexPath()
  const candidates = [
    path.join(home, '.codex', 'auth.json'),
    path.join(home, '.codex', 'credentials.json'),
    path.join(home, '.config', 'codex', 'auth.json'),
  ]
  return {
    agent,
    binaryPath,
    authenticated: candidates.some(fileExists),
  }
}

/**
 * Shell command users would run to sign in. Resolved through the detected
 * system binary when available so we don't rely on PATH at execution time.
 */
export function getAgentLoginCommand(agent: 'claude' | 'codex'): string {
  if (agent === 'claude') {
    const bin = getSystemClaudePath() || 'claude'
    return `${bin} auth login`
  }
  const bin = getSystemCodexPath() || 'codex'
  return `${bin} login`
}

export interface CodexModelInfo {
  id: string
  displayName: string
  description: string
  isDefault: boolean
  hidden: boolean
  /** Reasoning effort names the model accepts, per Codex CLI app-server. */
  supportedReasoningEfforts: Array<{ effort: string; description: string }>
  /** Default reasoning effort the CLI picks if the caller doesn't override. */
  defaultReasoningEffort: string
}

let cachedCodexModels: { at: number; list: CodexModelInfo[] } | null = null

/**
 * Query the Codex CLI's experimental app-server for the live model catalog
 * via JSON-RPC over stdio. The protocol is documented at
 *   `codex app-server generate-ts --experimental --out <dir>`
 * (see `ClientRequest.ts` → `"model/list"` and `v2/Model.ts`). Results are
 * cached for the app session so the picker doesn't respawn the server on
 * every popover open.
 */
export async function listCodexModels(): Promise<CodexModelInfo[]> {
  if (cachedCodexModels && Date.now() - cachedCodexModels.at < 5 * 60_000) {
    return cachedCodexModels.list
  }
  const binary = getSystemCodexPath() || 'codex'
  const list = await new Promise<CodexModelInfo[]>((resolve, reject) => {
    let settled = false
    const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    const models: CodexModelInfo[] = []
    const finish = (result: CodexModelInfo[] | Error) => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const timer = setTimeout(() => finish(new Error('codex app-server timed out')), 8000)
    child.on('error', (err) => {
      clearTimeout(timer)
      finish(err)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      // If we closed before getting the model list, resolve empty rather than
      // throw — the renderer falls back to the hardcoded catalog.
      if (!settled) finish(models)
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf('\n')
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 2 && msg.result?.data) {
            for (const m of msg.result.data as Array<{
              id: string
              displayName?: string
              description?: string
              hidden?: boolean
              isDefault?: boolean
              supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>
              defaultReasoningEffort?: string
            }>) {
              models.push({
                id: m.id,
                displayName: m.displayName || m.id,
                description: m.description || '',
                isDefault: !!m.isDefault,
                hidden: !!m.hidden,
                supportedReasoningEfforts: (m.supportedReasoningEfforts || []).map((r) => ({
                  effort: r.reasoningEffort,
                  description: r.description || '',
                })),
                defaultReasoningEffort: m.defaultReasoningEffort || 'medium',
              })
            }
            clearTimeout(timer)
            finish(models)
          }
        } catch {
          // Ignore malformed lines — server can emit notifications too.
        }
      }
    })
    const initializeReq =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'cells', version: '0.1.0', title: null },
          capabilities: { experimentalApi: true },
        },
      }) + '\n'
    const listReq =
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} }) + '\n'
    child.stdin.write(initializeReq)
    child.stdin.write(listReq)
  })
  cachedCodexModels = { at: Date.now(), list }
  return list
}

export interface ClaudeModelInfo {
  id: string
  displayName: string
  description: string
  /** Whether the model accepts an `effort` parameter at all. */
  supportsEffort: boolean
  /**
   * Raw effort names the SDK/CLI reports for this model. We keep this as
   * `string[]` (not the SDK's typed union) so any runtime-only values — the
   * CLI adds new tiers ahead of the TypeScript declarations — surface in the
   * picker without a type-level edit.
   */
  supportedEffortLevels: string[]
  supportsAdaptiveThinking: boolean
}

let cachedClaudeModels: { at: number; list: ClaudeModelInfo[] } | null = null

/**
 * Fetch the live Claude model catalog from the Agent SDK's control plane.
 *
 * We call `query()` in streaming-input mode with an async iterable that
 * never yields — that spawns the Claude Code subprocess and gives us access
 * to the `Query.supportedModels()` control method, but no user message is
 * ever sent so the turn budget isn't touched. The `SDKSession` we use for
 * real sessions (unstable_v2_*) doesn't expose control methods, which is why
 * we drop to the lower-level `query()` here. Results are cached for 5
 * minutes so opening the picker repeatedly doesn't respawn the CLI.
 */
export async function listClaudeModels(): Promise<ClaudeModelInfo[]> {
  if (cachedClaudeModels && Date.now() - cachedClaudeModels.at < 5 * 60_000) {
    return cachedClaudeModels.list
  }
  const claudeBinary = getSystemClaudePath()
  let releasePrompt: () => void = () => {}
  const promptDone = new Promise<void>((resolve) => {
    releasePrompt = resolve
  })
  // A prompt iterable that never yields — we only need the Query's control
  // plane (supportedModels), never a user turn. Implemented by hand instead
  // of as an async generator so ESLint's require-yield doesn't fire.
  const prompt: AsyncIterable<never> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          await promptDone
          return { value: undefined as never, done: true as const }
        },
      }
    },
  }
  const q = query({
    prompt,
    options: {
      env: buildAgentEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: 'cells' }),
      ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
    },
  })
  try {
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('claude supportedModels timed out')), 10_000),
    )
    const raw = (await Promise.race([q.supportedModels(), timer])) as Array<{
      value: string
      displayName?: string
      description?: string
      supportsEffort?: boolean
      supportedEffortLevels?: string[]
      supportsAdaptiveThinking?: boolean
    }>
    const mapped: ClaudeModelInfo[] = raw.map((m) => ({
      id: m.value,
      displayName: m.displayName || m.value,
      description: m.description || '',
      supportsEffort: !!m.supportsEffort,
      supportedEffortLevels: (m.supportedEffortLevels as string[] | undefined) ?? [],
      supportsAdaptiveThinking: !!m.supportsAdaptiveThinking,
    }))
    cachedClaudeModels = { at: Date.now(), list: mapped }
    return mapped
  } finally {
    releasePrompt()
    try {
      q.close()
    } catch {}
  }
}

export type LoginPhase = 'starting' | 'awaiting_browser' | 'success' | 'failed' | 'cancelled'

export interface LoginEvent {
  agent: 'claude' | 'codex'
  phase: LoginPhase
  url?: string | null
  message?: string | null
}

interface ActiveLogin {
  child: ChildProcessWithoutNullStreams
  url: string | null
  phase: LoginPhase
  buffer: string
}

/**
 * Orchestrates the CLI OAuth flow the same way Craft does:
 *
 *   1. Spawn the CLI in a hidden subprocess (no PTY, no visible window).
 *   2. Sniff its stdout/stderr for the OAuth URL.
 *   3. Open that URL in the user's default browser automatically.
 *   4. Wait for the CLI to exit once it receives the OAuth callback.
 *   5. Report phase transitions to the renderer over the emitter so the
 *      auth card / settings row can update live.
 *
 * The CLI itself hosts the OAuth callback server on localhost, so we don't
 * need our own — we just need to stay out of its way and expose progress.
 */
export class AgentLoginManager extends EventEmitter {
  private active = new Map<'claude' | 'codex', ActiveLogin>()

  isActive(agent: 'claude' | 'codex'): boolean {
    return this.active.has(agent)
  }

  cancel(agent: 'claude' | 'codex') {
    const running = this.active.get(agent)
    if (!running) return
    try {
      running.child.kill('SIGINT')
    } catch {
      // ignore
    }
  }

  async start(agent: 'claude' | 'codex'): Promise<void> {
    if (this.active.has(agent)) return

    const binary = agent === 'claude' ? getSystemClaudePath() : getSystemCodexPath()
    if (!binary) {
      this.emit('event', {
        agent,
        phase: 'failed',
        message: `${agent === 'claude' ? 'Claude Code' : 'Codex'} CLI not found on PATH.`,
      } satisfies LoginEvent)
      return
    }

    // The claude CLI tries to auto-open the browser itself, which in a
    // packaged Electron app can fail (no $DISPLAY or no xdg-open). We
    // disable that behaviour when we can and open the URL ourselves so
    // the user always lands in their default browser.
    const args = agent === 'claude' ? ['auth', 'login'] : ['login']

    const env = buildAgentEnv({
      // Force non-TTY output; the claude CLI uses a different prompt when
      // stdin isn't a tty and just prints the URL.
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'cells',
    })

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(binary, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      this.emit('event', {
        agent,
        phase: 'failed',
        message: err instanceof Error ? err.message : String(err),
      } satisfies LoginEvent)
      return
    }

    const state: ActiveLogin = {
      child,
      url: null,
      phase: 'starting',
      buffer: '',
    }
    this.active.set(agent, state)
    this.emit('event', { agent, phase: 'starting' } satisfies LoginEvent)

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      state.buffer = (state.buffer + text).slice(-4000)
      if (!state.url) {
        const url = extractUrl(state.buffer)
        if (url) {
          state.url = url
          state.phase = 'awaiting_browser'
          this.emit('event', {
            agent,
            phase: 'awaiting_browser',
            url,
          } satisfies LoginEvent)
          void shell.openExternal(url).catch(() => {})
        }
      }
    }

    child.stdout.on('data', handleChunk)
    child.stderr.on('data', handleChunk)

    child.on('error', (err) => {
      this.active.delete(agent)
      this.emit('event', {
        agent,
        phase: 'failed',
        message: err instanceof Error ? err.message : String(err),
      } satisfies LoginEvent)
    })

    child.on('close', (code, signal) => {
      this.active.delete(agent)
      if (signal === 'SIGINT' || signal === 'SIGTERM') {
        this.emit('event', { agent, phase: 'cancelled' } satisfies LoginEvent)
        return
      }
      if (code === 0) {
        // Invalidate detection cache so subsequent `getAgentAuthStatus`
        // re-reads fresh credential files written by the CLI.
        this.emit('event', { agent, phase: 'success' } satisfies LoginEvent)
      } else {
        const snippet = state.buffer.split('\n').slice(-6).join('\n').trim()
        this.emit('event', {
          agent,
          phase: 'failed',
          message: snippet || `CLI exited with code ${code}`,
        } satisfies LoginEvent)
      }
    })
  }
}

export const agentLoginManager = new AgentLoginManager()

type Runtime = ClaudeRuntime | CodexRuntime

interface RuntimeBase {
  request: AgentSessionRequest
  snapshot: AgentSessionSnapshot
  closed: boolean
}

interface ClaudeRuntime extends RuntimeBase {
  kind: 'claude'
  session: SDKSession
  streamPromise: Promise<void>
}

interface CodexRuntime extends RuntimeBase {
  kind: 'codex'
  codex: Codex
  thread: Thread
  turnPromise: Promise<void> | null
  /** Monotonic counter bumped on every `turn.started`. The Codex CLI reuses
   *  `item_0`, `item_1`, … across turns, so we prefix item ids with this
   *  counter to keep each turn's items distinct in our message list. */
  turnCounter: number
}

function now() {
  return Date.now()
}

function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"')]+/)
  return match?.[0] ?? null
}

function isClaudeAuthError(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('not logged in') ||
    t.includes('please run /login') ||
    t.includes('authentication failed') ||
    t.includes('unauthorized') ||
    t.includes('missing credentials') ||
    t.includes('invalid api key')
  )
}

function isCodexAuthError(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('not logged in') ||
    t.includes('please run `codex login`') ||
    t.includes("run 'codex login'") ||
    t.includes('authentication failed') ||
    t.includes('unauthorized') ||
    t.includes('missing credentials')
  )
}

/**
 * Build the env we hand to the `claude` / `codex` CLI. We explicitly keep
 * HOME/USER/PATH/SHELL intact so the CLIs can locate their OAuth creds
 * in `~/.claude/` and `~/.codex/` — otherwise the SDK's minimal PATH
 * inheritance causes them to prompt for fresh login every session.
 */
function buildAgentEnv(extra: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) env[key] = value
  }
  // In dev mode the app rewrites `process.env.HOME` to a sandbox path
  // (`$CELLS_DEV_ROOT/home`) so it doesn't pollute the user's real dotfiles.
  // But agents are here to work with the user's real filesystem — tools like
  // `Read ~/.config/nvim/init.lua` or `Bash: ls ~/` MUST resolve against the
  // real home. `userInfo().homedir` bypasses the $HOME override and reads
  // from the OS-level password db, so that's the authoritative value.
  const realHome = userInfo().homedir || process.env.HOME || ''
  if (realHome) {
    env.HOME = realHome
    // XDG spec defaults — make sure the agent reads the user's real config.
    env.XDG_CONFIG_HOME = process.env.CELLS_REAL_XDG_CONFIG_HOME || path.join(realHome, '.config')
    env.XDG_DATA_HOME = process.env.CELLS_REAL_XDG_DATA_HOME || path.join(realHome, '.local/share')
    env.XDG_CACHE_HOME = process.env.CELLS_REAL_XDG_CACHE_HOME || path.join(realHome, '.cache')
    env.XDG_STATE_HOME =
      process.env.CELLS_REAL_XDG_STATE_HOME || path.join(realHome, '.local/state')
  }
  // Make sure our PATH includes the common user bins so spawned auth
  // callbacks can open browsers and reach helpers.
  const extraPath = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    `${realHome}/.local/bin`,
    `${realHome}/.bun/bin`,
  ].join(':')
  env.PATH = env.PATH ? `${env.PATH}:${extraPath}` : extraPath
  for (const [key, value] of Object.entries(extra)) {
    if (value != null) env[key] = value
  }
  return env
}

function cloneSnapshot(snapshot: AgentSessionSnapshot): AgentSessionSnapshot {
  return {
    ...snapshot,
    messages: snapshot.messages.map((message) => ({ ...message })),
  }
}

function upsertMessage(messages: AgentSessionMessage[], next: AgentSessionMessage) {
  const index = messages.findIndex((message) => message.id === next.id)
  if (index >= 0) {
    messages[index] = { ...messages[index], ...next }
    return
  }
  messages.push(next)
}

function appendMessage(snapshot: AgentSessionSnapshot, message: AgentSessionMessage | null) {
  if (!message) return
  // Allow empty-text messages for tool/auth/error/system since those rows
  // carry meaning via title/status even without a body. Only drop empty
  // assistant/user/reasoning rows which *are* purely text.
  const needsText =
    message.role === 'assistant' || message.role === 'user' || message.role === 'reasoning'
  if (needsText && !message.text.trim()) return
  upsertMessage(snapshot.messages, { ...message, updatedAt: message.updatedAt ?? now() })
  snapshot.updatedAt = now()
}

function compactText(value: unknown, fallback = '') {
  if (typeof value === 'string') return value.trim()
  if (value == null) return fallback
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function flattenClaudeText(message: any) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .map((item: any) => (item?.type === 'text' ? item.text : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function flattenClaudeUserText(message: any): string {
  // User messages can carry plain strings OR a content array mixing text +
  // tool_result blocks. We only care about the typed-by-human text portion
  // when rehydrating a resumed session.
  if (typeof message?.content === 'string') return message.content.trim()
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .map((item: any) => {
      if (item?.type === 'text' && typeof item.text === 'string') return item.text
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function extractClaudeToolMessages(
  message: any,
  sessionId: string,
  parentToolUseId: string | null,
): AgentSessionMessage[] {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((item: any) => item?.type === 'tool_use')
    .map((item: any, index: number) => ({
      // Must match the id used by stream_event / user tool_use_result so we
      // upsert instead of duplicating rows.
      id: `tool-${item.id ?? `${sessionId}-${index}`}`,
      role: 'tool' as const,
      title: item.name ?? 'Tool',
      text: compactText(item.input),
      status: 'in_progress' as const,
      updatedAt: now(),
      toolUseId: item.id ?? null,
      parentToolUseId,
    }))
}

function codexItemToMessage(item: ThreadItem): AgentSessionMessage | null {
  if (item.type === 'agent_message') {
    return {
      id: item.id,
      role: 'assistant',
      text: item.text,
      updatedAt: now(),
    }
  }
  if (item.type === 'reasoning') {
    return {
      id: item.id,
      role: 'reasoning',
      title: 'Reasoning',
      text: item.text,
      updatedAt: now(),
    }
  }
  if (item.type === 'command_execution') {
    return {
      id: item.id,
      role: 'tool',
      title: item.command,
      text: item.aggregated_output || item.command,
      status:
        item.status === 'failed'
          ? 'failed'
          : item.status === 'completed'
            ? 'completed'
            : 'in_progress',
      metadata: typeof item.exit_code === 'number' ? `Exit ${item.exit_code}` : 'Running command',
      updatedAt: now(),
    }
  }
  if (item.type === 'file_change') {
    return {
      id: item.id,
      role: 'tool',
      title: 'File changes',
      text: item.changes.map((change) => `${change.kind}: ${change.path}`).join('\n'),
      status: item.status === 'failed' ? 'failed' : 'completed',
      updatedAt: now(),
    }
  }
  if (item.type === 'mcp_tool_call') {
    return {
      id: item.id,
      role: 'tool',
      title: `${item.server}:${item.tool}`,
      text: item.error?.message ?? compactText(item.result ?? item.arguments),
      status:
        item.status === 'failed'
          ? 'failed'
          : item.status === 'completed'
            ? 'completed'
            : 'in_progress',
      updatedAt: now(),
    }
  }
  if (item.type === 'web_search') {
    return {
      id: item.id,
      role: 'tool',
      title: 'Web search',
      text: item.query,
      status: 'completed',
      updatedAt: now(),
    }
  }
  if (item.type === 'todo_list') {
    return {
      id: item.id,
      role: 'system',
      title: 'Plan',
      text: item.items.map((todo) => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`).join('\n'),
      updatedAt: now(),
    }
  }
  if (item.type === 'error') {
    return {
      id: item.id,
      role: 'error',
      title: 'Error',
      text: item.message,
      status: 'failed',
      updatedAt: now(),
    }
  }
  return null
}

function flattenCodexContentBlocks(content: Array<{ type?: string; text?: string }>) {
  return content
    .map((item) => (typeof item?.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function codexBootstrapMessage(text: string) {
  return (
    text.includes('# AGENTS.md instructions for ') ||
    text.includes('<environment_context>') ||
    text.includes('<permissions instructions>')
  )
}

async function findCodexTranscriptFile(threadId: string): Promise<string | null> {
  const root = path.join(homedir(), '.codex', 'sessions')

  async function walk(dir: string): Promise<string | null> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }

    for (const entry of entries) {
      const nextPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = await walk(nextPath)
        if (found) return found
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
        return nextPath
      }
    }

    return null
  }

  return walk(root)
}

async function readCodexTranscript(threadId: string): Promise<AgentSessionMessage[]> {
  const transcriptPath = await findCodexTranscriptFile(threadId)
  if (!transcriptPath) return []

  let raw: string
  try {
    raw = await fs.readFile(transcriptPath, 'utf8')
  } catch {
    return []
  }

  const messages: AgentSessionMessage[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let entry: any
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (entry?.type !== 'response_item') continue
    const payload = entry.payload
    if (!payload) continue

    if (payload.type === 'message') {
      const text = flattenCodexContentBlocks(Array.isArray(payload.content) ? payload.content : [])
      if (!text) continue
      if (payload.role === 'user') {
        if (codexBootstrapMessage(text)) continue
        upsertMessage(messages, {
          id: `${threadId}-restore-user-${messages.length}`,
          role: 'user',
          text,
          updatedAt: now(),
        })
      } else if (payload.role === 'assistant') {
        upsertMessage(messages, {
          id: `${threadId}-restore-assistant-${messages.length}`,
          role: 'assistant',
          text,
          updatedAt: now(),
        })
      }
      continue
    }

    if (payload.type === 'reasoning') {
      const text = Array.isArray(payload.summary)
        ? payload.summary
            .map((item: any) => (typeof item?.text === 'string' ? item.text : ''))
            .filter(Boolean)
            .join('\n\n')
            .trim()
        : ''
      if (!text) continue
      upsertMessage(messages, {
        id: `${threadId}-restore-reasoning-${messages.length}`,
        role: 'reasoning',
        title: 'Reasoning',
        text,
        updatedAt: now(),
      })
      continue
    }

    if (payload.type === 'function_call') {
      upsertMessage(messages, {
        id: `${threadId}-call-${payload.call_id}`,
        role: 'tool',
        title: payload.name ?? 'Tool',
        text: compactText(payload.arguments, ''),
        status: 'in_progress',
        updatedAt: now(),
      })
      continue
    }

    if (payload.type === 'function_call_output') {
      upsertMessage(messages, {
        id: `${threadId}-call-${payload.call_id}`,
        role: 'tool',
        title: 'Tool output',
        text: compactText(payload.output, ''),
        status: 'completed',
        updatedAt: now(),
      })
    }
  }

  return messages
}

// ---------------------------------------------------------------------------
// Snapshot persistence — mirrors Craft's per-session JSONL file. Because the
// AgentSessionSnapshot only lives in the service's in-memory runtime, we lose
// the whole conversation the moment the user quits. Craft persists each
// session to disk and reads it back on open; we do the same but with a plain
// JSON blob per window (we don't need the streaming header/body split).
//
// Storage layout: `{userData}/agent-sessions/{windowId}.json`
// ---------------------------------------------------------------------------

function getPersistDir(): string {
  const userData = app.getPath('userData')
  const dir = path.join(userData, 'agent-sessions')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // ignore — first write will surface the error
  }
  return dir
}

function getPersistPath(windowId: string): string {
  return path.join(getPersistDir(), `${windowId}.json`)
}

function loadPersistedSnapshot(windowId: string): AgentSessionSnapshot | null {
  const file = getPersistPath(windowId)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) return null
    // If the app was killed mid-stream, messages still marked `in_progress`
    // would render as spinners forever on reload. Close them out.
    // Also strip transient error rows that shouldn't survive a restart —
    // stale-session errors, process-killed errors, etc. If the user cares
    // about the failure they'll see it happen live; stale bubbles from a
    // previous app run are just noise.
    const messages = (parsed.messages as AgentSessionMessage[])
      .filter((m) => {
        if (m.role !== 'error') return true
        const t = typeof m.text === 'string' ? m.text : ''
        return !(
          t.includes('No conversation found with session ID') ||
          t.includes('session has expired') ||
          t.includes('session not found') ||
          t.includes('exited with code 143') ||
          t.includes('exited with code 137') ||
          t.includes('aborted by user') ||
          t.includes('Operation aborted')
        )
      })
      .map((m) => (m.status === 'in_progress' ? { ...m, status: 'completed' as const } : m))
    return {
      ...(parsed as AgentSessionSnapshot),
      status: 'idle',
      error: null,
      messages,
    }
  } catch (err) {
    log('persist.load.error', {
      windowId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// Coalesce rapid snapshot updates so we don't hammer the disk during
// streaming — one write per ~150ms is plenty to keep the file fresh.
const persistTimers = new Map<string, NodeJS.Timeout>()
function schedulePersist(snapshot: AgentSessionSnapshot) {
  const existing = persistTimers.get(snapshot.windowId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    persistTimers.delete(snapshot.windowId)
    const file = getPersistPath(snapshot.windowId)
    const tmp = `${file}.tmp`
    const serialized = JSON.stringify(snapshot)
    fs.writeFile(tmp, serialized, 'utf8')
      .then(() => fs.rename(tmp, file))
      .catch((err) => {
        log('persist.write.error', {
          windowId: snapshot.windowId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }, 150)
  persistTimers.set(snapshot.windowId, timer)
}

function deletePersistedSnapshot(windowId: string) {
  const file = getPersistPath(windowId)
  if (!existsSync(file)) return
  fs.unlink(file).catch(() => {})
}

// Structured debug logger. Everything goes through here so the user can tell
// us exactly where a stall is happening from the app logs. Keep single-line
// JSON-ish payloads so they're easy to paste back.
function log(event: string, data: Record<string, unknown> = {}) {
  // eslint-disable-next-line no-console
  console.log(
    `[agent-session] ${event}` + (Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''),
  )
}

function summarizeEvent(event: any): Record<string, unknown> {
  const base: Record<string, unknown> = { type: event?.type }
  if (event?.subtype) base.subtype = event.subtype
  if (event?.state) base.state = event.state
  if (event?.isAuthenticating !== undefined) base.isAuthenticating = event.isAuthenticating
  if (event?.is_error !== undefined) base.is_error = event.is_error
  if (event?.tool_use_id) base.tool_use_id = event.tool_use_id
  if (event?.tool_name) base.tool_name = event.tool_name
  if (event?.parent_tool_use_id) base.parent_tool_use_id = event.parent_tool_use_id
  if (event?.type === 'stream_event') {
    base.streamType = event.event?.type
    if (event.event?.delta?.type) base.deltaType = event.event.delta.type
    if (event.event?.content_block?.type) base.blockType = event.event.content_block.type
  }
  if (event?.type === 'user' && event?.tool_use_result) base.hasToolResult = true
  return base
}

export class AgentSessionService extends EventEmitter {
  private runtimes = new Map<string, Runtime>()

  async ensure(request: AgentSessionRequest): Promise<AgentSessionSnapshot> {
    // Coerce legacy permission values ('safe' / 'allow-all') from older
    // saved ProjectsState so the rest of the code only has to handle the
    // current 3-mode union.
    request = { ...request, permissionMode: normalizePermissionMode(request.permissionMode) }
    const existing = this.runtimes.get(request.windowId)
    log('ensure', {
      windowId: request.windowId,
      agent: request.agent,
      existing: !!existing,
      closed: existing?.closed ?? null,
      hasClaudeSessionId: !!request.claudeSessionId,
      hasCodexThreadId: !!request.codexThreadId,
      model: request.model ?? null,
      permissionMode: request.permissionMode ?? null,
      cwd: request.cwd ?? null,
    })
    if (existing) {
      existing.request = { ...existing.request, ...request }
      existing.snapshot.title = request.title?.trim() || existing.snapshot.title
      existing.snapshot.cwd = request.cwd ?? existing.snapshot.cwd ?? null
      return cloneSnapshot(existing.snapshot)
    }

    const persisted = loadPersistedSnapshot(request.windowId)
    log('ensure.persisted', {
      windowId: request.windowId,
      hasPersisted: !!persisted,
      messageCount: persisted?.messages.length ?? 0,
    })
    const snapshot: AgentSessionSnapshot = {
      windowId: request.windowId,
      agent: request.agent,
      title:
        request.title?.trim() ||
        persisted?.title ||
        (request.agent === 'claude' ? 'Claude Code' : 'Codex'),
      cwd: request.cwd ?? persisted?.cwd ?? null,
      status: 'idle',
      error: null,
      claudeSessionId: request.claudeSessionId ?? persisted?.claudeSessionId ?? null,
      codexThreadId: request.codexThreadId ?? persisted?.codexThreadId ?? null,
      updatedAt: now(),
      messages: persisted?.messages ?? [],
    }

    if (request.agent === 'claude') {
      const isResumedSession = Boolean(request.claudeSessionId)
      const claudeBinary = getSystemClaudePath()
      // The v2 SDK hardcodes `allowDangerouslySkipPermissions: false` (see
      // node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs), which means we
      // can't use `permissionMode: 'bypassPermissions'` — the CLI will reject
      // it. Instead we use `default` + canUseTool and approve everything
      // ourselves, matching how Craft handles permission in its PreToolUse
      // hooks. The user-facing "safe" mode still maps to 'plan' (read-only).
      // Always boot Claude in 'default' so mid-session permission swaps work.
      // If we boot in 'plan', Claude itself (model) locks onto "I'm in plan
      // mode" and keeps refusing edits even after setPermissionMode swaps us
      // to default. Craft's fix (packages/shared/src/agent/claude-agent.ts
      // ~line 983) is to always use bypassPermissions and reject writes in
      // canUseTool. Cells does the same: safe mode denies write tools there.
      const claudePermission = 'default' as const
      const sessionOptions: any = {
        model: request.model || DEFAULT_CLAUDE_MODEL,
        cwd: request.cwd ?? undefined,
        permissionMode: claudePermission,
        env: buildAgentEnv({
          CLAUDE_AGENT_SDK_CLIENT_APP: 'cells',
          ...(request.cwd ? { PWD: request.cwd } : {}),
        }),
        canUseTool: async (toolName: string, input: any) => {
          const mode = this.runtimes.get(request.windowId)?.request.permissionMode
          // Safe mode: block anything that can write to the filesystem or
          // execute shell. Matches the read-only posture the UI advertises
          // without using the SDK's 'plan' permissionMode (which primes
          // Claude to refuse edits even after we swap it out).
          if (mode === 'plan' && CLAUDE_WRITE_TOOLS.has(toolName)) {
            return {
              behavior: 'deny' as const,
              message: `Cells is in Plan mode — ${toolName} is blocked. Switch to Ask or Yolo to allow writes.`,
            }
          }
          log('claude.canUseTool', {
            windowId: request.windowId,
            toolName,
            mode: mode ?? null,
            inputKeys: input ? Object.keys(input) : [],
          })
          return {
            behavior: 'allow' as const,
            updatedInput: (input ?? {}) as Record<string, unknown>,
          }
        },
        ...claudeThinkingOptions(request.thinkingLevel, request.model || DEFAULT_CLAUDE_MODEL),
        ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
        ...(request.contextLength === 'extended' ? { betas: [CLAUDE_CONTEXT_1M_BETA] } : {}),
      }
      log('claude.create', {
        windowId: request.windowId,
        resume: isResumedSession,
        claudeBinary,
        model: sessionOptions.model,
        permissionMode: claudePermission,
      })
      const session = this.withCwd(request.cwd, () =>
        request.claudeSessionId
          ? unstable_v2_resumeSession(request.claudeSessionId!, sessionOptions)
          : unstable_v2_createSession(sessionOptions),
      )

      const runtime: ClaudeRuntime = {
        kind: 'claude',
        request,
        snapshot,
        session,
        closed: false,
        streamPromise: Promise.resolve(),
      }
      runtime.streamPromise = this.consumeClaudeStream(runtime)
      this.runtimes.set(request.windowId, runtime)
      if (!isResumedSession && request.initialPrompt?.trim()) {
        log('claude.initialPrompt', { windowId: request.windowId })
        void this.send(request.windowId, request.initialPrompt)
      }
      return cloneSnapshot(snapshot)
    }

    const codexBinary = getSystemCodexPath()
    const codex = new Codex({
      env: buildAgentEnv(),
      ...(codexBinary ? { codexPathOverride: codexBinary } : {}),
    })
    const isResumedThread = Boolean(request.codexThreadId)
    // Map portable permission modes onto Codex's sandbox/approval policy pair.
    //   plan    → read-only + never-approve (agent can read but not write)
    //   ask     → workspace-write + ask-on-request
    //   bypass  → danger-full-access + never-approve (yolo)
    // Legacy values: 'safe' → plan, 'allow-all' → ask.
    const codexSandbox =
      request.permissionMode === 'plan'
        ? ('read-only' as const)
        : request.permissionMode === 'bypass'
          ? ('danger-full-access' as const)
          : ('workspace-write' as const)
    const codexApproval =
      request.permissionMode === 'ask' ? ('on-request' as const) : ('never' as const)
    const threadOptions = {
      workingDirectory: request.cwd ?? undefined,
      sandboxMode: codexSandbox,
      approvalPolicy: codexApproval,
      networkAccessEnabled: true,
      // Codex refuses to run in a non-git directory unless this is set.
      // Home ($HOME) is the common case for "just start a general chat",
      // so we always opt out of the repo trust check here.
      skipGitRepoCheck: true,
      modelReasoningEffort: codexThinkingEffort(request.thinkingLevel),
      ...(request.model ? { model: request.model } : {}),
    }
    const thread = request.codexThreadId
      ? codex.resumeThread(request.codexThreadId, threadOptions)
      : codex.startThread(threadOptions)

    const runtime: CodexRuntime = {
      kind: 'codex',
      request,
      snapshot,
      codex,
      thread,
      turnPromise: null,
      closed: false,
      turnCounter: 0,
    }
    if (isResumedThread && request.codexThreadId) {
      // Prefer Codex's own rollout file when it's still around — more
      // authoritative than our JSON snapshot. If the rollout is gone (GC'd,
      // a fresh install, session file format changed), keep the persisted
      // messages we already loaded above so the user doesn't see an empty
      // chat after restarting the app.
      const rollout = await readCodexTranscript(request.codexThreadId)
      if (rollout.length > 0) runtime.snapshot.messages = rollout
    }
    this.runtimes.set(request.windowId, runtime)
    if (!isResumedThread && request.initialPrompt?.trim()) {
      void this.send(request.windowId, request.initialPrompt)
    }
    return cloneSnapshot(snapshot)
  }

  async send(
    windowId: string,
    input: string,
    attachments?: string[],
    overrides?: {
      model?: AgentSessionRequest['model']
      thinkingLevel?: AgentSessionRequest['thinkingLevel']
      permissionMode?: AgentSessionRequest['permissionMode']
    },
  ): Promise<void> {
    let runtime = this.runtimes.get(windowId)
    log('send.begin', {
      windowId,
      hasRuntime: !!runtime,
      closed: runtime?.closed ?? null,
      kind: runtime?.kind ?? null,
      inputLength: input.length,
      attachmentCount: attachments?.length ?? 0,
      overrides: overrides ?? null,
    })
    if (!runtime) throw new Error(`Missing agent session for ${windowId}`)

    // Apply queued-message overrides (captured at queue time) so the next
    // turn runs with the model / thinking / permission that were selected
    // when the user queued this message, not whatever is active now.
    if (overrides) {
      const req = runtime.request
      const modelChanged =
        overrides.model !== undefined && (overrides.model ?? null) !== (req.model ?? null)
      const thinkingChanged =
        overrides.thinkingLevel !== undefined &&
        (overrides.thinkingLevel ?? null) !== (req.thinkingLevel ?? null)
      const permissionChanged =
        overrides.permissionMode !== undefined &&
        (overrides.permissionMode ?? null) !== (req.permissionMode ?? null)

      if (modelChanged) req.model = overrides.model ?? null
      if (thinkingChanged) req.thinkingLevel = overrides.thinkingLevel ?? null

      if (permissionChanged) {
        await this.updatePermissionMode(windowId, overrides.permissionMode ?? null)
      }

      // Model / thinking changes require rebooting the underlying CLI session
      // (Claude) or thread (Codex) — both only read these at construction time.
      // Marking closed + closing the Claude session lets the existing
      // reopen-on-send path below pick up the new config.
      if (modelChanged || thinkingChanged) {
        if (runtime.kind === 'claude') {
          try {
            runtime.session.close()
          } catch {
            /* idempotent */
          }
        }
        runtime.closed = true
      }
    }

    // If the runtime was closed (user hit Stop) but not disposed, transparently
    // reopen it so the message history survives and we just resume the
    // underlying CLI session for the next turn.
    if (runtime.closed) {
      runtime = this.reopenRuntime(runtime)
    }

    const normalizedAttachments = (attachments ?? []).filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    )
    const imageAttachments = normalizedAttachments.filter(isImagePath)
    const nonImageAttachments = normalizedAttachments.filter((p) => !isImagePath(p))

    // Non-image attachments stay as `[path]` text references so the agent can
    // open them with its file-read tool. Images are promoted to a proper
    // content block below so the model sees the pixels, not a filename.
    const nonImageLine = nonImageAttachments.length
      ? nonImageAttachments.map((p) => `[${p}]`).join(' ') + '\n\n'
      : ''
    const agentText = `${nonImageLine}${input}`.trim() || input

    appendMessage(runtime.snapshot, {
      id: `${windowId}-user-${now()}`,
      role: 'user',
      text: input,
      attachments: normalizedAttachments.length > 0 ? normalizedAttachments : undefined,
      updatedAt: now(),
    })
    runtime.snapshot.status = 'running'
    runtime.snapshot.error = null
    this.emitUpdate(runtime.snapshot)

    if (runtime.kind === 'claude') {
      log('send.claude.dispatch', { windowId })
      try {
        if (imageAttachments.length > 0) {
          const blocks = await buildClaudeImageBlocks(imageAttachments)
          await runtime.session.send({
            type: 'user',
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: [...blocks, { type: 'text', text: agentText }],
            },
          })
        } else {
          await runtime.session.send(agentText)
        }
        log('send.claude.dispatched', { windowId })
      } catch (err) {
        log('send.claude.error', {
          windowId,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
      return
    }

    if (runtime.turnPromise) {
      throw new Error('Codex is still processing the previous turn')
    }

    log('send.codex.dispatch', { windowId })
    const codexInput =
      imageAttachments.length > 0
        ? [
            ...imageAttachments.map((p) => ({ type: 'local_image' as const, path: p })),
            { type: 'text' as const, text: agentText },
          ]
        : agentText
    const streamed = await runtime.thread.runStreamed(codexInput)
    runtime.turnPromise = this.consumeCodexTurn(runtime, streamed.events).finally(() => {
      runtime.turnPromise = null
    })
  }

  /** Stop the current turn but keep the runtime + message history around.
   * The next `send()` will reopen the underlying CLI session on demand. */
  async close(windowId: string): Promise<void> {
    const runtime = this.runtimes.get(windowId)
    log('close', { windowId, hasRuntime: !!runtime })
    if (!runtime) return
    runtime.closed = true
    if (runtime.kind === 'claude') {
      try {
        runtime.session.close()
      } catch {
        /* idempotent */
      }
    }
    runtime.snapshot.status = 'idle'
    runtime.snapshot.error = null
    this.emitUpdate(runtime.snapshot)
  }

  /** Fully dispose of a runtime — drop history, terminate the process. Called
   * when the agent window itself is removed from the store. */
  async dispose(windowId: string): Promise<void> {
    const runtime = this.runtimes.get(windowId)
    log('dispose', { windowId, hasRuntime: !!runtime })
    if (runtime) {
      runtime.closed = true
      if (runtime.kind === 'claude') {
        try {
          runtime.session.close()
        } catch {
          /* ignore */
        }
      }
      this.runtimes.delete(windowId)
    }
    // Also clear the on-disk snapshot so a fresh window with the same id
    // doesn't silently rehydrate stale history.
    const pending = persistTimers.get(windowId)
    if (pending) {
      clearTimeout(pending)
      persistTimers.delete(windowId)
    }
    deletePersistedSnapshot(windowId)
  }

  /** Claude-only: toggle the 1M-context-window beta. Must recreate the
   *  session since `betas` is only read at construction time. Mark closed so
   *  the next send() transparently reopens with the new beta flag. */
  async updateContextLength(
    windowId: string,
    length: AgentSessionRequest['contextLength'],
  ): Promise<void> {
    const runtime = this.runtimes.get(windowId)
    if (!runtime) return
    runtime.request.contextLength = length ?? null
    if (runtime.kind !== 'claude') return
    try {
      runtime.session.close()
    } catch {
      /* idempotent */
    }
    runtime.closed = true
    log('claude.contextLength.update', { windowId, length: length ?? null })
  }

  /** Apply a permission-mode change to a running agent session. Claude's SDK
   *  exposes `session.setPermissionMode` for live updates; Codex only reads
   *  `approvalPolicy` at thread construction so we rebuild the thread on the
   *  same thread id to pick up the new policy on the next turn. */
  async updatePermissionMode(
    windowId: string,
    mode: AgentSessionRequest['permissionMode'] | 'safe' | 'allow-all',
  ): Promise<void> {
    const runtime = this.runtimes.get(windowId)
    if (!runtime) return
    mode = normalizePermissionMode(mode)
    runtime.request.permissionMode = mode ?? null
    if (runtime.kind === 'claude') {
      const next = mode === 'plan' ? 'plan' : 'default'
      try {
        await (runtime.session as any).setPermissionMode?.(next)
        log('claude.permissionMode.update', { windowId, mode: next })
      } catch (err) {
        log('claude.permissionMode.error', {
          windowId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    // Codex: rebuild the Thread on top of the existing thread id so the next
    // turn gets the new sandbox/approval policy.
    const req = runtime.request
    const codexSandbox =
      req.permissionMode === 'plan'
        ? ('read-only' as const)
        : req.permissionMode === 'bypass'
          ? ('danger-full-access' as const)
          : ('workspace-write' as const)
    const codexApproval =
      req.permissionMode === 'ask' ? ('on-request' as const) : ('never' as const)
    const threadOptions = {
      workingDirectory: req.cwd ?? undefined,
      sandboxMode: codexSandbox,
      approvalPolicy: codexApproval,
      networkAccessEnabled: true,
      skipGitRepoCheck: true,
      modelReasoningEffort: codexThinkingEffort(req.thinkingLevel),
      ...(req.model ? { model: req.model } : {}),
    }
    const threadId = runtime.snapshot.codexThreadId
    runtime.thread = threadId
      ? runtime.codex.resumeThread(threadId, threadOptions)
      : runtime.codex.startThread(threadOptions)
    log('codex.permissionMode.update', { windowId, sandbox: codexSandbox, approval: codexApproval })
  }

  // The v2 SDK drops the `cwd` option from SDKSessionOptions (see
  // node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs — the `hz` class
  // constructs its ProcessTransport without forwarding cwd). To make the
  // spawned `claude` CLI run in the user's selected project directory, we
  // temporarily chdir() the main process around the synchronous session
  // construction. The CLI captures cwd at spawn time, so we can restore
  // immediately after.
  private withCwd<T>(cwd: string | null | undefined, fn: () => T): T {
    if (!cwd) return fn()
    const prev = process.cwd()
    try {
      process.chdir(cwd)
    } catch (err) {
      log('withCwd.chdir-failed', {
        cwd,
        error: err instanceof Error ? err.message : String(err),
      })
      return fn()
    }
    try {
      return fn()
    } finally {
      try {
        process.chdir(prev)
      } catch {
        // ignore — shouldn't happen
      }
    }
  }

  private reopenRuntime(runtime: Runtime): Runtime {
    const windowId = runtime.snapshot.windowId
    log('reopen', { windowId, kind: runtime.kind })
    if (runtime.kind === 'claude') {
      const req = runtime.request
      const claudeBinary = getSystemClaudePath()
      // See ensure() — always use 'default' and enforce safe mode via
      // canUseTool. Plan mode at session boot locks the model into a
      // self-imposed plan mode that survives setPermissionMode swaps.
      const claudePermission = 'default' as const
      const sessionOptions: any = {
        model: req.model || DEFAULT_CLAUDE_MODEL,
        cwd: req.cwd ?? undefined,
        permissionMode: claudePermission,
        env: buildAgentEnv({
          CLAUDE_AGENT_SDK_CLIENT_APP: 'cells',
          ...(req.cwd ? { PWD: req.cwd } : {}),
        }),
        canUseTool: async (toolName: string, input: any) => {
          const mode = this.runtimes.get(windowId)?.request.permissionMode
          if (mode === 'plan' && CLAUDE_WRITE_TOOLS.has(toolName)) {
            return {
              behavior: 'deny' as const,
              message: `Cells is in Plan mode — ${toolName} is blocked. Switch to Ask or Yolo to allow writes.`,
            }
          }
          return {
            behavior: 'allow' as const,
            updatedInput: (input ?? {}) as Record<string, unknown>,
          }
        },
        ...claudeThinkingOptions(req.thinkingLevel, req.model || DEFAULT_CLAUDE_MODEL),
        ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
        ...(req.contextLength === 'extended' ? { betas: [CLAUDE_CONTEXT_1M_BETA] } : {}),
      }
      const sessionId = runtime.snapshot.claudeSessionId
      const session = this.withCwd(req.cwd, () =>
        sessionId
          ? unstable_v2_resumeSession(sessionId, sessionOptions)
          : unstable_v2_createSession(sessionOptions),
      )
      runtime.session = session
      runtime.closed = false
      runtime.streamPromise = this.consumeClaudeStream(runtime)
      return runtime
    }

    // Codex: rebuild the thread on top of the same codex client.
    const req = runtime.request
    const codexSandbox =
      req.permissionMode === 'plan'
        ? ('read-only' as const)
        : req.permissionMode === 'bypass'
          ? ('danger-full-access' as const)
          : ('workspace-write' as const)
    const codexApproval =
      req.permissionMode === 'ask' ? ('on-request' as const) : ('never' as const)
    const threadOptions = {
      workingDirectory: req.cwd ?? undefined,
      sandboxMode: codexSandbox,
      approvalPolicy: codexApproval,
      networkAccessEnabled: true,
      skipGitRepoCheck: true,
      modelReasoningEffort: codexThinkingEffort(req.thinkingLevel),
      ...(req.model ? { model: req.model } : {}),
    }
    const threadId = runtime.snapshot.codexThreadId
    runtime.thread = threadId
      ? runtime.codex.resumeThread(threadId, threadOptions)
      : runtime.codex.startThread(threadOptions)
    runtime.closed = false
    return runtime
  }

  private emitUpdate(snapshot: AgentSessionSnapshot) {
    schedulePersist(snapshot)
    this.emit('update', cloneSnapshot(snapshot))
  }

  private async consumeClaudeStream(runtime: ClaudeRuntime) {
    const windowId = runtime.snapshot.windowId
    log('claude.stream.start', { windowId })
    // The v2 SDK's `session.stream()` returns AFTER THE FIRST `result` event —
    // see node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs (`if(yield $,$.type==="result")return`).
    // That means a single for-await loop only drains one turn. We have to
    // restart the loop for every subsequent send() or the next turn's events
    // are never consumed and the UI hangs at "thinking".
    let totalCount = 0
    try {
      while (!runtime.closed) {
        let count = 0
        for await (const event of runtime.session.stream()) {
          if (runtime.closed) {
            log('claude.stream.broken-by-close', { windowId, count, totalCount })
            return
          }
          count += 1
          totalCount += 1
          log('claude.event', { windowId, n: totalCount, ...summarizeEvent(event) })
          this.handleClaudeEvent(runtime, event)
          this.emitUpdate(runtime.snapshot)
        }
        log('claude.stream.turn-end', { windowId, count, totalCount })
        // Loop back around — the next stream() call will block on the shared
        // queryIterator until the user sends another message.
      }
      log('claude.stream.end', { windowId, totalCount })
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      log('claude.stream.error', {
        windowId,
        totalCount,
        error: errMsg,
      })
      // Clean shutdown signals (SIGTERM/SIGKILL → exit codes 143/137, or
      // explicit "aborted" from the SDK) usually mean HMR reload or a user-
      // triggered stop. Don't surface those as errors — just mark the
      // runtime closed so the next send() transparently reopens it.
      if (
        errMsg.includes('exited with code 143') ||
        errMsg.includes('exited with code 137') ||
        errMsg.includes('aborted by user') ||
        errMsg.includes('Operation aborted')
      ) {
        runtime.snapshot.status = 'idle'
        runtime.snapshot.error = null
        runtime.closed = true
        this.emitUpdate(runtime.snapshot)
        return
      }
      // Stale-session errors from resume — the Claude CLI garbage-collects
      // sessions after some time, so a persisted id from a previous app run
      // will fail with this. Drop the stale id and let the next send()
      // transparently reopen as a fresh session.
      if (
        errMsg.includes('No conversation found with session ID') ||
        errMsg.includes('session has expired') ||
        errMsg.includes('session not found')
      ) {
        log('claude.resume.stale-session-thrown', {
          windowId,
          sessionId: runtime.snapshot.claudeSessionId,
        })
        runtime.snapshot.claudeSessionId = null
        runtime.snapshot.status = 'idle'
        runtime.snapshot.error = null
        runtime.closed = true
        // Strip any already-persisted "No conversation found" error bubbles.
        runtime.snapshot.messages = runtime.snapshot.messages.filter(
          (m) =>
            !(
              m.role === 'error' &&
              typeof m.text === 'string' &&
              (m.text.includes('No conversation found with session ID') ||
                m.text.includes('session has expired') ||
                m.text.includes('session not found'))
            ),
        )
        this.emitUpdate(runtime.snapshot)
        return
      }
      runtime.snapshot.status = 'error'
      runtime.snapshot.error = errMsg
      appendMessage(runtime.snapshot, {
        id: `${runtime.snapshot.windowId}-claude-error-${now()}`,
        role: 'error',
        title: 'Claude Code',
        text: runtime.snapshot.error,
        status: 'failed',
      })
      this.emitUpdate(runtime.snapshot)
    }
  }

  private handleClaudeEvent(runtime: ClaudeRuntime, event: SDKMessage) {
    runtime.snapshot.claudeSessionId = (event as any).session_id ?? runtime.snapshot.claudeSessionId

    // Stream text / tool deltas so the UI reflects progress in real time
    // instead of waiting for the final `assistant` event. Mirrors Craft's
    // event-adapter (packages/shared/src/agent/backend/claude/event-adapter.ts).
    if (event.type === 'stream_event') {
      const evt = event as any
      const streamed = evt.event
      const parentToolUseId: string | null = evt.parent_tool_use_id ?? null
      if (
        streamed?.type === 'content_block_start' &&
        streamed?.content_block?.type === 'tool_use'
      ) {
        const tool = streamed.content_block
        log('claude.tool.start', {
          windowId: runtime.snapshot.windowId,
          toolName: tool.name,
          toolUseId: tool.id,
          parentToolUseId,
          input: compactText(tool.input ?? {}).slice(0, 200),
        })
        appendMessage(runtime.snapshot, {
          id: `tool-${tool.id}`,
          role: 'tool',
          title: tool.name ?? 'Tool',
          text: compactText(tool.input ?? {}),
          status: 'in_progress',
          updatedAt: now(),
          toolUseId: tool.id,
          parentToolUseId,
        })
        return
      }
      if (streamed?.type === 'content_block_delta' && streamed?.delta?.type === 'text_delta') {
        const delta: string = streamed.delta.text ?? ''
        if (!delta) return
        const parentId = `stream-${evt.uuid}`
        const existing = runtime.snapshot.messages.find((m) => m.id === parentId)
        if (existing && existing.role === 'assistant') {
          existing.text = (existing.text || '') + delta
          existing.updatedAt = now()
          existing.status = 'in_progress'
          runtime.snapshot.updatedAt = now()
        } else {
          appendMessage(runtime.snapshot, {
            id: parentId,
            role: 'assistant',
            text: delta,
            status: 'in_progress',
            updatedAt: now(),
            parentToolUseId,
          })
        }
        return
      }
      if (
        streamed?.type === 'content_block_delta' &&
        streamed?.delta?.type === 'input_json_delta'
      ) {
        // Tool input streaming — stitch into the tool message.
        const toolUseId = streamed.tool_use_id || streamed.index
        if (toolUseId) {
          const existing = runtime.snapshot.messages.find((m) => m.id === `tool-${toolUseId}`)
          if (existing) {
            existing.text = (existing.text || '') + (streamed.delta.partial_json ?? '')
            existing.updatedAt = now()
          }
        }
        return
      }
      return
    }

    // `user` events come in two shapes:
    //  1. Tool results — body has `tool_use_result`; we attach to the tool row.
    //  2. Replay / synthetic — a past user prompt being re-emitted when the
    //     SDK resumes a persisted session.
    if (event.type === 'user') {
      const evt = event as any
      const parentToolUseId: string | null = evt.parent_tool_use_id ?? null
      // Primary path matching Craft's extractToolResults: look for
      // `tool_result` blocks inside message.content. Each block carries its
      // own `tool_use_id` which is the authoritative link back to the
      // tool row, unlike the convenience `tool_use_result` field which
      // doesn't always include an id. Falls back to that convenience field
      // when no content blocks are present.
      const contentBlocks: any[] = Array.isArray(evt.message?.content) ? evt.message.content : []
      const toolResultBlocks = contentBlocks.filter((b) => b?.type === 'tool_result')

      if (toolResultBlocks.length > 0) {
        for (const block of toolResultBlocks) {
          const toolUseId = block.tool_use_id
          const isError = !!block.is_error
          const rawContent =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((c: any) =>
                      typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : '',
                    )
                    .filter(Boolean)
                    .join('\n')
                : compactText(block.content ?? '')
          const summaryLine = rawContent.split('\n').slice(0, 8).join('\n')
          log('claude.tool.result', {
            windowId: runtime.snapshot.windowId,
            toolUseId,
            parentToolUseId,
            isError,
            resultPreview: summaryLine.slice(0, 140),
          })
          const existing = toolUseId
            ? runtime.snapshot.messages.find((m) => m.id === `tool-${toolUseId}`)
            : null
          if (existing) {
            existing.text = summaryLine
            existing.status = isError ? 'failed' : 'completed'
            existing.metadata = isError ? 'error' : (existing.metadata ?? null)
            existing.updatedAt = now()
            if (parentToolUseId && !existing.parentToolUseId) {
              existing.parentToolUseId = parentToolUseId
            }
            if (toolUseId && !existing.toolUseId) existing.toolUseId = toolUseId
            runtime.snapshot.updatedAt = now()
          } else if (toolUseId) {
            appendMessage(runtime.snapshot, {
              id: `tool-${toolUseId}`,
              role: 'tool',
              title: 'Tool result',
              text: summaryLine,
              status: isError ? 'failed' : 'completed',
              updatedAt: now(),
              toolUseId,
              parentToolUseId,
            })
          }
        }
        return
      }

      const result = evt.tool_use_result
      if (!result) {
        // Replay path: re-hydrate user bubbles from persisted session history.
        // Skip messages that came from inside a subagent — those are the
        // subagent system prompt/instructions, not actual user input, and
        // shouldn't appear as user bubbles in the conversation.
        if (parentToolUseId) {
          log('claude.user.replay.skip-subagent', {
            windowId: runtime.snapshot.windowId,
            uuid: evt.uuid,
            parentToolUseId,
          })
          return
        }
        const text = flattenClaudeUserText(evt.message)
        log('claude.user.replay', {
          windowId: runtime.snapshot.windowId,
          uuid: evt.uuid,
          isSynthetic: !!evt.isSynthetic,
          textLength: text.length,
        })
        if (!text || evt.isSynthetic) return
        const id =
          evt.uuid || `${runtime.snapshot.windowId}-user-replay-${runtime.snapshot.messages.length}`
        if (runtime.snapshot.messages.some((m) => m.id === id)) return
        appendMessage(runtime.snapshot, {
          id,
          role: 'user',
          text,
          status: 'completed',
          updatedAt: now(),
        })
        return
      }
      // Convenience-field fallback — use parent_tool_use_id as the row key.
      log('claude.tool.result.fallback', {
        windowId: runtime.snapshot.windowId,
        parent_tool_use_id: evt.parent_tool_use_id,
      })
      const toolUseId = evt.parent_tool_use_id
      const existing = toolUseId
        ? runtime.snapshot.messages.find((m) => m.id === `tool-${toolUseId}`)
        : null
      const content =
        typeof result === 'string'
          ? result
          : typeof result?.content === 'string'
            ? result.content
            : compactText(result?.content ?? result)
      const summaryLine = content.split('\n').slice(0, 8).join('\n')
      if (existing) {
        existing.text = summaryLine
        existing.status = result?.is_error ? 'failed' : 'completed'
        existing.metadata = result?.is_error ? 'error' : (existing.metadata ?? null)
        existing.updatedAt = now()
        runtime.snapshot.updatedAt = now()
      }
      return
    }

    if (event.type === 'tool_progress') {
      const evt = event as any
      const existing = runtime.snapshot.messages.find((m) => m.id === `tool-${evt.tool_use_id}`)
      if (existing) {
        existing.metadata = `${Math.round(evt.elapsed_time_seconds || 0)}s`
        existing.updatedAt = now()
        runtime.snapshot.updatedAt = now()
      }
      return
    }

    if (event.type === 'auth_status') {
      const evt = event as any
      const output = Array.isArray(evt.output) ? evt.output.join('\n') : ''
      const url = extractUrl(output)
      if (evt.isAuthenticating) {
        appendMessage(runtime.snapshot, {
          id: evt.uuid || `${runtime.snapshot.windowId}-auth-${now()}`,
          role: 'auth_request',
          title: 'Sign in to Claude Code',
          text:
            output.trim() ||
            'Claude Code needs you to sign in. Open the URL below in your browser, approve access, then paste the code back into the terminal where you ran `claude login`.',
          status: 'in_progress',
          authLoginUrl: url,
        })
      } else if (evt.error) {
        appendMessage(runtime.snapshot, {
          id: evt.uuid || `${runtime.snapshot.windowId}-auth-err-${now()}`,
          role: 'error',
          title: 'Authentication failed',
          text: evt.error,
          status: 'failed',
        })
      } else {
        // Auth completed — mark any pending auth_request completed.
        for (const msg of runtime.snapshot.messages) {
          if (msg.role === 'auth_request' && msg.status !== 'completed') {
            msg.status = 'completed'
            msg.updatedAt = now()
          }
        }
      }
      return
    }
    if (event.type === 'assistant') {
      const uuid = (event as any).uuid
      const msg = (event as any).message
      const parentToolUseId: string | null = (event as any).parent_tool_use_id ?? null
      const content = Array.isArray(msg?.content) ? msg.content : []
      log('claude.assistant', {
        windowId: runtime.snapshot.windowId,
        uuid,
        parentToolUseId,
        contentTypes: content.map((c: any) => c?.type ?? 'unknown'),
        textBlocks: content.filter((c: any) => c?.type === 'text').length,
        toolBlocks: content.filter((c: any) => c?.type === 'tool_use').length,
      })
      const text = flattenClaudeText(msg)
      // If we've already been streaming text under stream-<uuid>, overwrite it
      // with the authoritative text and mark it completed. Avoids double-
      // rendering and ensures the final text matches the model's output.
      const streamingId = `stream-${uuid}`
      const streamed = runtime.snapshot.messages.find((m) => m.id === streamingId)
      if (streamed && streamed.role === 'assistant' && text.trim()) {
        streamed.text = text
        streamed.status = 'completed'
        streamed.updatedAt = now()
        if (parentToolUseId && !streamed.parentToolUseId) {
          streamed.parentToolUseId = parentToolUseId
        }
        runtime.snapshot.updatedAt = now()
      } else if (text.trim()) {
        appendMessage(runtime.snapshot, {
          id: uuid,
          role: 'assistant',
          text,
          status: 'completed',
          parentToolUseId,
        })
      }
      // Finalize any tool_use messages that didn't get stream_event starts.
      for (const toolMessage of extractClaudeToolMessages(msg, uuid, parentToolUseId)) {
        const existing = runtime.snapshot.messages.find((m) => m.id === toolMessage.id)
        if (existing) {
          // Update the input — stream_event may have stored an empty shell.
          if (toolMessage.text && toolMessage.text !== '{}') existing.text = toolMessage.text
          if (!existing.title || existing.title === 'Tool') existing.title = toolMessage.title
          if (toolMessage.toolUseId && !existing.toolUseId)
            existing.toolUseId = toolMessage.toolUseId
          if (toolMessage.parentToolUseId && !existing.parentToolUseId) {
            existing.parentToolUseId = toolMessage.parentToolUseId
          }
          runtime.snapshot.updatedAt = now()
          continue
        }
        log('claude.tool.finalize-fallback', {
          windowId: runtime.snapshot.windowId,
          toolName: toolMessage.title,
          id: toolMessage.id,
        })
        appendMessage(runtime.snapshot, toolMessage)
      }
      return
    }
    if (event.type === 'system' && (event as any).subtype === 'session_state_changed') {
      const state = (event as any).state
      runtime.snapshot.status =
        state === 'running' ? 'running' : state === 'requires_action' ? 'error' : 'idle'
      return
    }
    if (event.type === 'system' && (event as any).subtype === 'local_command_output') {
      appendMessage(runtime.snapshot, {
        id: (event as any).uuid,
        role: 'system',
        title: 'Claude Code',
        text: (event as any).content,
      })
      return
    }
    if (event.type === 'result' && (event as any).is_error) {
      const rawError = Array.isArray((event as any).errors)
        ? (event as any).errors.join('\n')
        : 'Claude Code failed'

      // "No conversation found with session ID" means the resume target has
      // been garbage-collected by the Claude CLI. This is a common case on
      // app restart when the user hasn't used the agent for a while. Silently
      // drop the stale session id, clear any prior error rows from earlier
      // failed resumes, and let the next send() reopen as a fresh session —
      // matches Craft's session-expired fallback (claude-agent.ts "Suppress
      // session-expired errors during resume/fork").
      if (
        rawError.includes('No conversation found with session ID') ||
        rawError.includes('session has expired') ||
        rawError.includes('session not found')
      ) {
        log('claude.resume.stale-session', {
          windowId: runtime.snapshot.windowId,
          sessionId: runtime.snapshot.claudeSessionId,
        })
        runtime.snapshot.claudeSessionId = null
        runtime.snapshot.status = 'idle'
        runtime.snapshot.error = null
        // Drop any "No conversation found" error bubbles that accumulated
        // from earlier failed resumes — they're noise the user shouldn't see.
        runtime.snapshot.messages = runtime.snapshot.messages.filter(
          (m) =>
            !(
              m.role === 'error' &&
              typeof m.text === 'string' &&
              (m.text.includes('No conversation found with session ID') ||
                m.text.includes('session has expired') ||
                m.text.includes('session not found'))
            ),
        )
        runtime.closed = true
        return
      }

      runtime.snapshot.status = 'error'
      runtime.snapshot.error = rawError

      if (isClaudeAuthError(rawError)) {
        appendMessage(runtime.snapshot, {
          id: (event as any).uuid,
          role: 'auth_request',
          title: 'Sign in to Claude Code',
          text: "Claude Code isn't signed in on this machine yet. Open a login session below to authenticate — once it finishes you can retry your last message.",
          status: 'in_progress',
          authLoginUrl: null,
        })
        // Clear the top-level error so the window chrome doesn't also show
        // the raw "Claude Code failed" banner alongside the auth card.
        runtime.snapshot.error = null
      } else {
        appendMessage(runtime.snapshot, {
          id: (event as any).uuid,
          role: 'error',
          title: 'Claude Code',
          text: rawError,
          status: 'failed',
        })
      }
      return
    }
    if (event.type === 'result') {
      runtime.snapshot.status = 'idle'
      runtime.snapshot.error = null
      // Capture token accounting so the renderer can display
      // "X% · used / contextWindow". `modelUsage` is keyed by model id —
      // pick the entry matching the runtime's model (or fall back to the
      // first one if the SDK aliased the id).
      const result = event as any
      const modelUsage = result.modelUsage as
        | Record<
            string,
            {
              inputTokens: number
              outputTokens: number
              cacheReadInputTokens: number
              cacheCreationInputTokens: number
              contextWindow: number
            }
          >
        | undefined
      if (modelUsage) {
        const requested = runtime.request.model || DEFAULT_CLAUDE_MODEL
        const pick = modelUsage[requested] ?? Object.values(modelUsage)[0]
        if (pick) {
          runtime.snapshot.usage = {
            model: requested,
            inputTokens: pick.inputTokens ?? 0,
            outputTokens: pick.outputTokens ?? 0,
            cachedInputTokens:
              (pick.cacheReadInputTokens ?? 0) + (pick.cacheCreationInputTokens ?? 0),
            contextWindow: pick.contextWindow ?? null,
            updatedAt: now(),
          }
        }
      }
      // Safety net: if any tool rows are still marked in_progress after the
      // turn finished (tool_result event was dropped or mis-matched),
      // close them out so the UI doesn't keep spinning. Assistant text
      // rows are left as-is — they get finalized via the `assistant` event.
      for (const m of runtime.snapshot.messages) {
        if (m.role === 'tool' && m.status === 'in_progress') {
          m.status = 'completed'
          m.updatedAt = now()
        }
      }
    }
  }

  private async consumeCodexTurn(runtime: CodexRuntime, events: AsyncGenerator<ThreadEvent>) {
    const windowId = runtime.snapshot.windowId
    log('codex.turn.start', { windowId })
    let count = 0
    try {
      for await (const event of events) {
        if (runtime.closed) {
          log('codex.turn.broken-by-close', { windowId, count })
          break
        }
        count += 1
        log('codex.event', { windowId, n: count, type: (event as any).type })
        this.handleCodexEvent(runtime, event)
        this.emitUpdate(runtime.snapshot)
      }
      log('codex.turn.end', { windowId, count })
    } catch (error) {
      runtime.snapshot.status = 'error'
      const rawError = error instanceof Error ? error.message : String(error)
      runtime.snapshot.error = rawError
      if (isCodexAuthError(rawError)) {
        appendMessage(runtime.snapshot, {
          id: `${runtime.snapshot.windowId}-codex-auth-${now()}`,
          role: 'auth_request',
          title: 'Sign in to Codex',
          text: "Codex isn't signed in on this machine yet. Open a login session below — once you finish you can retry your last message.",
          status: 'in_progress',
          authLoginUrl: null,
        })
        runtime.snapshot.error = null
      } else {
        appendMessage(runtime.snapshot, {
          id: `${runtime.snapshot.windowId}-codex-error-${now()}`,
          role: 'error',
          title: 'Codex',
          text: rawError,
          status: 'failed',
        })
      }
      this.emitUpdate(runtime.snapshot)
    }
  }

  private handleCodexEvent(runtime: CodexRuntime, event: ThreadEvent) {
    if (event.type === 'thread.started') {
      runtime.snapshot.codexThreadId = event.thread_id
      return
    }
    if (event.type === 'turn.started') {
      runtime.turnCounter += 1
      runtime.snapshot.status = 'running'
      runtime.snapshot.error = null
      return
    }
    if (event.type === 'turn.completed') {
      runtime.snapshot.status = 'idle'
      runtime.snapshot.error = null
      const usage = (event as any).usage as
        | { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
        | undefined
      if (usage) {
        runtime.snapshot.usage = {
          model: runtime.request.model || null,
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cachedInputTokens: usage.cached_input_tokens ?? 0,
          // Codex SDK doesn't expose a per-model context window; fall back to
          // the known GPT-5 family capacity so the % indicator has a denominator.
          contextWindow: CODEX_DEFAULT_CONTEXT_WINDOW,
          updatedAt: now(),
        }
      }
      return
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      const message = event.type === 'error' ? event.message : event.error.message
      runtime.snapshot.status = 'error'
      runtime.snapshot.error = message
      appendMessage(runtime.snapshot, {
        id: `${runtime.snapshot.windowId}-turn-error-${now()}`,
        role: 'error',
        title: 'Codex',
        text: message,
        status: 'failed',
      })
      return
    }
    // Codex reuses item ids (item_0, item_1 …) across every turn — prefix
    // with the turn counter so a new turn doesn't overwrite the previous
    // turn's messages via upsertMessage.
    const next = codexItemToMessage(event.item)
    if (next) {
      next.id = `t${runtime.turnCounter}-${next.id}`
      appendMessage(runtime.snapshot, next)
    }
  }
}
