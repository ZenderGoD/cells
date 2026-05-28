import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { URL } from 'node:url'

const root = process.cwd()
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = packageJson.version
const releaseDir = path.join(root, 'release')
const arch = process.arch
const artifactName = `Cells-${version}-mac-${arch}.zip`
const artifactPath = path.join(releaseDir, artifactName)
const metadataPath = path.join(releaseDir, 'latest-mac.yml')

if (!version) throw new Error('package.json version is missing.')
if (!fs.existsSync(artifactPath)) throw new Error(`Missing release artifact: ${artifactPath}`)

function resolveRepositoryPath() {
  const envRepository = process.env.GITHUB_REPOSITORY?.trim()
  if (envRepository) return envRepository.replace(/^\/+|\/+$/g, '')

  const repositoryUrl =
    typeof packageJson.repository === 'string'
      ? packageJson.repository
      : packageJson.repository?.url
  const match = String(repositoryUrl ?? '').match(/github\.com[:/]([^/\s]+\/[^/\s.#]+)(?:\.git)?/)
  if (match) return match[1]

  return 'xrehpicx/cells'
}

function resolveArtifactUrl() {
  const baseUrl = process.env.CELLS_UPDATE_BASE_URL?.trim()
  if (baseUrl) {
    return new URL(artifactName, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
  }

  // Older NW builds resolved relative paths against GitHub's signed CDN URL for
  // latest-mac.yml. Publish an absolute browser download URL so they can update.
  const serverUrl = (process.env.GITHUB_SERVER_URL?.trim() || 'https://github.com').replace(
    /\/+$/,
    '',
  )
  const releaseTag = process.env.RELEASE_TAG?.trim() || `v${version}`
  return `${serverUrl}/${resolveRepositoryPath()}/releases/download/${encodeURIComponent(
    releaseTag,
  )}/${encodeURIComponent(artifactName)}`
}

const artifact = fs.readFileSync(artifactPath)
const sha512 = crypto.createHash('sha512').update(artifact).digest('base64')
const size = fs.statSync(artifactPath).size
const releaseDate = new Date().toISOString()
const artifactUrl = resolveArtifactUrl()

const metadata = [
  `version: ${version}`,
  'files:',
  `  - url: ${artifactUrl}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${artifactUrl}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  '',
].join('\n')

fs.writeFileSync(metadataPath, metadata)
console.log(`Created update metadata ${path.relative(root, metadataPath)}`)
