# Codex Agent Browser

Cells supports an embedded browser owned by Codex agent windows in the NW.js runtime.

## Current Scope

- V1 is Codex-only.
- The browser lives inside the Codex agent window when shown.
- Browser work is hidden by default, matching Codex Desktop browser-skill behavior.
- Hidden browsers keep running while the Codex turn is active.
- After an idle hidden browser sits unused, Cells can hibernate the webview while preserving URL, title, history, and session state.

Claude, Cursor, GitHub Copilot, and OpenCode do not receive this browser surface in v1. They can be added later once Cells has a NW.js MCP browser bridge or those providers expose compatible dynamic tool APIs.

## Architecture

The implementation is NW.js-only. Do not add new product behavior under `electron/`.

- `window.cells.agentBrowser` owns browser lifecycle: ensure, navigate, show, hide, destroy, state lookup, and state subscriptions.
- The React agent browser pane mounts a NW.js `<webview>` using the same project-scoped partition style as canvas browser panes: `persist:nw-${projectId}`.
- A shared browser runtime registry connects mounted webviews to Codex dynamic tools. The registry exposes script execution, screenshot capture, navigation, and state reads without going through the deprecated Electron MCP bridge.
- Codex receives dynamic browser tools on `thread/start`. Tool calls resolve the browser from the Codex agent window ID; Codex never chooses a raw browser ID.

## Tool Behavior

Codex browser tools use namespace `cells`:

- `browser_open`
- `browser_snapshot`
- `browser_screenshot`
- `browser_click`
- `browser_fill`
- `browser_type`
- `browser_press_key`
- `browser_select`
- `browser_wait_for`
- `browser_back`
- `browser_forward`
- `browser_reload`
- `browser_show`
- `browser_hide`

Tool responses use Codex dynamic tool output items: text as `inputText`, screenshots as `inputImage` data URLs.

## Security Notes

- The agent browser webview does not enable `allownw`.
- Browser tools run against the Codex-owned webview only.
- Non-Codex dynamic browser calls are rejected in this build.
- Existing canvas browser panes and manual browser element selection remain separate from the Codex-owned browser.
