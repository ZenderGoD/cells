export type BrowserEvent =
  | { type: 'load-start'; browserId: string; url: string }
  | { type: 'load-stop'; browserId: string; url: string; title: string }
  | { type: 'load-fail'; browserId: string; detail: string }
  | { type: 'console'; browserId: string; detail: string }
  | { type: 'new-window'; browserId: string; url: string }

export interface BrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

type Listener = (event: BrowserEvent) => void

export class WebviewController {
  private webviews = new Map<string, WebviewElement>()
  private listeners = new Set<Listener>()

  register(browserId: string, webview: WebviewElement) {
    this.webviews.set(browserId, webview)
    webview.addEventListener('loadstart', () => {
      this.emit({ type: 'load-start', browserId, url: webview.src ?? '' })
    })
    webview.addEventListener('loadstop', () => {
      this.emit({
        type: 'load-stop',
        browserId,
        url: getWebviewUrl(webview),
        title: getWebviewTitle(webview),
      })
    })
    webview.addEventListener('loadabort', (event: Event) => {
      this.emit({ type: 'load-fail', browserId, detail: JSON.stringify(event) })
    })
    webview.addEventListener('consolemessage', (event: Event) => {
      const message = (event as ConsoleMessageEvent).message ?? ''
      this.emit({ type: 'console', browserId, detail: message })
    })
    webview.addEventListener('newwindow', (event: Event) => {
      const url = (event as NewWindowEvent).targetUrl ?? ''
      this.emit({ type: 'new-window', browserId, url })
    })
  }

  unregister(browserId: string) {
    this.webviews.delete(browserId)
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  navigate(browserId: string, rawUrl: string) {
    const webview = this.requireWebview(browserId)
    webview.src = normalizeUrl(rawUrl)
  }

  back(browserId: string) {
    this.webviews.get(browserId)?.back?.()
  }

  forward(browserId: string) {
    this.webviews.get(browserId)?.forward?.()
  }

  reload(browserId: string) {
    this.webviews.get(browserId)?.reload?.()
  }

  getState(browserId: string): BrowserState | null {
    const webview = this.webviews.get(browserId)
    if (!webview) return null
    return {
      url: getWebviewUrl(webview),
      title: getWebviewTitle(webview),
      canGoBack: Boolean(webview.canGoBack?.()),
      canGoForward: Boolean(webview.canGoForward?.()),
      loading: Boolean(webview.isLoading?.()),
    }
  }

  execute(browserId: string, code: string): Promise<unknown> {
    const webview = this.requireWebview(browserId)
    return new Promise((resolve, reject) => {
      try {
        webview.executeScript({ code }, (results: unknown[]) => resolve(results?.[0]))
      } catch (error) {
        reject(error)
      }
    })
  }

  getElement(browserId: string) {
    return this.webviews.get(browserId) ?? null
  }

  private requireWebview(browserId: string) {
    const webview = this.webviews.get(browserId)
    if (!webview) throw new Error(`Unknown webview: ${browserId}`)
    return webview
  }

  private emit(event: BrowserEvent) {
    for (const listener of this.listeners) listener(event)
  }
}

export function normalizeUrl(rawUrl: string) {
  const trimmed = rawUrl.trim()
  if (!trimmed) return 'about:blank'
  if (/^(https?:\/\/|file:\/\/|about:|data:|chrome-extension:\/\/)/i.test(trimmed)) return trimmed
  if (/^[^\s]+\.[^\s]+$/.test(trimmed) || /^localhost(?::\d+)?/i.test(trimmed)) {
    return `https://${trimmed}`
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

function getWebviewUrl(webview: WebviewElement) {
  return webview.getUrl?.() || webview.src || ''
}

function getWebviewTitle(webview: WebviewElement) {
  return webview.getTitle?.() || ''
}

export interface WebviewElement extends HTMLElement {
  src: string
  back?: () => void
  forward?: () => void
  reload?: () => void
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  isLoading?: () => boolean
  getUrl?: () => string
  getTitle?: () => string
  executeScript: (details: { code: string }, callback?: (results: unknown[]) => void) => void
}

interface ConsoleMessageEvent extends Event {
  message?: string
}

interface NewWindowEvent extends Event {
  targetUrl?: string
}
