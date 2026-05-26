import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

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

const artifact = fs.readFileSync(artifactPath)
const sha512 = crypto.createHash('sha512').update(artifact).digest('base64')
const size = fs.statSync(artifactPath).size
const releaseDate = new Date().toISOString()

const metadata = [
  `version: ${version}`,
  'files:',
  `  - url: ${artifactName}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${artifactName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  '',
].join('\n')

fs.writeFileSync(metadataPath, metadata)
console.log(`Created update metadata ${path.relative(root, metadataPath)}`)
