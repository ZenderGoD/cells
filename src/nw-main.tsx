import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { installNwCellsAdapter } from './nw-cells-adapter'
import './globals.css'

async function bootstrap() {
  installNwCellsAdapter()
  document.documentElement.classList.add('cells-runtime-nw')
  const { App } = await import('./app')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <HotkeysProvider>
        <App />
      </HotkeysProvider>
    </StrictMode>,
  )
}

void bootstrap()
