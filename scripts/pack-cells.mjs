import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
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
const dmgName = `${appName}-${appVersion}-mac-${process.arch}.dmg`
const dmgPath = path.join(outDir, dmgName)
const dmgReadWritePath = path.join(outDir, `${appName}-${appVersion}-mac-${process.arch}.rw.dmg`)
const dmgBackgroundPath = path.join(root, 'resources', 'dmg', 'cells-dmg-background.png')
const entitlementsPath = path.join(root, 'resources', 'mac-entitlements.plist')
const requireNotarization = process.env.CELLS_REQUIRE_NOTARIZATION === '1'
const machOMagicValues = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
])

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

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: process.platform === 'win32',
      ...options,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
      process.stdout.write(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      const output = `${stdout}\n${stderr}`.trim()
      if (signal) {
        const error = new Error(`${command} exited with signal ${signal}`)
        error.output = output
        reject(error)
        return
      }
      if (code === 0) {
        resolve({ stdout, stderr, output })
        return
      }
      const error = new Error(`${command} exited with code ${code}`)
      error.output = output
      reject(error)
    })
  })
}

function appleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function printNotaryLog(submissionId, profile) {
  if (!submissionId) return
  console.log(`Fetching Apple notary log for submission ${submissionId}.`)
  await run('xcrun', ['notarytool', 'log', submissionId, '--keychain-profile', profile]).catch(
    (error) => {
      console.error(`Unable to fetch Apple notary log: ${error.message}`)
    },
  )
}

async function submitForNotarization(filePath, profile, label) {
  const { output } = await runCapture('xcrun', [
    'notarytool',
    'submit',
    filePath,
    '--keychain-profile',
    profile,
    '--wait',
    '--output-format',
    'json',
  ])
  const result = JSON.parse(output)
  console.log(`Apple notarization ${label}: ${result.status} (${result.id})`)
  if (result.status !== 'Accepted') {
    await printNotaryLog(result.id, profile)
    throw new Error(`Apple notarization failed for ${label}: ${result.status}`)
  }
  return result
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
    ['CFBundleShortVersionString', appVersion],
    ['CFBundleVersion', appVersion],
  ]
  for (const [key, value] of updates) {
    await run('plutil', ['-replace', key, '-string', value, plistPath])
  }
  await run('plutil', ['-replace', 'LSFileQuarantineEnabled', '-bool', 'false', plistPath])
}

function isMachO(filePath) {
  const buffer = Buffer.alloc(4)
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const bytesRead = fs.readSync(fd, buffer, 0, 4, 0)
    if (bytesRead < 4) return false
    return (
      machOMagicValues.has(buffer.readUInt32BE(0)) || machOMagicValues.has(buffer.readUInt32LE(0))
    )
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function collectMachOFiles(dir) {
  const files = []
  const stack = [dir]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }
      if (entry.isFile() && isMachO(entryPath)) {
        files.push(entryPath)
      }
    }
  }

  return files.sort((a, b) => b.length - a.length || a.localeCompare(b))
}

async function signNestedMachOFiles(identity, keychain) {
  if (identity === '-') return

  const files = collectMachOFiles(stagedApp)
  for (const file of files) {
    const args = ['--force', '--sign', identity, '--timestamp', '--options', 'runtime']
    if (keychain) args.push('--keychain', keychain)
    args.push(file)
    await run('codesign', args)
  }

  console.log(`Signed ${files.length} nested Mach-O files with identity ${identity}.`)
}

async function signApp() {
  const identity = process.env.CELLS_CODESIGN_IDENTITY?.trim() || '-'
  const keychain = process.env.CELLS_CODESIGN_KEYCHAIN?.trim()
  const args = ['--force', '--deep', '--sign', identity]

  if (identity !== '-') {
    await signNestedMachOFiles(identity, keychain)
    args.push('--timestamp', '--options', 'runtime', '--entitlements', entitlementsPath)
    if (keychain) args.push('--keychain', keychain)
  }

  args.push(stagedApp)
  await run('codesign', args)
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', stagedApp])
  console.log(
    identity === '-'
      ? 'Ad-hoc signed Cells.app for local packaging.'
      : `Signed Cells.app with identity ${identity}.`,
  )
}

async function notarizeAppIfConfigured() {
  const profile = process.env.CELLS_NOTARY_PROFILE?.trim()
  const identity = process.env.CELLS_CODESIGN_IDENTITY?.trim() || '-'
  if (!profile || identity === '-') {
    if (requireNotarization) {
      throw new Error(
        'CELLS_NOTARY_PROFILE and CELLS_CODESIGN_IDENTITY are required for this Cells release build.',
      )
    }
    console.log(
      'Skipping notarization; CELLS_NOTARY_PROFILE or signing identity is not configured.',
    )
    return
  }

  const notaryZip = path.join(outDir, `${appName}-${appVersion}-notary.zip`)
  fs.rmSync(notaryZip, { force: true })
  await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stagedApp, notaryZip])
  await submitForNotarization(notaryZip, profile, `${appName}.app`)
  await run('xcrun', ['stapler', 'staple', stagedApp])
  await run('xcrun', ['stapler', 'validate', stagedApp])
  fs.rmSync(notaryZip, { force: true })
}

async function createDmg() {
  const dmgRoot = path.join(outDir, 'dmg-root')
  fs.rmSync(dmgRoot, { recursive: true, force: true })
  fs.rmSync(dmgPath, { force: true })
  fs.rmSync(dmgReadWritePath, { force: true })
  fs.mkdirSync(dmgRoot, { recursive: true })
  fs.mkdirSync(path.join(dmgRoot, '.background'), { recursive: true })
  fs.cpSync(stagedApp, path.join(dmgRoot, `${appName}.app`), {
    recursive: true,
    verbatimSymlinks: true,
  })
  fs.symlinkSync('/Applications', path.join(dmgRoot, 'Applications'))
  fs.copyFileSync(dmgBackgroundPath, path.join(dmgRoot, '.background', 'cells-dmg-background.png'))
  await run('SetFile', ['-a', 'V', path.join(dmgRoot, '.background')]).catch(() => {})
  await run('hdiutil', [
    'create',
    '-volname',
    appName,
    '-srcfolder',
    dmgRoot,
    '-ov',
    '-format',
    'UDRW',
    dmgReadWritePath,
  ])
  let attached = false
  try {
    await run('hdiutil', ['attach', dmgReadWritePath, '-readwrite', '-noverify', '-noautoopen'])
    attached = true
    await run('osascript', [
      '-e',
      `
tell application "Finder"
  set volumePath to POSIX file "/Volumes/${appleScriptString(appName)}"
  open volumePath
  delay 0.4
  set theDisk to disk "${appleScriptString(appName)}"
  set theWindow to front Finder window
  set current view of theWindow to icon view
  set toolbar visible of theWindow to false
  set statusbar visible of theWindow to false
  set bounds of theWindow to {120, 120, 840, 560}
  set viewOptions to icon view options of theWindow
  set arrangement of viewOptions to not arranged
  set icon size of viewOptions to 104
  set background picture of viewOptions to POSIX file "/Volumes/${appleScriptString(appName)}/.background/cells-dmg-background.png"
  set position of item "Cells.app" of theDisk to {180, 238}
  set position of item "Applications" of theDisk to {540, 238}
  delay 0.2
  close theWindow
end tell
`,
    ])
  } finally {
    if (attached) await run('hdiutil', ['detach', `/Volumes/${appName}`, '-quiet']).catch(() => {})
    fs.rmSync(dmgRoot, { recursive: true, force: true })
  }
  await run('hdiutil', ['convert', dmgReadWritePath, '-format', 'UDZO', '-o', dmgPath, '-ov'])
  fs.rmSync(dmgReadWritePath, { force: true })
}

async function signDmgIfPossible() {
  const identity = process.env.CELLS_CODESIGN_IDENTITY?.trim() || '-'
  const keychain = process.env.CELLS_CODESIGN_KEYCHAIN?.trim()
  if (identity === '-') return

  const args = ['--force', '--sign', identity, '--timestamp']
  if (keychain) args.push('--keychain', keychain)
  args.push(dmgPath)
  await run('codesign', args)
  await run('codesign', ['--verify', '--verbose=2', dmgPath])
}

async function notarizeDmgIfConfigured() {
  const profile = process.env.CELLS_NOTARY_PROFILE?.trim()
  const identity = process.env.CELLS_CODESIGN_IDENTITY?.trim() || '-'
  if (!profile || identity === '-') {
    if (requireNotarization) {
      throw new Error(
        'CELLS_NOTARY_PROFILE and CELLS_CODESIGN_IDENTITY are required to notarize the Cells DMG.',
      )
    }
    return
  }

  await submitForNotarization(dmgPath, profile, `${appName}.dmg`)
  await run('xcrun', ['stapler', 'staple', dmgPath])
  await run('xcrun', ['stapler', 'validate', dmgPath])
}

async function assessGatekeeperIfRequired() {
  if (!requireNotarization) return
  await run('spctl', ['-a', '-vv', '--type', 'execute', stagedApp])
  await run('spctl', [
    '-a',
    '-vv',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    dmgPath,
  ])
}

if (process.platform !== 'darwin')
  throw new Error('pack:cells currently stages a macOS .app bundle only.')

await run('pnpm', ['build:cells'])
const nwApp = await ensureNwRuntime()

fs.mkdirSync(outDir, { recursive: true })
fs.rmSync(stagedApp, { recursive: true, force: true })
fs.rmSync(artifactPath, { force: true })
fs.rmSync(dmgPath, { force: true })
fs.cpSync(nwApp, stagedApp, { recursive: true, verbatimSymlinks: true })

const resourcesDir = path.join(stagedApp, 'Contents', 'Resources')
const appNwDir = path.join(resourcesDir, 'app.nw')
fs.rmSync(appNwDir, { recursive: true, force: true })
fs.cpSync(path.join(root, 'dist-cells'), appNwDir, { recursive: true })
fs.copyFileSync(path.join(root, 'resources', 'icon.icns'), path.join(resourcesDir, 'cells.icns'))

await updatePlist(path.join(stagedApp, 'Contents', 'Info.plist'))
await signApp()
await notarizeAppIfConfigured()
await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stagedApp, artifactPath])
await run('node', ['scripts/generate-cells-update-metadata.mjs'])
await createDmg()
await signDmgIfPossible()
await notarizeDmgIfConfigured()
await run('hdiutil', ['verify', dmgPath])
await assessGatekeeperIfRequired()

console.log(`Staged ${appName} at ${path.relative(root, stagedApp)}`)
console.log(`Created artifact ${path.relative(root, artifactPath)}`)
console.log(`Created artifact ${path.relative(root, dmgPath)}`)
console.log(`Created updater metadata release/latest-mac.yml`)
console.log(`Run it with: open ${JSON.stringify(stagedApp)}`)
