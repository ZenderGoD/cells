import { useCallback, useEffect, useRef, useState } from 'react'
import { init, Terminal, FitAddon, UrlRegexProvider, OSC8LinkProvider } from 'ghostty-web'
import type { ILinkProvider, ILink } from 'ghostty-web'
import { useStore, consumePendingCommand } from '@/lib/store'
import { getTerminalTheme } from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'

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

/** Apply a theme to every cached terminal instance (mounted or not). */
export function applyThemeToAllTerminals(themeName: string) {
  const theme = buildTheme(themeName)
  for (const [, cached] of terminalCache) {
    cached.term.options.theme = theme
  }
}

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

type AgentName = 'claude' | 'codex'

const COMMON_SHELL_COMMANDS = new Set([
  'awk',
  'bash',
  'brew',
  'bun',
  'cargo',
  'cat',
  'cd',
  'chmod',
  'claude',
  'clear',
  'codex',
  'cp',
  'curl',
  'docker',
  'find',
  'git',
  'go',
  'grep',
  'just',
  'kubectl',
  'less',
  'ls',
  'make',
  'mkdir',
  'mv',
  'node',
  'npm',
  'npx',
  'open',
  'pnpm',
  'python',
  'python3',
  'rg',
  'rm',
  'sed',
  'touch',
  'vim',
  'yarn',
  'zsh',
])

const CODEX_SUBCOMMANDS = new Set([
  'app',
  'app-server',
  'apply',
  'cloud',
  'completion',
  'debug',
  'exec',
  'features',
  'fork',
  'help',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'resume',
  'review',
  'sandbox',
])

const CLAUDE_SUBCOMMANDS = new Set([
  'agents',
  'auth',
  'auto-mode',
  'doctor',
  'help',
  'install',
  'mcp',
  'plugin',
  'plugins',
  'setup-token',
  'update',
  'upgrade',
])

function getAgentLabel(agent: AgentName) {
  return agent === 'claude' ? 'Claude' : 'Codex'
}

const ESCAPE_CHAR = String.fromCharCode(27)
const NULL_CHAR = String.fromCharCode(0)
const ANSI_CSI_SEQUENCE_RE = new RegExp(`${ESCAPE_CHAR}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const ANSI_ESCAPE_RE = new RegExp(`${ESCAPE_CHAR}[@-_]`, 'g')
const NULL_CHAR_RE = new RegExp(NULL_CHAR, 'g')

function summarizeTitle(input: string, maxLength = 60) {
  const collapsed = input
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
  if (!collapsed) return ''
  if (collapsed.length <= maxLength) return collapsed
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`
}

function formatAgentWindowTitle(agent: AgentName, title: string, maxLength = 60) {
  const summary = summarizeTitle(title, maxLength)
  return summary ? `${getAgentLabel(agent)}: ${summary}` : getAgentLabel(agent)
}

function normalizeAgentProcess(proc: string | null): AgentName | null {
  if (!proc) return null
  const normalized = proc.toLowerCase().split('/').pop() ?? proc.toLowerCase()
  if (normalized === 'claude' || normalized.startsWith('claude-')) return 'claude'
  if (normalized === 'codex' || normalized === 'codex-cli' || normalized.startsWith('codex-')) {
    return 'codex'
  }
  return null
}

function inferAgentLaunch(line: string): { agent: AgentName; title: string } | null {
  const trimmed = line.trim()
  const match = trimmed.match(
    /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+))\s+)*(?<cmd>(?:\S*\/)?(?:claude|codex))(?=\s|$)\s*(?<rest>.*)$/i,
  )
  if (!match?.groups) return null

  const agent = normalizeAgentProcess(match.groups.cmd) ?? null
  if (!agent) return null

  const rest = (match.groups.rest ?? '').trim()
  const firstToken = rest.split(/\s+/, 1)[0]?.toLowerCase()
  const knownSubcommands = agent === 'claude' ? CLAUDE_SUBCOMMANDS : CODEX_SUBCOMMANDS
  const prompt =
    rest && !rest.startsWith('-') && firstToken && !knownSubcommands.has(firstToken)
      ? summarizeTitle(rest)
      : ''

  return {
    agent,
    title: prompt ? `${getAgentLabel(agent)}: ${prompt}` : getAgentLabel(agent),
  }
}

function inferAgentPromptTitle(agent: AgentName, line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (['exit', 'quit', 'logout'].includes(trimmed.toLowerCase())) return null
  if (trimmed.startsWith('/')) return null
  if (
    trimmed.includes('&&') ||
    trimmed.includes('||') ||
    trimmed.includes('|') ||
    trimmed.includes('>') ||
    trimmed.includes('<') ||
    trimmed.includes('$(') ||
    trimmed.includes('`')
  ) {
    return null
  }

  const firstToken = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? ''
  if (
    COMMON_SHELL_COMMANDS.has(firstToken) ||
    /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(firstToken) ||
    (!trimmed.includes(' ') && trimmed.length < 20)
  ) {
    return null
  }

  const summary = summarizeTitle(trimmed)
  return summary ? `${getAgentLabel(agent)}: ${summary}` : null
}

function stripInputControlSequences(chunk: string) {
  return chunk
    .replace(ANSI_CSI_SEQUENCE_RE, '')
    .replace(ANSI_ESCAPE_RE, '')
    .replace(NULL_CHAR_RE, '')
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return Boolean(target.closest('input, textarea, [contenteditable="true"], [role="textbox"]'))
}

function shellEscapePath(filePath: string) {
  if (/^[A-Za-z0-9_./-]+$/.test(filePath)) return filePath
  return `'${filePath.replace(/'/g, `'\\''`)}'`
}

function parseUriList(uriList: string) {
  return uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      try {
        if (!line.startsWith('file://')) return ''
        return decodeURIComponent(new URL(line).pathname)
      } catch {
        return ''
      }
    })
    .filter(Boolean)
}

function getFilePaths(dataTransfer: DataTransfer) {
  const filePaths = Array.from(dataTransfer.files)
    .map((file) => {
      try {
        return window.cells.app.getPathForFile(file)
      } catch {
        return ''
      }
    })
    .filter(Boolean)

  if (filePaths.length > 0) return filePaths

  return parseUriList(dataTransfer.getData('text/uri-list'))
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
  const overlayOpen = useStore((s) => s.overlayOpen)
  const focusTerminal = useStore((s) => s.focusTerminal)
  const themeNameRef = useRef(themeName)
  const fontSizeRef = useRef(fontSize)
  const fontFamilyRef = useRef(fontFamily)
  const inferredAgentRef = useRef<AgentName | null>(null)
  const detectedAgentRef = useRef<AgentName | null>(null)
  const inputBufferRef = useRef('')
  const lastInferredTitleRef = useRef<string | null>(null)
  const dragDepthRef = useRef(0)
  const [dropActive, setDropActive] = useState(false)

  const pasteToTerminal = useCallback(
    (text: string) => {
      const term = terminalRef.current
      if (!term || !text) return
      focusTerminal(termId)
      term.focus()
      term.paste(text)
    },
    [focusTerminal, termId],
  )

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange
    themeNameRef.current = themeName
    fontSizeRef.current = fontSize
    fontFamilyRef.current = fontFamily
  }, [onTitleChange, themeName, fontSize, fontFamily])

  const setInferredTitle = useCallback((title: string) => {
    if (!title || title === lastInferredTitleRef.current) return
    lastInferredTitleRef.current = title
    onTitleChangeRef.current?.(title)
  }, [])

  const handleSubmittedInput = useCallback(
    (line: string) => {
      const launch = inferAgentLaunch(line)
      if (launch) {
        inferredAgentRef.current = launch.agent
        const current = useStore.getState().terminals.find((terminal) => terminal.id === termId)
        if (current && current.agent !== launch.agent) {
          useStore.getState().updateTerminalAgent(termId, launch.agent)
        }
        setInferredTitle(launch.title)
        return
      }

      const trimmed = line.trim()
      if (['exit', 'quit', 'logout'].includes(trimmed.toLowerCase())) {
        inferredAgentRef.current = null
        return
      }

      const activeAgent = detectedAgentRef.current ?? inferredAgentRef.current
      if (!activeAgent) return

      const inferredTitle = inferAgentPromptTitle(activeAgent, line)
      if (inferredTitle) {
        setInferredTitle(inferredTitle)
      }
    },
    [setInferredTitle, termId],
  )

  const trackInputForTitle = useCallback(
    (chunk: string) => {
      for (const char of stripInputControlSequences(chunk)) {
        if (char === '\r' || char === '\n') {
          const line = inputBufferRef.current
          inputBufferRef.current = ''
          handleSubmittedInput(line)
          continue
        }
        if (char === '\u007f' || char === '\b') {
          inputBufferRef.current = inputBufferRef.current.slice(0, -1)
          continue
        }
        if (char === '\u0015' || char === '\u0003') {
          inputBufferRef.current = ''
          continue
        }
        if (char >= ' ') {
          inputBufferRef.current += char
        }
      }
    },
    [handleSubmittedInput],
  )

  useEffect(() => {
    if (!isFocused) return

    const handlePaste = async (event: ClipboardEvent) => {
      const container = containerRef.current
      const inThisTerminal = Boolean(
        container && event.target instanceof Node && container.contains(event.target),
      )
      if (overlayOpen || (!inThisTerminal && isEditableTarget(event.target))) return
      event.preventDefault()
      event.stopPropagation()

      // Check for files/images in clipboard
      const filePaths = await window.cells.app.pasteClipboardFiles()
      if (filePaths && filePaths.length > 0) {
        pasteToTerminal(filePaths.map(shellEscapePath).join(' ') + ' ')
        return
      }

      const text = event.clipboardData?.getData('text')
      if (text) pasteToTerminal(text)
    }

    document.addEventListener('paste', handlePaste, true)
    return () => document.removeEventListener('paste', handlePaste, true)
  }, [isFocused, overlayOpen, pasteToTerminal])

  // Main lifecycle — create or reattach cached terminal
  useEffect(() => {
    let cancelled = false
    const container = containerRef.current

    async function setup() {
      if (!container) return
      const cleanups: Array<() => void> = []

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
        cursorBlink: false,
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

      // Register link providers — wraps built-in providers with custom activate
      // that routes links based on user settings (system browser vs built-in)
      const activateLink = (url: string) => {
        const state = useStore.getState()
        const rules = state.linkRules
        // Check link rules first (most specific match wins)
        for (const rule of rules) {
          try {
            if (new RegExp(rule.pattern, 'i').test(url)) {
              if (rule.target === 'system') {
                window.cells.app.openExternal(url)
              } else {
                const projectId = rule.projectId || state.activeProjectId
                if (projectId && projectId !== state.activeProjectId) {
                  // TODO: open in specific project — for now fall back to current
                }
                state.addBrowserWithUrl(url)
              }
              return
            }
          } catch {
            // Invalid regex, skip
          }
        }
        // Fall back to default behavior
        if (state.terminalLinkTarget === 'browser') {
          state.addBrowserWithUrl(url)
        } else {
          window.cells.app.openExternal(url)
        }
      }

      const wrapProvider = (provider: ILinkProvider): ILinkProvider => ({
        provideLinks(y, callback) {
          provider.provideLinks(y, (links) => {
            if (!links) return callback(undefined)
            callback(
              links.map((link) => ({
                ...link,
                activate: () => activateLink(link.text),
              })),
            )
          })
        },
        dispose() {
          provider.dispose?.()
        },
      })

      term.registerLinkProvider(wrapProvider(new UrlRegexProvider(term as any)))
      term.registerLinkProvider(wrapProvider(new OSC8LinkProvider(term as any)))

      if (term.textarea) {
        term.textarea.style.opacity = '0'
        term.textarea.style.caretColor = 'transparent'
        term.textarea.style.position = 'fixed'
        term.textarea.style.left = '-9999px'
        term.textarea.style.top = '-9999px'
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

        // Only handle keydown, not keyup
        if (e.type !== 'keydown') return false

        // Handle Cmd+V paste — check for clipboard image first, then text
        if (e.metaKey && (e.key === 'v' || e.key === 'V')) {
          e.preventDefault()
          ;(async () => {
            // Try files/images from native clipboard
            const filePaths = await window.cells.app.pasteClipboardFiles()
            if (filePaths && filePaths.length > 0) {
              window.cells.terminal.write(termId, filePaths.map(shellEscapePath).join(' ') + ' ')
              return
            }
            // Fallback to text
            const text = await navigator.clipboard.readText()
            if (text) window.cells.terminal.write(termId, text)
          })()
          return true
        }

        // macOS editing shortcuts → terminal escape sequences
        // Option+Backspace → delete word backward
        if (e.altKey && e.key === 'Backspace') {
          window.cells.terminal.write(termId, '\x1b\x7f')
          return true
        }
        // Option+Delete → delete word forward
        if (e.altKey && e.key === 'Delete') {
          window.cells.terminal.write(termId, '\x1bd')
          return true
        }
        // Cmd+Backspace → delete to beginning of line
        if (e.metaKey && e.key === 'Backspace') {
          window.cells.terminal.write(termId, '\x15')
          return true
        }
        // Option+Left → move word left
        if (e.altKey && e.key === 'ArrowLeft') {
          window.cells.terminal.write(termId, '\x1bb')
          return true
        }
        // Option+Right → move word right
        if (e.altKey && e.key === 'ArrowRight') {
          window.cells.terminal.write(termId, '\x1bf')
          return true
        }
        // Cmd+Left → beginning of line
        if (e.metaKey && e.key === 'ArrowLeft') {
          window.cells.terminal.write(termId, '\x01')
          return true
        }
        // Cmd+Right → end of line
        if (e.metaKey && e.key === 'ArrowRight') {
          window.cells.terminal.write(termId, '\x05')
          return true
        }

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
      cleanups.push(
        term.onTitleChange((title) => {
          lastInferredTitleRef.current = title || 'Terminal'
          onTitleChangeRef.current?.(title || 'Terminal')
        }).dispose,
        term.onData((data) => {
          trackInputForTitle(data)
          window.cells.terminal.write(termId, data)
        }).dispose,
        window.cells.terminal.onData((id, data) => {
          if (id === termId) term.write(data)
        }),
        window.cells.terminal.onExit((id) => {
          if (id === termId) {
            useStore.getState().removeTerminal(termId)
          }
        }),
      )

      // Handle paste events from any source (Raycast, right-click, etc.)
      const handlePaste = (e: ClipboardEvent) => {
        e.preventDefault()
        const text = e.clipboardData?.getData('text')
        if (text) window.cells.terminal.write(termId, text)
      }
      wrapper.addEventListener('paste', handlePaste)
      cleanups.push(() => wrapper.removeEventListener('paste', handlePaste))

      // Agent detection poll
      const agentPoll = setInterval(async () => {
        const proc = await window.cells.terminal.getProcess(termId)
        const agent = normalizeAgentProcess(proc)
        detectedAgentRef.current = agent
        if (agent) inferredAgentRef.current = agent
        const current = useStore.getState().terminals.find((t) => t.id === termId)
        if (current && current.agent !== agent) {
          useStore.getState().updateTerminalAgent(termId, agent)
        }
        if (agent === 'codex') {
          const codexTitle = await window.cells.terminal.getCodexTitle(termId)
          if (codexTitle) {
            setInferredTitle(formatAgentWindowTitle('codex', codexTitle))
          }
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
      inputBufferRef.current = ''
      // Tell main process to buffer instead of sending live IPC
      window.cells.terminal.unsubscribe(termId)
    }
  }, [setInferredTitle, termId, trackInputForTitle])

  // Theme/font updates
  useEffect(() => {
    const term = terminalRef.current
    if (!term) return

    term.options.theme = buildTheme(themeName)

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

  return (
    <div
      ref={containerRef}
      className="cell-terminal relative w-full h-full"
      onPasteCapture={(event) => {
        if (overlayOpen) return
        const text = event.clipboardData.getData('text')
        if (!text) return
        event.preventDefault()
        event.stopPropagation()
        pasteToTerminal(text)
      }}
      onDragEnterCapture={(event) => {
        if (!event.dataTransfer?.files?.length) return
        event.preventDefault()
        event.stopPropagation()
        dragDepthRef.current += 1
        setDropActive(true)
      }}
      onDragOverCapture={(event) => {
        if (!event.dataTransfer) return
        const filePaths = getFilePaths(event.dataTransfer)
        if (filePaths.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
        if (!dropActive) setDropActive(true)
      }}
      onDragLeaveCapture={(event) => {
        if (!event.dataTransfer?.files?.length) return
        event.preventDefault()
        event.stopPropagation()
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) {
          setDropActive(false)
        }
      }}
      onDropCapture={(event) => {
        const dataTransfer = event.dataTransfer
        dragDepthRef.current = 0
        setDropActive(false)
        if (!dataTransfer) return

        const filePaths = getFilePaths(dataTransfer)
        if (filePaths.length === 0) return

        event.preventDefault()
        event.stopPropagation()

        const payload = `${filePaths.map(shellEscapePath).join(' ')} `
        pasteToTerminal(payload)
      }}
    >
      {dropActive && (
        <div
          className={cn(
            'pointer-events-none absolute inset-0 z-20 rounded-lg border border-dashed',
            'border-terminal-active/80 bg-terminal-active/10 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-terminal-active)_45%,transparent)]',
          )}
        />
      )}
    </div>
  )
}
