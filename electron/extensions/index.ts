/**
 * Chrome Extension Support for Cells
 *
 * This module provides a compatibility layer for running Chrome extensions
 * inside Electron. Electron's native `session.loadExtension()` supports
 * loading unpacked extensions but only implements a subset of Chrome's
 * extension APIs. This layer fills the gaps:
 *
 * - **CRX Pipeline** (`crx.ts`): Downloads .crx files from Chrome Web Store
 *   via Google's update2 URL (same method as Brave/Vivaldi), extracts them
 *   (CRX v2/v3 → ZIP → unpacked directory), and manages on-disk storage.
 *
 * - **Compatibility Layer** (`compat.ts`): Patches extensions for Electron:
 *   1. Strips `webRequest` permissions that cause ERR_BLOCKED_BY_CLIENT
 *   2. Injects polyfill stubs for missing Chrome APIs (webNavigation,
 *      contextMenus, notifications, privacy) into background scripts
 *   3. Resolves i18n __MSG_ placeholders in manifest fields
 *
 * - **Session Manager** (`session.ts`): Loads/unloads extensions into
 *   per-project Electron sessions, manages the runtime ID mapping
 *   (Electron assigns its own IDs to unpacked extensions, different from
 *   Chrome Web Store IDs), and handles UA spoofing.
 *
 * - **CWS Integration** (`cws.ts`): Injects scripts into Chrome Web Store
 *   pages to intercept "Add to Chrome" button clicks and route them through
 *   our install pipeline.
 *
 * - **Metadata** (`metadata.ts`): Persists extension state to
 *   `~/.cells/extensions.json` — installed extensions and per-project
 *   enable/disable configuration.
 *
 * Known limitations (Electron ≤33):
 * - `chrome.webNavigation` events don't fire (stubbed as noops)
 * - `chrome.contextMenus` creates are noops (no native menu integration)
 * - `chrome.notifications` creates are noops
 * - Content script autofill overlays may not work for complex extensions
 * - Extension popups open in a separate BrowserWindow, not inline
 * - CWS "Add to Chrome" button may show "Item unavailable" due to
 *   server-side Sec-CH-UA header detection (installs still work via
 *   settings UI using extension ID)
 */

// Re-export everything from the individual modules
export type { ExtensionMeta, ExtensionsState } from './metadata'

export { readExtensionsMeta, writeExtensionsMeta, buildExtensionMeta } from './metadata'

export {
  parseExtensionInput,
  installExtension,
  uninstallExtension,
  setExtensionEnabled,
} from './lifecycle'

export {
  ensureExtensionsLoaded,
  loadExtensionIntoSession,
  unloadExtensionFromSession,
  unloadExtensionFromAllSessions,
  getExtensionPopupUrl,
  spoofChromeUA,
} from './session'

export { setupCWSIntegration } from './cws'
