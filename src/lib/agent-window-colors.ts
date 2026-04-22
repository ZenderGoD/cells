// Palette for color-coding agent windows. Class names are written out in
// full (no string templating) so Tailwind's JIT can see them at build time.
// Keep the palette small — the point is glanceable identification, not
// customization. Adding a color? Pair it with a visible swatch, a focused
// border tint (~/55), and a top-accent bar (solid).

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
  accentBarClass: string
  focusedBorderClass: string
  unfocusedBorderClass: string
}

export const AGENT_WINDOW_COLORS: AgentWindowColorSpec[] = [
  {
    id: 'none',
    label: 'No color',
    swatchClass: '',
    accentBarClass: '',
    focusedBorderClass: '',
    unfocusedBorderClass: '',
  },
  {
    id: 'sky',
    label: 'Sky',
    swatchClass: 'bg-sky-400',
    accentBarClass: 'bg-sky-400/85',
    focusedBorderClass: 'border-sky-400/55',
    unfocusedBorderClass: 'border-sky-400/25',
  },
  {
    id: 'emerald',
    label: 'Emerald',
    swatchClass: 'bg-emerald-400',
    accentBarClass: 'bg-emerald-400/85',
    focusedBorderClass: 'border-emerald-400/55',
    unfocusedBorderClass: 'border-emerald-400/25',
  },
  {
    id: 'amber',
    label: 'Amber',
    swatchClass: 'bg-amber-400',
    accentBarClass: 'bg-amber-400/85',
    focusedBorderClass: 'border-amber-400/55',
    unfocusedBorderClass: 'border-amber-400/25',
  },
  {
    id: 'rose',
    label: 'Rose',
    swatchClass: 'bg-rose-400',
    accentBarClass: 'bg-rose-400/85',
    focusedBorderClass: 'border-rose-400/55',
    unfocusedBorderClass: 'border-rose-400/25',
  },
  {
    id: 'violet',
    label: 'Violet',
    swatchClass: 'bg-violet-400',
    accentBarClass: 'bg-violet-400/85',
    focusedBorderClass: 'border-violet-400/55',
    unfocusedBorderClass: 'border-violet-400/25',
  },
  {
    id: 'cyan',
    label: 'Cyan',
    swatchClass: 'bg-cyan-400',
    accentBarClass: 'bg-cyan-400/85',
    focusedBorderClass: 'border-cyan-400/55',
    unfocusedBorderClass: 'border-cyan-400/25',
  },
  {
    id: 'slate',
    label: 'Slate',
    swatchClass: 'bg-slate-400',
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
