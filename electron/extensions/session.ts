/**
 * Session-level extension management.
 *
 * Each project in Cells gets its own Electron session partition
 * (`persist:browser-<projectId>`). Extensions are loaded into these
 * sessions via `session.loadExtension()`.
 *
 * Key complexity: Electron assigns its own extension IDs to unpacked
 * extensions (derived from the file path), which differ from Chrome Web
 * Store IDs. We track both and resolve between them via path matching.
 */

import { session } from 'electron'
import path from 'path'
import fs from 'fs'
import { EXTENSIONS_DIR } from './paths'
import { readExtensionsMeta } from './metadata'
import { sanitizeManifest, injectApiStubs, readManifest } from './compat'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Tracks which CWS extension IDs have been loaded into each session. */
const loadedSessionExtensions = new Map<string, Set<string>>()

/** Tracks sessions where UA has been spoofed. */
const spoofedSessions = new Set<string>()

// ---------------------------------------------------------------------------
// Loading / unloading
// ---------------------------------------------------------------------------

/**
 * Ensure all enabled extensions for a project are loaded into its session,
 * and any disabled extensions are unloaded.
 */
export async function ensureExtensionsLoaded(projectId: string): Promise<void> {
  const partition = `persist:browser-${projectId}`
  const ses = session.fromPartition(partition)
  const loaded = loadedSessionExtensions.get(partition) ?? new Set<string>()

  const meta = readExtensionsMeta()
  const enabledIds = meta.projectExtensions[projectId] ?? []

  for (const extId of enabledIds) {
    if (loaded.has(extId)) continue
    const extDir = path.join(EXTENSIONS_DIR, extId)
    if (!fs.existsSync(path.join(extDir, 'manifest.json'))) continue
    // Patch the extension for Electron compatibility before loading
    sanitizeManifest(extDir)
    injectApiStubs(extDir)
    try {
      await ses.loadExtension(extDir, { allowFileAccess: true })
      loaded.add(extId)
    } catch (err) {
      console.error(`[extensions] Failed to load ${extId}:`, err)
    }
  }

  // Unload extensions that are no longer enabled.
  // Compare by path, not ID — Electron's runtime ID differs from CWS ID.
  const enabledDirs = new Set(enabledIds.map((id) => path.resolve(path.join(EXTENSIONS_DIR, id))))
  for (const ext of ses.getAllExtensions()) {
    if (!enabledDirs.has(path.resolve(ext.path))) {
      ses.removeExtension(ext.id)
      loaded.delete(ext.id)
    }
  }

  loadedSessionExtensions.set(partition, loaded)
}

/** Load a single extension into a project session (used for live-enable). */
export async function loadExtensionIntoSession(
  projectId: string,
  extensionId: string,
): Promise<void> {
  const partition = `persist:browser-${projectId}`
  const ses = session.fromPartition(partition)
  const extDir = path.join(EXTENSIONS_DIR, extensionId)
  if (!fs.existsSync(path.join(extDir, 'manifest.json'))) return
  try {
    await ses.loadExtension(extDir, { allowFileAccess: true })
    const loaded = loadedSessionExtensions.get(partition) ?? new Set<string>()
    loaded.add(extensionId)
    loadedSessionExtensions.set(partition, loaded)
  } catch (err) {
    console.error(`[extensions] Failed to load ${extensionId}:`, err)
  }
}

/** Unload a single extension from a project session (used for live-disable). */
export function unloadExtensionFromSession(projectId: string, extensionId: string): void {
  const partition = `persist:browser-${projectId}`
  const ses = session.fromPartition(partition)
  try {
    ses.removeExtension(extensionId)
  } catch {
    /* may not be loaded */
  }
  const loaded = loadedSessionExtensions.get(partition)
  if (loaded) loaded.delete(extensionId)
}

/** Unload an extension from ALL sessions (used on uninstall). */
export function unloadExtensionFromAllSessions(extensionId: string): void {
  for (const [partition, loaded] of loadedSessionExtensions) {
    if (loaded.has(extensionId)) {
      try {
        session.fromPartition(partition).removeExtension(extensionId)
      } catch {}
      loaded.delete(extensionId)
    }
  }
}

// ---------------------------------------------------------------------------
// Popup URL resolution
// ---------------------------------------------------------------------------

/**
 * Get the popup URL for an extension in a specific project's session.
 *
 * IMPORTANT: Electron assigns its own extension ID when loading unpacked
 * extensions (based on the file path), NOT the Chrome Web Store ID. We
 * look up the actual runtime ID by matching extension paths.
 */
export function getExtensionPopupUrl(extensionId: string, projectId: string): string | null {
  const extDir = path.join(EXTENSIONS_DIR, extensionId)
  if (!fs.existsSync(path.join(extDir, 'manifest.json'))) return null
  const manifest = readManifest(extDir)
  const action = manifest.action || manifest.browser_action || {}
  const popup = action.default_popup
  if (!popup) return null

  // Find the actual runtime extension ID from the session
  const partition = `persist:browser-${projectId}`
  const ses = session.fromPartition(partition)
  const loadedExts = ses.getAllExtensions()

  const normalizedDir = path.resolve(extDir)
  const match = loadedExts.find((ext) => path.resolve(ext.path) === normalizedDir)

  if (!match) {
    console.error(
      `[extensions] Extension ${extensionId} not found in session. ` +
        `Loaded: ${loadedExts.map((e) => `${e.name}(${e.id})`).join(', ')}`,
    )
    return null
  }

  return `chrome-extension://${match.id}/${popup}`
}

// ---------------------------------------------------------------------------
// UA spoofing
// ---------------------------------------------------------------------------

/**
 * Strip "Electron/x.x.x" and app name from the User-Agent so websites
 * see a normal Chromium browser. Also strips the "Electron" brand from
 * Sec-CH-UA Client Hints headers on Google auth domains (which block
 * sign-in for Electron apps).
 *
 * The Sec-CH-UA handler is narrowly scoped to accounts.google.com to
 * avoid conflicting with extension webRequest handlers on other URLs.
 */
export function spoofChromeUA(projectId: string): void {
  const partition = `persist:browser-${projectId}`
  if (spoofedSessions.has(partition)) return
  spoofedSessions.add(partition)

  const ses = session.fromPartition(partition)
  const original = ses.getUserAgent()
  const cleaned = original
    .replace(/\s*cells\/\S+/gi, '')
    .replace(/\s*Electron\/\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  ses.setUserAgent(cleaned)

  // Strip "Electron" brand from Sec-CH-UA Client Hints headers on all
  // HTTP(S) requests so sites see a normal Chromium browser. The URL filter
  // ensures chrome-extension:// and other internal protocols are untouched.
  ses.webRequest.onBeforeSendHeaders(
    { urls: ['https://*/*', 'http://*/*'] },
    (details, callback) => {
      const h = details.requestHeaders
      for (const key of Object.keys(h)) {
        const lower = key.toLowerCase()
        if (lower === 'sec-ch-ua' || lower === 'sec-ch-ua-full-version-list') {
          const val = h[key]
          if (typeof val === 'string' && val.includes('Electron')) {
            h[key] = val
              .split(',')
              .filter((brand: string) => !/Electron/i.test(brand))
              .join(',')
          }
        }
      }
      callback({ requestHeaders: h })
    },
  )
}
