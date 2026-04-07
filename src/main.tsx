import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { App } from './app'
import { loadBundledTerminalFonts } from './lib/load-terminal-fonts'
import './globals.css'

async function bootstrap() {
  const shouldBootstrapReload =
    window.location.protocol === 'file:' &&
    sessionStorage.getItem('cells-renderer-bootstrap-reloaded') !== '1'

  await loadBundledTerminalFonts()

  if (shouldBootstrapReload) {
    sessionStorage.setItem('cells-renderer-bootstrap-reloaded', '1')
    window.location.reload()
    return
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <HotkeysProvider>
        <App />
      </HotkeysProvider>
    </StrictMode>,
  )
}

void bootstrap()
