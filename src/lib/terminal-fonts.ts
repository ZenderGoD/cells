export interface TerminalFontOption {
  label: string
  value: string
  aliases?: string[]
}

export const TERMINAL_FONT_FAMILIES: TerminalFontOption[] = [
  {
    label: 'GeistMono Nerd Font',
    value: '"GeistMono NFM", "Geist Mono", monospace',
    aliases: ['"GeistMono NF", monospace', '"GeistMono NF", "Geist Mono", monospace'],
  },
  {
    label: 'JetBrainsMono Nerd Font',
    value: '"JetBrainsMono NFM", monospace',
    aliases: ['"JetBrainsMono NF", monospace'],
  },
  {
    label: 'FiraCode Nerd Font',
    value: '"FiraCode Nerd Font Mono", monospace',
    aliases: ['"FiraCode NF", monospace'],
  },
  {
    label: 'Meslo Nerd Font',
    value: '"MesloLGS Nerd Font Mono", monospace',
    aliases: ['"Meslo NF", monospace'],
  },
  {
    label: 'Hack Nerd Font',
    value: '"Hack Nerd Font Mono", monospace',
    aliases: ['"Hack NF", monospace'],
  },
]

export const DEFAULT_TERMINAL_FONT_FAMILY = TERMINAL_FONT_FAMILIES[0].value

const LEGACY_NON_NERD_TERMINAL_FONT_FAMILIES = new Set([
  '"Geist Mono", "SFMono-Regular", "JetBrains Mono", "Menlo", monospace',
  '"JetBrains Mono", "SFMono-Regular", "Menlo", monospace',
])

export function normalizeTerminalFontFamily(value: string | null | undefined): string {
  if (!value) return DEFAULT_TERMINAL_FONT_FAMILY

  const normalized = value.trim()
  if (LEGACY_NON_NERD_TERMINAL_FONT_FAMILIES.has(normalized)) {
    return DEFAULT_TERMINAL_FONT_FAMILY
  }
  for (const option of TERMINAL_FONT_FAMILIES) {
    if (option.value === normalized) return option.value
    if (option.aliases?.includes(normalized)) return option.value
  }

  return DEFAULT_TERMINAL_FONT_FAMILY
}
