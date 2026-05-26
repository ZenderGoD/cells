# Cells Runtime Extension Capability Matrix

Initial state: unverified. Use the extension lab controls,
then replace the "unknown" cells with observed results.

| Capability | Native NW.js Result | Polyfill Possible | Production Risk | Notes |
| --- | --- | --- | --- | --- |
| browser embedding | unknown | no | high | Must support stable `<webview>` navigation, events, sizing, and focus. |
| per-project storage isolation | unknown | no | high | Must prove `partition="project-a"` and `partition="project-b"` isolate cookies/storage. |
| content scripts | unknown | no | high | Bundled content-script probes should inject markers into controlled pages. |
| runtime messaging | unknown | no | high | `chrome.runtime.sendMessage` must work from content script to background. |
| storage | unknown | limited | medium | App-owned storage can be polyfilled, but extension `chrome.storage` semantics should be native. |
| tabs targeting webviews | unknown | limited | high | The prototype probes `chrome.tabs.query`; deeper tab targeting needs manual extension tests. |
| cookies | unknown | no | high | Cookie API must access the intended webview/session store. |
| webRequest | unknown | no | high | Request interception/blocking cannot be fully polyfilled from page JavaScript. |
| declarativeNetRequest | unknown | no | high | DNR success is required for ad-block-style extension support. |
| extension popups/actions | unknown | yes | medium | App shell can map action UI if extension pages are loadable. |
| Chrome Web Store install flow | unknown | yes | medium | Later phase can reuse CRX download/unpack; not part of first prototype. |
| devtools | unknown | no | low | SDK build should expose useful webview inspection. |
| focus/keyboard shortcuts | unknown | yes | medium | App shell can intercept many shortcuts; webview focus behavior still matters. |
| context menus | unknown | yes | medium | Shell can provide custom menus, but extension context menu API may need mapping. |
| request/cookie/session isolation | unknown | no | high | Must be verified with real webviews and extension APIs, not only page cookies. |
