const TERMINAL_FONT_LOAD_TARGETS = [
  { family: '"GeistMono NFM"', weights: ['400', '700'] },
  { family: '"JetBrainsMono NFM"', weights: ['400', '700'] },
  { family: '"FiraCode Nerd Font Mono"', weights: ['400', '700'] },
  { family: '"MesloLGS Nerd Font Mono"', weights: ['400', '700'] },
  { family: '"Hack Nerd Font Mono"', weights: ['400', '700'] },
] as const

const GLYPH_SAMPLE = '\ue0b0\ue0b2\uf0c8\ue5ff'

let loadPromise: Promise<void> | null = null

export function loadBundledTerminalFonts() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    if (typeof document === 'undefined' || !document.fonts) return

    await Promise.allSettled(
      TERMINAL_FONT_LOAD_TARGETS.flatMap((font) =>
        font.weights.map((weight) =>
          document.fonts.load(`${weight} 16px ${font.family}`, GLYPH_SAMPLE),
        ),
      ),
    )

    await document.fonts.ready
  })()
  return loadPromise
}
