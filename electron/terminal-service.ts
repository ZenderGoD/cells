import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import type { TerminalSessionBackend } from '../src/types'

export const TERMINAL_SERVICE_LABEL = 'com.cells.terminal-service'

export interface TerminalServiceConfig {
  stateDir: string
  appVersion: string
  execPath: string
  daemonScript: string
  backend: TerminalSessionBackend
  packaged: boolean
}

export interface TerminalServiceStatus {
  available: boolean
  enabled: boolean
  loaded: boolean
  label: string
  plistPath: string | null
  domain: string | null
  error: string | null
}

export interface TerminalServiceControls {
  enabled: boolean
  start(): Promise<boolean>
  stop(): Promise<boolean>
  status(): TerminalServiceStatus
}

function getLaunchAgentDir() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents')
}

function getPlistPath() {
  return path.join(getLaunchAgentDir(), `${TERMINAL_SERVICE_LABEL}.plist`)
}

function getLaunchctlDomain() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid
  return `gui/${uid}`
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function plistString(value: string) {
  return `<string>${xmlEscape(value)}</string>`
}

function plistEnv(env: Record<string, string>) {
  return Object.entries(env)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    ${plistString(value)}`)
    .join('\n')
}

function buildPlist(config: TerminalServiceConfig) {
  const logDir = config.stateDir
  const env = {
    ELECTRON_RUN_AS_NODE: '1',
    CELLS_APP_VERSION: config.appVersion,
    CELLS_HOME_DIR: config.stateDir,
    CELLS_TERMINAL_BACKEND: config.backend,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${plistString(TERMINAL_SERVICE_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${plistString(config.execPath)}
    ${plistString(config.daemonScript)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${plistEnv(env)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  ${plistString(path.join(logDir, 'terminal-service.out.log'))}
  <key>StandardErrorPath</key>
  ${plistString(path.join(logDir, 'terminal-service.err.log'))}
</dict>
</plist>
`
}

function launchctl(args: string[]) {
  return spawnSync('/bin/launchctl', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function isLoaded(domain: string) {
  const result = launchctl(['print', `${domain}/${TERMINAL_SERVICE_LABEL}`])
  return result.status === 0
}

function writePlist(config: TerminalServiceConfig) {
  fs.mkdirSync(config.stateDir, { recursive: true })
  fs.mkdirSync(getLaunchAgentDir(), { recursive: true })
  const plistPath = getPlistPath()
  const next = buildPlist(config)
  let current = ''
  try {
    current = fs.readFileSync(plistPath, 'utf8')
  } catch {}
  if (current !== next) {
    fs.writeFileSync(plistPath, next, 'utf8')
  }
  return plistPath
}

export function createTerminalServiceControls(
  config: TerminalServiceConfig,
): TerminalServiceControls {
  const available = config.packaged && process.platform === 'darwin'
  const domain = available ? getLaunchctlDomain() : null
  const plistPath = available ? getPlistPath() : null
  let lastError: string | null = null

  const status = (): TerminalServiceStatus => ({
    available,
    enabled: available,
    loaded: Boolean(domain && isLoaded(domain)),
    label: TERMINAL_SERVICE_LABEL,
    plistPath,
    domain,
    error: lastError,
  })

  if (!available || !domain || !plistPath) {
    return {
      enabled: false,
      async start() {
        return false
      },
      async stop() {
        return true
      },
      status,
    }
  }

  return {
    enabled: true,
    async start() {
      try {
        const nextPlistPath = writePlist(config)
        if (isLoaded(domain)) {
          const unloaded = launchctl(['bootout', `${domain}/${TERMINAL_SERVICE_LABEL}`])
          if (unloaded.status !== 0 && isLoaded(domain)) {
            lastError =
              unloaded.stderr?.trim() || unloaded.stdout?.trim() || 'launchctl bootout failed'
            return false
          }
        }

        const bootstrapped = launchctl(['bootstrap', domain, nextPlistPath])
        if (bootstrapped.status !== 0 && !isLoaded(domain)) {
          lastError =
            bootstrapped.stderr?.trim() ||
            bootstrapped.stdout?.trim() ||
            'launchctl bootstrap failed'
          return false
        }
        lastError = null
        return true
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        return false
      }
    },
    async stop() {
      try {
        if (isLoaded(domain)) {
          const result = launchctl(['bootout', `${domain}/${TERMINAL_SERVICE_LABEL}`])
          if (result.status !== 0 && isLoaded(domain)) {
            lastError = result.stderr?.trim() || result.stdout?.trim() || 'launchctl bootout failed'
            return false
          }
        }
        lastError = null
        return true
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        return false
      }
    },
    status,
  }
}
