export const UNICODE_REPLACEMENT_CHAR = '\uFFFD'

const MAX_UNICODE_CODE_POINT = 0x10ffff
const SURROGATE_START = 0xd800
const SURROGATE_END = 0xdfff

export function isRenderableCodePoint(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_UNICODE_CODE_POINT &&
    (value < SURROGATE_START || value > SURROGATE_END)
  )
}

export function safeCodePointString(value: unknown): string {
  if (!isRenderableCodePoint(value)) return UNICODE_REPLACEMENT_CHAR
  if (value === 0) return ' '
  return String.fromCodePoint(value)
}

export function safeCodePointsString(values: unknown): string {
  if (!Array.isArray(values) || values.length === 0) return ' '
  return values.map((value) => safeCodePointString(value)).join('')
}
