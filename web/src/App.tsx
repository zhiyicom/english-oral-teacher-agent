import { useEffect, useState } from 'react'
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom'
import HistoryPage from './components/HistoryPage.tsx'
import SessionPage from './components/SessionPage.tsx'
import SettingsPage from './components/SettingsPage.tsx'
import SessionSidebar from './components/SessionSidebar.tsx'
import SetupPage from './components/SetupPage.tsx'
import TopicLibraryPage from './components/TopicLibraryPage.tsx'

function WelcomePage() {
  return (
    <div className="flex h-full items-center justify-center text-slate-400">
      <p>选择左侧会话或点击「开始新练习」</p>
    </div>
  )
}

function SetupGate({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    if (window.location.pathname.startsWith('/setup')) {
      setChecked(true)
      return
    }
    fetch('/api/setup/status')
      .then((r) => r.json())
      .then((s) => {
        if (s.needsApiKey) {
          navigate('/setup', { replace: true })
        }
      })
      .catch(() => { /* network error: let through, may fail later */ })
      .finally(() => setChecked(true))
  }, [navigate])

  if (!checked) return null
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <SetupGate>
        <div className="flex h-screen bg-white">
          <SessionSidebar />
          <div className="flex-1 overflow-y-auto">
            <Routes>
              <Route path="/" element={<WelcomePage />} />
              <Route path="/session/:id" element={<SessionPage />} />
              <Route path="/history/:id" element={<HistoryPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/topics" element={<TopicLibraryPage />} />
              <Route path="/setup" element={<SetupPage />} />
            </Routes>
          </div>
        </div>
      </SetupGate>
    </BrowserRouter>
  )
}
