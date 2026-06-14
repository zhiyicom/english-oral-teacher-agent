import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { createSession, listSessions } from '../lib/api'
import type { SessionApi } from '../lib/types'
import { STRINGS } from '../i18n/strings'

function groupByDate(sessions: SessionApi[]): { label: string; items: SessionApi[] }[] {
  const now = Date.now()
  const day = 86400000
  const today: SessionApi[] = []
  const yesterday: SessionApi[] = []
  const older: SessionApi[] = []

  for (const s of sessions) {
    const age = now - new Date(s.startedAt).getTime()
    if (age < day) today.push(s)
    else if (age < 2 * day) yesterday.push(s)
    else older.push(s)
  }

  const groups: { label: string; items: SessionApi[] }[] = []
  if (today.length) groups.push({ label: '今天', items: today })
  if (yesterday.length) groups.push({ label: '昨天', items: yesterday })
  if (older.length) groups.push({ label: '更早', items: older })
  return groups
}

export default function SessionSidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const [sessions, setSessions] = useState<SessionApi[]>([])
  const [creating, setCreating] = useState(false)

  const activeId = location.pathname.startsWith('/session/')
    ? location.pathname.slice('/session/'.length)
    : null

  const refresh = useCallback(() => {
    listSessions()
      .then(setSessions)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Refresh when navigating back to root (session ended/created)
  useEffect(() => {
    if (location.pathname === '/') refresh()
  }, [location.pathname, refresh])

  async function handleNew() {
    setCreating(true)
    try {
      const { id } = await createSession()
      navigate(`/session/${id}`)
    } catch {
      // Keep button enabled on error
    } finally {
      setCreating(false)
    }
  }

  const groups = groupByDate(sessions)

  return (
    <aside className="flex h-screen w-64 flex-col border-r border-slate-200 bg-slate-50">
      {/* App title */}
      <div className="border-b border-slate-200 px-3 py-2">
        <h1 className="text-sm font-semibold text-slate-800">
          {STRINGS.appTitle}
        </h1>
      </div>

      {/* New session button */}
      <div className="border-b border-slate-200 p-3">
        <button
          type="button"
          onClick={handleNew}
          disabled={creating}
          data-testid="start-button"
          className="w-full rounded bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {creating ? '...' : STRINGS.startPractice}
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.label} className="mb-1">
            <div className="px-3 py-2 text-xs font-medium text-slate-400">
              {group.label}
            </div>
            {group.items.map((s) => {
              const isActive = activeId === s.id
              return (
                <button
                  key={s.id}
                  type="button"
                  data-testid="session-row"
                  onClick={() => {
                    const target = s.endedAt ? `/history/${s.id}` : `/session/${s.id}`
                    navigate(target)
                  }}
                  className={`w-full px-3 py-2 text-left text-sm transition-colors hover:bg-slate-200 ${
                    isActive ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700'
                  }`}
                >
                  <div className="truncate">
                    {s.summary
                      ? s.summary.length > 35
                        ? `${s.summary.slice(0, 35)}…`
                        : s.summary
                      : `${STRINGS.sessionTitle} #${s.id.slice(0, 8)}`}
                  </div>
                  {s.durationMin !== null && (
                    <div className="text-xs text-slate-400">
                      {s.durationMin}{STRINGS.minutesShort}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* Settings link */}
      <div className="border-t border-slate-200 p-3">
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className={`w-full rounded px-3 py-2 text-left text-sm transition-colors hover:bg-slate-200 ${
            location.pathname === '/settings' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-600'
          }`}
        >
          {STRINGS.navSettings}
        </button>
      </div>
    </aside>
  )
}
