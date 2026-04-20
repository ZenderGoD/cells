export type AgentComposerMentionKind = 'skill' | 'file' | 'folder'

// Copied and adapted from Craft Agents OSS mention-trigger logic:
// ../craft-agents-oss/apps/electron/src/renderer/components/ui/mention-menu.tsx

export interface AgentComposerMentionTrigger {
  kind: 'inline'
  query: string
  start: number
}

export interface RewriteAgentComposerMentionsResult {
  text: string
  referencedPaths: string[]
}

const INLINE_COMPOSER_MENTION_RE = /\[(skill|file|folder):([^\]]+)\]/g

export function isValidAgentComposerMentionTrigger(
  textBeforeCursor: string,
  atPosition: number,
): boolean {
  if (atPosition < 0) return false
  if (atPosition === 0) return true
  const charBefore = textBeforeCursor[atPosition - 1]
  if (!charBefore) return false
  return /\s/.test(charBefore) || /[("']/.test(charBefore)
}

export function extractAgentComposerMentionTrigger(
  value: string,
  cursorPosition: number,
): AgentComposerMentionTrigger | null {
  const textBeforeCursor = value.slice(0, cursorPosition)
  const atMatch = textBeforeCursor.match(/@([\w\-/.\s]{0,100})?$/)
  const matchStart = atMatch ? textBeforeCursor.lastIndexOf('@') : -1
  if (!atMatch || !isValidAgentComposerMentionTrigger(textBeforeCursor, matchStart)) {
    return null
  }
  return {
    kind: 'inline',
    query: atMatch[1] || '',
    start: matchStart,
  }
}

export function rewriteAgentComposerMentions(
  text: string,
  resolvePath: (kind: AgentComposerMentionKind, value: string) => string | null,
): RewriteAgentComposerMentionsResult {
  const referencedPaths = new Set<string>()
  const normalizedText = text.replace(
    INLINE_COMPOSER_MENTION_RE,
    (_match, rawKind: string, rawValue: string) => {
      const kind = rawKind as AgentComposerMentionKind
      const value = rawValue.trim()
      const resolvedPath = resolvePath(kind, value)
      if (resolvedPath) referencedPaths.add(resolvedPath)
      return `[${value}]`
    },
  )
  return {
    text: normalizedText,
    referencedPaths: Array.from(referencedPaths),
  }
}
