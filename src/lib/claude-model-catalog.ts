export const CLAUDE_OPUS_4_7_MODEL_ID = 'claude-opus-4-7'
export const CLAUDE_SONNET_4_6_MODEL_ID = 'claude-sonnet-4-6'
export const CLAUDE_HAIKU_4_5_MODEL_ID = 'claude-haiku-4-5-20251001'
export const MINIMUM_CLAUDE_OPUS_4_7_VERSION = '2.1.111'

interface ParsedCliSemver {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
}

export interface ClaudeCatalogModelCandidate {
  id: string | null | undefined
  displayName?: string | null | undefined
  description?: string | null | undefined
}

const CLI_VERSION_NUMBER_SEGMENT = /^\d+$/

export function parseGenericCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)
  return match?.[1] ?? null
}

function normalizeCliVersion(version: string): string {
  const [main, prerelease] = version.trim().split('-', 2)
  const segments = (main ?? '')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  if (segments.length === 2) {
    segments.push('0')
  }

  return prerelease ? `${segments.join('.')}-${prerelease}` : segments.join('.')
}

function parseCliSemver(version: string): ParsedCliSemver | null {
  const normalized = normalizeCliVersion(version)
  const [main = '', prerelease] = normalized.split('-', 2)
  const segments = main.split('.')
  if (segments.length !== 3) {
    return null
  }

  const [majorSegment, minorSegment, patchSegment] = segments
  if (majorSegment === undefined || minorSegment === undefined || patchSegment === undefined) {
    return null
  }
  if (
    !CLI_VERSION_NUMBER_SEGMENT.test(majorSegment) ||
    !CLI_VERSION_NUMBER_SEGMENT.test(minorSegment) ||
    !CLI_VERSION_NUMBER_SEGMENT.test(patchSegment)
  ) {
    return null
  }

  const major = Number.parseInt(majorSegment, 10)
  const minor = Number.parseInt(minorSegment, 10)
  const patch = Number.parseInt(patchSegment, 10)
  if (![major, minor, patch].every(Number.isInteger)) {
    return null
  }

  return {
    major,
    minor,
    patch,
    prerelease:
      prerelease
        ?.split('.')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0) ?? [],
  }
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)

  if (leftNumeric && rightNumeric) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10)
  }
  if (leftNumeric) {
    return -1
  }
  if (rightNumeric) {
    return 1
  }
  return left.localeCompare(right)
}

export function compareCliVersions(left: string, right: string): number {
  const parsedLeft = parseCliSemver(left)
  const parsedRight = parseCliSemver(right)
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right)
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major
  }
  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch - parsedRight.patch
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) {
    return 0
  }
  if (parsedLeft.prerelease.length === 0) {
    return 1
  }
  if (parsedRight.prerelease.length === 0) {
    return -1
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index]
    const rightIdentifier = parsedRight.prerelease[index]
    if (leftIdentifier === undefined) {
      return -1
    }
    if (rightIdentifier === undefined) {
      return 1
    }
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier)
    if (comparison !== 0) {
      return comparison
    }
  }

  return 0
}

export function supportsClaudeOpus47(version: string | null | undefined): boolean {
  return version ? compareCliVersions(version, MINIMUM_CLAUDE_OPUS_4_7_VERSION) >= 0 : false
}

function modelText(candidate: ClaudeCatalogModelCandidate): string {
  return [candidate.id, candidate.displayName, candidate.description]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase()
}

export function normalizeClaudeCatalogModelId(
  candidate: ClaudeCatalogModelCandidate,
  cliVersion: string | null | undefined,
): string | null {
  const rawId = candidate.id?.trim()
  if (!rawId) return null
  if (/\[1m\]/i.test(rawId)) return rawId

  const text = modelText(candidate)
  if (
    /^claude-opus-4-7$/i.test(rawId) ||
    /^opus$/i.test(rawId) ||
    /\bopus(?:\s+|[-_])?4(?:\.|\s)?7\b/.test(text)
  ) {
    return CLAUDE_OPUS_4_7_MODEL_ID
  }
  if (
    /^claude-sonnet-4-6$/i.test(rawId) ||
    /^sonnet$/i.test(rawId) ||
    /\bsonnet(?:\s+|[-_])?4(?:\.|\s)?6\b/.test(text)
  ) {
    return CLAUDE_SONNET_4_6_MODEL_ID
  }
  if (
    /^claude-haiku-4-5(?:-\d+)?$/i.test(rawId) ||
    /^haiku$/i.test(rawId) ||
    /\bhaiku(?:\s+|[-_])?4(?:\.|\s)?5\b/.test(text)
  ) {
    return CLAUDE_HAIKU_4_5_MODEL_ID
  }

  // Newer Claude Code builds expose Opus 4.7 behind the generic `default`
  // alias even when the concrete slug is still accepted for turns.
  if (/^default$/i.test(rawId) && supportsClaudeOpus47(cliVersion)) {
    return CLAUDE_OPUS_4_7_MODEL_ID
  }

  return rawId
}
