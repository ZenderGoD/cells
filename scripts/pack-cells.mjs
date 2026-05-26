import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const require = createRequire(import.meta.url)
const nwVersion = '0.109.0'
const nwFlavor = 'normal'
const nwPackageName = 'nw-runtime'
const appName = 'Cells'
const outDir = path.join(root, 'release')
const stagedApp = path.join(outDir, `${appName}.app`)
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const appVersion = packageJson.version || '0.0.0'
const artifactName = `${appName}-${appVersion}-mac-${process.arch}.zip`
const artifactPath = path.join(outDir, artifactName)

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`))
        return
      }
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

async function ensureNwRuntime() {
  const packageJson = require.resolve(`${nwPackageName}/package.json`)
  const nwPackageDir = path.dirname(packageJson)
  const entries = fs.existsSync(nwPackageDir) ? fs.readdirSync(nwPackageDir) : []
  const runtimePrefix = nwFlavor === 'sdk' ? `nwjs-sdk-v${nwVersion}-` : `nwjs-v${nwVersion}-`
  const runtimeDir = entries.find((entry) => entry.startsWith(runtimePrefix))
  if (runtimeDir) return path.join(nwPackageDir, runtimeDir, 'nwjs.app')

  console.log(`Cells runtime ${nwVersion} is missing; running pnpm rebuild ${nwPackageName}`)
  await run('pnpm', ['rebuild', nwPackageName])

  const rebuiltEntries = fs.readdirSync(nwPackageDir)
  const rebuiltRuntimeDir = rebuiltEntries.find((entry) => entry.startsWith(runtimePrefix))
  if (!rebuiltRuntimeDir) throw new Error(`Unable to find Cells runtime ${nwVersion}.`)
  return path.join(nwPackageDir, rebuiltRuntimeDir, 'nwjs.app')
}

async function updatePlist(plistPath) {
  const updates = [
    ['CFBundleDisplayName', appName],
    ['CFBundleName', appName],
    ['CFBundleIdentifier', 'com.cells.app'],
    ['CFBundleIconFile', 'cells.icns'],
  ]
  for (const [key, value] of updates) {
    await run('plutil', ['-replace', key, '-string', value, plistPath])
  }
}

if (process.platform !== 'darwin')
  throw new Error('pack:cells currently stages a macOS .app bundle only.')

await run('pnpm', ['build:cells'])
const nwApp = await ensureNwRuntime()

fs.mkdirSync(outDir, { recursive: true })
fs.rmSync(stagedApp, { recursive: true, force: true })
fs.rmSync(artifactPath, { force: true })
fs.cpSync(nwApp, stagedApp, { recursive: true })

const resourcesDir = path.join(stagedApp, 'Contents', 'Resources')
const appNwDir = path.join(resourcesDir, 'app.nw')
fs.rmSync(appNwDir, { recursive: true, force: true })
fs.cpSync(path.join(root, 'dist-cells'), appNwDir, { recursive: true })
fs.copyFileSync(path.join(root, 'resources', 'icon.icns'), path.join(resourcesDir, 'cells.icns'))

await updatePlist(path.join(stagedApp, 'Contents', 'Info.plist'))
await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stagedApp, artifactPath])
await run('node', ['scripts/generate-cells-update-metadata.mjs'])

console.log(`Staged ${appName} at ${path.relative(root, stagedApp)}`)
console.log(`Created artifact ${path.relative(root, artifactPath)}`)
console.log(`Created updater metadata release/latest-mac.yml`)
console.log(`Run it with: open ${JSON.stringify(stagedApp)}`)
