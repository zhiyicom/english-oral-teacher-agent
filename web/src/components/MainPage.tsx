import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { STRINGS } from '../i18n/strings'
import { createSession, listSessions } from '../lib/api.ts'
import type { SessionApi } from '../lib/types.ts'
import LoadingSpinner from './shared/LoadingSpinner'

export default function MainPage() {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<SessionApi[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let cancelled = false
    listSessions()
      .then((list) => {
        if (!cancelled) setSessions(list)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleStart() {
    setCreating(true)
    try {
      const { id } = await createSession()
      navigate(`/session/${id}`)
    } catch (e) {
      setError((e as Error).message)
      setCreating(false)
    }
  }

  if (error) {
    return (
      <div className="rounded border border-red-300 bg-red-50 p-4" data-testid="error-banner">
        <p className="text-red-700">
          {STRINGS.errorPrefix}: {error}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-2 rounded bg-red-600 px-3 py-1 text-white hover:bg-red-700"
        >
          {STRINGS.retry}
        </button>
      </div>
    )
  }

  if (sessions === null) {
    return <LoadingSpinner text={STRINGS.loading} />
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleStart}
        disabled={creating}
        data-testid="start-button"
        className="rounded bg-blue-600 px-4 py-2 text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
      >
        {STRINGS.startPractice}
      </button>

      {sessions.length === 0 ? (
        <p className="mt-8 text-slate-500" data-testid="empty-state">
          {STRINGS.emptyState}
        </p>
      ) : (
        <ul className="mt-8 space-y-3" data-testid="session-list">
          {sessions.map((s, i) => {
            const idx = sessions.length - i
            return (
              <li
                key={s.id}
                data-testid="session-row"
                className="cursor-pointer rounded border border-slate-200 bg-white p-4 shadow-sm hover:shadow"
                onClick={() => navigate(`/history/${s.id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    navigate(`/history/${s.id}`)
                  }
                }}
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-sm text-slate-500">
                    #{idx} · {new Date(s.startedAt).toLocaleString()}
                  </span>
                  {s.durationMin !== null && (
                    <span className="text-sm text-slate-500">
                      {s.durationMin} {STRINGS.minutesShort}
                    </span>
                  )}
                </div>
                {s.summary && (
                  <p className="mt-2 text-slate-700">
                    {s.summary.length > 80 ? `${s.summary.slice(0, 80)}…` : s.summary}
                  </p>
                )}
                {s.keywords.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {s.keywords.map((k) => (
                      <span
                        key={k}
                        className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                      >
                        {k}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
