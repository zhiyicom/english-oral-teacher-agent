import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// v1.0.1 — restore localStorage from server prefs on startup.
// localStorage may be cleared on browser restart; the server persists
// all settings in data/preferences.json and USER.md.
fetch('/api/settings')
  .then((r) => r.json())
  .then((s: Record<string, unknown>) => {
    // Restore localStorage for settings that SessionPage reads directly
    if (s.voice_enabled !== undefined) {
      localStorage.setItem('settings:voice_enabled', String(s.voice_enabled))
    }
    if (s.voice_speed !== undefined) {
      localStorage.setItem('settings:voice_speed', String(s.voice_speed))
    }
    if (s.voice_accent !== undefined) {
      localStorage.setItem('settings:voice_accent', String(s.voice_accent))
    }
    if (s.font_size !== undefined && !localStorage.getItem('settings:font_size')) {
      localStorage.setItem('settings:font_size', String(s.font_size))
      document.documentElement.style.setProperty('--font-size-base', `${s.font_size}px`)
    }
    if (s.mic_hotkey && !localStorage.getItem('settings:mic_hotkey')) {
      localStorage.setItem('settings:mic_hotkey', JSON.stringify(s.mic_hotkey))
    }
    if (s.send_hotkey && !localStorage.getItem('settings:send_hotkey')) {
      localStorage.setItem('settings:send_hotkey', JSON.stringify(s.send_hotkey))
    }
  })
  .catch(() => { /* server not ready yet — use localStorage defaults */ })

// Apply saved font size from localStorage on startup
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
