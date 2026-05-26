import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const runtimeDir = path.join(root, 'cells-runtime')
const outDir = path.join(root, 'dist-cells')
const resourcesDir = path.join(root, 'resources')

fs.copyFileSync(path.join(runtimeDir, 'cells-package.json'), path.join(outDir, 'package.json'))
fs.copyFileSync(path.join(outDir, 'cells-runtime', 'cells.html'), path.join(outDir, 'cells.html'))
fs.copyFileSync(path.join(resourcesDir, 'icon.png'), path.join(outDir, 'icon.png'))
fs.copyFileSync(path.join(resourcesDir, 'icon.icns'), path.join(outDir, 'icon.icns'))

for (const entry of ['test-extensions']) {
  const src = path.join(runtimeDir, entry)
  const dest = path.join(outDir, entry)
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(src, dest, { recursive: true })
}

console.log(`Prepared Cells app at ${path.relative(root, outDir)}`)
