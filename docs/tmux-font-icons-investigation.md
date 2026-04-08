# tmux Font Icon Investigation

## Summary

This document tracks the installed-app issue where terminal prompt icons render incorrectly when using the `tmux` backend, while the same setup works correctly with the `zellij` backend and usually works in `pnpm dev`.

The issue has **not been fully resolved**.

## Main Symptom

In the installed macOS app, tmux-backed terminals sometimes render prompt/icon glyphs incorrectly.

Examples of affected prompt symbols:

- git branch icon ``
- node icon ``
- prompt arrow `❯`

Observed bad renderings include:

- missing icons
- square/tofu fallback glyphs
- underscores or other incorrect replacement characters appearing where the icons should be

## What Works

- `zellij` backend renders correctly
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

`vector-ghost on  main [$!] via  v24.14.1`

That means:

- tmux is not emitting wrong bytes
- fish/starship are not the root cause
- the corruption happens somewhere in the app render/display path or from reused stale state

### 2. Installed app renderer can see the bundled fonts, but rendering is inconsistent

DevTools checks showed:

- the browser knows about the relevant font families
- some families stay `unloaded` before manual intervention
- canvas glyph tests in the broken state often render boxes/tofu for those codepoints

### 3. Local manual repair has worked

The most reliable local workaround has been:

1. quit Cells
2. kill Cells-owned background processes
3. clear the installed app's Chromium/Electron caches
4. relaunch Cells

This strongly suggests stale renderer/runtime state is part of the issue.

### 4. Persisted state was also bad

The installed app's `~/.cells/state.json` contained stale terminal state, including:

- old non-Nerd `fontFamily` values
- stale per-project font settings
- stale terminal `restoredOutput` values that already contained the wrong glyph placeholders

That means Cells could re-show already-bad terminal output/state even when the live tmux pane itself was fine.

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

The most likely root cause is a combination of:

- stale persisted terminal visual state
- stale renderer/cache/process state
- tmux-specific attach/restart/restore lifecycle reusing or reintroducing bad state

Why tmux-specific?

- zellij uses a different attach/restart path and does not seem to reuse the same bad state in the same way
- tmux is the backend where Cells does more reattach/restore behavior

So the issue appears to be:

**Cells' tmux lifecycle is more exposed to stale visual/render state than zellij, and that stale state can surface as broken icon glyph rendering in the installed app.**

## What This Probably Is Not

Based on the diagnostics so far, the issue is probably not primarily caused by:

- wrong tmux output bytes
- fish or starship generating the wrong prompt
- missing bundled Nerd Font files
- dev using a completely different tmux binary than prod

## Simplest Future Direction

The most promising direction is to keep the fix surface small and focus on the actual stale-state problem:

1. keep startup/manual state repair for legacy font state
2. keep a strong manual repair path in-app
3. avoid extra complex runtime font-loading tricks unless proven necessary
4. investigate tmux-specific restore/replay paths that may be reintroducing stale visual state
5. especially inspect what survives across:
   - backend switch `zellij -> tmux`
   - daemon restart
   - packaged app relaunch

## Current Status

As of this document:

- the issue is still not fully solved in the installed app
- a reliable local workaround exists
- the tmux pane content itself is correct
- the remaining work is to identify exactly which tmux lifecycle state is reintroducing the bad rendered output
