/**
 * WebGL-accelerated terminal renderer — drop-in replacement for ghostty-web's CanvasRenderer.
 *
 * WHY THIS EXISTS:
 *   ghostty-web ships only a Canvas2D renderer. Canvas2D becomes a bottleneck
 *   when rendering large grids (200+ cols) because every cell requires separate
 *   fillRect/fillText calls, each crossing the JS→native bridge. WebGL batches
 *   the entire grid into two draw calls per frame.
 *
 * ARCHITECTURE:
 *   1. Glyph atlas (GlyphAtlas class):
 *      - Offscreen Canvas2D renders each unique glyph (char + bold + italic
 *        combination) as white-on-transparent into a 2048×2048 texture.
 *      - The red channel is sampled in the fragment shader as an alpha mask.
 *      - Atlas is rebuilt on font changes; evicted if it fills up (rare).
 *
 *   2. Background pass:
 *      - Solid-color quads for cell backgrounds, selection highlights, and
 *        cursor background. Drawn with blending disabled (fully opaque).
 *
 *   3. Text pass:
 *      - Textured quads referencing the glyph atlas, tinted with the cell's
 *        foreground color. Drawn with premultiplied-alpha blending.
 *
 *   4. Dirty-row tracking:
 *      - Matches CanvasRenderer's approach: only rows flagged dirty by the
 *        terminal buffer (plus adjacent rows for glyph bleed) are rebuilt.
 *
 * COMPATIBILITY:
 *   Exposes the same public API and internal property names as CanvasRenderer
 *   so that cell-terminal.tsx's Reflect.get() access and SelectionManager
 *   integration work without modification.
 *
 *   The monkey-patches in patchGhosttyRenderer() (renderCursor, renderCellText)
 *   target CanvasRenderer.prototype and do NOT apply to this class. All patched
 *   behaviors (block cursor with text overlay, Zellij foreground color clamping,
 *   faint alpha, selection foreground) are built in natively.
 *
 * WIRING:
 *   Injected via the `rendererFactory` option on Terminal (added by our
 *   ghostty-web patch). See cell-terminal.tsx where `new Terminal({...})` is
 *   called.
 */

import type {
  FontMetrics,
  GhosttyCell,
  IRenderable,
  ITheme,
  RendererOptions,
  SelectionCoordinates,
  SelectionManager,
} from 'ghostty-web'
import { CellFlags } from 'ghostty-web'
import { hexToRgb } from '@/lib/terminal-themes'

// ── Types ──────────────────────────────────────────────────────────────

interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null
  getScrollbackLength(): number
}

interface GlyphInfo {
  /** x offset in atlas texture (pixels) */
  x: number
  /** y offset in atlas texture (pixels) */
  y: number
  /** glyph width in atlas (pixels) */
  w: number
  /** glyph height in atlas (pixels) */
  h: number
}

interface HoveredLinkRange {
  startX: number
  startY: number
  endX: number
  endY: number
}

type CursorStyle = 'block' | 'underline' | 'bar'

// ── Shader sources ─────────────────────────────────────────────────────
//
// Background shader: position (vec2) + color (vec4) → solid fill.
// Text shader: position (vec2) + UV (vec2) + color (vec4) → atlas-textured
//   quad where the red channel of the atlas texture serves as an alpha mask
//   (white glyphs on transparent background). Output is premultiplied:
//     gl_FragColor = vec4(color.rgb * mask, mask * color.a)
//   Blended with gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA).

const BG_VS = `
attribute vec2 a_pos;
attribute vec4 a_color;
varying vec4 v_color;
uniform vec2 u_res;
void main() {
  vec2 c = (a_pos / u_res) * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  v_color = a_color;
}
`

const BG_FS = `
precision mediump float;
varying vec4 v_color;
void main() { gl_FragColor = v_color; }
`

const TEXT_VS = `
attribute vec2 a_pos;
attribute vec2 a_uv;
attribute vec4 a_color;
varying vec2 v_uv;
varying vec4 v_color;
uniform vec2 u_res;
void main() {
  vec2 c = (a_pos / u_res) * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  v_uv = a_uv;
  v_color = a_color;
}
`

const TEXT_FS = `
precision mediump float;
varying vec2 v_uv;
varying vec4 v_color;
uniform sampler2D u_atlas;
void main() {
  float a = texture2D(u_atlas, v_uv).r;
  gl_FragColor = vec4(v_color.rgb * a, a * v_color.a);
}
`

// ── Glyph Atlas ────────────────────────────────────────────────────────

// 2048×2048 atlas fits ~32K glyphs at typical terminal font sizes.
// If it fills up (extremely rare — only with huge Unicode diversity)
// the entire atlas is cleared and rebuilt on demand.
const ATLAS_SIZE = 2048

function isDoubleWidthGlyph(char: string) {
  const codePoint = char.codePointAt(0)
  if (codePoint === undefined) return false

  // Nerd Font and powerline glyphs live in the Unicode private-use ranges.
  // They render as single-cell terminal symbols, so treating them as wide
  // corrupts atlas layout and prompt spacing inside tmux.
  if (
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  ) {
    return false
  }

  return codePoint > 0x2e7f
}

class GlyphAtlas {
  private canvas: OffscreenCanvas
  private ctx: OffscreenCanvasRenderingContext2D
  private glyphs = new Map<string, GlyphInfo>()
  private nextX = 0
  private nextY = 0
  private rowH = 0
  dirty = false

  constructor(
    private fontSize: number,
    private fontFamily: string,
    private metrics: FontMetrics,
    private dpr: number,
  ) {
    this.canvas = new OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE)
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false })!
    this.reset()
  }

  /** Clear atlas and rebuild on font change. */
  reset() {
    this.glyphs.clear()
    this.nextX = 0
    this.nextY = 0
    this.rowH = 0
    this.ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE)
    this.dirty = true
  }

  updateFont(fontSize: number, fontFamily: string, metrics: FontMetrics, dpr: number) {
    this.fontSize = fontSize
    this.fontFamily = fontFamily
    this.metrics = metrics
    this.dpr = dpr
    this.reset()
  }

  /** Get (or create) atlas entry for a glyph. */
  get(char: string, bold: boolean, italic: boolean): GlyphInfo {
    const key = `${char}\x00${bold ? 1 : 0}\x00${italic ? 1 : 0}`
    let info = this.glyphs.get(key)
    if (info) return info

    const cellW = Math.ceil(this.metrics.width * this.dpr)
    // Allow wide chars up to 2× cell width, regular chars get 1× cell width
    const isWide = isDoubleWidthGlyph(char)
    const glyphW = isWide ? cellW * 2 : cellW
    const glyphH = Math.ceil(this.metrics.height * this.dpr)

    // Wrap to next row if needed
    if (this.nextX + glyphW > ATLAS_SIZE) {
      this.nextX = 0
      this.nextY += this.rowH
      this.rowH = 0
    }

    // Atlas full — clear and rebuild (rare)
    if (this.nextY + glyphH > ATLAS_SIZE) {
      this.reset()
    }

    const x = this.nextX
    const y = this.nextY

    const ctx = this.ctx
    let font = ''
    if (italic) font += 'italic '
    if (bold) font += 'bold '
    ctx.font = `${font}${this.fontSize * this.dpr}px ${this.fontFamily}`
    ctx.textBaseline = 'alphabetic'
    // Render white glyph — we'll use the red channel as alpha mask in the shader
    ctx.fillStyle = '#fff'
    ctx.fillText(char, x, y + this.metrics.baseline * this.dpr)

    this.nextX = x + glyphW
    this.rowH = Math.max(this.rowH, glyphH)

    info = { x, y, w: glyphW, h: glyphH }
    this.glyphs.set(key, info)
    this.dirty = true
    return info
  }

  getCanvas() {
    return this.canvas
  }
}

// ── Helper functions ───────────────────────────────────────────────────

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(s)
    gl.deleteShader(s)
    throw new Error(`Shader compile error: ${info}`)
  }
  return s
}

function linkProgram(gl: WebGLRenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(p)
    gl.deleteProgram(p)
    throw new Error(`Program link error: ${info}`)
  }
  return p
}

function colorDistance(
  l: { r: number; g: number; b: number },
  r: { r: number; g: number; b: number },
) {
  return Math.sqrt((l.r - r.r) ** 2 + (l.g - r.g) ** 2 + (l.b - r.b) ** 2)
}

// ── WebGL Terminal Renderer ────────────────────────────────────────────

export class WebGLTerminalRenderer {
  // ── Private properties (same names as CanvasRenderer for compatibility) ──
  canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext
  fontSize: number
  fontFamily: string
  cursorStyle: CursorStyle
  cursorBlink: boolean
  theme: ITheme & { __cellsBackend?: string | null }
  devicePixelRatio: number
  metrics: FontMetrics = { width: 0, height: 0, baseline: 0 }
  private palette: string[] = []
  cursorVisible = true
  private cursorBlinkInterval?: ReturnType<typeof setInterval>
  private lastCursorPosition = { x: 0, y: 0 }
  private lastViewportY = 0
  currentBuffer: IRenderable | null = null
  selectionManager?: SelectionManager
  currentSelectionCoords: SelectionCoordinates | null = null
  hoveredHyperlinkId = 0
  private previousHoveredHyperlinkId = 0
  hoveredLinkRange: HoveredLinkRange | null = null
  private previousHoveredLinkRange: HoveredLinkRange | null = null

  // WebGL resources
  private bgProgram!: WebGLProgram
  private textProgram!: WebGLProgram
  private bgBuffer!: WebGLBuffer
  private textBuffer!: WebGLBuffer
  private atlasTexture!: WebGLTexture
  private atlas!: GlyphAtlas

  // Attribute/uniform locations
  private bgLocs!: {
    a_pos: number
    a_color: number
    u_res: WebGLUniformLocation
  }
  private textLocs!: {
    a_pos: number
    a_uv: number
    a_color: number
    u_res: WebGLUniformLocation
    u_atlas: WebGLUniformLocation
  }

  // Vertex data accumulators
  private bgVerts: number[] = []
  private textVerts: number[] = []

  // Offscreen canvas for font measurement
  private measureCanvas: OffscreenCanvas
  private measureCtx: OffscreenCanvasRenderingContext2D

  // Cols/rows
  private cols = 0
  private rows = 0

  constructor(canvas: HTMLCanvasElement, options?: RendererOptions) {
    this.canvas = canvas
    this.fontSize = options?.fontSize ?? 12
    this.fontFamily = options?.fontFamily ?? 'monospace'
    this.cursorStyle = options?.cursorStyle ?? 'block'
    this.cursorBlink = options?.cursorBlink ?? false
    this.theme = options?.theme ?? {}
    this.devicePixelRatio = options?.devicePixelRatio ?? window.devicePixelRatio ?? 1

    // Font measurement canvas
    this.measureCanvas = new OffscreenCanvas(200, 200)
    this.measureCtx = this.measureCanvas.getContext('2d')!

    this.measureFont()

    // WebGL context
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    })
    if (!gl) throw new Error('WebGL not supported')
    this.gl = gl

    this.initGL()

    // Glyph atlas
    this.atlas = new GlyphAtlas(this.fontSize, this.fontFamily, this.metrics, this.devicePixelRatio)

    if (this.cursorBlink) this.startCursorBlink()
  }

  private initGL() {
    const gl = this.gl

    // Background program
    const bgVS = compileShader(gl, gl.VERTEX_SHADER, BG_VS)
    const bgFS = compileShader(gl, gl.FRAGMENT_SHADER, BG_FS)
    this.bgProgram = linkProgram(gl, bgVS, bgFS)
    gl.deleteShader(bgVS)
    gl.deleteShader(bgFS)

    this.bgLocs = {
      a_pos: gl.getAttribLocation(this.bgProgram, 'a_pos'),
      a_color: gl.getAttribLocation(this.bgProgram, 'a_color'),
      u_res: gl.getUniformLocation(this.bgProgram, 'u_res')!,
    }

    // Text program
    const textVS = compileShader(gl, gl.VERTEX_SHADER, TEXT_VS)
    const textFS = compileShader(gl, gl.FRAGMENT_SHADER, TEXT_FS)
    this.textProgram = linkProgram(gl, textVS, textFS)
    gl.deleteShader(textVS)
    gl.deleteShader(textFS)

    this.textLocs = {
      a_pos: gl.getAttribLocation(this.textProgram, 'a_pos'),
      a_uv: gl.getAttribLocation(this.textProgram, 'a_uv'),
      a_color: gl.getAttribLocation(this.textProgram, 'a_color'),
      u_res: gl.getUniformLocation(this.textProgram, 'u_res')!,
      u_atlas: gl.getUniformLocation(this.textProgram, 'u_atlas')!,
    }

    // Buffers
    this.bgBuffer = gl.createBuffer()!
    this.textBuffer = gl.createBuffer()!

    // Atlas texture
    this.atlasTexture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    // Blending for text (premultiplied alpha)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)
  }

  // ── Font measurement ─────────────────────────────────────────────────

  private measureFont() {
    const ctx = this.measureCtx
    ctx.font = `${this.fontSize * this.devicePixelRatio}px ${this.fontFamily}`

    // Measure character dimensions
    const m = ctx.measureText('M')
    const testChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let maxW = 0
    for (const ch of testChars) {
      const cm = ctx.measureText(ch)
      maxW = Math.max(maxW, cm.width)
    }

    // Use integer pixel metrics for crisp alignment
    const width = Math.ceil(maxW) / this.devicePixelRatio
    const ascent = Math.ceil(m.actualBoundingBoxAscent) / this.devicePixelRatio
    const descent = Math.ceil(m.actualBoundingBoxDescent) / this.devicePixelRatio
    const height = Math.ceil((ascent + descent) * 1.2) // line-height factor
    const baseline = Math.ceil(ascent + (height - ascent - descent) / 2)

    this.metrics = { width, height, baseline }
  }

  remeasureFont() {
    this.measureFont()
    this.atlas.updateFont(this.fontSize, this.fontFamily, this.metrics, this.devicePixelRatio)
    this.uploadAtlasTexture()
  }

  // ── Public API (same as CanvasRenderer) ──────────────────────────────

  resize(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    const w = cols * this.metrics.width
    const h = rows * this.metrics.height
    const pw = Math.ceil(w * this.devicePixelRatio)
    const ph = Math.ceil(h * this.devicePixelRatio)
    this.canvas.width = pw
    this.canvas.height = ph
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${h}px`
    this.gl.viewport(0, 0, pw, ph)
  }

  render(
    buffer: IRenderable,
    forceAll = false,
    viewportY = 0,
    scrollbackProvider?: IScrollbackProvider,
    _scrollbarOpacity = 0,
  ) {
    this.currentBuffer = buffer
    const gl = this.gl

    const cursor = buffer.getCursor()
    const dims = buffer.getDimensions()
    const scrollbackLen = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0

    // Check if full redraw needed
    if (buffer.needsFullRedraw?.()) forceAll = true

    // Check canvas size
    const expectedW = dims.cols * this.metrics.width * this.devicePixelRatio
    const expectedH = dims.rows * this.metrics.height * this.devicePixelRatio
    if (
      Math.abs(this.canvas.width - expectedW) > 0.5 ||
      Math.abs(this.canvas.height - expectedH) > 0.5
    ) {
      this.resize(dims.cols, dims.rows)
      forceAll = true
    }

    if (viewportY !== this.lastViewportY) {
      forceAll = true
      this.lastViewportY = viewportY
    }

    // Determine dirty rows
    const hasSelection = this.selectionManager?.hasSelection() ?? false
    this.currentSelectionCoords = hasSelection
      ? (this.selectionManager!.getSelectionCoords() as SelectionCoordinates)
      : null

    const selRows = new Set<number>()
    if (this.currentSelectionCoords) {
      const sc = this.currentSelectionCoords
      for (let r = sc.startRow; r <= sc.endRow; r++) selRows.add(r)
    }
    if (this.selectionManager) {
      const dirty = (this.selectionManager as any).getDirtySelectionRows?.() as
        | Set<number>
        | undefined
      if (dirty && dirty.size > 0) {
        for (const r of dirty) selRows.add(r)
        ;(this.selectionManager as any).clearDirtySelectionRows?.()
      }
    }

    // Hyperlink dirty rows
    const linkRows = new Set<number>()
    const hyperlinkChanged = this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId
    if (hyperlinkChanged) {
      for (let r = 0; r < dims.rows; r++) {
        const line = this.getLineForRow(r, viewportY, buffer, scrollbackProvider, scrollbackLen)
        if (line) {
          for (const cell of line) {
            if (
              cell.hyperlink_id === this.hoveredHyperlinkId ||
              cell.hyperlink_id === this.previousHoveredHyperlinkId
            ) {
              linkRows.add(r)
              break
            }
          }
        }
      }
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId
    }

    const linkRangeChanged =
      JSON.stringify(this.hoveredLinkRange) !== JSON.stringify(this.previousHoveredLinkRange)
    if (linkRangeChanged) {
      if (this.previousHoveredLinkRange) {
        for (
          let r = this.previousHoveredLinkRange.startY;
          r <= this.previousHoveredLinkRange.endY;
          r++
        )
          linkRows.add(r)
      }
      if (this.hoveredLinkRange) {
        for (let r = this.hoveredLinkRange.startY; r <= this.hoveredLinkRange.endY; r++)
          linkRows.add(r)
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange
    }

    // Build set of rows to render
    const dirtyRows = new Set<number>()
    for (let r = 0; r < dims.rows; r++) {
      if (forceAll || buffer.isRowDirty(r) || selRows.has(r) || linkRows.has(r)) {
        dirtyRows.add(r)
        if (r > 0) dirtyRows.add(r - 1)
        if (r < dims.rows - 1) dirtyRows.add(r + 1)
      }
    }

    // Always re-render cursor row(s)
    const cursorMoved =
      cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y
    if (cursorMoved || this.cursorBlink) {
      dirtyRows.add(cursor.y)
      if (cursorMoved && cursor.y !== this.lastCursorPosition.y) {
        dirtyRows.add(this.lastCursorPosition.y)
      }
    }

    if (dirtyRows.size === 0) {
      buffer.clearDirty()
      return
    }

    // If we're doing a full redraw, clear and rebuild everything
    const fullFrame = forceAll || dirtyRows.size >= dims.rows

    // Build vertex data
    this.bgVerts.length = 0
    this.textVerts.length = 0

    const bgColor = this.parseThemeColor(this.theme.background, 0, 0, 0)
    const dpr = this.devicePixelRatio
    const cw = this.metrics.width * dpr
    const ch = this.metrics.height * dpr
    const totalW = dims.cols * cw
    const faintAlpha = this.getFaintAlpha()

    for (let r = 0; r < dims.rows; r++) {
      if (!fullFrame && !dirtyRows.has(r)) continue

      const py = r * ch
      const line = this.getLineForRow(r, viewportY, buffer, scrollbackProvider, scrollbackLen)

      // Row background
      this.pushBgQuad(0, py, totalW, ch, bgColor[0], bgColor[1], bgColor[2], 1)

      if (!line) continue

      // Pass 1: cell backgrounds
      for (let c = 0; c < line.length; c++) {
        const cell = line[c]
        if (cell.width === 0) continue
        this.renderCellBackground(cell, c, r, cw, ch, dpr)
      }

      // Pass 2: cell text
      for (let c = 0; c < line.length; c++) {
        const cell = line[c]
        if (cell.width === 0) continue
        this.renderCellText(cell, c, r, cw, ch, dpr, faintAlpha, buffer, viewportY)
      }
    }

    // Cursor
    if (viewportY === 0 && cursor.visible && this.cursorVisible) {
      this.renderCursor(cursor.x, cursor.y, cw, ch, dpr, faintAlpha, buffer)
    }

    // Upload atlas if dirty
    if (this.atlas.dirty) {
      this.uploadAtlasTexture()
      this.atlas.dirty = false
    }

    // ── Draw ───────────────────────────────────────────────────────────
    // For full frames, clear everything; for partial updates the per-row
    // background quads already overwrite stale content.
    if (fullFrame) {
      const bg = this.parseThemeColor(this.theme.background, 0, 0, 0)
      gl.clearColor(bg[0], bg[1], bg[2], 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }

    const canvasW = this.canvas.width
    const canvasH = this.canvas.height

    // Draw backgrounds
    if (this.bgVerts.length > 0) {
      gl.useProgram(this.bgProgram)
      gl.uniform2f(this.bgLocs.u_res, canvasW, canvasH)

      gl.bindBuffer(gl.ARRAY_BUFFER, this.bgBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.bgVerts), gl.STREAM_DRAW)

      // a_pos: 2 floats, a_color: 4 floats = 6 floats per vertex = 24 bytes
      gl.enableVertexAttribArray(this.bgLocs.a_pos)
      gl.vertexAttribPointer(this.bgLocs.a_pos, 2, gl.FLOAT, false, 24, 0)
      gl.enableVertexAttribArray(this.bgLocs.a_color)
      gl.vertexAttribPointer(this.bgLocs.a_color, 4, gl.FLOAT, false, 24, 8)

      // Disable blending for opaque backgrounds
      gl.disable(gl.BLEND)
      gl.drawArrays(gl.TRIANGLES, 0, this.bgVerts.length / 6)
      gl.enable(gl.BLEND)
    }

    // Draw text
    if (this.textVerts.length > 0) {
      gl.useProgram(this.textProgram)
      gl.uniform2f(this.textLocs.u_res, canvasW, canvasH)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture)
      gl.uniform1i(this.textLocs.u_atlas, 0)

      gl.bindBuffer(gl.ARRAY_BUFFER, this.textBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.textVerts), gl.STREAM_DRAW)

      // a_pos: 2, a_uv: 2, a_color: 4 = 8 floats = 32 bytes
      gl.enableVertexAttribArray(this.textLocs.a_pos)
      gl.vertexAttribPointer(this.textLocs.a_pos, 2, gl.FLOAT, false, 32, 0)
      gl.enableVertexAttribArray(this.textLocs.a_uv)
      gl.vertexAttribPointer(this.textLocs.a_uv, 2, gl.FLOAT, false, 32, 8)
      gl.enableVertexAttribArray(this.textLocs.a_color)
      gl.vertexAttribPointer(this.textLocs.a_color, 4, gl.FLOAT, false, 32, 16)

      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.drawArrays(gl.TRIANGLES, 0, this.textVerts.length / 8)
    }

    this.lastCursorPosition = { x: cursor.x, y: cursor.y }
    buffer.clearDirty()
  }

  // ── Line resolution (handles scrollback) ─────────────────────────────

  private getLineForRow(
    screenRow: number,
    viewportY: number,
    buffer: IRenderable,
    scrollbackProvider?: IScrollbackProvider,
    scrollbackLen = 0,
  ): GhosttyCell[] | null {
    if (viewportY > 0) {
      if (screenRow < viewportY && scrollbackProvider) {
        const offset = scrollbackLen - Math.floor(viewportY) + screenRow
        return scrollbackProvider.getScrollbackLine(offset)
      }
      return buffer.getLine(screenRow - Math.floor(viewportY))
    }
    return buffer.getLine(screenRow)
  }

  // ── Cell rendering helpers ───────────────────────────────────────────

  private renderCellBackground(
    cell: GhosttyCell,
    col: number,
    row: number,
    cw: number,
    ch: number,
    _dpr: number,
  ) {
    const px = col * cw
    const py = row * ch
    const w = cw * cell.width
    const inSel = this.isInSelection(col, row)

    if (inSel) {
      const sc = this.parseThemeColor(this.theme.selectionBackground, 0.3, 0.5, 0.8)
      this.pushBgQuad(px, py, w, ch, sc[0], sc[1], sc[2], 1)
    } else {
      let br = cell.bg_r
      let bg = cell.bg_g
      let bb = cell.bg_b
      if (cell.flags & CellFlags.INVERSE) {
        br = cell.fg_r
        bg = cell.fg_g
        bb = cell.fg_b
      }
      // Only draw non-default backgrounds
      const defBg = this.parseThemeColor(this.theme.background, 0, 0, 0)
      const dr = br / 255
      const dg = bg / 255
      const db = bb / 255
      if (
        Math.abs(dr - defBg[0]) > 0.01 ||
        Math.abs(dg - defBg[1]) > 0.01 ||
        Math.abs(db - defBg[2]) > 0.01
      ) {
        this.pushBgQuad(px, py, w, ch, dr, dg, db, 1)
      }
    }
  }

  private renderCellText(
    cell: GhosttyCell,
    col: number,
    row: number,
    cw: number,
    ch: number,
    dpr: number,
    faintAlpha: number,
    buffer: IRenderable,
    viewportY: number,
  ) {
    if (cell.flags & CellFlags.INVISIBLE) return
    if (!cell.codepoint && cell.grapheme_len <= 0) return

    const inSel = this.isInSelection(col, row)
    let r: number, g: number, b: number

    if (inSel) {
      const sf = this.parseThemeColor(this.theme.selectionForeground, 1, 1, 1)
      r = sf[0]
      g = sf[1]
      b = sf[2]
    } else {
      let cr = cell.fg_r
      let cg = cell.fg_g
      let cb = cell.fg_b
      if (cell.flags & CellFlags.INVERSE) {
        cr = cell.bg_r
        cg = cell.bg_g
        cb = cell.bg_b
      }
      const clamped = this.clampForeground(cr, cg, cb)
      r = clamped.r / 255
      g = clamped.g / 255
      b = clamped.b / 255
    }

    let alpha = 1
    if (cell.flags & CellFlags.FAINT) alpha = faintAlpha

    // Get glyph text
    let text: string
    // Resolve the actual buffer row from the screen row
    const bufferRow = viewportY > 0 ? row - Math.floor(viewportY) : row
    if (cell.grapheme_len > 0 && buffer.getGraphemeString) {
      text = buffer.getGraphemeString(bufferRow, col)
    } else {
      text = String.fromCodePoint(cell.codepoint || 32)
    }

    if (text === ' ' || text === '') return

    const bold = !!(cell.flags & CellFlags.BOLD)
    const italic = !!(cell.flags & CellFlags.ITALIC)

    const glyph = this.atlas.get(text, bold, italic)
    const px = col * cw
    const py = row * ch

    this.pushTextQuad(px, py, glyph, r, g, b, alpha)

    // Underline
    if (cell.codepoint && cell.flags & CellFlags.UNDERLINE) {
      const uly = py + this.metrics.baseline * dpr + 2 * dpr
      const ulh = Math.max(1, dpr)
      const w = cw * cell.width
      this.pushBgQuad(px, uly, w, ulh, r, g, b, alpha)
    }

    // Strikethrough
    if (cell.codepoint && cell.flags & CellFlags.STRIKETHROUGH) {
      const sty = py + (this.metrics.height * dpr) / 2
      const sth = Math.max(1, dpr)
      const w = cw * cell.width
      this.pushBgQuad(px, sty, w, sth, r, g, b, alpha)
    }

    // Hyperlink underline
    if (cell.hyperlink_id && cell.hyperlink_id === this.hoveredHyperlinkId) {
      const uly = py + this.metrics.baseline * dpr + 2 * dpr
      const ulh = Math.max(1, dpr)
      const w = cw * cell.width
      this.pushBgQuad(px, uly, w, ulh, r, g, b, alpha)
    }

    // Hovered link range underline
    if (this.hoveredLinkRange) {
      const lr = this.hoveredLinkRange
      if (
        row >= lr.startY &&
        row <= lr.endY &&
        (row > lr.startY || col >= lr.startX) &&
        (row < lr.endY || col <= lr.endX)
      ) {
        const uly = py + this.metrics.baseline * dpr + 2 * dpr
        const ulh = Math.max(1, dpr)
        const w = cw * cell.width
        this.pushBgQuad(px, uly, w, ulh, r, g, b, alpha)
      }
    }
  }

  private renderCursor(
    x: number,
    y: number,
    cw: number,
    ch: number,
    dpr: number,
    faintAlpha: number,
    buffer: IRenderable,
  ) {
    const px = x * cw
    const py = y * ch
    const cursorColor = this.parseThemeColor(this.theme.cursor, 1, 1, 1)

    switch (this.cursorStyle) {
      case 'block': {
        // Cursor background
        this.pushBgQuad(px, py, cw, ch, cursorColor[0], cursorColor[1], cursorColor[2], 1)

        // Render character under cursor in cursorAccent color
        const line = buffer.getLine(y)
        const cell = line?.[x]
        if (!cell || cell.flags & CellFlags.INVISIBLE || cell.grapheme_len <= 0) break
        if (!cell.codepoint && cell.grapheme_len <= 0) break

        const accentColor = this.parseThemeColor(
          this.theme.cursorAccent ?? this.theme.background,
          0,
          0,
          0,
        )
        let text: string
        if (cell.grapheme_len > 0 && buffer.getGraphemeString) {
          text = buffer.getGraphemeString(y, x)
        } else {
          text = String.fromCodePoint(cell.codepoint || 32)
        }

        if (text && text !== ' ') {
          const bold = !!(cell.flags & CellFlags.BOLD)
          const italic = !!(cell.flags & CellFlags.ITALIC)
          const glyph = this.atlas.get(text, bold, italic)
          const alpha = cell.flags & CellFlags.FAINT ? faintAlpha : 1
          this.pushTextQuad(px, py, glyph, accentColor[0], accentColor[1], accentColor[2], alpha)
        }
        break
      }
      case 'underline': {
        const uly = py + ch - 2 * dpr
        const ulh = Math.max(2, 2 * dpr)
        this.pushBgQuad(px, uly, cw, ulh, cursorColor[0], cursorColor[1], cursorColor[2], 1)
        break
      }
      case 'bar': {
        const barW = Math.max(2, 2 * dpr)
        this.pushBgQuad(px, py, barW, ch, cursorColor[0], cursorColor[1], cursorColor[2], 1)
        break
      }
    }
  }

  // ── Vertex buffer helpers ────────────────────────────────────────────

  private pushBgQuad(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ) {
    const v = this.bgVerts
    // Triangle 1
    v.push(x, y, r, g, b, a)
    v.push(x + w, y, r, g, b, a)
    v.push(x, y + h, r, g, b, a)
    // Triangle 2
    v.push(x + w, y, r, g, b, a)
    v.push(x + w, y + h, r, g, b, a)
    v.push(x, y + h, r, g, b, a)
  }

  private pushTextQuad(
    px: number,
    py: number,
    glyph: GlyphInfo,
    r: number,
    g: number,
    b: number,
    a: number,
  ) {
    const v = this.textVerts
    const x0 = px
    const y0 = py
    const x1 = px + glyph.w
    const y1 = py + glyph.h
    const u0 = glyph.x / ATLAS_SIZE
    const v0 = glyph.y / ATLAS_SIZE
    const u1 = (glyph.x + glyph.w) / ATLAS_SIZE
    const v1 = (glyph.y + glyph.h) / ATLAS_SIZE

    // Triangle 1
    v.push(x0, y0, u0, v0, r, g, b, a)
    v.push(x1, y0, u1, v0, r, g, b, a)
    v.push(x0, y1, u0, v1, r, g, b, a)
    // Triangle 2
    v.push(x1, y0, u1, v0, r, g, b, a)
    v.push(x1, y1, u1, v1, r, g, b, a)
    v.push(x0, y1, u0, v1, r, g, b, a)
  }

  // ── Selection ────────────────────────────────────────────────────────

  isInSelection(col: number, row: number): boolean {
    const sc = this.currentSelectionCoords
    if (!sc) return false
    if (row < sc.startRow || row > sc.endRow) return false
    if (row === sc.startRow && row === sc.endRow) return col >= sc.startCol && col < sc.endCol
    if (row === sc.startRow) return col >= sc.startCol
    if (row === sc.endRow) return col < sc.endCol
    return true
  }

  // ── Color helpers ────────────────────────────────────────────────────

  private colorCache = new Map<string, [number, number, number]>()

  private parseThemeColor(
    hex: string | undefined,
    dr: number,
    dg: number,
    db: number,
  ): [number, number, number] {
    if (!hex) return [dr, dg, db]
    const cached = this.colorCache.get(hex)
    if (cached) return cached
    const rgb = hexToRgb(hex)
    if (!rgb) return [dr, dg, db]
    const result: [number, number, number] = [rgb.r / 255, rgb.g / 255, rgb.b / 255]
    this.colorCache.set(hex, result)
    return result
  }

  rgbToCSS(r: number, g: number, b: number): string {
    return `rgb(${r},${g},${b})`
  }

  private clampForeground(r: number, g: number, b: number) {
    const background = this.theme.background ? hexToRgb(this.theme.background) : null
    const fallback = this.theme.brightBlack ? hexToRgb(this.theme.brightBlack) : null
    if (!background || !fallback) return { r, g, b }

    // Only apply on dark themes
    if (background.r + background.g + background.b >= 3 * 128) return { r, g, b }
    // Only for zellij backend
    if ((this.theme as any).__cellsBackend !== 'zellij') return { r, g, b }

    const color = { r, g, b }
    if (colorDistance(color, background) < 84 && r + g + b < 180) {
      return fallback
    }
    return color
  }

  private getFaintAlpha(): number {
    return (this.theme as any).__cellsBackend === 'zellij' ? 0.78 : 0.5
  }

  // ── Atlas texture upload ─────────────────────────────────────────────

  private uploadAtlasTexture() {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas.getCanvas())
  }

  // ── Theme / font setters ─────────────────────────────────────────────

  setTheme(theme: ITheme) {
    this.theme = theme
    this.colorCache.clear()
  }

  setFontSize(size: number) {
    this.fontSize = size
    this.remeasureFont()
  }

  setFontFamily(family: string) {
    this.fontFamily = family
    this.remeasureFont()
  }

  setCursorStyle(style: CursorStyle) {
    this.cursorStyle = style
  }

  setCursorBlink(enabled: boolean) {
    const was = this.cursorBlink
    this.cursorBlink = enabled
    if (enabled && !was) this.startCursorBlink()
    if (!enabled && was) this.stopCursorBlink()
  }

  getMetrics(): FontMetrics {
    return this.metrics
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas
  }

  setSelectionManager(manager: SelectionManager) {
    this.selectionManager = manager
  }

  setHoveredHyperlinkId(id: number) {
    this.hoveredHyperlinkId = id
  }

  setHoveredLinkRange(range: HoveredLinkRange | null) {
    this.hoveredLinkRange = range
  }

  get charWidth(): number {
    return this.metrics.width
  }

  get charHeight(): number {
    return this.metrics.height
  }

  clear() {
    const gl = this.gl
    const bg = this.parseThemeColor(this.theme.background, 0, 0, 0)
    gl.clearColor(bg[0], bg[1], bg[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  dispose() {
    this.stopCursorBlink()
    const gl = this.gl
    gl.deleteProgram(this.bgProgram)
    gl.deleteProgram(this.textProgram)
    gl.deleteBuffer(this.bgBuffer)
    gl.deleteBuffer(this.textBuffer)
    gl.deleteTexture(this.atlasTexture)
    const ext = gl.getExtension('WEBGL_lose_context')
    ext?.loseContext()
  }

  // ── Cursor blink ─────────────────────────────────────────────────────

  private startCursorBlink() {
    this.stopCursorBlink()
    this.cursorVisible = true
    this.cursorBlinkInterval = setInterval(() => {
      this.cursorVisible = !this.cursorVisible
    }, 530)
  }

  private stopCursorBlink() {
    if (this.cursorBlinkInterval != null) {
      clearInterval(this.cursorBlinkInterval)
      this.cursorBlinkInterval = undefined
    }
    this.cursorVisible = true
  }
}
