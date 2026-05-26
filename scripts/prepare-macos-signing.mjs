import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cscLink = process.env.CSC_LINK?.trim()
const cscPassword = process.env.CSC_KEY_PASSWORD ?? ''
const githubEnv = process.env.GITHUB_ENV

function appendGithubEnv(key, value) {
  if (!githubEnv || !value) return
  fs.appendFileSync(githubEnv, `${key}=${value}\n`)
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function resolveCertificatePath(tmpDir) {
  if (!cscLink) return null

  if (/^https?:\/\//i.test(cscLink)) {
    const certPath = path.join(tmpDir, 'certificate.p12')
    execFileSync('curl', ['-fsSL', cscLink, '-o', certPath], { stdio: 'inherit' })
    return certPath
  }

  if (cscLink.startsWith('file://')) {
    return new URL(cscLink).pathname
  }

  if (fs.existsSync(cscLink)) {
    return cscLink
  }

  const certPath = path.join(tmpDir, 'certificate.p12')
  const base64 = cscLink.replace(/^data:[^,]+,/, '').replace(/\s/g, '')
  fs.writeFileSync(certPath, Buffer.from(base64, 'base64'))
  return certPath
}

function findIdentity(keychainPath) {
  const output = run('security', ['find-identity', '-v', '-p', 'codesigning', keychainPath])
  const lines = output.split('\n').filter(Boolean)
  const preferred = lines.find((line) => line.includes('Developer ID Application')) ?? lines[0]
  const match = preferred?.match(/\b([A-F0-9]{40})\b/i)
  return match?.[1] ?? null
}

if (!cscLink) {
  console.log('CSC_LINK is not set; Cells will be ad-hoc signed for local packaging.')
  process.exit(0)
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cells-signing-'))
const keychainPath = path.join(tmpDir, 'cells-build.keychain-db')
const keychainPassword = cryptoRandom()
const certPath = resolveCertificatePath(tmpDir)

if (!certPath || !fs.existsSync(certPath)) {
  throw new Error('Unable to resolve CSC_LINK certificate.')
}

run('security', ['create-keychain', '-p', keychainPassword, keychainPath])
run('security', ['set-keychain-settings', '-lut', '21600', keychainPath])
run('security', ['unlock-keychain', '-p', keychainPassword, keychainPath])
run('security', [
  'import',
  certPath,
  '-k',
  keychainPath,
  '-P',
  cscPassword,
  '-T',
  '/usr/bin/codesign',
  '-T',
  '/usr/bin/security',
])
run('security', [
  'set-key-partition-list',
  '-S',
  'apple-tool:,apple:,codesign:',
  '-s',
  '-k',
  keychainPassword,
  keychainPath,
])

const existingKeychains = run('security', ['list-keychains', '-d', 'user'])
  .split('\n')
  .map((line) => line.trim().replace(/^"|"$/g, ''))
  .filter(Boolean)
run('security', ['list-keychains', '-d', 'user', '-s', keychainPath, ...existingKeychains])

const identity = findIdentity(keychainPath)
if (!identity) {
  throw new Error('No code signing identity found after importing CSC_LINK.')
}

appendGithubEnv('CELLS_CODESIGN_IDENTITY', identity)
appendGithubEnv('CELLS_CODESIGN_KEYCHAIN', keychainPath)
console.log(`Imported macOS signing identity ${identity}`)

function cryptoRandom() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
