import { useCallback, useEffect, useRef, useState } from 'react'

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

interface VoiceInputProps {
  onResult: (text: string) => void
  onInterim: (text: string) => void
  lang?: string
  disabled?: boolean
}

export default function VoiceInput({
  onResult,
  onInterim,
  lang = 'en-US',
  disabled = false,
}: VoiceInputProps) {
  const [state, setState] = useState<'idle' | 'listening' | 'unsupported'>(
    SpeechRecognitionCtor ? 'idle' : 'unsupported',
  )
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

    rec.onerror = () => stop()
    rec.onend = () => {
      setState('idle')
      recognitionRef.current = null
    }

    recognitionRef.current = rec
    rec.start()
    setState('listening')
  }, [lang, disabled, stop, onResult, onInterim])

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

  return (
    <button
      type="button"
      data-testid="voice-input"
      onClick={start}
      disabled={disabled}
      title={state === 'listening' ? 'Listening… Click to stop' : 'Click to speak'}
      className={`rounded-full p-2 text-lg transition-all ${
        state === 'listening'
          ? 'animate-pulse bg-red-100 text-red-500'
          : 'bg-slate-100 text-slate-400 hover:bg-slate-200 hover:text-slate-600'
      } disabled:opacity-40`}
    >
      🎤
    </button>
  )
}
