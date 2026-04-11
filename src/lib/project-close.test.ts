import test from 'node:test'
import assert from 'node:assert/strict'
import type { Project, TerminalProcessInfo } from '@/types'

const projectCloseModulePromise = import(new URL('./project-close.ts', import.meta.url).href).catch(
  () => ({}),
)

function makeProject(id: string, lastOpenedAt: number, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    terminals: [],
    browsers: [],
    canvas: { x: 0, y: 0, scale: 1 },
    lastOpenedAt,
    ...overrides,
  }
}

test('getProjectCloseTransition picks the most recently opened remaining project when closing the active tab', async () => {
  const { getProjectCloseTransition } = (await projectCloseModulePromise) as {
    getProjectCloseTransition?: (
      projects: Project[],
      activeProjectId: string | null,
      projectId: string,
    ) => { remainingProjects: Project[]; nextActiveProjectId: string | null }
  }

  assert.equal(typeof getProjectCloseTransition, 'function')

  const projects = [makeProject('alpha', 10), makeProject('beta', 50), makeProject('gamma', 30)]
  const transition = getProjectCloseTransition!(projects, 'alpha', 'alpha')

  assert.deepEqual(
    transition.remainingProjects.map((project) => project.id),
    ['beta', 'gamma'],
  )
  assert.equal(transition.nextActiveProjectId, 'beta')
})

test('getProjectCloseTransition keeps the current active project when closing a background tab', async () => {
  const { getProjectCloseTransition } = (await projectCloseModulePromise) as {
    getProjectCloseTransition?: (
      projects: Project[],
      activeProjectId: string | null,
      projectId: string,
    ) => { remainingProjects: Project[]; nextActiveProjectId: string | null }
  }

  assert.equal(typeof getProjectCloseTransition, 'function')

  const projects = [makeProject('alpha', 10), makeProject('beta', 50), makeProject('gamma', 30)]
  const transition = getProjectCloseTransition!(projects, 'beta', 'gamma')

  assert.deepEqual(
    transition.remainingProjects.map((project) => project.id),
    ['alpha', 'beta'],
  )
  assert.equal(transition.nextActiveProjectId, 'beta')
})

test('insertRestoredProject puts a closed project back at its original tab position', async () => {
  const { insertRestoredProject } = (await projectCloseModulePromise) as {
    insertRestoredProject?: (
      projects: Project[],
      project: Project,
      closedIndex: number,
    ) => Project[]
  }

  assert.equal(typeof insertRestoredProject, 'function')

  const restored = insertRestoredProject!(
    [makeProject('alpha', 10), makeProject('gamma', 30)],
    makeProject('beta', 50),
    1,
  )

  assert.deepEqual(
    restored.map((project) => project.id),
    ['alpha', 'beta', 'gamma'],
  )
})

test('getRunningProjectProcessLabels ignores shells and de-duplicates repeated services', async () => {
  const { getRunningProjectProcessLabels } = (await projectCloseModulePromise) as {
    getRunningProjectProcessLabels?: (processInfos: Array<TerminalProcessInfo | null>) => string[]
  }

  assert.equal(typeof getRunningProjectProcessLabels, 'function')

  const labels = getRunningProjectProcessLabels!([
    { pid: 1, command: 'zsh', label: 'shell', key: 'zsh', isShell: true },
    { pid: 2, command: 'pnpm dev', label: 'pnpm dev', key: 'pnpm dev', isShell: false },
    { pid: 3, command: 'pnpm dev', label: 'pnpm dev', key: 'pnpm dev', isShell: false },
    { pid: 4, command: 'npm test', label: 'npm test', key: 'npm test', isShell: false },
    null,
  ])

  assert.deepEqual(labels, ['pnpm dev', 'npm test'])
})
