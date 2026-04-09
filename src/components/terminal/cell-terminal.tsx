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

type ScrollbackProvider = NonNullable<Parameters<CanvasRenderer['render']>[3]>
import { useStore, consumePendingCommand, consumePendingWorktreePath } from '@/lib/store'
import { DEFAULT_TERMINAL_CURSOR_SETTINGS, type TerminalCursorStyle } from '@/lib/terminal-cursor'
import { isServerOwnedTerminalBackend } from '@/lib/terminal-session-backend'
import { DEFAULT_TERMINAL_SCROLLBACK_LINES } from '@/lib/terminal-scrollback'
import {
  getTerminalIndexedColor,
  getTerminalTheme,
  hexToRgb,
  rgbToXtermQueryColor,
} from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'
import { WebGLTerminalRenderer } from '@/lib/webgl-terminal-renderer'
import type { TerminalPerfSample } from '@/types'
import { registerTerminalCacheApi } from './terminal-cache-api'

// Initialize WASM lazily on first terminal mount
let ghosttyReady: Promise<void> | null = null
let ghosttyRendererPatched = false

const GHOSTTY_SMOOTH_SCROLL_DURATION_MS = 125
const CANVAS_MIN_ZOOM = 0.15
const CANVAS_MAX_ZOOM = 1.5
const HISTORY_PAGE_BYTES = 256 * 1024
const HISTORY_WRITE_BYTES = 64 * 1024
const TERMINAL_SEARCH_MATCH_LIMIT = 2_000
const TERMINAL_ATTACH_RETRY_DELAYS_MS = [0, 250, 1000] as const
const SERVER_OWNED_ATTACH_RECOVERY_DELAYS_MS = [800, 1600] as const
const SERVER_OWNED_WHEEL_HANDLED_KEY = '__cellsServerOwnedWheelHandled'
const SERVER_OWNED_MOUSE_FLUSH_MS = 16
const SERVER_OWNED_MOUSE_HANDLED_KEY = '__cellsServerOwnedMouseHandled'

type TerminalAttachResponse = {
  reattached: boolean
  buffer: string
  backend: 'replay' | 'tmux' | 'zellij'
}

type QueuedWheelPayload = {
  direction: 'up' | 'down'
  delta: number
  x: number
  y: number
  modifier: number
}

type MouseCellPosition = {
  x: number
  y: number
}

function patchGhosttyRenderer() {
  if (ghosttyRendererPatched) return
  ghosttyRendererPatched = true

  const proto = CanvasRenderer.prototype as any
  const originalRenderCursor = proto.renderCursor
  const originalRenderCellText = proto.renderCellText

  function colorDistance(
    left: { r: number; g: number; b: number },
    right: { r: number; g: number; b: number },
  ) {
    return Math.sqrt((left.r - right.r) ** 2 + (left.g - right.g) ** 2 + (left.b - right.b) ** 2)
  }

  function isDarkThemeBackground(theme: { background?: string }) {
    const rgb = theme.background ? hexToRgb(theme.background) : null
    if (!rgb) return false
    return rgb.r + rgb.g + rgb.b < 3 * 128
  }

  function clampUnreadableForeground(
    theme: { background?: string; brightBlack?: string; __cellsBackend?: string | null },
    color: { r: number; g: number; b: number },
  ) {
    const background = theme.background ? hexToRgb(theme.background) : null
    const fallback = theme.brightBlack ? hexToRgb(theme.brightBlack) : null
    if (!background || !fallback || !isDarkThemeBackground(theme)) return color
    if (theme.__cellsBackend !== 'zellij') return color

    // Some apps emit literal black or near-black foregrounds even on dark
    // themes. Native terminals often keep this legible via palette/contrast
    // handling; ghostty-web currently paints the raw RGB and the text vanishes.
    if (colorDistance(color, background) < 84 && color.r + color.g + color.b < 180) {
      return fallback
    }

    return color
  }

  function getFaintAlpha(theme: { __cellsBackend?: string | null }) {
    // Zellij/Codex uses dim styling more aggressively than tmux/native Ghostty.
    // ghostty-web's default 0.5 opacity makes those rows look washed out.
    return theme.__cellsBackend === 'zellij' ? 0.78 : 0.5
  }

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
    if (cell.flags & CellFlags.FAINT) this.ctx.globalAlpha = getFaintAlpha(this.theme)

    const grapheme = this.currentBuffer?.getGraphemeString?.(y, x)
    const text = grapheme || String.fromCodePoint(cell.codepoint || 32)
    this.ctx.fillText(text, cursorX, cursorY + this.metrics.baseline)

    if (cell.flags & CellFlags.FAINT) this.ctx.globalAlpha = 1
  }

  proto.renderCellText = function renderCellTextPatched(
    this: any,
    cell: any,
    x: number,
    y: number,
  ) {
    if (!cell || cell.flags & CellFlags.INVISIBLE) {
      return originalRenderCellText.call(this, cell, x, y)
    }

    const px = x * this.metrics.width
    const py = y * this.metrics.height
    const width = this.metrics.width * cell.width
    const inSelection = this.isInSelection(x, y)
    let font = ''
    if (cell.flags & CellFlags.ITALIC) font += 'italic '
    if (cell.flags & CellFlags.BOLD) font += 'bold '
    this.ctx.font = `${font}${this.fontSize}px ${this.fontFamily}`

    if (inSelection) {
      this.ctx.fillStyle = this.theme.selectionForeground
    } else {
      let r = cell.fg_r
      let g = cell.fg_g
      let b = cell.fg_b
      if (cell.flags & CellFlags.INVERSE) {
        r = cell.bg_r
        g = cell.bg_g
        b = cell.bg_b
      }
      const clamped = clampUnreadableForeground(this.theme, { r, g, b })
      this.ctx.fillStyle = this.rgbToCSS(clamped.r, clamped.g, clamped.b)
    }

    if (cell.flags & CellFlags.FAINT) this.ctx.globalAlpha = getFaintAlpha(this.theme)

    let text: string
    if (cell.grapheme_len > 0 && this.currentBuffer?.getGraphemeString) {
      text = this.currentBuffer.getGraphemeString(y, x)
    } else {
      text = String.fromCodePoint(cell.codepoint || 32)
    }
    this.ctx.fillText(text, px, py + this.metrics.baseline)

    if (cell.flags & CellFlags.FAINT) this.ctx.globalAlpha = 1

    if (cell.codepoint && cell.flags & CellFlags.UNDERLINE) {
      const underlineY = py + this.metrics.baseline + 2
      this.ctx.strokeStyle = this.ctx.fillStyle
      this.ctx.lineWidth = 1
      this.ctx.beginPath()
      this.ctx.moveTo(px, underlineY)
      this.ctx.lineTo(px + width, underlineY)
      this.ctx.stroke()
    }

    if (cell.codepoint && cell.flags & CellFlags.STRIKETHROUGH) {
      const strikeY = py + this.metrics.height / 2
      this.ctx.strokeStyle = this.ctx.fillStyle
      this.ctx.lineWidth = 1
      this.ctx.beginPath()
      this.ctx.moveTo(px, strikeY)
      this.ctx.lineTo(px + width, strikeY)
      this.ctx.stroke()
    }
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

/** Force an immediate full render of the terminal canvas. */
function forceTerminalFullRender(term: Terminal): boolean {
  if (!term.renderer || !term.wasmTerm) return false
  term.renderer.render(term.wasmTerm, true, term.viewportY, term as ScrollbackProvider, 0)
  return true
}

function usesServerOwnedTerminalState(term: Terminal | null | undefined) {
  return Reflect.get(term as object, '__cellsUsesServerOwnedState') === true
}

function getTerminalBackend(term: Terminal | null | undefined) {
  const backend = Reflect.get(term as object, '__cellsTerminalBackend')
  return backend === 'tmux' || backend === 'zellij' || backend === 'replay' ? backend : null
}

function getMouseWheelSequencePayload(
  event: WheelEvent,
  term: Terminal,
  element: HTMLElement,
): QueuedWheelPayload | null {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return null

  const position = getMouseCellPosition(event, term, element)
  if (!position) return null

  const modifier = getMouseModifierMask(event)
  const delta =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? Math.abs(event.deltaY) * 0.45
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? Math.abs(event.deltaY) * Math.max(1, term.rows / 6)
        : Math.abs(event.deltaY / 36)

  return {
    direction: event.deltaY < 0 ? 'up' : 'down',
    delta,
    x: position.x,
    y: position.y,
    modifier,
  }
}

function getMouseCellPosition(
  event: MouseEvent,
  term: Terminal,
  element: HTMLElement,
): MouseCellPosition | null {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0 || term.cols <= 0 || term.rows <= 0) return null

  const cellWidth = rect.width / term.cols
  const cellHeight = rect.height / term.rows
  return {
    x: Math.max(1, Math.min(term.cols, Math.floor((event.clientX - rect.left) / cellWidth) + 1)),
    y: Math.max(1, Math.min(term.rows, Math.floor((event.clientY - rect.top) / cellHeight) + 1)),
  }
}

function getMouseModifierMask(event: MouseEvent) {
  let modifier = 0
  if (event.shiftKey) modifier += 4
  if (event.altKey) modifier += 8
  if (event.ctrlKey) modifier += 16
  return modifier
}

function getMouseButtonBase(button: number) {
  if (button === 1) return 1
  if (button === 2) return 2
  return 0
}

function getMouseMoveButtonBase(buttons: number) {
  if (buttons & 1) return 0
  if (buttons & 4) return 1
  if (buttons & 2) return 2
  return 3
}

function getMouseSequencePayload(
  event: MouseEvent,
  term: Terminal,
  element: HTMLElement,
  kind: 'press' | 'release' | 'move',
): string | null {
  const position = getMouseCellPosition(event, term, element)
  if (!position) return null

  const modifier = getMouseModifierMask(event)
  if (kind === 'press' && event.button > 2) return null

  let button: number
  let suffix: 'M' | 'm' = 'M'

  if (kind === 'press') {
    button = getMouseButtonBase(event.button) + modifier
  } else if (kind === 'release') {
    button = getMouseButtonBase(event.button) + modifier
    suffix = 'm'
  } else {
    button = getMouseMoveButtonBase(event.buttons) + 32 + modifier
  }

  return `\x1b[<${button};${position.x};${position.y}${suffix}`
}

function buildTheme(themeName: string, backend?: 'tmux' | 'zellij' | 'replay' | null) {
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
    __cellsBackend: backend ?? null,
  }
}

function buildPaletteQueryReply(command: string, payload: string, themeName: string) {
  const theme = getTerminalTheme(themeName)
  const wrapOsc = (body: string) => `\x1b]${body}\x1b\\`

  if (command === '10' && payload === '?') {
    const color = hexToRgb(theme.foreground)
    return color ? wrapOsc(`10;${rgbToXtermQueryColor(color)}`) : ''
  }

  if (command === '11' && payload === '?') {
    const color = hexToRgb(theme.background)
    return color ? wrapOsc(`11;${rgbToXtermQueryColor(color)}`) : ''
  }

  if (command === '12' && payload === '?') {
    const color = hexToRgb(theme.cursor)
    return color ? wrapOsc(`12;${rgbToXtermQueryColor(color)}`) : ''
  }

  if (command === '4') {
    const [indexText, spec] = payload.split(';')
    if (spec !== '?') return ''
    const index = Number.parseInt(indexText ?? '', 10)
    const hex = getTerminalIndexedColor(theme, index)
    const color = hex ? hexToRgb(hex) : null
    return color ? wrapOsc(`4;${index};${rgbToXtermQueryColor(color)}`) : ''
  }

  return ''
}

function buildWindowQueryReply(query: string, term: Terminal, element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  const width = Math.max(0, Math.round(rect.width))
  const height = Math.max(0, Math.round(rect.height))
  const cellWidth = term.cols > 0 ? Math.max(1, Math.round(rect.width / term.cols)) : 0
  const cellHeight = term.rows > 0 ? Math.max(1, Math.round(rect.height / term.rows)) : 0

  switch (query) {
    case '\x1b[14t':
      return `\x1b[4;${height};${width}t`
    case '\x1b[16t':
      return `\x1b[6;${cellHeight};${cellWidth}t`
    case '\x1b[18t':
      return `\x1b[8;${term.rows};${term.cols}t`
    case '\x1b[?2026$p':
      // Report synchronized output as reset rather than unsupported so
      // Zellij can continue without stalling on the query.
      return '\x1b[?2026;2$y'
    default:
      return ''
  }
}

function splitZellijHostQueries(
  chunk: string,
  term: Terminal,
  element: HTMLElement,
  themeName: string,
) {
  let display = ''
  let replies = ''
  let index = 0

  while (index < chunk.length) {
    if (chunk[index] !== '\x1b') {
      display += chunk[index]
      index += 1
      continue
    }

    if (chunk.startsWith('\x1b]', index)) {
      const belIndex = chunk.indexOf('\x07', index + 2)
      const stIndex = chunk.indexOf('\x1b\\', index + 2)
      const terminator =
        belIndex !== -1 && (stIndex === -1 || belIndex < stIndex)
          ? { endIndex: belIndex, terminatorLength: 1 }
          : stIndex !== -1
            ? { endIndex: stIndex, terminatorLength: 2 }
            : null
      if (!terminator) {
        break
      }

      const { endIndex, terminatorLength } = terminator
      const body = chunk.slice(index + 2, endIndex)
      const separator = body.indexOf(';')
      if (separator !== -1) {
        const command = body.slice(0, separator)
        const payload = body.slice(separator + 1)
        const reply = buildPaletteQueryReply(command, payload, themeName)
        if (reply) {
          replies += reply
          index = endIndex + terminatorLength
          continue
        }
      }

      display += chunk.slice(index, endIndex + terminatorLength)
      index = endIndex + terminatorLength
      continue
    }

    const knownWindowQueries = ['\x1b[14t', '\x1b[16t', '\x1b[18t', '\x1b[?2026$p']
    const matchedQuery = knownWindowQueries.find((query) => chunk.startsWith(query, index))
    if (matchedQuery) {
      replies += buildWindowQueryReply(matchedQuery, term, element)
      index += matchedQuery.length
      continue
    }

    const maybePartialWindowQuery = knownWindowQueries.find((query) =>
      query.startsWith(chunk.slice(index)),
    )
    if (maybePartialWindowQuery) break

    display += chunk[index]
    index += 1
  }

  return {
    display,
    replies,
    remainder: chunk.slice(index),
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

function refreshTerminalTheme(term: Terminal | null | undefined, themeName: string) {
  if (!term) return
  applyThemeToTerminal(term, buildTheme(themeName, getTerminalBackend(term)))
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

function shouldPreferSnapshotRestoreForTerminal(term: Terminal | null | undefined) {
  // Alternate-screen apps own the visible viewport and often redraw from a
  // blank frame. Replaying raw shell history into them causes more corruption
  // than value, so restore only the currently visible snapshot there.
  return term?.buffer.active.type === 'alternate'
}

function shouldAvoidSyntheticResizeForTerminal(term: Terminal | null | undefined) {
  return shouldPreferSnapshotRestoreForTerminal(term)
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
const terminalReloadSnapshots = new Map<string, string>()
const retainedAttachmentTimers = new Map<string, number>()
const retainedAttachmentOrder = new Map<string, number>()
const RETAINED_ATTACHMENT_TTL_MS = 3_000
const RETAINED_ATTACHMENT_MAX = 6

function clearRetainedAttachment(termId: string) {
  const timer = retainedAttachmentTimers.get(termId)
  if (timer != null) {
    window.clearTimeout(timer)
    retainedAttachmentTimers.delete(termId)
  }
  retainedAttachmentOrder.delete(termId)
}

function releaseRetainedAttachment(termId: string) {
  clearRetainedAttachment(termId)

  const cached = terminalCache.get(termId)
  if (!cached) return

  cached.setPollingEnabled(false)
  setTerminalRenderLoopEnabled(cached.term, false)

  if (Reflect.get(cached.term, '__cellsBackendAttached') === true) {
    Reflect.set(cached.term, '__cellsBackendAttached', false)
    void window.cells.terminal.unsubscribe(termId).catch(() => {})
  }
}

function trimRetainedAttachments() {
  while (retainedAttachmentOrder.size > RETAINED_ATTACHMENT_MAX) {
    let oldestTermId: string | null = null
    let oldestAt = Infinity

    for (const [termId, retainedAt] of retainedAttachmentOrder) {
      if (retainedAt < oldestAt) {
        oldestAt = retainedAt
        oldestTermId = termId
      }
    }

    if (!oldestTermId) return
    releaseRetainedAttachment(oldestTermId)
  }
}

function retainTerminalAttachment(termId: string) {
  const cached = terminalCache.get(termId)
  if (!cached || !usesServerOwnedTerminalState(cached.term)) {
    releaseRetainedAttachment(termId)
    return
  }

  clearRetainedAttachment(termId)
  retainedAttachmentOrder.set(termId, Date.now())
  retainedAttachmentTimers.set(
    termId,
    window.setTimeout(() => releaseRetainedAttachment(termId), RETAINED_ATTACHMENT_TTL_MS),
  )
  trimRetainedAttachments()
}

function getCachedTerminalCount() {
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

function getTerminalPreviewSnapshot(
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

function getTerminalRestoreSnapshot(termId: string): string | null {
  const cached = terminalCache.get(termId)
  const term = cached?.term
  if (!term) return null

  if (shouldPreferSnapshotRestoreForTerminal(term)) {
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
function applyThemeToAllTerminals(themeName: string) {
  for (const [, cached] of terminalCache) {
    applyThemeToTerminal(cached.term, buildTheme(themeName, getTerminalBackend(cached.term)))
  }
}

/** Call when a terminal is permanently removed (not just hidden). */
function destroyCachedTerminal(termId: string) {
  clearRetainedAttachment(termId)
  const cached = terminalCache.get(termId)
  if (cached) {
    for (const fn of cached.cleanups) fn()
    cached.term.dispose()
    cached.wrapper.remove()
    terminalCache.delete(termId)
  }
}

/** Repaint a terminal — recreates the renderer while keeping the shell alive. */
function reloadTerminal(termId: string) {
  const cached = terminalCache.get(termId)
  const usesServerOwnedState = cached?.term ? usesServerOwnedTerminalState(cached.term) : false
  const snapshot =
    cached?.term && !usesServerOwnedState && shouldPreferSnapshotRestoreForTerminal(cached.term)
      ? getTerminalRestoreSnapshot(termId)
      : null
  if (snapshot !== null) terminalReloadSnapshots.set(termId, snapshot)
  else terminalReloadSnapshots.delete(termId)

  void window.cells.terminal.unsubscribe(termId).finally(() => {
    if (cached && usesServerOwnedState) {
      clearRetainedAttachment(termId)
      cached.setPollingEnabled(false)
      setTerminalRenderLoopEnabled(cached.term, false)
      Reflect.set(cached.term, '__cellsBackendAttached', false)
      Reflect.set(cached.term, '__cellsPendingReattachReset', false)
    } else {
      destroyCachedTerminal(termId)
    }
    window.dispatchEvent(new CustomEvent('terminal-reload', { detail: { termId } }))
  })
}

function reloadAllTerminals() {
  for (const termId of [...terminalCache.keys()]) {
    reloadTerminal(termId)
  }
}

registerTerminalCacheApi({
  applyThemeToAllTerminals,
  destroyCachedTerminal,
  getCachedTerminalCount,
  getTerminalPreviewSnapshot,
  getTerminalRestoreSnapshot,
  reloadAllTerminals,
  reloadTerminal,
})

interface CellTerminalProps {
  termId: string
  width: number
  height: number
  isVisible: boolean
  isFocused: boolean
  projectId?: string | null
  projectPath?: string | null
  onTitleChange?: (title: string) => void
}

type AgentName = 'claude' | 'codex' | 'opencode' | 'pi'

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
  'pi',
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

const OPENCODE_SUBCOMMANDS = new Set([
  'acp',
  'agent',
  'attach',
  'auth',
  'export',
  'github',
  'help',
  'import',
  'mcp',
  'models',
  'run',
  'serve',
  'session',
  'stats',
  'uninstall',
  'upgrade',
  'web',
])

const PI_SUBCOMMANDS = new Set(['update'])

function getAgentLabel(agent: AgentName) {
  if (agent === 'claude') return 'Claude'
  if (agent === 'codex') return 'Codex'
  if (agent === 'pi') return 'Pi'
  return 'OpenCode'
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

function sanitizeBackendLeakedTitle(input: string) {
  const collapsed = input.replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''

  // Zellij can leak its hidden session name into pane titles, for example:
  //   czba1d9888fa56fe2207bc8ce | * Claude Code
  // Strip the private Cells session prefix and the transient zellij marker.
  const withoutCellsSessionPrefix = collapsed.replace(
    /^(?:cz[a-f0-9]{8,}|cells[-_][^\s|]+)\s*\|\s*(?:[*+-]\s*)?/i,
    '',
  )

  return withoutCellsSessionPrefix.trim()
}

function formatAgentWindowTitle(agent: AgentName, title: string, maxLength = 60) {
  const summary = summarizeTitle(sanitizeBackendLeakedTitle(title), maxLength)
  return summary || getAgentLabel(agent)
}

function normalizeAgentProcess(proc: string | null): AgentName | null {
  if (!proc) return null
  const normalized = proc.toLowerCase().split('/').pop() ?? proc.toLowerCase()
  if (normalized === 'claude' || normalized.startsWith('claude-')) return 'claude'
  if (normalized === 'codex' || normalized === 'codex-cli' || normalized.startsWith('codex-')) {
    return 'codex'
  }
  if (normalized === 'opencode' || normalized.startsWith('opencode-')) return 'opencode'
  if (normalized === 'pi' || normalized.startsWith('pi-')) return 'pi'
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
  const names = new Set(['claude', 'codex', 'opencode', 'pi'])
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
  const knownSubcommands =
    agent === 'claude'
      ? CLAUDE_SUBCOMMANDS
      : agent === 'opencode'
        ? OPENCODE_SUBCOMMANDS
        : agent === 'pi'
          ? PI_SUBCOMMANDS
          : CODEX_SUBCOMMANDS
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

function consumeTerminalReloadSnapshot(termId: string) {
  const snapshot = terminalReloadSnapshots.get(termId)
  terminalReloadSnapshots.delete(termId)
  return snapshot
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

function reportTerminalSizeIfChanged(termId: string, fitAddon: FitAddon | null) {
  if (!fitAddon) return
  const dims = fitAddon.proposeDimensions()
  if (!dims) return
  window.cells.terminal.resize(termId, dims.cols, dims.rows)
}

function forceTerminalRepaint(term: Terminal) {
  requestAnimationFrame(() => forceTerminalFullRender(term))
  window.setTimeout(() => requestAnimationFrame(() => forceTerminalFullRender(term)), 32)
}

function shouldRetryTerminalAttach(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /timed out|not connected|connection (?:lost|closed)|econn|epipe|pty daemon/i.test(message)
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

async function attachTerminalWithRetry(
  termId: string,
  cols: number,
  rows: number,
  cwd: string | undefined,
  projectId: string | null | undefined,
  shouldContinue: () => boolean,
): Promise<TerminalAttachResponse> {
  let lastError: unknown = null

  for (let attempt = 0; attempt < TERMINAL_ATTACH_RETRY_DELAYS_MS.length; attempt += 1) {
    const delay = TERMINAL_ATTACH_RETRY_DELAYS_MS[attempt]
    if (delay > 0) {
      await sleep(delay)
      if (!shouldContinue()) {
        throw lastError instanceof Error ? lastError : new Error('Terminal attach cancelled')
      }
    }

    try {
      return await window.cells.terminal.attach(termId, cols, rows, cwd, projectId)
    } catch (error) {
      lastError = error
      const lastAttempt = attempt === TERMINAL_ATTACH_RETRY_DELAYS_MS.length - 1
      if (lastAttempt || !shouldRetryTerminalAttach(error) || !shouldContinue()) {
        throw error
      }

      console.warn(
        `Terminal attach failed for ${termId}; retrying (${attempt + 1}/${TERMINAL_ATTACH_RETRY_DELAYS_MS.length})`,
        error,
      )
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Terminal attach failed')
}

export function CellTerminal({
  termId,
  width,
  height,
  isVisible,
  isFocused,
  projectId,
  projectPath,
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
  const terminalAgent = useStore(
    (s) => s.terminals.find((terminal) => terminal.id === termId)?.agent ?? null,
  )
  const terminalRuntimeStatus = useStore(
    (s) => s.terminals.find((terminal) => terminal.id === termId)?.runtimeStatus ?? null,
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
  const backendAgentSyncRef = useRef<AgentName | null>(null)
  const inputBufferRef = useRef('')
  const backendQueryRemainderRef = useRef('')
  const lastInferredTitleRef = useRef<string | null>(null)
  const lastCodexTitleDataRef = useRef<number>(-1)
  const lastCodexTitleRef = useRef<string | null>(null)
  const processTitleRef = useRef(false) // whether the agent process has set its own title
  const dragDepthRef = useRef(0)
  const shouldRenderRef = useRef(isFocused || isVisible)
  const focusStateRef = useRef({ isFocused, isVisible })
  const suppressAutoFocusRef = useRef(false)
  const projectIdRef = useRef<string | null | undefined>(projectId)
  const projectPathRef = useRef<string | null | undefined>(projectPath)
  const queuedMouseSequencesRef = useRef<string[]>([])
  const queuedMouseTimerRef = useRef<number | null>(null)
  const serverOwnedMouseModeRef = useRef(false)
  const lastReportedSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const wheelDeltaCarryRef = useRef(0)
  const searchMatchesRef = useRef<SearchMatch[]>([])
  const searchDebounceRef = useRef<number | null>(null)
  const searchLimitHitRef = useRef(false)
  const [dropActive, setDropActive] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [, setScrollStatus] = useState<{
    paneInMode: boolean
    scrollPosition: number
    historySize: number
  } | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent).detail?.termId === termId) {
        setReloadKey((k) => k + 1)
      }
    }
    window.addEventListener('terminal-reload', handler)
    return () => window.removeEventListener('terminal-reload', handler)
  }, [termId])

  const refitTerminalToLoadedFont = useCallback(
    (term: Terminal | null, fitAddon: FitAddon | null) => {
      if (!term || !fitAddon) return
      requestAnimationFrame(() => {
        const renderer = Reflect.get(term, 'renderer') as
          | {
              remeasureFont?: () => void
              setFontSize?: (size: number) => void
              setFontFamily?: (family: string) => void
            }
          | undefined
        renderer?.remeasureFont?.()
        fitAddon.fit()
        forceTerminalRepaint(term)
      })
    },
    [],
  )

  const getPrimaryTerminalFont = useCallback(() => {
    return (fontFamilyRef.current ?? '')
      .split(',')[0]
      .trim()
      .replace(/^["']|["']$/g, '')
  }, [])

  const ensurePrimaryTerminalFontLoaded = useCallback(async () => {
    const fontSet = document.fonts
    const primaryFont = getPrimaryTerminalFont()
    if (!fontSet || !primaryFont) return

    const descriptor = `16px "${primaryFont}"`
    if (fontSet.check(descriptor)) return

    const waitForFont = () =>
      new Promise<void>((resolve) => {
        const finish = () => {
          cleanup()
          resolve()
        }
        const onLoadingDone = () => {
          if (fontSet.check(descriptor)) finish()
        }
        const timer = window.setTimeout(finish, 1200)
        const cleanup = () => {
          window.clearTimeout(timer)
          fontSet.removeEventListener('loadingdone', onLoadingDone)
        }
        fontSet.addEventListener('loadingdone', onLoadingDone)
      })

    try {
      await Promise.race([fontSet.load(descriptor).then(() => undefined), waitForFont()])
    } catch {
      // Best-effort only. The post-open watcher still handles late font loads.
    }
  }, [getPrimaryTerminalFont])

  const getLiveTerminal = useCallback(
    () => terminalCache.get(termId)?.term ?? terminalRef.current,
    [termId],
  )

  const getAttachProjectId = useCallback(
    () => projectIdRef.current ?? useStore.getState().activeProjectId,
    [],
  )

  const getAttachProjectPath = useCallback(
    () => projectPathRef.current ?? useStore.getState().getActiveProjectPath(),
    [],
  )

  useEffect(() => {
    focusStateRef.current = { isFocused, isVisible }
  }, [isFocused, isVisible])

  useEffect(() => {
    projectIdRef.current = projectId
    projectPathRef.current = projectPath
  }, [projectId, projectPath])

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

  useEffect(() => {
    detectedAgentRef.current = terminalAgent
    if (terminalAgent) {
      inferredAgentRef.current = terminalAgent
      return
    }
    if (terminalRuntimeStatus?.kind !== 'agent') {
      detectedAgentRef.current = null
    }
  }, [terminalAgent, terminalRuntimeStatus])

  useEffect(() => {
    if (!terminalAgent) {
      backendAgentSyncRef.current = null
      return
    }
    if (backendAgentSyncRef.current === terminalAgent) return
    backendAgentSyncRef.current = terminalAgent
    void window.cells.terminal
      .registerLaunch(termId, {
        agent: terminalAgent,
        cwd: getAttachProjectPath(),
      })
      .catch(() => {})
  }, [getAttachProjectPath, termId, terminalAgent])

  const syncTerminalState = useCallback(
    (term: Terminal | null = getLiveTerminal()) => {
      if (!term) return

      const { isFocused: focused, isVisible: visible } = focusStateRef.current
      const shouldRender = focused || visible
      shouldRenderRef.current = shouldRender
      setTerminalRenderLoopEnabled(term, shouldRender)

      requestAnimationFrame(() => {
        if (focused && !suppressAutoFocusRef.current) {
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

  const shouldRouteServerOwnedMouseInput = useCallback((term: Terminal | null | undefined) => {
    if (!term || !usesServerOwnedTerminalState(term)) return false
    if (serverOwnedMouseModeRef.current) return true

    const wasmTerm = Reflect.get(term, 'wasmTerm') as
      | {
          hasMouseTracking?: () => boolean
          isAlternateScreen?: () => boolean
        }
      | undefined

    try {
      if (wasmTerm?.hasMouseTracking?.() === true) return true
      if (wasmTerm?.isAlternateScreen?.() === true) return true
    } catch {}

    return term.buffer.active.type === 'alternate'
  }, [])

  const queueServerOwnedWheelPayload = useCallback(
    (event: WheelEvent, payload: QueuedWheelPayload) => {
      Reflect.set(event, SERVER_OWNED_WHEEL_HANDLED_KEY, true)
      const term = getLiveTerminal()
      const directionSign = payload.direction === 'up' ? -1 : 1
      const combinedDelta =
        Math.sign(wheelDeltaCarryRef.current) === directionSign || wheelDeltaCarryRef.current === 0
          ? wheelDeltaCarryRef.current + directionSign * payload.delta
          : directionSign * payload.delta
      // Fullscreen TUIs often emit many small trackpad wheel deltas. Keep the
      // threshold low enough that those deltas become prompt scroll steps
      // instead of feeling dropped until several gestures accumulate.
      const threshold = 0.12
      const steps = Math.max(0, Math.min(8, Math.floor(Math.abs(combinedDelta) / threshold)))
      wheelDeltaCarryRef.current =
        steps > 0 ? directionSign * (Math.abs(combinedDelta) - steps * threshold) : combinedDelta
      if (steps <= 0) return

      const buttonBase = payload.direction === 'up' ? 64 : 65
      const button = buttonBase + payload.modifier
      const sequence = Array.from(
        { length: steps },
        () => `\x1b[<${button};${payload.x};${payload.y}M`,
      ).join('')
      if (term && isServerOwnedTerminalBackend(getTerminalBackend(term))) {
        focusGhosttyInput(term)
        window.cells.terminal.write(termId, sequence)
        return
      }
      void window.cells.terminal.handleWheel(termId, payload.direction, steps, sequence)
    },
    [focusGhosttyInput, getLiveTerminal, termId],
  )

  const flushQueuedMouseSequences = useCallback(() => {
    queuedMouseTimerRef.current = null
    const sequences = queuedMouseSequencesRef.current
    queuedMouseSequencesRef.current = []
    if (sequences.length === 0) return
    window.cells.terminal.write(termId, sequences.join(''))
  }, [termId])

  const queueServerOwnedMouseSequence = useCallback(
    (event: MouseEvent, term: Terminal, sequence: string) => {
      Reflect.set(event, SERVER_OWNED_MOUSE_HANDLED_KEY, true)
      if (getTerminalBackend(term) === 'zellij') {
        window.cells.terminal.write(termId, sequence)
        return
      }
      queuedMouseSequencesRef.current.push(sequence)
      if (queuedMouseTimerRef.current === null) {
        queuedMouseTimerRef.current = window.setTimeout(
          flushQueuedMouseSequences,
          SERVER_OWNED_MOUSE_FLUSH_MS,
        )
      }
    },
    [flushQueuedMouseSequences],
  )

  const scheduleServerOwnedAttachRecovery = useCallback(
    (term: Terminal, cols: number, rows: number, cwd: string | undefined, attempt = 0) => {
      const delay = SERVER_OWNED_ATTACH_RECOVERY_DELAYS_MS[attempt]
      if (delay == null) return

      window.setTimeout(() => {
        if (Reflect.get(term, '__cellsPendingReattachReset') !== true) return

        void (async () => {
          try {
            console.warn(
              `Terminal ${termId} did not receive an initial ${getTerminalBackend(term) ?? 'server-owned'} redraw; retrying attach`,
            )
            const result = await attachTerminalWithRetry(
              termId,
              cols,
              rows,
              cwd,
              getAttachProjectId(),
              () => {
                return terminalRef.current === term
              },
            )

            if (terminalRef.current !== term) return

            Reflect.set(term, '__cellsBackendAttached', true)
            Reflect.set(term, '__cellsTerminalBackend', result.backend ?? null)
            const usesServerOwnedState = isServerOwnedTerminalBackend(result.backend)
            Reflect.set(term, '__cellsUsesServerOwnedState', usesServerOwnedState)
            refreshTerminalTheme(term, themeNameRef.current)

            if (usesServerOwnedState) {
              Reflect.set(term, '__cellsPendingReattachReset', true)
              // eslint-disable-next-line react-hooks/immutability -- recursive setTimeout; safe at runtime
              scheduleServerOwnedAttachRecovery(term, cols, rows, cwd, attempt + 1)
              return
            }

            Reflect.set(term, '__cellsPendingReattachReset', false)
            if (result.buffer) {
              term.write(result.buffer)
            }
            forceTerminalRepaint(term)
          } catch (error) {
            console.warn(`Terminal ${termId} attach recovery failed`, error)
            if (terminalRef.current === term) {
              // eslint-disable-next-line react-hooks/immutability -- recursive setTimeout; safe at runtime
              scheduleServerOwnedAttachRecovery(term, cols, rows, cwd, attempt + 1)
            }
          }
        })()
      }, delay)
    },
    [getAttachProjectId, termId],
  )
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
    const sanitized = sanitizeBackendLeakedTitle(title)
    if (!sanitized || sanitized === lastInferredTitleRef.current) return
    lastInferredTitleRef.current = sanitized
    onTitleChangeRef.current?.(sanitized)
  }, [])

  useEffect(() => {
    const agent =
      terminalRuntimeStatus?.kind === 'agent' ? (terminalRuntimeStatus.agent ?? null) : null
    if (agent !== 'codex') {
      lastCodexTitleDataRef.current = -1
      lastCodexTitleRef.current = null
      return
    }

    const statusVersion = terminalRuntimeStatus?.updatedAt ?? 0
    if (statusVersion === lastCodexTitleDataRef.current) return
    lastCodexTitleDataRef.current = statusVersion

    void window.cells.terminal
      .getCodexTitle(termId)
      .then((codexTitle) => {
        if (!codexTitle) return
        lastCodexTitleRef.current = codexTitle
        setInferredTitle(formatAgentWindowTitle('codex', codexTitle))
      })
      .catch(() => {})
  }, [setInferredTitle, termId, terminalRuntimeStatus])

  const handleSubmittedInput = useCallback(
    (line: string) => {
      const launch = inferAgentLaunch(line)
      if (launch) {
        inferredAgentRef.current = launch.agent
        backendAgentSyncRef.current = launch.agent
        processTitleRef.current = false
        void window.cells.terminal
          .registerLaunch(termId, {
            agent: launch.agent,
            command: line.trim(),
            cwd: getAttachProjectPath(),
            startedAt: Date.now(),
          })
          .catch(() => {})
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
        detectedAgentRef.current = null
        backendAgentSyncRef.current = null
        processTitleRef.current = false
        void window.cells.terminal
          .registerLaunch(termId, {
            agent: null,
            command: null,
            cwd: getAttachProjectPath(),
            startedAt: null,
          })
          .catch(() => {})
        return
      }

      const activeAgent = detectedAgentRef.current ?? inferredAgentRef.current
      if (!activeAgent) return
      backendAgentSyncRef.current = activeAgent
      void window.cells.terminal
        .registerLaunch(termId, {
          agent: activeAgent,
          cwd: getAttachProjectPath(),
          startedAt: Date.now(),
        })
        .catch(() => {})

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
        clearRetainedAttachment(termId)
        const avoidSyntheticResize = shouldAvoidSyntheticResizeForTerminal(cached.term)
        const backendAttached = Reflect.get(cached.term, '__cellsBackendAttached') === true
        patchTerminalViewportPreservation(cached.term)
        await ensurePrimaryTerminalFontLoaded()
        // Move the existing DOM back into our container
        cached.wrapper.style.backgroundColor = buildTheme(themeNameRef.current).background
        container.appendChild(cached.wrapper)
        // Immediate synchronous render so the user never sees a blank canvas.
        // The browser discards the canvas backing store while the wrapper is
        // detached; painting before the next frame prevents the colorless flash.
        forceTerminalFullRender(cached.term)
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
        void document.fonts?.ready.then(() => {
          if (cancelled) return
          refitTerminalToLoadedFont(cached.term, cached.fitAddon)
        })

        // Same late-font-load watcher as the fresh-terminal path (see
        // comment there). Cached terminals can also hit the race where the
        // atlas was populated with fallback glyphs before the @font-face
        // font finished loading.
        const cachedPrimaryFont = getPrimaryTerminalFont()
        if (cachedPrimaryFont && !document.fonts.check(`16px "${cachedPrimaryFont}"`)) {
          const onCachedFontDone = () => {
            if (cancelled) return
            if (document.fonts.check(`16px "${cachedPrimaryFont}"`)) {
              document.fonts.removeEventListener('loadingdone', onCachedFontDone)
              refitTerminalToLoadedFont(cached.term, cached.fitAddon)
            }
          }
          document.fonts.addEventListener('loadingdone', onCachedFontDone)
        }

        const dims = cached.fitAddon.proposeDimensions()
        let result: Awaited<ReturnType<typeof window.cells.terminal.attach>> | null = null
        if (!backendAttached) {
          try {
            result = await attachTerminalWithRetry(
              termId,
              dims?.cols ?? 80,
              dims?.rows ?? 24,
              getAttachProjectPath(),
              getAttachProjectId(),
              () => !cancelled,
            )
          } catch (error) {
            finishTerminalReplay(cached.term)
            throw error
          }

          Reflect.set(cached.term, '__cellsBackendAttached', true)
          Reflect.set(cached.term, '__cellsTerminalBackend', result?.backend ?? null)
          const usesServerOwnedState = isServerOwnedTerminalBackend(result?.backend)
          Reflect.set(cached.term, '__cellsUsesServerOwnedState', usesServerOwnedState)
          refreshTerminalTheme(cached.term, themeNameRef.current)
          if (usesServerOwnedState) {
            // Defer the reset() until the first data chunk from the backend
            // arrives. If we reset() now, the buffer goes blank and the render
            // loop paints an empty grid (cursor at 0,0, no colors) until
            // tmux/zellij redraws ~50-200ms later. By deferring, the old
            // cached content stays visible and the reset+redraw happen in the
            // same synchronous block — no blank frame.
            Reflect.set(cached.term, '__cellsPendingReattachReset', true)
            scheduleServerOwnedAttachRecovery(
              cached.term,
              dims?.cols ?? 80,
              dims?.rows ?? 24,
              getAttachProjectPath(),
            )
          }

          // Replay any data buffered while this terminal was in another project.
          // tmux/Zellij redraw themselves through the attached client PTY instead
          // of sending a detached replay buffer.
          if (!usesServerOwnedState && result?.buffer) {
            cached.term.write(result.buffer)
          }
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

        const usesServerOwnedState = usesServerOwnedTerminalState(cached.term)
        if (result?.reattached && dims && !avoidSyntheticResize && !usesServerOwnedState) {
          bumpPtySize(dims.cols, dims.rows)
        }

        reportTerminalSizeIfChanged(termId, cached.fitAddon)

        syncTerminalState(cached.term)
        return
      }

      // First time — create new terminal
      await ensureInit()
      if (cancelled) return
      await ensurePrimaryTerminalFontLoaded()
      if (cancelled) return

      const wrapper = document.createElement('div')
      wrapper.className = 'cell-terminal-surface'
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
        // Use WebGL renderer instead of Canvas2D (see patches/README.md for
        // how rendererFactory is injected into ghostty-web).
        rendererFactory: (canvas, opts) => new WebGLTerminalRenderer(canvas, opts) as any,
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
        const usesServerOwnedState = usesServerOwnedTerminalState(term)

        if (
          usesServerOwnedState &&
          term.viewportY > 0 &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          [
            'ArrowUp',
            'ArrowDown',
            'ArrowLeft',
            'ArrowRight',
            'PageUp',
            'PageDown',
            'Home',
            'End',
          ].includes(e.key)
        ) {
          term.scrollToBottom()
          ;(term as any).targetViewportY = 0
        }

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

      term.attachCustomWheelEventHandler((e: WheelEvent) => {
        if (!shouldRouteServerOwnedMouseInput(term)) return false
        if (e.metaKey || e.ctrlKey) return false
        if (Reflect.get(e, SERVER_OWNED_WHEEL_HANDLED_KEY) === true) return true

        const payload = getMouseWheelSequencePayload(e, term, wrapper)
        if (payload) {
          queueServerOwnedWheelPayload(e, payload)
        }
        return true
      })

      // Fit in next frame so the container has layout, then attach with accurate dims
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          if (!cancelled) fitAddon.fit()
          resolve()
        })
      })
      void document.fonts?.ready.then(() => {
        if (cancelled) return
        refitTerminalToLoadedFont(term, fitAddon)
      })

      // @font-face fonts may still be loading after document.fonts.ready
      // resolves (it only waits for currently-loading fonts, not unloaded
      // ones). When the terminal font finishes loading later — after the
      // glyph atlas has already cached fallback glyphs — rebuild the atlas
      // so Nerd Font icons render correctly instead of showing tofu.
      let fontLoaded = false
      const primaryFont = getPrimaryTerminalFont()
      const onFontLoadingDone = () => {
        if (cancelled || fontLoaded) return
        if (primaryFont && document.fonts.check(`16px "${primaryFont}"`)) {
          fontLoaded = true
          document.fonts.removeEventListener('loadingdone', onFontLoadingDone)
          refitTerminalToLoadedFont(term, fitAddon)
        }
      }
      if (primaryFont && !document.fonts.check(`16px "${primaryFont}"`)) {
        document.fonts.addEventListener('loadingdone', onFontLoadingDone)
      } else {
        fontLoaded = true
      }

      if (cancelled) {
        document.fonts.removeEventListener('loadingdone', onFontLoadingDone)
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
        const scrolledUp =
          !usesServerOwnedTerminalState(term) && term.viewportY > SCROLL_LOCK_THRESHOLD
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
        } else if (usesServerOwnedTerminalState(term)) {
          term.scrollToBottom()
          ;(term as any).targetViewportY = 0
        } else if (termCanvas) {
          // At the bottom — clear any sub-pixel scroll transform
          termCanvas.style.transform = ''
        }

        // Let ghostty-web's own 60 fps render loop pick up dirty rows.
        // No extra render call here — a second render per frame halves the
        // frame budget and makes heavyweight TUIs (Codex) visibly laggy.

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
          const sanitizedTitle = sanitizeBackendLeakedTitle(title || 'Terminal') || 'Terminal'
          lastInferredTitleRef.current = sanitizedTitle
          onTitleChangeRef.current?.(sanitizedTitle)
          // If an agent is active and the process sets its own title,
          // remember that so we don't overwrite it with inferred titles.
          const agent = detectedAgentRef.current ?? inferredAgentRef.current
          if (agent) processTitleRef.current = true
        }).dispose,
        term.onData((data) => {
          trackInputForTitle(data)
          window.cells.terminal.write(termId, data)
        }).dispose,
        term.onResize(({ cols, rows }) => {
          lastReportedSizeRef.current = { cols, rows }
          window.cells.terminal.resize(termId, cols, rows)
        }).dispose,
        window.cells.terminal.onData((id, data) => {
          if (id === termId) {
            let nextChunk = data
            if (getTerminalBackend(term) === 'zellij') {
              const parsed = splitZellijHostQueries(
                backendQueryRemainderRef.current + data,
                term,
                wrapper,
                themeNameRef.current,
              )
              backendQueryRemainderRef.current = parsed.remainder
              if (parsed.replies) {
                window.cells.terminal.write(termId, parsed.replies)
              }
              nextChunk = parsed.display
              if (!nextChunk) return
            } else if (backendQueryRemainderRef.current) {
              nextChunk = backendQueryRemainderRef.current + data
              backendQueryRemainderRef.current = ''
            }

            if (isTerminalReplayPending(term)) {
              queueTerminalReplayData(term, nextChunk)
              return
            }

            // After a server-owned reattach, reset() was deferred so the
            // old cached content stays visible instead of flashing a blank
            // grid. Now that the backend is sending real redraw data, do the
            // reset + mouse-mode setup and write the first chunk in one go
            // so the render loop never sees an empty buffer.
            if (Reflect.get(term, '__cellsPendingReattachReset') === true) {
              Reflect.set(term, '__cellsPendingReattachReset', false)
              term.reset()
              term.scrollToBottom()
              // Enable SGR mouse reporting — the multiplexer already set up
              // mouse mode server-side but ghostty-web missed those escapes.
              term.write('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h')
            }

            // Accumulate data and schedule a single flush per frame
            writeBuf += nextChunk
            if (!writeRaf) writeRaf = requestAnimationFrame(flushWrites)
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

      const setPollingEnabled = (_enabled: boolean) => {}
      cleanups.push(() => setPollingEnabled(false))

      // Store in cache
      terminalCache.set(termId, { term, fitAddon, wrapper, cleanups, setPollingEnabled })
      setPollingEnabled(true)

      const dims = fitAddon.proposeDimensions()
      const worktreeCwd = consumePendingWorktreePath(termId)
      const projectPath = worktreeCwd ?? getAttachProjectPath()
      const reloadSnapshot = consumeTerminalReloadSnapshot(termId)
      const avoidSyntheticResize = shouldAvoidSyntheticResizeForTerminal(term)
      const terminalState = useStore.getState().terminals.find((terminal) => terminal.id === termId)
      const restoredOutput = terminalState?.restoredOutput ?? ''
      const shouldRestorePersistedOutput = Boolean(
        terminalState?.exited && restoredOutput.length > 0,
      )
      const preferSnapshotRestore =
        shouldRestorePersistedOutput && shouldPreferSnapshotRestoreForTerminal(term)
      let result: Awaited<ReturnType<typeof window.cells.terminal.attach>>
      try {
        result = await attachTerminalWithRetry(
          termId,
          dims?.cols ?? 80,
          dims?.rows ?? 24,
          projectPath,
          getAttachProjectId(),
          () => !cancelled,
        )
      } catch (error) {
        finishTerminalReplay(term)
        throw error
      }

      const usesServerOwnedState = isServerOwnedTerminalBackend(result?.backend)
      Reflect.set(term, '__cellsBackendAttached', true)
      Reflect.set(term, '__cellsTerminalBackend', result?.backend ?? null)
      Reflect.set(term, '__cellsUsesServerOwnedState', usesServerOwnedState)
      backendQueryRemainderRef.current = ''
      refreshTerminalTheme(term, themeNameRef.current)
      if (usesServerOwnedState) {
        if (result?.reattached && shouldRestorePersistedOutput && restoredOutput) {
          term.write(restoredOutput)
        }

        // Suppress rendering while the buffer is in the blank reset() state.
        // Defer reset() until the first data chunk arrives from the
        // backend so the render loop never paints a blank buffer.
        Reflect.set(term, '__cellsPendingReattachReset', true)
        scheduleServerOwnedAttachRecovery(term, dims?.cols ?? 80, dims?.rows ?? 24, projectPath)
        reportTerminalSizeIfChanged(termId, fitAddon)
      }

      let replayedRawHistory = false
      if (reloadSnapshot !== undefined && result?.reattached && !usesServerOwnedState) {
        if (reloadSnapshot) {
          term.write(reloadSnapshot)
        }
      } else if (result?.reattached && !preferSnapshotRestore && !usesServerOwnedState) {
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

      // Persisted renderer snapshots are only safe to show for exited sessions.
      // If a live session was not actually reattached, painting stale text above
      // a fresh shell prompt looks like duplicated output rather than continuity.
      if (
        !usesServerOwnedState &&
        !replayedRawHistory &&
        shouldRestorePersistedOutput &&
        (!result?.reattached || preferSnapshotRestore)
      ) {
        term.write(restoredOutput)
        if (!preferSnapshotRestore && !restoredOutput.endsWith('\r\n')) {
          term.write('\r\n')
        }
      }

      if (!usesServerOwnedState && !replayedRawHistory && result?.buffer) {
        term.write(result.buffer)
      }

      const replayChunk = finishTerminalReplay(term)
      if (replayChunk) {
        writeBuf += replayChunk
        if (!writeRaf) writeRaf = requestAnimationFrame(flushWrites)
      }

      scheduleTerminalSearchRefresh(0)

      if (result?.reattached && dims && !avoidSyntheticResize && !usesServerOwnedState) {
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
      const cached = terminalCache.get(termId)
      if (cached) {
        setTerminalRenderLoopEnabled(cached.term, false)
        if (Reflect.get(cached.term, '__cellsBackendAttached') === true) {
          retainTerminalAttachment(termId)
        } else {
          cached.setPollingEnabled(false)
        }
      }
      if (cached && container?.contains(cached.wrapper)) {
        container.removeChild(cached.wrapper)
      }
      terminalRef.current = null
      fitAddonRef.current = null
      inputBufferRef.current = ''
      backendQueryRemainderRef.current = ''
    }
  }, [
    copySelectionToClipboard,
    ensurePrimaryTerminalFontLoaded,
    getPrimaryTerminalFont,
    pasteToTerminal,
    queueServerOwnedWheelPayload,
    reloadKey,
    refitTerminalToLoadedFont,
    scheduleServerOwnedAttachRecovery,
    scheduleTerminalSearchRefresh,
    setInferredTitle,
    getAttachProjectId,
    getAttachProjectPath,
    shouldRouteServerOwnedMouseInput,
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

    refreshTerminalTheme(term, themeName)
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
      cached.wrapper.style.backgroundColor = buildTheme(themeName).background
    }

    const fontChanged = term.options.fontSize !== fontSize || term.options.fontFamily !== fontFamily

    if (fontChanged) {
      term.options.fontSize = fontSize
      term.options.fontFamily = fontFamily

      requestAnimationFrame(() => {
        const renderer = Reflect.get(term, 'renderer') as { remeasureFont?: () => void } | undefined
        renderer?.remeasureFont?.()
        fitAddonRef.current?.fit()
        forceTerminalRepaint(term)
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

  useEffect(() => {
    const handleStart = () => {
      suppressAutoFocusRef.current = true
      if (isFocused) getLiveTerminal()?.blur()
    }

    const handleEnd = () => {
      suppressAutoFocusRef.current = false
      const term = getLiveTerminal()
      if (isFocused && term) {
        focusGhosttyInput(term)
        forceTerminalRepaint(term)
      }
    }

    window.addEventListener('terminal-navigation-start', handleStart)
    window.addEventListener('terminal-navigation-end', handleEnd)
    return () => {
      window.removeEventListener('terminal-navigation-start', handleStart)
      window.removeEventListener('terminal-navigation-end', handleEnd)
    }
  }, [getLiveTerminal, isFocused])

  // Re-focus the terminal when overlays (command palette, etc.) close
  useEffect(() => {
    const handler = () => {
      const term = getLiveTerminal()
      if (isFocused && term && !suppressAutoFocusRef.current) {
        focusGhosttyInput(term)
        forceTerminalRepaint(term)
      }
    }
    window.addEventListener('terminal-refocus', handler)
    return () => window.removeEventListener('terminal-refocus', handler)
  }, [getLiveTerminal, isFocused])

  // Intercept server-owned backend wheel events before ghostty-web sees them.
  // Its alternate-screen wheel fallback synthesizes arrow keys, which breaks
  // TUIs under tmux/Zellij. For regular terminals we still let ghostty-web own
  // scrolling, and Cmd/Ctrl+wheel continues to drive canvas zoom.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const onWheel = (e: WheelEvent) => {
      const term = terminalRef.current
      if (term && shouldRouteServerOwnedMouseInput(term) && !e.metaKey && !e.ctrlKey) {
        if (Reflect.get(e, SERVER_OWNED_WHEEL_HANDLED_KEY) === true) return
        const payload = getMouseWheelSequencePayload(e, term, container)
        if (payload) {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          queueServerOwnedWheelPayload(e, payload)
          return
        }
      }

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

    const shouldHandleServerOwnedMouse = (e: MouseEvent) => {
      const term = terminalRef.current
      if (!term || !shouldRouteServerOwnedMouseInput(term)) return null
      if (!isServerOwnedTerminalBackend(getTerminalBackend(term))) return null
      if (Reflect.get(e, SERVER_OWNED_MOUSE_HANDLED_KEY) === true) return null
      return term
    }

    const onMouseDown = (e: MouseEvent) => {
      const term = shouldHandleServerOwnedMouse(e)
      if (!term) return
      const sequence = getMouseSequencePayload(e, term, container, 'press')
      if (!sequence) return
      if (queuedMouseTimerRef.current !== null) {
        window.clearTimeout(queuedMouseTimerRef.current)
        queuedMouseTimerRef.current = null
        queuedMouseSequencesRef.current = []
      }
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      focusGhosttyInput(term)
      Reflect.set(e, SERVER_OWNED_MOUSE_HANDLED_KEY, true)
      window.cells.terminal.write(termId, sequence)
    }

    const onMouseUp = (e: MouseEvent) => {
      const term = shouldHandleServerOwnedMouse(e)
      if (!term) return
      const sequence = getMouseSequencePayload(e, term, container, 'release')
      if (!sequence) return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      Reflect.set(e, SERVER_OWNED_MOUSE_HANDLED_KEY, true)
      window.cells.terminal.write(termId, sequence)
    }

    const onMouseMove = (e: MouseEvent) => {
      const term = shouldHandleServerOwnedMouse(e)
      if (!term) return
      const sequence = getMouseSequencePayload(e, term, container, 'move')
      if (!sequence) return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (e.buttons !== 0) {
        Reflect.set(e, SERVER_OWNED_MOUSE_HANDLED_KEY, true)
        window.cells.terminal.write(termId, sequence)
      } else {
        queueServerOwnedMouseSequence(e, term, sequence)
      }
    }

    const onContextMenu = (e: MouseEvent) => {
      if (!shouldHandleServerOwnedMouse(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
    }

    container.addEventListener('wheel', onWheel, { capture: true, passive: false })
    container.addEventListener('mousedown', onMouseDown, { capture: true })
    container.addEventListener('mouseup', onMouseUp, { capture: true })
    container.addEventListener('mousemove', onMouseMove, { capture: true })
    container.addEventListener('contextmenu', onContextMenu, { capture: true })
    return () => {
      container.removeEventListener('wheel', onWheel, { capture: true })
      container.removeEventListener('mousedown', onMouseDown, { capture: true })
      container.removeEventListener('mouseup', onMouseUp, { capture: true })
      container.removeEventListener('mousemove', onMouseMove, { capture: true })
      container.removeEventListener('contextmenu', onContextMenu, { capture: true })
    }
  }, [
    flushQueuedMouseSequences,
    queueServerOwnedMouseSequence,
    queueServerOwnedWheelPayload,
    shouldRouteServerOwnedMouseInput,
    termId,
  ])

  useEffect(() => {
    return () => {
      wheelDeltaCarryRef.current = 0
      if (queuedMouseTimerRef.current !== null) {
        window.clearTimeout(queuedMouseTimerRef.current)
      }
      queuedMouseTimerRef.current = null
      queuedMouseSequencesRef.current = []
    }
  }, [])

  // Handle resize
  useEffect(() => {
    if (!fitAddonRef.current || !terminalRef.current) return
    const frame = requestAnimationFrame(() => {
      const fitAddon = fitAddonRef.current
      const term = terminalRef.current
      if (!fitAddon || !term) return
      fitAddon.fit()
      refitTerminalToLoadedFont(term, fitAddon)
      const dims = fitAddon.proposeDimensions()
      if (!dims) return
      const last = lastReportedSizeRef.current
      if (!last || last.cols !== dims.cols || last.rows !== dims.rows) {
        lastReportedSizeRef.current = { cols: dims.cols, rows: dims.rows }
        window.cells.terminal.resize(termId, dims.cols, dims.rows)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [height, refitTerminalToLoadedFont, termId, width])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let frame = 0
    const scheduleFit = () => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const fitAddon = fitAddonRef.current
        const term = terminalRef.current
        if (!fitAddon || !term) return
        fitAddon.fit()
        refitTerminalToLoadedFont(term, fitAddon)
        const dims = fitAddon.proposeDimensions()
        if (!dims) return
        const last = lastReportedSizeRef.current
        if (!last || last.cols !== dims.cols || last.rows !== dims.rows) {
          lastReportedSizeRef.current = { cols: dims.cols, rows: dims.rows }
          window.cells.terminal.resize(termId, dims.cols, dims.rows)
        }
      })
    }

    const observer = new ResizeObserver(() => scheduleFit())
    observer.observe(container)

    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [refitTerminalToLoadedFont, reloadKey, termId])

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null

    const poll = async () => {
      const term = terminalRef.current
      if (!term || !usesServerOwnedTerminalState(term)) {
        serverOwnedMouseModeRef.current = false
        if (!cancelled) setScrollStatus(null)
        return
      }

      const status = await window.cells.terminal.getScrollStatus(termId).catch(() => null)
      if (cancelled) return
      if (
        !status ||
        status.backend !== 'tmux' ||
        !status.paneInMode ||
        status.scrollPosition <= 0
      ) {
        serverOwnedMouseModeRef.current =
          status?.backend === 'tmux' &&
          (status.mouseAnyFlag === true || status.alternateOn === true)
        setScrollStatus((previous) => (previous === null ? previous : null))
      } else {
        serverOwnedMouseModeRef.current =
          status.mouseAnyFlag === true || status.alternateOn === true
        setScrollStatus((previous) => {
          if (
            previous &&
            previous.paneInMode === status.paneInMode &&
            previous.scrollPosition === status.scrollPosition &&
            previous.historySize === status.historySize
          ) {
            return previous
          }
          return {
            paneInMode: status.paneInMode,
            scrollPosition: status.scrollPosition,
            historySize: status.historySize,
          }
        })
      }
      timer = window.setTimeout(poll, isFocused ? 120 : 220)
    }

    void poll()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [termId, isFocused, reloadKey])

  return (
    <div
      ref={containerRef}
      className="cell-terminal relative w-full h-full"
      style={{ width, height }}
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
