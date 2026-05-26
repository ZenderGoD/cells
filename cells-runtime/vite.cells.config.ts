import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  root: path.resolve(__dirname, '..'),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, '../dist-cells'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'cells.html'),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../src'),
    },
  },
})
