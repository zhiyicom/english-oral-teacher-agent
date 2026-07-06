import { useCallback, useEffect, useRef, useState } from 'react'
import { STRINGS } from '../i18n/strings'

// Browser-native SpeechRecognition (Chrome/Edge).
// Types are not in all TS DOM libs, so we use a minimal interface.
interface ISpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
  readonly error?: string
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number
  results: SpeechRecognitionResultList
}

const SpeechRecognitionCtor: (new () => ISpeechRecognition) | null =
  (window as unknown as Record<string, unknown>).SpeechRecognition as (new () => ISpeechRecognition) ??
  (window as unknown as Record<string, unknown>).webkitSpeechRecognition as (new () => ISpeechRecognition) ??
  null

export function isVoiceSupported(): boolean {
  return SpeechRecognitionCtor !== null
}

// v1.0.7 §1.1 — map Web Speech API error codes to user-facing hints.
// Replaces the v1.0.6 "Try Microsoft Edge" toast (which was misleading for
// users already on Edge — e.g. China-region Edge uses Azure CN and the real
// failure is network, not browser choice). The switch's default branch
// catches unknown / future codes safely.
function hintForError(err: string): string {
  switch (err) {
    case 'audio-capture':
      return STRINGS.voiceErrorAudioCapture
    case 'not-allowed':
      return STRINGS.voiceErrorNotAllowed
    case 'service-not-allowed':
      return STRINGS.voiceErrorServiceNotAllowed
    case 'network':
      return STRINGS.voiceErrorNetwork
    case 'no-speech':
      return STRINGS.voiceErrorNoSpeech
    case 'language-not-supported':
      return STRINGS.voiceErrorLangNotSupported
    default:
      return STRINGS.voiceErrorUnknown
  }
}

interface VoiceInputProps {
  onResult: (text: string) => void
  onInterim: (text: string) => void
  // v1.0.7 §1.2 — VoiceInput no longer renders its own hint span; the parent
  // (SessionPage) renders it above the border-t divider so it doesn't squeeze
  // the textarea. Pass null to clear.
  onHint?: (msg: string | null) => void
  lang?: string
  disabled?: boolean
}

export default function VoiceInput({
  onResult,
  onInterim,
  onHint,
  lang = 'en-US',
  disabled = false,
}: VoiceInputProps) {
  const [state, setState] = useState<'idle' | 'listening' | 'error' | 'unsupported'>(
    SpeechRecognitionCtor ? 'idle' : 'unsupported',
  )
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const recognitionRef = useRef<ISpeechRecognition | null>(null)

  const stop = useCallback(() => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setState('idle')
  }, [])

  const start = useCallback(() => {
    if (!SpeechRecognitionCtor || disabled) return
    if (recognitionRef.current) {
      stop()
      return
    }
    // v1.0.7 §1.2 — clear stale hint from a previous error so the user sees
    // immediate feedback when they retry.
    onHint?.(null)
    const rec = new SpeechRecognitionCtor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = lang

    rec.onresult = (event: SpeechRecognitionEvent) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result?.isFinal) {
          onResult(result[0]?.transcript ?? '')
        } else {
          onInterim(result[0]?.transcript ?? '')
        }
      }
    }

    rec.onerror = () => {
      const err = rec.error ?? 'unknown'
      console.error(`[VoiceInput] SpeechRecognition error: ${err}`)
      setErrorMsg(err)
      setState('error')
      recognitionRef.current = null
      onHint?.(hintForError(err))
      setTimeout(() => {
        setState('idle')
        setErrorMsg(null)
        onHint?.(null)
      }, 2500)
    }
    rec.onend = () => {
      setState('idle')
      recognitionRef.current = null
    }

    recognitionRef.current = rec
    rec.start()
    setState('listening')
  }, [lang, disabled, stop, onResult, onInterim, onHint])

  // Global hotkey from Settings — toggles the microphone
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const raw = localStorage.getItem('settings:mic_hotkey')
      if (!raw) return
      let h: { ctrl: boolean; shift: boolean; alt: boolean; key: string } | null = null
      try { h = JSON.parse(raw) } catch { return }
      if (!h?.key) return
      if (
        e.key.toLowerCase() === h.key.toLowerCase() &&
        e.ctrlKey === h.ctrl &&
        e.shiftKey === h.shift &&
        e.altKey === h.alt
      ) {
        e.preventDefault()
        start()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [start])

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop()
    }
  }, [])

  if (state === 'unsupported') return null

  let title = 'Click to speak'
  if (state === 'listening') title = 'Listening… Click to stop'
  else if (state === 'error') title = errorMsg ? `Error: ${errorMsg}` : 'Voice error'

  return (
    <button
      type="button"
      data-testid="voice-input"
      onClick={start}
      disabled={disabled}
      title={title}
      className={`rounded-full p-2 text-lg transition-all ${
        state === 'listening'
          ? 'animate-pulse bg-red-100 text-red-500'
          : state === 'error'
            ? 'bg-red-100 text-red-400'
            : 'bg-slate-100 text-slate-400 hover:bg-slate-200 hover:text-slate-600'
      } disabled:opacity-40`}
    >
      🎤
    </button>
  )
}
