import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const home = os.homedir()
const statePath = path.join(home, '.cells', 'state.json')
const userDataDir = path.join(home, 'Library', 'Application Support', 'Cells')
const nextFont = '"GeistMono NFM", "Geist Mono", monospace'

if (!fs.existsSync(statePath)) {
  throw new Error(`Missing state file: ${statePath}`)
}

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
state.fontFamily = nextFont
if (Array.isArray(state.projects)) {
  state.projects = state.projects.map((project) => {
    const next = { ...project }
    delete next.fontFamily
    delete next.fontSize
    delete next.terminalTheme
    return next
  })
}

const backupPath = `${statePath}.bak-repair-${Date.now()}`
fs.copyFileSync(statePath, backupPath)
fs.writeFileSync(statePath, JSON.stringify(state, null, 2))

try {
  execFileSync('osascript', ['-e', 'quit app "Cells"'], { stdio: 'ignore' })
} catch {}

for (const args of [
  ['-x', 'Cells'],
  ['-f', '/Applications/Cells.app/Contents/Resources/app.asar/dist-electron/pty-daemon.js'],
  ['-f', '/Applications/Cells.app/Contents/Resources/vendor/tmux/darwin-arm64/tmux'],
  ['-f', '/Applications/Cells.app/Contents/Resources/vendor/zellij/darwin-arm64/zellij'],
]) {
  try {
    execFileSync('pkill', args, { stdio: 'ignore' })
  } catch {}
}

for (const entry of [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'blob_storage',
  'Session Storage',
  'Shared Dictionary',
  'Network Persistent State',
]) {
  fs.rmSync(path.join(userDataDir, entry), { recursive: true, force: true })
}

console.log(`Backed up state to ${backupPath}`)
console.log('Repaired terminal font settings and cleared installed app caches.')
