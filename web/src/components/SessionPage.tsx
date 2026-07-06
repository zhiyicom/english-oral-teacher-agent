import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { STRINGS } from '../i18n/strings'
import { getSession, getSessionStreamUrl, getSettings } from '../lib/api'
import LoadingSpinner from './shared/LoadingSpinner'
import MessageBubble from './shared/MessageBubble'
import VoiceInput from './VoiceInput'

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

// v1.0.1 — strip <tool>...</tool> blocks (internal signal) AND emoji (per SOUL Iron rule #7).
// Emoji ranges: U+1F000–1FFFF (emoticons, pictographs, symbols, transport),
// U+2600–27BF (misc symbols, dingbats), U+2300–23FF (misc technical).
// Built from a string so the unicode escapes survive JSON encoding.
const EMOJI_REGEX = new RegExp(
  '[\\u{1F000}-\\u{1FFFF}\\u{2600}-\\u{27BF}\\u{2300}-\\u{23FF}]',
  'gu',
)
function stripInternal(text: string): string {
  return text
    .replace(/<tool>[\s\S]*?<\/tool>\n?/g, '')
    .replace(EMOJI_REGEX, '')
}

export default function SessionPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()

  // v1.0.3 §1.3 — WARM_UP opener hook forwarded by MainPage / Sidebar via
  // navigation state. Read once on mount; passed on every /stream call so
  // server can use it on first turn. The ref avoids re-renders and survives
  // across the user input that triggers the actual first turn.
  const warmUpHookRef = useRef<string | null>(
    (location.state as { warmUpHook?: string | null } | null)?.warmUpHook ?? null,
  )

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

  // TTS — speak assistant text when voice is enabled.
  // Source of truth: server /api/settings (USER.md via updateSettings).
  // SessionPage reads from server on mount; SettingsPage writes to both
  // server and localStorage. localStorage is no longer consulted here
  // because that path silently broke when USER.md was edited manually or
  // restored from backup without touching localStorage (memory: "localStorage
  // Unreliable — always add server-side fallback for settings persistence").
  const [voiceEnabled, setVoiceEnabled] = useState(false)
  const [voiceSpeed, setVoiceSpeed] = useState(1)
  const [voiceAccent, setVoiceAccent] = useState('en-US')

  const voiceRef = useRef({ enabled: false, speed: 1, accent: 'en-US' })
  useEffect(() => {
    voiceRef.current = { enabled: voiceEnabled, speed: voiceSpeed, accent: voiceAccent }
  }, [voiceEnabled, voiceSpeed, voiceAccent])

  useEffect(() => {
    getSettings()
      .then((s) => {
        setVoiceEnabled(s.voice_enabled)
        setVoiceSpeed(s.voice_speed)
        setVoiceAccent(s.voice_accent)
      })
      .catch(() => {
        // server unreachable — best effort: localStorage cache from SettingsPage
        const lsEnabled = localStorage.getItem('settings:voice_enabled') === 'true'
        const lsSpeed = Number(localStorage.getItem('settings:voice_speed')) || 1
        const lsAccent = localStorage.getItem('settings:voice_accent') || 'en-US'
        setVoiceEnabled(lsEnabled)
        setVoiceSpeed(lsSpeed)
        setVoiceAccent(lsAccent)
      })
  }, [])

  function speakAssistant(text: string) {
    const v = voiceRef.current
    if (!v.enabled) return
    const clean = stripInternal(text).trim()
    if (!clean) return
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(clean)
    u.rate = v.speed
    const allVoices = speechSynthesis.getVoices()
    const localVoices = allVoices.filter((x) => 'local' in x && (x as SpeechSynthesisVoice & { local: boolean }).local)
    // "Multilingual" online voices (e.g. Microsoft Ada Multilingual Online)
    // are known to fail silently on first use and sound mechanical when they
    // do work — prefer Natural voices when falling back to online.
    const isMultilingual = (x: SpeechSynthesisVoice) => /multilingual/i.test(x.name)
    const onlineNonMulti = allVoices.filter((x) => !isMultilingual(x))
    const baseLang = v.accent.split('-')[0]
    const voice =
      localVoices.find((x) => x.lang === v.accent) ??
      localVoices.find((x) => x.lang.startsWith(`${baseLang}-`)) ??
      localVoices.find((x) => x.lang === 'en-US') ??
      localVoices.find((x) => x.lang.startsWith('en')) ??
      onlineNonMulti.find((x) => x.lang === v.accent) ??
      onlineNonMulti.find((x) => x.lang.startsWith(`${baseLang}-`)) ??
      onlineNonMulti.find((x) => x.lang === 'en-US') ??
      onlineNonMulti.find((x) => x.lang.startsWith('en')) ??
      allVoices.find((x) => x.lang === v.accent)
    if (voice) {
      u.voice = voice
      u.lang = voice.lang
    }
    speechSynthesis.speak(u)
  }

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

  // Load existing messages when resuming a session (in addition to init SSE)
  useEffect(() => {
    if (!id) return
    getSession(id)
      .then((s) => {
        if (s.messages && s.messages.length > 0) {
          const msgs: ChatMessage[] = s.messages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          }))
          setMessages(msgs)
        }
        if (s.endedAt) {
          setEnded(true)
          setPhase('END')
        }
      })
      .catch(() => {
        // Silently ignore — init SSE will still set up the session
      })
  }, [id])

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

    speechSynthesis.cancel()

    const userMsg: ChatMessage = { role: 'user', content: input }
    setMessages((prev) => [...prev, userMsg])
    setIsTurning(true)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''

    closeES()

    const url = getSessionStreamUrl(id, 'turn', input, warmUpHookRef.current)
    const es = new EventSource(url)
    esRef.current = es

    streamingRef.current = ''

    // v1.0.1 diagnostic — opt-in via localStorage('debug:web_diag=1').
    // Tracks per-turn SSE event counts + final streamingRef state, then
    // POSTs a summary to /api/diagnostic/log on `done`. Server appends
    // to the same JSONL file as turn.ts so we can correlate end-to-end.
    const diagEnabled = localStorage.getItem('debug:web_diag') === '1'
    let textChunkCount = 0
    let textChunkTotalLen = 0
    let studentTextCount = 0
    let lastStudentTextPayload = ''
    const firstEvents: Array<{ type: string; len?: number }> = []
    const recordEvent = (type: string, len?: number) => {
      if (firstEvents.length < 20) firstEvents.push(len !== undefined ? { type, len } : { type })
    }

    es.addEventListener('phase', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { phase: string }
      if (data.phase) setPhase(data.phase)
      if (diagEnabled) recordEvent('phase')
    })

    es.addEventListener('ctx', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { elapsed: number }
      if (data.elapsed !== undefined) {
        startedAtRef.current = Date.now() - data.elapsed * 60000
        setElapsedMin(data.elapsed)
      }
      if (diagEnabled) recordEvent('ctx')
    })

    es.addEventListener('text-chunk', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { delta: string }
      streamingRef.current += data.delta
      setStreamingText(stripInternal(streamingRef.current))
      if (diagEnabled) {
        textChunkCount += 1
        textChunkTotalLen += data.delta.length
        recordEvent('text-chunk', data.delta.length)
      }
    })

    es.addEventListener('student-text', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { text: string }
      // v1.0.2 — always replace, don't guard on streamingRef. The old guard
      // was a v0.8 compat shim for clients without text-chunk support; it
      // silently dropped 2nd-call responses (topic_select / memory_search /
      // summarize_history) whenever the 1st-call had streamed anything,
      // including pure <tool>...</tool> calls that strip down to empty.
      // Symptom: empty or preamble-only assistant bubble mid-session,
      // full message only visible after page refresh. See 2026-06-27
      // session ddb32b4f for a real case (11 of 33 turns affected).
      streamingRef.current = data.text
      setStreamingText(stripInternal(data.text))
      if (diagEnabled) {
        studentTextCount += 1
        lastStudentTextPayload = data.text
        recordEvent('student-text', data.text.length)
      }
    })

    es.addEventListener('done', (e) => {
      es.close()
      esRef.current = null

      const raw = streamingRef.current
      const text = stripInternal(raw).trim()
      const addedToMessages = text.length > 0
      if (text) {
        setMessages((prev) => [...prev, { role: 'assistant', content: text }])
        speakAssistant(text)
      }
      streamingRef.current = ''
      setStreamingText(null)

      const data = JSON.parse((e as MessageEvent).data) as { endedReason: string | null }
      if (data.endedReason && data.endedReason !== 'init') {
        setEnded(true)
        setPhase('END')
        window.dispatchEvent(new CustomEvent('session-ended'))
      }
      setIsTurning(false)

      if (diagEnabled) {
        recordEvent('done')
        fetch('/api/diagnostic/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: id,
            type: 'web-done',
            data: {
              endedReason: data.endedReason,
              firstEvents,
              textChunkCount,
              textChunkTotalLen,
              studentTextCount,
              lastStudentTextLen: lastStudentTextPayload.length,
              lastStudentTextHead: lastStudentTextPayload.slice(0, 200),
              finalStreamingRefLen: raw.length,
              finalStreamingRefHead: raw.slice(0, 200),
              finalStreamingRefTail: raw.length > 200 ? raw.slice(-100) : '',
              addedToMessages,
            },
          }),
        }).catch(() => {
          // best-effort
        })
      }
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
      if (diagEnabled) {
        recordEvent('error')
        fetch('/api/diagnostic/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: id,
            type: 'web-error',
            data: { firstEvents, classification: data.classification, message: data.message },
          }),
        }).catch(() => {})
      }
    })

    es.onerror = () => {
      if (!esRef.current) return
      setError(STRINGS.sessionLoadError)
      closeES()
      setIsTurning(false)
      if (diagEnabled) {
        recordEvent('onerror')
        fetch('/api/diagnostic/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: id,
            type: 'web-onerror',
            data: { firstEvents },
          }),
        }).catch(() => {})
      }
    }
  }

  function handleEnd() {
    if (!id || isTurning || ended) return
    if (inputRef.current) {
      inputRef.current.value = 'stop'
      handleSend()
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Configurable send hotkey from Settings (default: Enter)
    const raw = localStorage.getItem('settings:send_hotkey')
    let h: { ctrl: boolean; shift: boolean; alt: boolean; key: string } | null = null
    try { h = raw ? JSON.parse(raw) : null } catch { /* ignore */ }

    if (h?.key) {
      if (
        e.key.toLowerCase() === h.key.toLowerCase() &&
        e.ctrlKey === h.ctrl &&
        e.shiftKey === h.shift &&
        e.altKey === h.alt
      ) {
        e.preventDefault()
        handleSend()
        return
      }
      // If custom hotkey set, Enter alone no longer sends (Shift+Enter always newline)
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        // Enter alone = newline when custom send hotkey is set
        return
      }
    } else {
      // Default: Enter sends, Shift+Enter newline
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    }
  }

  const elapsedDisplay = `${Math.floor(elapsedMin).toString().padStart(2, '0')}:${Math.floor(
    (elapsedMin % 1) * 60,
  )
    .toString()
    .padStart(2, '0')}`

  // Global keyboard shortcuts for the session page
  useEffect(() => {
    function matchHotkey(e: KeyboardEvent, raw: string | null): boolean {
      if (!raw) return false
      let h: { ctrl: boolean; shift: boolean; alt: boolean; key: string } | null = null
      try { h = JSON.parse(raw) } catch { return false }
      if (!h?.key) return false
      return (
        e.key.toLowerCase() === h.key.toLowerCase() &&
        e.ctrlKey === h.ctrl &&
        e.shiftKey === h.shift &&
        e.altKey === h.alt
      )
    }

    function onKey(e: KeyboardEvent) {
      // Esc — navigate home
      if (e.key === 'Escape' && !isTurning) {
        navigate('/')
        return
      }
      // Skip if ended, turning, or focused on another input
      if (ended || isTurning) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      // Custom send hotkey (default: none — only textarea Enter works)
      const raw = localStorage.getItem('settings:send_hotkey')
      if (raw && matchHotkey(e, raw)) {
        e.preventDefault()
        handleSend()
        return
      }
      // Default: Enter sends when no custom hotkey set
      if (!raw && e.key === 'Enter') {
        e.preventDefault()
        handleSend()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, isTurning, ended])

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
    <div className="flex h-full flex-col">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
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
          <button
            type="button"
            onClick={() => navigate('/')}
            data-testid="back-to-main"
            className="inline-block rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            {STRINGS.backToMain}
          </button>
        </div>
      )}

      {/* Input area */}
      {!ended && (
        <div className="flex gap-2 border-t pt-3">
          <VoiceInput
            onResult={(t) => {
              if (inputRef.current) {
                inputRef.current.value = (inputRef.current.value + ' ' + t).trim()
              }
            }}
            onInterim={() => {
              // Interim results shown in input via VoiceInput component
            }}
          />
          <textarea
            ref={inputRef}
            data-testid="input-box"
            disabled={isTurning}
            placeholder={isTurning ? STRINGS.turnInProgress : STRINGS.inputPlaceholder}
            onKeyDown={handleKeyDown}
            rows={3}
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
