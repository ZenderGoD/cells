// Copied and adapted from Craft Agents OSS:
// ../craft-agents-oss/packages/shared/src/utils/cli-icon-resolver.ts
// Resolves bash command strings → { displayName, iconUrl } using the 57 tool
// icons lifted from Craft (src/assets/tool-icons/). Handles env-var prefixes,
// sudo/time/nohup passthroughs, pipe/chain boundaries, and absolute-path
// invocations (/usr/local/bin/node → node).

import toolIconsConfigRaw from '@/assets/tool-icons/tool-icons.json'

// Eagerly bundle every icon next to tool-icons.json. Vite rewrites the paths
// at build time so the URLs survive packaging.
const iconModules = import.meta.glob('@/assets/tool-icons/*.{png,svg,ico,jpg,jpeg}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

// Map filename → bundled URL (keys in iconModules are absolute paths).
const iconUrlByFilename = new Map<string, string>()
for (const [fullPath, url] of Object.entries(iconModules)) {
  const filename = fullPath.split('/').pop()
  if (filename) iconUrlByFilename.set(filename.toLowerCase(), url)
}

interface ToolIconEntry {
  id: string
  displayName: string
  icon: string
  commands: string[]
}

interface ToolIconConfig {
  version: number
  tools: ToolIconEntry[]
}

const config = toolIconsConfigRaw as ToolIconConfig

// Build a command → entry lookup for O(1) match. Commands are lowercased.
const entryByCommand = new Map<string, ToolIconEntry>()
for (const entry of config.tools) {
  for (const command of entry.commands) {
    entryByCommand.set(command.toLowerCase(), entry)
  }
}

export interface ResolvedToolIcon {
  id: string
  displayName: string
  iconUrl: string | null
}

// Commands that run another command — skip and use the next token.
const PREFIX_COMMANDS = new Set([
  'sudo',
  'time',
  'nice',
  'nohup',
  'env',
  'timeout',
  'strace',
  'ltrace',
  'ionice',
  'taskset',
  'watch',
  'caffeinate',
])

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

// Split a bash command string on top-level chain operators (|, &&, ||, ;) and
// return the first segment. We only care about identifying the leading tool,
// so parsing inside subshells/quotes is unnecessary for our purposes.
function firstSegment(command: string): string {
  // Very lightweight split — ignore operators inside quotes.
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (ch === '\\' && i + 1 < command.length) {
      i += 1
      continue
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    if (inSingle || inDouble) continue
    if (ch === '|' || ch === ';') return command.slice(0, i)
    if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
      return command.slice(0, i)
    }
  }
  return command
}

// Extract the leading command token from a bash command string, peeling off
// env-var assignments and prefix commands (sudo, time, etc.). Returns the
// command basename lowercased, or null if we can't find one.
function extractLeadingCommand(command: string): string | null {
  const segment = firstSegment(command).trim()
  if (!segment) return null
  // Tokenise on whitespace — shell-quote would be more correct but we only
  // need the first real token, and quoted program names are vanishingly rare.
  const tokens = segment.split(/\s+/).filter(Boolean)
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (isEnvAssignment(token)) {
      index += 1
      continue
    }
    // Strip path prefix: /usr/local/bin/node → node, ./bin/jest → jest
    const base = token.split('/').pop() || token
    const lower = base.toLowerCase()
    if (PREFIX_COMMANDS.has(lower)) {
      index += 1
      continue
    }
    return lower
  }
  return null
}

export function resolveToolIcon(command: string | undefined | null): ResolvedToolIcon | null {
  if (!command) return null
  const leading = extractLeadingCommand(command)
  if (!leading) return null
  const entry = entryByCommand.get(leading)
  if (!entry) return null
  const iconUrl = iconUrlByFilename.get(entry.icon.toLowerCase()) ?? null
  return {
    id: entry.id,
    displayName: entry.displayName,
    iconUrl,
  }
}
