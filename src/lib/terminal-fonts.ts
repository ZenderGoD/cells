export interface TerminalFontOption {
  label: string
  value: string
  aliases?: string[]
}

export const TERMINAL_FONT_FAMILIES: TerminalFontOption[] = [
  {
    label: 'GeistMono Nerd Font',
    value: '"GeistMono NFM"',
    aliases: [
      '"GeistMono NF"',
      '"GeistMono NF", monospace',
      '"GeistMono NF", "Geist Mono", monospace',
    ],
  },
  {
    label: 'JetBrainsMono Nerd Font',
    value: '"JetBrainsMono NFM"',
    aliases: ['"JetBrainsMono NF"', '"JetBrainsMono NF", monospace'],
  },
  {
    label: 'FiraCode Nerd Font',
    value: '"FiraCode Nerd Font Mono"',
    aliases: ['"FiraCode NF"', '"FiraCode NF", monospace'],
  },
  {
    label: 'Meslo Nerd Font',
    value: '"MesloLGS Nerd Font Mono"',
    aliases: ['"Meslo NF"', '"Meslo NF", monospace'],
  },
  {
    label: 'Hack Nerd Font',
    value: '"Hack Nerd Font Mono"',
    aliases: ['"Hack NF"', '"Hack NF", monospace'],
  },
]

export const DEFAULT_TERMINAL_FONT_FAMILY = TERMINAL_FONT_FAMILIES[0].value

export function normalizeTerminalFontFamily(value: string | null | undefined): string {
  if (!value) return DEFAULT_TERMINAL_FONT_FAMILY

  const normalized = value.trim()
  for (const option of TERMINAL_FONT_FAMILIES) {
    if (option.value === normalized) return option.value
    if (option.aliases?.includes(normalized)) return option.value
  }

  return DEFAULT_TERMINAL_FONT_FAMILY
}
