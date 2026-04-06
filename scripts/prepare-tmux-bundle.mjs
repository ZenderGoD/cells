import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { execaSync } from 'execa'
import tmuxBundle from '../config/tmux-bundle.json' with { type: 'json' }

const ROOT = process.cwd()
const VENDOR_ROOT = path.join(ROOT, 'resources', 'vendor', 'tmux')
const MINIMUM_VERSION = tmuxBundle.minimumVersion
const REQUIRE_TARGETS = process.env.CELLS_TMUX_REQUIRE_TARGETS === '1'
const DOWNLOADS_ROOT = path.join(ROOT, '.tmp', 'tmux-bottles')

const TARGETS = {
  'darwin-arm64': { binary: 'tmux' },
  'darwin-x64': { binary: 'tmux' },
  'linux-arm64': { binary: 'tmux' },
  'linux-x64': { binary: 'tmux' },
}

const HOMEBREW_BOTTLE_TAGS = {
  'darwin-arm64': ['arm64_tahoe', 'arm64_sequoia', 'arm64_sonoma'],
  'darwin-x64': ['sonoma'],
  'linux-arm64': ['arm64_linux'],
  'linux-x64': ['x86_64_linux'],
}

function parseTmuxVersion(version) {
  const match = version.trim().match(/^(\d+)\.(\d+)([a-z]*)$/i)
  if (!match) return null
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    suffix: match[3]?.toLowerCase() ?? '',
  }
}

function compareTmuxVersions(left, right) {
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

function resolveHostTarget() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  }
  return null
}

function resolveRequestedTargets() {
  const requested = process.env.CELLS_TMUX_TARGETS?.trim()
  if (requested) {
    return requested
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  }

  const targets = []
  if (process.platform === 'darwin') {
    if (fsSync.existsSync('/opt/homebrew/bin/tmux')) targets.push('darwin-arm64')
    if (fsSync.existsSync('/usr/local/bin/tmux')) targets.push('darwin-x64')
  }
  if (targets.length > 0) return targets

  const hostTarget = resolveHostTarget()
  return hostTarget ? [hostTarget] : []
}

function getEnvBinaryKey(targetKey) {
  return `CELLS_TMUX_BINARY_${targetKey.toUpperCase().replace(/-/g, '_')}`
}

function commandExists(binaryPath) {
  try {
    fsSync.accessSync(binaryPath, fsSync.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveCommandLineTmux() {
  const result = execaSync('/bin/sh', ['-lc', 'command -v tmux'], {
    reject: false,
    stdin: 'ignore',
    timeout: 1500,
  })
  return result.exitCode === 0 ? result.stdout.trim() : null
}

function resolveSourceBinary(targetKey) {
  const envOverride = process.env[getEnvBinaryKey(targetKey)]?.trim()
  if (envOverride) return envOverride

  const genericOverride = process.env.CELLS_TMUX_BINARY?.trim()
  if (genericOverride) return genericOverride

  if (targetKey === 'darwin-arm64' && commandExists('/opt/homebrew/bin/tmux')) {
    return '/opt/homebrew/bin/tmux'
  }
  if (targetKey === 'darwin-x64' && commandExists('/usr/local/bin/tmux')) {
    return '/usr/local/bin/tmux'
  }

  const hostTarget = resolveHostTarget()
  if (targetKey === hostTarget) return resolveCommandLineTmux()
  return null
}

function readTmuxVersion(binaryPath) {
  const result = execaSync(binaryPath, ['-V'], {
    reject: false,
    stdin: 'ignore',
    timeout: 1500,
  })
  if (result.exitCode !== 0) return null
  const match = result.stdout.trim().match(/^tmux\s+(.+)$/i)
  return match?.[1]?.trim() ?? null
}

let homebrewFormulaCache = null

async function fetchText(url) {
  const response = await globalThis.fetch(url)
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`)
  }
  return response.text()
}

async function getGhcrToken(scope) {
  const tokenUrl = `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(scope)}`
  const response = await globalThis.fetch(tokenUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch GHCR token: ${response.status} ${response.statusText}`)
  }
  const payload = await response.json()
  return payload.token
}

async function fetchBuffer(url, options = {}) {
  const response = await globalThis.fetch(url, options)
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function getHomebrewFormula() {
  if (homebrewFormulaCache) return homebrewFormulaCache
  homebrewFormulaCache = JSON.parse(
    await fetchText('https://formulae.brew.sh/api/formula/tmux.json'),
  )
  return homebrewFormulaCache
}

async function resolveBottleAsset(targetKey) {
  const formula = await getHomebrewFormula()
  const files = formula?.bottle?.stable?.files ?? {}
  const tags = HOMEBREW_BOTTLE_TAGS[targetKey] ?? []
  for (const tag of tags) {
    const file = files[tag]
    if (file?.url) {
      return { url: file.url, version: formula?.versions?.stable ?? null }
    }
  }
  return null
}

async function extractBottleBinary(archivePath, destinationDir) {
  await fs.mkdir(destinationDir, { recursive: true })
  execaSync('tar', ['-xzf', archivePath, '-C', destinationDir], {
    reject: true,
    stdin: 'ignore',
    timeout: 30000,
  })

  const candidate = execaSync(
    '/bin/sh',
    ['-lc', `find "${destinationDir}" -path '*/bin/tmux' -type f | head -n 1`],
    {
      reject: false,
      stdin: 'ignore',
      timeout: 5000,
    },
  ).stdout.trim()

  if (!candidate) {
    throw new Error(`Unable to locate tmux binary in extracted bottle ${archivePath}`)
  }
  return candidate
}

async function fetchBottleBinary(targetKey) {
  const asset = await resolveBottleAsset(targetKey)
  if (!asset?.url) return null

  const downloadDir = path.join(DOWNLOADS_ROOT, targetKey)
  const archivePath = path.join(downloadDir, 'tmux-bottle.tar.gz')
  const extractDir = path.join(downloadDir, 'extract')
  await fs.mkdir(downloadDir, { recursive: true })

  if (!fsSync.existsSync(archivePath)) {
    const token = await getGhcrToken('repository:homebrew/core/tmux:pull')
    const archive = await fetchBuffer(asset.url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    await fs.writeFile(archivePath, archive)
  }

  const binaryPath = await extractBottleBinary(archivePath, extractDir)
  await fs.chmod(binaryPath, 0o755)
  return {
    binaryPath,
    version: asset.version,
  }
}

async function readBundledVersion(targetKey, binaryPath, versionPath) {
  try {
    const existingVersion = (await fs.readFile(versionPath, 'utf8')).trim()
    await fs.access(binaryPath, fsSync.constants.X_OK)
    return existingVersion || readTmuxVersion(binaryPath)
  } catch {
    return null
  }
}

async function ensureTarget(targetKey) {
  const target = TARGETS[targetKey]
  if (!target) {
    throw new Error(`Unsupported tmux bundle target: ${targetKey}`)
  }

  const targetDir = path.join(VENDOR_ROOT, targetKey)
  const binaryPath = path.join(targetDir, target.binary)
  const versionPath = path.join(targetDir, '.version')

  const existingVersion = await readBundledVersion(targetKey, binaryPath, versionPath)
  if (existingVersion && compareTmuxVersions(existingVersion, MINIMUM_VERSION) >= 0) {
    console.log(`[prepare-tmux] ${targetKey} already present (${existingVersion})`)
    return
  }

  const sourceBinary = resolveSourceBinary(targetKey)
  const downloadedBottle = sourceBinary ? null : await fetchBottleBinary(targetKey)
  const resolvedSourceBinary = sourceBinary || downloadedBottle?.binaryPath || null
  if (!resolvedSourceBinary) {
    if (REQUIRE_TARGETS) {
      throw new Error(
        `No tmux binary found for required target ${targetKey}. Set ${getEnvBinaryKey(targetKey)} or install a matching tmux binary before building release artifacts.`,
      )
    }
    console.log(`[prepare-tmux] no source binary found for ${targetKey}; skipping`)
    return
  }
  if (!commandExists(resolvedSourceBinary)) {
    throw new Error(
      `Configured tmux binary is not executable for ${targetKey}: ${resolvedSourceBinary}`,
    )
  }

  const version = downloadedBottle?.version || readTmuxVersion(resolvedSourceBinary)
  if (!version) {
    throw new Error(`Failed to read tmux version from ${resolvedSourceBinary}`)
  }
  if (compareTmuxVersions(version, MINIMUM_VERSION) < 0) {
    throw new Error(
      `tmux ${MINIMUM_VERSION}+ is required for ${targetKey}; found ${version} at ${resolvedSourceBinary}`,
    )
  }
  await fs.mkdir(targetDir, { recursive: true })
  await fs.copyFile(resolvedSourceBinary, binaryPath)
  await fs.chmod(binaryPath, 0o755)
  await fs.writeFile(versionPath, `${version}\n`, 'utf8')
  console.log(`[prepare-tmux] bundled ${targetKey} from ${resolvedSourceBinary} (${version})`)
}

async function main() {
  const targets = resolveRequestedTargets()
  if (targets.length === 0) {
    console.log('[prepare-tmux] no supported targets for this platform; skipping')
    return
  }

  await fs.mkdir(VENDOR_ROOT, { recursive: true })
  for (const target of targets) {
    await ensureTarget(target)
  }
}

await main()
