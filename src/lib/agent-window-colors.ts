// Palette for color-coding agent windows. Class names are written out in
// full (no string templating) so Tailwind's JIT can see them at build time.
// Keep the palette small — the point is glanceable identification, not
// customization. Adding a color? Pair it with a visible swatch, a frame color,
// focused/unfocused border tints, and a compact accent for small previews.

export type AgentWindowColorId =
  | 'none'
  | 'sky'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'violet'
  | 'cyan'
  | 'slate'

export interface AgentWindowColorSpec {
  id: AgentWindowColorId
  label: string
  swatchClass: string
  frameColor: string
  accentBarClass: string
  focusedBorderClass: string
  unfocusedBorderClass: string
}

export const DEFAULT_AGENT_WINDOW_COLOR_OPACITY = 72

export function normalizeAgentWindowColorOpacity(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return DEFAULT_AGENT_WINDOW_COLOR_OPACITY
  return Math.min(100, Math.max(20, Math.round(value)))
}

export const AGENT_WINDOW_COLORS: AgentWindowColorSpec[] = [
  {
    id: 'none',
    label: 'No color',
    swatchClass: '',
    frameColor: '',
    accentBarClass: '',
    focusedBorderClass: '',
    unfocusedBorderClass: '',
  },
  {
    id: 'sky',
    label: 'Sky',
    swatchClass: 'bg-sky-400',
    frameColor: 'oklch(74.6% 0.16 232.66)',
    accentBarClass: 'bg-sky-400/85',
    focusedBorderClass: 'border-sky-400/55',
    unfocusedBorderClass: 'border-sky-400/25',
  },
  {
    id: 'emerald',
    label: 'Emerald',
    swatchClass: 'bg-emerald-400',
    frameColor: 'oklch(76.5% 0.177 163.223)',
    accentBarClass: 'bg-emerald-400/85',
    focusedBorderClass: 'border-emerald-400/55',
    unfocusedBorderClass: 'border-emerald-400/25',
  },
  {
    id: 'amber',
    label: 'Amber',
    swatchClass: 'bg-amber-400',
    frameColor: 'oklch(82.8% 0.189 84.429)',
    accentBarClass: 'bg-amber-400/85',
    focusedBorderClass: 'border-amber-400/55',
    unfocusedBorderClass: 'border-amber-400/25',
  },
  {
    id: 'rose',
    label: 'Rose',
    swatchClass: 'bg-rose-400',
    frameColor: 'oklch(71.2% 0.194 13.428)',
    accentBarClass: 'bg-rose-400/85',
    focusedBorderClass: 'border-rose-400/55',
    unfocusedBorderClass: 'border-rose-400/25',
  },
  {
    id: 'violet',
    label: 'Violet',
    swatchClass: 'bg-violet-400',
    frameColor: 'oklch(70.2% 0.183 293.541)',
    accentBarClass: 'bg-violet-400/85',
    focusedBorderClass: 'border-violet-400/55',
    unfocusedBorderClass: 'border-violet-400/25',
  },
  {
    id: 'cyan',
    label: 'Cyan',
    swatchClass: 'bg-cyan-400',
    frameColor: 'oklch(78.9% 0.154 211.53)',
    accentBarClass: 'bg-cyan-400/85',
    focusedBorderClass: 'border-cyan-400/55',
    unfocusedBorderClass: 'border-cyan-400/25',
  },
  {
    id: 'slate',
    label: 'Slate',
    swatchClass: 'bg-slate-400',
    frameColor: 'oklch(70.4% 0.04 256.788)',
    accentBarClass: 'bg-slate-400/85',
    focusedBorderClass: 'border-slate-400/55',
    unfocusedBorderClass: 'border-slate-400/25',
  },
]

const BY_ID = new Map(AGENT_WINDOW_COLORS.map((color) => [color.id, color]))

export function getAgentWindowColor(
  id: AgentWindowColorId | null | undefined,
): AgentWindowColorSpec {
  if (!id) return AGENT_WINDOW_COLORS[0]
  return BY_ID.get(id) ?? AGENT_WINDOW_COLORS[0]
}
