import { useEffect, useState } from 'react'
import {
  Brain,
  Check,
  ChevronDown,
  Gauge,
  Infinity as InfinityIcon,
  Shield,
  ShieldCheck,
  ShieldOff,
  Zap,
} from 'lucide-react'
import type {
  AgentContextLength,
  AgentPermissionMode,
  AgentThinkingLevel,
  AgentUsageStats,
  AgentWindowNode,
} from '@/types'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { resolveAgentModelId } from '@/lib/agent-model-selection'
import { cn } from '@/lib/utils'

// Copied and adapted from Craft Agents OSS:
// ../craft-agents-oss/apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx
// ../craft-agents-oss/apps/electron/src/renderer/components/app-shell/input/CompactPermissionModeSelector.tsx

interface ModelOption {
  id: string
  label: string
  hint?: string
  isDefault?: boolean
  available?: boolean
  /** Effort values the model actually accepts (subset of AgentThinkingLevel). */
  supportedEfforts: AgentThinkingLevel[]
  /** Effort the SDK picks when the caller doesn't specify one. */
  defaultEffort: AgentThinkingLevel
  /** Per-effort human description (shown in the sub-list). */
  effortHints?: Partial<Record<AgentThinkingLevel, string>>
}

// Fallback used before the live `claude` Agent-SDK `supportedModels()` call
// resolves (or if it fails — CLI not installed, not logged in, offline).
// Mirrors what the SDK returns for each model today; Haiku reports no
// `supportsEffort` so its supportedEfforts list is empty (thinking picker
// hides for that model).
const CLAUDE_MODELS_FALLBACK: ModelOption[] = [
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    hint: 'Most capable for complex work',
    supportedEfforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    hint: 'Best for everyday tasks',
    supportedEfforts: ['off', 'low', 'medium', 'high', 'max'],
    defaultEffort: 'medium',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    hint: 'Fastest for quick answers',
    supportedEfforts: [],
    defaultEffort: 'off',
  },
]

// Process-level cache so opening a second Claude window doesn't respawn the
// CLI just to re-query the same catalog.
let claudeModelsCache: ModelOption[] | null = null
let claudeModelsPromise: Promise<ModelOption[]> | null = null

// Prettify a Claude model id into a picker label when the SDK doesn't
// provide a displayName. Turns "claude-opus-4-7" into "Opus 4.7",
// "claude-haiku-4-5-20251001" into "Haiku 4.5".
function prettifyClaudeModel(raw: string): string {
  const s = raw.trim()
  if (/[A-Z]/.test(s)) return s
  const stripped = s.replace(/^claude-/i, '')
  // Tier name up to the first version segment: "opus-4-7-something" → "opus"
  const m = stripped.match(/^([a-z]+)-?(\d[\d-]*)?/i)
  if (!m) return stripped
  const tier = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  const version = m[2] ? ' ' + m[2].replace(/-/g, '.').replace(/\.0+$/, '') : ''
  return (tier + version).trim()
}

// Normalises a raw effort string from the SDK's
// `ModelInfo.supportedEffortLevels` onto our portable `AgentThinkingLevel`
// union. Kept as a string-in / union-out filter so any future CLI-only
// additions pass through without a type-level edit.
function claudeEffortToLevel(effort: string): AgentThinkingLevel | null {
  switch (effort) {
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
    case 'xhigh':
      return effort as AgentThinkingLevel
    default:
      return null
  }
}

function fetchClaudeModels(): Promise<ModelOption[]> {
  if (claudeModelsCache) return Promise.resolve(claudeModelsCache)
  if (claudeModelsPromise) return claudeModelsPromise
  const api = (window as any).cells?.agentSession?.listClaudeModels
  if (typeof api !== 'function') return Promise.resolve(CLAUDE_MODELS_FALLBACK)
  claudeModelsPromise = (
    api() as Promise<
      Array<{
        id: string
        displayName: string
        description: string
        supportsEffort: boolean
        supportedEffortLevels: string[]
        supportsAdaptiveThinking: boolean
      }>
    >
  )
    .then((list) => {
      if (!Array.isArray(list) || list.length === 0) return CLAUDE_MODELS_FALLBACK
      const mapped = list.map<ModelOption>((m) => {
        const efforts = (m.supportedEffortLevels || [])
          .map(claudeEffortToLevel)
          .filter((v): v is AgentThinkingLevel => v != null)
        // Models without `supportsEffort` (Haiku today) expose no effort
        // knobs, so we leave supportedEfforts empty and the ThinkingPicker
        // hides itself. For models that do support effort we prepend 'off'
        // (maps to `thinking: { type: 'disabled' }` — the SDK never lists
        // it in `supportedEffortLevels`).
        const supportedEfforts: AgentThinkingLevel[] =
          m.supportsEffort && efforts.length > 0 ? ['off', ...efforts] : []
        const defaultEffort: AgentThinkingLevel = efforts.includes('medium')
          ? 'medium'
          : (efforts[0] ?? 'off')
        // The SDK sometimes returns a generic displayName like
        // "Default (recommended)" for aliased entries — prefer the concrete
        // model id prettified so the picker shows "Opus 4.7" rather than
        // the opaque alias label.
        const isGenericDisplayName =
          !m.displayName || /\b(default|recommended)\b/i.test(m.displayName)
        const label = isGenericDisplayName
          ? prettifyClaudeModel(m.id)
          : prettifyClaudeModel(m.displayName)
        return {
          id: m.id,
          label,
          hint: m.description || undefined,
          available: true,
          supportedEfforts,
          defaultEffort,
        }
      })
      // Filter out generic alias entries (id = "default" etc.) when concrete
      // named models are also present — the alias adds no picker value.
      const named = mapped.filter((m) => !/\bdefault\b/i.test(m.id))
      const liveList = named.length > 0 ? named : mapped

      // Extract the tier (opus/sonnet/haiku) from a model id so we can match
      // fallback slots to live entries even when the SDK returns versioned or
      // date-suffixed ids like "claude-sonnet-4-6-20250514".
      const tierOf = (id: string) =>
        id
          .replace(/^claude-/i, '')
          .split('-')[0]
          .toLowerCase()

      // Build two lookup tables: exact id → live model, tier → first live model
      const liveById = new Map(liveList.map((m) => [m.id, m]))
      const liveByTier = new Map<string, ModelOption>()
      for (const m of liveList) {
        const t = tierOf(m.id)
        if (!liveByTier.has(t)) liveByTier.set(t, m)
      }

      // Fallback defines canonical ordering. Prefer exact-id match, then
      // tier match (avoids duplicates when SDK uses versioned ids), then
      // keep the fallback entry visible-but-disabled so unsupported models
      // never become the implicit current selection.
      const usedLiveIds = new Set<string>()
      const merged = CLAUDE_MODELS_FALLBACK.map((fb) => {
        const byId = liveById.get(fb.id)
        if (byId) {
          usedLiveIds.add(byId.id)
          return byId
        }
        const byTier = liveByTier.get(tierOf(fb.id))
        if (byTier) {
          usedLiveIds.add(byTier.id)
          return byTier
        }
        return { ...fb, available: false }
      })

      // Append live models not already slotted into a fallback position.
      // Filter by id (not tier) so variants like "Sonnet (1M context)" still
      // appear even when the base sonnet slot was already filled.
      const extras = liveList.filter((m) => !usedLiveIds.has(m.id))
      claudeModelsCache = [...merged, ...extras]
      return claudeModelsCache
    })
    .catch(() => {
      claudeModelsCache = CLAUDE_MODELS_FALLBACK
      return claudeModelsCache
    })
    .finally(() => {
      claudeModelsPromise = null
    }) as Promise<ModelOption[]>
  return claudeModelsPromise
}

// Fallback used before the live `codex app-server` `model/list` call resolves.
const CODEX_MODELS_FALLBACK: ModelOption[] = [
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    hint: 'Strong model for everyday coding.',
    isDefault: true,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    hint: 'Frontier model for complex coding, research, and real-world work.',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    hint: 'Small, fast, and cost-efficient model for simpler coding tasks.',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    hint: 'Coding-optimized model.',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',
    hint: 'Ultra-fast coding model.',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    id: 'gpt-5.2',
    label: 'GPT-5.2',
    hint: 'Optimized for professional work and long-running agents.',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
]

// Process-level cache so opening a second Codex window doesn't respawn the
// app-server just to ask the same question.
let codexModelsCache: ModelOption[] | null = null
let codexModelsPromise: Promise<ModelOption[]> | null = null
const CURSOR_MODELS_FALLBACK: ModelOption[] = [
  {
    id: 'auto',
    label: 'Auto',
    hint: 'Cursor account default',
    isDefault: true,
    supportedEfforts: [],
    defaultEffort: 'off',
  },
  {
    id: 'sonnet-4',
    label: 'Sonnet 4',
    hint: 'Claude Sonnet through Cursor',
    supportedEfforts: [],
    defaultEffort: 'off',
  },
]
let cursorModelsCache: ModelOption[] | null = null
let cursorModelsPromise: Promise<ModelOption[]> | null = null

const COPILOT_MODELS_FALLBACK: ModelOption[] = [
  {
    id: 'auto',
    label: 'Auto',
    hint: 'GitHub Copilot account default',
    isDefault: true,
    supportedEfforts: [],
    defaultEffort: 'off',
  },
]
let copilotModelsCache: ModelOption[] | null = null
let copilotModelsPromise: Promise<ModelOption[]> | null = null

const OPENCODE_MODELS_FALLBACK: ModelOption[] = [
  {
    id: 'opencode/gpt-5-nano',
    label: 'GPT-5 Nano',
    hint: 'OpenCode default',
    isDefault: true,
    supportedEfforts: ['off', 'low', 'medium', 'high', 'max'],
    defaultEffort: 'medium',
  },
]
let opencodeModelsCache: ModelOption[] | null = null
let opencodeModelsPromise: Promise<ModelOption[]> | null = null

// Prettify a Codex model id/displayName into a picker label. The CLI often
// returns displayName equal to id (e.g. "gpt-5.4", "gpt-5.2-codex"); we
// title-case the `gpt-` prefix and the `-codex` / `-mini` suffixes so the
// trigger reads "GPT-5.4", "GPT-5.2 Codex" instead of the raw id.
function prettifyCodexModel(raw: string): string {
  const s = raw.trim()
  // If the CLI already returned a Cased label, keep it.
  if (/[A-Z]/.test(s)) return s
  return s
    .replace(/^gpt-/i, 'GPT-')
    .replace(/-codex(-[a-z]+)?/gi, (_m, tail) => ' Codex' + (tail ? ' ' + tail.slice(1) : ''))
    .replace(/-mini\b/gi, ' Mini')
    .replace(/-spark\b/gi, ' Spark')
    .replace(/-max\b/gi, ' Max')
    .replace(/\s+/g, ' ')
    .trim()
}

function prettifyCursorModel(raw: string): string {
  const s = raw.trim()
  if (/[A-Z]/.test(s)) return s
  return s
    .replace(/^gpt-/i, 'GPT-')
    .replace(/^claude-/i, 'Claude ')
    .replace(/^sonnet-/i, 'Sonnet ')
    .replace(/^opus-/i, 'Opus ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/^GPT /, 'GPT-')
    .trim()
}

function prettifyCopilotModel(raw: string): string {
  const s = raw.trim()
  if (/[A-Z]/.test(s)) return s
  return s
    .replace(/^gpt-/i, 'GPT-')
    .replace(/^claude-/i, 'Claude ')
    .replace(/sonnet-/i, 'Sonnet ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/^GPT /, 'GPT-')
    .trim()
}

function prettifyOpencodeModel(raw: string): string {
  const providerless = raw.includes('/') ? raw.split('/').slice(1).join('/') : raw
  return prettifyCodexModel(providerless)
}

// Maps the Codex CLI's reasoning-effort strings onto Cells's portable
// `AgentThinkingLevel`. 'minimal' → 'off'; 'xhigh' stays 'xhigh' (Codex's
// top level — distinct from Claude's 'max').
function codexEffortToLevel(effort: string): AgentThinkingLevel {
  switch (effort) {
    case 'minimal':
      return 'off'
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return effort
    default:
      return 'medium'
  }
}

function fetchCodexModels(): Promise<ModelOption[]> {
  if (codexModelsCache) return Promise.resolve(codexModelsCache)
  if (codexModelsPromise) return codexModelsPromise
  const api = (window as any).cells?.agentSession?.listCodexModels
  if (typeof api !== 'function') return Promise.resolve(CODEX_MODELS_FALLBACK)
  codexModelsPromise = (
    api() as Promise<
      Array<{
        id: string
        displayName: string
        description: string
        isDefault: boolean
        hidden: boolean
        supportedReasoningEfforts: Array<{ effort: string; description: string }>
        defaultReasoningEffort: string
      }>
    >
  )
    .then((list) => {
      const mapped = list
        .filter((m) => !m.hidden)
        .map<ModelOption>((m) => {
          const efforts: AgentThinkingLevel[] = (m.supportedReasoningEfforts || []).map((r) =>
            codexEffortToLevel(r.effort),
          )
          const effortHints: Partial<Record<AgentThinkingLevel, string>> = {}
          for (const r of m.supportedReasoningEfforts || []) {
            const lvl = codexEffortToLevel(r.effort)
            if (r.description) effortHints[lvl] = r.description
          }
          return {
            id: m.id,
            label: prettifyCodexModel(m.displayName || m.id),
            hint: m.description || undefined,
            isDefault: !!m.isDefault,
            supportedEfforts: efforts.length > 0 ? efforts : ['low', 'medium', 'high', 'xhigh'],
            defaultEffort: codexEffortToLevel(m.defaultReasoningEffort || 'medium'),
            effortHints,
          }
        })
      codexModelsCache =
        mapped.length > 0
          ? [...mapped].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault))
          : CODEX_MODELS_FALLBACK
      return codexModelsCache
    })
    .catch(() => {
      codexModelsCache = CODEX_MODELS_FALLBACK
      return codexModelsCache
    })
    .finally(() => {
      codexModelsPromise = null
    }) as Promise<ModelOption[]>
  return codexModelsPromise
}

function fetchCursorModels(): Promise<ModelOption[]> {
  if (cursorModelsCache) return Promise.resolve(cursorModelsCache)
  if (cursorModelsPromise) return cursorModelsPromise
  const api = (window as any).cells?.agentSession?.listCursorModels
  if (typeof api !== 'function') return Promise.resolve(CURSOR_MODELS_FALLBACK)
  cursorModelsPromise = (
    api() as Promise<
      Array<{
        id: string
        displayName: string
        description: string
        variants?: Array<{ displayName: string; description?: string; isDefault?: boolean }>
      }>
    >
  )
    .then((list) => {
      const mapped = list.map<ModelOption>((m) => {
        const defaultVariant = m.variants?.find((variant) => variant.isDefault)
        return {
          id: m.id,
          label: prettifyCursorModel(m.displayName || m.id),
          hint: defaultVariant?.description || m.description || undefined,
          isDefault: Boolean(defaultVariant?.isDefault),
          supportedEfforts: [],
          defaultEffort: 'off',
        }
      })
      cursorModelsCache =
        mapped.length > 0
          ? [...mapped].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault))
          : CURSOR_MODELS_FALLBACK
      return cursorModelsCache
    })
    .catch(() => {
      cursorModelsCache = CURSOR_MODELS_FALLBACK
      return cursorModelsCache
    })
    .finally(() => {
      cursorModelsPromise = null
    }) as Promise<ModelOption[]>
  return cursorModelsPromise
}

function fetchCopilotModels(): Promise<ModelOption[]> {
  if (copilotModelsCache) return Promise.resolve(copilotModelsCache)
  if (copilotModelsPromise) return copilotModelsPromise
  const api = (window as any).cells?.agentSession?.listCopilotModels
  if (typeof api !== 'function') return Promise.resolve(COPILOT_MODELS_FALLBACK)
  copilotModelsPromise = (
    api() as Promise<
      Array<{
        id: string
        displayName: string
        description: string
        isDefault: boolean
        hidden: boolean
        supportedReasoningEfforts: string[]
        defaultReasoningEffort: string
      }>
    >
  )
    .then((list) => {
      const mapped = list
        .filter((m) => !m.hidden)
        .map<ModelOption>((m) => {
          const efforts = (m.supportedReasoningEfforts || [])
            .map(claudeEffortToLevel)
            .filter((value): value is AgentThinkingLevel => value != null)
          return {
            id: m.id,
            label: prettifyCopilotModel(m.displayName || m.id),
            hint: m.description || undefined,
            isDefault: Boolean(m.isDefault || m.id === 'auto'),
            supportedEfforts: efforts,
            defaultEffort:
              claudeEffortToLevel(m.defaultReasoningEffort || '') ?? efforts[0] ?? 'off',
          }
        })
      copilotModelsCache =
        mapped.length > 0
          ? [...mapped].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault))
          : COPILOT_MODELS_FALLBACK
      return copilotModelsCache
    })
    .catch(() => {
      copilotModelsCache = COPILOT_MODELS_FALLBACK
      return copilotModelsCache
    })
    .finally(() => {
      copilotModelsPromise = null
    }) as Promise<ModelOption[]>
  return copilotModelsPromise
}

function fetchOpencodeModels(): Promise<ModelOption[]> {
  if (opencodeModelsCache) return Promise.resolve(opencodeModelsCache)
  if (opencodeModelsPromise) return opencodeModelsPromise
  const api = (window as any).cells?.agentSession?.listOpencodeModels
  if (typeof api !== 'function') return Promise.resolve(OPENCODE_MODELS_FALLBACK)
  opencodeModelsPromise = (
    api() as Promise<
      Array<{
        id: string
        displayName: string
        description: string
        isDefault: boolean
        hidden: boolean
        supportedReasoningEfforts: string[]
        defaultReasoningEffort: string
      }>
    >
  )
    .then((list) => {
      const mapped = list
        .filter((m) => !m.hidden)
        .map<ModelOption>((m) => {
          const efforts = (m.supportedReasoningEfforts || [])
            .map((effort) => (effort === 'minimal' ? 'off' : effort))
            .filter((value): value is AgentThinkingLevel =>
              ['off', 'low', 'medium', 'high', 'max', 'xhigh'].includes(value),
            )
          return {
            id: m.id,
            label: prettifyOpencodeModel(m.displayName || m.id),
            hint: m.description || undefined,
            isDefault: Boolean(m.isDefault),
            supportedEfforts:
              efforts.length > 0 ? efforts : ['off', 'low', 'medium', 'high', 'max'],
            defaultEffort:
              ((m.defaultReasoningEffort === 'minimal'
                ? 'off'
                : m.defaultReasoningEffort) as AgentThinkingLevel) || 'medium',
          }
        })
      opencodeModelsCache =
        mapped.length > 0
          ? [...mapped].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault))
          : OPENCODE_MODELS_FALLBACK
      return opencodeModelsCache
    })
    .catch(() => {
      opencodeModelsCache = OPENCODE_MODELS_FALLBACK
      return opencodeModelsCache
    })
    .finally(() => {
      opencodeModelsPromise = null
    }) as Promise<ModelOption[]>
  return opencodeModelsPromise
}

const DEFAULT_MODEL: Record<AgentWindowNode['agent'], string> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5-codex',
  cursor: 'auto',
  copilot: 'auto',
  opencode: 'opencode/gpt-5-nano',
}

function findModel(
  models: ModelOption[],
  agent: AgentWindowNode['agent'],
  id: string | null | undefined,
) {
  const resolvedId = resolveAgentModelId(agent, id, models, DEFAULT_MODEL[agent])
  return models.find((m) => m.id === resolvedId) ?? models[0]
}

function resolveModelThinkingLevel(
  model: ModelOption | undefined,
  requested: AgentThinkingLevel | null | undefined,
): AgentThinkingLevel | null {
  const efforts = model?.supportedEfforts ?? []
  if (efforts.length === 0) return null
  return requested && efforts.includes(requested) ? requested : (model?.defaultEffort ?? efforts[0])
}

export const THINKING_LEVEL_LABEL_MAP: Record<AgentThinkingLevel, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
  xhigh: 'Extra-high',
}

export function prettifyModelId(agent: AgentWindowNode['agent'], id: string): string {
  if (agent === 'codex') return prettifyCodexModel(id)
  if (agent === 'cursor') return prettifyCursorModel(id)
  if (agent === 'copilot') return prettifyCopilotModel(id)
  if (agent === 'opencode') return prettifyOpencodeModel(id)
  return prettifyClaudeModel(id)
}

// Returns the currently-known model list synchronously — uses the live cache
// when populated, otherwise the hard-coded fallback. Keyboard-shortcut cycling
// has no time to await the SDK, so we cycle through whatever we know right
// now and rely on the picker to stay in sync once the fetch lands.
function getCachedModelsSync(agent: AgentWindowNode['agent']): ModelOption[] {
  if (agent === 'codex') return codexModelsCache ?? CODEX_MODELS_FALLBACK
  if (agent === 'cursor') return cursorModelsCache ?? CURSOR_MODELS_FALLBACK
  if (agent === 'copilot') return copilotModelsCache ?? COPILOT_MODELS_FALLBACK
  if (agent === 'opencode') return opencodeModelsCache ?? OPENCODE_MODELS_FALLBACK
  return claudeModelsCache ?? CLAUDE_MODELS_FALLBACK
}

export function resolveAgentPickerModelId(
  agent: AgentWindowNode['agent'],
  modelId: string | null | undefined,
): string | null {
  return findModel(getCachedModelsSync(agent), agent, modelId)?.id ?? null
}

export function resolveThinkingLevelForModel(
  agent: AgentWindowNode['agent'],
  modelId: string | null | undefined,
  requested: AgentThinkingLevel | null | undefined,
): AgentThinkingLevel | null {
  return resolveModelThinkingLevel(findModel(getCachedModelsSync(agent), agent, modelId), requested)
}

export function cycleAgentModel(
  agent: AgentWindowNode['agent'],
  currentId: string | null | undefined,
  direction: 1 | -1 = 1,
): string | null {
  const models = getCachedModelsSync(agent).filter((m) => m.available !== false)
  if (models.length === 0) return null
  const resolved = resolveAgentModelId(agent, currentId, models, DEFAULT_MODEL[agent])
  const idx = models.findIndex((m) => m.id === resolved)
  const safeIdx = idx < 0 ? 0 : idx
  const next = models[(safeIdx + direction + models.length) % models.length]
  return next.id
}

export function cycleThinkingLevel(
  agent: AgentWindowNode['agent'],
  modelId: string | null | undefined,
  currentLevel: AgentThinkingLevel | null | undefined,
  direction: 1 | -1 = 1,
): AgentThinkingLevel | null {
  const models = getCachedModelsSync(agent)
  const model = findModel(models, agent, modelId)
  const efforts = model.supportedEfforts
  if (efforts.length === 0) return null
  const effective: AgentThinkingLevel =
    currentLevel && efforts.includes(currentLevel) ? currentLevel : model.defaultEffort
  const idx = efforts.indexOf(effective)
  const safeIdx = idx < 0 ? 0 : idx
  return efforts[(safeIdx + direction + efforts.length) % efforts.length]
}

export function cyclePermissionMode(
  current: AgentPermissionMode | null | undefined,
  direction: 1 | -1 = 1,
): AgentPermissionMode {
  const coerced = coerceLegacyPermissionMode(current as any)
  const idx = PERMISSION_MODE_OPTIONS.findIndex((m) => m.id === coerced)
  const safeIdx = idx < 0 ? 0 : idx
  const len = PERMISSION_MODE_OPTIONS.length
  return PERMISSION_MODE_OPTIONS[(safeIdx + direction + len) % len].id
}

const THINKING_LEVEL_LABEL = THINKING_LEVEL_LABEL_MAP

const THINKING_FALLBACK_HINT: Record<AgentThinkingLevel, string> = {
  off: 'No extended reasoning',
  low: 'Light reasoning pass',
  medium: 'Balanced speed and depth',
  high: 'Deep reasoning for complex tasks',
  max: 'Maximum effort reasoning',
  xhigh: 'Extra-high effort reasoning',
}

// Matches Claude Sonnet 4 / 4.5 ids — the only models that accept the
// context-1m beta flag. Opus / Haiku / Codex all ignore it.
function modelSupportsExtendedContext(
  agent: AgentWindowNode['agent'],
  modelId: string | null | undefined,
): boolean {
  if (agent !== 'claude' || !modelId) return false
  return /^claude-sonnet-4/i.test(modelId)
}

interface ModelPickerProps {
  agent: AgentWindowNode['agent']
  value: string | null | undefined
  contextLength?: AgentContextLength | null | undefined
  onChange: (value: string) => void
  onContextLengthChange?: (value: AgentContextLength) => void
}

// Model-only picker. Thinking has its own popover (see `ThinkingPicker`) so
// the two controls can live side-by-side in the composer toolbar. For Claude
// Sonnet 4/4.5 the popover also exposes a "1M context window" toggle that
// wires through to the context-1m-2025-08-07 beta flag on the backend.
export function ModelPicker({
  agent,
  value,
  contextLength,
  onChange,
  onContextLengthChange,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [codexModels, setCodexModels] = useState<ModelOption[]>(
    () => codexModelsCache ?? CODEX_MODELS_FALLBACK,
  )
  const [claudeModels, setClaudeModels] = useState<ModelOption[]>(
    () => claudeModelsCache ?? CLAUDE_MODELS_FALLBACK,
  )
  const [cursorModels, setCursorModels] = useState<ModelOption[]>(
    () => cursorModelsCache ?? CURSOR_MODELS_FALLBACK,
  )
  const [copilotModels, setCopilotModels] = useState<ModelOption[]>(
    () => copilotModelsCache ?? COPILOT_MODELS_FALLBACK,
  )
  const [opencodeModels, setOpencodeModels] = useState<ModelOption[]>(
    () => opencodeModelsCache ?? OPENCODE_MODELS_FALLBACK,
  )
  useEffect(() => {
    let cancelled = false
    if (agent === 'codex') {
      void fetchCodexModels().then((list) => {
        if (!cancelled) setCodexModels(list)
      })
    } else if (agent === 'cursor') {
      void fetchCursorModels().then((list) => {
        if (!cancelled) setCursorModels(list)
      })
    } else if (agent === 'copilot') {
      void fetchCopilotModels().then((list) => {
        if (!cancelled) setCopilotModels(list)
      })
    } else if (agent === 'opencode') {
      void fetchOpencodeModels().then((list) => {
        if (!cancelled) setOpencodeModels(list)
      })
    } else {
      void fetchClaudeModels().then((list) => {
        if (!cancelled) setClaudeModels(list)
      })
    }
    return () => {
      cancelled = true
    }
  }, [agent])
  const models =
    agent === 'claude'
      ? claudeModels
      : agent === 'cursor'
        ? cursorModels
        : agent === 'copilot'
          ? copilotModels
          : agent === 'opencode'
            ? opencodeModels
            : codexModels
  const current = findModel(models, agent, value)
  const supportsExtended = modelSupportsExtendedContext(agent, current.id)
  const isExtended = supportsExtended && contextLength === 'extended'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-[8px] bg-foreground/5 px-2 text-[11px] text-foreground/85 transition-colors hover:bg-foreground/10"
            title={isExtended ? `Model: ${current.label} · 1M context` : `Model: ${current.label}`}
          >
            <span className="truncate font-medium">{current.label}</span>
            {isExtended ? (
              <span
                className="inline-flex items-center gap-0.5 rounded-[4px] bg-sky-400/15 px-1 py-px text-[9.5px] font-semibold text-sky-300"
                title="1M context window (Sonnet beta)"
              >
                <InfinityIcon className="size-2.5" />
                1M
              </span>
            ) : null}
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        }
      />
      <PopoverContent align="start" side="top" sideOffset={6} className="w-64 p-1">
        <div className="mb-1 flex items-center justify-between gap-2 px-2 pt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
          <span>
            {agent === 'claude'
              ? 'Claude models'
              : agent === 'cursor'
                ? 'Cursor models'
                : agent === 'copilot'
                  ? 'Copilot models'
                  : agent === 'opencode'
                    ? 'OpenCode models'
                    : 'Codex models'}
          </span>
          <ShortcutHint keys={['Ctrl', 'M']} />
        </div>
        {models.map((model) => {
          const active = model.id === current.id
          const unavailable = model.available === false
          return (
            <button
              key={model.id}
              type="button"
              disabled={unavailable}
              onClick={() => {
                onChange(model.id)
                // Moving to a model that doesn't support the 1M beta — drop
                // the extended flag so we don't send an unknown beta header
                // on the next session.
                if (
                  onContextLengthChange &&
                  contextLength === 'extended' &&
                  !modelSupportsExtendedContext(agent, model.id)
                ) {
                  onContextLengthChange('default')
                }
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12px] transition-colors',
                unavailable
                  ? 'cursor-not-allowed opacity-50'
                  : active
                    ? 'bg-foreground/8 text-foreground'
                    : 'hover:bg-foreground/5 text-foreground/90',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{model.label}</div>
                {model.hint || unavailable ? (
                  <div className="truncate text-[10.5px] text-muted-foreground/70">
                    {unavailable ? 'Unavailable in the current CLI/account' : model.hint}
                  </div>
                ) : null}
              </div>
              {active ? <Check className="mt-0.5 size-3.5 text-foreground" /> : null}
            </button>
          )
        })}
        {supportsExtended && onContextLengthChange ? (
          <>
            <div className="my-1 h-px bg-border/60" />
            <div className="mb-1 flex items-center gap-1.5 px-2 pt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
              <InfinityIcon className="size-3 text-sky-300/80" />
              Context window
            </div>
            {[
              {
                id: 'default' as const,
                label: '200k (standard)',
                hint: 'Normal context — fastest, cheapest.',
              },
              {
                id: 'extended' as const,
                label: '1M (beta)',
                hint: 'Anthropic context-1m beta. Applies on next send — session reopens.',
              },
            ].map((opt) => {
              const active = (contextLength ?? 'default') === opt.id
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    onContextLengthChange(opt.id)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12px] transition-colors',
                    active
                      ? 'bg-foreground/8 text-foreground'
                      : 'hover:bg-foreground/5 text-foreground/90',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{opt.label}</div>
                    <div className="truncate text-[10.5px] text-muted-foreground/70">
                      {opt.hint}
                    </div>
                  </div>
                  {active ? <Check className="mt-0.5 size-3.5 text-foreground" /> : null}
                </button>
              )
            })}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

interface ThinkingPickerProps {
  agent: AgentWindowNode['agent']
  model: string | null | undefined
  value: AgentThinkingLevel | null | undefined
  onChange: (value: AgentThinkingLevel) => void
}

// Standalone thinking-effort picker. Scoped to the CURRENT model's
// `supportedEfforts` (pulled from the Codex app-server `model/list` response
// and the Claude Agent SDK `ModelInfo.supportedEffortLevels`).
export function ThinkingPicker({ agent, model, value, onChange }: ThinkingPickerProps) {
  const [open, setOpen] = useState(false)
  const [codexModels, setCodexModels] = useState<ModelOption[]>(
    () => codexModelsCache ?? CODEX_MODELS_FALLBACK,
  )
  const [claudeModels, setClaudeModels] = useState<ModelOption[]>(
    () => claudeModelsCache ?? CLAUDE_MODELS_FALLBACK,
  )
  const [cursorModels, setCursorModels] = useState<ModelOption[]>(
    () => cursorModelsCache ?? CURSOR_MODELS_FALLBACK,
  )
  const [copilotModels, setCopilotModels] = useState<ModelOption[]>(
    () => copilotModelsCache ?? COPILOT_MODELS_FALLBACK,
  )
  const [opencodeModels, setOpencodeModels] = useState<ModelOption[]>(
    () => opencodeModelsCache ?? OPENCODE_MODELS_FALLBACK,
  )
  useEffect(() => {
    let cancelled = false
    if (agent === 'codex') {
      void fetchCodexModels().then((list) => {
        if (!cancelled) setCodexModels(list)
      })
    } else if (agent === 'cursor') {
      void fetchCursorModels().then((list) => {
        if (!cancelled) setCursorModels(list)
      })
    } else if (agent === 'copilot') {
      void fetchCopilotModels().then((list) => {
        if (!cancelled) setCopilotModels(list)
      })
    } else if (agent === 'opencode') {
      void fetchOpencodeModels().then((list) => {
        if (!cancelled) setOpencodeModels(list)
      })
    } else {
      void fetchClaudeModels().then((list) => {
        if (!cancelled) setClaudeModels(list)
      })
    }
    return () => {
      cancelled = true
    }
  }, [agent])
  const models =
    agent === 'claude'
      ? claudeModels
      : agent === 'cursor'
        ? cursorModels
        : agent === 'copilot'
          ? copilotModels
          : agent === 'opencode'
            ? opencodeModels
            : codexModels
  const current = findModel(models, agent, model)
  const effective = resolveModelThinkingLevel(current, value)
  if (current.supportedEfforts.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-[8px] bg-foreground/5 px-2 text-[11px] text-foreground/85 transition-colors hover:bg-foreground/10"
            title={`Thinking: ${THINKING_LEVEL_LABEL[effective ?? current.defaultEffort]}`}
          >
            <Brain className="size-3 text-violet-300/90" />
            <span className="truncate font-medium">
              {THINKING_LEVEL_LABEL[effective ?? current.defaultEffort]}
            </span>
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        }
      />
      <PopoverContent align="start" side="top" sideOffset={6} className="w-60 p-1">
        <div className="mb-1 flex items-center justify-between gap-2 px-2 pt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
          <span className="flex items-center gap-1.5">
            <Brain className="size-3 text-violet-300/80" />
            Thinking
          </span>
          <ShortcutHint keys={['Ctrl', 'T']} />
        </div>
        {current.supportedEfforts.map((level) => {
          const active = level === effective
          const hint = current.effortHints?.[level] ?? THINKING_FALLBACK_HINT[level]
          return (
            <button
              key={level}
              type="button"
              onClick={() => {
                onChange(level)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12px] transition-colors',
                active
                  ? 'bg-foreground/8 text-foreground'
                  : 'hover:bg-foreground/5 text-foreground/90',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{THINKING_LEVEL_LABEL[level]}</div>
                {hint ? (
                  <div className="truncate text-[10.5px] text-muted-foreground/70">{hint}</div>
                ) : null}
              </div>
              {active ? <Check className="mt-0.5 size-3.5 text-foreground" /> : null}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

interface FastModeToggleProps {
  agent: AgentWindowNode['agent']
  value: boolean | null | undefined
  onChange: (value: boolean) => void
}

export function FastModeToggle({ agent, value, onChange }: FastModeToggleProps) {
  if (agent !== 'codex') return null
  const active = value === true
  return (
    <button
      type="button"
      onClick={() => onChange(!active)}
      className={cn(
        'inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-[11px] transition-colors',
        active
          ? 'bg-emerald-400/14 text-emerald-100 ring-1 ring-emerald-300/20 hover:bg-emerald-400/18'
          : 'bg-foreground/5 text-foreground/85 hover:bg-foreground/10',
      )}
      title={
        active
          ? 'Fast mode on: Codex uses low reasoning effort on each turn'
          : 'Fast mode off: Codex uses the selected thinking effort'
      }
      aria-pressed={active}
    >
      <Zap className={cn('size-3.5', active ? 'text-emerald-300' : 'text-muted-foreground/75')} />
      <span className="truncate font-medium">Fast</span>
    </button>
  )
}

interface ContextUsageIndicatorProps {
  usage: AgentUsageStats | null | undefined
  agent: AgentWindowNode['agent']
  contextLength: AgentContextLength | null | undefined
}

// Known-at-design-time context windows used when `usage.contextWindow` isn't
// available yet (pre-first-turn). Real value comes from the SDK after the
// first turn completes. Claude 1M beta is handled separately.
const CONTEXT_WINDOW_FALLBACK: Record<AgentWindowNode['agent'], number> = {
  claude: 200_000,
  codex: 272_000,
  cursor: 200_000,
  copilot: 200_000,
  opencode: 200_000,
}

function formatTokens(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

// Rolling "% of context used" readout that sits next to the model picker.
// Uses the backend's normalized `usedTokens` snapshot when available and
// falls back to a capped view of `totalProcessedTokens` so the badge never
// renders impossible values like "4.6M / 272k".
export function ContextUsageIndicator({ usage, agent, contextLength }: ContextUsageIndicatorProps) {
  if (!usage) return null
  const fromSdk = usage.contextWindow && usage.contextWindow > 0 ? usage.contextWindow : null
  const fallback =
    agent === 'claude' && contextLength === 'extended' ? 1_000_000 : CONTEXT_WINDOW_FALLBACK[agent]
  const limit = fromSdk ?? fallback
  const totalProcessed =
    usage.totalProcessedTokens && usage.totalProcessedTokens > 0 ? usage.totalProcessedTokens : null
  const used =
    usage.usedTokens && usage.usedTokens > 0
      ? usage.usedTokens
      : totalProcessed && totalProcessed > 0
        ? Math.min(totalProcessed, limit)
        : null
  if (!used || used <= 0) return null
  const pct = Math.min(100, Math.round((used / limit) * 100))
  const tint =
    pct >= 90
      ? 'text-rose-300 bg-rose-500/10'
      : pct >= 70
        ? 'text-amber-300 bg-amber-500/10'
        : 'text-muted-foreground/85 bg-foreground/5'
  const title = [
    `Context: ${used.toLocaleString()} / ${limit.toLocaleString()} tokens`,
    totalProcessed && totalProcessed > used
      ? `${usage.compactsAutomatically ? 'Processed this turn' : 'Processed'}: ${totalProcessed.toLocaleString()} tokens`
      : null,
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <span
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-[11px] font-medium tabular-nums',
        tint,
      )}
      title={title}
    >
      <Gauge className="size-3" />
      {pct}%
      <span className="text-muted-foreground/70">
        {formatTokens(used)}/{formatTokens(limit)}
      </span>
    </span>
  )
}

function ShortcutHint({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-0.5 normal-case tracking-normal text-muted-foreground/55">
      {keys.map((k) => (
        <Kbd
          key={k}
          className="h-4 min-w-4 rounded-[3px] bg-foreground/6 px-1 text-[9.5px] font-medium text-muted-foreground/75"
        >
          {k}
        </Kbd>
      ))}
    </span>
  )
}

export const PERMISSION_MODE_OPTIONS: Array<{
  id: AgentPermissionMode
  label: string
  short: string
  hint: string
  Icon: typeof Shield
  tint: string
}> = [
  {
    id: 'plan',
    label: 'Plan',
    short: 'Plan',
    hint: 'Read-only planning — agent can look and reason but cannot write files or run commands.',
    Icon: Shield,
    tint: 'text-sky-400',
  },
  {
    id: 'ask',
    label: 'Ask to Edit',
    short: 'Ask',
    hint: 'Agent asks before each write / command.',
    Icon: ShieldCheck,
    tint: 'text-amber-400',
  },
  {
    id: 'bypass',
    label: 'Bypass (yolo)',
    short: 'Yolo',
    hint: 'Nothing is gated — every tool runs without confirmation. Use in sandboxed worktrees only.',
    Icon: ShieldOff,
    tint: 'text-rose-400',
  },
]

export function getDefaultPermissionMode(): AgentPermissionMode {
  return 'ask'
}

// Older windows were saved with 'safe' / 'allow-all'; fold them into the
// current 3-mode set so existing sessions keep working without a migration.
function coerceLegacyPermissionMode(
  value: AgentPermissionMode | 'safe' | 'allow-all' | null | undefined,
): AgentPermissionMode {
  if (value === 'safe') return 'plan'
  if (value === 'allow-all') return 'ask'
  if (value === 'plan' || value === 'ask' || value === 'bypass') return value
  return getDefaultPermissionMode()
}

interface PermissionPickerProps {
  value: AgentPermissionMode | null | undefined
  onChange: (value: AgentPermissionMode) => void
}

export function PermissionPicker({ value, onChange }: PermissionPickerProps) {
  const [open, setOpen] = useState(false)
  const coerced = coerceLegacyPermissionMode(value as any)
  const current =
    PERMISSION_MODE_OPTIONS.find((m) => m.id === coerced) ?? PERMISSION_MODE_OPTIONS[1]
  const Icon = current.Icon
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-[8px] bg-foreground/5 px-2 text-[11px] text-foreground/85 transition-colors hover:bg-foreground/10"
            title={current.hint}
          >
            <Icon className={cn('size-3.5', current.tint)} />
            <span className="truncate font-medium">{current.short}</span>
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        }
      />
      <PopoverContent align="start" side="top" sideOffset={6} className="w-64 p-1">
        <div className="mb-1 flex items-center justify-between gap-2 px-2 pt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
          <span>Permission mode</span>
          <ShortcutHint keys={['Shift', 'Tab']} />
        </div>
        {PERMISSION_MODE_OPTIONS.map((mode) => {
          const active = mode.id === current.id
          const Mi = mode.Icon
          return (
            <button
              key={mode.id}
              type="button"
              onClick={() => {
                onChange(mode.id)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12px] transition-colors',
                active
                  ? 'bg-foreground/8 text-foreground'
                  : 'hover:bg-foreground/5 text-foreground/90',
              )}
            >
              <Mi className={cn('mt-0.5 size-3.5 shrink-0', mode.tint)} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{mode.label}</div>
                <div className="text-[10.5px] leading-snug text-muted-foreground/70">
                  {mode.hint}
                </div>
              </div>
              {active ? <Check className="mt-0.5 size-3.5 text-foreground" /> : null}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
