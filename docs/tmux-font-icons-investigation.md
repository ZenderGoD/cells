# tmux Font Icon Investigation

## Summary

This document tracks the installed-app issue where terminal prompt icons render incorrectly when using the `tmux` backend, while the same setup works correctly with the `zellij` backend and always works in `pnpm dev`.

The issue has **not been fully resolved**.

## Main Symptom

In the installed macOS app, tmux-backed terminals sometimes render prompt/icon glyphs incorrectly.

Examples of affected prompt symbols:

- git branch icon ``
- node icon ``
- prompt arrow `❯`

Observed bad renderings include:

- missing icons
- square/tofu fallback glyphs
- underscores or other incorrect replacement characters appearing where the icons should be

## What Works

- `zellij` backend renders correctly (always, including installed app)
- `pnpm dev` generally does not reproduce the installed-app issue
- Direct tmux pane capture outside the app shows the correct glyphs
- The bundled Nerd Font files are present in the app bundle

## Reproduction Patterns

Observed ways to trigger the broken state:

- install/update the packaged app and open it
- switch backend to `zellij`, restart app, then switch back to `tmux` and restart daemon
- sometimes after daemon-related lifecycle transitions involving tmux

Observed ways the broken state did **not** reliably trigger:

- plain `pnpm dev`
- `zellij` backend usage

## Strong Evidence Collected

### 1. tmux output itself is correct

The live tmux pane was captured directly from the running Cells tmux socket and showed the correct glyphs:

`vector-ghost on  main [$!] via  v24.14.1`

Raw hex capture of tmux client data confirmed correct UTF-8 bytes (`ee 82 a0` = U+E0A0) are sent to the client terminal. tmux is not corrupting the data.

That means:

- tmux is not emitting wrong bytes
- fish/starship are not the root cause
- the corruption happens somewhere in the app render/display path or from reused stale state

### 2. tmux and ghostty-web agree on character widths

Both the bundled tmux (3.5a) and the app's terminal emulator (ghostty-web) use `utf8proc` for Unicode character widths. Direct testing confirmed:

- U+E0A0 (git branch): utf8proc_charwidth = 1
- U+E0B0 (powerline arrow): utf8proc_charwidth = 1
- U+F1D3 (node icon): utf8proc_charwidth = 1
- U+E718 (PUA icon): utf8proc_charwidth = 1

The WebGL renderer's `isDoubleWidthGlyph()` also returns `false` for PUA characters (explicitly excludes U+E000-U+F8FF). So there is no wcwidth mismatch between tmux and the renderer.

### 3. Installed app renderer can see the bundled fonts, but rendering is inconsistent

DevTools checks showed:

- the browser knows about the relevant font families
- some families stay `unloaded` before manual intervention
- canvas glyph tests in the broken state often render boxes/tofu for those codepoints

### 4. Local manual repair has worked

The most reliable local workaround has been:

1. quit Cells
2. kill Cells-owned background processes
3. clear the installed app's Chromium/Electron caches
4. relaunch Cells

This strongly suggests stale renderer/runtime state is part of the issue.

### 5. Persisted state was also bad

The installed app's `~/.cells/state.json` contained stale terminal state, including:

- old non-Nerd `fontFamily` values
- stale per-project font settings
- stale terminal `restoredOutput` values that already contained the wrong glyph placeholders

That means Cells could re-show already-bad terminal output/state even when the live tmux pane itself was fine.

### 6. Both dev and installed app use the same bundled tmux binary

The bundled tmux at `resources/vendor/tmux/darwin-arm64/tmux` (v3.5a) is resolved by `resolveBundledTmuxBinary()` in both `pnpm dev` and the installed app. Both link against the same `libutf8proc.3.dylib`. The difference between dev and installed is not the tmux binary itself.

### 7. Unicode East_Asian_Width for PUA is "Ambiguous"

Python `unicodedata.east_asian_width()` reports PUA characters (U+E0A0, U+E0B0, etc.) as `A` (Ambiguous). This was investigated as a potential wcwidth mismatch between tmux and the renderer, but both use utf8proc which resolves ambiguous-width PUA to width 1. Ruled out as root cause.

## Things Tried

### Backend/session changes

- bundled `tmux` into the app and made it the default backend
- reworked tmux session management toward a shared private server model
- reduced attach/unsubscribe churn
- changed daemon restart behavior to avoid extra `reloadAllTerminals()`

Result:

- improved tmux lifecycle and interactivity in many places
- did **not** reliably fix the icon rendering issue

### Font naming changes

- switched terminal font family references to the fonts' real embedded names
- aligned CSS `@font-face` names with those embedded names

Result:

- improved consistency in local diagnostics
- did **not** by itself fix the installed-app issue

### Runtime font loading experiments

- explicit `FontFace(...)` loading from bundled asset paths
- `document.fonts.load(...)` using Nerd glyph samples
- loading from binary font data through Electron IPC
- waiting on `document.fonts.ready` before terminal/app bootstrap
- warm renderer reload attempts after startup

Result:

- none of these reliably fixed the installed-app issue on their own
- several of these added complexity without producing a stable fix

### Cache clearing on update/startup

- clear renderer caches once per app version
- move that clearing earlier in startup
- relaunch after cache clear

Result:

- likely helps in some cases
- did **not** fully solve the issue on its own

### State migration / repair

- auto-migrate legacy non-Nerd `fontFamily`
- strip stale per-project `fontFamily` / `fontSize` / `terminalTheme`
- strip stale `restoredOutput` during repair flows
- add a manual repair button / script path

Result:

- this clearly fixes part of the bad state problem
- but still did not guarantee the installed app stayed correct in all tmux lifecycle cases

### Route tmux data through zellij's OSC query filter (v0.1.86)

Changed `cell-terminal.tsx` to run tmux data through `splitZellijHostQueries()` (same filter zellij uses). The theory was that tmux sends OSC 10/11 (foreground/background color queries), DA1, DA2, and XTVERSION queries to the client terminal that pass through unintercepted to ghostty-web, while zellij's equivalent queries are intercepted and replied to by the app. If ghostty-web's parser mishandled these queries, it could corrupt state before screen content arrived.

Result:

- did **not** fix the issue
- the theory was wrong because tmux sends queries AND screen content in a single data burst — filtering the queries doesn't add any delay before the first render, unlike zellij where query exchanges happen across multiple round trips

### Add `remeasureFont()` to font change effect (v0.1.86)

The font change effect at `cell-terminal.tsx:~3003` updated `term.options.fontFamily` and called `fit()` when font family changed at runtime (e.g., after state normalization from legacy "Geist Mono" to "GeistMono NFM"), but did NOT call `renderer.remeasureFont()`. This meant the WebGL glyph atlas kept using the old font. Added `remeasureFont()` + `forceTerminalRepaint()` to the effect.

Result:

- genuine bug fix for font-change scenarios
- did **not** fix the core tmux installed-app issue (the font family is usually already correct at startup)

### Add `document.fonts` `loadingdone` watcher (v0.1.86, pending test)

Added a `loadingdone` event listener on `document.fonts` that watches for the terminal's primary font (e.g., "GeistMono NFM") to finish loading. When it does, calls `remeasureFont()` to clear the glyph atlas and force re-render with the correct font. Applied to both new-terminal and cached-terminal-reattach paths.

Theory: `document.fonts.ready` resolves instantly when no `@font-face` fonts are in the `loading` state — but `@font-face` fonts start as `unloaded`, not `loading`. In the packaged app (fonts loaded from ASAR via `file://`), the font may not start loading until something triggers it. The first render happens before the font is available, and the glyph atlas caches fallback glyphs permanently. Zellij escapes this because its multi-round-trip query exchange creates enough delay for the font to load before the first content render.

Result:

- **pending test** — not yet confirmed whether this fixes the issue

## What Did Work Temporarily / Locally

The strongest practical workaround was the manual local repair sequence:

1. repair saved font state
2. remove stale `restoredOutput`
3. kill Cells-owned background processes
4. clear renderer caches
5. relaunch Cells

This could restore correct icons locally, but the state could still regress after certain tmux/backend transitions.

## Current Best Understanding

The issue is probably **not a single font-file or tmux-binary problem**.

### Most likely root cause: glyph atlas poisoning from font loading race

The WebGL glyph atlas (`GlyphAtlas` in `webgl-terminal-renderer.ts`) caches rendered glyphs permanently within a session. Once a PUA character is first drawn with a fallback font (because the Nerd Font `@font-face` hasn't loaded yet), that fallback glyph stays in the atlas. Even when the font loads later, the atlas is never rebuilt — it already has an entry for that character.

**Why tmux is affected but not zellij:**

When a tmux client attaches, tmux sends its terminal queries (DA1, DA2, XTVERSION, OSC 10/11) AND the full screen content in a **single data burst**. The first render happens on the very next animation frame (~16ms). The `@font-face` font hasn't loaded from the ASAR by then.

When a zellij client attaches, zellij sends queries first, then waits for the app to reply, then sends content in a separate data chunk. This multi-round-trip exchange creates ~50-100ms of delay during which the font has time to load. By the time zellij's actual content hits the glyph atlas, the real Nerd Font is available.

**Why the installed app is affected but not dev:**

In `pnpm dev`, Vite serves fonts via HTTP (`http://localhost:PORT/src/fonts/...`). Vite's CSS injection triggers the browser to start loading `@font-face` fonts early. By the time the terminal mounts, fonts are loaded or loading.

In the installed app, CSS is loaded from the ASAR bundle. `@font-face` fonts start as `unloaded` and may not begin loading until something explicitly needs them. Canvas API usage (which the glyph atlas uses) doesn't always trigger `@font-face` loading in Chromium.

### Contributing factors

- **Stale persisted terminal visual state**: `restoredOutput` in `state.json` can contain previously-captured text that was rendered with fallback glyphs. On restore, this bad text is replayed into the terminal.
- **Stale renderer/cache/process state**: Chromium's GPU cache, code cache, and session storage can persist bad glyph renders across app launches.
- **tmux-specific attach/restart/restore lifecycle**: More reattach cycles than zellij means more chances to hit the race condition.

## What This Probably Is Not

Based on the diagnostics so far, the issue is probably not primarily caused by:

- wrong tmux output bytes (confirmed correct via capture-pane and raw client data hex dump)
- fish or starship generating the wrong prompt
- missing bundled Nerd Font files
- dev using a different tmux binary than prod (both use the bundled 3.5a)
- wcwidth mismatch between tmux and ghostty-web (both use utf8proc, both report width 1 for PUA)
- tmux's OSC/DA queries corrupting ghostty-web's parser (tested and ruled out in v0.1.86)

## Simplest Future Direction

1. **Test the `loadingdone` watcher** (pending) — this directly addresses the atlas poisoning theory by rebuilding the atlas when the font loads late
2. If that doesn't work, investigate whether the font actually loads at all in the installed app by adding diagnostics (`document.fonts.check()` + `document.fonts.load()` with logging)
3. Consider pre-loading the terminal font eagerly before any terminal is created, using `document.fonts.load('16px "GeistMono NFM"')` at app startup
4. As a last resort, consider periodically clearing the glyph atlas (e.g., on the first few renders) to catch late-loading fonts

## Key Code Locations

- `src/components/terminal/cell-terminal.tsx:~2445` — `document.fonts.ready` callback + `loadingdone` watcher
- `src/components/terminal/cell-terminal.tsx:~2109` — cached terminal reattach font handling
- `src/components/terminal/cell-terminal.tsx:~2620` — `__cellsPendingReattachReset` mechanism (deferred reset on first backend data)
- `src/components/terminal/cell-terminal.tsx:~3003` — font change effect (now calls `remeasureFont()`)
- `src/lib/webgl-terminal-renderer.ts:162` — `GlyphAtlas` class (caches glyphs permanently until `reset()`)
- `src/lib/webgl-terminal-renderer.ts:144` — `isDoubleWidthGlyph()` (excludes PUA from double-width)
- `src/lib/webgl-terminal-renderer.ts:453` — `remeasureFont()` (clears atlas and rebuilds)
- `electron/tmux-shared.ts:223` — `buildPrivateTmuxConfig()` (tmux server options)
- `electron/tmux-session-manager.ts:381` — `replaceAttachedClient()` (tmux client PTY setup)

## Current Status

As of this document:

- the issue is still not fully solved in the installed app
- a reliable local workaround exists (cache clear + relaunch)
- the tmux pane content and raw client bytes are confirmed correct
- the `loadingdone` watcher fix is pending test
- the remaining work is confirming whether the font loading race / atlas poisoning theory is correct, and if not, adding runtime diagnostics to determine when and why the glyph atlas gets poisoned
