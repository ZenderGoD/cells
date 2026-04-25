import type { GitWorktree } from '@/types'

export function normalizeFsPath(value: string | null | undefined) {
  if (!value) return null
  const normalized = value.trim().replace(/\\/g, '/')
  if (!normalized) return null
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

export function shortenFsPath(value: string | null | undefined) {
  if (!value) return ''
  return value.replace(/^\/Users\/[^/]+/, '~')
}

export function getWorktreeName(worktree: Pick<GitWorktree, 'branch' | 'isDetached' | 'path'>) {
  if (worktree.branch) return worktree.branch
  if (worktree.isDetached) return 'Detached'
  return worktree.path.split('/').filter(Boolean).at(-1) ?? worktree.path
}

export function findWorktreeForPath(
  worktrees: GitWorktree[],
  cwd: string | null | undefined,
): GitWorktree | null {
  const normalizedCwd = normalizeFsPath(cwd)
  if (!normalizedCwd) return null
  return (
    worktrees
      .filter((worktree) => !worktree.isBare)
      .map((worktree) => ({ worktree, path: normalizeFsPath(worktree.path) }))
      .filter((entry): entry is { worktree: GitWorktree; path: string } => Boolean(entry.path))
      .filter((entry) => normalizedCwd === entry.path || normalizedCwd.startsWith(`${entry.path}/`))
      .sort((left, right) => right.path.length - left.path.length)[0]?.worktree ?? null
  )
}

export function formatWorktreeLocation(
  worktree: GitWorktree | null,
  cwd: string | null | undefined,
) {
  if (!worktree) return cwd ? shortenFsPath(cwd) : null
  const normalizedCwd = normalizeFsPath(cwd)
  const normalizedRoot = normalizeFsPath(worktree.path)
  const name = getWorktreeName(worktree)
  if (!normalizedCwd || !normalizedRoot || normalizedCwd === normalizedRoot) return name
  const relativePath = normalizedCwd.slice(normalizedRoot.length).replace(/^\/+/, '')
  return relativePath ? `${name} · ${relativePath}` : name
}

export function createPromptBranchName(prompt: string, prefix = 'task') {
  const slug = prompt
    .trim()
    .toLowerCase()
    .replace(/[`"'’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return `${prefix}/${slug || `worktree-${Date.now().toString(36)}`}`
}
