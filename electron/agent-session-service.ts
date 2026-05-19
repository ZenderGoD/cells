import { EventEmitter } from 'node:events'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  promises as fs,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { userInfo } from 'node:os'
import * as path from 'node:path'
import { app, shell } from 'electron'
import {
  forkSession,
  query,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKMessage,
  type SDKSession,
} from '@anthropic-ai/claude-agent-sdk'
import { Cursor, type SDKModel as CursorSDKModel } from '@cursor/sdk'
import {
  CopilotClient,
  type CopilotSession,
  type ModelInfo as CopilotSDKModelInfo,
  type PermissionRequest as CopilotPermissionRequest,
  type PermissionRequestResult as CopilotPermissionRequestResult,
  type SessionEvent as CopilotSessionEvent,
} from '@github/copilot-sdk'
import type {
  AgentContextLength,
  AgentSessionName,
  AgentReplyReference,
  AgentUsageStats,
  AgentSessionMessage,
  AgentSessionRequest,
  AgentSessionSnapshot,
  AgentThinkingLevel,
  PendingAgentApproval,
  RecentAgentSessionSummary,
  SavedAgentSessionSummary,
} from '../src/types'
import {
  rewriteAgentComposerMentions,
  type AgentComposerMentionKind,
} from '../src/lib/agent-composer-mentions'
import {
  normalizeClaudeCatalogModelId,
  parseGenericCliVersion,
} from '../src/lib/claude-model-catalog'
import { resolveAgentModelId } from '../src/lib/agent-model-selection'
import {
  inferAgentSessionTitle,
  isPlaceholderAgentSessionTitle,
  sanitizeImportedClaudeUserText,
} from '../src/lib/agent-session-title'

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
  fastMode?: boolean | null,
): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  if (fastMode) return 'low'
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
const DEFAULT_CODEX_MODEL = process.env.CELLS_CODEX_MODEL || 'gpt-5-codex'
const DEFAULT_CURSOR_MODEL = process.env.CELLS_CURSOR_MODEL || 'auto'
const DEFAULT_COPILOT_MODEL = process.env.CELLS_COPILOT_MODEL || 'auto'
const DEFAULT_OPENCODE_MODEL = process.env.CELLS_OPENCODE_MODEL || 'opencode/gpt-5-nano'
const ANSI_ESCAPE_CHAR = String.fromCharCode(27)
const ANSI_COLOR_RE = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, 'g')

// Claude Agent SDK beta flag that opts the prompt into the 1M-token context
// window. Documented in `@anthropic-ai/claude-agent-sdk` as `SdkBeta =
// 'context-1m-2025-08-07'` and only applies to Sonnet 4 / 4.5. Passed via
// `SDKSessionOptions.betas`.
const CLAUDE_CONTEXT_1M_BETA = 'context-1m-2025-08-07' as const

// Upper bound on consecutive silent auto-continuations per user turn. If a
// single prompt keeps hitting `max_turns` after this many retries, stop and
// leave the session idle so the user can take over — avoids pinning a model
// that's genuinely stuck in a loop.
const CLAUDE_AUTO_CONTINUE_CAP = 3
const CLAUDE_IDLE_STREAM_BACKOFF_MS = 250
const CODEX_INTERRUPT_REQUEST_TIMEOUT_MS = 5_000
const CODEX_INTERRUPT_GRACE_MS = 30_000
const AGENT_SESSION_DEBUG = process.env.CELLS_AGENT_SESSION_DEBUG === '1'

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

const AGENT_MENTION_ROOT_PREFIXES = [
  '.agents',
  '.claude',
  '.codex',
  '.cursor',
  '.github',
  '.opencode',
] as const

function resolveAgentComposerPath(
  cwd: string | null | undefined,
  _kind: AgentComposerMentionKind,
  rawValue: string,
): string | null {
  const value = rawValue.trim()
  if (!value) return null
  if (path.isAbsolute(value)) {
    return existsSync(value) ? value : null
  }

  const matchedPrefix = AGENT_MENTION_ROOT_PREFIXES.find(
    (prefix) => value === prefix || value.startsWith(`${prefix}/`),
  )
  if (!matchedPrefix || !cwd) return null

  let current = path.resolve(cwd)
  while (true) {
    const candidate = path.join(current, value)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

// Used as a last-resort fallback when the Codex app-server hasn't reported
// the model's live context window yet.
const CODEX_DEFAULT_CONTEXT_WINDOW = 272_000

const CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Plan Mode (Conversational)

You work in 3 phases, and you should chat your way to a great plan before finalizing it. A great plan is very detailed intent-wise and implementation-wise so that it can be handed to another engineer or agent to be implemented right away. It must be decision complete, where the implementer does not need to make any decisions.

## Mode rules (strict)

You are in Plan Mode until a developer message explicitly ends it.

Plan Mode is not changed by user intent, tone, or imperative language. If a user asks for execution while still in Plan Mode, treat it as a request to plan the execution, not perform it.

## Plan Mode vs update_plan tool

Plan Mode is a collaboration mode that can involve requesting user input and eventually issuing a <proposed_plan> block.

Separately, update_plan is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode. Do not confuse it with Plan mode or try to use it while in Plan mode. If you try to use update_plan in Plan mode, it will return an error.

## Execution vs. mutation in Plan Mode

You may explore and execute non-mutating actions that improve the plan. You must not perform mutating actions.

### Allowed (non-mutating, plan-improving)

Actions that gather truth, reduce ambiguity, or validate feasibility without changing repo-tracked state. Examples:

* Reading or searching files, configs, schemas, types, manifests, and docs
* Static analysis, inspection, and repo exploration
* Dry-run style commands when they do not edit repo-tracked files
* Tests, builds, or checks that may write to caches or build artifacts (for example, target/, .cache/, or snapshots) so long as they do not edit repo-tracked files

### Not allowed (mutating, plan-executing)

Actions that implement the plan or change repo-tracked state. Examples:

* Editing or writing files
* Running formatters or linters that rewrite files
* Applying patches, migrations, or codegen that updates repo-tracked files
* Side-effectful commands whose purpose is to carry out the plan rather than refine it

When in doubt: if the action would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## PHASE 1 - Ground in the environment (explore first, ask second)

Begin by grounding yourself in the actual environment. Eliminate unknowns in the prompt by discovering facts, not by asking the user. Resolve all questions that can be answered through exploration or inspection. Identify missing or ambiguous details only if they cannot be derived from the environment. Silent exploration between turns is allowed and encouraged.

Before asking the user any question, perform at least one targeted non-mutating exploration pass, unless no local environment or repo is available.

Exception: you may ask clarifying questions about the user's prompt before exploring, ONLY if there are obvious ambiguities or contradictions in the prompt itself. However, if ambiguity might be resolved by exploring, always prefer exploring first.

Do not ask questions that can be answered from the repo or system. Only ask once you have exhausted reasonable non-mutating exploration.

## PHASE 2 - Intent chat (what they actually want)

* Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.
* Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet-ask.

## PHASE 3 - Implementation chat (what/how we'll build)

* Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.

## Asking questions

Critical rules:

* Strongly prefer using the request_user_input tool to ask any questions.
* Offer only meaningful multiple-choice options; don't include filler choices that are obviously wrong or irrelevant.
* In rare cases where an unavoidable, important question can't be expressed with reasonable multiple-choice options, you may ask it directly without the tool.

Use the request_user_input tool only for decisions that materially change the plan, for confirming important assumptions, or for information that cannot be discovered via non-mutating exploration.

## Finalization rule

Only output the final plan when it is decision complete and leaves no decisions to the implementer.

When you present the official plan, wrap it in a <proposed_plan> block so the client can render it specially.
</collaboration_mode>`

const CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different <collaboration_mode>...</collaboration_mode> change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.

## request_user_input availability

The request_user_input tool is unavailable in Default mode.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.
</collaboration_mode>`

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

const ATTACHMENTS_ONLY_TEXT = '(attached files)'

function normalizeReplyPreview(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 220)
}

function escapeReplyAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function buildReplyContext(replyTo: AgentReplyReference | null | undefined): string {
  if (!replyTo) return ''
  const label = normalizeReplyPreview(replyTo.label) || 'Referenced message'
  const preview =
    normalizeReplyPreview(replyTo.preview).replace(/<\/replying_to>/gi, '<\\/replying_to>') || label
  const title = normalizeReplyPreview(replyTo.title ?? '')
  const titleAttribute = title ? ` title="${escapeReplyAttribute(title)}"` : ''
  return [
    `<replying_to role="${replyTo.role}" label="${escapeReplyAttribute(label)}"${titleAttribute}>`,
    preview,
    '</replying_to>',
    '',
  ].join('\n')
}

function imageAttachmentReference(index: number) {
  return `[Image ${index + 1}]`
}

function buildImageReferenceLine(paths: string[], text: string) {
  const missingRefs = paths
    .map((_p, index) => imageAttachmentReference(index))
    .filter((ref) => !text.includes(ref))
  if (missingRefs.length === 0) return ''
  return missingRefs.join(' ') + '\n\n'
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
let cachedCursorAgentPath: string | null | undefined
let cachedCopilotPath: string | null | undefined
let cachedOpencodePath: string | null | undefined
let cachedBundledCopilotNativePath: string | null | undefined
let cachedBundledCopilotLoaderPath: string | null | undefined
let cachedCopilotNodePath: string | null | undefined
let cachedCopilotWrapperPath: string | null | undefined

export function setCustomAgentPaths(paths: Record<string, string>) {
  if (paths.claude !== undefined) {
    cachedClaudePath = paths.claude?.trim() || undefined
  }
  if (paths.codex !== undefined) {
    cachedCodexPath = paths.codex?.trim() || undefined
  }
  if (paths.cursor !== undefined) {
    cachedCursorAgentPath = paths.cursor?.trim() || undefined
  }
  if (paths.copilot !== undefined) {
    cachedCopilotPath = paths.copilot?.trim() || undefined
  }
  if (paths.opencode !== undefined) {
    cachedOpencodePath = paths.opencode?.trim() || undefined
  }
}

function getSystemClaudePath(): string | null {
  if (cachedClaudePath === undefined) cachedClaudePath = resolveSystemBinary('claude')
  return cachedClaudePath
}

function getSystemCodexPath(): string | null {
  if (cachedCodexPath === undefined) cachedCodexPath = resolveSystemBinary('codex')
  return cachedCodexPath
}

function getSystemCursorAgentPath(): string | null {
  if (cachedCursorAgentPath === undefined) {
    cachedCursorAgentPath = resolveSystemBinary('cursor-agent')
  }
  return cachedCursorAgentPath
}

function getSystemCopilotPath(): string | null {
  if (cachedCopilotPath === undefined) cachedCopilotPath = resolveSystemBinary('copilot')
  return cachedCopilotPath
}

function getSystemOpencodePath(): string | null {
  if (cachedOpencodePath === undefined) cachedOpencodePath = resolveSystemBinary('opencode')
  return cachedOpencodePath
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function getCopilotNodePath(): string | null {
  if (cachedCopilotNodePath !== undefined) return cachedCopilotNodePath
  const candidates = [
    process.env.CELLS_COPILOT_NODE,
    process.env.npm_node_execpath,
    resolveSystemBinary('node'),
  ].filter((candidate): candidate is string => Boolean(candidate && existsSync(candidate)))

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-e', 'import("node:sqlite").then(()=>process.exit(0))'], {
        stdio: 'ignore',
        timeout: 2500,
      })
      cachedCopilotNodePath = candidate
      return candidate
    } catch {
      // The bundled Copilot CLI currently imports node:sqlite, so Electron's
      // embedded Node and older system Node builds cannot run it.
    }
  }

  cachedCopilotNodePath = null
  return null
}

function getBundledCopilotLoaderPath(): string | null {
  if (cachedBundledCopilotLoaderPath !== undefined) return cachedBundledCopilotLoaderPath
  const candidates: string[] = []
  const roots = [
    process.cwd(),
    app.getAppPath(),
    path.dirname(app.getAppPath()),
    process.resourcesPath,
    path.join(process.resourcesPath, 'app.asar.unpacked'),
  ]

  for (const root of roots) {
    candidates.push(path.join(root, 'node_modules', '@github', 'copilot', 'npm-loader.js'))
    const pnpmDir = path.join(root, 'node_modules', '.pnpm')
    try {
      for (const entry of readdirSync(pnpmDir)) {
        if (entry.startsWith('@github+copilot@')) {
          candidates.push(
            path.join(pnpmDir, entry, 'node_modules', '@github', 'copilot', 'npm-loader.js'),
          )
        }
      }
    } catch {
      // ignore
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBundledCopilotLoaderPath = candidate
      return candidate
    }
  }
  cachedBundledCopilotLoaderPath = null
  return null
}

function getBundledCopilotNativePath(): string | null {
  if (cachedBundledCopilotNativePath !== undefined) return cachedBundledCopilotNativePath
  const packageName = `@github/copilot-${process.platform}-${process.arch}`
  const executableName = process.platform === 'win32' ? 'copilot.exe' : 'copilot'
  const candidates: string[] = []
  const roots = [
    process.cwd(),
    app.getAppPath(),
    path.dirname(app.getAppPath()),
    process.resourcesPath,
    path.join(process.resourcesPath, 'app.asar.unpacked'),
  ]

  for (const root of roots) {
    candidates.push(path.join(root, 'node_modules', packageName, executableName))
    const pnpmDir = path.join(root, 'node_modules', '.pnpm')
    try {
      for (const entry of readdirSync(pnpmDir)) {
        if (entry.startsWith(`${packageName.replace('/', '+')}@`)) {
          candidates.push(path.join(pnpmDir, entry, 'node_modules', packageName, executableName))
        }
      }
    } catch {
      // ignore
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBundledCopilotNativePath = candidate
      return candidate
    }
  }
  cachedBundledCopilotNativePath = null
  return null
}

function getCopilotCliPath(): string | null {
  const system = getSystemCopilotPath()
  if (system) return system
  const native = getBundledCopilotNativePath()
  if (native) return native

  const nodePath = getCopilotNodePath()
  const loaderPath = getBundledCopilotLoaderPath()
  if (!nodePath || !loaderPath) return null

  if (cachedCopilotWrapperPath && existsSync(cachedCopilotWrapperPath))
    return cachedCopilotWrapperPath
  try {
    const dir = path.join(app.getPath('userData'), 'agent-bin')
    mkdirSync(dir, { recursive: true })
    const wrapperPath = path.join(dir, 'copilot-bundled')
    writeFileSync(
      wrapperPath,
      `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(loaderPath)} "$@"\n`,
      'utf8',
    )
    chmodSync(wrapperPath, 0o755)
    cachedCopilotWrapperPath = wrapperPath
    return wrapperPath
  } catch (err) {
    log('copilot.wrapper.error', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

function getCopilotLoginCommandParts(): {
  command: string
  argsPrefix: string[]
  displayPath: string
} | null {
  const system = getSystemCopilotPath()
  if (system) return { command: system, argsPrefix: [], displayPath: system }
  const native = getBundledCopilotNativePath()
  if (native) return { command: native, argsPrefix: [], displayPath: native }
  const bundled = getBundledCopilotLoaderPath()
  const nodePath = getCopilotNodePath()
  if (bundled && nodePath) return { command: nodePath, argsPrefix: [bundled], displayPath: bundled }
  return null
}

function buildCopilotClient(cwd?: string | null): CopilotClient {
  const cliPath = getCopilotCliPath()
  if (!cliPath) {
    throw new Error(
      'GitHub Copilot CLI is unavailable. Install the copilot CLI, or install Node.js 22+ so Cells can run the bundled CLI.',
    )
  }
  return new CopilotClient({
    cliPath,
    cwd: cwd ?? undefined,
    logLevel: AGENT_SESSION_DEBUG ? 'debug' : 'error',
    env: buildAgentEnv(cwd ? { PWD: cwd } : {}),
    useLoggedInUser: true,
  })
}

export interface AgentAuthStatus {
  agent: AgentSessionName
  binaryPath: string | null
  authenticated: boolean | 'unknown'
  account?: string | null
}

const AGENT_STATUS_TIMEOUT_MS = 5_000
const CODEX_APP_SERVER_TIMEOUT_MS = 8_000

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type CapturedCommandResult = {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
}

type JsonRpcId = number | string

type JsonRpcResponse = {
  id?: JsonRpcId
  result?: unknown
  error?: { code?: number; message?: string }
}

type CodexAppServerClient = {
  request<TResult = unknown>(method: string, params?: Record<string, unknown>): Promise<TResult>
  notify(method: string, params?: Record<string, unknown>): Promise<void>
}

type CodexAppServerNotification = {
  method: string
  params?: unknown
}

type CodexAppServerRequest = {
  id: JsonRpcId
  method: string
  params?: unknown
}

type LiveCodexAppServerClient = CodexAppServerClient & {
  close(): Promise<void>
  isClosed(): boolean
}

function appendBoundedText(current: string, next: string, max = 16_000): string {
  return (current + next).slice(-max)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asNonEmptyText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.length > 0 ? value : null
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const candidates = [trimmed]
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      const record = asRecord(parsed)
      if (record) return record
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

async function writeJsonLine(
  child: ChildProcessWithoutNullStreams,
  payload: unknown,
): Promise<void> {
  if (child.stdin.destroyed || !child.stdin.writable) {
    throw new Error('stdin is not writable')
  }
  await new Promise<void>((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function runCapturedCommand(
  binary: string,
  args: string[],
  options: { timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<CapturedCommandResult> {
  const timeoutMs = options.timeoutMs ?? AGENT_STATUS_TIMEOUT_MS
  return await new Promise<CapturedCommandResult>((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(binary, args, {
        env: buildAgentEnv(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      reject(err)
      return
    }
    const finish = (result: CapturedCommandResult | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish(new Error(`${path.basename(binary)} ${args.join(' ')} timed out`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBoundedText(stdout, chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBoundedText(stderr, chunk)
    })
    child.on('error', (err) => finish(err))
    child.on('close', (code, signal) => finish({ stdout, stderr, code, signal }))
  })
}

function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: 'cells',
      title: 'Cells',
      version: app.getVersion(),
    },
    capabilities: {
      experimentalApi: true,
    },
  }
}

function buildCodexApprovalPolicy(
  mode: AgentSessionRequest['permissionMode'],
): 'untrusted' | 'on-request' | 'never' {
  if (mode === 'plan') return 'untrusted'
  if (mode === 'ask') return 'on-request'
  return 'never'
}

function buildCodexThreadSandbox(mode: AgentSessionRequest['permissionMode']) {
  if (mode === 'plan') return 'read-only' as const
  if (mode === 'bypass') return 'danger-full-access' as const
  return 'workspace-write' as const
}

function buildCodexTurnSandboxPolicy(mode: AgentSessionRequest['permissionMode']) {
  if (mode === 'plan') {
    return {
      type: 'readOnly' as const,
      networkAccess: true,
      access: { type: 'fullAccess' as const },
    }
  }
  if (mode === 'bypass') {
    return { type: 'dangerFullAccess' as const }
  }
  return {
    type: 'workspaceWrite' as const,
    networkAccess: true,
    readOnlyAccess: { type: 'fullAccess' as const },
  }
}

function buildCodexCollaborationMode(
  mode: AgentSessionRequest['permissionMode'],
  model: string | null | undefined,
  thinkingLevel: AgentThinkingLevel | null | undefined,
  fastMode?: boolean | null,
) {
  const collaborationMode = mode === 'plan' ? 'plan' : 'default'
  return {
    mode: collaborationMode,
    settings: {
      ...(model ? { model } : {}),
      reasoning_effort: codexThinkingEffort(thinkingLevel, fastMode),
      developer_instructions:
        collaborationMode === 'plan'
          ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
          : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    },
  }
}

function buildCodexThreadStartParams(request: AgentSessionRequest) {
  return {
    cwd: request.cwd ?? undefined,
    approvalPolicy: buildCodexApprovalPolicy(request.permissionMode),
    sandbox: buildCodexThreadSandbox(request.permissionMode),
    model: request.model || DEFAULT_CODEX_MODEL,
  }
}

function buildCodexTurnInput(agentText: string, imageAttachments: string[]) {
  const input: Array<{ type: 'text'; text: string } | { type: 'localImage'; path: string }> = []
  if (agentText.trim()) input.push({ type: 'text', text: agentText })
  for (const p of imageAttachments) input.push({ type: 'localImage', path: p })
  return input
}

function buildCodexTurnStartParams(
  runtime: CodexRuntime,
  input: string,
  imageAttachments: string[],
): Record<string, unknown> {
  const request = runtime.request
  return {
    threadId: runtime.providerThreadId ?? runtime.snapshot.codexThreadId,
    input: buildCodexTurnInput(input, imageAttachments),
    approvalPolicy: buildCodexApprovalPolicy(request.permissionMode),
    sandboxPolicy: buildCodexTurnSandboxPolicy(request.permissionMode),
    cwd: request.cwd ?? undefined,
    model: request.model || DEFAULT_CODEX_MODEL,
    effort: codexThinkingEffort(request.thinkingLevel, request.fastMode),
    collaborationMode: buildCodexCollaborationMode(
      request.permissionMode,
      request.model || DEFAULT_CODEX_MODEL,
      request.thinkingLevel,
      request.fastMode,
    ),
  }
}

function isCodexRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    message.includes('thread') &&
    (message.includes('not found') ||
      message.includes('no rollout found') ||
      message.includes('does not exist') ||
      message.includes('unknown thread') ||
      message.includes('failed to resume'))
  )
}

function isCodexReconnectMessage(message: string | null | undefined): boolean {
  const trimmed = message?.trim() ?? ''
  if (!trimmed) return false
  return /^reconnecting(?:\.{3}|…)?\s*(?:(\d+)\s*\/\s*(\d+))?$/i.test(trimmed)
}

function codexQuestionResponse(answers: Record<string, string[]>): {
  answers: Record<string, { answers: string[] }>
} {
  const result: Record<string, { answers: string[] }> = {}
  for (const [key, value] of Object.entries(answers)) {
    result[key] = { answers: value }
  }
  return { answers: result }
}

function isCursorAuthError(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('not authenticated') ||
    t.includes('authentication') ||
    t.includes('api key') ||
    t.includes('unauthorized') ||
    t.includes('forbidden') ||
    t.includes('login')
  )
}

function isCopilotAuthError(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('not authenticated') ||
    t.includes('authentication') ||
    t.includes('unauthorized') ||
    t.includes('forbidden') ||
    t.includes('login') ||
    t.includes('copilot subscription')
  )
}

function isOpencodeAuthError(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('not authenticated') ||
    t.includes('no credentials') ||
    t.includes('auth login') ||
    t.includes('authentication') ||
    t.includes('unauthorized') ||
    t.includes('forbidden') ||
    t.includes('login')
  )
}

function copilotThinkingEffort(
  level: AgentThinkingLevel | null | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  switch (level) {
    case 'low':
      return 'low'
    case 'high':
      return 'high'
    case 'max':
    case 'xhigh':
      return 'xhigh'
    case 'medium':
      return 'medium'
    default:
      return undefined
  }
}

function opencodeThinkingVariant(
  level: AgentThinkingLevel | null | undefined,
): 'minimal' | 'low' | 'medium' | 'high' | 'max' | undefined {
  switch (level) {
    case 'off':
      return 'minimal'
    case 'low':
      return 'low'
    case 'high':
      return 'high'
    case 'max':
    case 'xhigh':
      return 'max'
    case 'medium':
      return 'medium'
    default:
      return undefined
  }
}

function buildCopilotSystemMessage(mode: AgentSessionRequest['permissionMode']) {
  const lines = [
    'Cells runtime guidance:',
    '- Prefer the current workspace and explicitly referenced files over scanning broad home-directory locations.',
    '- If you need to search outside the workspace, keep paths narrow and explain why.',
  ]
  if (mode === 'plan') {
    lines.push(
      'Cells is running this GitHub Copilot session in Plan mode.',
      'Do not edit files or run shell commands. Inspect and reason only.',
      'When the plan is ready, present it inside <proposed_plan>...</proposed_plan> tags and wait for approval before implementation.',
    )
  }
  return lines.join('\n')
}

function buildOpenCodeProviderText(mode: AgentSessionRequest['permissionMode'], text: string) {
  const lines = [
    'Cells runtime guidance:',
    '- Prefer the current workspace and explicitly referenced files over broad home-directory scans.',
    '- If you need files outside the workspace, use exact paths or narrow directories first.',
  ]
  if (mode === 'plan') {
    lines.push(
      'Cells is running this OpenCode session in Plan mode.',
      'Do not edit files or run mutating commands. Inspect and reason only.',
      'When the plan is ready, present it inside <proposed_plan>...</proposed_plan> tags and wait for approval before implementation.',
    )
  }
  return [...lines, '', text].join('\n')
}

function copilotToolTitle(rawName: string | null | undefined): string {
  const name = (rawName || '').trim()
  if (!name) return 'Tool'
  const normalized = name.replace(/[_-]/g, '').toLowerCase()
  if (normalized === 'shell' || normalized === 'bash' || normalized === 'terminal') return 'Bash'
  if (normalized === 'read' || normalized === 'view' || normalized === 'fileread') return 'Read'
  if (normalized === 'write' || normalized === 'edit' || normalized === 'fileedit') return 'Edit'
  if (normalized === 'grep' || normalized === 'search') return 'Grep'
  if (normalized === 'glob') return 'Glob'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function buildCopilotPendingApproval(request: CopilotPermissionRequest): PendingAgentApproval {
  const payload = request as CopilotPermissionRequest & Record<string, unknown>
  const kind: 'command' | 'file-change' =
    request.kind === 'write' || typeof payload.fileName === 'string' ? 'file-change' : 'command'
  const command = asNonEmptyString(payload.fullCommandText)
  const fileName = asNonEmptyString(payload.fileName)
  const mcpToolTitle = asNonEmptyString(payload.toolTitle)
  const mcpToolName = asNonEmptyString(payload.toolName)
  const url = asNonEmptyString(payload.url)
  const pathValue = asNonEmptyString(payload.path)
  const intention = asNonEmptyString(payload.intention)
  const detail = command || fileName || mcpToolTitle || mcpToolName || url || pathValue || intention
  return {
    kind,
    title: kind === 'file-change' ? 'Approve file changes' : 'Approve tool',
    detail: detail ?? null,
    reason: intention ?? null,
    command: command ?? null,
    grantRoot: fileName ?? pathValue ?? null,
    canApproveForSession: Boolean(
      (payload as Record<string, unknown>).canOfferSessionApproval ?? true,
    ),
    createdAt: now(),
  }
}

function compactCopilotToolResult(data: Record<string, unknown>): string {
  const error = asRecord(data.error)
  if (error) return asNonEmptyString(error.message) || compactText(error)
  const result = asRecord(data.result)
  const detailed = asNonEmptyString(result?.detailedContent)
  const content = asNonEmptyString(result?.content)
  return detailed || content || compactText(result ?? data)
}

function buildCursorProviderText(mode: AgentSessionRequest['permissionMode'], text: string) {
  const guardrails = [
    'Cells runtime guidance:',
    '- Avoid broad recursive glob/search/read operations from /Users, ~, $HOME, /Users/raj, /Applications, ~/Library, ~/Desktop, ~/Documents, ~/Downloads, and other macOS privacy-protected roots.',
    '- Never call the glob tool with targetDirectory set to /Users, ~, $HOME, /Users/raj, /Applications, ~/Library, ~/Desktop, ~/Documents, or ~/Downloads. Use an exact file read or a narrow workspace subdirectory instead.',
    '- For dotfiles or config files in the home directory, check direct standard paths first with exact file reads or shell tests, for example ~/.tmux.conf, ~/.config/tmux/tmux.conf, and ~/.tmux/tmux.conf.',
    '- If a broad search hits macOS permission prompts or permission-denied paths, do not retry the same broad search. Narrow the path or ask the user for the exact file.',
    '- Prefer the current workspace and explicitly referenced files over scanning the whole home directory.',
  ]
  if (mode === 'plan') {
    guardrails.push(
      'Cells is running this Cursor agent in Plan mode.',
      'Do not edit files or run mutating commands. Inspect and reason only.',
      'When the plan is ready, present it inside <proposed_plan>...</proposed_plan> tags and wait for approval before implementation.',
    )
  }
  return [...guardrails, '', text].join('\n')
}

function buildCursorCliPrompt(text: string, imageAttachments: string[]): string {
  if (imageAttachments.length === 0) return text
  const refs = imageAttachments.map((filePath) => `[${filePath}]`).join(' ')
  return text ? `${refs}\n\n${text}` : refs
}

function cursorToolTitle(rawName: string): string {
  const normalized = rawName
    .replace(/ToolCall$/i, '')
    .replace(/[_-]/g, '')
    .toLowerCase()
  if (normalized === 'shell' || normalized === 'bash' || normalized === 'terminal') return 'Bash'
  if (normalized === 'read' || normalized === 'fileread') return 'Read'
  if (normalized === 'edit' || normalized === 'fileedit') return 'Edit'
  if (normalized === 'write' || normalized === 'filewrite') return 'Write'
  if (normalized === 'glob') return 'Glob'
  if (normalized === 'grep' || normalized === 'search') return 'Grep'
  if (normalized === 'ls' || normalized === 'list' || normalized === 'listdir') return 'LS'
  if (normalized === 'webfetch') return 'WebFetch'
  if (normalized === 'websearch') return 'WebSearch'
  if (normalized === 'todowrite') return 'TodoWrite'
  const cleaned = rawName.replace(/ToolCall$/i, '').trim()
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'Tool'
}

function normalizeCursorToolArgs(title: string, rawArgs: Record<string, unknown>) {
  const args = { ...rawArgs }
  if (title === 'Glob') {
    const pattern = asNonEmptyString(args.pattern) ?? asNonEmptyString(args.globPattern)
    const searchPath =
      asNonEmptyString(args.path) ??
      asNonEmptyString(args.targetDirectory) ??
      asNonEmptyString(args.directory)
    if (pattern) args.pattern = pattern
    if (searchPath) args.path = searchPath
  } else if (title === 'Grep') {
    const pattern =
      asNonEmptyString(args.pattern) ??
      asNonEmptyString(args.query) ??
      asNonEmptyString(args.searchPattern)
    const searchPath =
      asNonEmptyString(args.path) ??
      asNonEmptyString(args.targetDirectory) ??
      asNonEmptyString(args.directory)
    if (pattern) args.pattern = pattern
    if (searchPath) args.path = searchPath
  } else if (title === 'LS') {
    const searchPath =
      asNonEmptyString(args.path) ??
      asNonEmptyString(args.targetDirectory) ??
      asNonEmptyString(args.directory)
    if (searchPath) args.path = searchPath
  }
  delete args.globPattern
  delete args.targetDirectory
  return args
}

function isCursorBroadProtectedGlob(title: string, args: Record<string, unknown>) {
  if (title !== 'Glob') return false
  const searchPath = asNonEmptyString(args.path)
  const pattern = asNonEmptyString(args.pattern)
  if (!searchPath || !pattern) return false
  const homeDir = userInfo().homedir
  const resolvedPath = path.resolve(searchPath.replace(/^~(?=$|\/)/, homeDir))
  const protectedRoots = [
    path.resolve(homeDir, 'Library'),
    path.resolve(homeDir, 'Desktop'),
    path.resolve(homeDir, 'Documents'),
    path.resolve(homeDir, 'Downloads'),
    path.resolve('/Applications'),
  ]
  const isProtectedRoot = protectedRoots.some(
    (root) => resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`),
  )
  if (isProtectedRoot) return true
  const isHomeRoot = resolvedPath === path.resolve(homeDir)
  return isHomeRoot && pattern.includes('**')
}

function buildCodexPendingApproval(
  kind: 'command' | 'file-change',
  payload: Record<string, unknown>,
): {
  kind: 'command' | 'file-change'
  title: string
  detail?: string | null
  reason?: string | null
  command?: string | null
  cwd?: string | null
  grantRoot?: string | null
  canApproveForSession?: boolean
  createdAt: number
} {
  const reason = asNonEmptyString(payload.reason)
  const command = asNonEmptyString(payload.command)
  const cwd = asNonEmptyString(payload.cwd)
  const grantRoot = asNonEmptyString(payload.grantRoot)
  const commandActions = Array.isArray(payload.commandActions) ? payload.commandActions : []
  const actionSummary = commandActions
    .map((value) => {
      const action = asRecord(value)
      if (!action) return null
      const type = asNonEmptyString(action.type) || 'command'
      const path = asNonEmptyString(action.path)
      const query = asNonEmptyString(action.query)
      if (path && query) return `${type} ${path} (${query})`
      if (path) return `${type} ${path}`
      return type
    })
    .filter((value): value is string => value !== null)

  const detail =
    kind === 'command'
      ? command ||
        (actionSummary.length > 0 ? actionSummary.slice(0, 3).join(' • ') : null) ||
        reason
      : grantRoot || reason

  return {
    kind,
    title: kind === 'command' ? 'Approve command' : 'Approve file changes',
    detail: detail ?? null,
    reason,
    command,
    cwd,
    grantRoot,
    canApproveForSession: true,
    createdAt: now(),
  }
}

async function createCodexAppServerSession(
  options: {
    onNotification?: (notification: CodexAppServerNotification) => void | Promise<void>
    onRequest?: (request: CodexAppServerRequest) => Promise<unknown>
    onStderr?: (line: string) => void
    onUnexpectedExit?: (error: Error) => void
  } = {},
): Promise<LiveCodexAppServerClient> {
  const binary = getSystemCodexPath() || 'codex'
  const child = spawn(binary, ['app-server'], {
    env: buildAgentEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let buffer = ''
  let stderr = ''
  let stderrRemainder = ''
  let nextId = 0
  let closed = false
  let exitError: Error | null = null
  const pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  let resolveExit: (() => void) | null = null
  let rejectExit: ((error: Error) => void) | null = null
  const exitPromise = new Promise<void>((resolve, reject) => {
    resolveExit = resolve
    rejectExit = reject
  })

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  const writeErrorResponse = async (id: JsonRpcId, err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err))
    try {
      await writeJsonLine(child, {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: error.message || 'codex app-server request failed' },
      })
    } catch {}
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const method = asNonEmptyString(message.method)
      if (method) {
        if (message.id != null) {
          const request: CodexAppServerRequest = {
            id: message.id as JsonRpcId,
            method,
            params: message.params,
          }
          void Promise.resolve(options.onRequest?.(request))
            .then(async (result) => {
              if (closed) return
              await writeJsonLine(child, { jsonrpc: '2.0', id: request.id, result })
            })
            .catch(async (err) => {
              await writeErrorResponse(request.id, err)
            })
          continue
        }
        void Promise.resolve(options.onNotification?.({ method, params: message.params })).catch(
          () => {},
        )
        continue
      }
      if (message.id == null) continue
      const request = pending.get(message.id as JsonRpcId)
      if (!request) continue
      pending.delete(message.id as JsonRpcId)
      const response = message as JsonRpcResponse
      if (response.error) {
        request.reject(
          new Error(
            response.error.message || `codex app-server request ${String(message.id)} failed`,
          ),
        )
      } else {
        request.resolve(response.result)
      }
    }
  })

  child.stderr.on('data', (chunk: string) => {
    stderr = appendBoundedText(stderr, chunk, 4_000)
    stderrRemainder += chunk
    const lines = stderrRemainder.split('\n')
    stderrRemainder = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, '').trim()
      if (!trimmed) continue
      options.onStderr?.(trimmed)
    }
  })

  child.on('error', (err) => {
    if (closed) return
    exitError = err instanceof Error ? err : new Error(String(err))
    closed = true
    rejectPending(exitError)
    rejectExit?.(exitError)
    options.onUnexpectedExit?.(exitError)
  })

  child.on('exit', (code, signal) => {
    const alreadyClosed = closed
    const detail = stderr.trim()
    exitError =
      exitError ||
      new Error(
        detail ||
          (signal
            ? `codex app-server exited via ${signal}`
            : `codex app-server exited with code ${code ?? 'unknown'}`),
      )
    closed = true
    rejectPending(exitError)
    if (signal === null && code === 0) {
      resolveExit?.()
      return
    }
    rejectExit?.(exitError)
    if (alreadyClosed) return
    options.onUnexpectedExit?.(exitError)
  })

  const client: LiveCodexAppServerClient = {
    request: async <TResult = unknown>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<TResult> => {
      if (closed) throw exitError || new Error('codex app-server is closed')
      const id = ++nextId
      return await new Promise<TResult>((resolveRequest, rejectRequest) => {
        pending.set(id, {
          resolve: resolveRequest as (value: unknown) => void,
          reject: rejectRequest,
        })
        void writeJsonLine(child, {
          jsonrpc: '2.0',
          id,
          method,
          params,
        }).catch((err) => {
          pending.delete(id)
          rejectRequest(err instanceof Error ? err : new Error(String(err)))
        })
      })
    },
    notify: async (method: string, params: Record<string, unknown> = {}) => {
      if (closed) throw exitError || new Error('codex app-server is closed')
      await writeJsonLine(child, { jsonrpc: '2.0', method, params })
    },
    close: async () => {
      if (closed) {
        try {
          await exitPromise
        } catch {}
        return
      }
      closed = true
      try {
        child.kill('SIGTERM')
      } catch {}
      const forceKill = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, 1_000)
      try {
        await exitPromise
      } catch {
        // Ignore shutdown errors when we initiated the close.
      } finally {
        clearTimeout(forceKill)
      }
    },
    isClosed: () => closed,
  }

  await client.request('initialize', buildCodexInitializeParams())
  await client.notify('initialized', {})
  return client
}

async function withCodexAppServer<T>(
  run: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const client = await createCodexAppServerSession()
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('codex app-server timed out')), CODEX_APP_SERVER_TIMEOUT_MS),
  )
  try {
    return await Promise.race([run(client), timeout])
  } finally {
    await client.close()
  }
}

async function probeClaudeAuthStatus(binaryPath: string): Promise<AgentAuthStatus> {
  const result = await runCapturedCommand(binaryPath, ['auth', 'status'])
  const payload = parseJsonRecord(`${result.stdout}\n${result.stderr}`)
  const loggedIn =
    payload && typeof payload.loggedIn === 'boolean' ? (payload.loggedIn as boolean) : 'unknown'
  return {
    agent: 'claude',
    binaryPath,
    authenticated: loggedIn,
    account: payload ? asNonEmptyString(payload.email) : null,
  }
}

async function probeCodexAuthStatus(binaryPath: string): Promise<AgentAuthStatus> {
  const result = await withCodexAppServer(async (client) => {
    return await client.request('account/read', {})
  })
  const payload = asRecord(result)
  const account = payload ? asRecord(payload.account) : null
  const email = account ? asNonEmptyString(account.email) : null
  const requiresOpenaiAuth =
    payload && typeof payload.requiresOpenaiAuth === 'boolean'
      ? payload.requiresOpenaiAuth
      : undefined
  return {
    agent: 'codex',
    binaryPath,
    authenticated: account ? true : requiresOpenaiAuth === true ? false : 'unknown',
    account: email,
  }
}

async function probeCursorAuthStatus(): Promise<AgentAuthStatus> {
  const binaryPath = getSystemCursorAgentPath()
  if (binaryPath) {
    try {
      const result = await runCapturedCommand(binaryPath, ['status', '--format', 'json'])
      const payload = parseJsonRecord(`${result.stdout}\n${result.stderr}`)
      const userInfo = payload ? asRecord(payload.userInfo) : null
      const email = userInfo ? asNonEmptyString(userInfo.email) : null
      const status = payload ? asNonEmptyString(payload.status) : null
      const isAuthenticated =
        payload && typeof payload.isAuthenticated === 'boolean'
          ? payload.isAuthenticated
          : status === 'authenticated'
            ? true
            : status === 'unauthenticated'
              ? false
              : null
      if (isAuthenticated !== null) {
        return {
          agent: 'cursor',
          binaryPath,
          authenticated: isAuthenticated,
          account: email,
        }
      }
    } catch {
      // Fall through to the SDK/API-key probe.
    }
  }

  try {
    const user = await Cursor.me()
    const name = [user.userFirstName, user.userLastName].filter(Boolean).join(' ').trim()
    return {
      agent: 'cursor',
      binaryPath,
      authenticated: true,
      account: user.userEmail || name || user.apiKeyName || null,
    }
  } catch {
    return {
      agent: 'cursor',
      binaryPath,
      authenticated: process.env.CURSOR_API_KEY ? 'unknown' : false,
      account: null,
    }
  }
}

async function probeCopilotAuthStatus(): Promise<AgentAuthStatus> {
  const command = getCopilotLoginCommandParts()
  const client = buildCopilotClient()
  try {
    await withTimeout(client.start(), AGENT_STATUS_TIMEOUT_MS, 'copilot auth start')
    const status = await withTimeout(
      client.getAuthStatus(),
      AGENT_STATUS_TIMEOUT_MS,
      'copilot auth status',
    )
    return {
      agent: 'copilot',
      binaryPath: getCopilotCliPath() ?? command?.displayPath ?? null,
      authenticated: status.isAuthenticated,
      account: status.login ?? status.statusMessage ?? null,
    }
  } finally {
    const errors = await client
      .stop()
      .catch((err) => [err instanceof Error ? err : new Error(String(err))])
    if (errors.length > 0) {
      log('copilot.auth.stop.error', {
        error: errors.map((err) => err.message).join('\n'),
      })
    }
  }
}

async function probeOpencodeAuthStatus(binaryPath: string): Promise<AgentAuthStatus> {
  const result = await runCapturedCommand(binaryPath, ['auth', 'list'])
  const output = `${result.stdout}\n${result.stderr}`.replace(ANSI_COLOR_RE, '')
  const authenticated =
    /\bcredentials?\b/i.test(output) && !/\b0 credentials?\b/i.test(output)
      ? true
      : /not logged in|no credentials|login/i.test(output)
        ? false
        : 'unknown'
  const account = output
    .split(/\r?\n/)
    .map((line) => line.replace(/[│●┌└~]/g, ' ').trim())
    .find((line) => line && !/^credentials\b/i.test(line) && !/auth\.json/i.test(line))
  return {
    agent: 'opencode',
    binaryPath,
    authenticated,
    account: account || null,
  }
}

export async function getAgentAuthStatus(agent: AgentSessionName): Promise<AgentAuthStatus> {
  if (agent === 'claude') {
    const binaryPath = getSystemClaudePath()
    if (!binaryPath) return { agent, binaryPath: null, authenticated: false }
    try {
      return await probeClaudeAuthStatus(binaryPath)
    } catch {
      return { agent, binaryPath, authenticated: 'unknown' }
    }
  }
  if (agent === 'cursor') {
    return await probeCursorAuthStatus()
  }
  if (agent === 'copilot') {
    try {
      return await probeCopilotAuthStatus()
    } catch {
      return {
        agent,
        binaryPath: getCopilotCliPath(),
        authenticated: false,
        account: null,
      }
    }
  }
  if (agent === 'opencode') {
    const binaryPath = getSystemOpencodePath()
    if (!binaryPath) return { agent, binaryPath: null, authenticated: false }
    try {
      return await probeOpencodeAuthStatus(binaryPath)
    } catch {
      return { agent, binaryPath, authenticated: 'unknown' }
    }
  }
  const binaryPath = getSystemCodexPath()
  if (!binaryPath) return { agent, binaryPath: null, authenticated: false }
  try {
    return await probeCodexAuthStatus(binaryPath)
  } catch {
    return { agent, binaryPath, authenticated: 'unknown' }
  }
}

/**
 * Shell command users would run to sign in. Resolved through the detected
 * system binary when available so we don't rely on PATH at execution time.
 */
export function getAgentLoginCommand(agent: AgentSessionName): string {
  if (agent === 'claude') {
    const bin = getSystemClaudePath() || 'claude'
    return `${bin} auth login`
  }
  if (agent === 'cursor') {
    const bin = getSystemCursorAgentPath() || 'cursor-agent'
    return `${bin} login`
  }
  if (agent === 'copilot') {
    const command = getCopilotLoginCommandParts()
    if (!command) return 'copilot login'
    return [command.command, ...command.argsPrefix, 'login'].join(' ')
  }
  if (agent === 'opencode') {
    const bin = getSystemOpencodePath() || 'opencode'
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

function parseCodexModelInfo(model: Record<string, unknown>): CodexModelInfo | null {
  const id = asNonEmptyString(model.id)
  if (!id) return null
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
        .map((value) => {
          const effort = asRecord(value)
          if (!effort) return null
          return {
            effort: asNonEmptyString(effort.reasoningEffort) || 'medium',
            description: asNonEmptyString(effort.description) || '',
          }
        })
        .filter((value): value is { effort: string; description: string } => value !== null)
    : []
  return {
    id,
    displayName: asNonEmptyString(model.displayName) || id,
    description: asNonEmptyString(model.description) || '',
    isDefault: Boolean(model.isDefault),
    hidden: Boolean(model.hidden),
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: asNonEmptyString(model.defaultReasoningEffort) || 'medium',
  }
}

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
  const list = await withCodexAppServer(async (client) => {
    const models: CodexModelInfo[] = []
    let cursor: string | null = null
    do {
      const page: {
        data?: unknown[]
        nextCursor?: string | null
      } = await client.request('model/list', cursor ? { cursor } : {})
      const data = Array.isArray(page.data) ? page.data : []
      for (const item of data) {
        const parsed = parseCodexModelInfo(asRecord(item) ?? {})
        if (parsed) models.push(parsed)
      }
      cursor = asNonEmptyString(page.nextCursor) ?? null
    } while (cursor)
    return models
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
let cachedClaudeCliVersion: { at: number; version: string | null } | null = null

export interface CursorModelInfo {
  id: string
  displayName: string
  description: string
  parameters?: Array<{
    id: string
    displayName?: string
    values: Array<{ value: string; displayName?: string }>
  }>
  variants?: Array<{
    params: Array<{ id: string; value: string }>
    displayName: string
    description?: string
    isDefault?: boolean
  }>
}

let cachedCursorModels: { at: number; list: CursorModelInfo[] } | null = null

export interface CopilotModelInfo {
  id: string
  displayName: string
  description: string
  isDefault: boolean
  hidden: boolean
  supportedReasoningEfforts: string[]
  defaultReasoningEffort: string
  contextWindow: number | null
}

let cachedCopilotModels: { at: number; list: CopilotModelInfo[] } | null = null

export interface OpencodeModelInfo {
  id: string
  displayName: string
  description: string
  isDefault: boolean
  hidden: boolean
  supportedReasoningEfforts: string[]
  defaultReasoningEffort: string
  contextWindow: number | null
}

let cachedOpencodeModels: { at: number; list: OpencodeModelInfo[] } | null = null

function mapCursorModel(model: CursorSDKModel): CursorModelInfo {
  return {
    id: model.id,
    displayName: model.displayName || model.id,
    description: model.description || '',
    parameters: model.parameters,
    variants: model.variants,
  }
}

function parseCursorCliModels(output: string): CursorModelInfo[] {
  const models: CursorModelInfo[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line === 'Available models' || line.startsWith('Tip:')) continue
    const match = line.match(/^([^\s]+)\s+-\s+(.+)$/)
    if (!match) continue
    const id = match[1]?.trim()
    const labelAndMeta = match[2]?.trim()
    if (!id || !labelAndMeta) continue
    const displayName = labelAndMeta.replace(/\s+\([^)]*\)\s*$/, '').trim() || id
    const meta = labelAndMeta.match(/\(([^)]*)\)\s*$/)?.[1]?.trim()
    models.push({
      id,
      displayName,
      description: meta || '',
      variants: meta?.includes('default')
        ? [{ params: [], displayName, description: meta, isDefault: true }]
        : undefined,
    })
  }
  return models
}

async function listCursorCliModels(): Promise<CursorModelInfo[]> {
  const binaryPath = getSystemCursorAgentPath()
  if (!binaryPath) return []
  const result = await runCapturedCommand(binaryPath, ['models'], { timeoutMs: 15_000 })
  if (result.code !== 0) return []
  return parseCursorCliModels(`${result.stdout}\n${result.stderr}`)
}

export async function listCursorModels(): Promise<CursorModelInfo[]> {
  if (cachedCursorModels && Date.now() - cachedCursorModels.at < 5 * 60_000) {
    return cachedCursorModels.list
  }
  let list: CursorModelInfo[]
  try {
    const raw = await Cursor.models.list()
    list = raw.map(mapCursorModel).filter((model) => model.id.trim().length > 0)
  } catch {
    list = await listCursorCliModels()
  }
  if (list.length > 0) {
    cachedCursorModels = { at: Date.now(), list }
  }
  return list
}

function mapCopilotModel(model: CopilotSDKModelInfo): CopilotModelInfo {
  return {
    id: model.id,
    displayName: model.name || model.id,
    description: '',
    isDefault: false,
    hidden: model.policy?.state === 'disabled' || model.policy?.state === 'unconfigured',
    supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
    defaultReasoningEffort: model.defaultReasoningEffort ?? 'medium',
    contextWindow: model.capabilities?.limits?.max_context_window_tokens ?? null,
  }
}

export async function listCopilotModels(): Promise<CopilotModelInfo[]> {
  if (cachedCopilotModels && Date.now() - cachedCopilotModels.at < 5 * 60_000) {
    return cachedCopilotModels.list
  }
  const client = buildCopilotClient()
  try {
    await withTimeout(client.start(), AGENT_STATUS_TIMEOUT_MS, 'copilot model start')
    const raw = await withTimeout(
      client.listModels(),
      AGENT_STATUS_TIMEOUT_MS,
      'copilot model list',
    )
    const live = raw.map(mapCopilotModel).filter((model) => model.id.trim().length > 0)
    const hasAuto = live.some((model) => model.id === 'auto')
    const list = [
      ...(hasAuto
        ? []
        : [
            {
              id: 'auto',
              displayName: 'Auto',
              description: 'GitHub Copilot account default',
              isDefault: true,
              hidden: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: 'off',
              contextWindow: null,
            } satisfies CopilotModelInfo,
          ]),
      ...live,
    ]
    cachedCopilotModels = { at: Date.now(), list }
    return list
  } finally {
    const errors = await client
      .stop()
      .catch((err) => [err instanceof Error ? err : new Error(String(err))])
    if (errors.length > 0) {
      log('copilot.models.stop.error', {
        error: errors.map((err) => err.message).join('\n'),
      })
    }
  }
}

function prettifyOpencodeModelName(id: string): string {
  const providerless = id.includes('/') ? id.split('/').slice(1).join('/') : id
  return providerless
    .replace(/^gpt-/i, 'GPT-')
    .replace(/-codex/gi, ' Codex')
    .replace(/-mini\b/gi, ' Mini')
    .replace(/-max\b/gi, ' Max')
    .replace(/-spark\b/gi, ' Spark')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/^GPT /, 'GPT-')
    .trim()
}

export async function listOpencodeModels(): Promise<OpencodeModelInfo[]> {
  if (cachedOpencodeModels && Date.now() - cachedOpencodeModels.at < 5 * 60_000) {
    return cachedOpencodeModels.list
  }
  const binary = getSystemOpencodePath()
  if (!binary) return []
  const result = await runCapturedCommand(binary, ['models'], { timeoutMs: 15_000 })
  if (result.code !== 0) return []
  const seen = new Set<string>()
  const models: OpencodeModelInfo[] = []
  for (const rawLine of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
    const id = rawLine.replace(ANSI_COLOR_RE, '').trim()
    if (!id || !id.includes('/') || seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      displayName: prettifyOpencodeModelName(id),
      description: id.startsWith('opencode/')
        ? 'OpenCode account default provider'
        : `${id.split('/')[0]} provider`,
      isDefault: id === DEFAULT_OPENCODE_MODEL,
      hidden: false,
      supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high', 'max'],
      defaultReasoningEffort: 'medium',
      contextWindow: null,
    })
  }
  const hasDefault = models.some((model) => model.isDefault)
  if (!hasDefault && models.length > 0) models[0].isDefault = true
  cachedOpencodeModels = { at: Date.now(), list: models }
  return models
}

function bufferToString(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

function getClaudeCliVersion(): string | null {
  if (cachedClaudeCliVersion && Date.now() - cachedClaudeCliVersion.at < 5 * 60_000) {
    return cachedClaudeCliVersion.version
  }
  const claudeBinary = getSystemClaudePath()
  if (!claudeBinary) return null

  try {
    const output = execFileSync(claudeBinary, ['--version'], {
      encoding: 'utf8',
      env: buildAgentEnv({
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      }),
    })
    const version = parseGenericCliVersion(output)
    cachedClaudeCliVersion = { at: Date.now(), version }
    return version
  } catch (error) {
    const output = `${bufferToString((error as { stdout?: unknown } | null)?.stdout)}\n${bufferToString((error as { stderr?: unknown } | null)?.stderr)}`
    const version = parseGenericCliVersion(output)
    cachedClaudeCliVersion = { at: Date.now(), version }
    return version
  }
}

async function resolveSessionModelId(
  agent: AgentSessionName,
  requested: string | null | undefined,
): Promise<string> {
  try {
    if (agent === 'codex') {
      const models = await listCodexModels()
      return resolveAgentModelId(agent, requested, models, DEFAULT_CODEX_MODEL)
    }
    if (agent === 'cursor') {
      const models = await listCursorModels()
      return resolveAgentModelId(agent, requested, models, DEFAULT_CURSOR_MODEL)
    }
    if (agent === 'copilot') {
      const models = await listCopilotModels()
      return resolveAgentModelId(agent, requested, models, DEFAULT_COPILOT_MODEL)
    }
    if (agent === 'opencode') {
      const models = await listOpencodeModels()
      return resolveAgentModelId(agent, requested, models, DEFAULT_OPENCODE_MODEL)
    }
    const models = await listClaudeModels()
    return resolveAgentModelId(agent, requested, models, DEFAULT_CLAUDE_MODEL)
  } catch {
    return (
      requested ||
      (agent === 'codex'
        ? DEFAULT_CODEX_MODEL
        : agent === 'cursor'
          ? DEFAULT_CURSOR_MODEL
          : agent === 'copilot'
            ? DEFAULT_COPILOT_MODEL
            : agent === 'opencode'
              ? DEFAULT_OPENCODE_MODEL
              : DEFAULT_CLAUDE_MODEL)
    )
  }
}

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
  const cliVersion = getClaudeCliVersion()
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
    const mapped = raw
      .map<ClaudeModelInfo | null>((m) => {
        const id = normalizeClaudeCatalogModelId(
          {
            id: m.value,
            displayName: m.displayName,
            description: m.description,
          },
          cliVersion,
        )
        if (!id) return null
        return {
          id,
          displayName: m.displayName || m.value,
          description: m.description || '',
          supportsEffort: !!m.supportsEffort,
          supportedEffortLevels: (m.supportedEffortLevels as string[] | undefined) ?? [],
          supportsAdaptiveThinking: !!m.supportsAdaptiveThinking,
        }
      })
      .filter((model): model is ClaudeModelInfo => model !== null)
    const deduped = new Map<string, ClaudeModelInfo>()
    for (const model of mapped) {
      if (!deduped.has(model.id)) deduped.set(model.id, model)
    }
    const list = [...deduped.values()]
    cachedClaudeModels = { at: Date.now(), list }
    return list
  } finally {
    releasePrompt()
    try {
      q.close()
    } catch {}
  }
}

export type LoginPhase = 'starting' | 'awaiting_browser' | 'success' | 'failed' | 'cancelled'

export interface LoginEvent {
  agent: AgentSessionName
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
  private active = new Map<AgentSessionName, ActiveLogin>()

  isActive(agent: AgentSessionName): boolean {
    return this.active.has(agent)
  }

  cancel(agent: AgentSessionName) {
    const running = this.active.get(agent)
    if (!running) return
    try {
      running.child.kill('SIGINT')
    } catch {
      // ignore
    }
  }

  async start(agent: AgentSessionName): Promise<void> {
    const existing = this.active.get(agent)
    if (existing) {
      this.emit('event', {
        agent,
        phase: existing.phase,
        url: existing.url,
      } satisfies LoginEvent)
      return
    }

    const binary =
      agent === 'claude'
        ? getSystemClaudePath()
        : agent === 'cursor'
          ? getSystemCursorAgentPath()
          : agent === 'copilot'
            ? getCopilotLoginCommandParts()?.command
            : agent === 'opencode'
              ? getSystemOpencodePath()
              : getSystemCodexPath()
    const copilotCommand = agent === 'copilot' ? getCopilotLoginCommandParts() : null
    if (!binary) {
      this.emit('event', {
        agent,
        phase: 'failed',
        message: `${agent === 'claude' ? 'Claude Code' : agent === 'cursor' ? 'Cursor Agent' : agent === 'copilot' ? 'GitHub Copilot' : agent === 'opencode' ? 'OpenCode' : 'Codex'} CLI not found on PATH.`,
      } satisfies LoginEvent)
      return
    }

    // The claude CLI tries to auto-open the browser itself, which in a
    // packaged Electron app can fail (no $DISPLAY or no xdg-open). We
    // disable that behaviour when we can and open the URL ourselves so
    // the user always lands in their default browser.
    const args =
      agent === 'claude'
        ? ['auth', 'login']
        : agent === 'copilot'
          ? [...(copilotCommand?.argsPrefix ?? []), 'login']
          : agent === 'opencode'
            ? ['auth', 'login']
            : ['login']

    const env = buildAgentEnv({
      // Force non-TTY output; the claude CLI uses a different prompt when
      // stdin isn't a tty and just prints the URL.
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'cells',
      // Cursor opens the browser by default. Disable that and let Cells open
      // the captured URL so the user gets one tab and the UI can track it.
      ...(agent === 'cursor' ? { NO_OPEN_BROWSER: '1' } : {}),
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
        // Subsequent auth probes hit the CLI/app-server directly, so a
        // successful login is immediately visible on the next refresh.
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

type Runtime = ClaudeRuntime | CodexRuntime | CursorRuntime | CopilotRuntime | OpencodeRuntime

interface RuntimeBase {
  request: AgentSessionRequest
  snapshot: AgentSessionSnapshot
  closed: boolean
}

/** A `canUseTool` callback resolver held open while the user decides
 *  whether to approve, reject, or refine a plan produced by ExitPlanMode. */
type PlanApprovalResolver = (result: {
  behavior: 'allow' | 'deny'
  message?: string
  updatedInput?: Record<string, unknown>
}) => void

/** Resolver for an AskUserQuestion prompt parked in `canUseTool`. Once the
 *  user responds we hand the answers back as `updatedInput.answers`, which is
 *  the shape the Claude SDK expects for AskUserQuestion continuation. */
type QuestionApprovalResolver = (result: {
  behavior: 'allow' | 'deny'
  message?: string
  updatedInput?: Record<string, unknown>
}) => void

type CodexQuestionApprovalResolver = (result: {
  answers: Record<string, { answers: string[] }>
}) => void

type CodexApprovalResolver = (result: {
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
}) => void

type CopilotQuestionApprovalResolver = (result: CopilotUserInputResponse) => void
type CopilotUserInputResponse = { answer: string; wasFreeform: boolean }
type CopilotApprovalResolver = (result: CopilotPermissionRequestResult) => void

interface ClaudeRuntime extends RuntimeBase {
  kind: 'claude'
  session: SDKSession
  streamPromise: Promise<void>
  /** Monotonic token for the currently active Claude stream consumer. When a
   *  stop/reopen happens quickly, the previous stream can still unwind with an
   *  abort error after the new session has already started. We ignore any
   *  late events/errors from older generations so they can't flip the fresh
   *  runtime back to closed/idle. */
  streamGeneration: number
  /** Count of consecutive auto-continuations issued without a new user turn
   *  in between. Bumped when we resume a max_turns / pause_turn stoppage,
   *  reset on every real user message. Guards against infinite resume loops
   *  if the model is truly stuck. */
  autoContinueCount: number
  /** Post-compaction token count reported by the most recent `compact_boundary`
   *  event. The `result` event that follows a mid-turn auto-compaction reports
   *  the PRE-compaction prompt size (since that's what actually got sent to
   *  the model), which would otherwise clobber the indicator back to ~100%.
   *  We pin this value into `usage.usedTokens` on the boundary event and skip
   *  the next result's usage reporting so the % bar reflects reality. Cleared
   *  after the next user send() starts a fresh turn. */
  postCompactUsedTokens: number | null
  /** True once the current turn has emitted a context-window-accurate live
   *  usage snapshot (task_progress/task_notification/compact_boundary). */
  liveContextUsageUpdatedThisTurn: boolean
  claudeStreamState: {
    messageIdByScope: Map<string, string>
    textMessageIdByBlock: Map<string, string>
    toolUseIdByBlock: Map<string, string>
  }
  /** Set while the agent has called `ExitPlanMode` and we're blocking the
   *  `canUseTool` return until the user picks approve / reject from the UI. */
  pendingPlanApproval: {
    plan: string
    originalInput: Record<string, unknown>
    resolve: PlanApprovalResolver
  } | null
  /** Set while the agent has called `AskUserQuestion` and we're blocking the
   *  `canUseTool` return until the user submits answers from the banner. */
  pendingQuestion: {
    questions: Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string; preview?: string }>
      multiSelect: boolean
    }>
    originalInput: Record<string, unknown>
    resolve: QuestionApprovalResolver
  } | null
}

interface CodexRuntime extends RuntimeBase {
  kind: 'codex'
  client: LiveCodexAppServerClient
  providerThreadId: string | null
  activeTurnId: string | null
  currentTurnUnifiedDiff: string | null
  turnPromise: Promise<void> | null
  resolveTurn: (() => void) | null
  rejectTurn: ((error: Error) => void) | null
  pendingQuestion: {
    questions: Array<{
      id: string
      question: string
      header: string
      options: Array<{ label: string; description: string }>
      multiSelect: boolean
    }>
    resolve: CodexQuestionApprovalResolver
  } | null
  pendingApproval: {
    kind: 'command' | 'file-change'
    resolve: CodexApprovalResolver
  } | null
  /** Set after Codex emits a `<proposed_plan>` block in agent message text.
   *  Unlike Claude's blocking `canUseTool` pause, Codex's turn is already
   *  complete; this is purely UI state so the renderer can show an approval
   *  banner and the user's choice can drive the next turn. Cleared on
   *  respondPlan() or when the user sends a new message. */
  pendingPlanApproval: {
    plan: string
  } | null
  /** Monotonic counter bumped on every `turn.started`. The Codex CLI reuses
   *  `item_0`, `item_1`, … across turns, so we prefix item ids with this
   *  counter to keep each turn's items distinct in our message list. */
  turnCounter: number
}

interface CursorRuntime extends RuntimeBase {
  kind: 'cursor'
  activeRun: ChildProcessWithoutNullStreams | null
  runPromise: Promise<void> | null
  resolveRun: (() => void) | null
  rejectRun: ((error: Error) => void) | null
  streamGeneration: number
}

interface CopilotRuntime extends RuntimeBase {
  kind: 'copilot'
  client: CopilotClient
  session: CopilotSession
  turnPromise: Promise<void> | null
  resolveTurn: (() => void) | null
  rejectTurn: ((error: Error) => void) | null
  pendingQuestion: {
    questions: Array<{
      id: string
      question: string
      header: string
      options: Array<{ label: string; description: string }>
      multiSelect: boolean
    }>
    resolve: CopilotQuestionApprovalResolver
  } | null
  pendingApproval: {
    kind: 'command' | 'file-change'
    resolve: CopilotApprovalResolver
  } | null
  textByMessageId: Map<string, string>
  reasoningById: Map<string, string>
}

interface OpencodeRuntime extends RuntimeBase {
  kind: 'opencode'
  activeRun: ChildProcessWithoutNullStreams | null
  runPromise: Promise<void> | null
  resolveRun: (() => void) | null
  rejectRun: ((error: Error) => void) | null
  streamGeneration: number
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

function buildUsageStats(input: {
  model: string | null
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  contextWindow: number | null
  compactsAutomatically: boolean
}): AgentUsageStats {
  const inputTokens = Math.max(0, Math.round(input.inputTokens))
  const outputTokens = Math.max(0, Math.round(input.outputTokens))
  const cachedInputTokens = Math.max(0, Math.round(input.cachedInputTokens))
  const contextWindow =
    input.contextWindow && Number.isFinite(input.contextWindow) && input.contextWindow > 0
      ? Math.round(input.contextWindow)
      : null
  const totalProcessedTokens = inputTokens + outputTokens
  const usedTokens =
    totalProcessedTokens > 0
      ? contextWindow != null
        ? Math.min(totalProcessedTokens, contextWindow)
        : totalProcessedTokens
      : null
  return {
    model: input.model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    contextWindow,
    usedTokens,
    totalProcessedTokens: totalProcessedTokens > 0 ? totalProcessedTokens : null,
    compactsAutomatically: input.compactsAutomatically,
    updatedAt: now(),
  }
}

function getClaudeRequestedContextWindow(contextLength: AgentContextLength | null | undefined) {
  return contextLength === 'extended' ? 1_000_000 : 200_000
}

function buildClaudeLiveUsageStats(input: {
  usage: Record<string, unknown> | null
  existingUsage: AgentUsageStats | null | undefined
  model: string | null
  contextLength: AgentContextLength | null | undefined
}): AgentUsageStats | null {
  const totalTokensRaw = input.usage?.total_tokens
  const totalTokens =
    typeof totalTokensRaw === 'number' && Number.isFinite(totalTokensRaw) && totalTokensRaw > 0
      ? Math.round(totalTokensRaw)
      : null
  if (totalTokens == null) return null

  const contextWindow =
    input.existingUsage?.contextWindow ?? getClaudeRequestedContextWindow(input.contextLength)
  const usedTokens = Math.min(totalTokens, contextWindow)

  return {
    model: input.existingUsage?.model ?? input.model,
    inputTokens: input.existingUsage?.inputTokens ?? 0,
    outputTokens: input.existingUsage?.outputTokens ?? 0,
    cachedInputTokens: input.existingUsage?.cachedInputTokens ?? 0,
    contextWindow,
    usedTokens,
    totalProcessedTokens: totalTokens > usedTokens ? totalTokens : null,
    compactsAutomatically: input.existingUsage?.compactsAutomatically ?? true,
    updatedAt: now(),
  }
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
  const timestamp = message.updatedAt ?? now()
  upsertMessage(snapshot.messages, {
    ...message,
    startedAt: message.startedAt ?? timestamp,
    updatedAt: timestamp,
  })
  if (
    (message.role === 'user' || snapshot.messages.length === 1) &&
    isPlaceholderAgentSessionTitle(snapshot.agent, snapshot.title)
  ) {
    snapshot.title = inferAgentSessionTitle(snapshot.agent, snapshot.messages)
  }
  snapshot.updatedAt = now()
}

function appendQuestionAnswerMessage(
  snapshot: AgentSessionSnapshot,
  windowId: string,
  questions: Array<{ question: string; header?: string | null }>,
  pickedByQuestion: Array<{ question: string; picked: string[] }>,
  note: string,
  declined: boolean,
) {
  const lines: string[] = []
  if (declined) {
    lines.push('_Skipped answering._')
  } else {
    for (const question of questions) {
      const entry = pickedByQuestion.find((item) => item.question === question.question)
      const picked = entry?.picked ?? []
      const header = question.header ? `**${question.header}** — ` : ''
      lines.push(`${header}${question.question}`)
      if (picked.length > 0) {
        lines.push(...picked.map((label) => `- ${label}`))
      } else {
        lines.push('- _(no option selected)_')
      }
      lines.push('')
    }
  }
  if (note) {
    lines.push(`> ${note.replace(/\n/g, '\n> ')}`)
  }
  const text = lines.join('\n').trim()
  if (!text) return
  appendMessage(snapshot, {
    id: `${windowId}-question-answer-${now()}`,
    role: 'user',
    text,
    updatedAt: now(),
  })
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
      metadata: compactText(item.input),
      status: 'in_progress' as const,
      updatedAt: now(),
      toolUseId: item.id ?? null,
      parentToolUseId,
    }))
}

function codexItemStatus(value: unknown): AgentSessionMessage['status'] {
  if (value === 'failed') return 'failed'
  if (value === 'completed' || value === 'interrupted' || value === 'cancelled') return 'completed'
  return 'in_progress'
}

// Codex doesn't expose plan-mode as a first-class SDK event — the developer
// prompt instructs the model to wrap its final plan in a <proposed_plan>
// block inside a normal agent message. Pull that block out so we can hand the
// plan markdown to the approval banner and drop the noisy tags from the
// rendered message body.
const CODEX_PROPOSED_PLAN_REGEX = /<proposed_plan>\s*\n([\s\S]*?)\n?\s*<\/proposed_plan>/i
function extractCodexProposedPlan(text: string): { plan: string; stripped: string } | null {
  if (!text || !text.includes('<proposed_plan>')) return null
  const match = text.match(CODEX_PROPOSED_PLAN_REGEX)
  if (!match) return null
  const plan = match[1].trim()
  if (!plan) return null
  const stripped = text.replace(CODEX_PROPOSED_PLAN_REGEX, plan).trim()
  return { plan, stripped }
}

function codexItemToMessage(item: Record<string, unknown>): AgentSessionMessage | null {
  const itemId = asNonEmptyString(item.id)
  const itemType = asNonEmptyString(item.type)
  if (!itemId || !itemType) return null

  if (itemType === 'agentMessage') {
    return {
      id: itemId,
      role: 'assistant',
      text: asNonEmptyString(item.text) || '',
      status: 'completed',
      updatedAt: now(),
    }
  }
  if (itemType === 'reasoning') {
    const summary = Array.isArray(item.summary)
      ? item.summary.filter((value): value is string => typeof value === 'string')
      : []
    const content = Array.isArray(item.content)
      ? item.content.filter((value): value is string => typeof value === 'string')
      : []
    return {
      id: itemId,
      role: 'reasoning',
      title: 'Reasoning',
      text: summary.join('\n\n').trim() || content.join('\n\n').trim(),
      status: 'completed',
      updatedAt: now(),
    }
  }
  if (itemType === 'commandExecution') {
    return {
      id: itemId,
      role: 'tool',
      title: asNonEmptyString(item.command) || 'Command',
      text:
        asNonEmptyString(item.aggregatedOutput) ||
        asNonEmptyString(item.command) ||
        compactText(item, ''),
      status: codexItemStatus(item.status),
      metadata:
        typeof item.exitCode === 'number'
          ? `Exit ${item.exitCode}`
          : asNonEmptyString(item.cwd) || 'Running command',
      updatedAt: now(),
    }
  }
  if (itemType === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    return {
      id: itemId,
      role: 'tool',
      title: 'File changes',
      text: changes
        .map((change) => {
          const entry = asRecord(change)
          if (!entry) return null
          return `${asNonEmptyString(entry.kind) || 'change'}: ${asNonEmptyString(entry.path) || 'unknown'}`
        })
        .filter((value): value is string => Boolean(value))
        .join('\n'),
      status: codexItemStatus(item.status),
      updatedAt: now(),
    }
  }
  if (itemType === 'mcpToolCall') {
    const error = asRecord(item.error)
    return {
      id: itemId,
      role: 'tool',
      title: `${asNonEmptyString(item.server) || 'mcp'}:${asNonEmptyString(item.tool) || 'tool'}`,
      text:
        asNonEmptyString(error?.message) ||
        compactText(item.result ?? item.arguments, compactText(item, '')),
      status: codexItemStatus(item.status),
      updatedAt: now(),
    }
  }
  if (itemType === 'dynamicToolCall' || itemType === 'collabAgentToolCall') {
    return {
      id: itemId,
      role: 'tool',
      title: asNonEmptyString(item.tool) || 'Tool call',
      text:
        asNonEmptyString(item.prompt) ||
        compactText(item.contentItems ?? item.arguments ?? item, ''),
      status: codexItemStatus(item.status),
      updatedAt: now(),
    }
  }
  if (itemType === 'webSearch') {
    return {
      id: itemId,
      role: 'tool',
      title: 'Web search',
      text: asNonEmptyString(item.query) || '',
      status: 'completed',
      updatedAt: now(),
    }
  }
  if (itemType === 'plan') {
    return {
      id: itemId,
      role: 'system',
      title: 'Plan',
      text: asNonEmptyString(item.text) || '',
      status: 'completed',
      updatedAt: now(),
    }
  }
  if (itemType === 'imageView') {
    return {
      id: itemId,
      role: 'system',
      title: 'Image view',
      text: asNonEmptyString(item.path) || '',
      status: 'completed',
      updatedAt: now(),
    }
  }
  if (itemType === 'enteredReviewMode' || itemType === 'exitedReviewMode') {
    return {
      id: itemId,
      role: 'system',
      title: itemType === 'enteredReviewMode' ? 'Review mode entered' : 'Review mode exited',
      text: asNonEmptyString(item.review) || '',
      status: 'completed',
      updatedAt: now(),
    }
  }
  if (itemType === 'contextCompaction') {
    const status = codexItemStatus(item.status)
    return {
      id: itemId,
      role: 'compaction',
      text: status === 'completed' ? 'Context compacted' : 'Compacting context…',
      status,
      updatedAt: now(),
    }
  }
  return null
}

function codexMessageId(runtime: CodexRuntime, itemId: string) {
  return `t${runtime.turnCounter}-${itemId}`
}

function appendCodexDelta(
  snapshot: AgentSessionSnapshot,
  message: Pick<AgentSessionMessage, 'id' | 'role' | 'text' | 'title'>,
) {
  const existing = snapshot.messages.find((entry) => entry.id === message.id)
  if (existing) {
    existing.text = `${existing.text || ''}${message.text}`
    existing.status = 'in_progress'
    existing.updatedAt = now()
    snapshot.updatedAt = now()
    return
  }
  appendMessage(snapshot, {
    id: message.id,
    role: message.role,
    title: message.title,
    text: message.text,
    status: 'in_progress',
    updatedAt: now(),
  })
}

function syncCodexTurnDiffToLatestFileChange(runtime: CodexRuntime) {
  const diff = runtime.currentTurnUnifiedDiff
  if (!diff) return
  const turnPrefix = `t${runtime.turnCounter}-`
  for (let index = runtime.snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = runtime.snapshot.messages[index]
    if (
      message.role === 'tool' &&
      message.title === 'File changes' &&
      message.id.startsWith(turnPrefix)
    ) {
      message.metadata = diff
      message.updatedAt = now()
      runtime.snapshot.updatedAt = now()
      return
    }
  }
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

function getPersistMetaPath(windowId: string): string {
  return path.join(getPersistDir(), `${windowId}.meta.json`)
}

function buildSavedSessionSummary(snapshot: AgentSessionSnapshot): SavedAgentSessionSummary {
  let lastMessageText: string | null = null
  for (let i = snapshot.messages.length - 1; i >= 0; i -= 1) {
    const text = snapshot.messages[i]?.text?.trim()
    if (text) {
      lastMessageText = text
      break
    }
  }
  return {
    windowId: snapshot.windowId,
    agent: snapshot.agent,
    title: snapshot.title,
    cwd: snapshot.cwd ?? null,
    claudeSessionId: snapshot.claudeSessionId ?? null,
    codexThreadId: snapshot.codexThreadId ?? null,
    cursorAgentId: snapshot.cursorAgentId ?? null,
    cursorRunId: snapshot.cursorRunId ?? null,
    copilotSessionId: snapshot.copilotSessionId ?? null,
    opencodeSessionId: snapshot.opencodeSessionId ?? null,
    model: snapshot.usage?.model ?? null,
    updatedAt: snapshot.updatedAt,
    messageCount: snapshot.messages.length,
    lastMessageText,
  }
}

function loadPersistedSummary(windowId: string): SavedAgentSessionSummary | null {
  const file = getPersistMetaPath(windowId)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.windowId !== windowId) return null
    if (
      parsed.agent !== 'claude' &&
      parsed.agent !== 'codex' &&
      parsed.agent !== 'cursor' &&
      parsed.agent !== 'copilot' &&
      parsed.agent !== 'opencode'
    ) {
      return null
    }
    if (typeof parsed.title !== 'string' || typeof parsed.updatedAt !== 'number') return null
    if (typeof parsed.messageCount !== 'number') return null
    return parsed as SavedAgentSessionSummary
  } catch {
    return null
  }
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

function getPersistDebounceMs(snapshot: AgentSessionSnapshot) {
  // Craft avoids this write amplification with append-oriented JSONL storage.
  // Cells still writes full snapshots, so back off aggressively once a live
  // session transcript gets large.
  const messageCount = snapshot.messages.length
  if (messageCount >= 1000) return 10_000
  if (messageCount >= 400) return 5_000
  if (messageCount >= 100) return 1_000
  return 250
}

async function persistSnapshotNow(snapshot: AgentSessionSnapshot) {
  const file = getPersistPath(snapshot.windowId)
  const tmp = `${file}.tmp`
  const serialized = JSON.stringify(snapshot)
  await fs.writeFile(tmp, serialized, 'utf8')
  await fs.rename(tmp, file)
  await persistSummaryNow(buildSavedSessionSummary(snapshot))
}

async function persistSummaryNow(summary: SavedAgentSessionSummary) {
  const metaFile = getPersistMetaPath(summary.windowId)
  const metaTmp = `${metaFile}.tmp`
  const serializedSummary = JSON.stringify(summary)
  await fs.writeFile(metaTmp, serializedSummary, 'utf8')
  await fs.rename(metaTmp, metaFile)
}

function schedulePersist(snapshot: AgentSessionSnapshot) {
  const existing = persistTimers.get(snapshot.windowId)
  if (existing) clearTimeout(existing)
  const delayMs = getPersistDebounceMs(snapshot)
  const timer = setTimeout(() => {
    persistTimers.delete(snapshot.windowId)
    persistSnapshotNow(snapshot).catch((err) => {
      log('persist.write.error', {
        windowId: snapshot.windowId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, delayMs)
  persistTimers.set(snapshot.windowId, timer)
}

// Structured debug logger. Everything goes through here so the user can tell
// us exactly where a stall is happening from the app logs. Keep single-line
// JSON-ish payloads so they're easy to paste back.
function log(event: string, data: Record<string, unknown> = {}) {
  if (!AGENT_SESSION_DEBUG && !event.includes('error') && !event.includes('exit')) return
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

const CLAUDE_NATIVE_PROJECTS_DIR = path.join(userInfo().homedir, '.claude', 'projects')
const CODEX_NATIVE_STATE_DB = path.join(userInfo().homedir, '.codex', 'state_5.sqlite')
const DEFAULT_RECENT_SESSION_LIMIT = 12
const MAX_NATIVE_CLAUDE_SCAN = 80

function toTimestampMs(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) return now()
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function summarizeSessionText(value: string | null | undefined, fallback: string) {
  const trimmed = value?.replace(/\s+/g, ' ').trim()
  if (!trimmed) return fallback
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed
}

function parseTimestampLike(value: unknown) {
  if (typeof value === 'number') return toTimestampMs(value)
  if (typeof value !== 'string' || !value.trim()) return now()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : now()
}

function flattenClaudeToolResultText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const item = part as { type?: unknown; text?: unknown }
      return typeof item.text === 'string' &&
        (item.type === 'input_text' || item.type === 'output_text' || item.type == null)
        ? item.text
        : ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function flattenCodexMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const item = part as { type?: unknown; text?: unknown }
      return typeof item.text === 'string' &&
        (item.type === 'input_text' || item.type === 'output_text' || item.type == null)
        ? item.text
        : ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function collectClaudeNativeSessionFiles(rootDir: string) {
  if (!existsSync(rootDir)) return [] as Array<{ filePath: string; updatedAt: number }>
  const files: Array<{ filePath: string; updatedAt: number }> = []
  const stack = [rootDir]
  while (stack.length > 0 && files.length < MAX_NATIVE_CLAUDE_SCAN) {
    const current = stack.pop()
    if (!current) break
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolutePath = path.join(current, entry)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(absolutePath)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (entry === 'subagents') continue
        stack.push(absolutePath)
        continue
      }
      if (!stat.isFile() || !entry.endsWith('.jsonl')) continue
      files.push({ filePath: absolutePath, updatedAt: stat.mtimeMs })
      if (files.length >= MAX_NATIVE_CLAUDE_SCAN) break
    }
  }
  return files.sort((a, b) => b.updatedAt - a.updatedAt)
}

function findClaudeNativeSessionFile(sessionId: string): string | null {
  return (
    collectClaudeNativeSessionFiles(CLAUDE_NATIVE_PROJECTS_DIR).find(
      (entry) => path.basename(entry.filePath, '.jsonl') === sessionId,
    )?.filePath ?? null
  )
}

function readClaudeNativeSessionMessages(filePath: string): AgentSessionMessage[] {
  try {
    const source = readFileSync(filePath, 'utf8')
    const lines = source.split('\n')
    const messages: AgentSessionMessage[] = []
    const toolMessages = new Map<string, AgentSessionMessage>()
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim()
      if (!line) continue
      const parsed = JSON.parse(line) as {
        type?: unknown
        uuid?: unknown
        timestamp?: unknown
        isSidechain?: unknown
        toolUseResult?: unknown
        message?: { content?: unknown }
      }
      if (parsed.isSidechain) continue
      const updatedAt = parseTimestampLike(parsed.timestamp)
      const contentBlocks = Array.isArray(parsed.message?.content) ? parsed.message.content : []

      if (parsed.type === 'user') {
        const toolResultBlocks = contentBlocks.filter((block: any) => block?.type === 'tool_result')
        if (toolResultBlocks.length > 0) {
          for (const block of toolResultBlocks) {
            const toolUseId = asNonEmptyString(block?.tool_use_id)
            const resultText = flattenClaudeToolResultText(block?.content)
            const summary = resultText.split('\n').slice(0, 8).join('\n').trim()
            if (!summary && !toolUseId) continue
            const existing = toolUseId ? toolMessages.get(toolUseId) : null
            if (existing) {
              existing.text = summary || existing.text
              existing.status = block?.is_error ? 'failed' : 'completed'
              existing.updatedAt = updatedAt
            } else {
              const message: AgentSessionMessage = {
                id: toolUseId ? `tool-${toolUseId}` : `claude-import-tool-result-${index}`,
                role: 'tool',
                title: 'Tool result',
                text: summary,
                status: block?.is_error ? 'failed' : 'completed',
                updatedAt,
                startedAt: updatedAt,
                toolUseId: toolUseId ?? null,
              }
              messages.push(message)
              if (toolUseId) toolMessages.set(toolUseId, message)
            }
          }
          continue
        }

        const text = sanitizeImportedClaudeUserText(flattenClaudeUserText(parsed.message))
        if (!text) continue
        messages.push({
          id: typeof parsed.uuid === 'string' ? parsed.uuid : `claude-import-user-${index}`,
          role: 'user',
          text,
          status: 'completed',
          updatedAt,
        })
        continue
      }

      if (parsed.type === 'assistant') {
        const text = flattenClaudeText(parsed.message)
        if (text) {
          messages.push({
            id: typeof parsed.uuid === 'string' ? parsed.uuid : `claude-import-assistant-${index}`,
            role: 'assistant',
            text,
            status: 'completed',
            updatedAt,
          })
        }
        const tools = extractClaudeToolMessages(parsed.message, `claude-import-${index}`, null).map(
          (message) => ({
            ...message,
            startedAt: updatedAt,
            updatedAt,
          }),
        )
        for (const tool of tools) {
          messages.push(tool)
          if (tool.toolUseId) toolMessages.set(tool.toolUseId, tool)
        }
      }
    }
    return messages
  } catch {
    return []
  }
}

function readClaudeNativeSessionSummary(filePath: string): RecentAgentSessionSummary | null {
  const sessionId = path.basename(filePath, '.jsonl')
  try {
    const source = readFileSync(filePath, 'utf8')
    const lines = source.split('\n')
    let cwd: string | null = null
    let title: string | null = null
    let lastUserText: string | null = null
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      const parsed = JSON.parse(line) as {
        cwd?: unknown
        type?: unknown
        message?: { role?: unknown; content?: unknown }
      }
      if (!cwd && typeof parsed.cwd === 'string' && parsed.cwd.trim()) cwd = parsed.cwd
      const userText = sanitizeImportedClaudeUserText(flattenClaudeUserText(parsed.message))
      if (parsed.type === 'user' && userText?.trim()) {
        const summary = summarizeSessionText(userText, `Claude session ${sessionId.slice(0, 8)}`)
        if (!title) title = summary
        lastUserText = summary
      }
      if (cwd && title && lastUserText) break
    }
    const updatedAt = toTimestampMs(statSync(filePath).mtimeMs)
    return {
      origin: 'native',
      windowId: null,
      nativeId: sessionId,
      agent: 'claude',
      title: title ?? `Claude session ${sessionId.slice(0, 8)}`,
      cwd,
      claudeSessionId: sessionId,
      codexThreadId: null,
      model: null,
      updatedAt,
      messageCount: null,
      lastMessageText: lastUserText,
      sourceLabel: 'Claude Code',
    }
  } catch {
    return null
  }
}

function lookupCodexRolloutPath(threadId: string): string | null {
  const rows = readSqliteRows(
    CODEX_NATIVE_STATE_DB,
    `select rollout_path from threads where id = '${threadId.replace(/'/g, "''")}' limit 1`,
  )
  return rows[0]?.[0] || null
}

function readCodexNativeSessionMessages(threadId: string): AgentSessionMessage[] {
  const rolloutPath = lookupCodexRolloutPath(threadId)
  if (!rolloutPath || !existsSync(rolloutPath)) return []
  try {
    const source = readFileSync(rolloutPath, 'utf8')
    const lines = source.split('\n')
    const messages: AgentSessionMessage[] = []
    const toolMessages = new Map<string, AgentSessionMessage>()
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim()
      if (!line) continue
      const parsed = JSON.parse(line) as {
        type?: unknown
        timestamp?: unknown
        payload?: Record<string, unknown>
      }
      const updatedAt = parseTimestampLike(parsed.timestamp)
      const payload = parsed.payload ?? {}
      if (parsed.type !== 'response_item') continue

      if (payload.type === 'message') {
        const role = asNonEmptyString(payload.role)
        const text = sanitizeImportedClaudeUserText(flattenCodexMessageText(payload.content))
        if (!text || role === 'developer' || role === 'system') continue
        messages.push({
          id: `codex-import-${role ?? 'message'}-${threadId}-${index}`,
          role: role === 'assistant' ? 'assistant' : 'user',
          text,
          status: 'completed',
          updatedAt,
        })
        continue
      }

      if (payload.type === 'reasoning') {
        const summary = Array.isArray(payload.summary)
          ? payload.summary
              .filter((entry): entry is string => typeof entry === 'string')
              .join('\n\n')
              .trim()
          : ''
        if (!summary) continue
        messages.push({
          id: `codex-import-reasoning-${threadId}-${index}`,
          role: 'reasoning',
          title: 'Reasoning',
          text: summary,
          status: 'completed',
          updatedAt,
        })
        continue
      }

      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const callId = asNonEmptyString(payload.call_id)
        if (!callId) continue
        const inputText =
          payload.type === 'function_call'
            ? compactText(payload.arguments, '')
            : compactText(payload.input, '')
        const message: AgentSessionMessage = {
          id: `tool-${callId}`,
          role: 'tool',
          title: asNonEmptyString(payload.name) || 'Tool call',
          text: inputText,
          metadata: inputText || null,
          status: payload.status === 'completed' ? 'completed' : 'in_progress',
          startedAt: updatedAt,
          updatedAt,
        }
        messages.push(message)
        toolMessages.set(callId, message)
        continue
      }

      if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        const callId = asNonEmptyString(payload.call_id)
        if (!callId) continue
        const outputText = compactText(payload.output, '')
        const existing = toolMessages.get(callId)
        if (existing) {
          existing.text = outputText || existing.text
          existing.status = 'completed'
          existing.updatedAt = updatedAt
        } else {
          messages.push({
            id: `tool-${callId}`,
            role: 'tool',
            title: 'Tool result',
            text: outputText,
            status: 'completed',
            startedAt: updatedAt,
            updatedAt,
          })
        }
      }
    }
    return messages
  } catch {
    return []
  }
}

function loadNativeImportMessages(request: AgentSessionRequest, snapshot: AgentSessionSnapshot) {
  if (snapshot.messages.length > 0) return snapshot.messages
  if (request.agent === 'claude' && snapshot.claudeSessionId) {
    const filePath = findClaudeNativeSessionFile(snapshot.claudeSessionId)
    if (!filePath) return snapshot.messages
    return readClaudeNativeSessionMessages(filePath)
  }
  if (request.agent === 'codex' && snapshot.codexThreadId) {
    return readCodexNativeSessionMessages(snapshot.codexThreadId)
  }
  return snapshot.messages
}

function readSqliteRows(dbPath: string, queryText: string) {
  if (!existsSync(dbPath)) return [] as string[][]
  try {
    const output = execFileSync('sqlite3', ['-separator', '\t', dbPath, queryText], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim()
    if (!output) return []
    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
  } catch {
    return []
  }
}

function listCodexNativeSessions(limit: number): RecentAgentSessionSummary[] {
  const rows = readSqliteRows(
    CODEX_NATIVE_STATE_DB,
    `select id, coalesce(replace(replace(title, char(10), ' '), char(13), ' '), ''), coalesce(cwd, ''), updated_at, created_at from threads order by updated_at desc limit ${Math.max(limit, 1)}`,
  )
  return rows.map(([id, title, cwd, updatedAt, createdAt]) => ({
    origin: 'native',
    windowId: null,
    nativeId: id || null,
    agent: 'codex',
    title: summarizeSessionText(title, id ? `Codex session ${id.slice(0, 8)}` : 'Codex session'),
    cwd: cwd || null,
    claudeSessionId: null,
    codexThreadId: id || null,
    model: null,
    updatedAt: toTimestampMs(Number.parseInt(updatedAt || createdAt || '0', 10)),
    messageCount: null,
    lastMessageText: null,
    sourceLabel: 'Codex CLI',
  }))
}

export class AgentSessionService extends EventEmitter {
  private runtimes = new Map<string, Runtime>()

  hasRuntime(windowId: string): boolean {
    return this.runtimes.has(windowId)
  }

  getSnapshot(windowId: string): AgentSessionSnapshot | null {
    const live = this.runtimes.get(windowId)?.snapshot
    if (live) return cloneSnapshot(live)
    const persisted = loadPersistedSnapshot(windowId)
    return persisted ? cloneSnapshot(persisted) : null
  }

  async listSavedSessions(): Promise<SavedAgentSessionSummary[]> {
    const entries: string[] = await fs.readdir(getPersistDir()).catch(() => [])
    if (!entries.length) {
      return []
    }

    return entries
      .filter((entry) => entry.endsWith('.json') && !entry.endsWith('.meta.json'))
      .map((entry) => {
        const windowId = path.basename(entry, '.json')
        const summary = loadPersistedSummary(windowId)
        if (summary) return summary
        const snapshot = loadPersistedSnapshot(windowId)
        if (!snapshot) return null
        const fallbackSummary = buildSavedSessionSummary(snapshot)
        persistSummaryNow(fallbackSummary).catch(() => {})
        return fallbackSummary
      })
      .filter((summary): summary is SavedAgentSessionSummary => summary !== null)
      .filter(
        (summary) =>
          summary.messageCount > 0 ||
          !!summary.claudeSessionId ||
          !!summary.codexThreadId ||
          !!summary.cursorAgentId ||
          !!summary.copilotSessionId ||
          !!summary.opencodeSessionId,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async listRecentSessions(
    agent: AgentSessionName,
    limit = DEFAULT_RECENT_SESSION_LIMIT,
  ): Promise<RecentAgentSessionSummary[]> {
    const normalizedLimit = Math.max(1, Math.min(limit, 24))
    const cellsSessions = (await this.listSavedSessions())
      .filter((session) => session.agent === agent)
      .map<RecentAgentSessionSummary>((session) => ({
        origin: 'cells',
        windowId: session.windowId,
        nativeId: null,
        agent: session.agent,
        title: session.title,
        cwd: session.cwd ?? null,
        claudeSessionId: session.claudeSessionId ?? null,
        codexThreadId: session.codexThreadId ?? null,
        cursorAgentId: session.cursorAgentId ?? null,
        cursorRunId: session.cursorRunId ?? null,
        copilotSessionId: session.copilotSessionId ?? null,
        opencodeSessionId: session.opencodeSessionId ?? null,
        model: session.model ?? null,
        updatedAt: session.updatedAt,
        messageCount: session.messageCount,
        lastMessageText: session.lastMessageText ?? null,
        sourceLabel: 'Cells',
      }))

    const nativeSessions =
      agent === 'claude'
        ? collectClaudeNativeSessionFiles(CLAUDE_NATIVE_PROJECTS_DIR)
            .map((entry) => readClaudeNativeSessionSummary(entry.filePath))
            .filter((session): session is RecentAgentSessionSummary => session !== null)
        : agent === 'codex'
          ? listCodexNativeSessions(normalizedLimit * 2)
          : []

    const seen = new Set<string>()
    return [...cellsSessions, ...nativeSessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((session) => {
        const dedupeKey =
          session.claudeSessionId ||
          session.codexThreadId ||
          session.cursorAgentId ||
          session.copilotSessionId ||
          session.opencodeSessionId ||
          session.nativeId ||
          session.windowId ||
          session.title
        if (seen.has(dedupeKey)) return false
        seen.add(dedupeKey)
        return true
      })
      .slice(0, normalizedLimit)
  }

  async ensure(request: AgentSessionRequest): Promise<AgentSessionSnapshot> {
    // Coerce legacy permission values ('safe' / 'allow-all') from older
    // saved ProjectsState so the rest of the code only has to handle the
    // current 3-mode union.
    request = {
      ...request,
      permissionMode: normalizePermissionMode(request.permissionMode),
      model: await resolveSessionModelId(request.agent, request.model),
    }
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
    // A stale placeholder title ("Claude Code" / "Codex") on the node must not
    // override a real inferred title from the persisted snapshot — new windows
    // are born with the placeholder and carry it up through ensure() on every
    // mount, which would otherwise clobber good titles on every reload.
    const requestTitleTrimmed = request.title?.trim() ?? ''
    const requestTitleOverride = isPlaceholderAgentSessionTitle(request.agent, requestTitleTrimmed)
      ? ''
      : requestTitleTrimmed
    if (existing) {
      existing.request = { ...existing.request, ...request }
      existing.snapshot.title = requestTitleOverride || existing.snapshot.title
      existing.snapshot.cwd = request.cwd ?? existing.snapshot.cwd ?? null
      const cloned = cloneSnapshot(existing.snapshot)
      existing.snapshot.restoredFromPersist = false
      return cloned
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
        requestTitleOverride ||
        persisted?.title ||
        (request.agent === 'claude'
          ? 'Claude Code'
          : request.agent === 'cursor'
            ? 'Cursor'
            : request.agent === 'copilot'
              ? 'GitHub Copilot'
              : request.agent === 'opencode'
                ? 'OpenCode'
                : 'Codex'),
      cwd: request.cwd ?? persisted?.cwd ?? null,
      restoredFromPersist: Boolean(persisted),
      status: 'idle',
      error: null,
      claudeSessionId: request.claudeSessionId ?? persisted?.claudeSessionId ?? null,
      codexThreadId: request.codexThreadId ?? persisted?.codexThreadId ?? null,
      cursorAgentId: request.cursorAgentId ?? persisted?.cursorAgentId ?? null,
      cursorRunId: request.cursorRunId ?? persisted?.cursorRunId ?? null,
      copilotSessionId: request.copilotSessionId ?? persisted?.copilotSessionId ?? null,
      opencodeSessionId: request.opencodeSessionId ?? persisted?.opencodeSessionId ?? null,
      updatedAt: now(),
      messages: persisted?.messages ?? [],
      // Keep the last known token accounting so the % indicator stays populated
      // across restarts (a fresh turn will overwrite it on the next 'result').
      usage: persisted?.usage ?? null,
      pendingApproval: null,
    }
    snapshot.messages = loadNativeImportMessages(request, snapshot)
    if (snapshot.messages.length > 0) {
      snapshot.updatedAt =
        snapshot.messages[snapshot.messages.length - 1]?.updatedAt ?? snapshot.updatedAt
    }
    if (
      snapshot.messages.length > 0 &&
      isPlaceholderAgentSessionTitle(snapshot.agent, snapshot.title)
    ) {
      snapshot.title = inferAgentSessionTitle(snapshot.agent, snapshot.messages)
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
        includePartialMessages: true,
        env: buildAgentEnv({
          CLAUDE_AGENT_SDK_CLIENT_APP: 'cells',
          ...(request.cwd ? { PWD: request.cwd } : {}),
        }),
        canUseTool: (toolName: string, input: any) =>
          this.handleClaudeCanUseTool(request.windowId, toolName, input),
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
        streamGeneration: 0,
        autoContinueCount: 0,
        postCompactUsedTokens: null,
        liveContextUsageUpdatedThisTurn: false,
        claudeStreamState: {
          messageIdByScope: new Map(),
          textMessageIdByBlock: new Map(),
          toolUseIdByBlock: new Map(),
        },
        pendingPlanApproval: null,
        pendingQuestion: null,
      }
      this.startClaudeStream(runtime)
      this.runtimes.set(request.windowId, runtime)
      if (!isResumedSession && request.initialPrompt?.trim()) {
        log('claude.initialPrompt', { windowId: request.windowId })
        void this.send(request.windowId, request.initialPrompt)
      }
      const cloned = cloneSnapshot(snapshot)
      snapshot.restoredFromPersist = false
      return cloned
    }

    if (request.agent === 'cursor') {
      const runtime = await this.createCursorRuntime(request, snapshot)
      this.runtimes.set(request.windowId, runtime)
      if (!request.cursorAgentId && request.initialPrompt?.trim()) {
        void this.send(request.windowId, request.initialPrompt)
      }
      const cloned = cloneSnapshot(snapshot)
      snapshot.restoredFromPersist = false
      return cloned
    }

    if (request.agent === 'copilot') {
      const isResumedSession = Boolean(request.copilotSessionId)
      const runtime = await this.createCopilotRuntime(request, snapshot)
      this.runtimes.set(request.windowId, runtime)
      if (!isResumedSession && request.initialPrompt?.trim()) {
        void this.send(request.windowId, request.initialPrompt)
      }
      const cloned = cloneSnapshot(snapshot)
      snapshot.restoredFromPersist = false
      return cloned
    }

    if (request.agent === 'opencode') {
      const runtime = await this.createOpencodeRuntime(request, snapshot)
      this.runtimes.set(request.windowId, runtime)
      if (!request.opencodeSessionId && request.initialPrompt?.trim()) {
        void this.send(request.windowId, request.initialPrompt)
      }
      const cloned = cloneSnapshot(snapshot)
      snapshot.restoredFromPersist = false
      return cloned
    }

    const isResumedThread = Boolean(request.codexThreadId)
    const runtime = await this.createCodexRuntime(request, snapshot)
    this.runtimes.set(request.windowId, runtime)
    if (!isResumedThread && request.initialPrompt?.trim()) {
      void this.send(request.windowId, request.initialPrompt)
    }
    const cloned = cloneSnapshot(snapshot)
    snapshot.restoredFromPersist = false
    return cloned
  }

  async send(
    windowId: string,
    input: string,
    attachments?: string[],
    overrides?: {
      model?: AgentSessionRequest['model']
      thinkingLevel?: AgentSessionRequest['thinkingLevel']
      permissionMode?: AgentSessionRequest['permissionMode']
      fastMode?: AgentSessionRequest['fastMode']
    },
    replyTo?: AgentReplyReference | null,
  ): Promise<void> {
    return this.sendInternal(windowId, input, input, attachments, overrides, replyTo)
  }

  async branchFrom(
    sourceWindowId: string,
    request: AgentSessionRequest,
    visibleInput: string,
    providerInput: string,
    attachments?: string[],
    overrides?: {
      model?: AgentSessionRequest['model']
      thinkingLevel?: AgentSessionRequest['thinkingLevel']
      permissionMode?: AgentSessionRequest['permissionMode']
      fastMode?: AgentSessionRequest['fastMode']
    },
    replyTo?: AgentReplyReference | null,
  ): Promise<void> {
    const sourceSnapshot =
      this.runtimes.get(sourceWindowId)?.snapshot ?? loadPersistedSnapshot(sourceWindowId)
    if (!sourceSnapshot) {
      throw new Error(`Missing source agent session for ${sourceWindowId}`)
    }

    let nativeProviderInput = false
    let forkedClaudeSessionId: string | null = null
    let forkedCodexThreadId: string | null = null
    if (request.agent === sourceSnapshot.agent) {
      if (request.agent === 'claude' && sourceSnapshot.claudeSessionId) {
        try {
          const forked = await forkSession(sourceSnapshot.claudeSessionId, {
            dir: sourceSnapshot.cwd ?? request.cwd ?? undefined,
            title: request.title ?? undefined,
          })
          forkedClaudeSessionId = forked.sessionId
          nativeProviderInput = true
        } catch (err) {
          log('branch.claudeFork.error', {
            sourceWindowId,
            sessionId: sourceSnapshot.claudeSessionId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } else if (request.agent === 'codex' && sourceSnapshot.codexThreadId) {
        try {
          const forked = await withCodexAppServer(async (client) =>
            client.request('thread/fork', { threadId: sourceSnapshot.codexThreadId }),
          )
          const payload = asRecord(forked)
          const thread = asRecord(payload?.thread)
          forkedCodexThreadId =
            asNonEmptyString(thread?.id) ??
            asNonEmptyString(payload?.threadId) ??
            asNonEmptyString(payload?.id)
          if (forkedCodexThreadId) {
            nativeProviderInput = true
          } else {
            log('branch.codexFork.missingThreadId', {
              sourceWindowId,
              threadId: sourceSnapshot.codexThreadId,
            })
          }
        } catch (err) {
          log('branch.codexFork.error', {
            sourceWindowId,
            threadId: sourceSnapshot.codexThreadId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    request = {
      ...request,
      initialPrompt: null,
      claudeSessionId: forkedClaudeSessionId,
      codexThreadId: forkedCodexThreadId,
      cursorAgentId: null,
      cursorRunId: null,
      copilotSessionId: null,
      opencodeSessionId: null,
      permissionMode: normalizePermissionMode(request.permissionMode),
      model: await resolveSessionModelId(request.agent, request.model),
    }

    const timestamp = now()
    const snapshot: AgentSessionSnapshot = {
      ...cloneSnapshot(sourceSnapshot),
      windowId: request.windowId,
      agent: request.agent,
      title: request.title?.trim() || sourceSnapshot.title,
      cwd: request.cwd ?? sourceSnapshot.cwd ?? null,
      restoredFromPersist: false,
      status: 'idle',
      error: null,
      claudeSessionId: request.claudeSessionId ?? null,
      codexThreadId: request.codexThreadId ?? null,
      cursorAgentId: request.cursorAgentId ?? null,
      cursorRunId: request.cursorRunId ?? null,
      copilotSessionId: request.copilotSessionId ?? null,
      opencodeSessionId: request.opencodeSessionId ?? null,
      updatedAt: timestamp,
      pendingApproval: null,
      pendingPlanApproval: null,
      pendingQuestion: null,
      codexPlan: null,
    }
    snapshot.messages = snapshot.messages.map((message) => ({
      ...message,
      status: message.status === 'in_progress' ? 'failed' : message.status,
    }))
    if (request.windowId !== sourceWindowId && this.runtimes.has(request.windowId)) {
      await this.dispose(request.windowId)
    }
    await persistSnapshotNow(snapshot)
    this.emitUpdate(snapshot)

    if (request.windowId !== sourceWindowId && this.runtimes.has(request.windowId)) {
      await this.dispose(request.windowId)
      await persistSnapshotNow(snapshot)
    }
    await this.ensure(request)
    await this.sendInternal(
      request.windowId,
      visibleInput,
      nativeProviderInput ? visibleInput : providerInput,
      attachments,
      overrides,
      replyTo,
    )
  }

  private async sendInternal(
    windowId: string,
    visibleInput: string,
    providerInput: string,
    attachments?: string[],
    overrides?: {
      model?: AgentSessionRequest['model']
      thinkingLevel?: AgentSessionRequest['thinkingLevel']
      permissionMode?: AgentSessionRequest['permissionMode']
      fastMode?: AgentSessionRequest['fastMode']
    },
    replyTo?: AgentReplyReference | null,
  ): Promise<void> {
    let runtime = this.runtimes.get(windowId)
    log('send.begin', {
      windowId,
      hasRuntime: !!runtime,
      closed: runtime?.closed ?? null,
      kind: runtime?.kind ?? null,
      inputLength: visibleInput.length,
      providerInputLength: providerInput.length,
      attachmentCount: attachments?.length ?? 0,
      hasReplyTo: !!replyTo,
      overrides: overrides ?? null,
    })
    if (!runtime) throw new Error(`Missing agent session for ${windowId}`)

    // Apply queued-message overrides (captured at queue time) so the next
    // turn runs with the model / thinking / permission that were selected
    // when the user queued this message, not whatever is active now.
    if (overrides) {
      const req = runtime.request
      // `null` overrides come from legacy / fallback UI state and should mean
      // "keep the current resolved setting", not "reset to baked-in default".
      const nextModel =
        overrides.model != null
          ? await resolveSessionModelId(req.agent, overrides.model)
          : undefined
      const nextThinkingLevel =
        overrides.thinkingLevel != null ? overrides.thinkingLevel : undefined
      const nextPermissionMode =
        overrides.permissionMode != null
          ? normalizePermissionMode(overrides.permissionMode)
          : undefined
      const nextFastMode = overrides.fastMode != null ? Boolean(overrides.fastMode) : undefined

      const modelChanged = nextModel !== undefined && nextModel !== (req.model ?? null)
      const thinkingChanged =
        nextThinkingLevel !== undefined && nextThinkingLevel !== (req.thinkingLevel ?? null)
      const permissionChanged =
        nextPermissionMode !== undefined && nextPermissionMode !== (req.permissionMode ?? null)
      const fastModeChanged = nextFastMode !== undefined && nextFastMode !== (req.fastMode ?? null)

      if (modelChanged) req.model = nextModel
      if (thinkingChanged) req.thinkingLevel = nextThinkingLevel
      if (fastModeChanged) req.fastMode = nextFastMode

      if (permissionChanged) {
        await this.updatePermissionMode(windowId, nextPermissionMode ?? null)
      }

      // Claude only reads model / thinking at session construction time.
      // Codex app-server accepts both per turn, so we keep the live session.
      if (modelChanged || thinkingChanged) {
        if (runtime.kind === 'claude') {
          try {
            runtime.session.close()
          } catch {
            /* idempotent */
          }
          runtime.closed = true
        }
      }
    }

    // If the runtime was closed (user hit Stop) but not disposed, transparently
    // reopen it so the message history survives and we just resume the
    // underlying CLI session for the next turn.
    if (runtime.closed) {
      runtime = await this.reopenRuntime(runtime)
    }

    const rewrittenInput = rewriteAgentComposerMentions(providerInput, (kind, value) =>
      resolveAgentComposerPath(runtime.snapshot.cwd ?? runtime.request.cwd ?? null, kind, value),
    )
    const normalizedAttachments = Array.from(
      new Set([...(attachments ?? []), ...rewrittenInput.referencedPaths]),
    ).filter((p): p is string => typeof p === 'string' && p.length > 0)
    const imageAttachments = normalizedAttachments.filter(isImagePath)
    const nonImageAttachments = normalizedAttachments.filter((p) => !isImagePath(p))

    // Non-image attachments stay as `[path]` text references so the agent can
    // open them with its file-read tool. Images are promoted to a proper
    // content block below so the model sees the pixels, not a filename.
    const nonImageLine = nonImageAttachments.length
      ? nonImageAttachments.map((p) => `[${p}]`).join(' ') + '\n\n'
      : ''
    const userText = visibleInput.trim()
    const rewrittenProviderText =
      rewrittenInput.text.trim() === ATTACHMENTS_ONLY_TEXT ? '' : rewrittenInput.text
    const imageLine = buildImageReferenceLine(imageAttachments, rewrittenProviderText)
    const replyContext = buildReplyContext(replyTo)
    const providerText =
      `${replyContext}${nonImageLine}${imageLine}${rewrittenProviderText}`.trim() ||
      rewrittenProviderText

    // Real user turn — reset the auto-continue watchdog so a fresh prompt
    // gets its own three-try budget if it also bottoms out on max_turns.
    if (runtime.kind === 'claude') {
      runtime.autoContinueCount = 0
      // A fresh user turn means the next `result` event reflects real
      // post-compaction usage (not the pre-compact remnant), so drop any
      // pinned post-compact value so we don't shadow it.
      runtime.postCompactUsedTokens = null
      runtime.liveContextUsageUpdatedThisTurn = false
    }

    appendMessage(runtime.snapshot, {
      id: `${windowId}-user-${now()}`,
      role: 'user',
      text: userText,
      attachments: normalizedAttachments.length > 0 ? normalizedAttachments : undefined,
      replyTo: replyTo ?? null,
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
              content: [...blocks, { type: 'text', text: providerText }],
            },
          })
        } else {
          await runtime.session.send(providerText)
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

    if (runtime.kind === 'cursor') {
      if (runtime.runPromise) {
        throw new Error('Cursor is still processing the previous turn')
      }
      log('send.cursor.dispatch', { windowId, agentId: runtime.snapshot.cursorAgentId })
      runtime.runPromise = new Promise<void>((resolve, reject) => {
        runtime.resolveRun = resolve
        runtime.rejectRun = reject
      }).finally(() => {
        runtime.runPromise = null
        runtime.resolveRun = null
        runtime.rejectRun = null
      })
      runtime.runPromise.catch(() => {})
      try {
        const cursorText = buildCursorProviderText(runtime.request.permissionMode, providerText)
        const message = buildCursorCliPrompt(cursorText, imageAttachments)
        this.startCursorCliTurn(runtime, message, ++runtime.streamGeneration)
        log('send.cursor.dispatched', {
          windowId,
          sessionId: runtime.snapshot.cursorAgentId,
        })
      } catch (err) {
        runtime.rejectRun?.(err instanceof Error ? err : new Error(String(err)))
        const message = err instanceof Error ? err.message : String(err)
        runtime.snapshot.status = isCursorAuthError(message) ? 'idle' : 'error'
        runtime.snapshot.error = isCursorAuthError(message) ? null : message
        if (isCursorAuthError(message)) {
          appendMessage(runtime.snapshot, {
            id: `${runtime.snapshot.windowId}-cursor-auth-${now()}`,
            role: 'auth_request',
            title: 'Sign in to Cursor',
            text: 'Cursor is not authenticated. Sign in with Cursor Agent or set CURSOR_API_KEY, then retry your last message.',
            status: 'in_progress',
            authLoginUrl: null,
          })
        }
        this.emitUpdate(runtime.snapshot)
        throw err
      }
      return
    }

    if (runtime.kind === 'copilot') {
      if (runtime.turnPromise) {
        throw new Error('GitHub Copilot is still processing the previous turn')
      }
      log('send.copilot.dispatch', { windowId, sessionId: runtime.snapshot.copilotSessionId })
      runtime.turnPromise = new Promise<void>((resolve, reject) => {
        runtime.resolveTurn = resolve
        runtime.rejectTurn = reject
      }).finally(() => {
        runtime.turnPromise = null
        runtime.resolveTurn = null
        runtime.rejectTurn = null
      })
      runtime.turnPromise.catch(() => {})
      try {
        await runtime.session.send({
          prompt: providerText,
          mode: 'immediate',
          attachments: imageAttachments.map((filePath) => ({
            type: 'file' as const,
            path: filePath,
            displayName: path.basename(filePath),
          })),
        })
        log('send.copilot.dispatched', {
          windowId,
          sessionId: runtime.snapshot.copilotSessionId,
        })
      } catch (err) {
        runtime.rejectTurn?.(err instanceof Error ? err : new Error(String(err)))
        const message = err instanceof Error ? err.message : String(err)
        runtime.snapshot.status = isCopilotAuthError(message) ? 'idle' : 'error'
        runtime.snapshot.error = isCopilotAuthError(message) ? null : message
        if (isCopilotAuthError(message)) {
          appendMessage(runtime.snapshot, {
            id: `${runtime.snapshot.windowId}-copilot-auth-${now()}`,
            role: 'auth_request',
            title: 'Sign in to GitHub Copilot',
            text: "GitHub Copilot isn't signed in on this machine yet. Sign in with Copilot CLI, then retry your last message.",
            status: 'in_progress',
            authLoginUrl: null,
          })
        }
        this.emitUpdate(runtime.snapshot)
        throw err
      }
      return
    }

    if (runtime.kind === 'opencode') {
      if (runtime.runPromise) {
        throw new Error('OpenCode is still processing the previous turn')
      }
      log('send.opencode.dispatch', { windowId, sessionId: runtime.snapshot.opencodeSessionId })
      runtime.runPromise = new Promise<void>((resolve, reject) => {
        runtime.resolveRun = resolve
        runtime.rejectRun = reject
      }).finally(() => {
        runtime.runPromise = null
        runtime.resolveRun = null
        runtime.rejectRun = null
      })
      runtime.runPromise.catch(() => {})
      try {
        const opencodeText = buildOpenCodeProviderText(runtime.request.permissionMode, providerText)
        this.startOpencodeCliTurn(
          runtime,
          opencodeText,
          ++runtime.streamGeneration,
          imageAttachments,
        )
        log('send.opencode.dispatched', {
          windowId,
          sessionId: runtime.snapshot.opencodeSessionId,
        })
      } catch (err) {
        runtime.rejectRun?.(err instanceof Error ? err : new Error(String(err)))
        const message = err instanceof Error ? err.message : String(err)
        runtime.snapshot.status = isOpencodeAuthError(message) ? 'idle' : 'error'
        runtime.snapshot.error = isOpencodeAuthError(message) ? null : message
        if (isOpencodeAuthError(message)) {
          appendMessage(runtime.snapshot, {
            id: `${runtime.snapshot.windowId}-opencode-auth-${now()}`,
            role: 'auth_request',
            title: 'Sign in to OpenCode',
            text: "OpenCode isn't signed in on this machine yet. Sign in with OpenCode CLI, then retry your last message.",
            status: 'in_progress',
            authLoginUrl: null,
          })
        }
        this.emitUpdate(runtime.snapshot)
        throw err
      }
      return
    }

    if (runtime.turnPromise) {
      throw new Error('Codex is still processing the previous turn')
    }

    log('send.codex.dispatch', { windowId })
    runtime.turnPromise = new Promise<void>((resolve, reject) => {
      runtime.resolveTurn = resolve
      runtime.rejectTurn = reject
    }).finally(() => {
      runtime.turnPromise = null
      runtime.resolveTurn = null
      runtime.rejectTurn = null
    })
    try {
      const started: { turn?: { id?: string } } = await runtime.client.request('turn/start', {
        ...buildCodexTurnStartParams(runtime, providerText, imageAttachments),
      })
      runtime.activeTurnId = asNonEmptyString(started.turn?.id) ?? runtime.activeTurnId
      log('send.codex.dispatched', {
        windowId,
        threadId: runtime.providerThreadId ?? runtime.snapshot.codexThreadId,
        turnId: runtime.activeTurnId,
      })
    } catch (err) {
      runtime.rejectTurn?.(err instanceof Error ? err : new Error(String(err)))
      runtime.snapshot.status = 'error'
      runtime.snapshot.error = err instanceof Error ? err.message : String(err)
      this.emitUpdate(runtime.snapshot)
      throw err
    }
  }

  /** Stop the current turn but keep the runtime + message history around.
   * The next `send()` will reopen the underlying CLI session on demand. */
  async close(windowId: string): Promise<void> {
    const runtime = this.runtimes.get(windowId)
    log('close', { windowId, hasRuntime: !!runtime })
    if (!runtime) return
    if (runtime.kind === 'claude') {
      runtime.closed = true
      try {
        runtime.session.close()
      } catch {
        /* idempotent */
      }
      // Drop any dangling plan approval — the SDK process is gone, so the
      // canUseTool promise cannot be resolved usefully. Leaving it in the
      // snapshot would show a zombie banner the user can't act on.
      if (runtime.pendingPlanApproval) {
        runtime.pendingPlanApproval = null
        runtime.snapshot.pendingPlanApproval = null
      }
      if (runtime.pendingQuestion) {
        runtime.pendingQuestion = null
        runtime.snapshot.pendingQuestion = null
      }
    } else if (runtime.kind === 'cursor' || runtime.kind === 'opencode') {
      const interruptedRun = runtime.runPromise
      try {
        runtime.activeRun?.kill('SIGINT')
      } catch (err) {
        log(`${runtime.kind}.run.cancel.error`, {
          windowId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      runtime.activeRun = null
      runtime.resolveRun?.()
      runtime.closed = true
      if (interruptedRun) {
        await Promise.race([
          interruptedRun.catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ])
      }
    } else if (runtime.kind === 'copilot') {
      runtime.pendingApproval?.resolve({ kind: 'reject' })
      runtime.pendingApproval = null
      runtime.snapshot.pendingApproval = null
      runtime.pendingQuestion?.resolve({ answer: '', wasFreeform: true })
      runtime.pendingQuestion = null
      runtime.snapshot.pendingQuestion = null
      const interruptedTurn = runtime.turnPromise
      try {
        await runtime.session.abort()
      } catch (err) {
        log('copilot.abort.error', {
          windowId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      runtime.resolveTurn?.()
      runtime.closed = true
      try {
        await runtime.session.disconnect()
      } catch {}
      await runtime.client.stop().catch(() => [])
      if (interruptedTurn) {
        await Promise.race([
          interruptedTurn.catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ])
      }
    } else {
      runtime.pendingApproval?.resolve({ decision: 'cancel' })
      runtime.pendingApproval = null
      runtime.snapshot.pendingApproval = null
      runtime.pendingQuestion = null
      runtime.snapshot.pendingQuestion = null
      const interruptedTurn = runtime.turnPromise
      let interruptAccepted = !runtime.activeTurnId
      if (runtime.activeTurnId && (runtime.providerThreadId || runtime.snapshot.codexThreadId)) {
        try {
          interruptAccepted = await Promise.race([
            runtime.client
              .request('turn/interrupt', {
                threadId: runtime.providerThreadId ?? runtime.snapshot.codexThreadId,
                turnId: runtime.activeTurnId,
              })
              .then(() => true),
            new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(false), CODEX_INTERRUPT_REQUEST_TIMEOUT_MS),
            ),
          ])
          if (!interruptAccepted) {
            log('codex.turn.interrupt.request-timeout', { windowId })
          }
        } catch (err) {
          log('codex.turn.interrupt.error', {
            windowId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (interruptedTurn && interruptAccepted) {
        const completed = await Promise.race([
          interruptedTurn.then(() => true).catch(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), CODEX_INTERRUPT_GRACE_MS),
          ),
        ])
        if (!completed) {
          log('codex.turn.interrupt.timeout', { windowId })
          runtime.activeTurnId = null
          runtime.resolveTurn?.()
          runtime.closed = true
          await runtime.client.close()
        }
      } else if (interruptedTurn) {
        runtime.activeTurnId = null
        runtime.resolveTurn?.()
        runtime.closed = true
        await runtime.client.close()
      } else {
        runtime.activeTurnId = null
      }
    }
    runtime.snapshot.codexPlan = null
    runtime.snapshot.status = 'idle'
    runtime.snapshot.error = null
    // Finalize any tool/assistant/reasoning messages still marked in_progress.
    // close() tears down the underlying CLI/session, so their natural
    // "completed" event will never arrive — without this the background
    // activity banner keeps showing and the Stop button appears to do
    // nothing on the next click.
    const now = Date.now()
    for (const message of runtime.snapshot.messages) {
      if (message.status === 'in_progress') {
        message.status = 'failed'
        message.updatedAt = now
      }
    }
    this.emitUpdate(runtime.snapshot)
  }

  /** Fully dispose of a runtime — terminate the live process/runtime when the
   * agent window is removed from the store, but keep the persisted transcript
   * so Cells can reopen the session later from search. */
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
      } else if (runtime.kind === 'cursor' || runtime.kind === 'opencode') {
        try {
          runtime.activeRun?.kill('SIGINT')
        } catch {
          /* ignore */
        }
        runtime.resolveRun?.()
      } else if (runtime.kind === 'copilot') {
        runtime.pendingApproval?.resolve({ kind: 'reject' })
        runtime.pendingApproval = null
        runtime.snapshot.pendingApproval = null
        runtime.pendingQuestion?.resolve({ answer: '', wasFreeform: true })
        runtime.pendingQuestion = null
        runtime.snapshot.pendingQuestion = null
        runtime.resolveTurn?.()
        try {
          await runtime.session.disconnect()
        } catch {}
        await runtime.client.stop().catch(() => [])
      } else {
        runtime.pendingApproval?.resolve({ decision: 'cancel' })
        runtime.pendingApproval = null
        runtime.snapshot.pendingApproval = null
        runtime.pendingQuestion = null
        runtime.snapshot.pendingQuestion = null
        runtime.resolveTurn?.()
        await runtime.client.close()
      }
      this.runtimes.delete(windowId)
    }
    const pending = persistTimers.get(windowId)
    if (pending) {
      clearTimeout(pending)
      persistTimers.delete(windowId)
    }
    if (runtime) {
      try {
        await persistSnapshotNow(runtime.snapshot)
      } catch (err) {
        log('persist.write.error', {
          windowId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
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

  /** Apply a permission-mode change to a running agent session. Claude can
   *  update live; Codex picks the new mode up on the next turn/start call. */
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
    if (runtime.kind === 'cursor' || runtime.kind === 'opencode') {
      log(`${runtime.kind}.permissionMode.update`, {
        windowId,
        mode: runtime.request.permissionMode ?? null,
      })
      return
    }
    if (runtime.kind === 'copilot') {
      log('copilot.permissionMode.update', {
        windowId,
        mode: runtime.request.permissionMode ?? null,
      })
      return
    }
    log('codex.permissionMode.update', {
      windowId,
      mode: runtime.request.permissionMode ?? null,
      approval: buildCodexApprovalPolicy(runtime.request.permissionMode),
      sandbox: buildCodexThreadSandbox(runtime.request.permissionMode),
    })
  }

  /** Shared `canUseTool` entry point for Claude sessions. Encapsulates
   *  (a) plan-mode write blocks, and (b) the ExitPlanMode intercept that
   *  parks the tool-use until the user taps Approve/Reject in the UI. */
  private handleClaudeCanUseTool(
    windowId: string,
    toolName: string,
    input: any,
  ): Promise<{
    behavior: 'allow' | 'deny'
    message?: string
    updatedInput?: Record<string, unknown>
  }> {
    const runtime = this.runtimes.get(windowId)
    const mode = runtime?.request.permissionMode
    if (mode === 'plan' && CLAUDE_WRITE_TOOLS.has(toolName)) {
      return Promise.resolve({
        behavior: 'deny',
        message: `Cells is in Plan mode — ${toolName} is blocked. Switch to Ask or Yolo to allow writes.`,
      })
    }
    if (toolName === 'AskUserQuestion' && runtime?.kind === 'claude') {
      const normalizedInput = (input ?? {}) as Record<string, unknown>
      const rawQuestions = Array.isArray(normalizedInput.questions)
        ? (normalizedInput.questions as unknown[])
        : []
      const questions = rawQuestions.map((q) => {
        const item = (q ?? {}) as Record<string, unknown>
        const options = Array.isArray(item.options) ? (item.options as unknown[]) : []
        return {
          question: typeof item.question === 'string' ? item.question : '',
          header: typeof item.header === 'string' ? item.header : '',
          multiSelect: Boolean(item.multiSelect),
          options: options.map((o) => {
            const opt = (o ?? {}) as Record<string, unknown>
            return {
              label: typeof opt.label === 'string' ? opt.label : '',
              description: typeof opt.description === 'string' ? opt.description : '',
              preview: typeof opt.preview === 'string' ? opt.preview : undefined,
            }
          }),
        }
      })
      log('claude.askUserQuestion.pending', { windowId, count: questions.length })
      return new Promise((resolve) => {
        // Supersede any older pending question so the tool_use doesn't hang.
        runtime.pendingQuestion?.resolve({
          behavior: 'deny',
          message: 'Superseded by a newer question prompt.',
        })
        runtime.pendingQuestion = { questions, originalInput: normalizedInput, resolve }
        runtime.snapshot.pendingQuestion = { questions, createdAt: now() }
        runtime.snapshot.updatedAt = now()
        this.emitUpdate(runtime.snapshot)
      })
    }
    if (toolName === 'ExitPlanMode' && runtime?.kind === 'claude') {
      const normalizedInput = (input ?? {}) as Record<string, unknown>
      // The SDK type says ExitPlanModeInput is just `{ allowedPrompts?: ... }`
      // + extra props, but in practice Claude Code passes the plan markdown
      // as `input.plan`. Fall back to scraping the most recent assistant
      // message if the agent ever omits it, so the banner never shows blank.
      let plan = typeof normalizedInput.plan === 'string' ? (normalizedInput.plan as string) : ''
      if (!plan.trim()) {
        const recentAssistant = [...runtime.snapshot.messages]
          .reverse()
          .find((m) => m.role === 'assistant' && m.text.trim().length > 0)
        if (recentAssistant) plan = recentAssistant.text
      }
      log('claude.exitPlanMode.pending', { windowId, planLength: plan.length })
      return new Promise((resolve) => {
        // If a previous pending approval somehow survived, resolve it as
        // denied so the prior tool-use gets a response.
        runtime.pendingPlanApproval?.resolve({
          behavior: 'deny',
          message: 'Superseded by a newer plan proposal.',
        })
        runtime.pendingPlanApproval = { plan, originalInput: normalizedInput, resolve }
        runtime.snapshot.pendingPlanApproval = { plan, createdAt: now() }
        runtime.snapshot.updatedAt = now()
        this.emitUpdate(runtime.snapshot)
      })
    }
    log('claude.canUseTool', {
      windowId,
      toolName,
      mode: mode ?? null,
      inputKeys: input ? Object.keys(input) : [],
    })
    return Promise.resolve({
      behavior: 'allow',
      updatedInput: (input ?? {}) as Record<string, unknown>,
    })
  }

  /** Resolve a pending ExitPlanMode approval with the user's choice.
   *    - 'auto-accept' → switch permission mode to `bypass` + allow
   *    - 'ask'         → switch permission mode to `ask` + allow
   *    - 'reject'      → deny so the agent returns to planning
   *  Feedback (optional) is forwarded verbatim in the deny message so the
   *  agent can revise the plan around the user's concerns. */
  async respondPlan(
    windowId: string,
    decision: 'auto-accept' | 'ask' | 'reject',
    feedback?: string,
  ): Promise<void> {
    const runtime = this.runtimes.get(windowId)
    if (!runtime) return

    if (runtime.kind === 'claude') {
      const pending = runtime.pendingPlanApproval
      if (!pending) return

      runtime.pendingPlanApproval = null
      runtime.snapshot.pendingPlanApproval = null
      runtime.snapshot.updatedAt = now()

      if (decision === 'reject') {
        const trimmed = feedback?.trim()
        const message = trimmed
          ? `The user rejected the plan. Their feedback: ${trimmed}\n\nPlease revise the plan based on the feedback — do not start implementing.`
          : 'The user rejected the plan. Please refine it further — do not start implementing.'
        log('claude.exitPlanMode.reject', { windowId, hasFeedback: Boolean(trimmed) })
        this.emitUpdate(runtime.snapshot)
        pending.resolve({ behavior: 'deny', message })
        return
      }

      const nextMode: AgentSessionRequest['permissionMode'] =
        decision === 'auto-accept' ? 'bypass' : 'ask'
      log('claude.exitPlanMode.approve', { windowId, nextMode })
      await this.updatePermissionMode(windowId, nextMode)
      this.emitUpdate(runtime.snapshot)
      pending.resolve({ behavior: 'allow', updatedInput: pending.originalInput })
      return
    }

    if (runtime.kind === 'cursor' || runtime.kind === 'opencode') {
      const pending = runtime.snapshot.pendingPlanApproval
      if (!pending) return

      runtime.snapshot.pendingPlanApproval = null
      runtime.snapshot.updatedAt = now()

      if (decision === 'reject') {
        const trimmed = feedback?.trim()
        log(`${runtime.kind}.proposedPlan.reject`, { windowId, hasFeedback: Boolean(trimmed) })
        this.emitUpdate(runtime.snapshot)
        if (trimmed) await this.send(windowId, trimmed)
        return
      }

      const nextMode: AgentSessionRequest['permissionMode'] =
        decision === 'auto-accept' ? 'bypass' : 'ask'
      log(`${runtime.kind}.proposedPlan.approve`, { windowId, nextMode })
      await this.updatePermissionMode(windowId, nextMode)
      this.emitUpdate(runtime.snapshot)
      const trimmed = feedback?.trim()
      const base = `PLEASE IMPLEMENT THIS PLAN:\n${pending.plan.trim()}`
      await this.send(
        windowId,
        trimmed ? `${base}\n\nAdditional guidance from the user: ${trimmed}` : base,
      )
      return
    }

    if (runtime.kind === 'copilot') {
      const pending = runtime.snapshot.pendingPlanApproval
      if (!pending) return

      runtime.snapshot.pendingPlanApproval = null
      runtime.snapshot.updatedAt = now()

      if (decision === 'reject') {
        const trimmed = feedback?.trim()
        log('copilot.proposedPlan.reject', { windowId, hasFeedback: Boolean(trimmed) })
        this.emitUpdate(runtime.snapshot)
        if (trimmed) await this.send(windowId, trimmed)
        return
      }

      const nextMode: AgentSessionRequest['permissionMode'] =
        decision === 'auto-accept' ? 'bypass' : 'ask'
      log('copilot.proposedPlan.approve', { windowId, nextMode })
      await this.updatePermissionMode(windowId, nextMode)
      this.emitUpdate(runtime.snapshot)
      const trimmed = feedback?.trim()
      const base = `PLEASE IMPLEMENT THIS PLAN:\n${pending.plan.trim()}`
      await this.send(
        windowId,
        trimmed ? `${base}\n\nAdditional guidance from the user: ${trimmed}` : base,
      )
      return
    }

    // Codex plan approval: the turn already completed when the model emitted
    // its <proposed_plan> block, so we don't have a blocking callback to
    // resolve. We drive the next action by (a) flipping the thread's
    // permission mode and (b) kicking a follow-up turn with an implement /
    // refine message. Mirrors t3code's "Implement" vs "Refine" split.
    const pending = runtime.pendingPlanApproval
    if (!pending) return

    runtime.pendingPlanApproval = null
    runtime.snapshot.pendingPlanApproval = null
    runtime.snapshot.updatedAt = now()

    if (decision === 'reject') {
      const trimmed = feedback?.trim()
      log('codex.proposedPlan.reject', { windowId, hasFeedback: Boolean(trimmed) })
      this.emitUpdate(runtime.snapshot)
      if (trimmed) {
        await this.send(windowId, trimmed)
      }
      return
    }

    const nextMode: AgentSessionRequest['permissionMode'] =
      decision === 'auto-accept' ? 'bypass' : 'ask'
    log('codex.proposedPlan.approve', { windowId, nextMode })
    await this.updatePermissionMode(windowId, nextMode)
    this.emitUpdate(runtime.snapshot)
    const trimmed = feedback?.trim()
    const base = `PLEASE IMPLEMENT THIS PLAN:\n${pending.plan.trim()}`
    const implementPrompt = trimmed
      ? `${base}\n\nAdditional guidance from the user: ${trimmed}`
      : base
    await this.send(windowId, implementPrompt)
  }

  /** Resolve a pending AskUserQuestion prompt.
   *    - `answers` map: key = original question text, value = chosen labels
   *      (array of length 1 for single-select; N for multi-select).
   *    - `null` → user declined / dismissed; the agent is told and can
   *      continue with its best judgment.
   *  Structured answers are returned through `updatedInput.answers`, which
   *  lets Claude continue the tool call without re-asking the question. */
  async respondQuestion(
    windowId: string,
    answers: Record<string, string[]> | null,
    note?: string | null,
  ): Promise<void> {
    const runtime = this.runtimes.get(windowId)
    if (!runtime) return

    const trimmedNote = typeof note === 'string' ? note.trim() : ''
    const hasNote = trimmedNote.length > 0

    if (runtime.kind === 'claude') {
      const pending = runtime.pendingQuestion
      if (!pending) return

      runtime.pendingQuestion = null
      runtime.snapshot.pendingQuestion = null
      runtime.snapshot.updatedAt = now()

      const normalizedAnswers: Record<string, string> = {}
      const pickedByQuestion: Array<{ question: string; picked: string[] }> = []
      if (answers) {
        for (const q of pending.questions) {
          const key = 'id' in q && typeof q.id === 'string' ? q.id : q.question
          const picked = (answers[key] ?? answers[q.question] ?? []).filter(
            (value): value is string => typeof value === 'string' && value.trim().length > 0,
          )
          pickedByQuestion.push({ question: q.question, picked })
          const normalized = q.multiSelect ? picked.join(', ') : (picked[0] ?? '')
          if (normalized) normalizedAnswers[q.question] = normalized
        }
      }

      const hasAnySelection = pickedByQuestion.some((entry) => entry.picked.length > 0)

      if (!answers && !hasNote) {
        log('claude.askUserQuestion.declined', { windowId })
        appendQuestionAnswerMessage(runtime.snapshot, windowId, pending.questions, [], '', true)
        this.emitUpdate(runtime.snapshot)
        pending.resolve({
          behavior: 'deny',
          message:
            'The user declined to answer the question(s). Continue using your best judgment, or ask again with more context.',
        })
        return
      }

      if (hasNote) normalizedAnswers._userNote = trimmedNote

      if (!hasAnySelection && hasNote) {
        log('claude.askUserQuestion.freeform', { windowId })
        appendQuestionAnswerMessage(
          runtime.snapshot,
          windowId,
          pending.questions,
          pickedByQuestion,
          trimmedNote,
          false,
        )
        this.emitUpdate(runtime.snapshot)
        pending.resolve({
          behavior: 'deny',
          message: `The user did not pick any of the provided options. Their freeform response: ${trimmedNote}`,
        })
        return
      }

      if (Object.keys(normalizedAnswers).length - (hasNote ? 1 : 0) < pending.questions.length) {
        log('claude.askUserQuestion.incomplete', {
          windowId,
          expected: pending.questions.length,
          actual: Object.keys(normalizedAnswers).length - (hasNote ? 1 : 0),
        })
        appendQuestionAnswerMessage(
          runtime.snapshot,
          windowId,
          pending.questions,
          pickedByQuestion,
          trimmedNote,
          false,
        )
        this.emitUpdate(runtime.snapshot)
        pending.resolve({
          behavior: 'deny',
          message: hasNote
            ? `The user's response was incomplete. Their note: ${trimmedNote}`
            : 'The user response was incomplete. Ask the question again if you still need clarification.',
        })
        return
      }
      log('claude.askUserQuestion.answered', {
        windowId,
        keys: Object.keys(normalizedAnswers).length,
      })
      appendQuestionAnswerMessage(
        runtime.snapshot,
        windowId,
        pending.questions,
        pickedByQuestion,
        trimmedNote,
        false,
      )
      this.emitUpdate(runtime.snapshot)
      pending.resolve({
        behavior: 'allow',
        updatedInput: {
          ...pending.originalInput,
          answers: normalizedAnswers,
        },
      })
      return
    }

    if (runtime.kind === 'cursor' || runtime.kind === 'opencode') return

    if (runtime.kind === 'copilot') {
      const pending = runtime.pendingQuestion
      if (!pending) return

      runtime.pendingQuestion = null
      runtime.snapshot.pendingQuestion = null
      runtime.snapshot.updatedAt = now()

      const question = pending.questions[0]
      const picked = question
        ? (answers?.[question.id] ?? answers?.[question.question] ?? []).filter(
            (value): value is string => typeof value === 'string' && value.trim().length > 0,
          )
        : []
      const answer = picked[0] ?? trimmedNote
      appendQuestionAnswerMessage(
        runtime.snapshot,
        windowId,
        pending.questions,
        question ? [{ question: question.question, picked }] : [],
        trimmedNote,
        !answer,
      )
      this.emitUpdate(runtime.snapshot)
      pending.resolve({ answer, wasFreeform: picked.length === 0 })
      return
    }

    const pending = runtime.pendingQuestion
    if (!pending) return

    runtime.pendingQuestion = null
    runtime.snapshot.pendingQuestion = null
    runtime.snapshot.updatedAt = now()

    const normalizedAnswers: Record<string, string[]> = {}
    const pickedByQuestion: Array<{ question: string; picked: string[] }> = []
    for (const question of pending.questions) {
      const picked = (answers?.[question.id] ?? answers?.[question.question] ?? []).filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      )
      normalizedAnswers[question.id] = picked
      pickedByQuestion.push({ question: question.question, picked })
    }

    if (hasNote) {
      const first = pending.questions[0]
      if (first) {
        normalizedAnswers[first.id] = [
          ...(normalizedAnswers[first.id] ?? []),
          `(user note: ${trimmedNote})`,
        ]
      }
    }

    const hasAnySelection = pickedByQuestion.some((entry) => entry.picked.length > 0)
    const declined = !answers && !hasNote

    if (declined) {
      log('codex.requestUserInput.declined', { windowId })
    } else if (!hasAnySelection) {
      log('codex.requestUserInput.freeform', { windowId })
    } else if (Object.values(normalizedAnswers).some((picked) => picked.length === 0)) {
      log('codex.requestUserInput.incomplete', {
        windowId,
        expected: pending.questions.length,
        actual: Object.values(normalizedAnswers).filter((picked) => picked.length > 0).length,
      })
    } else {
      log('codex.requestUserInput.answered', {
        windowId,
        keys: Object.keys(normalizedAnswers).length,
      })
    }

    appendQuestionAnswerMessage(
      runtime.snapshot,
      windowId,
      pending.questions,
      pickedByQuestion,
      trimmedNote,
      declined,
    )
    this.emitUpdate(runtime.snapshot)
    pending.resolve(codexQuestionResponse(normalizedAnswers))
  }

  async respondApproval(
    windowId: string,
    decision: 'accept' | 'acceptForSession' | 'decline',
  ): Promise<void> {
    const runtime = this.runtimes.get(windowId)
    if (!runtime) return

    if (runtime.kind === 'copilot') {
      const pending = runtime.pendingApproval
      if (!pending) return
      runtime.pendingApproval = null
      runtime.snapshot.pendingApproval = null
      runtime.snapshot.updatedAt = now()
      this.emitUpdate(runtime.snapshot)
      pending.resolve(
        decision === 'decline'
          ? { kind: 'reject' }
          : decision === 'acceptForSession'
            ? pending.kind === 'file-change'
              ? { kind: 'approve-for-session', approval: { kind: 'write' } }
              : { kind: 'approve-once' }
            : { kind: 'approve-once' },
      )
      return
    }

    if (runtime.kind !== 'codex') return
    const pending = runtime.pendingApproval
    if (!pending) return

    runtime.pendingApproval = null
    runtime.snapshot.pendingApproval = null
    runtime.snapshot.updatedAt = now()
    this.emitUpdate(runtime.snapshot)
    pending.resolve({ decision })
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

  private async createCodexRuntime(
    request: AgentSessionRequest,
    snapshot: AgentSessionSnapshot,
  ): Promise<CodexRuntime> {
    const runtime = {
      kind: 'codex',
      request,
      snapshot,
      client: null as unknown as LiveCodexAppServerClient,
      providerThreadId: snapshot.codexThreadId ?? null,
      activeTurnId: null,
      currentTurnUnifiedDiff: null,
      turnPromise: null,
      resolveTurn: null,
      rejectTurn: null,
      pendingQuestion: null,
      pendingApproval: null,
      pendingPlanApproval: null,
      closed: false,
      turnCounter: 0,
    } satisfies CodexRuntime
    runtime.client = await createCodexAppServerSession({
      onNotification: (notification) => {
        this.handleCodexNotification(runtime, notification)
        this.emitUpdate(runtime.snapshot)
      },
      onRequest: async (requestEvent) => await this.handleCodexServerRequest(runtime, requestEvent),
      onUnexpectedExit: (error) => {
        this.handleCodexUnexpectedExit(runtime, error)
      },
      onStderr: (line) => {
        log('codex.stderr', { windowId: snapshot.windowId, line })
      },
    })
    await this.openCodexThread(runtime)
    return runtime
  }

  private async createCursorRuntime(
    request: AgentSessionRequest,
    snapshot: AgentSessionSnapshot,
  ): Promise<CursorRuntime> {
    snapshot.error = null
    snapshot.status = 'idle'
    return {
      kind: 'cursor',
      request,
      snapshot,
      activeRun: null,
      runPromise: null,
      resolveRun: null,
      rejectRun: null,
      streamGeneration: 0,
      closed: false,
    }
  }

  private async createOpencodeRuntime(
    request: AgentSessionRequest,
    snapshot: AgentSessionSnapshot,
  ): Promise<OpencodeRuntime> {
    snapshot.error = null
    snapshot.status = 'idle'
    return {
      kind: 'opencode',
      request,
      snapshot,
      activeRun: null,
      runPromise: null,
      resolveRun: null,
      rejectRun: null,
      streamGeneration: 0,
      closed: false,
    }
  }

  private async createCopilotRuntime(
    request: AgentSessionRequest,
    snapshot: AgentSessionSnapshot,
  ): Promise<CopilotRuntime> {
    snapshot.error = null
    snapshot.status = 'idle'
    const client = buildCopilotClient(request.cwd)
    const runtime = {
      kind: 'copilot',
      request,
      snapshot,
      client,
      session: null as unknown as CopilotSession,
      turnPromise: null,
      resolveTurn: null,
      rejectTurn: null,
      pendingQuestion: null,
      pendingApproval: null,
      textByMessageId: new Map<string, string>(),
      reasoningById: new Map<string, string>(),
      closed: false,
    } satisfies CopilotRuntime
    await client.start()
    const config = this.buildCopilotSessionConfig(runtime)
    const sessionId = snapshot.copilotSessionId ?? request.copilotSessionId ?? null
    runtime.session = sessionId
      ? await client.resumeSession(sessionId, config)
      : await client.createSession(config)
    runtime.snapshot.copilotSessionId = runtime.session.sessionId
    return runtime
  }

  private buildCopilotSessionConfig(runtime: CopilotRuntime) {
    const model = runtime.request.model || DEFAULT_COPILOT_MODEL
    const effort = copilotThinkingEffort(runtime.request.thinkingLevel)
    return {
      clientName: 'cells',
      ...(model && model !== 'auto' ? { model } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      workingDirectory: runtime.request.cwd ?? undefined,
      streaming: true,
      includeSubAgentStreamingEvents: true,
      enableConfigDiscovery: true,
      infiniteSessions: { enabled: true },
      systemMessage: { content: buildCopilotSystemMessage(runtime.request.permissionMode) },
      onPermissionRequest: (request: CopilotPermissionRequest) =>
        this.handleCopilotPermissionRequest(runtime, request),
      onUserInputRequest: (request: {
        question: string
        choices?: string[]
        allowFreeform?: boolean
      }) => this.handleCopilotUserInputRequest(runtime, request),
      onEvent: (event: CopilotSessionEvent) => {
        this.handleCopilotEvent(runtime, event)
        this.emitUpdate(runtime.snapshot)
      },
    }
  }

  private async openCodexThread(runtime: CodexRuntime): Promise<void> {
    const params = buildCodexThreadStartParams(runtime.request)
    const resumeThreadId = runtime.snapshot.codexThreadId
    try {
      const response: { thread?: { id?: string } } = resumeThreadId
        ? await runtime.client.request('thread/resume', { threadId: resumeThreadId, ...params })
        : await runtime.client.request('thread/start', params)
      const threadId = asNonEmptyString(response.thread?.id) ?? resumeThreadId
      runtime.providerThreadId = threadId ?? null
      runtime.snapshot.codexThreadId = threadId ?? null
    } catch (err) {
      if (resumeThreadId && isCodexRecoverableThreadResumeError(err)) {
        log('codex.resume.fallback', {
          windowId: runtime.snapshot.windowId,
          threadId: resumeThreadId,
          error: err instanceof Error ? err.message : String(err),
        })
        runtime.snapshot.codexThreadId = null
        runtime.providerThreadId = null
        const response: { thread?: { id?: string } } = await runtime.client.request(
          'thread/start',
          params,
        )
        const threadId = asNonEmptyString(response.thread?.id)
        runtime.providerThreadId = threadId ?? null
        runtime.snapshot.codexThreadId = threadId ?? null
        return
      }
      throw err
    }
  }

  private handleCodexUnexpectedExit(runtime: CodexRuntime, error: Error) {
    if (runtime.closed) return
    log('codex.app-server.exit', {
      windowId: runtime.snapshot.windowId,
      error: error.message,
    })
    runtime.closed = true
    runtime.pendingApproval?.resolve({ decision: 'cancel' })
    runtime.pendingApproval = null
    runtime.snapshot.pendingApproval = null
    runtime.pendingQuestion = null
    runtime.snapshot.pendingQuestion = null
    runtime.activeTurnId = null
    runtime.rejectTurn?.(error)
    if (isCodexAuthError(error.message)) {
      runtime.snapshot.status = 'idle'
      runtime.snapshot.error = null
      appendMessage(runtime.snapshot, {
        id: `${runtime.snapshot.windowId}-codex-auth-${now()}`,
        role: 'auth_request',
        title: 'Sign in to Codex',
        text: "Codex isn't signed in on this machine yet. Open a login session below — once you finish you can retry your last message.",
        status: 'in_progress',
        authLoginUrl: null,
      })
    } else {
      runtime.snapshot.status = 'error'
      runtime.snapshot.error = error.message
    }
    this.emitUpdate(runtime.snapshot)
  }

  private handleCopilotPermissionRequest(
    runtime: CopilotRuntime,
    request: CopilotPermissionRequest,
  ): Promise<CopilotPermissionRequestResult> | CopilotPermissionRequestResult {
    if (runtime.request.permissionMode === 'bypass') return { kind: 'approve-once' }

    const payload = request as CopilotPermissionRequest & Record<string, unknown>
    const readOnly =
      request.kind === 'read' ||
      (request.kind === 'mcp' && payload.readOnly === true) ||
      (request.kind === 'shell' &&
        Array.isArray(payload.commands) &&
        payload.commands.every((command) => asRecord(command)?.readOnly === true))

    if (runtime.request.permissionMode === 'plan') {
      return readOnly
        ? { kind: 'approve-once' }
        : {
            kind: 'reject',
            feedback: 'Cells is in Plan mode, so write tools and shell commands are blocked.',
          }
    }

    if (readOnly) return { kind: 'approve-once' }

    const approval = buildCopilotPendingApproval(request)
    log('copilot.permission.pending', {
      windowId: runtime.snapshot.windowId,
      kind: approval.kind,
      detail: approval.detail ?? null,
    })
    return new Promise((resolve) => {
      runtime.pendingApproval?.resolve({ kind: 'reject' })
      runtime.pendingApproval = { kind: approval.kind, resolve }
      runtime.snapshot.pendingApproval = approval
      runtime.snapshot.updatedAt = now()
      this.emitUpdate(runtime.snapshot)
    })
  }

  private handleCopilotUserInputRequest(
    runtime: CopilotRuntime,
    request: { question: string; choices?: string[]; allowFreeform?: boolean },
  ): Promise<CopilotUserInputResponse> {
    const question = {
      id: `copilot-question-${now()}`,
      question: request.question,
      header: 'Question',
      options: (request.choices ?? []).map((choice) => ({ label: choice, description: '' })),
      multiSelect: false,
    }
    log('copilot.userInput.pending', {
      windowId: runtime.snapshot.windowId,
      hasChoices: question.options.length > 0,
    })
    return new Promise((resolve) => {
      runtime.pendingQuestion?.resolve({ answer: '', wasFreeform: true })
      runtime.pendingQuestion = { questions: [question], resolve }
      runtime.snapshot.pendingQuestion = { questions: [question], createdAt: now() }
      runtime.snapshot.updatedAt = now()
      this.emitUpdate(runtime.snapshot)
    })
  }

  private async handleCodexServerRequest(
    runtime: CodexRuntime,
    request: CodexAppServerRequest,
  ): Promise<unknown> {
    const payload = asRecord(request.params) ?? {}
    if (request.method === 'item/tool/requestUserInput') {
      const rawQuestions = Array.isArray(payload.questions) ? payload.questions : []
      const questions = rawQuestions
        .map((value) => {
          const item = asRecord(value)
          if (!item) return null
          const id = asNonEmptyString(item.id)
          const question = asNonEmptyString(item.question)
          if (!id || !question) return null
          const options = Array.isArray(item.options)
            ? item.options
                .map((option) => {
                  const normalized = asRecord(option)
                  if (!normalized) return null
                  const label = asNonEmptyString(normalized.label)
                  if (!label) return null
                  return {
                    label,
                    description: asNonEmptyString(normalized.description) || '',
                  }
                })
                .filter(
                  (option): option is { label: string; description: string } => option !== null,
                )
            : []
          return {
            id,
            question,
            header: asNonEmptyString(item.header) || '',
            options,
            multiSelect: false,
          }
        })
        .filter(
          (
            question,
          ): question is {
            id: string
            question: string
            header: string
            options: Array<{ label: string; description: string }>
            multiSelect: boolean
          } => question !== null,
        )

      log('codex.requestUserInput.pending', {
        windowId: runtime.snapshot.windowId,
        count: questions.length,
      })

      return await new Promise((resolve) => {
        const fallback = codexQuestionResponse(
          Object.fromEntries(questions.map((question) => [question.id, [] as string[]])),
        )
        runtime.pendingQuestion?.resolve(fallback)
        runtime.pendingQuestion = { questions, resolve }
        runtime.snapshot.pendingQuestion = { questions, createdAt: now() }
        runtime.snapshot.updatedAt = now()
        this.emitUpdate(runtime.snapshot)
      })
    }

    if (
      request.method === 'item/commandExecution/requestApproval' ||
      request.method === 'item/fileChange/requestApproval'
    ) {
      const approval = buildCodexPendingApproval(
        request.method === 'item/commandExecution/requestApproval' ? 'command' : 'file-change',
        payload,
      )
      log('codex.requestApproval.pending', {
        windowId: runtime.snapshot.windowId,
        kind: approval.kind,
      })
      return await new Promise((resolve) => {
        runtime.pendingApproval?.resolve({ decision: 'cancel' })
        runtime.pendingApproval = {
          kind: approval.kind,
          resolve,
        }
        runtime.snapshot.pendingApproval = approval
        runtime.snapshot.updatedAt = now()
        this.emitUpdate(runtime.snapshot)
      })
    }

    throw new Error(`Unsupported Codex app-server request: ${request.method}`)
  }

  private handleCodexNotification(runtime: CodexRuntime, notification: CodexAppServerNotification) {
    const { method } = notification
    const params = asRecord(notification.params)
    log('codex.notification', {
      windowId: runtime.snapshot.windowId,
      method,
      turnId:
        asNonEmptyString(params?.turnId) ?? asNonEmptyString(asRecord(params?.turn)?.id) ?? null,
      itemId:
        asNonEmptyString(params?.itemId) ?? asNonEmptyString(asRecord(params?.item)?.id) ?? null,
    })

    if (method !== 'error' && isCodexReconnectMessage(runtime.snapshot.error)) {
      runtime.snapshot.error = null
      runtime.snapshot.updatedAt = now()
    }

    if (method === 'thread/started') {
      const thread = asRecord(params?.thread)
      const threadId = asNonEmptyString(thread?.id) ?? asNonEmptyString(params?.threadId)
      runtime.providerThreadId = threadId ?? runtime.providerThreadId
      runtime.snapshot.codexThreadId = threadId ?? runtime.snapshot.codexThreadId
      return
    }

    if (method === 'thread/tokenUsage/updated') {
      const usage = asRecord(params?.tokenUsage)
      const last = asRecord(usage?.last)
      const total = asRecord(usage?.total)
      if (!last) return
      const inputTokens = typeof last.inputTokens === 'number' ? last.inputTokens : 0
      const cachedInputTokens =
        typeof last.cachedInputTokens === 'number' ? last.cachedInputTokens : 0
      const outputTokens = typeof last.outputTokens === 'number' ? last.outputTokens : 0
      const totalProcessedTokens =
        typeof total?.totalTokens === 'number' ? total.totalTokens : inputTokens + outputTokens
      const usedTokens =
        typeof last.totalTokens === 'number' ? last.totalTokens : inputTokens + outputTokens
      runtime.snapshot.usage = {
        model: runtime.request.model || null,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        contextWindow:
          typeof usage?.modelContextWindow === 'number'
            ? Math.round(usage.modelContextWindow)
            : CODEX_DEFAULT_CONTEXT_WINDOW,
        usedTokens,
        totalProcessedTokens,
        compactsAutomatically: true,
        updatedAt: now(),
      }
      return
    }

    if (method === 'turn/started') {
      const turn = asRecord(params?.turn)
      runtime.turnCounter += 1
      runtime.activeTurnId = asNonEmptyString(turn?.id) ?? runtime.activeTurnId
      runtime.currentTurnUnifiedDiff = null
      runtime.snapshot.status = 'running'
      runtime.snapshot.error = null
      runtime.snapshot.codexPlan = null
      return
    }

    if (method === 'turn/plan/updated') {
      const plan = Array.isArray(params?.plan) ? params.plan : []
      runtime.snapshot.codexPlan = {
        items: plan
          .map((value) => {
            const step = asRecord(value)
            if (!step) return null
            const text = asNonEmptyString(step.step)
            if (!text) return null
            return {
              text,
              completed: step.status === 'completed',
            }
          })
          .filter((step): step is { text: string; completed: boolean } => step !== null),
        updatedAt: now(),
      }
      return
    }

    if (method === 'turn/diff/updated') {
      const diff = asNonEmptyText(params?.diff)
      if (!diff) return
      runtime.currentTurnUnifiedDiff = diff
      syncCodexTurnDiffToLatestFileChange(runtime)
      return
    }

    if (method === 'turn/completed') {
      const turn = asRecord(params?.turn)
      const status = asNonEmptyString(turn?.status) ?? 'completed'
      runtime.snapshot.status = status === 'failed' ? 'error' : 'idle'
      runtime.snapshot.error =
        status === 'failed'
          ? asNonEmptyString(asRecord(turn?.error)?.message) || 'Codex turn failed'
          : null
      runtime.pendingApproval = null
      runtime.snapshot.pendingApproval = null
      runtime.snapshot.codexPlan = null
      runtime.currentTurnUnifiedDiff = null
      runtime.activeTurnId = null
      for (const message of runtime.snapshot.messages) {
        if (message.status === 'in_progress') {
          message.status = message.role === 'error' ? 'failed' : 'completed'
          message.updatedAt = now()
        }
      }
      if (runtime.snapshot.error) {
        runtime.rejectTurn?.(new Error(runtime.snapshot.error))
      } else {
        runtime.resolveTurn?.()
      }
      return
    }

    if (method === 'error') {
      const message =
        asNonEmptyString(params?.message) ||
        asNonEmptyString(asRecord(params?.error)?.message) ||
        'Codex failed'
      // Codex emits these while its own stream transport is retrying. The turn is
      // still alive, so treating them as terminal errors lets queued messages send
      // into the same active thread before the original turn finishes.
      if (isCodexReconnectMessage(message)) {
        runtime.snapshot.error = message
        if (runtime.turnPromise || runtime.activeTurnId) {
          runtime.snapshot.status = 'running'
        } else if (runtime.snapshot.status === 'error') {
          runtime.snapshot.status = 'idle'
        }
        runtime.snapshot.updatedAt = now()
        return
      }
      runtime.pendingApproval = null
      runtime.snapshot.pendingApproval = null
      runtime.snapshot.status = 'error'
      runtime.snapshot.error = message
      runtime.currentTurnUnifiedDiff = null
      runtime.activeTurnId = null
      runtime.rejectTurn?.(new Error(message))
      return
    }

    if (method === 'item/agentMessage/delta') {
      const itemId = asNonEmptyString(params?.itemId)
      const delta = asNonEmptyText(params?.delta)
      if (!itemId || !delta) return
      appendCodexDelta(runtime.snapshot, {
        id: codexMessageId(runtime, itemId),
        role: 'assistant',
        title: null,
        text: delta,
      })
      return
    }

    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const itemId = asNonEmptyString(params?.itemId)
      const delta = asNonEmptyText(params?.delta)
      if (!itemId || !delta) return
      appendCodexDelta(runtime.snapshot, {
        id: codexMessageId(runtime, itemId),
        role: 'reasoning',
        title: 'Reasoning',
        text: delta,
      })
      return
    }

    if (
      method === 'item/commandExecution/outputDelta' ||
      method === 'item/fileChange/outputDelta'
    ) {
      const itemId = asNonEmptyString(params?.itemId)
      const delta = asNonEmptyText(params?.delta)
      if (!itemId || !delta) return
      appendCodexDelta(runtime.snapshot, {
        id: codexMessageId(runtime, itemId),
        role: 'tool',
        title: method === 'item/fileChange/outputDelta' ? 'File changes' : 'Command',
        text: delta,
      })
      return
    }

    if (method !== 'item/started' && method !== 'item/completed') return
    const item = asRecord(params?.item)
    if (!item) return
    const next = codexItemToMessage(item)
    if (!next) return
    next.id = codexMessageId(runtime, next.id)
    if (method === 'item/completed' && next.title === 'File changes') {
      const previous = runtime.snapshot.messages.find((message) => message.id === next.id)
      next.metadata = runtime.currentTurnUnifiedDiff || previous?.metadata || previous?.text
    }
    if (next.title === 'File changes' && runtime.currentTurnUnifiedDiff) {
      next.metadata = runtime.currentTurnUnifiedDiff
    }
    if (method === 'item/started') next.status = 'in_progress'
    if (method === 'item/completed' && next.role === 'compaction') {
      next.status = 'completed'
      next.text = 'Context compacted'
    }
    // Codex emits a first-class `plan` item when it finalizes a proposed plan
    // (this mirrors t3code's `turn.proposed.completed` path — the plan arrives
    // pre-extracted, no tag parsing needed). Use it as the primary trigger for
    // the approval banner and skip appending the redundant transcript row.
    if (method === 'item/completed' && next.title === 'Plan' && next.role === 'system') {
      const planText = (next.text ?? '').trim()
      if (planText) {
        runtime.pendingPlanApproval = { plan: planText }
        runtime.snapshot.pendingPlanApproval = {
          plan: planText,
          createdAt: now(),
        }
        runtime.snapshot.updatedAt = now()
        log('codex.proposedPlan.pending', {
          windowId: runtime.snapshot.windowId,
          planLength: planText.length,
          source: 'planItem',
        })
        return
      }
    }
    // Fallback: older Codex builds (or plan mode on non-plan-aware models)
    // may ship the plan as `<proposed_plan>…</proposed_plan>` inside a
    // regular assistant message. Strip the tags from the rendered message
    // and surface the banner from the extracted body.
    if (
      method === 'item/completed' &&
      next.role === 'assistant' &&
      runtime.request.permissionMode === 'plan'
    ) {
      const extracted = extractCodexProposedPlan(next.text ?? '')
      if (extracted) {
        next.text = extracted.stripped || extracted.plan
        runtime.pendingPlanApproval = { plan: extracted.plan }
        runtime.snapshot.pendingPlanApproval = {
          plan: extracted.plan,
          createdAt: now(),
        }
        runtime.snapshot.updatedAt = now()
        log('codex.proposedPlan.pending', {
          windowId: runtime.snapshot.windowId,
          planLength: extracted.plan.length,
          source: 'proposedPlanTag',
        })
      }
    }
    appendMessage(runtime.snapshot, next)
  }

  private handleCopilotEvent(runtime: CopilotRuntime, event: CopilotSessionEvent) {
    log('copilot.event', {
      windowId: runtime.snapshot.windowId,
      type: event.type,
      id: (event as { id?: string }).id ?? null,
    })
    runtime.snapshot.copilotSessionId = runtime.session.sessionId

    if (event.type === 'assistant.message_delta') {
      const data = event.data
      const id = data.messageId || event.id
      const nextText = (runtime.textByMessageId.get(id) ?? '') + (data.deltaContent ?? '')
      runtime.textByMessageId.set(id, nextText)
      appendMessage(runtime.snapshot, {
        id: `copilot-assistant-${id}`,
        role: 'assistant',
        text: nextText,
        status: 'in_progress',
        parentToolUseId: data.parentToolCallId ?? null,
        updatedAt: now(),
      })
      return
    }

    if (event.type === 'assistant.message') {
      const data = event.data
      const id = data.messageId || event.id
      const text = data.content ?? runtime.textByMessageId.get(id) ?? ''
      const extracted =
        runtime.request.permissionMode === 'plan' ? extractCodexProposedPlan(text) : null
      if (extracted) {
        runtime.snapshot.pendingPlanApproval = {
          plan: extracted.plan,
          createdAt: now(),
        }
      }
      appendMessage(runtime.snapshot, {
        id: `copilot-assistant-${id}`,
        role: 'assistant',
        text: extracted ? extracted.stripped || extracted.plan : text,
        status: 'completed',
        parentToolUseId: data.parentToolCallId ?? null,
        updatedAt: now(),
      })
      runtime.snapshot.usage = buildUsageStats({
        model: runtime.request.model ?? DEFAULT_COPILOT_MODEL,
        inputTokens: 0,
        outputTokens: data.outputTokens ?? 0,
        cachedInputTokens: 0,
        contextWindow: null,
        compactsAutomatically: true,
      })
      return
    }

    if (event.type === 'assistant.reasoning_delta') {
      const data = event.data
      const id = data.reasoningId || event.id
      const nextText = (runtime.reasoningById.get(id) ?? '') + (data.deltaContent ?? '')
      runtime.reasoningById.set(id, nextText)
      appendMessage(runtime.snapshot, {
        id: `copilot-reasoning-${id}`,
        role: 'reasoning',
        title: 'Reasoning',
        text: nextText,
        status: 'in_progress',
        updatedAt: now(),
      })
      return
    }

    if (event.type === 'assistant.reasoning') {
      const data = event.data
      const id = data.reasoningId || event.id
      appendMessage(runtime.snapshot, {
        id: `copilot-reasoning-${id}`,
        role: 'reasoning',
        title: 'Reasoning',
        text: data.content ?? runtime.reasoningById.get(id) ?? '',
        status: 'completed',
        updatedAt: now(),
      })
      return
    }

    if (event.type === 'tool.execution_start') {
      const data = event.data
      appendMessage(runtime.snapshot, {
        id: `copilot-tool-${data.toolCallId}`,
        role: 'tool',
        title:
          data.mcpToolName || data.mcpServerName
            ? `${data.mcpServerName ?? 'MCP'} · ${data.mcpToolName ?? data.toolName}`
            : copilotToolTitle(data.toolName),
        text: compactText(data.arguments ?? {}),
        metadata: compactText(data.arguments ?? {}),
        status: 'in_progress',
        toolUseId: data.toolCallId,
        parentToolUseId: data.parentToolCallId ?? null,
        updatedAt: now(),
      })
      return
    }

    if (event.type === 'tool.execution_partial_result') {
      const data = event.data
      const existing = runtime.snapshot.messages.find(
        (message) => message.id === `copilot-tool-${data.toolCallId}`,
      )
      if (existing) {
        existing.text = appendBoundedText(existing.text || '', data.partialOutput ?? '', 12_000)
        existing.updatedAt = now()
        runtime.snapshot.updatedAt = now()
      }
      return
    }

    if (event.type === 'tool.execution_progress') {
      const data = event.data
      const existing = runtime.snapshot.messages.find(
        (message) => message.id === `copilot-tool-${data.toolCallId}`,
      )
      if (existing) {
        existing.metadata = data.progressMessage || existing.metadata || null
        existing.updatedAt = now()
        runtime.snapshot.updatedAt = now()
      }
      return
    }

    if (event.type === 'tool.execution_complete') {
      const data = event.data
      const existing = runtime.snapshot.messages.find(
        (message) => message.id === `copilot-tool-${data.toolCallId}`,
      )
      const text = compactCopilotToolResult(data as unknown as Record<string, unknown>)
      if (existing) {
        existing.text = text || existing.text
        existing.status = data.success ? 'completed' : 'failed'
        existing.metadata = text || existing.metadata || null
        existing.updatedAt = now()
        runtime.snapshot.updatedAt = now()
      } else {
        appendMessage(runtime.snapshot, {
          id: `copilot-tool-${data.toolCallId}`,
          role: 'tool',
          title: 'Tool',
          text,
          status: data.success ? 'completed' : 'failed',
          toolUseId: data.toolCallId,
          updatedAt: now(),
        })
      }
      return
    }

    if (event.type === 'assistant.usage') {
      const data = event.data
      runtime.snapshot.usage = buildUsageStats({
        model: data.model ?? runtime.request.model ?? DEFAULT_COPILOT_MODEL,
        inputTokens:
          (data.inputTokens ?? 0) + (data.cacheReadTokens ?? 0) + (data.cacheWriteTokens ?? 0),
        outputTokens: data.outputTokens ?? 0,
        cachedInputTokens: (data.cacheReadTokens ?? 0) + (data.cacheWriteTokens ?? 0),
        contextWindow: null,
        compactsAutomatically: true,
      })
      return
    }

    if (event.type === 'session.title_changed') {
      const title = event.data.title?.trim()
      if (title && isPlaceholderAgentSessionTitle(runtime.snapshot.agent, runtime.snapshot.title)) {
        runtime.snapshot.title = title
      }
      return
    }

    if (event.type === 'session.error') {
      const message = event.data.message || 'GitHub Copilot failed'
      runtime.pendingApproval = null
      runtime.snapshot.pendingApproval = null
      runtime.pendingQuestion = null
      runtime.snapshot.pendingQuestion = null
      runtime.snapshot.status = isCopilotAuthError(message) ? 'idle' : 'error'
      runtime.snapshot.error = isCopilotAuthError(message) ? null : message
      appendMessage(runtime.snapshot, {
        id: `copilot-error-${event.id}`,
        role: isCopilotAuthError(message) ? 'auth_request' : 'error',
        title: isCopilotAuthError(message) ? 'Sign in to GitHub Copilot' : 'GitHub Copilot',
        text: message,
        status: isCopilotAuthError(message) ? 'in_progress' : 'failed',
        authLoginUrl: isCopilotAuthError(message) ? (event.data.url ?? null) : undefined,
        updatedAt: now(),
      })
      runtime.rejectTurn?.(new Error(message))
      return
    }

    if (event.type === 'session.idle') {
      runtime.snapshot.status = 'idle'
      runtime.snapshot.error = null
      runtime.pendingApproval = null
      runtime.snapshot.pendingApproval = null
      runtime.pendingQuestion = null
      runtime.snapshot.pendingQuestion = null
      for (const message of runtime.snapshot.messages) {
        if (message.status === 'in_progress') {
          message.status = message.role === 'error' ? 'failed' : 'completed'
          message.updatedAt = now()
        }
      }
      runtime.resolveTurn?.()
    }
  }

  private startOpencodeCliTurn(
    runtime: OpencodeRuntime,
    prompt: string,
    streamGeneration: number,
    fileAttachments: string[],
  ) {
    const binary = getSystemOpencodePath()
    const windowId = runtime.snapshot.windowId
    if (!binary) throw new Error('OpenCode CLI not found on PATH.')

    const args = ['run', '--format', 'json', '--thinking']
    if (runtime.request.cwd) args.push('--dir', runtime.request.cwd)
    const model = runtime.request.model || DEFAULT_OPENCODE_MODEL
    if (model && model !== 'auto') args.push('--model', model)
    const variant = opencodeThinkingVariant(runtime.request.thinkingLevel)
    if (variant) args.push('--variant', variant)
    if (runtime.request.permissionMode === 'bypass') args.push('--dangerously-skip-permissions')
    if (runtime.snapshot.opencodeSessionId)
      args.push('--session', runtime.snapshot.opencodeSessionId)
    for (const filePath of fileAttachments) args.push('--file', filePath)
    args.push(prompt)

    const child = spawn(binary, args, {
      cwd: runtime.request.cwd ?? undefined,
      env: buildAgentEnv(runtime.request.cwd ? { PWD: runtime.request.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    runtime.activeRun = child
    runtime.snapshot.status = 'running'
    runtime.snapshot.error = null
    this.emitUpdate(runtime.snapshot)

    let stdoutBuffer = ''
    let stderrBuffer = ''
    let terminalFailure = false

    const fail = (message: string) => {
      if (runtime.closed || runtime.streamGeneration !== streamGeneration || terminalFailure) return
      terminalFailure = true
      const trimmed = message.trim() || 'OpenCode run failed'
      const authError = isOpencodeAuthError(trimmed)
      runtime.activeRun = null
      runtime.snapshot.status = authError ? 'idle' : 'error'
      runtime.snapshot.error = authError ? null : trimmed
      appendMessage(runtime.snapshot, {
        id: `${windowId}-opencode-error-${now()}`,
        role: authError ? 'auth_request' : 'error',
        title: authError ? 'Sign in to OpenCode' : 'OpenCode error',
        text: authError
          ? "OpenCode isn't signed in on this machine yet. Sign in with OpenCode CLI, then retry your last message."
          : trimmed,
        status: authError ? 'in_progress' : 'failed',
        updatedAt: now(),
      })
      runtime.rejectRun?.(new Error(trimmed))
      this.emitUpdate(runtime.snapshot)
    }

    const complete = () => {
      if (runtime.closed || runtime.streamGeneration !== streamGeneration || terminalFailure) return
      runtime.activeRun = null
      runtime.snapshot.status = 'idle'
      runtime.snapshot.error = null
      for (const entry of runtime.snapshot.messages) {
        if (entry.status === 'in_progress') {
          entry.status = entry.role === 'error' ? 'failed' : 'completed'
          entry.updatedAt = now()
        }
      }
      runtime.resolveRun?.()
      this.emitUpdate(runtime.snapshot)
    }

    const handleTextPart = (part: Record<string, unknown>, role: 'assistant' | 'reasoning') => {
      const id = asNonEmptyString(part.id) || `${role}-${now()}`
      const text = asNonEmptyText(part.text) ?? ''
      if (!text) return
      const extracted =
        role === 'assistant' && runtime.request.permissionMode === 'plan'
          ? extractCodexProposedPlan(text)
          : null
      if (extracted) {
        runtime.snapshot.pendingPlanApproval = { plan: extracted.plan, createdAt: now() }
      }
      appendMessage(runtime.snapshot, {
        id: `opencode-${role}-${id}`,
        role,
        title: role === 'reasoning' ? 'Reasoning' : null,
        text: extracted ? extracted.stripped || extracted.plan : text,
        status: asRecord(part.time)?.end ? 'completed' : 'in_progress',
        updatedAt: now(),
      })
    }

    const handleToolPart = (part: Record<string, unknown>) => {
      const id = asNonEmptyString(part.id) || asNonEmptyString(part.callID) || `tool-${now()}`
      const tool = asNonEmptyString(part.tool) || 'Tool'
      const state = asRecord(part.state) ?? {}
      const statusValue = asNonEmptyString(state.status)
      const input = state.input ?? state.metadata ?? part.input ?? {}
      const output = state.output ?? state.result ?? state.error ?? part.output ?? null
      appendMessage(runtime.snapshot, {
        id: `opencode-tool-${id}`,
        role: 'tool',
        title: cursorToolTitle(tool),
        text: compactText(input),
        metadata: output == null ? compactText(input) : compactText(output),
        status:
          statusValue === 'completed'
            ? 'completed'
            : statusValue === 'error' || statusValue === 'failed'
              ? 'failed'
              : 'in_progress',
        toolUseId: id,
        updatedAt: now(),
      })
    }

    const handleEvent = (raw: Record<string, unknown>) => {
      if (runtime.closed || runtime.streamGeneration !== streamGeneration) return
      const event = (asRecord(raw.payload) ?? raw) as Record<string, unknown>
      const type = asNonEmptyString(event.type)
      const sessionId = asNonEmptyString(event.sessionID) ?? asNonEmptyString(event.sessionId)
      if (sessionId) runtime.snapshot.opencodeSessionId = sessionId
      const part = asRecord(event.part)

      if (type === 'text' && part) handleTextPart(part, 'assistant')
      else if (type === 'reasoning' && part) handleTextPart(part, 'reasoning')
      else if (type === 'tool' && part) handleToolPart(part)
      else if ((type === 'patch' || type === 'file') && part) {
        appendMessage(runtime.snapshot, {
          id: `opencode-${type}-${asNonEmptyString(part.id) || now()}`,
          role: 'tool',
          title: type === 'patch' ? 'File changes' : 'File',
          text: compactText(part),
          metadata: compactText(part),
          status: asRecord(part.time)?.end ? 'completed' : 'in_progress',
          updatedAt: now(),
        })
      } else if (type === 'step_finish' && part) {
        const tokens = asRecord(part.tokens)
        const cache = asRecord(tokens?.cache)
        runtime.snapshot.usage = buildUsageStats({
          model: runtime.request.model ?? DEFAULT_OPENCODE_MODEL,
          inputTokens: typeof tokens?.input === 'number' ? tokens.input : 0,
          outputTokens:
            (typeof tokens?.output === 'number' ? tokens.output : 0) +
            (typeof tokens?.reasoning === 'number' ? tokens.reasoning : 0),
          cachedInputTokens: typeof cache?.read === 'number' ? cache.read : 0,
          contextWindow: null,
          compactsAutomatically: true,
        })
      } else if (type === 'compaction' || type === 'session.compacted') {
        appendMessage(runtime.snapshot, {
          id: `opencode-compaction-${now()}`,
          role: 'compaction',
          text: 'Context compacted',
          status: 'completed',
          updatedAt: now(),
        })
      } else if (type === 'error' || type === 'session.error') {
        fail(
          asNonEmptyString(event.message) ??
            asNonEmptyString(asRecord(event.error)?.message) ??
            compactText(event, 'OpenCode failed'),
        )
      } else {
        return
      }
      this.emitUpdate(runtime.snapshot)
    }

    const handleStdout = (chunk: Buffer | string) => {
      stdoutBuffer = appendBoundedText(stdoutBuffer, String(chunk), 64_000)
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parsed = parseJsonRecord(trimmed)
        if (parsed) handleEvent(parsed)
        else stderrBuffer = appendBoundedText(stderrBuffer, `${trimmed}\n`, 8_000)
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', handleStdout)
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer = appendBoundedText(stderrBuffer, chunk, 8_000)
    })
    child.on('error', (err) => fail(err.message))
    child.on('close', (code, signal) => {
      if (runtime.closed || runtime.streamGeneration !== streamGeneration) return
      if (stdoutBuffer.trim()) handleStdout('\n')
      runtime.activeRun = null
      if (terminalFailure) return
      if (signal === 'SIGINT' || signal === 'SIGTERM' || code === 0) {
        complete()
        return
      }
      fail(stderrBuffer.trim() || stdoutBuffer.trim() || `OpenCode exited with code ${code}`)
    })
  }

  private startCursorCliTurn(runtime: CursorRuntime, prompt: string, streamGeneration: number) {
    const binary = getSystemCursorAgentPath()
    const windowId = runtime.snapshot.windowId
    if (!binary) {
      throw new Error('Cursor Agent CLI not found on PATH.')
    }

    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--sandbox',
    ]
    args.push(runtime.request.permissionMode === 'bypass' ? 'disabled' : 'enabled')
    args.push('--trust')
    if (runtime.request.permissionMode === 'bypass') {
      args.push('--force')
    }
    if (runtime.request.permissionMode === 'plan') {
      args.push('--mode', 'plan')
    } else if (runtime.request.permissionMode === 'ask') {
      args.push('--mode', 'ask')
    }
    const model = runtime.request.model || DEFAULT_CURSOR_MODEL
    if (model && model !== 'auto') {
      args.push('--model', model)
    }
    if (runtime.snapshot.cursorAgentId) {
      args.push('--resume', runtime.snapshot.cursorAgentId)
    }
    args.push(prompt)

    const child = spawn(binary, args, {
      cwd: runtime.request.cwd ?? undefined,
      env: buildAgentEnv(runtime.request.cwd ? { PWD: runtime.request.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    runtime.activeRun = child
    runtime.snapshot.status = 'running'
    runtime.snapshot.error = null
    this.emitUpdate(runtime.snapshot)

    let stdoutBuffer = ''
    let stderrBuffer = ''
    let sawResult = false
    let assistantText = ''
    let assistantIndex = 0
    let awaitingPostToolAssistant = false
    let terminalFailure = false

    const assistantId = () => `${windowId}-cursor-assistant-${streamGeneration}-${assistantIndex}`

    const fail = (message: string) => {
      if (runtime.closed || runtime.streamGeneration !== streamGeneration) return
      if (terminalFailure) return
      terminalFailure = true
      const trimmed = message.trim() || 'Cursor run failed'
      runtime.activeRun = null
      runtime.snapshot.status = 'error'
      runtime.snapshot.error = trimmed
      appendMessage(runtime.snapshot, {
        id: `${windowId}-cursor-error-${now()}`,
        role: 'error',
        title: 'Cursor error',
        text: trimmed,
        status: 'failed',
        updatedAt: now(),
      })
      runtime.rejectRun?.(new Error(trimmed))
      this.emitUpdate(runtime.snapshot)
    }

    const complete = (result: Record<string, unknown>) => {
      if (runtime.closed || runtime.streamGeneration !== streamGeneration) return
      sawResult = true
      runtime.activeRun = null
      const isError = result.is_error === true || result.subtype === 'error'
      const resultText = asNonEmptyString(result.result)
      if (isError) {
        fail(resultText || 'Cursor run failed')
        return
      }
      if (resultText && !assistantText.trim()) {
        appendMessage(runtime.snapshot, {
          id: assistantId(),
          role: 'assistant',
          text: resultText,
          status: 'completed',
          updatedAt: now(),
        })
      }
      runtime.snapshot.status = 'idle'
      runtime.snapshot.error = null
      runtime.snapshot.cursorRunId =
        asNonEmptyString(result.request_id) ?? runtime.snapshot.cursorRunId
      const usage = asRecord(result.usage)
      runtime.snapshot.usage = {
        model: runtime.request.model ?? DEFAULT_CURSOR_MODEL,
        inputTokens: typeof usage?.inputTokens === 'number' ? usage.inputTokens : 0,
        outputTokens: typeof usage?.outputTokens === 'number' ? usage.outputTokens : 0,
        cachedInputTokens: typeof usage?.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0,
        contextWindow: null,
        usedTokens: null,
        totalProcessedTokens: null,
        compactsAutomatically: true,
        updatedAt: now(),
      }
      for (const entry of runtime.snapshot.messages) {
        if (entry.status === 'in_progress') {
          entry.status = entry.role === 'error' ? 'failed' : 'completed'
          entry.updatedAt = now()
        }
      }
      runtime.resolveRun?.()
      this.emitUpdate(runtime.snapshot)
    }

    const handleEvent = (event: Record<string, unknown>) => {
      if (runtime.closed || runtime.streamGeneration !== streamGeneration) return
      const type = asNonEmptyString(event.type)
      const sessionId = asNonEmptyString(event.session_id)
      if (sessionId) runtime.snapshot.cursorAgentId = sessionId

      if (type === 'assistant') {
        if (awaitingPostToolAssistant) {
          assistantIndex += 1
          assistantText = ''
          awaitingPostToolAssistant = false
        }
        const message = asRecord(event.message)
        const content = Array.isArray(message?.content) ? message.content : []
        const text = content
          .map((block) => {
            const record = asRecord(block)
            return record?.type === 'text' ? asNonEmptyText(record.text) : null
          })
          .filter((value): value is string => value !== null)
          .join('\n\n')
        if (!text) return
        const isFullAssistantMessage =
          Boolean(asNonEmptyString(event.model_call_id)) || typeof event.timestamp_ms !== 'number'
        if (isFullAssistantMessage) {
          if (text.length >= assistantText.length) assistantText = text
          else if (!assistantText.endsWith(text)) assistantText += text
        } else {
          assistantText += text
        }
        appendMessage(runtime.snapshot, {
          id: assistantId(),
          role: 'assistant',
          text: assistantText,
          status: 'in_progress',
          updatedAt: now(),
        })
        const extracted = extractCodexProposedPlan(assistantText)
        if (runtime.request.permissionMode === 'plan' && extracted) {
          runtime.snapshot.pendingPlanApproval = {
            plan: extracted.plan,
            createdAt: now(),
          }
          const assistant = runtime.snapshot.messages.find((entry) => entry.id === assistantId())
          if (assistant) assistant.text = extracted.stripped || extracted.plan
        }
        this.emitUpdate(runtime.snapshot)
        return
      }

      if (type === 'tool_call') {
        if (assistantText.trim()) {
          const assistant = runtime.snapshot.messages.find((entry) => entry.id === assistantId())
          if (assistant && assistant.status === 'in_progress') {
            assistant.status = 'completed'
            assistant.updatedAt = now()
          }
        }
        awaitingPostToolAssistant = true
        const subtype = asNonEmptyString(event.subtype)
        const callId = asNonEmptyString(event.call_id) || `${windowId}-cursor-tool-${now()}`
        const toolCall = asRecord(event.tool_call)
        const entries = toolCall ? Object.entries(toolCall) : []
        const [rawToolName, rawPayload] = entries[0] ?? ['toolCall', {}]
        const payload = asRecord(rawPayload) ?? {}
        const title = cursorToolTitle(rawToolName)
        const toolArgs = normalizeCursorToolArgs(title, asRecord(payload.args) ?? {})
        if (rawToolName === 'shellToolCall' && typeof payload.description === 'string') {
          toolArgs.description = payload.description
        }
        if (subtype === 'started' && isCursorBroadProtectedGlob(title, toolArgs)) {
          const detail = compactText(toolArgs)
          try {
            child.kill('SIGINT')
          } catch {}
          fail(`Blocked broad Cursor glob in a macOS protected location.\n\n${detail}`)
          return
        }
        const result = asRecord(payload.result)
        const success = result ? asRecord(result.success) : null
        const error = result ? asRecord(result.error) : null
        appendMessage(runtime.snapshot, {
          id: `cursor-tool-${callId.replace(/\s+/g, '-')}`,
          role: 'tool',
          title,
          text: compactText(toolArgs),
          metadata: compactText(success ?? error ?? result ?? toolArgs),
          status:
            subtype === 'completed'
              ? error
                ? 'failed'
                : 'completed'
              : subtype === 'failed'
                ? 'failed'
                : 'in_progress',
          toolUseId: callId,
          updatedAt: now(),
        })
        this.emitUpdate(runtime.snapshot)
        return
      }

      if (type === 'result') {
        complete(event)
      }
    }

    const handleStdout = (chunk: Buffer | string) => {
      stdoutBuffer = appendBoundedText(stdoutBuffer, String(chunk), 32_000)
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = asRecord(JSON.parse(trimmed))
          if (parsed) handleEvent(parsed)
        } catch {
          stderrBuffer = appendBoundedText(stderrBuffer, `${trimmed}\n`, 8_000)
        }
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', handleStdout)
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer = appendBoundedText(stderrBuffer, chunk, 8_000)
    })
    child.on('error', (err) => fail(err.message))
    child.on('close', (code, signal) => {
      if (runtime.closed || runtime.streamGeneration !== streamGeneration) return
      if (terminalFailure) return
      if (stdoutBuffer.trim()) handleStdout('\n')
      runtime.activeRun = null
      if (sawResult) return
      if (signal === 'SIGINT' || signal === 'SIGTERM') {
        runtime.snapshot.status = 'idle'
        runtime.resolveRun?.()
        this.emitUpdate(runtime.snapshot)
        return
      }
      const message =
        stderrBuffer.trim() ||
        stdoutBuffer.trim() ||
        (code === 0 ? 'Cursor finished without a result' : `Cursor exited with code ${code}`)
      fail(message)
    })
  }

  private async reopenRuntime(runtime: Runtime): Promise<Runtime> {
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
        canUseTool: (toolName: string, input: any) =>
          this.handleClaudeCanUseTool(windowId, toolName, input),
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
      runtime.liveContextUsageUpdatedThisTurn = false
      this.startClaudeStream(runtime)
      return runtime
    }

    if (runtime.kind === 'cursor' || runtime.kind === 'opencode') {
      runtime.activeRun = null
      runtime.closed = false
      return runtime
    }

    if (runtime.kind === 'copilot') {
      try {
        await runtime.session.disconnect()
      } catch {}
      await runtime.client.stop().catch(() => [])
      const next = await this.createCopilotRuntime(runtime.request, runtime.snapshot)
      this.runtimes.set(windowId, next)
      return next
    }

    runtime.client = await createCodexAppServerSession({
      onNotification: (notification) => {
        this.handleCodexNotification(runtime, notification)
        this.emitUpdate(runtime.snapshot)
      },
      onRequest: async (requestEvent) => await this.handleCodexServerRequest(runtime, requestEvent),
      onUnexpectedExit: (error) => {
        this.handleCodexUnexpectedExit(runtime, error)
      },
      onStderr: (line) => {
        log('codex.stderr', { windowId, line })
      },
    })
    await this.openCodexThread(runtime)
    runtime.activeTurnId = null
    runtime.pendingApproval = null
    runtime.snapshot.pendingApproval = null
    runtime.pendingQuestion = null
    runtime.snapshot.pendingQuestion = null
    runtime.closed = false
    return runtime
  }

  private emitUpdate(snapshot: AgentSessionSnapshot) {
    schedulePersist(snapshot)
    this.emit('update', cloneSnapshot(snapshot))
  }

  private startClaudeStream(runtime: ClaudeRuntime) {
    runtime.streamGeneration += 1
    runtime.streamPromise = this.consumeClaudeStream(runtime, runtime.streamGeneration)
  }

  private async consumeClaudeStream(runtime: ClaudeRuntime, streamGeneration: number) {
    const windowId = runtime.snapshot.windowId
    log('claude.stream.start', { windowId, streamGeneration })
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
          if (streamGeneration !== runtime.streamGeneration) {
            log('claude.stream.stale-event', { windowId, count, totalCount, streamGeneration })
            return
          }
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
        if (count > 0) {
          log('claude.stream.turn-end', { windowId, count, totalCount, streamGeneration })
        } else {
          await new Promise((resolve) => setTimeout(resolve, CLAUDE_IDLE_STREAM_BACKOFF_MS))
        }
        // Loop back around — the next stream() call will block on the shared
        // queryIterator until the user sends another message.
      }
      log('claude.stream.end', { windowId, totalCount, streamGeneration })
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      log('claude.stream.error', {
        windowId,
        totalCount,
        streamGeneration,
        error: errMsg,
      })
      if (streamGeneration !== runtime.streamGeneration) {
        log('claude.stream.stale-error', { windowId, totalCount, streamGeneration, error: errMsg })
        return
      }
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
      const scopeKey = `${evt.session_id ?? runtime.snapshot.claudeSessionId ?? runtime.snapshot.windowId}:${
        parentToolUseId ?? 'root'
      }`
      const blockKey = (index: unknown) => `${scopeKey}:${String(index ?? 0)}`
      if (streamed?.type === 'message_start') {
        const messageId = streamed.message?.id
        if (typeof messageId === 'string' && messageId.length > 0) {
          runtime.claudeStreamState.messageIdByScope.set(scopeKey, messageId)
        }
        return
      }
      if (streamed?.type === 'message_stop') {
        runtime.claudeStreamState.messageIdByScope.delete(scopeKey)
        for (const key of Array.from(runtime.claudeStreamState.textMessageIdByBlock.keys())) {
          if (key.startsWith(`${scopeKey}:`))
            runtime.claudeStreamState.textMessageIdByBlock.delete(key)
        }
        for (const key of Array.from(runtime.claudeStreamState.toolUseIdByBlock.keys())) {
          if (key.startsWith(`${scopeKey}:`)) runtime.claudeStreamState.toolUseIdByBlock.delete(key)
        }
        return
      }
      if (streamed?.type === 'content_block_start' && streamed?.content_block?.type === 'text') {
        const messageId =
          runtime.claudeStreamState.messageIdByScope.get(scopeKey) ??
          (typeof evt.uuid === 'string' ? evt.uuid : `${runtime.snapshot.windowId}-${now()}`)
        runtime.claudeStreamState.textMessageIdByBlock.set(
          blockKey(streamed.index),
          `stream-${messageId}-${streamed.index ?? 0}`,
        )
        return
      }
      if (
        streamed?.type === 'content_block_start' &&
        streamed?.content_block?.type === 'tool_use'
      ) {
        const tool = streamed.content_block
        if (tool.id) {
          runtime.claudeStreamState.toolUseIdByBlock.set(blockKey(streamed.index), tool.id)
        }
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
          // Preserve original input in metadata so diff-stats survive the
          // text field being overwritten with the tool result later.
          metadata: compactText(tool.input ?? {}),
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
        const parentId =
          runtime.claudeStreamState.textMessageIdByBlock.get(blockKey(streamed.index)) ??
          `stream-${runtime.claudeStreamState.messageIdByScope.get(scopeKey) ?? evt.uuid}-${
            streamed.index ?? 0
          }`
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
        const toolUseId =
          streamed.tool_use_id ??
          runtime.claudeStreamState.toolUseIdByBlock.get(blockKey(streamed.index))
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
        // When `send()` fires, we append an optimistic user row with id
        // `{windowId}-user-{timestamp}` so the bubble shows instantly. The SDK
        // later echoes the same user turn back with its own `evt.uuid`. Naively
        // appending would leave two bubbles, and the stable-list diff between
        // the optimistic id (gone) and the new uuid id (new) can visually drop
        // the row during the swap — the source of "user message disappears".
        // Adopt the SDK uuid onto the matching optimistic row instead.
        const optimisticIdPrefix = `${runtime.snapshot.windowId}-user-`
        const replayIdPrefix = `${runtime.snapshot.windowId}-user-replay-`
        let optimisticIdx = -1
        for (let i = runtime.snapshot.messages.length - 1; i >= 0; i -= 1) {
          const m = runtime.snapshot.messages[i]
          if (
            m.role === 'user' &&
            m.id.startsWith(optimisticIdPrefix) &&
            !m.id.startsWith(replayIdPrefix) &&
            m.text === text
          ) {
            optimisticIdx = i
            break
          }
        }
        if (optimisticIdx >= 0) {
          const existing = runtime.snapshot.messages[optimisticIdx]
          runtime.snapshot.messages[optimisticIdx] = {
            ...existing,
            id,
            status: 'completed',
            updatedAt: now(),
          }
          runtime.snapshot.updatedAt = now()
          return
        }
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
      // If we've already been streaming text, overwrite it with the
      // authoritative final text and mark it completed. Partial stream events
      // are keyed by the raw API message/content-block id; older builds used
      // the SDK wrapper uuid, so keep that as a fallback while sessions are
      // running across reloads.
      const messageId = typeof msg?.id === 'string' && msg.id ? msg.id : uuid
      const firstTextIndex = content.findIndex((c: any) => c?.type === 'text')
      const streamingIds = [
        messageId ? `stream-${messageId}-${firstTextIndex >= 0 ? firstTextIndex : 0}` : null,
        uuid ? `stream-${uuid}` : null,
      ].filter((id): id is string => typeof id === 'string')
      const streamed = runtime.snapshot.messages.find(
        (m) => m.role === 'assistant' && streamingIds.includes(m.id),
      )
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
    if (
      event.type === 'system' &&
      ((event as any).subtype === 'task_progress' || (event as any).subtype === 'task_notification')
    ) {
      const evt = event as any
      const liveUsage = buildClaudeLiveUsageStats({
        usage: asRecord(evt.usage),
        existingUsage: runtime.snapshot.usage,
        model: runtime.snapshot.usage?.model ?? runtime.request.model ?? DEFAULT_CLAUDE_MODEL,
        contextLength: runtime.request.contextLength,
      })
      if (liveUsage) {
        runtime.snapshot.usage = liveUsage
        runtime.liveContextUsageUpdatedThisTurn = true
      }
      return
    }
    if (
      event.type === 'system' &&
      (event as any).subtype === 'status' &&
      (event as any).status === 'compacting'
    ) {
      appendMessage(runtime.snapshot, {
        id: `compaction-${runtime.snapshot.windowId}-${now()}`,
        role: 'compaction',
        text: 'Compacting context…',
        status: 'in_progress',
        updatedAt: now(),
      })
      return
    }
    if (event.type === 'system' && (event as any).subtype === 'compact_boundary') {
      const meta = (event as any).compact_metadata ?? {}
      const postTokensRaw = meta.post_tokens
      const postTokens =
        typeof postTokensRaw === 'number' && Number.isFinite(postTokensRaw) && postTokensRaw > 0
          ? Math.round(postTokensRaw)
          : null
      const existing = runtime.snapshot.messages.find(
        (m) => m.role === 'compaction' && m.status === 'in_progress',
      )
      if (existing) {
        existing.status = 'completed'
        existing.text = 'Context compacted'
        existing.updatedAt = now()
      } else {
        appendMessage(runtime.snapshot, {
          id: `compaction-${runtime.snapshot.windowId}-${now()}`,
          role: 'compaction',
          text: 'Context compacted',
          status: 'completed',
          updatedAt: now(),
        })
      }
      // The upcoming `result` event (if one comes in this same turn) reports
      // the PRE-compaction prompt size — i.e., what got sent to the API
      // before the boundary. Using it would bounce the indicator back to
      // ~100% even though the live context is now much smaller. Pin the
      // post-compaction count from compact_metadata so the indicator reflects
      // reality, and flag the result handler to skip its usage update.
      runtime.postCompactUsedTokens = postTokens
      runtime.liveContextUsageUpdatedThisTurn = true
      const window =
        runtime.snapshot.usage?.contextWindow ??
        getClaudeRequestedContextWindow(runtime.request.contextLength)
      const clamped = postTokens != null ? Math.min(postTokens, window) : null
      const existingUsage = runtime.snapshot.usage
      runtime.snapshot.usage = {
        model: existingUsage?.model ?? runtime.request.model ?? null,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        contextWindow: existingUsage?.contextWindow ?? null,
        usedTokens: clamped,
        totalProcessedTokens: postTokens,
        compactsAutomatically: existingUsage?.compactsAutomatically ?? true,
        updatedAt: now(),
      }
      log('claude.compact_boundary', {
        windowId: runtime.snapshot.windowId,
        trigger: meta.trigger ?? null,
        preTokens: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : null,
        postTokens,
      })
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
        // Prefer the exact model match; if the SDK aliased the id, fall back
        // to the entry with the largest prompt (main conversation beats any
        // sidechain/subagent usage reported alongside it).
        const entries = Object.entries(modelUsage)
        const pickEntry =
          entries.find(([key]) => key === requested) ??
          entries.sort(
            ([, a], [, b]) =>
              b.inputTokens +
              b.cacheReadInputTokens +
              b.cacheCreationInputTokens -
              (a.inputTokens + a.cacheReadInputTokens + a.cacheCreationInputTokens),
          )[0]
        if (pickEntry) {
          const [pickModel, pick] = pickEntry
          const cached = (pick.cacheReadInputTokens ?? 0) + (pick.cacheCreationInputTokens ?? 0)
          const liveUsage =
            runtime.liveContextUsageUpdatedThisTurn && runtime.snapshot.usage?.usedTokens
              ? runtime.snapshot.usage
              : null
          const freshUsage = buildUsageStats({
            model: pickModel,
            // Claude reports `inputTokens` as the NEW prompt tokens only —
            // cache reads/creations are billed in separate buckets. Fold them
            // in here so `totalProcessedTokens` reflects the full prompt size.
            inputTokens: (pick.inputTokens ?? 0) + cached,
            outputTokens: pick.outputTokens ?? 0,
            cachedInputTokens: cached,
            contextWindow: pick.contextWindow ?? null,
            compactsAutomatically: true,
          })
          // If a `compact_boundary` fired during this same turn, the SDK's
          // modelUsage reports the pre-compaction prompt size (what was
          // actually sent to the API before the boundary). Overwriting
          // usedTokens with that would flip the indicator back to ~100%
          // right after compaction. Pin the post_tokens value we captured on
          // the boundary instead, but still refresh contextWindow / model /
          // output counts so the rest of the view stays accurate.
          if (runtime.postCompactUsedTokens != null) {
            const window =
              freshUsage.contextWindow ??
              getClaudeRequestedContextWindow(runtime.request.contextLength)
            const pinned = Math.min(runtime.postCompactUsedTokens, window)
            runtime.snapshot.usage = {
              ...freshUsage,
              usedTokens: pinned,
              totalProcessedTokens:
                freshUsage.totalProcessedTokens != null && freshUsage.totalProcessedTokens > pinned
                  ? freshUsage.totalProcessedTokens
                  : runtime.postCompactUsedTokens,
            }
            runtime.postCompactUsedTokens = null
          } else if (liveUsage?.usedTokens != null && liveUsage.usedTokens > 0) {
            const window = freshUsage.contextWindow ?? liveUsage.contextWindow
            const pinned =
              window != null ? Math.min(liveUsage.usedTokens, window) : liveUsage.usedTokens
            runtime.snapshot.usage = {
              ...freshUsage,
              contextWindow: window,
              usedTokens: pinned,
              totalProcessedTokens:
                freshUsage.totalProcessedTokens != null && freshUsage.totalProcessedTokens > pinned
                  ? freshUsage.totalProcessedTokens
                  : liveUsage.totalProcessedTokens != null &&
                      liveUsage.totalProcessedTokens > pinned
                    ? liveUsage.totalProcessedTokens
                    : null,
            }
          } else {
            runtime.snapshot.usage = freshUsage
          }
          runtime.liveContextUsageUpdatedThisTurn = false
          log('claude.usage', {
            windowId: runtime.snapshot.windowId,
            requested,
            picked: pickModel,
            inputTokens: runtime.snapshot.usage.inputTokens,
            outputTokens: runtime.snapshot.usage.outputTokens,
            usedTokens: runtime.snapshot.usage.usedTokens,
            totalProcessedTokens: runtime.snapshot.usage.totalProcessedTokens,
            contextWindow: runtime.snapshot.usage.contextWindow,
            modelCount: entries.length,
          })
        }
      } else {
        log('claude.usage.missing', { windowId: runtime.snapshot.windowId })
      }
      runtime.liveContextUsageUpdatedThisTurn = false
      runtime.postCompactUsedTokens = null
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
      // Auto-continue if the SDK bailed mid-agentic-loop. The Claude SDK
      // emits `terminal_reason: 'max_turns'` when its internal tool-call
      // loop hits the cap, and `stop_reason: 'pause_turn'` is how adaptive
      // thinking chunks long reasoning — in either case the model wanted
      // to keep going. We silently resubmit a "continue" turn up to
      // `CLAUDE_AUTO_CONTINUE_CAP` times per user message so a single
      // complex request doesn't grind to a halt. Any real send() resets
      // the counter; a user-initiated close() flips `runtime.closed` so
      // we don't fight the stop button.
      const terminalReason = (event as any).terminal_reason as string | undefined
      const stopReason = (event as any).stop_reason as string | null | undefined
      const shouldAutoContinue =
        !runtime.closed &&
        (terminalReason === 'max_turns' || stopReason === 'pause_turn') &&
        runtime.autoContinueCount < CLAUDE_AUTO_CONTINUE_CAP
      if (shouldAutoContinue) {
        runtime.autoContinueCount += 1
        log('claude.auto-continue', {
          windowId: runtime.snapshot.windowId,
          attempt: runtime.autoContinueCount,
          terminalReason: terminalReason ?? null,
          stopReason: stopReason ?? null,
        })
        // Microtask so the current result-event handler finishes
        // (status → idle, emitUpdate) before the next turn flips it back
        // to running. Avoids a visible flicker and lets schedulePersist
        // checkpoint the in-between state.
        queueMicrotask(() => {
          void this.autoContinueClaude(runtime)
        })
      }
    }
  }

  /** Re-arm the Claude session with a minimal "continue" prompt when the
   *  agentic loop stopped prematurely (max_turns / pause_turn). Bypasses
   *  `send()` so we don't append a visible user bubble — the resumption
   *  should feel like the original turn just kept going. */
  private async autoContinueClaude(runtime: ClaudeRuntime): Promise<void> {
    if (runtime.closed) return
    runtime.snapshot.status = 'running'
    runtime.snapshot.error = null
    this.emitUpdate(runtime.snapshot)
    try {
      await runtime.session.send('continue')
    } catch (err) {
      log('claude.auto-continue.error', {
        windowId: runtime.snapshot.windowId,
        error: err instanceof Error ? err.message : String(err),
      })
      runtime.snapshot.status = 'idle'
      this.emitUpdate(runtime.snapshot)
    }
  }
}
