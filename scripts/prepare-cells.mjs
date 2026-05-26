import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = process.cwd()
const require = createRequire(import.meta.url)
const runtimeDir = path.join(root, 'cells-runtime')
const outDir = path.join(root, 'dist-cells')
const resourcesDir = path.join(root, 'resources')
const rootPackageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function copyEntry(src, dest) {
  if (!fs.existsSync(src)) return false
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
  })
  return true
}

function copyNodePtyRuntime() {
  const packageJsonPath = require.resolve('node-pty/package.json')
  const packageDir = path.dirname(packageJsonPath)
  const destDir = path.join(outDir, 'node_modules', 'node-pty')
  const platformPrebuildDir = `darwin-${process.arch}`

  fs.rmSync(destDir, { recursive: true, force: true })
  copyEntry(path.join(packageDir, 'package.json'), path.join(destDir, 'package.json'))
  copyEntry(path.join(packageDir, 'lib'), path.join(destDir, 'lib'))
  copyEntry(path.join(packageDir, 'typings'), path.join(destDir, 'typings'))
  copyEntry(path.join(packageDir, 'build', 'Release'), path.join(destDir, 'build', 'Release'))
  copyEntry(
    path.join(packageDir, 'prebuilds', platformPrebuildDir),
    path.join(destDir, 'prebuilds', platformPrebuildDir),
  )

  for (const helper of [
    path.join(destDir, 'build', 'Release', 'spawn-helper'),
    path.join(destDir, 'prebuilds', platformPrebuildDir, 'spawn-helper'),
  ]) {
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
  }
}

const runtimePackageJson = JSON.parse(
  fs.readFileSync(path.join(runtimeDir, 'cells-package.json'), 'utf8'),
)
runtimePackageJson.version = rootPackageJson.version || runtimePackageJson.version || '0.0.0'
fs.writeFileSync(
  path.join(outDir, 'package.json'),
  `${JSON.stringify(runtimePackageJson, null, 2)}\n`,
)
fs.copyFileSync(path.join(outDir, 'cells-runtime', 'cells.html'), path.join(outDir, 'cells.html'))
fs.copyFileSync(path.join(resourcesDir, 'icon.png'), path.join(outDir, 'icon.png'))
fs.copyFileSync(path.join(resourcesDir, 'icon.icns'), path.join(outDir, 'icon.icns'))
copyNodePtyRuntime()

for (const entry of ['test-extensions']) {
  const src = path.join(runtimeDir, entry)
  const dest = path.join(outDir, entry)
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(src, dest, { recursive: true })
}

console.log(`Prepared Cells app at ${path.relative(root, outDir)}`)
