/**
 * Extension metadata persistence.
 *
 * Stores installed extension info and per-project enable/disable state
 * in `~/.cells/extensions.json`. Separate from the main app state to
 * avoid bloating the Zustand store with main-process-only data.
 */

import path from 'path'
import fs from 'fs'
import { STATE_DIR, EXTENSIONS_DIR, EXTENSIONS_META_FILE } from './paths'
import { readManifest, resolveI18n } from './compat'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtensionMeta {
  id: string
  name: string
  version: string
  description: string
  sourceUrl: string
  installedAt: number
  hasPopup: boolean
  icons: Record<string, string>
}

export interface ExtensionsState {
  extensions: ExtensionMeta[]
  projectExtensions: Record<string, string[]> // projectId → enabled extension IDs
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export function readExtensionsMeta(): ExtensionsState {
  let state: ExtensionsState = { extensions: [], projectExtensions: {} }
  try {
    if (fs.existsSync(EXTENSIONS_META_FILE)) {
      state = JSON.parse(fs.readFileSync(EXTENSIONS_META_FILE, 'utf-8'))
    }
  } catch {
    /* corrupt file — start fresh */
  }

  // Auto-fix any unresolved __MSG_ placeholders from older installs
  let dirty = false
  for (const ext of state.extensions) {
    if (ext.name.startsWith('__MSG_') || ext.description.startsWith('__MSG_')) {
      const extDir = path.join(EXTENSIONS_DIR, ext.id)
      if (fs.existsSync(path.join(extDir, 'manifest.json'))) {
        const manifest = readManifest(extDir)
        const fixedName = resolveI18n(ext.name, extDir, manifest)
        const fixedDesc = resolveI18n(ext.description, extDir, manifest)
        if (fixedName !== ext.name || fixedDesc !== ext.description) {
          ext.name = fixedName
          ext.description = fixedDesc
          dirty = true
        }
      }
    }
  }
  if (dirty) writeExtensionsMeta(state)

  return state
}

export function writeExtensionsMeta(state: ExtensionsState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(EXTENSIONS_META_FILE, JSON.stringify(state, null, 2))
}

export function buildExtensionMeta(
  extensionId: string,
  extensionDir: string,
  sourceUrl: string,
): ExtensionMeta {
  const manifest = readManifest(extensionDir)
  const action = manifest.action || manifest.browser_action || {}
  return {
    id: extensionId,
    name: resolveI18n(manifest.name || extensionId, extensionDir, manifest),
    version: manifest.version || '0.0.0',
    description: resolveI18n(manifest.description || '', extensionDir, manifest),
    sourceUrl,
    installedAt: Date.now(),
    hasPopup: !!action.default_popup,
    icons: manifest.icons || {},
  }
}
