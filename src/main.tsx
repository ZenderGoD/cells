import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { App } from './app'
import './globals.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HotkeysProvider>
      <App />
    </HotkeysProvider>
  </StrictMode>,
)
