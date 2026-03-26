/**
 * Chrome Web Store integration.
 *
 * Injects scripts into CWS pages to:
 * 1. Stub Chrome-specific APIs (chrome.app, chrome.csi, etc.) so CWS
 *    doesn't show browser-detection warnings
 * 2. Hook "Add to Chrome" button clicks to route installs through our
 *    CRX download pipeline instead of Chrome's native installer
 *
 * Communication bridge: The injected page script uses console.log with
 * a `__cells_install:` prefix since contextIsolation blocks postMessage
 * from reaching the preload. Main process picks it up via the
 * webContents 'console-message' event.
 */

import type { WebContents } from 'electron'

// ---------------------------------------------------------------------------
// Injected scripts
// ---------------------------------------------------------------------------

/** Stubs for Chrome-specific APIs that CWS probes client-side. */
const CWS_CHROME_STUBS_SCRIPT = `\
(function() {
  if (window.__cellsChromeStubbed) return;
  window.__cellsChromeStubbed = true;
  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        getDetails: function() { return null; },
        getIsInstalled: function() { return false; },
        installState: function(cb) { if (cb) cb('not_installed'); },
        runningState: function() { return 'cannot_run'; },
      };
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        id: undefined,
        connect: function() { return { onMessage: { addListener: function(){} }, postMessage: function(){} }; },
        sendMessage: function() {},
        onMessage: { addListener: function() {}, removeListener: function() {}, hasListeners: function() { return false; } },
        onConnect: { addListener: function() {}, removeListener: function() {} },
      };
    }
    if (!window.chrome.csi) {
      window.chrome.csi = function() {
        return { onloadT: 0, startE: Date.now(), pageT: 0, tran: 0 };
      };
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = function() {
        return {
          requestTime: Date.now() / 1000, startLoadTime: Date.now() / 1000,
          commitLoadTime: Date.now() / 1000, finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000, firstPaintTime: 0,
          firstPaintAfterLoadTime: 0, navigationType: 'Other',
          wasFetchedViaSpdy: false, wasNpnNegotiated: false,
          npnNegotiatedProtocol: '', wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2',
        };
      };
    }
  } catch (e) {}
})();
`

/** Hooks "Add to Chrome" buttons and routes clicks to our install pipeline. */
const CWS_BUTTON_HOOK_SCRIPT = `\
(function() {
  if (window.__cellsButtonHooked) return;
  window.__cellsButtonHooked = true;

  function getExtensionId() {
    var m = location.pathname.match(/\\/detail\\/(?:[^\\/]+\\/)?([a-z]{32})/);
    return m ? m[1] : null;
  }

  function hookButton(btn) {
    if (!btn || btn.__cellsHooked) return;
    btn.__cellsHooked = true;
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      var extId = getExtensionId();
      if (!extId) return;
      var originalText = btn.textContent;
      btn.textContent = 'Installing...';
      btn.style.opacity = '0.6';
      btn.style.pointerEvents = 'none';
      console.log('__cells_install:' + extId);
      function onResult(ev) {
        if (!ev.data || ev.data.type !== '__cells_install_result') return;
        if (ev.data.extensionId !== extId) return;
        window.removeEventListener('message', onResult);
        if (ev.data.success) {
          btn.textContent = 'Added to Cells';
          btn.style.opacity = '1';
        } else {
          btn.textContent = originalText;
          btn.style.opacity = '1';
          btn.style.pointerEvents = '';
        }
      }
      window.addEventListener('message', onResult);
    }, true);
  }

  function findAndHookButtons() {
    document.querySelectorAll('button').forEach(function(btn) {
      var text = (btn.textContent || '').trim().toLowerCase();
      if (text === 'add to chrome' || text === 'install') hookButton(btn);
    });
  }

  findAndHookButtons();
  new MutationObserver(function() { findAndHookButtons(); })
    .observe(document.body, { childList: true, subtree: true });
})();
`

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function isCWSUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'chromewebstore.google.com'
  } catch {
    return false
  }
}

/**
 * Set up CWS "Add to Chrome" interception on a browser view's webContents.
 *
 * Two-phase injection:
 * 1. Chrome API stubs on 'dom-ready' (before page scripts check them)
 * 2. Button hooks on 'did-finish-load' (after DOM is populated)
 *
 * Install requests bridged via console.log → 'console-message' event.
 */
export function setupCWSIntegration(
  webContents: WebContents,
  onInstallRequest: (extensionId: string) => Promise<boolean>,
): void {
  webContents.on('dom-ready', () => {
    if (!isCWSUrl(webContents.getURL())) return
    webContents.executeJavaScript(CWS_CHROME_STUBS_SCRIPT).catch(() => {})
  })

  const hookButtons = (url: string) => {
    if (!isCWSUrl(url)) return
    webContents.executeJavaScript(CWS_CHROME_STUBS_SCRIPT).catch(() => {})
    webContents.executeJavaScript(CWS_BUTTON_HOOK_SCRIPT).catch(() => {})
  }

  webContents.on('did-navigate', (_e, url) => hookButtons(url))
  webContents.on('did-navigate-in-page', (_e, url) => hookButtons(url))
  webContents.on('did-finish-load', () => hookButtons(webContents.getURL()))

  webContents.on('console-message', async (_event, _level, message) => {
    if (!message.startsWith('__cells_install:')) return
    const extensionId = message.slice('__cells_install:'.length).trim()
    if (!/^[a-z]{32}$/.test(extensionId)) return

    const success = await onInstallRequest(extensionId)

    webContents
      .executeJavaScript(
        `window.postMessage({ type: '__cells_install_result', extensionId: ${JSON.stringify(extensionId)}, success: ${success} }, '*');`,
      )
      .catch(() => {})
  })
}
