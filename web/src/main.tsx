import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// v0.8.5 — apply saved font size from localStorage on startup
const savedFontSize = localStorage.getItem('settings:font_size')
if (savedFontSize) {
  document.documentElement.style.setProperty('--font-size-base', `${savedFontSize}px`)
}

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Root element #root not found in index.html')
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
