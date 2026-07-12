import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { createSession, deleteSession, listSessions } from '../lib/api'
import type { SessionApi } from '../lib/types'
import { STRINGS } from '../i18n/strings'
import { VERSION } from '../version'

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

  // v1.0.4 §1.5 — a session row is "active" both when the user is in the
  // live conversation page AND when they're reviewing that session's
  // transcript on the history detail page. Previously /history/:id did
  // not match, leaving the sidebar without a highlight while the user
  // was staring at the corresponding session on the right.
  const activeId = location.pathname.startsWith('/session/')
    ? location.pathname.slice('/session/'.length)
    : location.pathname.startsWith('/history/')
      ? location.pathname.slice('/history/'.length)
      : null

  const refresh = useCallback(() => {
    listSessions()
      .then(setSessions)
      .catch(() => {})
  }, [])

  // Refresh on initial mount.
  useEffect(() => {
    refresh()
  }, [refresh])

  // v1.0.8 §1.6 — refresh when a session ends (custom event from SessionPage).
  useEffect(() => {
    const handler = () => refresh()
    window.addEventListener('session-ended', handler)
    return () => window.removeEventListener('session-ended', handler)
  }, [refresh])

  async function handleDelete(e: { stopPropagation: () => void }, id: string) {
    e.stopPropagation()
    try {
      await deleteSession(id)
      refresh()
    } catch {
      // keep list on error
    }
  }

  async function handleNew() {
    setCreating(true)
    try {
      const { id, warmUpHook } = await createSession()
      // v1.0.3 §1.3 — forward warmUpHook via navigation state.
      navigate(`/session/${id}`, { state: { warmUpHook } })
      // v1.0.8 §1.6 — refresh sidebar directly. Previous attempts:
      //   (1) pathname-change useEffect — fired but inconsistently across
      //       race conditions with React Router
      //   (2) window.dispatchEvent('session-created') — listener didn't run
      //       because Playwright + Chromium handle the dispatch differently
      // Calling refresh() directly is unambiguous and gives us the timing
      // we need (immediately after navigate).
      refresh()
    } catch {
      // Keep button enabled on error
    } finally {
      setCreating(false)
    }
  }

  const groups = groupByDate(sessions)

  return (
    <aside className="flex h-screen w-72 flex-col border-r border-slate-200 bg-slate-50">
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
                  className={`group relative w-full px-3 py-2 text-left text-sm transition-colors hover:bg-slate-200 ${
                    // v1.0.4 §1.5 — strong gray highlight (slate-300 on
                    // slate-50 sidebar bg) replaces the previous blue-50
                    // which was too low-contrast to read at a glance.
                    // Bottom nav (Topics / Settings) keeps blue-50 to keep
                    // a visible distinction between "session data view"
                    // (gray row) and "page nav" (blue button).
                    isActive ? 'bg-slate-300 text-slate-900 font-medium' : 'text-slate-700'
                  }`}
                >
                  <div className="truncate pr-5">
                    {s.summary
                      ? s.summary.length > 35
                        ? `${s.summary.slice(0, 35)}…`
                        : s.summary
                      : s.endedAt
                        ? '已结束（摘要生成中…）'
                        : `${STRINGS.sessionTitle} #${s.id.slice(0, 8)}`}
                  </div>
                  {s.durationMin !== null && (
                    <div className="text-xs text-slate-400">
                      {s.durationMin}{STRINGS.minutesShort}
                    </div>
                  )}
                  <span
                    role="button"
                    tabIndex={0}
                    data-testid="delete-session"
                    onClick={(e) => handleDelete(e, s.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleDelete(e, s.id)
                    }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 hidden rounded px-1.5 py-0.5 text-xs text-red-400 hover:bg-red-50 hover:text-red-600 group-hover:inline-block"
                  >
                    &times;
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* Settings + Topics */}
      <div className="border-t border-slate-200 p-3 space-y-1">
        <button
          type="button"
          onClick={() => navigate('/topics')}
          className={`w-full rounded px-3 py-2 text-left text-sm transition-colors hover:bg-slate-200 ${
            location.pathname === '/topics' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-600'
          }`}
        >
          话题库
        </button>
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

      {/* Version tag */}
      <div className="border-t border-slate-200 px-3 py-1.5 text-xs text-slate-400">
        {VERSION}
      </div>
    </aside>
  )
}
