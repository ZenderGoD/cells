/**
 * Re-exports non-component functions from cell-terminal.tsx.
 *
 * Vite's React Fast Refresh requires that .tsx files only export React
 * components/hooks. Exporting plain functions like applyThemeToAllTerminals
 * from cell-terminal.tsx causes HMR to fall back to a full page reload.
 *
 * Consumers that only need the utility functions (e.g. store.ts) should
 * import from here instead of cell-terminal.tsx directly.
 */
export {
  applyThemeToAllTerminals,
  destroyCachedTerminal,
  getCachedTerminalCount,
  getTerminalPreviewSnapshot,
  getTerminalRestoreSnapshot,
  reloadAllTerminals,
  reloadTerminal,
} from './cell-terminal'
