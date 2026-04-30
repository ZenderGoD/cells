import type { Project } from '@/types'

function normalizeFsPathForMatch(value: string | null | undefined) {
  const normalized = (value ?? '').trim().replace(/\\/g, '/')
  if (normalized === '/') return '/'
  return normalized.replace(/\/+$/, '')
}

function shouldCompareCaseInsensitive() {
  if (typeof navigator === 'undefined') return false
  return /mac|win/i.test(navigator.platform)
}

function comparablePath(value: string) {
  return shouldCompareCaseInsensitive() ? value.toLowerCase() : value
}

export function isPathInsideProject(filePath: string, projectPath: string | null | undefined) {
  const normalizedFile = normalizeFsPathForMatch(filePath)
  const normalizedProject = normalizeFsPathForMatch(projectPath)
  if (!normalizedFile || !normalizedProject) return false

  const file = comparablePath(normalizedFile)
  const project = comparablePath(normalizedProject)
  return file === project || file.startsWith(`${project}/`)
}

export function findProjectForFilePath(filePath: string, projects: Project[]) {
  return projects
    .filter((project) => isPathInsideProject(filePath, project.path))
    .sort((left, right) => right.path.length - left.path.length)[0]
}
