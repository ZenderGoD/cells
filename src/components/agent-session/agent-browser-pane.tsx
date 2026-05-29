import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ArrowLeft, ArrowRight, EyeOff, Globe2, Loader2, RefreshCw, X } from 'lucide-react'
import type { AgentBrowserDock, AgentBrowserSessionState, BrowserViewFailure } from '@/types'
import {
  getAgentBrowserController,
  registerAgentBrowserController,
  updateAgentBrowserRuntimeState,
  type AgentBrowserController,
} from '@/lib/agent-browser-runtime'
import {
  NW_PICKER_CANCELLED_MARKER,
  NW_PICKER_SELECTED_MARKER,
  buildElementPickerScript,
} from '@/lib/nw-element-picker'
import { cn } from '@/lib/utils'

interface NwAgentBrowserWebview extends HTMLElement {
  src: string
  back?: () => void
  forward?: () => void
  reload?: () => void
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  getUrl?: () => string
  getTitle?: () => string
  executeScript?: (
    details: { code: string } | string,
    callback?: (result: unknown[]) => void,
  ) => void
  captureVisibleRegion?: (optionsOrCallback?: unknown, callback?: (dataUrl: string) => void) => void
}

const AGENT_BROWSER_HIBERNATE_MS = 5 * 60 * 1000
const HIDDEN_VIEWPORT = { width: 1280, height: 900 }
const RIGHT_DOCK_SPLIT_RATIO = 0.42
const BOTTOM_DOCK_SPLIT_RATIO = 0.4
const CAPTURE_TIMEOUT_MS = 2_500
const FALLBACK_SCREENSHOT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

interface BrowserScreenshotSummary {
  url: string
  title: string
  text: string
}

function browserTitle(state: AgentBrowserSessionState) {
  if (state.title) return state.title
  try {
    const url = new URL(state.url)
    return url.hostname || state.url
  } catch {
    return state.url || 'Browser'
  }
}

function browserDetail(state: AgentBrowserSessionState) {
  try {
    const url = new URL(state.url)
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return state.url || 'about:blank'
  }
}

function getWebviewUrl(webview: NwAgentBrowserWebview, fallback: string) {
  return webview.getUrl?.() || webview.src || fallback
}

function getWebviewTitle(webview: NwAgentBrowserWebview, fallback: string) {
  return webview.getTitle?.() || fallback || getWebviewUrl(webview, fallback)
}

function syncHistory(
  history: AgentBrowserSessionState['history'],
  url: string,
  title: string,
  mode: 'push' | 'replace' = 'push',
) {
  const entries = history.entries.length
    ? history.entries.map((entry) => ({ ...entry }))
    : [{ url, title }]
  let activeIndex = Math.min(Math.max(0, history.activeIndex), entries.length - 1)
  const active = entries[activeIndex]
  if (mode === 'replace' && active) {
    entries[activeIndex] = { url, title }
  } else if (active?.url === url) {
    entries[activeIndex] = { url, title }
  } else {
    entries.splice(activeIndex + 1)
    entries.push({ url, title })
    activeIndex = entries.length - 1
  }
  if (entries.length > 100) {
    const overflow = entries.length - 100
    entries.splice(0, overflow)
    activeIndex = Math.max(0, activeIndex - overflow)
  }
  return { entries, activeIndex }
}

function defaultSplitRatioForDock(dock: AgentBrowserDock) {
  return dock === 'bottom' ? BOTTOM_DOCK_SPLIT_RATIO : RIGHT_DOCK_SPLIT_RATIO
}

function effectiveSplitRatio(state: AgentBrowserSessionState, dock: AgentBrowserDock) {
  return state.dock === dock ? state.splitRatio : defaultSplitRatioForDock(dock)
}

function captureWebviewVisibleRegion(webview: NwAgentBrowserWebview) {
  if (typeof webview.captureVisibleRegion !== 'function')
    return Promise.resolve<string | null>(null)

  const attempt = (withOptions: boolean) =>
    new Promise<string | null>((resolve) => {
      let settled = false
      const finish = (dataUrl: unknown) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve(typeof dataUrl === 'string' && dataUrl.length > 32 ? dataUrl : null)
      }
      const timer = window.setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS)
      try {
        if (withOptions) webview.captureVisibleRegion?.({ format: 'png' }, finish)
        else webview.captureVisibleRegion?.(finish)
      } catch {
        finish(null)
      }
    })

  return attempt(true).then((dataUrl) => dataUrl ?? attempt(false))
}

function captureBrowserSummaryImage(
  state: AgentBrowserSessionState,
  summary: BrowserScreenshotSummary | null,
) {
  const canvas = document.createElement('canvas')
  canvas.width = HIDDEN_VIEWPORT.width
  canvas.height = HIDDEN_VIEWPORT.height
  const context = canvas.getContext('2d')
  if (!context) return FALLBACK_SCREENSHOT

  const url = summary?.url || state.url || 'about:blank'
  const title = summary?.title || browserTitle(state)
  const text = (summary?.text || '').replace(/\s+/g, ' ').trim()

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#111827'
  context.font = '600 30px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  context.fillText(title.slice(0, 90), 40, 58)
  context.fillStyle = '#4b5563'
  context.font = '18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  context.fillText(url.slice(0, 130), 40, 92)
  context.strokeStyle = '#e5e7eb'
  context.beginPath()
  context.moveTo(40, 122)
  context.lineTo(canvas.width - 40, 122)
  context.stroke()
  context.fillStyle = '#1f2937'
  context.font = '20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

  const words = text || 'No page text was available for the fallback browser capture.'
  const lines: string[] = []
  let line = ''
  for (const word of words.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (context.measureText(next).width > canvas.width - 80) {
      if (line) lines.push(line)
      line = word
    } else {
      line = next
    }
    if (lines.length >= 30) break
  }
  if (line && lines.length < 30) lines.push(line)
  lines.forEach((entry, index) => context.fillText(entry, 40, 166 + index * 28))

  try {
    return canvas.toDataURL('image/png')
  } catch {
    return FALLBACK_SCREENSHOT
  }
}

export function AgentBrowserPane({
  state,
  projectId,
  isRunning,
  dock,
}: {
  state: AgentBrowserSessionState
  projectId: string | null
  isRunning: boolean
  dock: AgentBrowserDock
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<NwAgentBrowserWebview | null>(null)
  const stateRef = useRef(state)
  const [mounted, setMounted] = useState(true)
  const visible = state.visible
  const currentSplitRatio = effectiveSplitRatio(state, dock)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    if (visible || isRunning) {
      setMounted(true)
      return
    }
    const timer = window.setTimeout(() => setMounted(false), AGENT_BROWSER_HIBERNATE_MS)
    return () => window.clearTimeout(timer)
  }, [isRunning, state.updatedAt, visible])

  useEffect(() => {
    if (state.updatedAt) setMounted(true)
  }, [state.updatedAt])

  const patchState = useCallback(
    (patch: Partial<AgentBrowserSessionState>) => {
      stateRef.current = updateAgentBrowserRuntimeState(state.agentWindowId, patch)
    },
    [state.agentWindowId],
  )

  const executeScript = useCallback(async <T,>(code: string, timeoutMs = 5_000): Promise<T> => {
    const webview = webviewRef.current
    if (!webview?.executeScript) throw new Error('Codex browser webview is not ready.')
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = window.setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('Browser script timed out.'))
      }, timeoutMs)
      const finish = (result: unknown[]) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve((Array.isArray(result) ? result[0] : result) as T)
      }
      try {
        webview.executeScript?.({ code }, finish)
      } catch {
        try {
          webview.executeScript?.(code, finish)
        } catch (error) {
          if (!settled) {
            settled = true
            window.clearTimeout(timer)
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        }
      }
    })
  }, [])

  const captureVisibleRegion = useCallback(async () => {
    const webview = webviewRef.current
    if (webview) {
      const dataUrl = await captureWebviewVisibleRegion(webview)
      if (dataUrl) return dataUrl
    }

    const summary = await executeScript<BrowserScreenshotSummary>(
      `(() => ({
        url: location.href,
        title: document.title || location.href,
        text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 4000)
      }))()`,
      1_500,
    ).catch(() => null)
    return captureBrowserSummaryImage(stateRef.current, summary)
  }, [executeScript])

  useEffect(() => {
    if (!mounted) return
    const webview = webviewRef.current
    if (!webview) return

    const controller: AgentBrowserController = {
      agentWindowId: state.agentWindowId,
      navigate: async (url) => {
        await new Promise<void>((resolve) => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            window.clearTimeout(timer)
            webview.removeEventListener('loadstop', finish)
            webview.removeEventListener('loadabort', finish)
            resolve()
          }
          const timer = window.setTimeout(finish, 4_000)
          webview.addEventListener('loadstop', finish)
          webview.addEventListener('loadabort', finish)
          webview.src = url
          patchState({ url, isLoading: true, failure: null })
        })
      },
      goBack: async () => {
        if (webview.canGoBack?.()) webview.back?.()
      },
      goForward: async () => {
        if (webview.canGoForward?.()) webview.forward?.()
      },
      reload: async () => webview.reload?.(),
      focus: async () => webview.focus?.(),
      startElementPicker: async (targetAgentWindowId) => {
        const result = await executeScript<boolean>(
          buildElementPickerScript(targetAgentWindowId),
          5_000,
        )
        return result !== false
      },
      cancelElementPicker: async () => {
        await executeScript(
          'window.__cellsNwElementPickerCancel && window.__cellsNwElementPickerCancel(true)',
          1_000,
        ).catch(() => {})
      },
      executeScript,
      captureVisibleRegion,
      getState: () => stateRef.current,
    }
    return registerAgentBrowserController(controller)
  }, [captureVisibleRegion, executeScript, mounted, patchState, state.agentWindowId])

  useEffect(() => {
    if (!mounted) return
    const webview = webviewRef.current
    if (!webview) return
    const nextUrl = state.url || 'about:blank'
    if (getWebviewUrl(webview, '') !== nextUrl) webview.src = nextUrl
  }, [mounted, state.url])

  useEffect(() => {
    if (!mounted) return
    const webview = webviewRef.current
    if (!webview) return

    const updateFromWebview = (loading?: boolean) => {
      const url = getWebviewUrl(webview, stateRef.current.url)
      const title = getWebviewTitle(webview, stateRef.current.title)
      const history = syncHistory(stateRef.current.history, url, title)
      patchState({
        url,
        title,
        isLoading: loading ?? stateRef.current.isLoading,
        canGoBack: Boolean(webview.canGoBack?.()) || history.activeIndex > 0,
        canGoForward:
          Boolean(webview.canGoForward?.()) || history.activeIndex < history.entries.length - 1,
        failure: null,
        history,
      })
    }

    const handleLoadStart = () => patchState({ isLoading: true, failure: null })
    const handleLoadStop = () => updateFromWebview(false)
    const handleLoadAbort = (event: Event) => {
      const detail = event as Event & { reason?: string; url?: string; code?: number }
      const failure: BrowserViewFailure = {
        kind: 'load-failed',
        message: 'Browser navigation failed.',
        reason: typeof detail.reason === 'string' ? detail.reason : null,
        url: typeof detail.url === 'string' ? detail.url : stateRef.current.url,
        code: typeof detail.code === 'number' ? detail.code : null,
      }
      patchState({ isLoading: false, failure })
    }
    const handleFocus = () => patchState({ lastActiveAt: Date.now() })
    const handleNewWindow = (event: Event) => {
      const detail = event as Event & { targetUrl?: string }
      if (typeof detail.targetUrl === 'string') {
        webview.src = detail.targetUrl
        patchState({ url: detail.targetUrl, isLoading: true })
      }
    }
    const handleConsoleMessage = (event: Event) => {
      const message = String((event as { message?: string }).message ?? '')
      if (message.startsWith(NW_PICKER_SELECTED_MARKER)) {
        try {
          const payload = JSON.parse(message.slice(NW_PICKER_SELECTED_MARKER.length)) as {
            targetAgentWindowId?: string | null
            selection?: unknown
          }
          if (payload.selection) {
            window.dispatchEvent(
              new CustomEvent('cells-nw-browser-event', {
                detail: {
                  browserId: stateRef.current.id,
                  kind: 'element-selected',
                  targetAgentWindowId: payload.targetAgentWindowId ?? null,
                  selection: payload.selection,
                },
              }),
            )
          }
        } catch {}
        return
      }
      if (message.startsWith(NW_PICKER_CANCELLED_MARKER)) {
        try {
          const payload = JSON.parse(message.slice(NW_PICKER_CANCELLED_MARKER.length)) as {
            targetAgentWindowId?: string | null
          }
          window.dispatchEvent(
            new CustomEvent('cells-nw-browser-event', {
              detail: {
                browserId: stateRef.current.id,
                kind: 'element-picker-cancelled',
                targetAgentWindowId: payload.targetAgentWindowId ?? null,
              },
            }),
          )
        } catch {
          window.dispatchEvent(
            new CustomEvent('cells-nw-browser-event', {
              detail: {
                browserId: stateRef.current.id,
                kind: 'element-picker-cancelled',
                targetAgentWindowId: null,
              },
            }),
          )
        }
      }
    }

    webview.addEventListener('loadstart', handleLoadStart)
    webview.addEventListener('loadstop', handleLoadStop)
    webview.addEventListener('loadabort', handleLoadAbort)
    webview.addEventListener('focus', handleFocus)
    webview.addEventListener('newwindow', handleNewWindow)
    webview.addEventListener('consolemessage', handleConsoleMessage)
    const timer = window.setTimeout(() => updateFromWebview(false), 250)
    return () => {
      window.clearTimeout(timer)
      webview.removeEventListener('loadstart', handleLoadStart)
      webview.removeEventListener('loadstop', handleLoadStop)
      webview.removeEventListener('loadabort', handleLoadAbort)
      webview.removeEventListener('focus', handleFocus)
      webview.removeEventListener('newwindow', handleNewWindow)
      webview.removeEventListener('consolemessage', handleConsoleMessage)
    }
  }, [mounted, patchState])

  const handleClose = useCallback(() => {
    void window.cells.agentBrowser.hide(state.agentWindowId)
  }, [state.agentWindowId])

  const handleDestroy = useCallback(() => {
    void window.cells.agentBrowser.destroy(state.agentWindowId)
  }, [state.agentWindowId])

  const handleNavigatePrompt = useCallback(() => {
    const next = window.prompt(
      'Open URL',
      state.url && state.url !== 'about:blank' ? state.url : '',
    )
    if (next === null) return
    void window.cells.agentBrowser.navigate(state.agentWindowId, next)
  }, [state.agentWindowId, state.url])

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const start = dock === 'right' ? event.clientX : event.clientY
      const startRatio = currentSplitRatio
      const ownerRect = rootRef.current?.parentElement?.getBoundingClientRect()
      const ownerSize = Math.max(
        1,
        dock === 'right'
          ? (ownerRect?.width ?? window.innerWidth)
          : (ownerRect?.height ?? window.innerHeight),
      )
      const onMove = (moveEvent: globalThis.PointerEvent) => {
        const current = dock === 'right' ? moveEvent.clientX : moveEvent.clientY
        const delta = start - current
        const nextRatio = Math.min(0.7, Math.max(0.25, startRatio + delta / ownerSize))
        void window.cells.agentBrowser.ensure(state.agentWindowId, {
          splitRatio: nextRatio,
          dock,
        })
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
      document.body.style.cursor = dock === 'right' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [currentSplitRatio, dock, state.agentWindowId],
  )

  const paneStyle = useMemo(
    () =>
      dock === 'right'
        ? { width: `${Math.round(currentSplitRatio * 100)}%` }
        : { height: `${Math.round(currentSplitRatio * 100)}%` },
    [currentSplitRatio, dock],
  )

  const webview = mounted ? (
    <webview
      ref={webviewRef as React.RefObject<HTMLElement>}
      src={state.url || 'about:blank'}
      partition={`persist:nw-${projectId ?? 'default'}`}
      className="block h-full w-full bg-white"
    />
  ) : null

  return (
    <div
      ref={rootRef}
      aria-hidden={visible ? undefined : true}
      className={cn(
        visible
          ? 'relative z-20 flex shrink-0 overflow-hidden border-border/35 bg-background/96'
          : 'fixed pointer-events-none opacity-0',
        visible
          ? dock === 'right'
            ? 'h-full min-w-[320px] max-w-[70%] border-l'
            : 'min-h-[240px] w-full max-h-[70%] flex-col border-t'
          : null,
      )}
      style={
        visible
          ? paneStyle
          : {
              left: -20_000,
              top: 0,
              width: HIDDEN_VIEWPORT.width,
              height: HIDDEN_VIEWPORT.height,
            }
      }
    >
      {visible ? (
        <div
          className={cn(
            'absolute z-30 bg-transparent',
            dock === 'right'
              ? 'left-0 top-0 h-full w-1.5 cursor-col-resize'
              : 'left-0 top-0 h-1.5 w-full cursor-row-resize',
          )}
          onPointerDown={handleResizeStart}
        />
      ) : null}
      <div className={cn('min-w-0 flex-1', visible ? 'flex h-full flex-col' : 'h-full w-full')}>
        {visible ? (
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/35 bg-background/88 px-2">
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-[7px] text-muted-foreground/75 hover:bg-foreground/8 hover:text-foreground disabled:opacity-35"
              title="Back"
              aria-label="Back"
              disabled={!state.canGoBack}
              onClick={() => void getAgentBrowserControllerAction(state.agentWindowId, 'back')}
            >
              <ArrowLeft className="size-3.5" />
            </button>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-[7px] text-muted-foreground/75 hover:bg-foreground/8 hover:text-foreground disabled:opacity-35"
              title="Forward"
              aria-label="Forward"
              disabled={!state.canGoForward}
              onClick={() => void getAgentBrowserControllerAction(state.agentWindowId, 'forward')}
            >
              <ArrowRight className="size-3.5" />
            </button>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-[7px] text-muted-foreground/75 hover:bg-foreground/8 hover:text-foreground"
              title="Reload"
              aria-label="Reload"
              onClick={() => void getAgentBrowserControllerAction(state.agentWindowId, 'reload')}
            >
              <RefreshCw className="size-3.5" />
            </button>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-[7px] bg-foreground/5 px-2 py-1 text-left hover:bg-foreground/8"
              onClick={handleNavigatePrompt}
              title={state.url}
            >
              {state.isLoading ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground/65" />
              ) : (
                <Globe2 className="size-3.5 shrink-0 text-muted-foreground/65" />
              )}
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground/85">
                {browserTitle(state)}
              </span>
              <span className="hidden max-w-[45%] truncate text-[10.5px] text-muted-foreground/55 lg:block">
                {browserDetail(state)}
              </span>
            </button>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-[7px] text-muted-foreground/75 hover:bg-foreground/8 hover:text-foreground"
              title="Hide browser"
              aria-label="Hide browser"
              onClick={handleClose}
            >
              <EyeOff className="size-3.5" />
            </button>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-[7px] text-muted-foreground/75 hover:bg-red-500/10 hover:text-red-200"
              title="Close browser"
              aria-label="Close browser"
              onClick={handleDestroy}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
        <div
          key="agent-browser-webview-frame"
          className={cn('relative', visible ? 'min-h-0 flex-1' : 'h-full w-full')}
        >
          {webview}
          {visible && !mounted ? (
            <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground/60">
              Browser hibernated
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

async function getAgentBrowserControllerAction(
  agentWindowId: string,
  action: 'back' | 'forward' | 'reload',
) {
  const controller = getAgentBrowserController(agentWindowId)
  if (controller) {
    if (action === 'back') await controller.goBack()
    else if (action === 'forward') await controller.goForward()
    else await controller.reload()
    return
  }
  const state = window.cells ? await window.cells.agentBrowser.getState(agentWindowId) : null
  if (!state) return
  if (action === 'back') {
    const history = state.history
    const nextIndex = history.activeIndex - 1
    if (nextIndex >= 0) {
      await window.cells.agentBrowser.navigate(
        agentWindowId,
        history.entries[nextIndex]?.url ?? state.url,
      )
    }
    return
  }
  if (action === 'forward') {
    const history = state.history
    const nextIndex = history.activeIndex + 1
    if (nextIndex < history.entries.length) {
      await window.cells.agentBrowser.navigate(
        agentWindowId,
        history.entries[nextIndex]?.url ?? state.url,
      )
    }
    return
  }
  await window.cells.agentBrowser.navigate(agentWindowId, state.url)
}
