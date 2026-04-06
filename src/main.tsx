import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { App } from './app'
import { loadBundledTerminalFonts } from './lib/load-terminal-fonts'
import { refreshAllTerminalFonts } from './components/terminal/terminal-cache-api'
import './globals.css'

async function bootstrap() {
  await loadBundledTerminalFonts()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <HotkeysProvider>
        <App />
      </HotkeysProvider>
    </StrictMode>,
  )

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      refreshAllTerminalFonts()
    })
  })
}

void bootstrap()
