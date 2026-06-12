import { BrowserRouter, Route, Routes } from 'react-router-dom'
import HistoryPage from './components/HistoryPage.tsx'
import MainPage from './components/MainPage.tsx'
import SessionPage from './components/SessionPage.tsx'
import SettingsPage from './components/SettingsPage.tsx'
import Header from './components/shared/Header.tsx'

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-slate-50">
        <Header />
        <main className="mx-auto max-w-4xl px-4 py-8">
          <Routes>
            <Route path="/" element={<MainPage />} />
            <Route path="/session/:id" element={<SessionPage />} />
            <Route path="/history/:id" element={<HistoryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
