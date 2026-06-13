import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { STRINGS } from '../i18n/strings'
import { getSessionStreamUrl } from '../lib/api'
import LoadingSpinner from './shared/LoadingSpinner'
import MessageBubble from './shared/MessageBubble'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

const PHASE_LABELS: Record<string, string> = {
  WARM_UP: STRINGS.phaseWarmUp,
  MAIN_ACTIVITY: STRINGS.phaseMainActivity,
  WRAP_UP: STRINGS.phaseWrapUp,
  END: STRINGS.phaseEnd,
}

export default function SessionPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [phase, setPhase] = useState<string>('WARM_UP')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isTurning, setIsTurning] = useState(false)
  const [ended, setEnded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [elapsedMin, setElapsedMin] = useState(0)
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const streamingRef = useRef('')
  const startedAtRef = useRef<number>(Date.now())
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  // Auto-scroll to bottom when messages change
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Timer — ticks every second until session ends
  useEffect(() => {
    if (ended) return
    const timer = setInterval(() => {
      setElapsedMin((Date.now() - startedAtRef.current) / 60000)
    }, 1000)
    return () => clearInterval(timer)
  }, [ended])

  const closeES = useCallback(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
  }, [])

  // Init SSE connection on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: closeES is stable (useCallback with [])
  useEffect(() => {
    if (!id) return
    const url = getSessionStreamUrl(id, 'init')
    const es = new EventSource(url)
    esRef.current = es

    es.addEventListener('phase', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { phase: string; elapsed: number }
      setPhase(data.phase)
      if (data.elapsed !== undefined) {
        startedAtRef.current = Date.now() - data.elapsed * 60000
        setElapsedMin(data.elapsed)
      }
    })

    es.addEventListener('done', () => {
      es.close()
      esRef.current = null
      setReady(true)
    })

    es.onerror = () => {
      setError(STRINGS.sessionLoadError)
      es.close()
      esRef.current = null
    }

    return () => {
      es.close()
    }
  }, [id, closeES])

  async function handleSend() {
    if (!id || isTurning || ended) return
    const input = inputRef.current?.value.trim()
    if (!input) return

    const userMsg: ChatMessage = { role: 'user', content: input }
    setMessages((prev) => [...prev, userMsg])
    setIsTurning(true)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''

    closeES()

    const url = getSessionStreamUrl(id, 'turn', input)
    const es = new EventSource(url)
    esRef.current = es

    streamingRef.current = ''

    es.addEventListener('phase', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { phase: string }
      if (data.phase) setPhase(data.phase)
    })

    es.addEventListener('ctx', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { elapsed: number }
      if (data.elapsed !== undefined) {
        startedAtRef.current = Date.now() - data.elapsed * 60000
        setElapsedMin(data.elapsed)
      }
    })

    es.addEventListener('text-chunk', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { delta: string }
      streamingRef.current += data.delta
      setStreamingText(streamingRef.current)
    })

    es.addEventListener('student-text', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { text: string }
      // Backward compat: if no text-chunk arrived, use student-text as fallback
      if (!streamingRef.current) {
        streamingRef.current = data.text
        setStreamingText(data.text)
      }
    })

    es.addEventListener('done', (e) => {
      es.close()
      esRef.current = null

      if (streamingRef.current) {
        setMessages((prev) => [...prev, { role: 'assistant', content: streamingRef.current }])
      }
      streamingRef.current = ''
      setStreamingText(null)

      const data = JSON.parse((e as MessageEvent).data) as { endedReason: string | null }
      if (data.endedReason && data.endedReason !== 'init') {
        setEnded(true)
        setPhase('END')
      }
      setIsTurning(false)
    })

    es.addEventListener('error', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        classification: string
        message: string
      }
      setError(data.message || 'SSE error')
      es.close()
      esRef.current = null
      setIsTurning(false)
    })

    es.onerror = () => {
      if (!esRef.current) return
      setError(STRINGS.sessionLoadError)
      closeES()
      setIsTurning(false)
    }
  }

  function handleEnd() {
    if (!id || isTurning || ended) return
    if (inputRef.current) {
      inputRef.current.value = 'exit'
      handleSend()
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const elapsedDisplay = `${Math.floor(elapsedMin).toString().padStart(2, '0')}:${Math.floor(
    (elapsedMin % 1) * 60,
  )
    .toString()
    .padStart(2, '0')}`

  // Esc key — confirm then navigate home
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isTurning) {
        navigate('/')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, isTurning])

  // ---- Loading ----
  if (!ready && !error) {
    return <LoadingSpinner text={STRINGS.loading} />
  }

  // ---- Error on init ----
  if (error && !ready) {
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

  // ---- Active / Ended ----
  return (
    <div className="flex flex-col h-[calc(100vh-6rem)]">
      {/* Header bar */}
      <div className="mb-3 flex items-center justify-between border-b pb-3">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm text-slate-500 hover:text-slate-700">
            &larr; {STRINGS.navHome}
          </Link>
          <span
            data-testid="phase-tag"
            className="rounded-full bg-blue-100 px-3 py-0.5 text-xs font-medium text-blue-700"
          >
            {PHASE_LABELS[phase] || phase}
          </span>
          <span className="font-mono text-sm text-slate-400">{elapsedDisplay}</span>
        </div>
        {!ended && (
          <button
            type="button"
            onClick={handleEnd}
            data-testid="end-button"
            disabled={isTurning}
            className="rounded border border-red-300 px-3 py-1 text-sm text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            {STRINGS.endSession}
          </button>
        )}
      </div>

      {/* Message list */}
      <div className="flex-1 space-y-3 overflow-y-auto pb-4">
        {messages.map((msg, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: messages append-only
          <MessageBubble key={i} role={msg.role} content={msg.content} />
        ))}
        {isTurning && streamingText && (
          <div className="flex justify-start">
            <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-gray-100 px-4 py-2 text-gray-900">
              {streamingText}
              <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-blue-500 align-text-bottom" />
            </div>
          </div>
        )}
        {isTurning && !streamingText && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-400">
              {STRINGS.turnInProgress}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Error banner (in-session) */}
      {error && ready && (
        <div
          className="mb-2 rounded border border-red-300 bg-red-50 p-2"
          data-testid="error-banner"
        >
          <p className="text-sm text-red-700">{error}</p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="mt-1 text-xs text-red-500 underline"
          >
            {STRINGS.retry}
          </button>
        </div>
      )}

      {/* Ended state */}
      {ended && (
        <div className="border-t pt-3 text-center" data-testid="session-ended">
          <p className="mb-2 text-slate-500">{STRINGS.sessionEnded}</p>
          <Link
            to="/"
            data-testid="back-to-main"
            className="inline-block rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            {STRINGS.backToMain}
          </Link>
        </div>
      )}

      {/* Input area */}
      {!ended && (
        <div className="flex gap-2 border-t pt-3">
          <textarea
            ref={inputRef}
            data-testid="input-box"
            disabled={isTurning}
            placeholder={isTurning ? STRINGS.turnInProgress : STRINGS.inputPlaceholder}
            onKeyDown={handleKeyDown}
            rows={2}
            className="flex-1 resize-none rounded border border-slate-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none disabled:bg-slate-100 disabled:text-slate-400"
          />
          <button
            type="button"
            onClick={handleSend}
            data-testid="send-button"
            disabled={isTurning}
            className="self-end rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {STRINGS.send}
          </button>
        </div>
      )}
    </div>
  )
}
