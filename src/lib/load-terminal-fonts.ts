import geistMonoRegularUrl from '@/fonts/GeistMonoNerdFontMono-Regular.otf'
import geistMonoBoldUrl from '@/fonts/GeistMonoNerdFontMono-Bold.otf'
import jetBrainsMonoRegularUrl from '@/fonts/JetBrainsMonoNerdFontMono-Regular.ttf'
import jetBrainsMonoBoldUrl from '@/fonts/JetBrainsMonoNerdFontMono-Bold.ttf'
import firaCodeRegularUrl from '@/fonts/FiraCodeNerdFontMono-Regular.ttf'
import firaCodeBoldUrl from '@/fonts/FiraCodeNerdFontMono-Bold.ttf'
import mesloRegularUrl from '@/fonts/MesloLGSNerdFontMono-Regular.ttf'
import mesloBoldUrl from '@/fonts/MesloLGSNerdFontMono-Bold.ttf'
import hackRegularUrl from '@/fonts/HackNerdFontMono-Regular.ttf'
import hackBoldUrl from '@/fonts/HackNerdFontMono-Bold.ttf'

type BundledFontFace = {
  family: string
  weight: string
  style: 'normal'
  url: string
  format: 'opentype' | 'truetype'
}

const TERMINAL_FONT_FACES: BundledFontFace[] = [
  {
    family: 'GeistMono NF',
    weight: '400',
    style: 'normal',
    url: geistMonoRegularUrl,
    format: 'opentype',
  },
  {
    family: 'GeistMono NF',
    weight: '700',
    style: 'normal',
    url: geistMonoBoldUrl,
    format: 'opentype',
  },
  {
    family: 'JetBrainsMono NF',
    weight: '400',
    style: 'normal',
    url: jetBrainsMonoRegularUrl,
    format: 'truetype',
  },
  {
    family: 'JetBrainsMono NF',
    weight: '700',
    style: 'normal',
    url: jetBrainsMonoBoldUrl,
    format: 'truetype',
  },
  {
    family: 'FiraCode NF',
    weight: '400',
    style: 'normal',
    url: firaCodeRegularUrl,
    format: 'truetype',
  },
  {
    family: 'FiraCode NF',
    weight: '700',
    style: 'normal',
    url: firaCodeBoldUrl,
    format: 'truetype',
  },
  { family: 'Meslo NF', weight: '400', style: 'normal', url: mesloRegularUrl, format: 'truetype' },
  { family: 'Meslo NF', weight: '700', style: 'normal', url: mesloBoldUrl, format: 'truetype' },
  { family: 'Hack NF', weight: '400', style: 'normal', url: hackRegularUrl, format: 'truetype' },
  { family: 'Hack NF', weight: '700', style: 'normal', url: hackBoldUrl, format: 'truetype' },
]

let loadPromise: Promise<void> | null = null

export function loadBundledTerminalFonts() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) {
      return
    }

    await Promise.allSettled(
      TERMINAL_FONT_FACES.map(async (font) => {
        const face = new FontFace(
          font.family,
          `url(${JSON.stringify(font.url)}) format(${JSON.stringify(font.format)})`,
          {
            weight: font.weight,
            style: font.style,
          },
        )
        const loaded = await face.load()
        document.fonts.add(loaded)
      }),
    )
  })()
  return loadPromise
}
