import type { AgentSessionMessage } from '../types/index.ts'

export interface DiffStats {
  additions: number
  deletions: number
  changedFiles?: number
}

export interface FileDiffStats extends DiffStats {
  filePath: string
  /** Multiple edit ops may target the same file within a session. */
  edits: Array<{ oldString: string; newString: string; toolId: string }>
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const FILE_CHANGE_TOOL = 'File changes'
const MAX_CACHE_ENTRIES = 10_000
const parsedFileCache = new Map<string, FileDiffStats[]>()
const diffStatsCache = new Map<string, DiffStats | null>()

function trimCache<T>(cache: Map<string, T>) {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (!oldestKey) break
    cache.delete(oldestKey)
  }
}

function messageCacheKey(message: AgentSessionMessage): string {
  const hashValue = (value: string | undefined | null) => {
    if (!value) return ''
    let hash = 2166136261
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return `${value.length}:${(hash >>> 0).toString(36)}`
  }
  return [
    message.id,
    message.updatedAt ?? '',
    message.status ?? '',
    message.title ?? '',
    hashValue(message.metadata),
    hashValue(message.text),
  ].join('\u241f')
}

function parseCandidateStats(value: string): FileDiffStats[] {
  return candidateHasLikelyDiff(value)
    ? parseUnifiedDiffFiles(value)
    : parseSummaryFileChanges(value)
}

function candidateHasNumericChanges(files: FileDiffStats[]) {
  return files.some((file) => file.additions > 0 || file.deletions > 0)
}

function candidateHasLikelyDiff(value: string) {
  return /^diff --git /m.test(value) || /^@@/m.test(value)
}

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

function normalizeDiffPath(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed
  if (!unquoted || unquoted === '/dev/null') return null
  if (unquoted.startsWith('a/') || unquoted.startsWith('b/')) return unquoted.slice(2)
  return unquoted
}

function parseSummaryFileChanges(text: string): FileDiffStats[] {
  const byPath = new Map<string, FileDiffStats>()
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const cleanedLine = rawLine.replace(/\s*Success\. Updated the following files:.*$/, '').trim()
    const match =
      cleanedLine.match(/^(?:add|delete|update|change):\s+(.+)$/) ??
      cleanedLine.match(/^[ACDMRTU?]\s+(.+)$/)
    if (!match) continue
    const filePath = match[1]?.trim()
    if (!filePath) continue
    if (!byPath.has(filePath)) {
      byPath.set(filePath, {
        filePath,
        additions: 0,
        deletions: 0,
        edits: [],
      })
    }
  }
  return Array.from(byPath.values()).sort((a, b) => a.filePath.localeCompare(b.filePath))
}

function upsertParsedFile(
  byPath: Map<string, FileDiffStats>,
  filePath: string | null,
  additions: number,
  deletions: number,
) {
  if (!filePath) return
  const existing = byPath.get(filePath) ?? {
    filePath,
    additions: 0,
    deletions: 0,
    edits: [],
  }
  existing.additions += additions
  existing.deletions += deletions
  byPath.set(filePath, existing)
}

// Copied and adapted from t3code's unified-diff stat model:
// ../t3code/apps/server/src/checkpointing/Diffs.ts
// We keep the same per-file additions/deletions shape locally so Codex
// session badges and file trees can consume streamed patch text directly.
function parseUnifiedDiffFiles(diff: string): FileDiffStats[] {
  const normalized = diff.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const byPath = new Map<string, FileDiffStats>()
  let currentPath: string | null = null
  let additions = 0
  let deletions = 0
  let sawPatch = false

  const flush = () => {
    if (!currentPath && additions === 0 && deletions === 0) return
    upsertParsedFile(byPath, currentPath, additions, deletions)
    currentPath = null
    additions = 0
    deletions = 0
  }

  for (const line of normalized.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      sawPatch = true
      continue
    }
    if (line.startsWith('rename to ')) {
      currentPath = normalizeDiffPath(line.slice('rename to '.length))
      sawPatch = true
      continue
    }
    if (line.startsWith('+++ ')) {
      const nextPath = normalizeDiffPath(line.slice(4))
      if (nextPath) currentPath = nextPath
      sawPatch = true
      continue
    }
    if (line.startsWith('--- ')) {
      if (!currentPath) currentPath = normalizeDiffPath(line.slice(4))
      sawPatch = true
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions += 1
      sawPatch = true
      continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      deletions += 1
      sawPatch = true
      continue
    }
    if (line.startsWith('Binary files ')) {
      sawPatch = true
      continue
    }
  }

  flush()
  if (!sawPatch) return parseSummaryFileChanges(diff)
  return Array.from(byPath.values()).sort((a, b) => a.filePath.localeCompare(b.filePath))
}

function diffStatsFromFiles(files: FileDiffStats[]): DiffStats | null {
  if (files.length === 0) return null
  return files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
      changedFiles: (total.changedFiles ?? 0) + 1,
    }),
    { additions: 0, deletions: 0, changedFiles: 0 },
  )
}

function parseFileChangeStats(message: AgentSessionMessage): FileDiffStats[] {
  const cacheKey = messageCacheKey(message)
  const cached = parsedFileCache.get(cacheKey)
  if (cached) return cached
  const candidates = [message.metadata, message.text].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  )
  let best: FileDiffStats[] = []
  let bestHasNumeric = false
  let bestLooksLikeDiff = false
  let bestFromText = false
  for (const candidate of candidates) {
    const parsed = parseCandidateStats(candidate)
    if (parsed.length === 0) continue
    const hasNumeric = candidateHasNumericChanges(parsed)
    const looksLikeDiff = candidateHasLikelyDiff(candidate)
    const fromText = candidate === message.text
    if (
      best.length === 0 ||
      (looksLikeDiff && !bestLooksLikeDiff) ||
      (looksLikeDiff === bestLooksLikeDiff && hasNumeric && !bestHasNumeric) ||
      (looksLikeDiff === bestLooksLikeDiff &&
        hasNumeric === bestHasNumeric &&
        parsed.length > best.length) ||
      (looksLikeDiff === bestLooksLikeDiff &&
        hasNumeric === bestHasNumeric &&
        parsed.length === best.length &&
        fromText &&
        !bestFromText)
    ) {
      best = parsed
      bestHasNumeric = hasNumeric
      bestLooksLikeDiff = looksLikeDiff
      bestFromText = fromText
    }
  }
  parsedFileCache.set(cacheKey, best)
  trimCache(parsedFileCache)
  return best
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

/** Extract diff stats from a single tool message.
 *  Prefers `metadata` (the preserved original input) over `text`, which gets
 *  overwritten with the tool result once the call completes. */
export function diffStatsFromMessage(message: AgentSessionMessage): DiffStats | null {
  if (message.role !== 'tool' || !message.title) return null
  const cacheKey = messageCacheKey(message)
  const cached = diffStatsCache.get(cacheKey)
  if (cached !== undefined) return cached
  const computed =
    message.title === FILE_CHANGE_TOOL
      ? diffStatsFromFiles(parseFileChangeStats(message))
      : computeEditWriteDiffStats(
          message.title,
          safeParse(message.metadata) ?? safeParse(message.text),
        )
  diffStatsCache.set(cacheKey, computed)
  trimCache(diffStatsCache)
  return computed
}

/** Sum {additions, deletions} across a list of tool messages. */
export function sumDiffStats(messages: AgentSessionMessage[]): DiffStats {
  const total: DiffStats = { additions: 0, deletions: 0, changedFiles: 0 }
  for (const message of messages) {
    const stats = diffStatsFromMessage(message)
    if (!stats) continue
    total.additions += stats.additions
    total.deletions += stats.deletions
    total.changedFiles = (total.changedFiles ?? 0) + (stats.changedFiles ?? 0)
  }
  return total
}

/** Group edits by file path and aggregate their stats. Used by the session
 *  diffs side panel to render one entry per touched file. */
export function groupDiffsByFile(messages: AgentSessionMessage[]): FileDiffStats[] {
  const byPath = new Map<string, FileDiffStats>()
  for (const message of messages) {
    if (message.role !== 'tool' || !message.title) continue
    if (message.title === FILE_CHANGE_TOOL) {
      for (const file of parseFileChangeStats(message)) {
        const existing = byPath.get(file.filePath) ?? {
          filePath: file.filePath,
          additions: 0,
          deletions: 0,
          edits: [],
        }
        existing.additions += file.additions
        existing.deletions += file.deletions
        byPath.set(file.filePath, existing)
      }
      continue
    }
    const input = safeParse(message.metadata) ?? safeParse(message.text)
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
  return stats.additions > 0 || stats.deletions > 0 || (stats.changedFiles ?? 0) > 0
}
