import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'

// Copied and adapted from Craft Agents OSS:
// ../craft-agents-oss/apps/electron/src/renderer/components/chat/EmptyStateHint.tsx

type EntityType = 'agent' | 'folder' | 'tool'

type HintSegment =
  | { type: 'text'; content: string }
  | { type: 'entity'; entityType: EntityType; label: string }

interface ParsedHint {
  id: string
  segments: HintSegment[]
}

const HINT_TEMPLATES = [
  'Ask {agent} to inspect {folder} and explain what is running.',
  'Have {agent} edit files directly, then summarize the changes.',
  'Use {tool} output to review commands and file updates.',
  'Start a new task in {folder} and keep the conversation here.',
  'Drop a question — {agent} can read {folder} before answering.',
]

function parseHintTemplate(template: string, id: string): ParsedHint {
  const segments: HintSegment[] = []
  const tokenRegex = /\{(agent|folder|tool)(?::([^}]+))?\}/g

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenRegex.exec(template)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        content: template.slice(lastIndex, match.index),
      })
    }

    const entityType = match[1] as EntityType
    segments.push({
      type: 'entity',
      entityType,
      label: match[2] || entityType,
    })

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < template.length) {
    segments.push({
      type: 'text',
      content: template.slice(lastIndex),
    })
  }

  return { id, segments }
}

function EntityBadge({ label }: { label: string }) {
  return (
    <span className="mx-[3px] inline-flex items-center rounded-[7px] bg-foreground/6 px-[9px] py-[1px] text-foreground/55 shadow-minimal">
      {label}
    </span>
  )
}

export function AgentEmptyStateHint({ className }: { className?: string }) {
  const hints = useMemo(
    () => HINT_TEMPLATES.map((template, index) => parseHintTemplate(template, `hint-${index}`)),
    [],
  )
  const [selectedIndex] = useState(() => Math.floor(Math.random() * hints.length))
  const hint = hints[selectedIndex]

  return (
    <div
      className={cn(
        'mx-auto max-w-[360px] select-none text-balance text-center text-[15px] font-medium leading-[1.55] tracking-tight text-foreground/75',
        className,
      )}
    >
      {hint.segments.map((segment, index) =>
        segment.type === 'text' ? (
          <span key={index}>{segment.content}</span>
        ) : (
          <EntityBadge key={index} label={segment.label} />
        ),
      )}
    </div>
  )
}
