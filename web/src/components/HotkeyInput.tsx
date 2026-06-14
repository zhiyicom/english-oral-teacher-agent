import { useState } from 'react'

export interface Hotkey {
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string
}

export function formatHotkey(h: Hotkey | null): string {
  if (!h || !h.key) return '未设置'
  const parts: string[] = []
  if (h.ctrl) parts.push('Ctrl')
  if (h.shift) parts.push('Shift')
  if (h.alt) parts.push('Alt')
  parts.push(h.key.length === 1 ? h.key.toUpperCase() : h.key)
  return parts.join('+')
}

export function parseHotkey(json: string | null): Hotkey | null {
  if (!json) return null
  try {
    return JSON.parse(json) as Hotkey
  } catch {
    return null
  }
}

export function hotkeyMatch(e: KeyboardEvent, h: Hotkey | null): boolean {
  if (!h || !h.key) return false
  return (
    e.key.toLowerCase() === h.key.toLowerCase() &&
    e.ctrlKey === h.ctrl &&
    e.shiftKey === h.shift &&
    e.altKey === h.alt
  )
}

interface HotkeyInputProps {
  value: Hotkey | null
  onChange: (h: Hotkey) => void
  placeholder?: string
}

export default function HotkeyInput({ value, onChange, placeholder }: HotkeyInputProps) {
  const [capturing, setCapturing] = useState(false)

  function handleCapture(e: React.KeyboardEvent<HTMLButtonElement>) {
    e.preventDefault()
    const key = e.key
    // Ignore modifier-only presses
    if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return

    onChange({
      ctrl: e.ctrlKey || e.metaKey,
      shift: e.shiftKey,
      alt: e.altKey,
      key,
    })
    setCapturing(false)
  }

  return (
    <button
      type="button"
      className={`rounded border px-3 py-1 text-sm font-mono ${
        capturing
          ? 'border-blue-400 bg-blue-50 text-blue-600'
          : 'border-slate-300 text-slate-600 hover:border-slate-400'
      }`}
      onClick={() => setCapturing(true)}
      onBlur={() => setCapturing(false)}
      onKeyDown={capturing ? handleCapture : undefined}
    >
      {capturing ? '按下快捷键…' : (formatHotkey(value) || placeholder || '点击设置')}
    </button>
  )
}
