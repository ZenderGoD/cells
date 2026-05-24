import test from 'node:test'
import assert from 'node:assert/strict'
import type { Project } from '@/types'

const { getTitleBarProjects } = (await import(
  new URL('./project-title-bar.ts', import.meta.url).href
)) as {
  getTitleBarProjects: (projects: Project[], activeProjectId?: string | null) => Project[]
}

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    terminals: [],
    browsers: [],
    textEditors: [],
    agentWindows: [],
    windowSections: [],
    canvas: { x: 0, y: 0, scale: 1 },
    lastOpenedAt: 1,
    ...overrides,
  }
}

test('getTitleBarProjects includes the active project alongside pinned projects', () => {
  const projects = [
    makeProject('pinned', { titleBarPinned: true }),
    makeProject('active'),
    makeProject('other'),
  ]

  assert.deepEqual(
    getTitleBarProjects(projects, 'active').map((project) => project.id),
    ['pinned', 'active'],
  )
})

test('getTitleBarProjects does not duplicate the active project when it is pinned', () => {
  const projects = [
    makeProject('active', { titleBarPinned: true }),
    makeProject('other', { titleBarPinned: true }),
  ]

  assert.deepEqual(
    getTitleBarProjects(projects, 'active').map((project) => project.id),
    ['active', 'other'],
  )
})

test('getTitleBarProjects keeps a hidden active project visible while pinned mode is active', () => {
  const projects = [
    makeProject('pinned', { titleBarPinned: true }),
    makeProject('active', { hiddenFromTitleBar: true }),
  ]

  assert.deepEqual(
    getTitleBarProjects(projects, 'active').map((project) => project.id),
    ['pinned', 'active'],
  )
})
