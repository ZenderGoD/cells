# ghostty-web patches

Patches applied via pnpm's `patchedDependencies` to `ghostty-web@0.4.0`.

## What's patched and why

### 1. `pixelToCell()` — selection offset fix

**Problem:** `pixelToCell()` converts mouse pixel coordinates to terminal grid
(col, row). The original implementation divides raw pixel coords by cell
metrics, which produces wrong results when the canvas is CSS-scaled (e.g.,
`transform: scale()` for zoom, or when `canvas.width` and
`getBoundingClientRect().width` differ due to DPR or layout constraints).
Clicks and selections would land on the wrong cell.

**Fix:** Before dividing by cell metrics, adjust pixel coordinates to account
for the ratio between the canvas's natural (backing) size and its CSS layout
size, factoring in `devicePixelRatio`:

```
naturalW = canvas.width / dpr
adjX     = mouseX * naturalW / rect.width
col      = floor(adjX / cellWidth)
```

This ensures correct cell targeting regardless of CSS transforms or DPR.

**Files modified:**
- `dist/ghostty-web.js` — ESM build, `pixelToCell` in `SelectionManager`
- `dist/ghostty-web.umd.cjs` — UMD build, same change

### 2. `rendererFactory` — custom renderer injection point

**Problem:** `Terminal.open()` hard-codes `new CanvasRenderer(canvas, opts)`.
There's no way to substitute a different renderer (e.g., WebGL) without forking
the entire package.

**Fix:** Check `this.options.rendererFactory` before falling back to the
default `CanvasRenderer`. If a factory function is provided, call it with
`(canvas, rendererOptions)` and use the returned renderer instead.

```js
// Before (hard-coded):
this.renderer = new CanvasRenderer(this.canvas, opts)

// After (factory-aware):
this.renderer = this.options.rendererFactory
  ? this.options.rendererFactory(this.canvas, opts)
  : new CanvasRenderer(this.canvas, opts)
```

The `rendererFactory` type is also added to `ITerminalOptions` in the type
declarations so TypeScript consumers can pass it without casting.

**Files modified:**
- `dist/ghostty-web.js` — ESM build, `Terminal.open()` method
- `dist/ghostty-web.umd.cjs` — UMD build, same change
- `dist/index.d.ts` — add `rendererFactory` to `ITerminalOptions`

## Re-creating the patch

If upgrading ghostty-web, re-apply these changes:

```bash
pnpm patch ghostty-web@<version>
# Make the edits listed above in the temporary directory
pnpm patch-commit <tmp-dir>
```

Both changes are in minified dist files, so find the right spots by searching
for:
- `pixelToCell` — the method that divides `A / g.width` and `B / g.height`
- `new $(this.canvas` or `new u(this.canvas` — the renderer instantiation
  (variable name depends on minification)
