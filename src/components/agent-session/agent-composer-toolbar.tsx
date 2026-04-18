import { useEffect, useState } from 'react'
import {
  Brain,
  Check,
  ChevronDown,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react'
import type { AgentPermissionMode, AgentThinkingLevel, AgentWindowNode } from '@/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// Copied and adapted from Craft Agents OSS:
// ../craft-agents-oss/apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx
// ../craft-agents-oss/apps/electron/src/renderer/components/app-shell/input/CompactPermissionModeSelector.tsx

interface ModelOption {
  id: string
  label: string
  hint?: string
  /** Effort values the model actually accepts (subset of AgentThinkingLevel). */
  supportedEfforts: AgentThinkingLevel[]
  /** Effort the SDK picks when the caller doesn't specify one. */
  defaultEffort: AgentThinkingLevel
  /** Per-effort human description (shown in the sub-list). */
  effortHints?: Partial<Record<AgentThinkingLevel, string>>
}

// Claude model catalog, sourced from the Claude Agent SDK `ModelInfo` type
// — node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts `supportedEffortLevels`.
// The SDK's authoritative union is `('low' | 'medium' | 'high' | 'max')[]`
// plus an `off` option (we always offer, since it maps to
// `thinking: { type: 'disabled' }`). Haiku drops the `max` tier because its
// adaptive-thinking path is unavailable and its token-budget cap sits below
// what 'max' would request.
const CLAUDE_MODELS: ModelOption[] = [
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    hint: 'Most capable for complex work',
    supportedEfforts: ['off', 'low', 'medium', 'high', 'max'],
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
    supportedEfforts: ['off', 'low', 'medium', 'high'],
    defaultEffort: 'low',
  },
]

// Fallback used before the live `codex app-server` `model/list` call resolves.
const CODEX_MODELS_FALLBACK: ModelOption[] = [
  {
    id: 'gpt-5-codex',
    label: 'GPT-5 Codex',
    hint: 'Default — fastest for coding',
    supportedEfforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'medium',
  },
]

// Process-level cache so opening a second Codex window doesn't respawn the
// app-server just to ask the same question.
let codexModelsCache: ModelOption[] | null = null
let codexModelsPromise: Promise<ModelOption[]> | null = null

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

// Maps the Codex CLI's reasoning-effort strings onto Cells's portable
// `AgentThinkingLevel` so the unified picker can render both agents the same
// way. 'minimal' → 'off', 'xhigh' → 'max'.
function codexEffortToLevel(effort: string): AgentThinkingLevel {
  switch (effort) {
    case 'minimal':
      return 'off'
    case 'xhigh':
      return 'max'
    case 'low':
    case 'medium':
    case 'high':
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
            supportedEfforts: efforts.length > 0 ? efforts : ['low', 'medium', 'high', 'max'],
            defaultEffort: codexEffortToLevel(m.defaultReasoningEffort || 'medium'),
            effortHints,
          }
        })
      codexModelsCache = mapped.length > 0 ? mapped : CODEX_MODELS_FALLBACK
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

const DEFAULT_MODEL: Record<'claude' | 'codex', string> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5-codex',
}

function findModel(
  models: ModelOption[],
  agent: 'claude' | 'codex',
  id: string | null | undefined,
) {
  return models.find((m) => m.id === (id ?? DEFAULT_MODEL[agent])) ?? models[0]
}

const THINKING_LEVEL_LABEL: Record<AgentThinkingLevel, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
}

const THINKING_FALLBACK_HINT: Record<AgentThinkingLevel, string> = {
  off: 'No extended reasoning',
  low: 'Light reasoning pass',
  medium: 'Balanced speed and depth',
  high: 'Deep reasoning for complex tasks',
  max: 'Maximum effort reasoning',
}

interface ModelPickerProps {
  agent: AgentWindowNode['agent']
  value: string | null | undefined
  thinkingLevel: AgentThinkingLevel | null | undefined
  onChange: (value: string) => void
  onThinkingChange: (value: AgentThinkingLevel) => void
}

// Unified model + thinking picker — mirrors Craft's FreeFormInput dropdown
// (../craft-agents-oss/apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx
// ~lines 1905-2100). The popover lists models, then a "Thinking" section
// whose options are scoped to the CURRENT model's `supportedEfforts` (pulled
// from the Codex app-server `model/list` response and the Claude Agent SDK
// `ModelInfo.supportedEffortLevels`). The trigger shows "<Model> · <Effort>"
// so the selected thinking level is always visible without opening the menu.
export function ModelPicker({
  agent,
  value,
  thinkingLevel,
  onChange,
  onThinkingChange,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [codexModels, setCodexModels] = useState<ModelOption[]>(
    () => codexModelsCache ?? CODEX_MODELS_FALLBACK,
  )
  useEffect(() => {
    if (agent !== 'codex') return
    let cancelled = false
    void fetchCodexModels().then((list) => {
      if (!cancelled) setCodexModels(list)
    })
    return () => {
      cancelled = true
    }
  }, [agent])
  const models = agent === 'claude' ? CLAUDE_MODELS : codexModels
  const current = findModel(models, agent, value)
  const effectiveThinking: AgentThinkingLevel =
    thinkingLevel && current.supportedEfforts.includes(thinkingLevel)
      ? thinkingLevel
      : current.defaultEffort

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-[8px] bg-foreground/5 px-2 text-[11px] text-foreground/85 transition-colors hover:bg-foreground/10"
            title={`Model: ${current.label} · Thinking: ${THINKING_LEVEL_LABEL[effectiveThinking]}`}
          >
            <span className="truncate font-medium">{current.label}</span>
            <span className="inline-flex items-center gap-1 rounded-[4px] bg-foreground/8 px-1 py-px text-[10px] font-medium text-foreground/80">
              <Brain className="size-2.5 text-violet-300/90" />
              {THINKING_LEVEL_LABEL[effectiveThinking]}
            </span>
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        }
      />
      <PopoverContent align="start" side="top" sideOffset={6} className="w-64 p-1">
        <div className="mb-1 px-2 pt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
          {agent === 'claude' ? 'Claude models' : 'Codex models'}
        </div>
        {models.map((model) => {
          const active = model.id === current.id
          return (
            <button
              key={model.id}
              type="button"
              onClick={() => {
                onChange(model.id)
                // If the new model doesn't support the current thinking level,
                // drop to its default. Matches Craft behaviour.
                if (thinkingLevel && !model.supportedEfforts.includes(thinkingLevel)) {
                  onThinkingChange(model.defaultEffort)
                }
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
                <div className="truncate font-medium">{model.label}</div>
                {model.hint ? (
                  <div className="truncate text-[10.5px] text-muted-foreground/70">
                    {model.hint}
                  </div>
                ) : null}
              </div>
              {active ? <Check className="mt-0.5 size-3.5 text-foreground" /> : null}
            </button>
          )
        })}
        {current.supportedEfforts.length > 0 ? (
          <>
            <div className="my-1 h-px bg-border/60" />
            <div className="mb-1 flex items-center gap-1.5 px-2 pt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
              <Brain className="size-3 text-violet-300/80" />
              Thinking
            </div>
            {current.supportedEfforts.map((level) => {
              const active = level === effectiveThinking
              const hint = current.effortHints?.[level] ?? THINKING_FALLBACK_HINT[level]
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => {
                    onThinkingChange(level)
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
          </>
        ) : null}
      </PopoverContent>
    </Popover>
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
    id: 'safe',
    label: 'Explore',
    short: 'Explore',
    hint: 'Read-only — agent can look but cannot change anything.',
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
    id: 'allow-all',
    label: 'Execute',
    short: 'Execute',
    hint: 'Agent auto-accepts edits but still prompts for shell commands.',
    Icon: ShieldAlert,
    tint: 'text-emerald-400',
  },
  {
    id: 'bypass',
    label: 'Bypass permissions',
    short: 'Bypass',
    hint: 'Nothing is gated — every tool runs without confirmation. Use in sandboxed worktrees only.',
    Icon: ShieldOff,
    tint: 'text-rose-400',
  },
]

export function getDefaultPermissionMode(): AgentPermissionMode {
  return 'allow-all'
}

interface PermissionPickerProps {
  value: AgentPermissionMode | null | undefined
  onChange: (value: AgentPermissionMode) => void
}

export function PermissionPicker({ value, onChange }: PermissionPickerProps) {
  const [open, setOpen] = useState(false)
  const current =
    PERMISSION_MODE_OPTIONS.find((m) => m.id === (value ?? getDefaultPermissionMode())) ??
    PERMISSION_MODE_OPTIONS[2]
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
        <div className="mb-1 px-2 pt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
          Permission mode
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
