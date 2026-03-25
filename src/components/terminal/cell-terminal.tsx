import { useEffect, useRef } from 'react'
import { init, Terminal, FitAddon } from 'ghostty-web'
import { useStore, consumePendingCommand } from '@/lib/store'
import { getTerminalTheme } from '@/lib/terminal-themes'

// Initialize WASM lazily on first terminal mount
let ghosttyReady: Promise<void> | null = null
function ensureInit() {
  if (!ghosttyReady) ghosttyReady = init()
  return ghosttyReady
}

function buildTheme(themeName: string) {
  const theme = getTerminalTheme(themeName)
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    selectionBackground: theme.selectionBackground,
    selectionForeground: theme.selectionForeground,
    black: theme.black,
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    blue: theme.blue,
    magenta: theme.magenta,
    cyan: theme.cyan,
    white: theme.white,
    brightBlack: theme.brightBlack,
    brightRed: theme.brightRed,
    brightGreen: theme.brightGreen,
    brightYellow: theme.brightYellow,
    brightBlue: theme.brightBlue,
    brightMagenta: theme.brightMagenta,
    brightCyan: theme.brightCyan,
    brightWhite: theme.brightWhite,
  }
}

// ---- Terminal instance cache ----
// Keeps ghostty Terminal alive across project switches so state (colors,
// scrollback, cursor position, alternate screen) is never lost.
interface CachedTerminal {
  term: Terminal
  fitAddon: FitAddon
  wrapper: HTMLDivElement // the div term.open() was called on
  cleanups: Array<() => void>
}
const terminalCache = new Map<string, CachedTerminal>()

/** Call when a terminal is permanently removed (not just hidden). */
export function destroyCachedTerminal(termId: string) {
  const cached = terminalCache.get(termId)
  if (cached) {
    for (const fn of cached.cleanups) fn()
    cached.term.dispose()
    cached.wrapper.remove()
    terminalCache.delete(termId)
  }
}

interface CellTerminalProps {
  termId: string
  width: number
  height: number
  isFocused: boolean
  onTitleChange?: (title: string) => void
}

export function CellTerminal({
  termId,
  width,
  height,
  isFocused,
  onTitleChange,
}: CellTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const onTitleChangeRef = useRef(onTitleChange)
  const themeName = useStore((s) => s.terminalTheme)
  const fontSize = useStore((s) => s.fontSize)
  const fontFamily = useStore((s) => s.fontFamily)
  const themeNameRef = useRef(themeName)
  const fontSizeRef = useRef(fontSize)
  const fontFamilyRef = useRef(fontFamily)

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange
    themeNameRef.current = themeName
    fontSizeRef.current = fontSize
    fontFamilyRef.current = fontFamily
  }, [onTitleChange, themeName, fontSize, fontFamily])

  // Main lifecycle — create or reattach cached terminal
  useEffect(() => {
    let cancelled = false
    const container = containerRef.current

    async function setup() {
      if (!container) return

      // Check cache first — reattach if exists
      const cached = terminalCache.get(termId)
      if (cached) {
        // Move the existing DOM back into our container
        container.appendChild(cached.wrapper)
        terminalRef.current = cached.term
        fitAddonRef.current = cached.fitAddon

        // Fit first, then get accurate dimensions for attach
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            cached.fitAddon.fit()
            resolve()
          })
        })

        const dims = cached.fitAddon.proposeDimensions()
        const result = await window.cells.terminal.attach(
          termId,
          dims?.cols ?? 80,
          dims?.rows ?? 24,
          useStore.getState().getActiveProjectPath(),
        )

        // Replay any data buffered while this terminal was in another project
        if (result?.buffer) {
          cached.term.write(result.buffer)
        }

        // Resize triggers SIGWINCH for interactive programs to redraw
        if (dims) {
          window.cells.terminal.resize(termId, dims.cols, dims.rows)
        }
        return
      }

      // First time — create new terminal
      await ensureInit()
      if (cancelled) return

      const wrapper = document.createElement('div')
      wrapper.style.width = '100%'
      wrapper.style.height = '100%'
      container.appendChild(wrapper)

      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        fontSize: fontSizeRef.current,
        fontFamily: fontFamilyRef.current,
        theme: buildTheme(themeNameRef.current),
        scrollback: 5000,
      })

      if (cancelled) {
        term.dispose()
        wrapper.remove()
        return
      }

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(wrapper)

      terminalRef.current = term
      fitAddonRef.current = fitAddon

      if (term.textarea) {
        term.textarea.style.opacity = '0'
      }

      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.metaKey) {
          const metaShortcuts = [
            'k',
            'K',
            't',
            'T',
            'w',
            'W',
            'l',
            'L',
            ',',
            'q',
            'Q',
            '0',
            '[',
            ']',
          ]
          if (metaShortcuts.includes(e.key)) return true
        }
        if (e.ctrlKey && e.key === 'Tab') return true
        return false
      })

      // Fit in next frame so the container has layout, then attach with accurate dims
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          if (!cancelled) fitAddon.fit()
          resolve()
        })
      })
      if (cancelled) {
        term.dispose()
        wrapper.remove()
        return
      }

      // These listeners live in the cache — they persist across mount/unmount
      const cleanups: Array<() => void> = []
      cleanups.push(
        term.onTitleChange((title) => {
          onTitleChangeRef.current?.(title || 'Terminal')
        }).dispose,
        term.onData((data) => {
          window.cells.terminal.write(termId, data)
        }).dispose,
        window.cells.terminal.onData((id, data) => {
          if (id === termId) term.write(data)
        }),
        window.cells.terminal.onExit((id) => {
          if (id === termId) {
            term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n')
          }
        }),
      )

      // Agent detection poll
      const agentPoll = setInterval(async () => {
        const proc = await window.cells.terminal.getProcess(termId)
        const agent =
          proc === 'claude' ? ('claude' as const) : proc === 'codex' ? ('codex' as const) : null
        const current = useStore.getState().terminals.find((t) => t.id === termId)
        if (current && current.agent !== agent) {
          useStore.getState().updateTerminalAgent(termId, agent)
        }
      }, 3000)
      cleanups.push(() => clearInterval(agentPoll))

      // Store in cache
      terminalCache.set(termId, { term, fitAddon, wrapper, cleanups })

      const dims = fitAddon.proposeDimensions()
      const projectPath = useStore.getState().getActiveProjectPath()
      const result = await window.cells.terminal.attach(
        termId,
        dims?.cols ?? 80,
        dims?.rows ?? 24,
        projectPath,
      )

      if (result?.reattached && result.buffer) {
        term.write(result.buffer)
      }

      const pendingCmd = consumePendingCommand(termId)
      if (pendingCmd) {
        setTimeout(() => {
          if (!cancelled) window.cells.terminal.write(termId, pendingCmd + '\n')
        }, 150)
      }
    }

    setup()

    return () => {
      cancelled = true
      // DON'T dispose — just detach DOM. Terminal stays alive in cache.
      const cached = terminalCache.get(termId)
      if (cached && container?.contains(cached.wrapper)) {
        container.removeChild(cached.wrapper)
      }
      terminalRef.current = null
      fitAddonRef.current = null
      // Tell main process to buffer instead of sending live IPC
      window.cells.terminal.unsubscribe(termId)
    }
  }, [termId])

  // Theme/font updates
  useEffect(() => {
    const term = terminalRef.current
    if (!term) return

    term.renderer?.setTheme(buildTheme(themeName))

    const fontChanged = term.options.fontSize !== fontSize || term.options.fontFamily !== fontFamily

    if (fontChanged) {
      term.options.fontSize = fontSize
      term.options.fontFamily = fontFamily

      requestAnimationFrame(() => {
        fitAddonRef.current?.fit()
        const dims = fitAddonRef.current?.proposeDimensions()
        if (dims) {
          window.cells.terminal.resize(termId, dims.cols, dims.rows)
        }
      })
    }
  }, [termId, themeName, fontSize, fontFamily])

  // Auto-focus
  useEffect(() => {
    if (isFocused && terminalRef.current) {
      terminalRef.current.focus()
    }
  }, [isFocused])

  // Handle resize
  useEffect(() => {
    if (!fitAddonRef.current || !terminalRef.current) return
    const timer = setTimeout(() => {
      fitAddonRef.current?.fit()
      const dims = fitAddonRef.current?.proposeDimensions()
      if (dims) {
        window.cells.terminal.resize(termId, dims.cols, dims.rows)
      }
    }, 100)
    return () => clearTimeout(timer)
  }, [width, height, termId])

  return <div ref={containerRef} className="w-full h-full" />
}
