import { BrowserRouter, Route, Routes } from 'react-router-dom'
import HistoryPage from './components/HistoryPage.tsx'
import SessionPage from './components/SessionPage.tsx'
import SettingsPage from './components/SettingsPage.tsx'
import SessionSidebar from './components/SessionSidebar.tsx'
import TopicLibraryPage from './components/TopicLibraryPage.tsx'

function WelcomePage() {
  return (
    <div className="flex h-full items-center justify-center text-slate-400">
      <p>选择左侧会话或点击「开始新练习」</p>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen bg-white">
        <SessionSidebar />
        <div className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<WelcomePage />} />
            <Route path="/session/:id" element={<SessionPage />} />
            <Route path="/history/:id" element={<HistoryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/topics" element={<TopicLibraryPage />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  )
}
