import type { AgentSessionMessage } from '@/types'

export interface DiffStats {
  additions: number
  deletions: number
}

export interface FileDiffStats extends DiffStats {
  filePath: string
  /** Multiple edit ops may target the same file within a session. */
  edits: Array<{ oldString: string; newString: string; toolId: string }>
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

function safeParse(text: string | undefined | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function countLines(text: string): number {
  if (!text) return 0
  return text.split('\n').length
}

/** Compute {additions, deletions} from an Edit/Write/MultiEdit tool input.
 *  Returns null for non-edit tools or unparseable inputs. Uses a simple
 *  line-count heuristic: additions = lines in new_string, deletions = lines
 *  in old_string. MultiEdit sums over the `edits[]` array. Write treats the
 *  whole content as additions. */
export function computeEditWriteDiffStats(
  toolName: string,
  input: Record<string, unknown> | null,
): DiffStats | null {
  if (!input) return null
  const title = toolName.replace(/^mcp__[^_]+__/, '')
  if (!EDIT_TOOLS.has(title)) return null

  if (title === 'Write') {
    const content = typeof input.content === 'string' ? input.content : ''
    return { additions: countLines(content), deletions: 0 }
  }

  if (title === 'Edit') {
    const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
    const newStr = typeof input.new_string === 'string' ? input.new_string : ''
    return { additions: countLines(newStr), deletions: countLines(oldStr) }
  }

  if (title === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? (input.edits as unknown[]) : []
    let additions = 0
    let deletions = 0
    for (const raw of edits) {
      const edit = (raw ?? {}) as Record<string, unknown>
      const oldStr = typeof edit.old_string === 'string' ? edit.old_string : ''
      const newStr = typeof edit.new_string === 'string' ? edit.new_string : ''
      additions += countLines(newStr)
      deletions += countLines(oldStr)
    }
    return { additions, deletions }
  }

  if (title === 'NotebookEdit') {
    const newSource = typeof input.new_source === 'string' ? input.new_source : ''
    return { additions: countLines(newSource), deletions: 0 }
  }

  return null
}

/** Extract diff stats from a single tool message. */
export function diffStatsFromMessage(message: AgentSessionMessage): DiffStats | null {
  if (message.role !== 'tool' || !message.title) return null
  return computeEditWriteDiffStats(message.title, safeParse(message.text))
}

/** Sum {additions, deletions} across a list of tool messages. */
export function sumDiffStats(messages: AgentSessionMessage[]): DiffStats {
  const total: DiffStats = { additions: 0, deletions: 0 }
  for (const message of messages) {
    const stats = diffStatsFromMessage(message)
    if (!stats) continue
    total.additions += stats.additions
    total.deletions += stats.deletions
  }
  return total
}

/** Group edits by file path and aggregate their stats. Used by the session
 *  diffs side panel to render one entry per touched file. */
export function groupDiffsByFile(messages: AgentSessionMessage[]): FileDiffStats[] {
  const byPath = new Map<string, FileDiffStats>()
  for (const message of messages) {
    if (message.role !== 'tool' || !message.title) continue
    const input = safeParse(message.text)
    if (!input) continue
    const title = message.title.replace(/^mcp__[^_]+__/, '')
    if (!EDIT_TOOLS.has(title)) continue
    const filePath =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.notebook_path === 'string'
          ? input.notebook_path
          : null
    if (!filePath) continue
    const stats = computeEditWriteDiffStats(title, input)
    if (!stats) continue
    const existing = byPath.get(filePath) ?? {
      filePath,
      additions: 0,
      deletions: 0,
      edits: [],
    }
    existing.additions += stats.additions
    existing.deletions += stats.deletions
    if (title === 'Edit') {
      existing.edits.push({
        oldString: typeof input.old_string === 'string' ? input.old_string : '',
        newString: typeof input.new_string === 'string' ? input.new_string : '',
        toolId: message.id,
      })
    } else if (title === 'MultiEdit') {
      const edits = Array.isArray(input.edits) ? (input.edits as unknown[]) : []
      for (const raw of edits) {
        const edit = (raw ?? {}) as Record<string, unknown>
        existing.edits.push({
          oldString: typeof edit.old_string === 'string' ? edit.old_string : '',
          newString: typeof edit.new_string === 'string' ? edit.new_string : '',
          toolId: message.id,
        })
      }
    } else if (title === 'Write') {
      existing.edits.push({
        oldString: '',
        newString: typeof input.content === 'string' ? input.content : '',
        toolId: message.id,
      })
    }
    byPath.set(filePath, existing)
  }
  return Array.from(byPath.values()).sort((a, b) => a.filePath.localeCompare(b.filePath))
}

export function hasDiffStats(stats: DiffStats | null | undefined): boolean {
  if (!stats) return false
  return stats.additions > 0 || stats.deletions > 0
}
