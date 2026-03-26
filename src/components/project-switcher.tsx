import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Globe, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import { getCanvasWindows } from '@/lib/canvas-navigation'
import { motion, AnimatePresence } from 'motion/react'
import { WindowOverviewMap } from './canvas/window-overview-map'
import type { Project } from '@/types'

type ProjectAttention = 'unread' | 'done' | 'active' | null

interface ProjectSwitcherItem {
  id: string
  name: string
  path: string
  terminals: number
  browsers: number
  windows: ReturnType<typeof getCanvasWindows>
  isCurrent: boolean
  attention: ProjectAttention
}

function orderProjects(
  projects: Project[],
  activeProjectId: string | null,
  mode: 'recent' | 'chronological',
) {
  if (projects.length === 0) return []

  const current = activeProjectId
    ? projects.find((project) => project.id === activeProjectId)
    : null
  const rest = projects.filter((project) => project.id !== activeProjectId)

  const orderedRest =
    mode === 'recent'
      ? [...rest].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
      : rest

  return current ? [current, ...orderedRest] : orderedRest
}

export function ProjectSwitcher() {
  const projects = useStore((s) => s.projects)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const terminals = useStore((s) => s.terminals)
  const browsers = useStore((s) => s.browsers)
  const switchProject = useStore((s) => s.switchProject)
  const setOverlayOpen = useStore((s) => s.setOverlayOpen)
  const projectSwitchMode = useStore((s) => s.projectSwitchMode)
  const reducedMotion = useStore((s) => s.reducedMotion)

  const [open, setOpenRaw] = useState(false)
  const openRef = useRef(false)
  const setOpen = useCallback(
    (nextOpen: boolean) => {
      openRef.current = nextOpen
      setOpenRaw(nextOpen)
      setOverlayOpen(nextOpen)
    },
    [setOverlayOpen],
  )

  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedIndexRef = useRef(0)
  const selectedIdRef = useRef<string | null>(null)
  const ctrlHeld = useRef(false)
  const mouseActivated = useRef(false)
  const openModeRef = useRef<'manual' | 'cycle' | null>(null)

  const updateSelected = useCallback((index: number, id: string | null) => {
    selectedIndexRef.current = index
    selectedIdRef.current = id
    setSelectedIndex(index)
  }, [])

  const items = useMemo<ProjectSwitcherItem[]>(() => {
    const ordered = orderProjects(projects, activeProjectId, projectSwitchMode)
    return ordered.map((project) => {
      const isCurrent = project.id === activeProjectId
      const projectTerminals = isCurrent ? terminals : project.terminals
      const projectBrowsers = isCurrent ? browsers : project.browsers

      let attention: ProjectAttention = null
      for (const t of projectTerminals) {
        if (t.agentStatus === 'unread') {
          attention = 'unread'
          break
        }
        if (t.agentStatus === 'done') attention = 'done'
        if (t.agentStatus === 'active' && !attention) attention = 'active'
      }

      return {
        id: project.id,
        name: project.name,
        path: project.path,
        terminals: projectTerminals.length,
        browsers: projectBrowsers.length,
        windows: getCanvasWindows(projectTerminals, projectBrowsers),
        isCurrent,
        attention,
      }
    })
  }, [activeProjectId, browsers, projectSwitchMode, projects, terminals])

  const currentId = activeProjectId

  const cycle = useCallback(
    (direction: 1 | -1) => {
      const state = useStore.getState()
      const ordered = orderProjects(
        state.projects,
        state.activeProjectId,
        state.projectSwitchMode,
      ).slice(0, 12)
      if (ordered.length < 2) return

      let nextIdx: number
      if (!openRef.current) {
        nextIdx = direction === 1 ? 1 : ordered.length - 1
        openModeRef.current = 'cycle'
        mouseActivated.current = false
        setOpen(true)
      } else {
        nextIdx =
          (((selectedIndexRef.current + direction) % ordered.length) + ordered.length) %
          ordered.length
      }

      updateSelected(nextIdx, ordered[nextIdx]?.id ?? null)
    },
    [setOpen, updateSelected],
  )

  const cancel = useCallback(() => {
    openModeRef.current = null
    setOpen(false)
    updateSelected(0, null)
  }, [setOpen, updateSelected])

  const commit = useCallback(() => {
    if (openRef.current && selectedIdRef.current && selectedIdRef.current !== currentId) {
      switchProject(selectedIdRef.current)
    }
    openModeRef.current = null
    setOpen(false)
    updateSelected(0, null)
  }, [currentId, setOpen, switchProject, updateSelected])

  const openManual = useCallback(() => {
    if (items.length < 2) return
    const currentIndex = items.findIndex((item) => item.id === currentId)
    openModeRef.current = 'manual'
    mouseActivated.current = false
    setOpen(true)
    updateSelected(currentIndex === -1 ? 0 : currentIndex, currentId)
  }, [currentId, items, setOpen, updateSelected])

  const selectProject = useCallback(
    (id: string) => {
      if (id !== currentId) {
        switchProject(id)
      }
      openModeRef.current = null
      setOpen(false)
      updateSelected(0, null)
    },
    [currentId, setOpen, switchProject, updateSelected],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Backquote' && event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        ctrlHeld.current = true
        cycle(event.shiftKey ? -1 : 1)
        return
      }

      if (
        event.key === 'a' &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault()
        event.stopPropagation()
        if (openRef.current) {
          cancel()
        } else {
          openManual()
        }
        return
      }

      if (event.key === 'Control') {
        ctrlHeld.current = true
      }

      if (!openRef.current) return

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancel()
        return
      }

      const num = Number.parseInt(event.key, 10)
      if (num >= 1 && num <= 9 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        const target = items[num - 1]
        if (target) {
          selectProject(target.id)
        }
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Control') {
        const shouldCommit = openModeRef.current === 'cycle'
        ctrlHeld.current = false
        if (shouldCommit) {
          commit()
        }
      }
    }

    const handleBlur = () => {
      if (ctrlHeld.current && openModeRef.current === 'cycle') {
        ctrlHeld.current = false
        commit()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', handleBlur)
    }
  }, [cancel, commit, cycle, items, openManual, selectProject])

  if (items.length < 2) return null

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={reducedMotion ? false : { opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
          transition={{ duration: reducedMotion ? 0 : 0.12 }}
          className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
        >
          <div
            className="bg-card/92 rounded-xl ring-1 ring-border/40 p-3 pointer-events-auto max-w-[min(98vw,800px)]"
            onMouseMove={() => {
              mouseActivated.current = true
            }}
          >
            <div className="px-1 pb-2 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/35">Projects</span>
              <span className="text-[10px] text-muted-foreground/35">
                {projectSwitchMode === 'recent' ? 'Recent order' : 'Static order'}
              </span>
            </div>

            <div className="px-1 py-2">
              <div className="flex flex-wrap gap-3 items-stretch">
                {items.slice(0, 12).map((item, index) => {
                  const isSelected = index === selectedIndex
                  const number = index + 1

                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => selectProject(item.id)}
                      onMouseEnter={() => {
                        if (mouseActivated.current) updateSelected(index, item.id)
                      }}
                      className={cn(
                        'relative flex h-[132px] w-[188px] shrink-0 flex-col overflow-hidden rounded-lg bg-card text-left transition-all',
                        isSelected
                          ? 'ring-2 ring-primary'
                          : 'border border-border/30 hover:border-border/50',
                      )}
                    >
                      {number <= 9 ? (
                        <kbd
                          className={cn(
                            'absolute top-2 left-2 z-10 flex h-5 min-w-5 items-center justify-center rounded bg-black/45 px-1 text-[10px] font-mono text-white/70',
                            isSelected && 'bg-primary/85 text-primary-foreground',
                          )}
                        >
                          {number}
                        </kbd>
                      ) : null}

                      <div className="flex flex-1 items-center justify-center bg-background/70 px-2 py-2">
                        {item.windows.length > 0 ? (
                          <WindowOverviewMap
                            windows={item.windows}
                            width={164}
                            height={78}
                            className="border-border/20 bg-background/50 rounded-md"
                          />
                        ) : (
                          <div className="flex h-[78px] w-[164px] items-center justify-center rounded-md border border-border/20 bg-background/40">
                            <FolderOpen
                              className={cn(
                                'h-4 w-4',
                                isSelected ? 'text-primary/60' : 'text-muted-foreground/20',
                              )}
                            />
                          </div>
                        )}
                      </div>

                      <div
                        className={cn(
                          'flex min-h-0 flex-col gap-1 bg-card/90 px-2.5 py-2',
                          isSelected ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        <div className="flex items-center gap-1.5">
                          <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                          <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                            {item.name}
                          </span>
                          {!item.isCurrent && item.attention ? (
                            <div
                              className={cn(
                                'h-1.5 w-1.5 shrink-0 rounded-full',
                                item.attention === 'active' && 'bg-primary/90 animate-pulse',
                                item.attention === 'unread' && 'bg-amber-400',
                                item.attention === 'done' && 'bg-emerald-400',
                              )}
                            />
                          ) : item.isCurrent ? (
                            <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
                          ) : null}
                        </div>
                        <div className="truncate text-[10px] text-muted-foreground/40">
                          {item.path}
                        </div>
                        <div className="flex items-center gap-2.5 text-[10px] text-muted-foreground/40">
                          {item.terminals > 0 ? (
                            <span className="flex items-center gap-1">
                              <TerminalSquare className="h-2.5 w-2.5" />
                              {item.terminals}
                            </span>
                          ) : null}
                          {item.browsers > 0 ? (
                            <span className="flex items-center gap-1">
                              <Globe className="h-2.5 w-2.5" />
                              {item.browsers}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="mt-2 px-1 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground/30">
                ⌃` forward, ⌃~ back, ⌃A panel
              </span>
              <span className="text-[10px] text-muted-foreground/30">
                Release ⌃ to switch, 1-9 jump
              </span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
