import type { Project, TerminalProcessInfo } from '@/types'

export function getProjectCloseTransition(
  projects: Project[],
  activeProjectId: string | null,
  projectId: string,
) {
  const remainingProjects = projects.filter((project) => project.id !== projectId)

  if (projectId !== activeProjectId) {
    return {
      remainingProjects,
      nextActiveProjectId: activeProjectId,
    }
  }

  const nextActiveProjectId =
    remainingProjects.length > 0
      ? ([...remainingProjects].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0]
          ?.id ?? null)
      : null

  return {
    remainingProjects,
    nextActiveProjectId,
  }
}

export function insertRestoredProject(projects: Project[], project: Project, closedIndex: number) {
  const withoutDuplicate = projects.filter((candidate) => candidate.id !== project.id)
  const index = Math.max(0, Math.min(closedIndex, withoutDuplicate.length))
  return [...withoutDuplicate.slice(0, index), project, ...withoutDuplicate.slice(index)]
}

export function getRunningProjectProcessLabels(processInfos: Array<TerminalProcessInfo | null>) {
  const seen = new Set<string>()
  const labels: string[] = []

  for (const processInfo of processInfos) {
    if (!processInfo || processInfo.isShell || seen.has(processInfo.key)) {
      continue
    }
    seen.add(processInfo.key)
    labels.push(processInfo.label)
  }

  return labels
}
