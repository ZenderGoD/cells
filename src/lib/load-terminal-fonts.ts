type BundledFontFace = {
  filename: string
  family: string
  weight: string
  style: 'normal'
}

const TERMINAL_FONT_FACES: BundledFontFace[] = [
  {
    filename: 'GeistMonoNerdFontMono-Regular.otf',
    family: 'GeistMono NFM',
    weight: '400',
    style: 'normal',
  },
  {
    filename: 'GeistMonoNerdFontMono-Bold.otf',
    family: 'GeistMono NFM',
    weight: '700',
    style: 'normal',
  },
  {
    filename: 'JetBrainsMonoNerdFontMono-Regular.ttf',
    family: 'JetBrainsMono NFM',
    weight: '400',
    style: 'normal',
  },
  {
    filename: 'JetBrainsMonoNerdFontMono-Bold.ttf',
    family: 'JetBrainsMono NFM',
    weight: '700',
    style: 'normal',
  },
  {
    filename: 'FiraCodeNerdFontMono-Regular.ttf',
    family: 'FiraCode Nerd Font Mono',
    weight: '400',
    style: 'normal',
  },
  {
    filename: 'FiraCodeNerdFontMono-Bold.ttf',
    family: 'FiraCode Nerd Font Mono',
    weight: '700',
    style: 'normal',
  },
  {
    filename: 'MesloLGSNerdFontMono-Regular.ttf',
    family: 'MesloLGS Nerd Font Mono',
    weight: '400',
    style: 'normal',
  },
  {
    filename: 'MesloLGSNerdFontMono-Bold.ttf',
    family: 'MesloLGS Nerd Font Mono',
    weight: '700',
    style: 'normal',
  },
  {
    filename: 'HackNerdFontMono-Regular.ttf',
    family: 'Hack Nerd Font Mono',
    weight: '400',
    style: 'normal',
  },
  {
    filename: 'HackNerdFontMono-Bold.ttf',
    family: 'Hack Nerd Font Mono',
    weight: '700',
    style: 'normal',
  },
]

const GLYPH_SAMPLE = '\ue0b0\ue0b2\uf0c8\ue5ff'

let loadPromise: Promise<void> | null = null

function decodeBase64ToUint8Array(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function loadBundledTerminalFonts() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    if (typeof document === 'undefined' || !document.fonts) return

    let fontData: Record<string, string> = {}
    try {
      fontData = (await window.cells.app.getTerminalFontData()) || {}
    } catch {}

    await Promise.allSettled(
      TERMINAL_FONT_FACES.map(async (font) => {
        const sourceBase64 = fontData[font.filename]
        if (!sourceBase64) return
        const face = new FontFace(font.family, decodeBase64ToUint8Array(sourceBase64), {
          weight: font.weight,
          style: font.style,
        })
        const loaded = await face.load()
        document.fonts.add(loaded)
      }),
    )

    await Promise.allSettled(
      TERMINAL_FONT_FACES.map((font) =>
        document.fonts.load(`${font.weight} 16px "${font.family}"`, GLYPH_SAMPLE),
      ),
    )

    await document.fonts.ready
  })()
  return loadPromise
}
