export interface TerminalFontOption {
  label: string
  value: string
  aliases?: string[]
}

export const TERMINAL_FONT_FAMILIES: TerminalFontOption[] = [
  {
    label: 'GeistMono Nerd Font',
    value: '"GeistMono NF", "Geist Mono", monospace',
    aliases: ['"GeistMono NF", monospace', '"GeistMono NFM"'],
  },
  {
    label: 'JetBrainsMono Nerd Font',
    value: '"JetBrainsMono NF", monospace',
    aliases: ['"JetBrainsMono NFM"'],
  },
  {
    label: 'FiraCode Nerd Font',
    value: '"FiraCode NF", monospace',
    aliases: ['"FiraCode Nerd Font Mono"'],
  },
  {
    label: 'Meslo Nerd Font',
    value: '"Meslo NF", monospace',
    aliases: ['"MesloLGS Nerd Font Mono"'],
  },
  {
    label: 'Hack Nerd Font',
    value: '"Hack NF", monospace',
    aliases: ['"Hack Nerd Font Mono"'],
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
