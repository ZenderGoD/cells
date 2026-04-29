import type { Project } from '@/types'

export const TITLE_BAR_AUTO_PROJECT_LIMIT = 5

export function hasPinnedTitleBarProjects(projects: Project[]): boolean {
  return projects.some((project) => project.titleBarPinned === true)
}

export function getTitleBarProjects(projects: Project[], activeProjectId?: string | null) {
  const pinned = projects.filter((project) => project.titleBarPinned === true)
  if (pinned.length > 0) return pinned

  const autoVisible = projects.filter((project) => !project.hiddenFromTitleBar)
  if (projects.length <= TITLE_BAR_AUTO_PROJECT_LIMIT) return autoVisible

  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId)
    : null
  return activeProject ? [activeProject] : []
}
