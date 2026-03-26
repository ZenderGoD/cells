/**
 * Extension lifecycle — install, uninstall, enable/disable.
 *
 * Orchestrates the CRX pipeline, compatibility patching, metadata
 * persistence, and session management for high-level operations
 * called from IPC handlers.
 */

import path from 'path'
import fs from 'fs'
import { EXTENSIONS_DIR } from './paths'
import {
  parseExtensionInput as parseInput,
  downloadCrx,
  extractCrx,
  getCrxDownloadUrl,
} from './crx'
import { sanitizeManifest, injectApiStubs } from './compat'
import {
  readExtensionsMeta,
  writeExtensionsMeta,
  buildExtensionMeta,
  type ExtensionMeta,
} from './metadata'
import { unloadExtensionFromAllSessions } from './session'

export { parseInput as parseExtensionInput }

/**
 * Download, extract, patch, and register a Chrome extension.
 * Returns metadata for the installed extension.
 */
export async function installExtension(input: string): Promise<ExtensionMeta> {
  const extensionId = parseInput(input)
  if (!extensionId) throw new Error('Invalid extension ID or Chrome Web Store URL')

  fs.mkdirSync(EXTENSIONS_DIR, { recursive: true })

  // Download CRX from Google's update2 endpoint
  const crxPath = await downloadCrx(extensionId)

  // Extract (CRX header → ZIP → unpacked directory)
  const destDir = path.join(EXTENSIONS_DIR, extensionId)
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true })
  fs.mkdirSync(destDir, { recursive: true })

  try {
    extractCrx(crxPath, destDir)
  } finally {
    try {
      fs.unlinkSync(crxPath)
    } catch {}
  }

  if (!fs.existsSync(path.join(destDir, 'manifest.json'))) {
    fs.rmSync(destDir, { recursive: true })
    throw new Error('Extension has no manifest.json')
  }

  // Patch for Electron compatibility
  sanitizeManifest(destDir)
  injectApiStubs(destDir)

  // Persist metadata
  const sourceUrl = getCrxDownloadUrl(extensionId)
  const meta = buildExtensionMeta(extensionId, destDir, sourceUrl)

  const state = readExtensionsMeta()
  state.extensions = state.extensions.filter((e) => e.id !== extensionId)
  state.extensions.push(meta)
  writeExtensionsMeta(state)

  return meta
}

/** Remove an extension completely — files, sessions, metadata. */
export function uninstallExtension(extensionId: string): void {
  const extDir = path.join(EXTENSIONS_DIR, extensionId)
  if (fs.existsSync(extDir)) fs.rmSync(extDir, { recursive: true })

  unloadExtensionFromAllSessions(extensionId)

  const state = readExtensionsMeta()
  state.extensions = state.extensions.filter((e) => e.id !== extensionId)
  for (const projectId of Object.keys(state.projectExtensions)) {
    state.projectExtensions[projectId] = state.projectExtensions[projectId].filter(
      (id) => id !== extensionId,
    )
  }
  writeExtensionsMeta(state)
}

/** Enable or disable an extension for a specific project. */
export function setExtensionEnabled(
  projectId: string,
  extensionId: string,
  enabled: boolean,
): void {
  const state = readExtensionsMeta()
  const projectExts = state.projectExtensions[projectId] ?? []

  if (enabled && !projectExts.includes(extensionId)) {
    state.projectExtensions[projectId] = [...projectExts, extensionId]
  } else if (!enabled) {
    state.projectExtensions[projectId] = projectExts.filter((id) => id !== extensionId)
  }
  writeExtensionsMeta(state)
}
