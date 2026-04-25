import test from 'node:test'
import assert from 'node:assert/strict'
import type { GitWorktree } from '@/types'

const { createPromptBranchName, findWorktreeForPath, formatWorktreeLocation, getWorktreeName } =
  await import(new URL('./worktree-utils.ts', import.meta.url).href)

function worktree(overrides: Partial<GitWorktree>): GitWorktree {
  return {
    path: '/repo',
    repoRoot: '/repo',
    head: 'abc123',
    branch: 'main',
    branchRef: 'refs/heads/main',
    isMain: false,
    isBare: false,
    isDetached: false,
    isMissing: false,
    isDirty: false,
    dirtyCount: 0,
    ahead: null,
    behind: null,
    upstream: null,
    prunable: false,
    lockedReason: null,
    ...overrides,
  }
}

test('findWorktreeForPath chooses the deepest matching worktree', () => {
  const worktrees = [
    worktree({ path: '/repo', branch: 'main', isMain: true }),
    worktree({ path: '/repo/packages/app-wt', branch: 'feature/app' }),
  ]

  assert.equal(findWorktreeForPath(worktrees, '/repo/packages/app-wt/src')?.branch, 'feature/app')
})

test('formatWorktreeLocation includes relative path inside worktree', () => {
  const wt = worktree({ path: '/Users/raj/projects/cells-feature', branch: 'feature/ui' })

  assert.equal(
    formatWorktreeLocation(wt, '/Users/raj/projects/cells-feature/src'),
    'feature/ui · src',
  )
})

test('getWorktreeName handles detached worktrees', () => {
  assert.equal(getWorktreeName(worktree({ branch: null, isDetached: true })), 'Detached')
})

test('createPromptBranchName creates a stable task branch slug', () => {
  assert.equal(createPromptBranchName('Fix the worktree UX!'), 'task/fix-the-worktree-ux')
})
