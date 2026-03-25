import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import electronFlat from 'vite-plugin-electron'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

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
              external: ['node-pty'],
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
    electronFlat({
      entry: 'electron/browser-preload.ts',
      vite: {
        build: {
          lib: {
            entry: 'electron/browser-preload.ts',
            formats: ['cjs'],
            fileName: () => 'browser-preload.cjs',
          },
          outDir: 'dist-electron',
          rollupOptions: {
            output: {
              inlineDynamicImports: true,
              format: 'cjs',
              entryFileNames: 'browser-preload.cjs',
              chunkFileNames: '[name].cjs',
              assetFileNames: '[name].[ext]',
            },
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
