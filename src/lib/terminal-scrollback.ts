export const DEFAULT_TERMINAL_SCROLLBACK_LINES = 5_000
export const MIN_TERMINAL_SCROLLBACK_LINES = 1_000
export const MAX_TERMINAL_SCROLLBACK_LINES = 50_000

export function normalizeTerminalScrollbackLines(value: number | null | undefined) {
  const numeric = Number.isFinite(value)
    ? Math.round(value ?? DEFAULT_TERMINAL_SCROLLBACK_LINES)
    : 0
  return clamp(
    numeric || DEFAULT_TERMINAL_SCROLLBACK_LINES,
    MIN_TERMINAL_SCROLLBACK_LINES,
    MAX_TERMINAL_SCROLLBACK_LINES,
  )
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
