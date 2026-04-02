export type TerminalCursorStyle = 'block' | 'underline' | 'bar'

export interface TerminalCursorSettings {
  terminalCursorStyle: TerminalCursorStyle
  terminalCursorBlink: boolean
}

export const DEFAULT_TERMINAL_CURSOR_SETTINGS: TerminalCursorSettings = {
  terminalCursorStyle: 'block',
  terminalCursorBlink: false,
}

export const TERMINAL_CURSOR_STYLE_OPTIONS: Array<{
  value: TerminalCursorStyle
  label: string
  hint: string
}> = [
  { value: 'block', label: 'Block', hint: 'Filled cell' },
  { value: 'bar', label: 'Bar', hint: 'Vertical beam' },
  { value: 'underline', label: 'Underline', hint: 'Line under text' },
]

export function normalizeTerminalCursorStyle(
  value: TerminalCursorStyle | null | undefined,
): TerminalCursorStyle {
  switch (value) {
    case 'block':
    case 'bar':
    case 'underline':
      return value
    default:
      return DEFAULT_TERMINAL_CURSOR_SETTINGS.terminalCursorStyle
  }
}

export function normalizeTerminalCursorSettings(
  value: Partial<TerminalCursorSettings> | null | undefined,
): TerminalCursorSettings {
  return {
    terminalCursorStyle: normalizeTerminalCursorStyle(value?.terminalCursorStyle),
    terminalCursorBlink:
      value?.terminalCursorBlink ?? DEFAULT_TERMINAL_CURSOR_SETTINGS.terminalCursorBlink,
  }
}
