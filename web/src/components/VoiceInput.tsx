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
  // v1.0.8 §13.3 — 改为接收 event 参数；error 在 event 上而非 instance 上
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number
  results: SpeechRecognitionResultList
}

// v1.0.8 §13.3 — 新增：W3C SpeechRecognitionErrorEvent 接口
// W3C spec: error 在 event 对象上，instance 上的 error 是 Chromium 私有扩展
// 且在 Edge 150 / Chromium 150 上通常为空
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string
  readonly message: string
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
  // v1.0.8 §13.4 — 追踪本轮识别是否出过错，让 onend 不覆盖错误态
  const erroredRef = useRef(false)

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

    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      // v1.0.8 §13.4 — Bug #1 修复：从 event.error 读取真实错误码（不再读 rec.error）
      const err = event.error ?? 'unknown'
      console.error(`[VoiceInput] SpeechRecognition error: ${err}`, event.message ?? '')

      // v1.0.8 §13.4 — aborted = 用户主动 stop（rec.stop() 触发），不弹错误
      if (err === 'aborted') {
        setState('idle')
        setErrorMsg(null)
        recognitionRef.current = null
        return
      }

      setErrorMsg(err)
      setState('error')
      // v1.0.8 §13.4 — 标记本轮已出错，让 onend 不要覆盖错误态
      erroredRef.current = true
      onHint?.(hintForError(err))
      setTimeout(() => {
        setState('idle')
        setErrorMsg(null)
        onHint?.(null)
        // 重置标记，让下一轮识别干净
        erroredRef.current = false
      }, 2500)
    }
    rec.onend = () => {
      recognitionRef.current = null
      // v1.0.8 §13.4 — Bug #4 修复：仅在无错时才清状态
      // 出错时错误态由 onerror 的 2.5s timer 统一清空
      if (!erroredRef.current) {
        setState('idle')
      }
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
