/**
 * Chrome Extension Compatibility Layer for Electron.
 *
 * Electron's `session.loadExtension()` only supports a subset of Chrome's
 * extension APIs. Extensions that use unsupported APIs will crash or cause
 * errors. This module patches extensions before loading:
 *
 * 1. **Permission sanitization**: Strips permissions that actively break
 *    Electron (webRequest causes ERR_BLOCKED_BY_CLIENT / network hangs).
 *    Other unsupported permissions produce harmless warnings and are left
 *    in place since their APIs may be partially available.
 *
 * 2. **API stub injection**: Prepends polyfill code to the extension's
 *    background/service worker script that provides noop implementations
 *    of missing Chrome APIs. This prevents `TypeError: Cannot read
 *    properties of undefined` crashes when extensions reference APIs
 *    that Electron doesn't implement.
 *
 * 3. **i18n resolution**: Chrome extensions use `__MSG_key__` placeholders
 *    in manifest.json that reference `_locales/<locale>/messages.json`.
 *    We resolve these to human-readable strings for display in the UI.
 *
 * Stubbed APIs:
 * - chrome.webNavigation (events + getAllFrames/getFrame)
 * - chrome.contextMenus (create/update/remove/removeAll + onClicked)
 * - chrome.notifications (create/clear/getAll + events)
 * - chrome.privacy (services/websites/network settings)
 * - chrome.webRequest.onAuthRequired
 */

import path from 'path'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Permission sanitization
// ---------------------------------------------------------------------------

/**
 * Permissions that actively break Electron when present in extensions.
 * webRequest/webRequestBlocking cause ERR_BLOCKED_BY_CLIENT on all
 * chrome-extension:// URL loads and can hang the entire network stack.
 */
const BREAKING_PERMISSIONS = new Set(['webRequest', 'webRequestBlocking', 'webRequestAuthProvider'])

/**
 * Strip breaking permissions from an extension's manifest.
 * Modifies the manifest.json file on disk.
 */
export function sanitizeManifest(extensionDir: string): void {
  const manifestPath = path.join(extensionDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  let changed = false

  if (Array.isArray(manifest.permissions)) {
    const filtered = manifest.permissions.filter((p: string) => !BREAKING_PERMISSIONS.has(p))
    if (filtered.length !== manifest.permissions.length) {
      manifest.permissions = filtered
      changed = true
    }
  }
  if (Array.isArray(manifest.optional_permissions)) {
    const filtered = manifest.optional_permissions.filter(
      (p: string) => !BREAKING_PERMISSIONS.has(p),
    )
    if (filtered.length !== manifest.optional_permissions.length) {
      manifest.optional_permissions = filtered
      changed = true
    }
  }

  if (changed) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  }
}

// ---------------------------------------------------------------------------
// Chrome API stubs
// ---------------------------------------------------------------------------

/**
 * Polyfill code prepended to extension background/service worker scripts.
 * Provides noop implementations of Chrome APIs that Electron doesn't support
 * so the extension doesn't crash on startup.
 */
const CHROME_API_STUBS = `\
/* Cells: Chrome API stubs for Electron compatibility */
(function() {
  if (typeof chrome === 'undefined') return;
  function noopEvent() {
    return { addListener: function(){}, removeListener: function(){}, hasListener: function(){ return false; }, hasListeners: function(){ return false; } };
  }
  function stubApi(name, events) {
    if (chrome[name]) return;
    var obj = {};
    (events || []).forEach(function(e) { obj[e] = noopEvent(); });
    chrome[name] = obj;
  }

  // --- chrome.webNavigation ---
  stubApi('webNavigation', ['onCommitted', 'onCompleted', 'onBeforeNavigate', 'onCreatedNavigationTarget', 'onDOMContentLoaded', 'onErrorOccurred', 'onReferenceFragmentUpdated', 'onTabReplaced', 'onHistoryStateUpdated']);
  if (chrome.webNavigation) {
    if (!chrome.webNavigation.getAllFrames) chrome.webNavigation.getAllFrames = function(d, cb) { var r = []; if (cb) cb(r); return Promise.resolve(r); };
    if (!chrome.webNavigation.getFrame) chrome.webNavigation.getFrame = function(d, cb) { if (cb) cb(null); return Promise.resolve(null); };
  }

  // --- chrome.contextMenus ---
  stubApi('contextMenus', ['onClicked']);
  if (chrome.contextMenus && !chrome.contextMenus.create) {
    chrome.contextMenus.create = function(){};
    chrome.contextMenus.update = function(){};
    chrome.contextMenus.remove = function(){};
    chrome.contextMenus.removeAll = function(cb){ if(cb) cb(); };
  }

  // --- chrome.notifications ---
  stubApi('notifications', ['onClicked', 'onClosed', 'onButtonClicked']);
  if (chrome.notifications && !chrome.notifications.create) {
    chrome.notifications.create = function(id, opts, cb){ if(cb) cb(id || ''); };
    chrome.notifications.clear = function(id, cb){ if(cb) cb(true); };
    chrome.notifications.getAll = function(cb){ if(cb) cb({}); };
  }

  // --- chrome.privacy ---
  stubApi('privacy', []);
  if (chrome.privacy && !chrome.privacy.services) {
    var privacySetting = { get: function(d,cb){ if(cb) cb({ value: true }); }, set: function(){}, clear: function(){}, onChange: noopEvent() };
    chrome.privacy.services = { passwordSavingEnabled: privacySetting };
    chrome.privacy.websites = {};
    chrome.privacy.network = {};
  }

  // --- chrome.webRequest partial ---
  if (chrome.webRequest) {
    if (!chrome.webRequest.onAuthRequired) chrome.webRequest.onAuthRequired = noopEvent();
  }
})();
`

/**
 * Inject Chrome API stubs into an extension's background/service worker.
 * Prepends the polyfill to the script file. Idempotent — checks for a
 * marker comment to avoid double-injection.
 */
export function injectApiStubs(extensionDir: string): void {
  const manifestPath = path.join(extensionDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))

  const bgScript =
    manifest.background?.service_worker ||
    (manifest.background?.scripts && manifest.background.scripts[0])
  if (!bgScript) return

  const bgPath = path.join(extensionDir, bgScript)
  if (!fs.existsSync(bgPath)) return

  const content = fs.readFileSync(bgPath, 'utf-8')
  if (content.includes('Cells: Chrome API stubs')) return

  fs.writeFileSync(bgPath, CHROME_API_STUBS + content)
}

// ---------------------------------------------------------------------------
// i18n resolution
// ---------------------------------------------------------------------------

/**
 * Resolve Chrome extension i18n message placeholders like `__MSG_extName__`.
 * Looks up values in `_locales/<locale>/messages.json`.
 */
export function resolveI18n(
  value: string,
  extensionDir: string,
  manifest: Record<string, any>,
): string {
  if (!value || !value.startsWith('__MSG_')) return value

  const key = value.replace(/^__MSG_/, '').replace(/__$/, '')
  const locale = manifest.default_locale || 'en'
  const locales = [locale, 'en']

  for (const loc of locales) {
    const messagesPath = path.join(extensionDir, '_locales', loc, 'messages.json')
    try {
      if (fs.existsSync(messagesPath)) {
        const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf-8'))
        const found = Object.keys(messages).find((k) => k.toLowerCase() === key.toLowerCase())
        if (found && messages[found]?.message) return messages[found].message
      }
    } catch {}
  }

  return value
}

export function readManifest(extensionDir: string): Record<string, any> {
  const manifestPath = path.join(extensionDir, 'manifest.json')
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
}
