import { useCallback, useEffect, useRef, useState } from 'react'
import {
  init,
  Terminal,
  FitAddon,
  UrlRegexProvider,
  OSC8LinkProvider,
  CanvasRenderer,
  CellFlags,
} from 'ghostty-web'
import type { ILinkProvider } from 'ghostty-web'

/** The 4th param of CanvasRenderer.render — not exported by ghostty-web. */
type Renderable = Parameters<CanvasRenderer['render']>[0]
type ScrollbackProvider = NonNullable<Parameters<CanvasRenderer['render']>[3]>
import { useStore, consumePendingCommand, consumePendingWorktreePath } from '@/lib/store'
import { DEFAULT_TERMINAL_CURSOR_SETTINGS, type TerminalCursorStyle } from '@/lib/terminal-cursor'
import { DEFAULT_TERMINAL_SCROLLBACK_LINES } from '@/lib/terminal-scrollback'
import { getTerminalTheme } from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'
import { inferAgentFromTitle } from '@/lib/agent-command'
import type { TerminalPerfSample } from '@/types'

// Initialize WASM lazily on first terminal mount
let ghosttyReady: Promise<void> | null = null
let ghosttyRendererPatched = false

const GHOSTTY_SMOOTH_SCROLL_DURATION_MS = 125
const CANVAS_MIN_ZOOM = 0.15
const CANVAS_MAX_ZOOM = 1.5
const HISTORY_PAGE_BYTES = 256 * 1024
const HISTORY_WRITE_BYTES = 64 * 1024
const TERMINAL_SEARCH_MATCH_LIMIT = 2_000
const TERMINAL_FULL_RENDER_THROTTLE_MS = 100

function patchGhosttyRenderer() {
  if (ghosttyRendererPatched) return
  ghosttyRendererPatched = true

  const proto = CanvasRenderer.prototype as any
  const originalRenderCursor = proto.renderCursor

  proto.renderCursor = function renderCursorPatched(this: any, x: number, y: number) {
    if (this.cursorStyle !== 'block') {
      originalRenderCursor.call(this, x, y)
      return
    }

    const cursorX = x * this.metrics.width
    const cursorY = y * this.metrics.height
    this.ctx.fillStyle = this.theme.cursor
    this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height)

    const line = this.currentBuffer?.getLine?.(y)
    const cell = line?.[x]
    if (!cell || cell.flags & CellFlags.INVISIBLE || cell.grapheme_len <= 0) return

    let font = ''
    if (cell.flags & CellFlags.ITALIC) font += 'italic '
    if (cell.flags & CellFlags.BOLD) font += 'bold '
    this.ctx.font = `${font}${this.fontSize}px ${this.fontFamily}`
    this.ctx.fillStyle = this.theme.cursorAccent ?? this.theme.background
    if (cell.flags & CellFlags.FAINT) this.ctx.globalAlpha = 0.5

    const grapheme = this.currentBuffer?.getGraphemeString?.(y, x)
    const text = grapheme || String.fromCodePoint(cell.codepoint || 32)
    this.ctx.fillText(text, cursorX, cursorY + this.metrics.baseline)

    if (cell.flags & CellFlags.FAINT) this.ctx.globalAlpha = 1
  }
}

function ensureInit() {
  patchGhosttyRenderer()
  if (!ghosttyReady) ghosttyReady = init()
  return ghosttyReady
}

function setTerminalRenderLoopEnabled(term: Terminal | null, enabled: boolean) {
  if (!term) return

  const animationFrameId = Reflect.get(term, 'animationFrameId')

  if (!enabled) {
    if (typeof animationFrameId === 'number') {
      cancelAnimationFrame(animationFrameId)
      Reflect.set(term, 'animationFrameId', undefined)
    }
    return
  }

  if (typeof animationFrameId === 'number') return

  const startRenderLoop = Reflect.get(term, 'startRenderLoop')
  const renderer = Reflect.get(term, 'renderer')
  const wasmTerm = Reflect.get(term, 'wasmTerm')
  const isDisposed = Reflect.get(term, 'isDisposed')
  const isOpen = Reflect.get(term, 'isOpen')

  if (typeof startRenderLoop !== 'function' || !renderer || !wasmTerm) return
  if (isDisposed === true || isOpen === false) return

  startRenderLoop.call(term)
}

function patchTerminalViewportPreservation(term: Terminal) {
  const marker = Reflect.get(term, '__cellsViewportPatched')
  if (marker) return
  Reflect.set(term, '__cellsViewportPatched', true)

  const originalWriteInternal = Reflect.get(term, 'writeInternal')
  if (typeof originalWriteInternal !== 'function') return

  Reflect.set(term, '__cellsOriginalWriteInternal', originalWriteInternal)
  Reflect.set(
    term,
    'writeInternal',
    function patchedWriteInternal(
      this: Terminal,
      data: string | Uint8Array,
      callback?: () => void,
    ) {
      if (!Reflect.get(this, '__cellsPreserveViewportOnWrite')) {
        return originalWriteInternal.call(this, data, callback)
      }

      const originalScrollToBottom = Reflect.get(this, 'scrollToBottom')
      Reflect.set(this, 'scrollToBottom', () => {})
      try {
        return originalWriteInternal.call(this, data, callback)
      } finally {
        Reflect.set(this, 'scrollToBottom', originalScrollToBottom)
      }
    },
  )
}

function patchTerminalFullRenderScheduler(term: Terminal) {
  if (Reflect.get(term, '__cellsFullRenderSchedulerPatched')) return

  const renderer = Reflect.get(term, 'renderer')
  if (!renderer) return

  const originalRender = Reflect.get(renderer, 'render')
  if (typeof originalRender !== 'function') return

  Reflect.set(term, '__cellsFullRenderSchedulerPatched', true)
  Reflect.set(term, '__cellsPendingFullRender', false)
  Reflect.set(term, '__cellsLastForcedFullRenderAt', 0)
  Reflect.set(term, '__cellsPerfForcedFullRenderCount', 0)

  Reflect.set(
    renderer,
    'render',
    function patchedRender(
      this: CanvasRenderer,
      wasmTerm: Renderable,
      forceFull: boolean,
      viewportY: number,
      scrollbackProvider: ScrollbackProvider,
      scrollbarOpacity: number,
    ) {
      let shouldForceFull = forceFull

      if (!shouldForceFull && Reflect.get(term, '__cellsPendingFullRender') === true) {
        const now = performance.now()
        const lastForcedFullRenderAt = Number(
          Reflect.get(term, '__cellsLastForcedFullRenderAt') ?? 0,
        )
        if (now - lastForcedFullRenderAt >= TERMINAL_FULL_RENDER_THROTTLE_MS) {
          shouldForceFull = true
        }
      }

      if (shouldForceFull) {
        Reflect.set(term, '__cellsPendingFullRender', false)
        Reflect.set(term, '__cellsLastForcedFullRenderAt', performance.now())
        const forcedFullRenderCount = Number(
          Reflect.get(term, '__cellsPerfForcedFullRenderCount') ?? 0,
        )
        Reflect.set(term, '__cellsPerfForcedFullRenderCount', forcedFullRenderCount + 1)
      }

      return originalRender.call(
        this,
        wasmTerm,
        shouldForceFull,
        viewportY,
        scrollbackProvider,
        scrollbarOpacity,
      )
    },
  )
}

function requestTerminalFullRender(term: Terminal) {
  Reflect.set(term, '__cellsPendingFullRender', true)
}

function consumeTerminalFullRenderCount(term: Terminal) {
  const forcedFullRenderCount = Number(Reflect.get(term, '__cellsPerfForcedFullRenderCount') ?? 0)
  Reflect.set(term, '__cellsPerfForcedFullRenderCount', 0)
  return forcedFullRenderCount
}

function buildTheme(themeName: string) {
  const theme = getTerminalTheme(themeName)
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    cursorAccent: theme.background,
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

function applyThemeToTerminal(term: Terminal, theme: ReturnType<typeof buildTheme>) {
  term.options.theme = theme

  if (term.renderer) {
    term.renderer.setTheme(theme)
  }

  if (term.renderer && term.wasmTerm) {
    term.renderer.render(term.wasmTerm, true, term.viewportY, term as ScrollbackProvider, 0)
  }
}

function replaceLinkProviders(term: Terminal, providers: ILinkProvider[]) {
  const linkDetector = Reflect.get(term, 'linkDetector')
  if (!linkDetector) {
    for (const provider of providers) {
      term.registerLinkProvider(provider)
    }
    return
  }

  const existingProviders = Reflect.get(linkDetector, 'providers')
  if (Array.isArray(existingProviders)) {
    for (const provider of existingProviders) {
      provider?.dispose?.()
    }
  }

  Reflect.set(linkDetector, 'providers', [])
  linkDetector.invalidateCache?.()

  for (const provider of providers) {
    term.registerLinkProvider(provider)
  }
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

async function writeHistoryChunk(term: Terminal, chunk: string) {
  for (let offset = 0; offset < chunk.length; offset += HISTORY_WRITE_BYTES) {
    term.write(chunk.slice(offset, offset + HISTORY_WRITE_BYTES))
    await nextAnimationFrame()
  }
}

async function replayPagedTerminalHistory(termId: string, term: Terminal) {
  let token: string | null = null
  let offset: number | null = null

  while (true) {
    const page = await window.cells.terminal.getHistoryPage(
      termId,
      token,
      offset,
      HISTORY_PAGE_BYTES,
    )
    if (page.chunk) {
      await writeHistoryChunk(term, page.chunk)
    }
    if (page.done || page.offset == null) break
    token = page.token
    offset = page.offset
  }
}

function shouldPreferSnapshotRestoreForTerminal(terminal: {
  agent?: AgentName | null
  title?: string | null
  customTitle?: string | null
}) {
  if (terminal.agent === 'codex') return true
  const inferred = inferAgentFromTitle(terminal.customTitle ?? terminal.title ?? '')
  return inferred === 'codex'
}

function shouldAvoidSyntheticResizeForTerminal(terminal: {
  agent?: AgentName | null
  title?: string | null
  customTitle?: string | null
}) {
  return shouldPreferSnapshotRestoreForTerminal(terminal)
}

interface SearchMatch {
  absoluteRow: number
  length: number
  startCol: number
}

interface SearchResultSet {
  limitHit: boolean
  matches: SearchMatch[]
}

function locateSearchMatch(
  segments: Array<{ absoluteRow: number; text: string }>,
  startIndex: number,
  length: number,
): SearchMatch | null {
  let remaining = startIndex

  for (const segment of segments) {
    if (remaining < segment.text.length) {
      return {
        absoluteRow: segment.absoluteRow,
        startCol: remaining,
        length,
      }
    }
    remaining -= segment.text.length
  }

  return null
}

function buildSearchMatches(term: Terminal, query: string): SearchResultSet {
  const buffer = term.buffer.active
  const needle = query.trim()
  if (!needle) {
    return { matches: [], limitHit: false }
  }

  const normalizedNeedle = needle.toLocaleLowerCase()
  const matches: SearchMatch[] = []
  let limitHit = false
  let logicalText = ''
  let logicalSegments: Array<{ absoluteRow: number; text: string }> = []

  const flushLogicalLine = () => {
    if (logicalSegments.length === 0 || logicalText.length === 0 || limitHit) {
      logicalText = ''
      logicalSegments = []
      return
    }

    const haystack = logicalText.toLocaleLowerCase()
    let searchOffset = 0

    while (searchOffset <= haystack.length - normalizedNeedle.length) {
      const found = haystack.indexOf(normalizedNeedle, searchOffset)
      if (found === -1) break

      const match = locateSearchMatch(logicalSegments, found, needle.length)
      if (match) {
        matches.push(match)
      }
      if (matches.length >= TERMINAL_SEARCH_MATCH_LIMIT) {
        limitHit = true
        break
      }

      searchOffset = found + Math.max(1, normalizedNeedle.length)
    }

    logicalText = ''
    logicalSegments = []
  }

  for (let lineIndex = 0; lineIndex < buffer.length; lineIndex += 1) {
    const line = buffer.getLine(lineIndex)
    if (!line) {
      flushLogicalLine()
      continue
    }

    const text = line.translateToString(false, 0, line.length)
    if (line.isWrapped && logicalSegments.length > 0) {
      logicalSegments.push({ absoluteRow: lineIndex, text })
      logicalText += text
    } else {
      flushLogicalLine()
      logicalSegments = [{ absoluteRow: lineIndex, text }]
      logicalText = text
    }

    if (limitHit) break
  }

  flushLogicalLine()
  return { matches, limitHit }
}

function scrollToSearchMatch(term: Terminal, match: SearchMatch) {
  const buffer = term.buffer.active
  const scrollbackLength = Math.max(0, buffer.length - term.rows)
  const preferredTopRow = Math.max(
    0,
    Math.min(scrollbackLength, match.absoluteRow - Math.floor(term.rows * 0.35)),
  )
  term.scrollToLine(scrollbackLength - preferredTopRow)

  requestAnimationFrame(() => {
    const visibleTop = Math.max(0, buffer.length - term.rows - term.viewportY)
    const viewportRow = match.absoluteRow - visibleTop
    if (viewportRow < 0 || viewportRow >= term.rows) return
    term.clearSelection()
    term.select(match.startCol, viewportRow, Math.max(1, match.length))
  })
}

// ---- Terminal instance cache ----
// Keeps ghostty Terminal alive across project switches so state (colors,
// scrollback, cursor position, alternate screen) is never lost.
interface CachedTerminal {
  term: Terminal
  fitAddon: FitAddon
  wrapper: HTMLDivElement // the div term.open() was called on
  cleanups: Array<() => void>
  setPollingEnabled(enabled: boolean): void
}
const terminalCache = new Map<string, CachedTerminal>()

export function getCachedTerminalCount() {
  return terminalCache.size
}

interface TerminalPreviewOptions {
  lines?: number
  columns?: number
}

const TERMINAL_RESTORE_SNAPSHOT_LIMIT = 256 * 1024

interface SerializedCellStyle {
  bg: number
  blink: boolean
  bold: boolean
  faint: boolean
  fg: number
  inverse: boolean
  invisible: boolean
  italic: boolean
  strikethrough: boolean
  underline: boolean
}

function parseHexColor(hex: string) {
  const normalized = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return 0
  return Number.parseInt(normalized, 16)
}

function getRgbChannels(color: number) {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff] as const
}

function getDefaultSerializedCellStyle(themeName: string): SerializedCellStyle {
  const theme = buildTheme(themeName)
  return {
    fg: parseHexColor(theme.foreground),
    bg: parseHexColor(theme.background),
    bold: false,
    faint: false,
    italic: false,
    underline: false,
    strikethrough: false,
    blink: false,
    inverse: false,
    invisible: false,
  }
}

function getSerializedCellStyle(
  cell: { getFgColor(): number; getBgColor(): number; isBold(): number; isItalic(): number } & {
    isUnderline(): number
    isStrikethrough(): number
    isBlink(): number
    isInverse(): number
    isInvisible(): number
    isFaint(): number
  },
): SerializedCellStyle {
  return {
    fg: cell.getFgColor(),
    bg: cell.getBgColor(),
    bold: Boolean(cell.isBold()),
    faint: Boolean(cell.isFaint()),
    italic: Boolean(cell.isItalic()),
    underline: Boolean(cell.isUnderline()),
    strikethrough: Boolean(cell.isStrikethrough()),
    blink: Boolean(cell.isBlink()),
    inverse: Boolean(cell.isInverse()),
    invisible: Boolean(cell.isInvisible()),
  }
}

function areSerializedCellStylesEqual(a: SerializedCellStyle | null, b: SerializedCellStyle) {
  return (
    a !== null &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.faint === b.faint &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.blink === b.blink &&
    a.inverse === b.inverse &&
    a.invisible === b.invisible
  )
}

function buildSgrSequence(style: SerializedCellStyle) {
  const fg = getRgbChannels(style.fg)
  const bg = getRgbChannels(style.bg)
  const codes = ['0']
  if (style.bold) codes.push('1')
  if (style.faint) codes.push('2')
  if (style.italic) codes.push('3')
  if (style.underline) codes.push('4')
  if (style.blink) codes.push('5')
  if (style.inverse) codes.push('7')
  if (style.invisible) codes.push('8')
  if (style.strikethrough) codes.push('9')
  codes.push(`38;2;${fg[0]};${fg[1]};${fg[2]}`)
  codes.push(`48;2;${bg[0]};${bg[1]};${bg[2]}`)
  return `\u001b[${codes.join(';')}m`
}

function getSnapshotViewportRange(term: Terminal) {
  const activeBuffer = term.buffer.active
  const viewportY = Math.max(0, activeBuffer.viewportY ?? 0)
  const start =
    activeBuffer.type === 'alternate'
      ? Math.max(0, activeBuffer.length - term.rows)
      : Math.max(0, activeBuffer.length - term.rows - viewportY)
  const end = Math.min(activeBuffer.length, start + term.rows)
  return { activeBuffer, start, end }
}

function serializeVisibleTerminalSnapshot(term: Terminal, themeName: string) {
  const { activeBuffer, start, end } = getSnapshotViewportRange(term)
  const defaultStyle = getDefaultSerializedCellStyle(themeName)
  const parts: string[] = []
  let activeStyle: SerializedCellStyle | null = null

  if (activeBuffer.type === 'alternate') {
    parts.push('\u001b[?1049h')
  }

  parts.push('\u001b[2J')

  for (let row = 0; row < term.rows; row += 1) {
    parts.push(`\u001b[${row + 1};1H`)
    const line = row < end - start ? activeBuffer.getLine(start + row) : undefined

    for (let col = 0; col < term.cols; col += 1) {
      const cell = line?.getCell(col)
      if (cell && cell.getWidth() === 0) continue

      const style = cell ? getSerializedCellStyle(cell) : defaultStyle
      if (!areSerializedCellStylesEqual(activeStyle, style)) {
        parts.push(buildSgrSequence(style))
        activeStyle = style
      }

      const chars = cell?.getChars() || ' '
      parts.push(chars)
    }
  }

  const cursorRow = Math.max(1, Math.min(term.rows, activeBuffer.cursorY + 1))
  const cursorCol = Math.max(1, Math.min(term.cols, activeBuffer.cursorX + 1))
  const cursorLine = activeBuffer.getLine(start + activeBuffer.cursorY)
  const cursorCell = cursorLine?.getCell(activeBuffer.cursorX)
  const cursorStyle = cursorCell ? getSerializedCellStyle(cursorCell) : defaultStyle
  if (!areSerializedCellStylesEqual(activeStyle, cursorStyle)) {
    parts.push(buildSgrSequence(cursorStyle))
  }
  parts.push(`\u001b[${cursorRow};${cursorCol}H`)

  const snapshot = parts.join('')
  return snapshot.length > TERMINAL_RESTORE_SNAPSHOT_LIMIT ? null : snapshot
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

export function getTerminalRestoreSnapshot(termId: string): string | null {
  const cached = terminalCache.get(termId)
  const term = cached?.term
  if (!term) return null

  const terminalState = useStore.getState().terminals.find((terminal) => terminal.id === termId)
  if (terminalState && shouldPreferSnapshotRestoreForTerminal(terminalState)) {
    return serializeVisibleTerminalSnapshot(term, useStore.getState().terminalTheme)
  }

  const activeBuffer = term.buffer.active
  const logicalLines: string[] = []

  for (let lineIndex = 0; lineIndex < activeBuffer.length; lineIndex += 1) {
    const line = activeBuffer.getLine(lineIndex)
    if (!line) {
      logicalLines.push('')
      continue
    }

    const text = line.translateToString(true, 0, line.length)
    if (line.isWrapped && logicalLines.length > 0) {
      logicalLines[logicalLines.length - 1] += text
    } else {
      logicalLines.push(text)
    }
  }

  while (logicalLines.length > 0 && logicalLines[logicalLines.length - 1] === '') {
    logicalLines.pop()
  }

  if (logicalLines.length === 0) return ''

  const snapshot = logicalLines.join('\r\n')
  return snapshot.length > TERMINAL_RESTORE_SNAPSHOT_LIMIT
    ? snapshot.slice(-TERMINAL_RESTORE_SNAPSHOT_LIMIT)
    : snapshot
}

/** Apply a theme to every cached terminal instance (mounted or not). */
export function applyThemeToAllTerminals(themeName: string) {
  const theme = buildTheme(themeName)
  for (const [, cached] of terminalCache) {
    applyThemeToTerminal(cached.term, theme)
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

export function reloadAllTerminals() {
  for (const termId of [...terminalCache.keys()]) {
    reloadTerminal(termId)
  }
}

interface CellTerminalProps {
  termId: string
  width: number
  height: number
  isVisible: boolean
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

function beginTerminalReplay(term: Terminal) {
  Reflect.set(term, '__cellsReplayPending', true)
  Reflect.set(term, '__cellsPendingReplayData', [] as string[])
}

function queueTerminalReplayData(term: Terminal, data: string) {
  const pending = Reflect.get(term, '__cellsPendingReplayData')
  if (Array.isArray(pending)) {
    pending.push(data)
    return
  }
  Reflect.set(term, '__cellsPendingReplayData', [data] as string[])
}

function finishTerminalReplay(term: Terminal) {
  Reflect.set(term, '__cellsReplayPending', false)
  const pending = Reflect.get(term, '__cellsPendingReplayData')
  Reflect.set(term, '__cellsPendingReplayData', [] as string[])
  return Array.isArray(pending) && pending.length > 0 ? pending.join('') : ''
}

function isTerminalReplayPending(term: Terminal) {
  return Reflect.get(term, '__cellsReplayPending') === true
}

function focusGhosttyInput(term: Terminal) {
  const textarea = (term as Terminal & { textarea?: HTMLTextAreaElement | null }).textarea
  const element = (term as Terminal & { element?: HTMLElement | null }).element

  textarea?.focus({ preventScroll: true })
  element?.focus({ preventScroll: true })

  requestAnimationFrame(() => {
    textarea?.focus({ preventScroll: true })
  })
}

function forceTerminalRepaint(term: Terminal) {
  requestTerminalFullRender(term)

  const repaint = () => {
    if (!term.renderer || !term.wasmTerm) return
    term.renderer.render(term.wasmTerm, true, term.viewportY, term as ScrollbackProvider, 0)
  }

  requestAnimationFrame(repaint)
  window.setTimeout(() => requestAnimationFrame(repaint), 32)
}

function forceFullRenderNow(term: Terminal) {
  Reflect.set(term, '__cellsPendingFullRender', false)
  if (!term.renderer || !term.wasmTerm) return false
  term.renderer.render(term.wasmTerm, true, term.viewportY, term as ScrollbackProvider, 0)
  return true
}

export function CellTerminal({
  termId,
  width,
  height,
  isVisible,
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
  const scrollbackLines = useStore((s) => s.terminalScrollbackLines)
  const cursorStyle = useStore((s) => s.terminalCursorStyle)
  const cursorBlink = useStore((s) => s.terminalCursorBlink)
  const terminalExited = useStore(
    (s) => s.terminals.find((terminal) => terminal.id === termId)?.exited === true,
  )
  const terminalExitStatusMessage = useStore(
    (s) => s.terminals.find((terminal) => terminal.id === termId)?.exitStatusMessage ?? null,
  )
  const overlayOpen = useStore((s) => s.overlayOpen)
  const focusTerminal = useStore((s) => s.focusTerminal)
  const restartTerminalSession = useStore((s) => s.restartTerminalSession)
  const terminalFindOpen = useStore((s) => s.terminalFindOpen)
  const terminalFindQuery = useStore((s) => s.terminalFindQuery)
  const themeNameRef = useRef(themeName)
  const fontSizeRef = useRef(fontSize)
  const fontFamilyRef = useRef(fontFamily)
  const scrollbackLinesRef = useRef(scrollbackLines)
  const cursorStyleRef = useRef<TerminalCursorStyle>(cursorStyle)
  const cursorBlinkRef = useRef(cursorBlink)
  const inferredAgentRef = useRef<AgentName | null>(null)
  const detectedAgentRef = useRef<AgentName | null>(null)
  const inputBufferRef = useRef('')
  const lastInferredTitleRef = useRef<string | null>(null)
  const lastAgentDataRef = useRef<number>(0) // timestamp of last PTY data while agent active
  const lastCodexTitleDataRef = useRef<number>(-1)
  const lastCodexTitleRef = useRef<string | null>(null)
  const agentPollInFlightRef = useRef(false)
  const prevAgentRef = useRef<AgentName | null>(null) // track transitions for done detection
  const agentBellRef = useRef(false) // whether a BEL was heard since last input
  const processTitleRef = useRef(false) // whether the agent process has set its own title
  const dragDepthRef = useRef(0)
  const shouldRenderRef = useRef(isFocused || isVisible)
  const focusStateRef = useRef({ isFocused, isVisible })
  const searchMatchesRef = useRef<SearchMatch[]>([])
  const searchDebounceRef = useRef<number | null>(null)
  const searchLimitHitRef = useRef(false)
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

  const getLiveTerminal = useCallback(
    () => terminalCache.get(termId)?.term ?? terminalRef.current,
    [termId],
  )

  useEffect(() => {
    focusStateRef.current = { isFocused, isVisible }
  }, [isFocused, isVisible])

  useEffect(() => {
    themeNameRef.current = themeName
  }, [themeName])

  useEffect(() => {
    fontSizeRef.current = fontSize
  }, [fontSize])

  useEffect(() => {
    fontFamilyRef.current = fontFamily
  }, [fontFamily])

  useEffect(() => {
    scrollbackLinesRef.current = scrollbackLines
  }, [scrollbackLines])

  useEffect(() => {
    cursorStyleRef.current = cursorStyle
  }, [cursorStyle])

  useEffect(() => {
    cursorBlinkRef.current = cursorBlink
  }, [cursorBlink])

  const syncTerminalState = useCallback(
    (term: Terminal | null = getLiveTerminal()) => {
      if (!term) return

      const { isFocused: focused, isVisible: visible } = focusStateRef.current
      const shouldRender = focused || visible
      shouldRenderRef.current = shouldRender
      setTerminalRenderLoopEnabled(term, shouldRender)

      requestAnimationFrame(() => {
        if (focused) {
          focusGhosttyInput(term)
        } else {
          term.blur()
        }

        if (shouldRender && term.renderer && term.wasmTerm) {
          term.renderer.render(term.wasmTerm, true, term.viewportY, term as ScrollbackProvider, 0)
        }
      })
    },
    [getLiveTerminal],
  )

  const pasteToTerminal = useCallback(
    (text: string) => {
      const term = getLiveTerminal()
      if (!term || !text) return
      focusTerminal(termId)
      focusGhosttyInput(term)
      term.paste(text)
    },
    [focusTerminal, getLiveTerminal, termId],
  )

  const copySelectionToClipboard = useCallback(() => {
    const term = getLiveTerminal()
    if (!term || !term.hasSelection()) return false
    const selection = term.getSelection()
    if (!selection) return false
    void navigator.clipboard.writeText(selection).catch(() => {})
    return true
  }, [getLiveTerminal])

  const relaunchTerminal = useCallback(() => {
    restartTerminalSession(termId)
  }, [restartTerminalSession, termId])

  const refreshTerminalSearch = useCallback(() => {
    const term = getLiveTerminal()
    if (!term) return

    if (!terminalFindOpen || !isFocused) {
      searchMatchesRef.current = []
      searchLimitHitRef.current = false
      term.clearSelection()
      if (useStore.getState().terminalFindResultTermId === termId) {
        useStore.getState().setTerminalFindResults(termId, 0, 0, false)
      }
      return
    }

    const query = terminalFindQuery.trim()
    if (!query) {
      searchMatchesRef.current = []
      searchLimitHitRef.current = false
      term.clearSelection()
      useStore.getState().setTerminalFindResults(termId, 0, 0, false)
      return
    }

    const results = buildSearchMatches(term, query)
    searchMatchesRef.current = results.matches
    searchLimitHitRef.current = results.limitHit

    if (results.matches.length === 0) {
      term.clearSelection()
      useStore.getState().setTerminalFindResults(termId, 0, 0, results.limitHit)
      return
    }

    const store = useStore.getState()
    const previousActive =
      store.terminalFindResultTermId === termId ? Math.max(0, store.terminalFindActiveIndex - 1) : 0
    const nextActive = Math.min(previousActive, results.matches.length - 1)
    scrollToSearchMatch(term, results.matches[nextActive])
    store.setTerminalFindResults(termId, results.matches.length, nextActive + 1, results.limitHit)
  }, [getLiveTerminal, isFocused, termId, terminalFindOpen, terminalFindQuery])

  const scheduleTerminalSearchRefresh = useCallback(
    (delayMs = 50) => {
      if (searchDebounceRef.current) {
        window.clearTimeout(searchDebounceRef.current)
      }
      searchDebounceRef.current = window.setTimeout(() => {
        searchDebounceRef.current = null
        refreshTerminalSearch()
      }, delayMs)
    },
    [refreshTerminalSearch],
  )

  useEffect(() => {
    onTitleChangeRef.current = onTitleChange
  }, [onTitleChange])

  useEffect(() => {
    scheduleTerminalSearchRefresh(0)
    return () => {
      if (searchDebounceRef.current) {
        window.clearTimeout(searchDebounceRef.current)
        searchDebounceRef.current = null
      }
    }
  }, [scheduleTerminalSearchRefresh])

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      if (!isFocused || !terminalFindOpen) return
      const query = terminalFindQuery.trim()
      if (!query) return

      const term = getLiveTerminal()
      const matches = searchMatchesRef.current
      if (!term || matches.length === 0) return

      const direction =
        (event as CustomEvent<{ direction?: 1 | -1 }>).detail?.direction === -1 ? -1 : 1
      const store = useStore.getState()
      const currentIndex =
        store.terminalFindResultTermId === termId && store.terminalFindActiveIndex > 0
          ? store.terminalFindActiveIndex - 1
          : 0
      const nextIndex = (currentIndex + direction + matches.length) % matches.length

      scrollToSearchMatch(term, matches[nextIndex])
      store.setTerminalFindResults(termId, matches.length, nextIndex + 1, searchLimitHitRef.current)
    }

    window.addEventListener('terminal-find-navigate', handleNavigate as EventListener)
    return () => {
      window.removeEventListener('terminal-find-navigate', handleNavigate as EventListener)
    }
  }, [getLiveTerminal, isFocused, termId, terminalFindOpen, terminalFindQuery])

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
        processTitleRef.current = false
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
        processTitleRef.current = false
        return
      }

      const activeAgent = detectedAgentRef.current ?? inferredAgentRef.current
      if (!activeAgent) return

      // If the agent process has already set its own title (via escape sequences),
      // don't overwrite it with inferred titles from user input.
      if (processTitleRef.current) return

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
      const bumpPtySize = (cols: number, rows: number) => {
        // Force a real SIGWINCH so shells and fullscreen TUIs redraw after
        // the terminal is reattached. A same-size resize is a no-op at the
        // PTY layer, so briefly bump the width and restore it.
        const bumpCols = Math.max(1, cols - 1)
        window.cells.terminal.resize(termId, bumpCols, rows)
        setTimeout(() => {
          if (cancelled) return
          window.cells.terminal.resize(termId, cols, rows)
        }, 50)
      }

      // Check cache first — reattach if exists
      const cached = terminalCache.get(termId)
      if (cached) {
        const terminalState = useStore
          .getState()
          .terminals.find((terminal) => terminal.id === termId)
        const avoidSyntheticResize = Boolean(
          terminalState && shouldAvoidSyntheticResizeForTerminal(terminalState),
        )
        patchTerminalViewportPreservation(cached.term)
        patchTerminalFullRenderScheduler(cached.term)
        // Move the existing DOM back into our container
        cached.wrapper.style.backgroundColor = buildTheme(themeNameRef.current).background
        container.appendChild(cached.wrapper)
        terminalRef.current = cached.term
        fitAddonRef.current = cached.fitAddon
        cached.setPollingEnabled(true)
        syncTerminalState(cached.term)
        beginTerminalReplay(cached.term)

        // Fit first, then get accurate dimensions for attach
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            cached.fitAddon.fit()
            resolve()
          })
        })

        const dims = cached.fitAddon.proposeDimensions()
        let result: Awaited<ReturnType<typeof window.cells.terminal.attach>>
        try {
          result = await window.cells.terminal.attach(
            termId,
            dims?.cols ?? 80,
            dims?.rows ?? 24,
            useStore.getState().getActiveProjectPath(),
          )
        } catch (error) {
          finishTerminalReplay(cached.term)
          throw error
        }

        // Replay any data buffered while this terminal was in another project
        if (result?.buffer) {
          cached.term.write(result.buffer)
        }
        const replayChunk = finishTerminalReplay(cached.term)
        if (replayChunk) {
          cached.term.write(replayChunk)
        }

        // Force a full redraw after DOM reattachment — the canvas backing
        // store may have been reclaimed while the wrapper was detached,
        // leaving the terminal visually stale or blank even though the
        // internal buffer state is correct.
        requestAnimationFrame(() => {
          const t = cached.term
          if (shouldRenderRef.current && t.renderer && t.wasmTerm) {
            t.renderer.render(t.wasmTerm, true, t.viewportY, t as ScrollbackProvider, 0)
          }
        })
        forceTerminalRepaint(cached.term)

        if (result?.reattached && dims && !avoidSyntheticResize) {
          bumpPtySize(dims.cols, dims.rows)
        }

        syncTerminalState(cached.term)
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
        cursorBlink: cursorBlinkRef.current,
        cursorStyle: cursorStyleRef.current ?? DEFAULT_TERMINAL_CURSOR_SETTINGS.terminalCursorStyle,
        fontSize: fontSizeRef.current,
        fontFamily: fontFamilyRef.current,
        theme: buildTheme(themeNameRef.current),
        scrollback: scrollbackLinesRef.current || DEFAULT_TERMINAL_SCROLLBACK_LINES,
        smoothScrollDuration: GHOSTTY_SMOOTH_SCROLL_DURATION_MS,
      })
      patchTerminalViewportPreservation(term)

      if (cancelled) {
        term.dispose()
        wrapper.remove()
        return
      }

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(wrapper)
      patchTerminalFullRenderScheduler(term)
      fitAddon.observeResize()
      setTerminalRenderLoopEnabled(term, shouldRenderRef.current)

      terminalRef.current = term
      fitAddonRef.current = fitAddon
      syncTerminalState(term)

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

      // ghostty-web registers its own providers during open(). Replace them so
      // our routing logic controls where links open without duplicate scans.
      replaceLinkProviders(term, [
        wrapProvider(new OSC8LinkProvider(term as any)),
        wrapProvider(new UrlRegexProvider(term as any)),
      ])

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
          if (normalizedKey === 'f') {
            if (e.type === 'keydown') {
              e.preventDefault()
              useStore.getState().openTerminalFind()
              window.dispatchEvent(new Event('terminal-find-focus'))
            }
            return true
          }

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
              pasteToTerminal(filePaths.map(shellEscapePath).join(' ') + ' ')
              return
            }
            // Fallback to text
            const text = await navigator.clipboard.readText()
            if (text) pasteToTerminal(text)
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

      // Batch incoming PTY data and flush in a single term.write() per frame.
      // During rapid output (e.g. Claude streaming), many small IPC messages
      // arrive between frames.  Writing each one individually causes the WASM
      // terminal to process partial ANSI sequences across separate write
      // boundaries, and its dirty-row tracking can miss scroll-induced content
      // shifts — rows that moved up due to scrolling aren't marked dirty, so
      // the Canvas2D renderer paints stale content over them.  Batching into
      // one write per frame gives the WASM state machine a single consistent
      // chunk so scroll events and dirty flags are handled atomically.
      let writeBuf = ''
      let writeRaf = 0
      beginTerminalReplay(term)
      let perfWindowStart = performance.now()
      let perfBytes = 0
      let perfWriteCalls = 0
      let perfForcedFullRenders = 0
      // How many lines from bottom the user must scroll before we stop
      // auto-scrolling to bottom on new output.
      const SCROLL_LOCK_THRESHOLD = 5
      const termCanvas = wrapper.querySelector('canvas') as HTMLCanvasElement | null
      const reportTerminalPerf = () => {
        perfForcedFullRenders += consumeTerminalFullRenderCount(term)
        const sampleWindowMs = Math.max(1, Math.round(performance.now() - perfWindowStart))
        if (perfBytes <= 0 && perfWriteCalls <= 0 && perfForcedFullRenders <= 0) {
          perfWindowStart = performance.now()
          return
        }

        const sample: TerminalPerfSample = {
          termId,
          sampleWindowMs,
          bytes: perfBytes,
          writeCalls: perfWriteCalls,
          forcedFullRenders: perfForcedFullRenders,
          viewportY: term.viewportY,
          scrollbackLines: term.getScrollbackLength(),
          isFocused: focusStateRef.current.isFocused,
          isVisible: focusStateRef.current.isVisible,
        }
        window.cells.perf.reportTerminalSample(sample)

        perfWindowStart = performance.now()
        perfBytes = 0
        perfWriteCalls = 0
        perfForcedFullRenders = 0
      }
      const flushWrites = () => {
        writeRaf = 0
        if (!writeBuf) return
        const chunk = writeBuf
        writeBuf = ''

        // If the user has scrolled up past the threshold, preserve their
        // viewport position instead of letting writeInternal snap to bottom.
        const scrolledUp = term.viewportY > SCROLL_LOCK_THRESHOLD
        const savedY = term.viewportY
        const savedTargetY = (term as any).targetViewportY ?? term.viewportY
        const savedLen = term.getScrollbackLength()

        Reflect.set(term, '__cellsPreserveViewportOnWrite', scrolledUp)
        term.write(chunk)
        Reflect.set(term, '__cellsPreserveViewportOnWrite', false)
        perfBytes += chunk.length
        perfWriteCalls += 1
        const newLen = term.getScrollbackLength()
        const scrollbackDelta = newLen - savedLen

        if (scrolledUp) {
          // Adjust for any new lines that were added to the scrollback so
          // the user keeps looking at the same content.
          ;(term as any).viewportY = Math.min(newLen, savedY + scrollbackDelta)
          ;(term as any).targetViewportY = Math.min(newLen, savedTargetY + scrollbackDelta)
        } else if (termCanvas) {
          // At the bottom — clear any sub-pixel scroll transform
          termCanvas.style.transform = ''
        }

        // ghostty-web's dirty-row tracking is not reliable enough for complex
        // cursor-addressed redraws such as TUIs and terminal QR renderers. We
        // still avoid the old "force immediately on every flush" behavior:
        // instead, mark each flushed write for a full repaint and let the
        // patched renderer coalesce/throttle the actual work.
        if (shouldRenderRef.current && (chunk.length > 0 || scrollbackDelta > 0)) {
          const activeAgent = detectedAgentRef.current ?? inferredAgentRef.current

          // Claude's streaming output is line-oriented and visibly smears if we
          // defer full repaints. Keep the pre-Codex behavior here: repaint on
          // every flushed chunk. Codex and fullscreen TUIs stay on the throttled
          // scheduler introduced for cursor-addressed redraw performance.
          if (activeAgent === 'claude') {
            if (forceFullRenderNow(term)) {
              perfForcedFullRenders += 1
            }
          } else {
            requestTerminalFullRender(term)
          }
        }

        if (terminalFindOpen && focusStateRef.current.isFocused) {
          scheduleTerminalSearchRefresh()
        }
      }

      // These listeners live in the cache — they persist across mount/unmount
      cleanups.push(
        () => {
          if (writeRaf) {
            cancelAnimationFrame(writeRaf)
            writeRaf = 0
          }
          // Flush any remaining buffered data so nothing is lost
          if (writeBuf) {
            term.write(writeBuf)
            perfBytes += writeBuf.length
            perfWriteCalls += 1
            writeBuf = ''
          }
          reportTerminalPerf()
        },
        term.onTitleChange((title) => {
          lastInferredTitleRef.current = title || 'Terminal'
          onTitleChangeRef.current?.(title || 'Terminal')
          // If an agent is active and the process sets its own title,
          // remember that so we don't overwrite it with inferred titles.
          const agent = detectedAgentRef.current ?? inferredAgentRef.current
          if (agent) processTitleRef.current = true
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
        term.onResize(({ cols, rows }) => {
          window.cells.terminal.resize(termId, cols, rows)
        }).dispose,
        window.cells.terminal.onData((id, data) => {
          if (id === termId) {
            if (isTerminalReplayPending(term)) {
              queueTerminalReplayData(term, data)
              return
            }

            // Accumulate data and schedule a single flush per frame
            writeBuf += data
            if (!writeRaf) writeRaf = requestAnimationFrame(flushWrites)

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
      )
      const perfInterval = window.setInterval(reportTerminalPerf, 10_000)
      cleanups.push(() => window.clearInterval(perfInterval))

      // Handle paste events from any source (Raycast, right-click, etc.)
      const handlePaste = (e: ClipboardEvent) => {
        e.preventDefault()
        const text = e.clipboardData?.getData('text')
        if (text) pasteToTerminal(text)
      }
      wrapper.addEventListener('paste', handlePaste)
      cleanups.push(() => wrapper.removeEventListener('paste', handlePaste))

      let agentPoll: ReturnType<typeof setInterval> | null = null
      const runAgentPoll = async () => {
        if (agentPollInFlightRef.current) return
        agentPollInFlightRef.current = true
        try {
          const procInfo = await window.cells.terminal.getProcessInfo(termId)
          if (cancelled) return

          const proc = procInfo?.command ?? null
          const agent = normalizeAgentProcess(proc)
          const wasAgent = prevAgentRef.current
          detectedAgentRef.current = agent
          if (agent) inferredAgentRef.current = agent
          prevAgentRef.current = agent

          const store = useStore.getState()
          const current = store.terminals.find((t) => t.id === termId)

          // Track whether any non-shell process is running (for subtle indicator)
          const hasProcess = Boolean(procInfo && !procInfo.isShell && !agent)
          if (current?.processRunning !== hasProcess) {
            store.updateTerminalProcessRunning(termId, hasProcess)
          }
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
              // User focused an idle agent terminal — acknowledge & clear,
              // but only after they've been looking at it for at least 2s
              const focusedFor = Date.now() - store.focusedTerminalSince
              if (focusedFor >= 2000) {
                newStatus = null
              }
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
            lastCodexTitleDataRef.current = -1
            lastCodexTitleRef.current = null
            agentBellRef.current = false
            // Clear inferred agent so subsequent shell output doesn't
            // re-trigger the active → unread cycle on a dead agent
            inferredAgentRef.current = null
          }

          if (agent === 'codex') {
            const shouldRefreshCodexTitle =
              lastCodexTitleRef.current === null ||
              lastCodexTitleDataRef.current !== lastAgentDataRef.current
            if (shouldRefreshCodexTitle) {
              const codexTitle = await window.cells.terminal.getCodexTitle(termId)
              if (cancelled) return
              lastCodexTitleDataRef.current = lastAgentDataRef.current
              lastCodexTitleRef.current = codexTitle
              if (codexTitle) {
                setInferredTitle(formatAgentWindowTitle('codex', codexTitle))
              }
            }
          } else {
            lastCodexTitleDataRef.current = -1
            lastCodexTitleRef.current = null
          }
        } finally {
          agentPollInFlightRef.current = false
        }
      }
      const setPollingEnabled = (enabled: boolean) => {
        if (enabled) {
          if (agentPoll) return
          agentPoll = setInterval(() => {
            void runAgentPoll()
          }, 3000)
          void runAgentPoll()
          return
        }
        if (agentPoll) {
          clearInterval(agentPoll)
          agentPoll = null
        }
      }
      cleanups.push(() => setPollingEnabled(false))

      // Store in cache
      terminalCache.set(termId, { term, fitAddon, wrapper, cleanups, setPollingEnabled })
      setPollingEnabled(true)

      const dims = fitAddon.proposeDimensions()
      const worktreeCwd = consumePendingWorktreePath(termId)
      const projectPath = worktreeCwd ?? useStore.getState().getActiveProjectPath()
      const terminalState = useStore.getState().terminals.find((terminal) => terminal.id === termId)
      const avoidSyntheticResize = Boolean(
        terminalState && shouldAvoidSyntheticResizeForTerminal(terminalState),
      )
      const restoredOutput = terminalState?.restoredOutput ?? ''
      const preferSnapshotRestore =
        restoredOutput.length > 0 &&
        Boolean(terminalState && shouldPreferSnapshotRestoreForTerminal(terminalState))
      let result: Awaited<ReturnType<typeof window.cells.terminal.attach>>
      try {
        result = await window.cells.terminal.attach(
          termId,
          dims?.cols ?? 80,
          dims?.rows ?? 24,
          projectPath,
        )
      } catch (error) {
        finishTerminalReplay(term)
        throw error
      }

      let replayedRawHistory = false
      if (result?.reattached && !preferSnapshotRestore) {
        try {
          await replayPagedTerminalHistory(termId, term)
          replayedRawHistory = true
        } catch {
          const history = await window.cells.terminal.getHistory(termId).catch(() => '')
          if (history) {
            await writeHistoryChunk(term, history)
            replayedRawHistory = true
          }
        }
      }

      if (!replayedRawHistory && restoredOutput && (!result?.reattached || preferSnapshotRestore)) {
        term.write(restoredOutput)
        if (!preferSnapshotRestore && !restoredOutput.endsWith('\r\n')) {
          term.write('\r\n')
        }
      }

      if (!replayedRawHistory && result?.buffer) {
        term.write(result.buffer)
      }

      const replayChunk = finishTerminalReplay(term)
      if (replayChunk) {
        writeBuf += replayChunk
        if (!writeRaf) writeRaf = requestAnimationFrame(flushWrites)
      }

      scheduleTerminalSearchRefresh(0)

      if (result?.reattached && dims && !avoidSyntheticResize) {
        bumpPtySize(dims.cols, dims.rows)
      }

      const pendingCmd = consumePendingCommand(termId)
      if (pendingCmd) {
        setTimeout(() => {
          if (!cancelled) window.cells.terminal.write(termId, pendingCmd + '\n')
        }, 150)
      }

      syncTerminalState(term)
      forceTerminalRepaint(term)
    }

    setup()

    return () => {
      cancelled = true
      // DON'T dispose — just detach DOM. Terminal stays alive in cache.
      const cached = terminalCache.get(termId)
      cached?.setPollingEnabled(false)
      setTerminalRenderLoopEnabled(cached?.term ?? null, false)
      if (cached && container?.contains(cached.wrapper)) {
        container.removeChild(cached.wrapper)
      }
      terminalRef.current = null
      fitAddonRef.current = null
      inputBufferRef.current = ''
      // Tell main process to buffer instead of sending live IPC
      window.cells.terminal.unsubscribe(termId)
    }
  }, [
    copySelectionToClipboard,
    pasteToTerminal,
    reloadKey,
    scheduleTerminalSearchRefresh,
    setInferredTitle,
    syncTerminalState,
    terminalFindOpen,
    termId,
    trackInputForTitle,
  ])

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
      const selection = getLiveTerminal()?.getSelection()
      if (selection) event.clipboardData?.setData('text/plain', selection)
    }

    document.addEventListener('copy', handleCopy, true)
    return () => document.removeEventListener('copy', handleCopy, true)
  }, [copySelectionToClipboard, getLiveTerminal, isFocused])

  // Theme/font updates
  useEffect(() => {
    const term = terminalRef.current
    if (!term) return

    const theme = buildTheme(themeName)
    applyThemeToTerminal(term, theme)
    if (term.options.cursorStyle !== cursorStyle) {
      term.options.cursorStyle = cursorStyle
    }
    if (term.options.cursorBlink !== cursorBlink) {
      term.options.cursorBlink = cursorBlink
    }
    if (term.options.smoothScrollDuration !== GHOSTTY_SMOOTH_SCROLL_DURATION_MS) {
      term.options.smoothScrollDuration = GHOSTTY_SMOOTH_SCROLL_DURATION_MS
    }

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
      })
    }
  }, [termId, themeName, fontSize, fontFamily, cursorStyle, cursorBlink])

  // Auto-focus + force repaint for reattached daemon sessions that may have
  // a stale/blank canvas despite having content in the internal buffer.
  // When unfocused, blur the terminal so keystrokes don't reach it (e.g. in
  // overview mode).
  useEffect(() => {
    syncTerminalState()
  }, [isFocused, isVisible, syncTerminalState])

  useEffect(() => {
    if (!terminalExited) return
    getLiveTerminal()?.blur()
  }, [getLiveTerminal, terminalExited])

  // Re-focus the terminal when overlays (command palette, etc.) close
  useEffect(() => {
    const handler = () => {
      const term = getLiveTerminal()
      if (isFocused && term) {
        focusGhosttyInput(term)
        forceTerminalRepaint(term)
      }
    }
    window.addEventListener('terminal-refocus', handler)
    return () => window.removeEventListener('terminal-refocus', handler)
  }, [getLiveTerminal, isFocused])

  // Let ghostty-web handle normal wheel scrolling. The custom sub-pixel canvas
  // transform looked smoother on paper, but in practice it fights the terminal's
  // own repaint cycle and feels less stable than VS Code's native xterm scroll.
  // Keep only Cmd/Ctrl+wheel interception here so canvas zoom still works.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()

      const rect = container.getBoundingClientRect()
      const current = useStore.getState().canvas
      const zoomIntensity = 0.01
      const newScale = Math.max(
        CANVAS_MIN_ZOOM,
        Math.min(CANVAS_MAX_ZOOM, current.scale * (1 - e.deltaY * zoomIntensity)),
      )
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const ratio = newScale / current.scale
      useStore.getState().setCanvasTransform({
        x: mouseX - (mouseX - current.x) * ratio,
        y: mouseY - (mouseY - current.y) * ratio,
        scale: newScale,
      })
    }

    container.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => container.removeEventListener('wheel', onWheel, { capture: true })
  }, [termId])

  // Handle resize
  useEffect(() => {
    if (!fitAddonRef.current || !terminalRef.current) return
    const timer = setTimeout(() => {
      fitAddonRef.current?.fit()
    }, 100)
    return () => clearTimeout(timer)
  }, [width, height])

  return (
    <div
      ref={containerRef}
      className="cell-terminal relative w-full h-full"
      onMouseDownCapture={() => {
        if (!isFocused || overlayOpen || terminalExited) return
        const term = getLiveTerminal()
        if (term) focusGhosttyInput(term)
      }}
      onKeyDownCapture={(event) => {
        if (!terminalExited) return
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
        if (event.key !== 'Enter') return
        event.preventDefault()
        event.stopPropagation()
        relaunchTerminal()
      }}
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
      {terminalExited && (
        <>
          <div
            className="absolute inset-0 z-[25]"
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
          />
          <div className="absolute inset-x-3 bottom-3 z-30">
            <div className="flex items-center gap-3 rounded-lg border border-amber-400/15 bg-background/92 px-3 py-2 shadow-lg backdrop-blur">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-foreground">{terminalExitStatusMessage}</div>
                <div className="text-[10px] text-muted-foreground/40">
                  History is preserved. Relaunch to start a fresh shell in this window.
                </div>
              </div>
              <button
                type="button"
                onClick={relaunchTerminal}
                className="shrink-0 rounded-md border border-border/20 bg-background/60 px-2.5 py-1 text-[10px] text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                Relaunch shell
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
