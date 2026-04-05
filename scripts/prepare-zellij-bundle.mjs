import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import zellijBundle from '../config/zellij-bundle.json' with { type: 'json' }

const VERSION = zellijBundle.version
const REPO_BASE = `https://github.com/zellij-org/zellij/releases/download/v${VERSION}`
const ROOT = process.cwd()
const VENDOR_ROOT = path.join(ROOT, 'resources', 'vendor', 'zellij')

const TARGETS = {
  'darwin-arm64': {
    asset: 'zellij-no-web-aarch64-apple-darwin.tar.gz',
    checksum: 'zellij-no-web-aarch64-apple-darwin.sha256sum',
    binary: 'zellij',
  },
  'darwin-x64': {
    asset: 'zellij-no-web-x86_64-apple-darwin.tar.gz',
    checksum: 'zellij-no-web-x86_64-apple-darwin.sha256sum',
    binary: 'zellij',
  },
  'linux-arm64': {
    asset: 'zellij-no-web-aarch64-unknown-linux-musl.tar.gz',
    checksum: 'zellij-no-web-aarch64-unknown-linux-musl.sha256sum',
    binary: 'zellij',
  },
  'linux-x64': {
    asset: 'zellij-no-web-x86_64-unknown-linux-musl.tar.gz',
    checksum: 'zellij-no-web-x86_64-unknown-linux-musl.sha256sum',
    binary: 'zellij',
  },
}

function resolveRequestedTargets() {
  const requested = process.env.CELLS_ZELLIJ_TARGETS?.trim()
  if (requested) {
    return requested
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  }

  if (process.platform === 'darwin') {
    return ['darwin-arm64', 'darwin-x64']
  }
  if (process.platform === 'linux') {
    return [process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64']
  }
  return []
}

async function fetchText(url) {
  const response = await globalThis.fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
  }
  return await response.text()
}

async function fetchBuffer(url) {
  const response = await globalThis.fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

function parseChecksumFile(text, assetName) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [sha, name] = trimmed.split(/\s+/, 2)
    if (!name) return sha
    const basename = name.split('/').pop()
    if (basename === 'zellij' || basename === 'zellij.exe' || name.includes(assetName)) return sha
  }
  throw new Error(`Could not find checksum for ${assetName}`)
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function ensureTarget(targetKey) {
  const target = TARGETS[targetKey]
  if (!target) {
    throw new Error(`Unsupported Zellij bundle target: ${targetKey}`)
  }

  const targetDir = path.join(VENDOR_ROOT, targetKey)
  const binaryPath = path.join(targetDir, target.binary)
  const versionPath = path.join(targetDir, '.version')

  try {
    const existingVersion = (await fs.readFile(versionPath, 'utf8')).trim()
    await fs.access(binaryPath, fsSync.constants.X_OK)
    if (existingVersion === VERSION) {
      console.log(`[prepare-zellij] ${targetKey} already present (${VERSION})`)
      return
    }
  } catch {}

  await fs.mkdir(targetDir, { recursive: true })

  const checksumText = await fetchText(`${REPO_BASE}/${target.checksum}`)
  const expectedSha = parseChecksumFile(checksumText, target.asset)
  const archiveBuffer = await fetchBuffer(`${REPO_BASE}/${target.asset}`)

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cells-zellij-'))
  const archivePath = path.join(tempDir, target.asset)
  try {
    await fs.writeFile(archivePath, archiveBuffer)
    execFileSync('tar', ['-xzf', archivePath, '-C', tempDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    })

    const extractedBinary = path.join(tempDir, target.binary)
    const extractedSha = sha256(await fs.readFile(extractedBinary))
    if (extractedSha !== expectedSha) {
      throw new Error(
        `Checksum mismatch for ${target.asset}: expected binary sha ${expectedSha}, got ${extractedSha}`,
      )
    }
    await fs.copyFile(extractedBinary, binaryPath)
    await fs.chmod(binaryPath, 0o755)
    await fs.writeFile(versionPath, `${VERSION}\n`, 'utf8')
    console.log(`[prepare-zellij] bundled ${targetKey} (${VERSION})`)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

async function main() {
  const targets = resolveRequestedTargets()
  if (targets.length === 0) {
    console.log('[prepare-zellij] no supported targets for this platform; skipping')
    return
  }

  await fs.mkdir(VENDOR_ROOT, { recursive: true })
  for (const target of targets) {
    await ensureTarget(target)
  }
}

await main()
