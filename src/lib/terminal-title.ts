// Helpers for cleaning up terminal window titles. Extracted from
// cell-terminal.tsx so they can be unit tested without importing the whole
// xterm stack.

// Prefixes that agents or backends prepend to window titles. We strip a single
// leading match so the user only sees the meaningful part. Matched
// case-insensitively; each entry expects " | " or ": " to follow.
export const STRIPPABLE_TITLE_PREFIXES = [
  'claude code',
  'claude',
  'codex',
  'opencode',
  'pi',
] as const

const AGENT_PREFIX_RE = new RegExp(`^(?:${STRIPPABLE_TITLE_PREFIXES.join('|')})\\s*[|:]\\s*`, 'i')

// Drop Zellij's private Cells session name, e.g. `czba1d9888fa56fe2207bc8ce |`
// or `cells_foo |`, plus any transient marker glyph (`* `, `+ `, `- `), plus
// one well-known agent label prefix. Unrelated pipe-separated titles survive.
export function sanitizeBackendLeakedTitle(input: string): string {
  let trimmed = input.replace(/\s+/g, ' ').trim()
  if (!trimmed) return ''

  trimmed = trimmed
    .replace(/^(?:cz[a-f0-9]{8,}|cells[-_][^\s|]+)\s*\|\s*/i, '')
    .replace(/^[*+-]\s+/, '')
    .replace(AGENT_PREFIX_RE, '')

  return trimmed.trim()
}
