# Legacy Electron Runtime

The Electron runtime is deprecated.

Cells now uses the NW.js-based runtime as the primary development, packaging, and release path:

- `pnpm dev`
- `pnpm build`
- `pnpm pack`
- `pnpm release`

Files in this directory are retained only for the explicit legacy Electron commands:

- `pnpm dev:legacy-electron`
- `pnpm build:legacy-electron`
- `pnpm pack:legacy-electron`
- `pnpm release:legacy-electron`

Do not add new product behavior here. New runtime work should land in `cells-runtime/`,
`src/nw-main.tsx`, and `src/nw-cells-adapter.ts`. If a legacy Electron fix is still needed,
keep it scoped to preserving the old launcher or extracting behavior into shared code that the
NW.js runtime can use.

Some files in this directory still contain useful historical implementations for terminals,
agents, browser views, extension compatibility, and updater behavior. Treat them as legacy
reference code unless an explicit `legacy-electron` script is being maintained.
