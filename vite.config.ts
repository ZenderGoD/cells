import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'

// IMPORTANT: The browser preload (electron/browser-preload.cjs) is a plain CJS
// file that gets copied as-is — it must NOT be compiled by vite-plugin-electron.
//
// Why:
// - Electron sandboxed preloads require CJS (`require('electron')`). ESM `import`
//   silently fails and the preload never runs.
// - vite-plugin-electron/simple forces CJS for its preload builder, but only
//   supports a single input — we can't add a second preload there.
// - The flat vite-plugin-electron API always emits ESM when the project has
//   "type": "module", ignoring format: 'cjs'. Using lib mode causes double-build
//   corruption (two passes write to the same file).
// - The only reliable solution is to keep browser-preload.cjs as handwritten CJS
//   and copy it to dist-electron during build.
function copyBrowserPreload(): Plugin {
  const src = path.resolve(__dirname, 'electron/browser-preload.cjs')
  const dest = path.resolve(__dirname, 'dist-electron/browser-preload.cjs')
  return {
    name: 'copy-browser-preload',
    buildStart() {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['node-pty', 'adm-zip'],
            },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
      renderer: {},
    }),
    copyBrowserPreload(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
