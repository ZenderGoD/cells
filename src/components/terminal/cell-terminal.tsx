import { useCallback, useEffect, useRef, useState } from 'react'
import { init, Terminal, FitAddon, UrlRegexProvider, OSC8LinkProvider } from 'ghostty-web'
import type { ILinkProvider } from 'ghostty-web'
import { useStore, consumePendingCommand, consumePendingWorktreePath } from '@/lib/store'
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

interface TerminalPreviewOptions {
  lines?: number
  columns?: number
}

export function getTerminalPreviewSnapshot(
  termId: string,
  options: TerminalPreviewOptions = {},
): string[] {
  const cached = terminalCache.get(termId)
  const term = cached?.term
  if (!term) return []

  const activeBuffer = term.buffer.active
  const visibleRows = Math.max(1, options.lines ?? 6)
  const maxColumns = Math.max(1, options.columns ?? 34)
  const viewportY = Math.max(0, activeBuffer.viewportY ?? 0)
  const start =
    activeBuffer.type === 'alternate'
      ? Math.max(0, activeBuffer.length - visibleRows)
      : Math.max(0, activeBuffer.length - term.rows - viewportY)
  const end = Math.min(activeBuffer.length, start + visibleRows)
  const previewLines: string[] = []

  for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
    const line = activeBuffer.getLine(lineIndex)
    if (!line) {
      previewLines.push('')
      continue
    }

    const text = line.translateToString(false, 0, Math.min(line.length, maxColumns))
    previewLines.push(text.replace(/\s+$/g, ''))
  }

  while (previewLines.length < visibleRows) {
    previewLines.push('')
  }

  return previewLines
}

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

/** Repaint a terminal — recreates the renderer while keeping the shell alive. */
export function reloadTerminal(termId: string) {
  window.cells.terminal.unsubscribe(termId)
  destroyCachedTerminal(termId)
  window.dispatchEvent(new CustomEvent('terminal-reload', { detail: { termId } }))
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

// ---------- Agent status detection ----------
//
// STATUS MODEL (state machine):
//
//   null ──[output arrives]──► active ──[silence >3s, unfocused]──► unread
//     ▲                          │                                    │
//     │                          │ [silence >3s, focused]             │
//     │                          ▼                                    │
//     └──────────────────────── null ◄──────[user focuses]────────────┘
//
//   active ──[agent exits]──► done ──[user focuses]──► null
//
// KEY DESIGN DECISIONS:
//
// 1. Only timing-based detection (no terminal output parsing).
//    Earlier attempts tried to detect agent prompt characters (❯, ›, >)
//    in the PTY output buffer, but this was fragile: agents render status
//    bars below the prompt, different versions use different characters,
//    and ANSI escape sequences leave artifacts that break regex matching.
//    A 3-second silence threshold is simple and reliable — agents actively
//    working always produce continuous output (streaming text, tool use
//    blocks, progress spinners).
//
// 2. State machine transitions, not re-evaluation.
//    The poll must NOT re-derive status from scratch each cycle. If it did,
//    an idle unfocused agent would get re-marked as 'unread' every 3s,
//    even after the user already focused it and acknowledged the output.
//    Instead, 'unread' is only set on the active→idle transition. Once
//    cleared to null (by focusing), it stays null until the agent produces
//    NEW output and goes idle again while unfocused.
//
// 3. Focus clears status immediately (in store.focusTerminal), including
//    when re-focusing the same terminal. Without this, clicking an already-
//    focused terminal wouldn't clear a stale 'unread' that the poll set
//    between focus events.
//
// 4. Bell character (BEL, \x07) is an early idle signal. Agents ring the
//    bell when they finish a turn, so we don't have to wait the full 3s.
//
// 5. processRunning (for non-agent terminals) is purely runtime — cleared
//    on app restart since the process tree is stale. agentStatus persists
//    across restarts: 'active' is normalized to 'unread' on restore (the
//    agent was mid-work when the app closed, so there's unread output).

const AGENT_IDLE_SILENCE_MS = 3_000
const BEL = '\x07'
const ANSI_ESCAPE_RE = new RegExp(`${ESCAPE_CHAR}[@-_]`, 'g')
const NULL_CHAR_RE = new RegExp(NULL_CHAR, 'g')
const COMMAND_EDITING_SEQUENCES: Record<string, string> = {
  a: '\x01',
  b: '\x02',
  d: '\x04',
  e: '\x05',
  f: '\x06',
  n: '\x0e',
  p: '\x10',
  u: '\x15',
  y: '\x19',
  z: '\x1f',
}

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
  // Check user-configured aliases
  const aliases = useStore.getState().agentAliases
  for (const [agent, alias] of Object.entries(aliases)) {
    if (alias && normalized === alias.toLowerCase().split('/').pop()) {
      return agent as AgentName
    }
  }
  return null
}

function inferAgentLaunch(line: string): { agent: AgentName; title: string } | null {
  const trimmed = line.trim()

  // Build regex that matches canonical names + any user-configured aliases
  const aliases = useStore.getState().agentAliases
  const names = new Set(['claude', 'codex'])
  for (const alias of Object.values(aliases)) {
    if (alias?.trim()) names.add(alias.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }
  const namesPattern = [...names].join('|')
  const re = new RegExp(
    `^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\\S+))\\s+)*(?<cmd>(?:\\S*\\/)?(?:${namesPattern}))(?=\\s|$)\\s*(?<rest>.*)$`,
    'i',
  )
  const match = trimmed.match(re)
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
  const lastAgentDataRef = useRef<number>(0) // timestamp of last PTY data while agent active
  const prevAgentRef = useRef<AgentName | null>(null) // track transitions for done detection
  const agentBellRef = useRef(false) // whether a BEL was heard since last input
  const dragDepthRef = useRef(0)
  const [dropActive, setDropActive] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent).detail?.termId === termId) {
        setReloadKey((k) => k + 1)
      }
    }
    window.addEventListener('terminal-reload', handler)
    return () => window.removeEventListener('terminal-reload', handler)
  }, [termId])

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

  const copySelectionToClipboard = useCallback(() => {
    const term = terminalRef.current
    if (!term || !term.hasSelection()) return false
    const selection = term.getSelection()
    if (!selection) return false
    void navigator.clipboard.writeText(selection).catch(() => {})
    return true
  }, [])

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
        cached.wrapper.style.backgroundColor = buildTheme(themeNameRef.current).background
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

        // Force a full redraw after DOM reattachment — the canvas backing
        // store may have been reclaimed while the wrapper was detached,
        // leaving the terminal visually stale or blank even though the
        // internal buffer state is correct.
        requestAnimationFrame(() => {
          const t = cached.term
          if (t.renderer && t.wasmTerm) {
            t.renderer.render(t.wasmTerm, true, t.viewportY, t as any, 0)
          }
        })

        return
      }

      // First time — create new terminal
      await ensureInit()
      if (cancelled) return

      const wrapper = document.createElement('div')
      wrapper.style.width = '100%'
      wrapper.style.height = '100%'
      wrapper.style.backgroundColor = buildTheme(themeNameRef.current).background
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
                state.addBrowserWithUrl(url, rule.projectId ?? null)
              }
              return
            }
          } catch {
            // Invalid regex, skip
          }
        }
        // Fall back to default behavior
        if (state.terminalLinkTarget === 'browser') {
          state.addBrowserWithUrl(url, state.terminalLinkProjectId)
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
        const normalizedKey = e.key.length === 1 ? e.key.toLowerCase() : e.key

        if (e.metaKey) {
          const metaShortcuts = [
            'k',
            'K',
            'r',
            'R',
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

        // Shift+Tab → send reverse-tab (backtab) escape sequence to PTY
        // Must intercept here to prevent browser focus navigation
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.key === 'Tab') {
          e.preventDefault()
          if (e.type === 'keydown') {
            window.cells.terminal.write(termId, '\x1b[Z')
          }
          return true
        }

        if (e.metaKey && !e.ctrlKey && !e.altKey) {
          if (normalizedKey === 'c') {
            if (e.type === 'keydown') {
              e.preventDefault()
              if (!copySelectionToClipboard()) {
                window.cells.terminal.write(termId, '\x03')
              }
            }
            return true
          }

          const sequence = COMMAND_EDITING_SEQUENCES[normalizedKey]
          if (sequence) {
            if (e.type === 'keydown') {
              e.preventDefault()
              window.cells.terminal.write(termId, sequence)
            }
            return true
          }
        }

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
          // When user sends input (Enter key), immediately mark agent as active
          if (data.includes('\r') || data.includes('\n')) {
            const agent = detectedAgentRef.current ?? inferredAgentRef.current
            if (agent) {
              agentBellRef.current = false
              const store = useStore.getState()
              const current = store.terminals.find((t) => t.id === termId)
              if (current?.agentStatus !== 'active') {
                store.updateTerminalAgentStatus(termId, 'active')
              }
            }
          }
        }).dispose,
        window.cells.terminal.onData((id, data) => {
          if (id === termId) {
            term.write(data)
            const agent = detectedAgentRef.current ?? inferredAgentRef.current
            if (agent) {
              lastAgentDataRef.current = Date.now()

              // Bell = agent finished its turn. This lets the poll detect
              // idle state immediately instead of waiting the full 3s.
              if (data.includes(BEL)) {
                agentBellRef.current = true
              }

              // Any PTY output means the agent is working. Transition to
              // 'active' immediately — this is the only place 'active' is set
              // (aside from user pressing Enter). The poll handles the
              // active→idle transition after silence.
              const store = useStore.getState()
              const current = store.terminals.find((t) => t.id === termId)
              if (current && current.agentStatus !== 'active') {
                store.updateTerminalAgentStatus(termId, 'active')
              }
            }
          }
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

      // Agent + process detection poll
      const agentPoll = setInterval(async () => {
        const proc = await window.cells.terminal.getProcess(termId)
        const agent = normalizeAgentProcess(proc)
        const wasAgent = prevAgentRef.current
        detectedAgentRef.current = agent
        if (agent) inferredAgentRef.current = agent
        prevAgentRef.current = agent

        const store = useStore.getState()
        const current = store.terminals.find((t) => t.id === termId)

        // Track whether any non-shell process is running (for subtle indicator)
        const hasProcess = !!proc && !agent
        store.updateTerminalProcessRunning(termId, hasProcess)
        if (current && current.agent !== agent) {
          store.updateTerminalAgent(termId, agent)
        }

        // ── Agent status state machine ──
        //
        // This is a state machine, NOT a stateless re-evaluation. The previous
        // status determines what transitions are valid. This is critical:
        // a naive "idle + unfocused → unread" would re-mark terminals the
        // user already read every 3 seconds, causing phantom notifications.
        //
        // Valid transitions:
        //   null/unread → active    (output arrived — handled in onData above)
        //   active → null           (silence + focused: user is watching)
        //   active → unread         (silence + unfocused: user missed it)
        //   unread/done → null      (user focused the terminal)
        //   null → null             (no-op: user already acknowledged)
        //   unread → unread         (no-op: user still hasn't looked)
        //   any → done              (agent process exited)
        //
        if (agent) {
          const elapsed = Date.now() - lastAgentDataRef.current
          const focused = store.focusedTerminalId === termId
          const isIdle =
            (lastAgentDataRef.current > 0 && elapsed > AGENT_IDLE_SILENCE_MS) ||
            agentBellRef.current
          const prev = current?.agentStatus ?? null

          let newStatus: import('@/types').AgentStatus = prev
          if (!isIdle && lastAgentDataRef.current > 0) {
            // Output still flowing — agent is actively working
            newStatus = 'active'
          } else if (isIdle && prev === 'active') {
            // TRANSITION: agent just went from working → idle.
            // This is the ONLY place 'unread' gets set. If the user is
            // watching (focused), skip straight to null.
            newStatus = focused ? null : 'unread'
          } else if (isIdle && focused && (prev === 'unread' || prev === 'done')) {
            // User focused an idle agent terminal — acknowledge & clear
            newStatus = null
          }
          // All other cases: keep current status unchanged.
          // null stays null (user already saw it — don't re-notify).
          // unread stays unread (user hasn't focused yet).

          if (current && current.agentStatus !== newStatus) {
            store.updateTerminalAgentStatus(termId, newStatus)
          }
        } else if (wasAgent && !agent) {
          // Agent process exited — mark done so user sees it
          store.updateTerminalAgentStatus(termId, 'done')
          lastAgentDataRef.current = 0
          agentBellRef.current = false
          // Clear inferred agent so subsequent shell output doesn't
          // re-trigger the active → unread cycle on a dead agent
          inferredAgentRef.current = null
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
      const worktreeCwd = consumePendingWorktreePath(termId)
      const projectPath = worktreeCwd ?? useStore.getState().getActiveProjectPath()
      const result = await window.cells.terminal.attach(
        termId,
        dims?.cols ?? 80,
        dims?.rows ?? 24,
        projectPath,
      )

      if (result?.reattached && result.buffer) {
        term.write(result.buffer)
      }

      if (result?.reattached && dims) {
        // Force a real SIGWINCH so the shell/TUI program fully redraws.
        // The daemon's spawn() already resized to (cols, rows), so sending
        // the same size is a no-op — the kernel won't deliver SIGWINCH.
        // Briefly resize to cols-1, then restore the correct size.
        const bumpCols = Math.max(1, dims.cols - 1)
        window.cells.terminal.resize(termId, bumpCols, dims.rows)
        setTimeout(() => {
          if (cancelled) return
          window.cells.terminal.resize(termId, dims.cols, dims.rows)
        }, 50)
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
  }, [copySelectionToClipboard, reloadKey, setInferredTitle, termId, trackInputForTitle])

  useEffect(() => {
    if (!isFocused) return

    const handleCopy = (event: ClipboardEvent) => {
      const container = containerRef.current
      const inThisTerminal = Boolean(
        container && event.target instanceof Node && container.contains(event.target),
      )
      const activeElement = document.activeElement
      const fromTerminalTextarea =
        activeElement instanceof HTMLElement && container && container.contains(activeElement)

      if (!inThisTerminal && !fromTerminalTextarea) return

      if (!copySelectionToClipboard()) return
      event.preventDefault()
      event.stopPropagation()
      const selection = terminalRef.current?.getSelection()
      if (selection) event.clipboardData?.setData('text/plain', selection)
    }

    document.addEventListener('copy', handleCopy, true)
    return () => document.removeEventListener('copy', handleCopy, true)
  }, [copySelectionToClipboard, isFocused])

  // Theme/font updates
  useEffect(() => {
    const term = terminalRef.current
    if (!term) return

    const theme = buildTheme(themeName)
    term.options.theme = theme

    // Keep wrapper background in sync so the sub-cell gap matches the terminal bg
    const cached = terminalCache.get(termId)
    if (cached) {
      cached.wrapper.style.backgroundColor = theme.background
    }

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

  // Auto-focus + force repaint for reattached daemon sessions that may have
  // a stale/blank canvas despite having content in the internal buffer.
  useEffect(() => {
    if (!isFocused || !terminalRef.current) return
    terminalRef.current.focus()
    const t = terminalRef.current
    requestAnimationFrame(() => {
      if (t.renderer && t.wasmTerm) {
        t.renderer.render(t.wasmTerm, true, t.viewportY, t as any, 0)
      }
    })
  }, [isFocused])

  // Allow scrolling the scrollback buffer even when the running program has
  // mouse tracking enabled (e.g. Claude Code, Codex) or is using the alternate
  // screen buffer.  In either case the default wheel behavior doesn't scroll
  // the main buffer's scrollback, so we intercept and do it ourselves.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onWheel = (e: WheelEvent) => {
      const term = terminalRef.current
      if (!term) return
      // Intercept when mouse tracking is on (agent TUIs) OR when the program
      // is in the alternate screen buffer (which has no scrollback of its own).
      const inAlternate = term.buffer?.active?.type === 'alternate'
      if (!term.hasMouseTracking() && !inAlternate) return
      e.preventDefault()
      e.stopPropagation()
      const lines = Math.round(e.deltaY / 20) || (e.deltaY > 0 ? 1 : -1)
      term.scrollLines(lines)
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [])

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
