import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const require = createRequire(import.meta.url)
const appDir = path.join(root, 'dist-cells')
const nwVersion = '0.109.0'
const nwFlavor = 'normal'
const nwPackageName = 'nw-runtime'
const devAppName = 'Cells Dev'
const devAppPath = path.join(root, 'release', `${devAppName}.app`)
const realHomeDir = os.userInfo().homedir || process.env.HOME || ''
const devRoot = process.env.CELLS_DEV_ROOT
  ? path.resolve(process.env.CELLS_DEV_ROOT)
  : path.join(realHomeDir, '.cells-dev')
const devHomeDir = path.join(devRoot, 'home')
const devDataDir = path.join(devRoot, 'data')
const devConfigDir = path.join(devRoot, 'config')
const devChromiumProfileDir = path.join(devRoot, 'chromium')
const productionCellsDir = path.join(realHomeDir, '.cells')
const devCellsDir = path.join(devHomeDir, '.cells')

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

function extensionDirsFromEnv() {
  const envDirs = (process.env.CELLS_NW_EXTENSIONS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry))
  return [...new Set([...envDirs, ...registeredExtensionDirs()])]
}

function registeredExtensionDirs() {
  const metaPath = path.join(devCellsDir, 'extensions.json')
  try {
    const state = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    if (!Array.isArray(state.extensions)) return []
    return state.extensions
      .map((extension) =>
        typeof extension?.sourceUrl === 'string' ? path.resolve(extension.sourceUrl) : null,
      )
      .filter((dir) => dir && fs.existsSync(path.join(dir, 'manifest.json')))
  } catch {
    return []
  }
}

function copyIfSourceIsNewer(source, target) {
  if (!fs.existsSync(source)) return false
  const sourceStat = fs.statSync(source)
  const targetStat = fs.existsSync(target) ? fs.statSync(target) : null
  if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs) return false
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (targetStat) {
    fs.copyFileSync(target, `${target}.bak-nw-dev-${Date.now()}`)
  }
  fs.copyFileSync(source, target)
  return true
}

function copyDirectoryIfTargetMissing(source, target) {
  if (!fs.existsSync(source) || fs.existsSync(target)) return false
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(source, target, { recursive: true })
  return true
}

function syncProductionCellsDataForDev() {
  if (process.env.CELLS_NW_SKIP_DATA_SYNC === '1') return
  if (!fs.existsSync(productionCellsDir)) return

  const copied = []
  if (
    copyIfSourceIsNewer(
      path.join(productionCellsDir, 'state.json'),
      path.join(devCellsDir, 'state.json'),
    )
  ) {
    copied.push('state.json')
  }
  if (
    copyIfSourceIsNewer(
      path.join(productionCellsDir, 'extensions.json'),
      path.join(devCellsDir, 'extensions.json'),
    )
  ) {
    copied.push('extensions.json')
  }
  if (
    copyDirectoryIfTargetMissing(
      path.join(productionCellsDir, 'extensions'),
      path.join(devCellsDir, 'extensions'),
    )
  ) {
    copied.push('extensions/')
  }

  if (copied.length > 0) {
    console.log(`Synced Cells data into dev home: ${copied.join(', ')}`)
  }
}

async function ensureNwRuntime() {
  const packageJson = require.resolve(`${nwPackageName}/package.json`)
  const nwPackageDir = path.dirname(packageJson)
  const entries = fs.existsSync(nwPackageDir) ? fs.readdirSync(nwPackageDir) : []
  const runtimePrefix = nwFlavor === 'sdk' ? `nwjs-sdk-v${nwVersion}-` : `nwjs-v${nwVersion}-`
  const runtimeDir = entries.find((entry) => entry.startsWith(runtimePrefix))
  if (runtimeDir) return path.join(nwPackageDir, runtimeDir, 'nwjs.app')

  console.log(`NW.js ${nwVersion} ${nwFlavor} runtime is missing; running pnpm rebuild ${nwPackageName}`)
  await run('pnpm', ['rebuild', nwPackageName])

  const rebuiltEntries = fs.readdirSync(nwPackageDir)
  const rebuiltRuntimeDir = rebuiltEntries.find((entry) => entry.startsWith(runtimePrefix))
  if (!rebuiltRuntimeDir) throw new Error(`Unable to find NW.js ${nwVersion} ${nwFlavor} runtime.`)
  return path.join(nwPackageDir, rebuiltRuntimeDir, 'nwjs.app')
}

function writeRuntimeManifest(extensionDirs) {
  const manifestPath = path.join(appDir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const baseArgs = String(manifest['chromium-args'] ?? '')
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !entry.startsWith('--load-extension='))

  const addArg = (arg) => {
    if (!baseArgs.includes(arg)) baseArgs.push(arg)
  }

  if (process.platform === 'darwin' && !baseArgs.includes('--use-mock-keychain')) {
    baseArgs.push('--use-mock-keychain')
  }

  baseArgs
    .filter((entry) => entry.startsWith('--user-data-dir='))
    .forEach((entry) => {
      const index = baseArgs.indexOf(entry)
      if (index >= 0) baseArgs.splice(index, 1)
    })

  fs.mkdirSync(devChromiumProfileDir, { recursive: true })
  baseArgs.push(`--user-data-dir=${devChromiumProfileDir}`)

  addArg('--disable-background-timer-throttling')
  addArg('--disable-renderer-backgrounding')
  addArg('--disable-backgrounding-occluded-windows')

  if (extensionDirs.length > 0) {
    baseArgs.push(`--load-extension=${extensionDirs.join(',')}`)
  }

  manifest['chromium-args'] = baseArgs.join(' ')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function updatePlist(plistPath) {
  const updates = [
    ['CFBundleDisplayName', devAppName],
    ['CFBundleName', devAppName],
    ['CFBundleIdentifier', 'com.cells.app.dev'],
    ['CFBundleIconFile', 'cells.icns'],
  ]
  for (const [key, value] of updates) {
    await run('plutil', ['-replace', key, '-string', value, plistPath])
  }
}

async function stageMacDevApp(nwAppPath) {
  if (process.platform !== 'darwin') return null

  fs.mkdirSync(path.dirname(devAppPath), { recursive: true })
  fs.rmSync(devAppPath, { recursive: true, force: true })
  fs.cpSync(nwAppPath, devAppPath, { recursive: true })

  const resourcesDir = path.join(devAppPath, 'Contents', 'Resources')
  const appNwDir = path.join(resourcesDir, 'app.nw')
  fs.rmSync(appNwDir, { recursive: true, force: true })
  fs.cpSync(appDir, appNwDir, { recursive: true })
  fs.copyFileSync(path.join(root, 'resources', 'icon.icns'), path.join(resourcesDir, 'cells.icns'))
  await updatePlist(path.join(devAppPath, 'Contents', 'Info.plist'))

  return path.join(devAppPath, 'Contents', 'MacOS', 'nwjs')
}

await run('pnpm', ['build:cells'])
syncProductionCellsDataForDev()
const nwAppPath = await ensureNwRuntime()

const extensionDirs = extensionDirsFromEnv()
writeRuntimeManifest(extensionDirs)

const devExecutable = await stageMacDevApp(nwAppPath)

console.log('Launching Cells')
console.log(`App: ${devExecutable ? devAppPath : appDir}`)
console.log(`Extensions: ${extensionDirs.length ? extensionDirs.join(', ') : '(none)'}`)

await run(
  devExecutable ?? 'pnpm',
  devExecutable ? [] : ['exec', 'nw', '--version', nwVersion, '--flavor', nwFlavor, appDir],
  {
    env: {
      ...process.env,
      CELLS_DEV_ROOT: devRoot,
      CELLS_HOME_DIR: devHomeDir,
      CELLS_DATA_DIR: devDataDir,
      CELLS_STATE_FILE: path.join(devHomeDir, '.cells', 'state.json'),
      CELLS_REAL_HOME: realHomeDir,
      CELLS_REAL_XDG_CONFIG_HOME:
        process.env.XDG_CONFIG_HOME || path.join(realHomeDir, '.config'),
      CELLS_REAL_XDG_DATA_HOME:
        process.env.XDG_DATA_HOME || path.join(realHomeDir, '.local', 'share'),
      CELLS_REAL_XDG_CACHE_HOME:
        process.env.XDG_CACHE_HOME || path.join(realHomeDir, '.cache'),
      CELLS_REAL_XDG_STATE_HOME:
        process.env.XDG_STATE_HOME || path.join(realHomeDir, '.local', 'state'),
      HOME: devHomeDir,
      XDG_CONFIG_HOME: devConfigDir,
      XDG_DATA_HOME: devDataDir,
      CELLS_NW_CHROMIUM_PROFILE_DIR: devChromiumProfileDir,
      CELLS_REPO_ROOT: root,
      CELLS_NW_EXTENSION_DIRS: extensionDirs.join(path.delimiter),
    },
  },
)
