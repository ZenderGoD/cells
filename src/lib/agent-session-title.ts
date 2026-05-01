import type { AgentSessionMessage, AgentSessionSnapshot } from '../types'

const DEFAULT_SESSION_TITLE = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
} as const

const CLAUDE_IMPORTED_PREAMBLE_PATTERNS = [
  /^\*\*USER'S DATE AND TIME:[\s\S]*?Ignore any other date information\.\s*/i,
  /<session_state>[\s\S]*?<\/session_state>\s*/gi,
  /<sources>[\s\S]*?<\/sources>\s*/gi,
  /<workspace_capabilities>[\s\S]*?<\/workspace_capabilities>\s*/gi,
  /<working_directory>[\s\S]*?<\/working_directory>\s*/gi,
  /<working_directory_context>[\s\S]*?<\/working_directory_context>\s*/gi,
]

// Copied and adapted from Craft Agents OSS title sanitization:
// ../craft-agents-oss/packages/server-core/src/domain/title-sanitizer.ts
function sanitizeSessionText(value: string): string {
  return value
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ')
    .replace(/<model_switch>[\s\S]*?<\/model_switch>/gi, ' ')
    .replace(/<edit_request>[\s\S]*?<\/edit_request>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[skill:[^\]]+\]/g, ' ')
    .replace(/\[source:[^\]]+\]/g, ' ')
    .replace(/\[file:[^\]]+\]/g, ' ')
    .replace(/\[folder:[^\]]+\]/g, ' ')
    .replace(/\[Image #[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function sanitizeImportedClaudeUserText(value: string): string {
  let next = value
  for (const pattern of CLAUDE_IMPORTED_PREAMBLE_PATTERNS) {
    next = next.replace(pattern, '')
  }
  return sanitizeSessionText(next)
}

export function sanitizeSessionTitleCandidate(value: string): string {
  const cleaned = sanitizeImportedClaudeUserText(value)
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .trim()
    .replace(/\s+/g, ' ')

  if (!cleaned) return ''
  if (cleaned.length <= 50) return cleaned
  return `${cleaned.slice(0, 47).trimEnd()}...`
}

export function isPlaceholderAgentSessionTitle(
  agent: AgentSessionSnapshot['agent'],
  title: string | null | undefined,
): boolean {
  const normalized = title?.trim() ?? ''
  if (!normalized) return true
  if (normalized === DEFAULT_SESSION_TITLE[agent]) return true
  if (normalized === 'New thread') return true
  if (agent === 'claude') return /^Claude session\b/i.test(normalized)
  if (agent === 'codex') return /^Codex session\b/i.test(normalized)
  if (agent === 'copilot') return /^Copilot session\b|^GitHub Copilot session\b/i.test(normalized)
  if (agent === 'opencode') return /^OpenCode session\b/i.test(normalized)
  return /^Cursor session\b/i.test(normalized)
}

export function inferAgentSessionTitle(
  agent: AgentSessionSnapshot['agent'],
  messages: AgentSessionMessage[],
): string {
  const candidate = messages
    .filter((message) => message.role === 'user')
    .map((message) => sanitizeSessionTitleCandidate(message.text))
    .find(Boolean)

  return candidate || DEFAULT_SESSION_TITLE[agent]
}
