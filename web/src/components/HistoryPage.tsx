import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { STRINGS } from '../i18n/strings'
import { getSession } from '../lib/api'
import type { SessionMessage } from '../lib/types'
import LoadingSpinner from './shared/LoadingSpinner'
import MessageBubble from './shared/MessageBubble'

const PHASE_LABELS: Record<string, string> = {
  WARM_UP: STRINGS.phaseWarmUp,
  MAIN_ACTIVITY: STRINGS.phaseMainActivity,
  WRAP_UP: STRINGS.phaseWrapUp,
  END: STRINGS.phaseEnd,
}

export default function HistoryPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const [session, setSession] = useState<{
    startedAt: string
    durationMin: number | null
    phaseHistory: string[]
    summary: string | null
    keywords: string[]
    messages?: SessionMessage[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    getSession(id)
      .then((s) => setSession(s))
      .catch((e: Error) => setError(e.message))
  }, [id])

  if (error) {
    return (
      <div className="rounded border border-red-300 bg-red-50 p-4" data-testid="error-banner">
        <p className="text-red-700">
          {STRINGS.errorPrefix}: {error}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-2 rounded bg-red-600 px-3 py-1 text-white"
        >
          {STRINGS.retry}
        </button>
      </div>
    )
  }

  if (!session) {
    return <LoadingSpinner text={STRINGS.loading} />
  }

  const messages: SessionMessage[] = session.messages ?? []
  const phaseLabels = session.phaseHistory.map((p) => PHASE_LABELS[p] || p).join(' → ')

  return (
    <div className="px-6 py-4">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="mb-3 text-sm text-blue-500 hover:text-blue-700"
      >
        ← 返回
      </button>

      {/* Metadata card */}
      <div className="mt-4 rounded border bg-white p-4 shadow-sm">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-slate-400">{STRINGS.historyDate}</span>
            <p className="text-slate-700">{new Date(session.startedAt).toLocaleString()}</p>
          </div>
          <div>
            <span className="text-slate-400">{STRINGS.historyDuration}</span>
            <p className="text-slate-700">
              {session.durationMin !== null
                ? `${session.durationMin} ${STRINGS.minutesShort}`
                : '—'}
            </p>
          </div>
        </div>

        {session.summary && (
          <div className="mt-3">
            <span className="text-sm text-slate-400">{STRINGS.historySummary}</span>
            <p className="text-slate-700">{session.summary}</p>
          </div>
        )}

        {session.keywords.length > 0 && (
          <div className="mt-3">
            <span className="text-sm text-slate-400">{STRINGS.historyKeywords}</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {session.keywords.map((k) => (
                <span
                  key={k}
                  className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                >
                  {k}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="mt-3">
          <span className="text-sm text-slate-400">{STRINGS.historyPhaseHistory}</span>
          <p className="font-mono text-xs text-slate-500">{phaseLabels}</p>
        </div>
      </div>

      {/* Message transcript */}
      <h3 className="mb-3 mt-6 text-lg font-semibold text-slate-800">{STRINGS.historyMessages}</h3>

      {messages.length === 0 ? (
        <p className="text-slate-400">{STRINGS.historyNoMessages}</p>
      ) : (
        <div className="space-y-3">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} role={msg.role} content={msg.content} timestamp={msg.ts} />
          ))}
        </div>
      )}
    </div>
  )
}
