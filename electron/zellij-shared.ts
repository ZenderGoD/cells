import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import zellijBundle from '../config/zellij-bundle.json'
import {
  DEFAULT_THEME,
  getTerminalTheme,
  hexToRgb,
  type TerminalTheme,
} from '../src/lib/terminal-themes'

export const ZELLIJ_INSTALL_URL = 'https://zellij.dev/documentation/installation.html'
export const ZELLIJ_MIN_VERSION = zellijBundle.version
export const ZELLIJ_BUNDLED_VERSION = zellijBundle.version

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export type ZellijSupportStatus = {
  ok: boolean
  reason: 'missing' | 'too-old' | null
  binaryPath: string | null
  version: string | null
  minimumVersion: string
}

type ParsedZellijVersion = {
  major: number
  minor: number
  patch: number
}

function parseZellijVersion(version: string): ParsedZellijVersion | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return null
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  }
}

export function compareZellijVersions(left: string, right: string): number {
  const a = parseZellijVersion(left)
  const b = parseZellijVersion(right)
  if (!a || !b) return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

export function resolveZellijBinary(): string {
  const configured = process.env.CELLS_ZELLIJ_BINARY?.trim()
  if (configured) return configured

  const bundled = resolveBundledZellijBinary()
  if (bundled) return bundled

  try {
    return execFileSync('/bin/sh', ['-lc', 'command -v zellij'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim()
  } catch {
    return 'zellij'
  }
}

function getBundledZellijExecutableName() {
  return process.platform === 'win32' ? 'zellij.exe' : 'zellij'
}

function getBundledZellijPlatformArchDir() {
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

function getBundledZellijCandidates() {
  const relative = path.join(
    'vendor',
    'zellij',
    getBundledZellijPlatformArchDir(),
    getBundledZellijExecutableName(),
  )
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, relative) : null,
    path.resolve(__dirname, '../resources', relative),
    path.resolve(__dirname, '../../resources', relative),
  ]
  return [...new Set(candidates.filter(Boolean) as string[])]
}

export function resolveBundledZellijBinary(): string | null {
  for (const candidate of getBundledZellijCandidates()) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

export function readZellijVersion(binaryPath = resolveZellijBinary()): string | null {
  try {
    const output = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim()
    const match = output.match(/^zellij\s+(.+)$/i)
    return match?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

export function getZellijSupportStatus(): ZellijSupportStatus {
  const binaryPath = resolveZellijBinary()
  const version = readZellijVersion(binaryPath)
  if (!version) {
    return {
      ok: false,
      reason: 'missing',
      binaryPath: null,
      version: null,
      minimumVersion: ZELLIJ_MIN_VERSION,
    }
  }

  if (compareZellijVersions(version, ZELLIJ_MIN_VERSION) < 0) {
    return {
      ok: false,
      reason: 'too-old',
      binaryPath,
      version,
      minimumVersion: ZELLIJ_MIN_VERSION,
    }
  }

  return {
    ok: true,
    reason: null,
    binaryPath,
    version,
    minimumVersion: ZELLIJ_MIN_VERSION,
  }
}

export function getPrivateZellijDir(stateDir: string): string {
  return path.join(stateDir, 'zellij')
}

export function getPrivateZellijDataDir(stateDir: string): string {
  return path.join(getPrivateZellijDir(stateDir), 'data')
}

export function getPrivateZellijConfigDir(stateDir: string): string {
  return path.join(getPrivateZellijDir(stateDir), 'config')
}

export function getPrivateZellijConfigPath(stateDir: string): string {
  return path.join(getPrivateZellijConfigDir(stateDir), 'config.kdl')
}

export function getPrivateZellijLayoutDir(stateDir: string): string {
  return path.join(getPrivateZellijConfigDir(stateDir), 'layouts')
}

export function getPrivateZellijLayoutPath(stateDir: string): string {
  return path.join(getPrivateZellijLayoutDir(stateDir), 'cells.kdl')
}

function readCellsTerminalThemeName(stateDir: string) {
  try {
    const raw = fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.terminalTheme === 'string' && parsed.terminalTheme.trim()) {
      return parsed.terminalTheme.trim()
    }
  } catch {}
  return DEFAULT_THEME
}

function buildLegacyThemeBlock(theme: TerminalTheme) {
  const toRgbTriplet = (hex: string) => {
    const rgb = hexToRgb(hex)
    return rgb ? `${rgb.r} ${rgb.g} ${rgb.b}` : '0 0 0'
  }

  // Zellij still supports the legacy ANSI palette theme spec. For Cells this is
  // the most direct way to keep shell/TUI colors aligned with the chosen
  // terminal theme instead of relying on Zellij's built-in defaults.
  return [
    'themes {',
    '  cells_private {',
    `    fg ${toRgbTriplet(theme.foreground)}`,
    `    bg ${toRgbTriplet(theme.background)}`,
    `    black ${toRgbTriplet(theme.black)}`,
    `    red ${toRgbTriplet(theme.red)}`,
    `    green ${toRgbTriplet(theme.green)}`,
    `    yellow ${toRgbTriplet(theme.yellow)}`,
    `    blue ${toRgbTriplet(theme.blue)}`,
    `    magenta ${toRgbTriplet(theme.magenta)}`,
    `    cyan ${toRgbTriplet(theme.cyan)}`,
    `    white ${toRgbTriplet(theme.white)}`,
    `    orange ${toRgbTriplet(theme.brightYellow)}`,
    '  }',
    '}',
  ].join('\n')
}

export function buildPrivateZellijConfig(defaultShell: string, themeName = DEFAULT_THEME): string {
  const shell = defaultShell.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const theme = getTerminalTheme(themeName)
  return [
    '// Cells private Zellij config',
    '// This file is app-owned and intentionally ignores the user Zellij config.',
    `default_shell "${shell}"`,
    'default_mode "locked"',
    'default_layout "cells"',
    'theme "cells_private"',
    'pane_frames false',
    'simplified_ui true',
    // Let xterm.js handle selection natively. With mouse_mode true, zellij
    // forwards mouse-tracking escapes to the host terminal which disables
    // xterm's click-drag selection — the user cannot select text the way
    // they can under tmux. Cells only uses single-pane layouts so we don't
    // need zellij's mouse handling for pane clicks.
    'mouse_mode false',
    'copy_on_select true',
    'styled_underlines false',
    'scroll_buffer_size 50000',
    'show_startup_tips false',
    'show_release_notes false',
    '',
    buildLegacyThemeBlock(theme),
    '',
  ].join('\n')
}

export function buildPrivateZellijLayout(): string {
  return ['// Cells single-pane layout', 'layout {', '    pane borderless=true', '}', ''].join('\n')
}

export function ensurePrivateZellijConfig(stateDir: string, _defaultShell: string) {
  const configDir = getPrivateZellijConfigDir(stateDir)
  const dataDir = getPrivateZellijDataDir(stateDir)
  const layoutDir = getPrivateZellijLayoutDir(stateDir)
  fs.mkdirSync(layoutDir, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })

  // Zellij's default_shell doesn't accept arguments, so we write a tiny
  // wrapper that execs the user's shell as a login shell. This matches the
  // direct PTY behavior Cells previously used successfully.
  const loginWrapperPath = path.join(configDir, 'login-shell')
  fs.writeFileSync(loginWrapperPath, '#!/bin/sh\nexec "$SHELL" -l\n', { mode: 0o755 })

  fs.writeFileSync(
    getPrivateZellijConfigPath(stateDir),
    buildPrivateZellijConfig(loginWrapperPath, readCellsTerminalThemeName(stateDir)),
    'utf8',
  )
  fs.writeFileSync(getPrivateZellijLayoutPath(stateDir), buildPrivateZellijLayout(), 'utf8')
  return {
    dataDir,
    configDir,
    configPath: getPrivateZellijConfigPath(stateDir),
    layoutPath: getPrivateZellijLayoutPath(stateDir),
  }
}
