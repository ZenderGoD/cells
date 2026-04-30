import { useState, useRef, useCallback, useEffect, type MouseEvent } from 'react'
import { ArrowUpRight, EyeOff, Globe, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { hasPrimaryModifier } from '@/lib/keyboard-shortcuts'
import { useStore } from '@/lib/store'
import type { BrowserNode as BrowserNodeType, BrowserViewFailure } from '@/types'
import { useShallow } from 'zustand/react/shallow'
import { hapticBuzz } from '@/lib/haptics'

const MIN_W = 400
const MIN_H = 300
const HANDLE = 6
const BORDER_W = 3 // px inset for focus ring visibility
const STATUS_BAR_H = 40 // must match toolbar height
const HIBERNATE_DELAY_MS = 15_000
const MAX_WARM_HIDDEN_BROWSERS = 2
const BROWSER_CREATE_RETRY_DELAY_MS = 1_200
const BROWSER_CREATE_TIMEOUT_MS = 8_000

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface WarmBrowserEntry {
  lastActiveAt: number
  isFocused: boolean
  isLive: () => boolean
  suspend: () => Promise<void>
}

const warmBrowserEntries = new Map<string, WarmBrowserEntry>()

function trimWarmBrowsers(exemptId?: string) {
  const hiddenLiveEntries = [...warmBrowserEntries.entries()]
    .filter(([id, entry]) => id !== exemptId && !entry.isFocused && entry.isLive())
    .sort((left, right) => left[1].lastActiveAt - right[1].lastActiveAt)

  const overflow = hiddenLiveEntries.length - MAX_WARM_HIDDEN_BROWSERS
  if (overflow <= 0) return

  for (const [, entry] of hiddenLiveEntries.slice(0, overflow)) {
    void entry.suspend()
  }
}

function getOverlayPauseDetail(owners: string[]) {
  if (owners.includes('command-palette')) return 'The command palette is open.'
  if (owners.includes('command-palette-settings') || owners.includes('toolbar-settings')) {
    return 'Settings is open.'
  }
  if (owners.includes('command-palette-new-project') || owners.includes('toolbar-new-project')) {
    return 'The new project flow is open.'
  }
  if (owners.includes('project-switcher')) return 'The project switcher is open.'
  if (owners.includes('terminal-switcher')) return 'The window switcher is open.'
  if (owners.includes('worktree-switcher')) return 'The worktree switcher is open.'
  if (owners.includes('toolbar-plus-menu')) return 'A toolbar menu is open.'
  if (owners.includes('app-close-dialogs')) return 'A close confirmation is open.'
  if (owners.includes('onboarding-guide')) return 'The onboarding guide is open.'
  if (owners.some((owner) => owner.startsWith('agent-window-color-picker:'))) {
    return 'A color picker is open.'
  }
  return 'A Cells dialog or overlay is open. Close it to resume the page.'
}

interface BrowserNodeProps {
  browser: BrowserNodeType
  scale: number
  selectionMode: boolean
  isSelected: boolean
  isFocused: boolean
  showFocusRing: boolean
  onDragStart: (id: string, kind: 'terminal' | 'browser', startX: number, startY: number) => void
}

export function BrowserNode({
  browser,
  scale,
  selectionMode,
  isSelected,
  isFocused,
  showFocusRing,
  onDragStart,
}: BrowserNodeProps) {
  const {
    resizeBrowser,
    moveBrowser,
    updateBrowserUrl,
    updateBrowserTitle,
    updateBrowserFavicon,
    updateBrowserHistory,
    addBrowserWithUrl,
    focusBrowser,
    togglePin,
  } = useStore(
    useShallow((s) => ({
      resizeBrowser: s.resizeBrowser,
      moveBrowser: s.moveBrowser,
      updateBrowserUrl: s.updateBrowserUrl,
      updateBrowserTitle: s.updateBrowserTitle,
      updateBrowserFavicon: s.updateBrowserFavicon,
      updateBrowserHistory: s.updateBrowserHistory,
      addBrowserWithUrl: s.addBrowserWithUrl,
      focusBrowser: s.focusBrowser,
      togglePin: s.togglePin,
    })),
  )
  const activeProjectId = useStore((s) => s.activeProjectId)
  const arrangeAnimating = useStore((s) => s.arrangeAnimating)
  const overlayOpen = useStore((s) => s.overlayOpen)
  const overlayOwners = useStore((s) => s.overlayOwners)
  const canvas = useStore((s) => s.canvas)
  const titleBarPosition = useStore((s) => s.titleBarPosition)
  const titleBarHidden = useStore((s) => s.titleBarHidden)
  const dragModeActive = selectionMode

  const [isResizing, setIsResizing] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [viewReady, setViewReady] = useState(false)
  const [offline, setOffline] = useState(!navigator.onLine)
  const [failure, setFailure] = useState<BrowserViewFailure | null>(null)
  const [suspended, setSuspended] = useState(false)
  const [overscroll, setOverscroll] = useState<{
    progress: number
    direction: 'back' | 'forward' | null
  }>({ progress: 0, direction: null })
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [transitionHidden, setTransitionHidden] = useState(false)
  const prevFocusedRef = useRef(isFocused)
  const contentRef = useRef<HTMLDivElement>(null)
  const createdRef = useRef(false)
  const lastBoundsRef = useRef({ x: 0, y: 0, width: 0, height: 0 })
  const lastZoomRef = useRef(-1)
  const hibernateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createRetryTimerRef = useRef<number | null>(null)
  const createRunRef = useRef(0)
  const createInFlightRef = useRef(false)
  const mountedRef = useRef(true)
  const isFocusedRef = useRef(isFocused)
  const [createAttempt, setCreateAttempt] = useState(0)

  // Snapshot url/history into refs so the create effect doesn't re-fire on navigation
  const initialUrlRef = useRef(browser.url)
  const initialHistoryRef = useRef(browser.history)
  useEffect(() => {
    initialUrlRef.current = browser.url
  }, [browser.url])
  useEffect(() => {
    initialHistoryRef.current = browser.history
  }, [browser.history])

  useEffect(() => {
    isFocusedRef.current = isFocused
  }, [isFocused])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      createRunRef.current += 1
      createInFlightRef.current = false
    }
  }, [])

  const clearHibernateTimer = useCallback(() => {
    if (hibernateTimerRef.current) {
      window.clearTimeout(hibernateTimerRef.current)
      hibernateTimerRef.current = null
    }
  }, [])

  const clearCreateRetryTimer = useCallback(() => {
    if (createRetryTimerRef.current) {
      window.clearTimeout(createRetryTimerRef.current)
      createRetryTimerRef.current = null
    }
  }, [])

  const resetNativeViewMetrics = useCallback(() => {
    lastBoundsRef.current = { x: 0, y: 0, width: 0, height: 0 }
    lastZoomRef.current = -1
  }, [])

  const hydrateBrowserState = useCallback(async () => {
    try {
      const state = await window.cells.browser.getState(browser.id)
      if (!state) return
      setIsLoading(state.isLoading)
      setCanGoBack(state.canGoBack)
      setCanGoForward(state.canGoForward)
      setFailure(state.failure)
      if (state.url) updateBrowserUrl(browser.id, state.url)
      if (state.title) updateBrowserTitle(browser.id, state.title)
      if (state.faviconUrl) updateBrowserFavicon(browser.id, state.faviconUrl)
    } catch {}
  }, [browser.id, updateBrowserFavicon, updateBrowserTitle, updateBrowserUrl])

  const hibernateView = useCallback(
    async (reason: 'suspended' | 'teardown' = 'suspended') => {
      clearHibernateTimer()
      clearCreateRetryTimer()
      if (!createdRef.current) return
      createdRef.current = false
      setViewReady(false)
      setIsLoading(false)
      setFailure(null)
      setSuspended(reason === 'suspended')
      resetNativeViewMetrics()
      window.cells.browser.setVisible(browser.id, false)
      try {
        const history = await window.cells.browser.getHistory(browser.id)
        if (history?.entries?.length) {
          updateBrowserHistory(browser.id, history)
        }
      } catch {}
      await window.cells.browser.destroy(browser.id)
    },
    [
      browser.id,
      clearCreateRetryTimer,
      clearHibernateTimer,
      resetNativeViewMetrics,
      updateBrowserHistory,
    ],
  )

  useEffect(() => {
    warmBrowserEntries.set(browser.id, {
      lastActiveAt: Date.now(),
      isFocused,
      isLive: () => createdRef.current,
      suspend: () => hibernateView('suspended'),
    })
    return () => {
      warmBrowserEntries.delete(browser.id)
    }
  }, [browser.id, hibernateView, isFocused])

  // Create or unpark WebContentsView only when the browser is focused.
  useEffect(() => {
    if (!activeProjectId || !isFocused || createdRef.current || createInFlightRef.current) return
    clearHibernateTimer()
    clearCreateRetryTimer()
    resetNativeViewMetrics()
    let resetFrame: number | null = window.requestAnimationFrame(() => {
      resetFrame = null
      setFailure(null)
      setSuspended(false)
    })
    createdRef.current = true
    createInFlightRef.current = true
    const createRun = ++createRunRef.current
    const url = initialUrlRef.current
    const history = initialHistoryRef.current
    let createTimeoutTimer: number | null = null

    const createView = Promise.race([
      window.cells.browser.create(browser.id, activeProjectId, history ?? undefined),
      new Promise<never>((_, reject) => {
        createTimeoutTimer = window.setTimeout(() => {
          reject(new Error(`Timed out opening browser view ${browser.id}`))
        }, BROWSER_CREATE_TIMEOUT_MS)
      }),
    ])

    void createView
      .then(async (result: any) => {
        if (!mountedRef.current || createRunRef.current !== createRun) return
        setViewReady(true)
        await hydrateBrowserState()
        if (isFocusedRef.current) window.cells.browser.focus(browser.id)
        // Only navigate on fresh creation, not when unparking (live page is preserved)
        if (!result?.unparked && url) {
          await window.cells.browser.navigate(browser.id, url, useStore.getState().searchEngine)
        }
        const entry = warmBrowserEntries.get(browser.id)
        if (entry) {
          entry.isFocused = true
          entry.lastActiveAt = Date.now()
        }
        trimWarmBrowsers(browser.id)
      })
      .catch((error) => {
        if (!mountedRef.current || createRunRef.current !== createRun) return
        console.error(`Failed to create browser view ${browser.id}`, error)
        createdRef.current = false
        createInFlightRef.current = false
        setViewReady(false)
        setFailure({
          kind: 'load-failed',
          message: 'Browser failed to open. Retrying…',
        })
        setSuspended(false)
        resetNativeViewMetrics()
        window.cells.browser.setVisible(browser.id, false)
        void window.cells.browser.destroy(browser.id).catch(() => {})
        createRetryTimerRef.current = window.setTimeout(() => {
          createRetryTimerRef.current = null
          setCreateAttempt((attempt) => attempt + 1)
        }, BROWSER_CREATE_RETRY_DELAY_MS)
      })
      .finally(() => {
        if (createRunRef.current === createRun) {
          createInFlightRef.current = false
        }
        if (createTimeoutTimer !== null) {
          window.clearTimeout(createTimeoutTimer)
          createTimeoutTimer = null
        }
      })

    return () => {
      if (resetFrame !== null) window.cancelAnimationFrame(resetFrame)
    }
  }, [
    activeProjectId,
    browser.id,
    clearCreateRetryTimer,
    clearHibernateTimer,
    createAttempt,
    hydrateBrowserState,
    isFocused,
    resetNativeViewMetrics,
  ])

  useEffect(() => {
    if (!isFocused || viewReady || failure || offline || suspended) return
    const timer = window.setTimeout(() => {
      if (!isFocusedRef.current || viewReady) return
      console.warn(`Browser view ${browser.id} stayed in opening state; recreating it`)
      createRunRef.current += 1
      createInFlightRef.current = false
      createdRef.current = false
      setViewReady(false)
      setFailure({
        kind: 'load-failed',
        message: 'Browser took too long to open. Retrying…',
      })
      setSuspended(false)
      resetNativeViewMetrics()
      window.cells.browser.setVisible(browser.id, false)
      void window.cells.browser.destroy(browser.id).catch(() => {})
      clearCreateRetryTimer()
      createRetryTimerRef.current = window.setTimeout(() => {
        createRetryTimerRef.current = null
        setCreateAttempt((attempt) => attempt + 1)
      }, BROWSER_CREATE_RETRY_DELAY_MS)
    }, BROWSER_CREATE_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [
    browser.id,
    clearCreateRetryTimer,
    failure,
    isFocused,
    offline,
    resetNativeViewMetrics,
    suspended,
    viewReady,
  ])

  useEffect(() => {
    const entry = warmBrowserEntries.get(browser.id)
    if (entry) {
      entry.isFocused = isFocused
      if (isFocused) {
        entry.lastActiveAt = Date.now()
      }
    }

    if (isFocused) {
      clearHibernateTimer()
      trimWarmBrowsers(browser.id)
      return
    }
    if (!createdRef.current) return
    hibernateTimerRef.current = setTimeout(() => {
      trimWarmBrowsers()
    }, HIBERNATE_DELAY_MS)
    return clearHibernateTimer
  }, [browser.id, clearHibernateTimer, isFocused])

  useEffect(() => {
    return () => {
      clearHibernateTimer()
      clearCreateRetryTimer()
      const state = useStore.getState()
      const browserStillExists =
        state.browsers.some((entry) => entry.id === browser.id) ||
        state.projects.some((project) =>
          (project.browsers ?? []).some((entry) => entry.id === browser.id),
        )
      if (browserStillExists) {
        window.cells.browser.setVisible(browser.id, false)
        void window.cells.browser.park(browser.id).catch(() => {})
        return
      }
      void hibernateView('teardown')
    }
  }, [browser.id, clearCreateRetryTimer, clearHibernateTimer, hibernateView])

  // Detect network loss — hide native view and auto-reload when back online
  useEffect(() => {
    const goOffline = () => setOffline(true)
    const goOnline = () => {
      setOffline(false)
      setFailure(null)
      window.cells.browser.reload(browser.id)
    }
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [browser.id])

  // Listen for title/URL updates and new-window requests
  useEffect(() => {
    const unsubTitle = window.cells.browser.onTitleUpdated((id, title) => {
      if (id === browser.id) updateBrowserTitle(id, title)
    })
    const unsubUrl = window.cells.browser.onUrlChanged((id, url) => {
      if (id === browser.id) updateBrowserUrl(id, url)
    })
    const unsubNewWindow = window.cells.browser.onNewWindow((id, url) => {
      if (id === browser.id) {
        addBrowserWithUrl(url)
      }
    })
    const unsubLoading = window.cells.browser.onLoading((id, loading) => {
      if (id === browser.id) {
        setIsLoading(loading)
        if (loading) setFailure(null)
      }
    })
    const unsubNav = window.cells.browser.onNavState((id, back, forward) => {
      if (id === browser.id) {
        setCanGoBack(back)
        setCanGoForward(forward)
      }
    })
    const unsubFavicon = window.cells.browser.onFaviconUpdated((id, faviconUrl) => {
      if (id === browser.id && faviconUrl) updateBrowserFavicon(id, faviconUrl)
    })
    const unsubLoadFailed = window.cells.browser.onLoadFailed((id, nextFailure) => {
      if (id === browser.id) {
        setFailure(nextFailure)
        setSuspended(false)
      }
    })
    const unsubRenderGone = window.cells.browser.onRenderGone((id, nextFailure) => {
      if (id === browser.id) {
        setFailure(nextFailure)
        setSuspended(false)
      }
    })
    return () => {
      unsubTitle()
      unsubUrl()
      unsubNewWindow()
      unsubLoading()
      unsubNav()
      unsubFavicon()
      unsubLoadFailed()
      unsubRenderGone()
    }
  }, [browser.id, updateBrowserTitle, updateBrowserUrl, updateBrowserFavicon, addBrowserWithUrl])

  // Listen for overscroll gesture progress
  useEffect(() => {
    const unsub = window.cells.browser.onOverscroll((id, progress, direction) => {
      if (id !== browser.id) return
      if (progress <= 0 || !direction) {
        setOverscroll({ progress: 0, direction: null })
      } else {
        setOverscroll({ progress, direction: direction as 'back' | 'forward' })
      }
    })
    return unsub
  }, [browser.id])

  // Hide native view briefly when focus transitions in, so the spring animation is visible
  useEffect(() => {
    if (isFocused && !prevFocusedRef.current && viewReady) {
      const frame = window.requestAnimationFrame(() => {
        setTransitionHidden(true)
      })
      const timer = window.setTimeout(() => setTransitionHidden(false), 250)
      prevFocusedRef.current = isFocused
      return () => {
        window.cancelAnimationFrame(frame)
        window.clearTimeout(timer)
      }
    }
    prevFocusedRef.current = isFocused
  }, [isFocused, viewReady])

  // Track window size so browser bounds update on resize
  const [windowSize, setWindowSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  })
  useEffect(() => {
    const onResize = () =>
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight,
      })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!viewReady || !isFocused) {
      window.cells.browser.setVisible(browser.id, false)
      return
    }

    // Compute screen-space bounds mathematically from known positions
    // (getBoundingClientRect is unreliable during canvas spring animations)
    const s = canvas.scale
    const topInset = !titleBarHidden && titleBarPosition === 'top' ? STATUS_BAR_H : 0
    const bottomInset = !titleBarHidden && titleBarPosition === 'bottom' ? STATUS_BAR_H : 0
    const screenX = browser.x * s + canvas.x
    const screenY = browser.y * s + canvas.y + topInset
    const screenW = browser.width * s
    const screenH = browser.height * s

    const inset = BORDER_W * s
    const minTop = topInset
    const maxRight = windowSize.width
    const maxBottom = windowSize.height - bottomInset
    const rawLeft = screenX + inset
    const rawTop = screenY + inset
    const rawRight = screenX + screenW - inset
    const rawBottom = screenY + screenH - inset
    const bx = Math.max(0, Math.min(maxRight, rawLeft))
    const by = Math.max(minTop, Math.min(maxBottom, rawTop))
    const br = Math.max(bx, Math.min(maxRight, rawRight))
    const bb = Math.max(by, Math.min(maxBottom, rawBottom))
    const bounds = {
      x: Math.round(bx),
      y: Math.round(by),
      width: Math.round(Math.max(0, br - bx)),
      height: Math.round(Math.max(0, bb - by)),
    }
    const last = lastBoundsRef.current
    if (
      bounds.x !== last.x ||
      bounds.y !== last.y ||
      bounds.width !== last.width ||
      bounds.height !== last.height
    ) {
      lastBoundsRef.current = bounds
      window.cells.browser.updateBounds(browser.id, bounds)
    }

    const roundedZoom = Math.round(s * 100) / 100
    if (roundedZoom !== lastZoomRef.current) {
      lastZoomRef.current = roundedZoom
      window.cells.browser.setZoomFactor(browser.id, roundedZoom)
    }

    const shouldBeVisible =
      !overlayOpen &&
      !offline &&
      !failure &&
      !dragModeActive &&
      !suspended &&
      !transitionHidden &&
      bounds.width >= 20 &&
      bounds.height >= 20
    window.cells.browser.setVisible(browser.id, shouldBeVisible)
  }, [
    browser.id,
    browser.x,
    browser.y,
    browser.width,
    browser.height,
    canvas.x,
    canvas.y,
    canvas.scale,
    dragModeActive,
    isFocused,
    offline,
    overlayOpen,
    failure,
    suspended,
    transitionHidden,
    viewReady,
    windowSize.height,
    windowSize.width,
    titleBarHidden,
    titleBarPosition,
  ])

  const handleEdgeMouseDown = useCallback(
    (edge: Edge, e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsResizing(true)

      const startX = e.clientX
      const startY = e.clientY
      const startW = browser.width
      const startH = browser.height
      const startBx = browser.x
      const startBy = browser.y

      const movesLeft = edge.includes('w')
      const movesRight = edge.includes('e')
      const movesTop = edge.includes('n')
      const movesBottom = edge.includes('s')

      const handleMouseMove = (ev: globalThis.MouseEvent) => {
        const dx = (ev.clientX - startX) / scale
        const dy = (ev.clientY - startY) / scale
        let newW = startW,
          newH = startH,
          newX = startBx,
          newY = startBy
        if (movesRight) newW = Math.max(MIN_W, startW + dx)
        if (movesBottom) newH = Math.max(MIN_H, startH + dy)
        if (movesLeft) {
          newW = Math.max(MIN_W, startW - dx)
          newX = startBx + (startW - newW)
        }
        if (movesTop) {
          newH = Math.max(MIN_H, startH - dy)
          newY = startBy + (startH - newH)
        }
        resizeBrowser(browser.id, newW, newH)
        if (movesLeft || movesTop) moveBrowser(browser.id, newX, newY)
      }

      const handleMouseUp = () => {
        setIsResizing(false)
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [
      browser.id,
      browser.width,
      browser.height,
      browser.x,
      browser.y,
      scale,
      resizeBrowser,
      moveBrowser,
    ],
  )

  const handleNodeMouseDown = useCallback(
    (e: MouseEvent) => {
      const modifierDrag = hasPrimaryModifier(e)
      if (!selectionMode && !modifierDrag) {
        focusBrowser(browser.id)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      onDragStart(browser.id, 'browser', e.clientX, e.clientY)
    },
    [focusBrowser, selectionMode, browser.id, onDragStart],
  )

  const zBase = browser.pinned ? 10000 : 0
  const z = zBase + (browser.zIndex ?? 0)

  // Scale up ring widths when zoomed out so borders remain visible
  let ringStyle: React.CSSProperties | undefined
  if (scale < 1) {
    if (isFocused && showFocusRing) {
      const w = Math.min(8, Math.round(2 / scale))
      ringStyle = { boxShadow: `0 0 0 ${w}px var(--color-primary)` }
    } else {
      const w = isSelected
        ? Math.min(10, Math.round(2 / scale))
        : Math.min(6, Math.round(1 / scale))
      ringStyle = {
        ['--tw-ring-shadow' as string]: `0 0 0 calc(${w}px + var(--tw-ring-offset-width, 0px)) var(--tw-ring-color, currentcolor)`,
      }
    }
  }

  const retryBrowser = useCallback(() => {
    setFailure(null)
    setSuspended(false)
    if (createdRef.current) {
      window.cells.browser.reload(browser.id)
    } else {
      setCreateAttempt((attempt) => attempt + 1)
    }
  }, [browser.id])

  let placeholderTitle = browser.title || browser.url || 'New Tab'
  let placeholderDetail: string | null = null
  let showRetry = false

  if (isFocused) {
    if (offline) {
      placeholderTitle = 'Offline'
      placeholderDetail =
        'Connection lost. The page will reload automatically when you are back online.'
    } else if (failure) {
      placeholderTitle = failure.kind === 'crashed' ? 'Page Unavailable' : 'Navigation Failed'
      placeholderDetail = failure.message
      showRetry = true
    } else if (suspended && !viewReady) {
      placeholderTitle = 'Resuming Browser…'
      placeholderDetail = 'This tab was paused to keep browser performance predictable.'
    } else if (overlayOpen) {
      placeholderTitle = 'Browser Paused'
      placeholderDetail = getOverlayPauseDetail(overlayOwners)
    } else if (dragModeActive) {
      placeholderTitle = 'Selection Mode Active'
      placeholderDetail = 'Drag on the canvas to move this panel.'
    } else if (transitionHidden) {
      placeholderTitle = 'Switching…'
      placeholderDetail = 'Finishing the focus transition.'
    } else if (!viewReady) {
      placeholderTitle = 'Opening Browser…'
      placeholderDetail = 'Reattaching the page.'
    }
  }

  return (
    <div
      data-browser-id={browser.id}
      className={cn(
        'browser-node absolute',
        isResizing && 'pointer-events-none',
        dragModeActive && 'cursor-grab',
      )}
      style={{
        left: browser.x,
        top: browser.y,
        width: browser.width,
        height: browser.height,
        zIndex: z,
        transition: arrangeAnimating
          ? 'left 300ms cubic-bezier(0.4, 0, 0.2, 1), top 300ms cubic-bezier(0.4, 0, 0.2, 1)'
          : undefined,
      }}
      onMouseDown={handleNodeMouseDown}
    >
      {dragModeActive && <div className="absolute inset-0 z-10 cursor-grab" />}

      {/* Content area — WebContentsView covers this when focused.
          Always dark bg so hiding the native view (popover/overlay) doesn't flash white. */}
      <div
        ref={contentRef}
        className={cn(
          'w-full h-full rounded-lg overflow-hidden bg-background relative',
          isFocused && showFocusRing
            ? 'window-focused'
            : isFocused
              ? 'ring-1 ring-white/10'
              : 'ring-1 ring-border/20',
          isSelected && 'ring-2 ring-primary/70 ring-offset-1 ring-offset-background',
        )}
        style={ringStyle}
      >
        {/* Pin control — top right corner */}
        <div
          className={cn(
            'absolute top-1.5 right-1.5 z-20 flex items-center gap-1 transition-opacity',
            isFocused ? 'opacity-100' : 'opacity-0 hover:opacity-100',
          )}
        >
          <button
            className="p-1 rounded-md backdrop-blur-sm transition-colors cursor-pointer text-muted-foreground/40 bg-background/50 hover:text-foreground hover:bg-background/70"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              hapticBuzz()
              togglePin(browser.id, 'browser')
            }}
            title="Pop out to separate window"
          >
            <ArrowUpRight className="w-3 h-3" />
          </button>
        </div>

        {/* Loading indicator — traces entire border starting from bottom-left */}
        {isLoading && (
          <svg
            className="absolute inset-0 z-30 pointer-events-none animate-border-trace"
            style={{ width: '100%', height: '100%' }}
            viewBox={`0 0 ${browser.width} ${browser.height}`}
            preserveAspectRatio="none"
          >
            <rect
              x="1"
              y="1"
              width={browser.width - 2}
              height={browser.height - 2}
              rx="8"
              ry="8"
              fill="none"
              stroke="oklch(0.65 0.18 250)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              pathLength="1"
              strokeDasharray="0.25 0.75"
              strokeDashoffset="0"
              style={{ filter: 'drop-shadow(0 0 4px oklch(0.65 0.18 250 / 0.5))' }}
            />
          </svg>
        )}
        {/* Placeholder shown when native view is hidden */}
        {(!isFocused ||
          !viewReady ||
          overlayOpen ||
          offline ||
          !!failure ||
          suspended ||
          dragModeActive ||
          transitionHidden) && (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-5 text-center">
            {offline ? (
              <WifiOff className="w-8 h-8 text-muted-foreground/30" />
            ) : failure ? (
              <EyeOff className="w-6 h-6 text-muted-foreground/25" />
            ) : (dragModeActive || suspended) && isFocused ? (
              <EyeOff className="w-6 h-6 text-muted-foreground/25" />
            ) : isFocused && !viewReady ? (
              <div className="w-5 h-5 border-2 border-muted-foreground/20 border-t-muted-foreground/60 rounded-full animate-spin" />
            ) : (
              <Globe className="w-8 h-8 text-muted-foreground/20" />
            )}
            <span className="max-w-[85%] text-[11px] font-medium text-muted-foreground/50">
              {placeholderTitle}
            </span>
            {placeholderDetail && (
              <span className="max-w-[85%] text-[10px] leading-4 text-muted-foreground/30">
                {placeholderDetail}
              </span>
            )}
            {showRetry && (
              <button
                className="mt-2 rounded-md border border-border/40 bg-background/60 px-2.5 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  retryBrowser()
                }}
              >
                Retry
              </button>
            )}
          </div>
        )}

        {/* Overscroll gesture indicators — bottom edge corner glows */}
        {overscroll.direction === 'back' && overscroll.progress > 0 && canGoBack && (
          <div
            className="absolute inset-x-0 bottom-0 z-20 pointer-events-none rounded-b-lg"
            style={{
              height: 80,
              opacity: 0.2 + Math.min(overscroll.progress, 1.1) * 0.6,
              background:
                'radial-gradient(ellipse 55% 130% at 0% 100%, oklch(0.72 0.16 220) 0%, transparent 100%)',
            }}
          />
        )}
        {overscroll.direction === 'forward' && overscroll.progress > 0 && canGoForward && (
          <div
            className="absolute inset-x-0 bottom-0 z-20 pointer-events-none rounded-b-lg"
            style={{
              height: 80,
              opacity: 0.2 + Math.min(overscroll.progress, 1.1) * 0.6,
              background:
                'radial-gradient(ellipse 55% 130% at 100% 100%, oklch(0.78 0.15 85) 0%, transparent 100%)',
            }}
          />
        )}
      </div>

      {/* Resize handles — edges */}
      <div
        className="absolute z-30 cursor-n-resize"
        style={{ top: -HANDLE / 2, left: HANDLE, right: HANDLE, height: HANDLE }}
        onMouseDown={(e) => handleEdgeMouseDown('n', e)}
      />
      <div
        className="absolute z-30 cursor-s-resize"
        style={{ bottom: -HANDLE / 2, left: HANDLE, right: HANDLE, height: HANDLE }}
        onMouseDown={(e) => handleEdgeMouseDown('s', e)}
      />
      <div
        className="absolute z-30 cursor-w-resize"
        style={{ left: -HANDLE / 2, top: HANDLE, bottom: HANDLE, width: HANDLE }}
        onMouseDown={(e) => handleEdgeMouseDown('w', e)}
      />
      <div
        className="absolute z-30 cursor-e-resize"
        style={{ right: -HANDLE / 2, top: HANDLE, bottom: HANDLE, width: HANDLE }}
        onMouseDown={(e) => handleEdgeMouseDown('e', e)}
      />

      {/* Resize handles — corners */}
      <div
        className="absolute z-30 cursor-nw-resize"
        style={{ top: -HANDLE / 2, left: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 }}
        onMouseDown={(e) => handleEdgeMouseDown('nw', e)}
      />
      <div
        className="absolute z-30 cursor-ne-resize"
        style={{ top: -HANDLE / 2, right: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 }}
        onMouseDown={(e) => handleEdgeMouseDown('ne', e)}
      />
      <div
        className="absolute z-30 cursor-sw-resize"
        style={{ bottom: -HANDLE / 2, left: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 }}
        onMouseDown={(e) => handleEdgeMouseDown('sw', e)}
      />
      <div
        className="absolute z-30 cursor-se-resize"
        style={{ bottom: -HANDLE / 2, right: -HANDLE / 2, width: HANDLE * 2, height: HANDLE * 2 }}
        onMouseDown={(e) => handleEdgeMouseDown('se', e)}
      />
    </div>
  )
}
