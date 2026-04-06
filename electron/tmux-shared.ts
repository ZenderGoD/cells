import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execaSync } from 'execa'
import tmuxBundle from '../config/tmux-bundle.json'

export const TMUX_INSTALL_URL = 'https://github.com/tmux/tmux/wiki/Installing'
export const TMUX_MIN_VERSION = tmuxBundle.minimumVersion
export const CELLS_TMUX_TERM = 'cells-tmux-256color'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export type TmuxSupportStatus = {
  ok: boolean
  reason: 'missing' | 'too-old' | null
  binaryPath: string | null
  version: string | null
  minimumVersion: string
}

type ParsedTmuxVersion = {
  major: number
  minor: number
  suffix: string
}

function parseTmuxVersion(version: string): ParsedTmuxVersion | null {
  const match = version.trim().match(/^(\d+)\.(\d+)([a-z]*)$/i)
  if (!match) return null
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    suffix: match[3]?.toLowerCase() ?? '',
  }
}

export function compareTmuxVersions(left: string, right: string): number {
  const a = parseTmuxVersion(left)
  const b = parseTmuxVersion(right)
  if (!a || !b) return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.suffix === b.suffix) return 0
  if (!a.suffix) return -1
  if (!b.suffix) return 1
  return a.suffix.localeCompare(b.suffix, undefined, { sensitivity: 'base' })
}

export function resolveTmuxBinary(): string {
  const configured = process.env.CELLS_TMUX_BINARY?.trim()
  if (configured) return configured

  const bundled = resolveBundledTmuxBinary()
  if (bundled) return bundled

  try {
    const result = execaSync('/bin/sh', ['-lc', 'command -v tmux'], {
      reject: false,
      stdin: 'ignore',
      timeout: 1500,
    })
    if (result.exitCode === 0) return result.stdout.trim()
  } catch {
    // Fall through to the bare command name.
  }
  return 'tmux'
}

function getBundledTmuxExecutableName() {
  return process.platform === 'win32' ? 'tmux.exe' : 'tmux'
}

function getBundledTmuxPlatformArchDir() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  }
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64'
  }
  return `${process.platform}-${process.arch}`
}

function getBundledTmuxCandidates() {
  const relative = path.join(
    'vendor',
    'tmux',
    getBundledTmuxPlatformArchDir(),
    getBundledTmuxExecutableName(),
  )
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, relative) : null,
    path.resolve(__dirname, '../resources', relative),
    path.resolve(__dirname, '../../resources', relative),
  ]
  return [...new Set(candidates.filter(Boolean) as string[])]
}

export function resolveBundledTmuxBinary(): string | null {
  for (const candidate of getBundledTmuxCandidates()) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

export function readTmuxVersion(binaryPath = resolveTmuxBinary()): string | null {
  try {
    const result = execaSync(binaryPath, ['-V'], {
      reject: false,
      stdin: 'ignore',
      timeout: 1500,
    })
    if (result.exitCode !== 0) return null
    const output = result.stdout.trim()
    const match = output.match(/^tmux\s+(.+)$/i)
    return match?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

export function getTmuxSupportStatus(): TmuxSupportStatus {
  const binaryPath = resolveTmuxBinary()
  const version = readTmuxVersion(binaryPath)
  if (!version) {
    return {
      ok: false,
      reason: 'missing',
      binaryPath: null,
      version: null,
      minimumVersion: TMUX_MIN_VERSION,
    }
  }

  if (compareTmuxVersions(version, TMUX_MIN_VERSION) < 0) {
    return {
      ok: false,
      reason: 'too-old',
      binaryPath,
      version,
      minimumVersion: TMUX_MIN_VERSION,
    }
  }

  return {
    ok: true,
    reason: null,
    binaryPath,
    version,
    minimumVersion: TMUX_MIN_VERSION,
  }
}

export function getPrivateTmuxSocketPath(stateDir: string): string {
  return path.join(stateDir, 'tmux.sock')
}

export function getPrivateTmuxConfigPath(stateDir: string): string {
  return path.join(stateDir, 'tmux.conf')
}

export function getPrivateTmuxTerminfoDir(stateDir: string): string {
  return path.join(stateDir, 'terminfo')
}

export function getPrivateTmuxTerminfoSourcePath(stateDir: string): string {
  return path.join(stateDir, 'tmux.terminfo')
}

// Many hosts ship a conservative tmux-256color entry that only advertises 256
// colors. Cells compiles a private app-owned variant with RGB/Tc and a few
// modern style capabilities so apps inside tmux can render closer to the
// non-tmux terminal path without relying on system terminfo patches.
export function buildPrivateTmuxTerminfoSource(termName = CELLS_TMUX_TERM): string {
  return [
    `${termName}|Cells private tmux terminfo with RGB color support,`,
    '  Tc,',
    '  RGB,',
    '  Ms=\\E]52;%p1%s;%p2%s\\007,',
    '  Setulc=\\E[58:2::%p1%d:%p2%d:%p3%dm,',
    '  Smulx=\\E[4:%p1%dm,',
    '  use=tmux-256color,',
    '',
  ].join('\n')
}

export function ensurePrivateTmuxTerminfo(
  stateDir: string,
  termName = CELLS_TMUX_TERM,
): { termName: string; terminfoDir: string | null; compiled: boolean } {
  const terminfoDir = getPrivateTmuxTerminfoDir(stateDir)
  const sourcePath = getPrivateTmuxTerminfoSourcePath(stateDir)

  try {
    fs.mkdirSync(terminfoDir, { recursive: true })
    fs.writeFileSync(sourcePath, buildPrivateTmuxTerminfoSource(termName), 'utf8')
    const result = execaSync('tic', ['-x', '-o', terminfoDir, sourcePath], {
      reject: false,
      stdin: 'ignore',
      timeout: 5000,
    })
    if (result.exitCode !== 0) throw new Error(result.stderr || result.shortMessage)
    return {
      termName,
      terminfoDir,
      compiled: true,
    }
  } catch {
    return {
      termName: 'tmux-256color',
      terminfoDir: null,
      compiled: false,
    }
  }
}

export function buildPrivateTmuxConfig(
  defaultShell: string,
  defaultTerminal = CELLS_TMUX_TERM,
): string {
  const shell = defaultShell.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return [
    '# Cells private tmux config',
    '# This file is app-owned and intentionally ignores user tmux.conf.',
    'set-option -sg display-time 0',
    'set-option -sg message-style "bg=default,fg=default"',
    'set-option -sg message-command-style "bg=default,fg=default"',
    'set-option -sg bell-action none',
    'set-option -g status off',
    'set-option -g mouse on',
    'set-option -g prefix None',
    'set-option -g visual-activity off',
    'set-option -g visual-bell off',
    'set-option -g monitor-activity off',
    'set-option -g allow-rename off',
    'set-option -g aggressive-resize on',
    'set-window-option -g automatic-rename off',
    'set-window-option -g window-size latest',
    'set-window-option -g pane-border-status off',
    'set-window-option -g pane-active-border-style "fg=default"',
    'set-window-option -g pane-border-style "fg=default"',
    'set-window-option -g remain-on-exit off',
    'unbind-key C-b',
    'unbind-key C-a',
    `set-option -g default-terminal "${defaultTerminal}"`,
    `set-option -g default-command "${shell} -l"`,
    `set-option -g default-shell "${shell}"`,
    'set-option -g allow-passthrough on',
    'set-option -g focus-events on',
    'set-option -g extended-keys on',
    'set-option -g extended-keys-format xterm',
    'set-option -s set-clipboard on',
    'set-option -s copy-command "pbcopy"',
    'set-option -g history-limit 50000',
    'set-environment -g COLORTERM "truecolor"',
    'set-environment -g TERM_PROGRAM "ghostty"',
    `set-option -ga terminal-features ",${defaultTerminal}:RGB,clipboard,ccolour,cstyle,extkeys,focus,hyperlinks,osc7,title,usstyle,strikethrough,overline,sync"`,
    'set-option -ga terminal-features ",xterm-256color:RGB,focus,clipboard,ccolour,cstyle,extkeys,hyperlinks,osc7,title,usstyle,strikethrough,overline,sync"',
    'set-option -ga terminal-features ",tmux-256color:RGB,clipboard,ccolour,cstyle,extkeys,focus,hyperlinks,osc7,title,usstyle,strikethrough,overline,sync"',
    `set-option -ga terminal-overrides ",${defaultTerminal}:Tc"`,
    'set-option -ga terminal-overrides ",xterm-256color:Tc,tmux-256color:Tc"',
    'bind-key -T root WheelUpPane if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" { send-keys -M } { copy-mode -eH ; send-keys -M }',
    '',
  ].join('\n')
}
