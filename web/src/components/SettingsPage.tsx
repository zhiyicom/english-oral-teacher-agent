import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { STRINGS } from '../i18n/strings'
import { getSettings, updateSettings } from '../lib/api'
import type { SettingsApi } from '../lib/types'
import HotkeyInput, { type Hotkey, parseHotkey } from './HotkeyInput'
import LoadingSpinner from './shared/LoadingSpinner'

const LS_FONT_SIZE = 'settings:font_size'
const LS_SHOW_DEBUG = 'settings:show_debug'
const LS_VOICE_ENABLED = 'settings:voice_enabled'
const LS_VOICE_SPEED = 'settings:voice_speed'
const LS_VOICE_ACCENT = 'settings:voice_accent'
const LS_MIC_HOTKEY = 'settings:mic_hotkey'
const LS_SEND_HOTKEY = 'settings:send_hotkey'

export default function SettingsPage() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<SettingsApi | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [micHotkey, setMicHotkey] = useState<Hotkey | null>(
    () => parseHotkey(localStorage.getItem(LS_MIC_HOTKEY)),
  )
  const [sendHotkey, setSendHotkey] = useState<Hotkey | null>(
    () => parseHotkey(localStorage.getItem(LS_SEND_HOTKEY)),
  )
  const [apiKey, setApiKey] = useState('')

  useEffect(() => {
    getSettings()
      .then((srv) => {
        const fontSize = Number(localStorage.getItem(LS_FONT_SIZE)) || srv.font_size
        const showDebug = localStorage.getItem(LS_SHOW_DEBUG) === 'true' || srv.show_debug
        const voiceEnabled = localStorage.getItem(LS_VOICE_ENABLED) === 'true' || srv.voice_enabled
        const voiceSpeed = Number(localStorage.getItem(LS_VOICE_SPEED)) || srv.voice_speed
        const voiceAccent = localStorage.getItem(LS_VOICE_ACCENT) || srv.voice_accent
        setSettings({
          ...srv,
          font_size: fontSize,
          show_debug: showDebug,
          voice_enabled: voiceEnabled,
          voice_speed: voiceSpeed,
          voice_accent: voiceAccent,
          run_live_llm: srv.run_live_llm ?? false,
          base_url: srv.base_url ?? '',
          model: srv.model ?? '',
        })

        // Hotkeys: localStorage first, server fallback
        const micFromLocal = parseHotkey(localStorage.getItem(LS_MIC_HOTKEY))
        const sendFromLocal = parseHotkey(localStorage.getItem(LS_SEND_HOTKEY))
        setMicHotkey(micFromLocal ?? (srv.mic_hotkey as Hotkey | null))
        setSendHotkey(sendFromLocal ?? (srv.send_hotkey as Hotkey | null))
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  // Save hotkeys to localStorage immediately whenever they change
  useEffect(() => {
    if (micHotkey) localStorage.setItem(LS_MIC_HOTKEY, JSON.stringify(micHotkey))
  }, [micHotkey])

  useEffect(() => {
    if (sendHotkey) localStorage.setItem(LS_SEND_HOTKEY, JSON.stringify(sendHotkey))
  }, [sendHotkey])

  const updateField = useCallback(<K extends keyof SettingsApi>(key: K, value: SettingsApi[K]) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev))
  }, [])

  async function handleSave() {
    if (!settings) return
    setSaving(true)
    setError(null)
    try {
      await updateSettings({
        voice_enabled: settings.voice_enabled,
        voice_speed: settings.voice_speed,
        voice_accent: settings.voice_accent,
        font_size: settings.font_size,
        show_debug: settings.show_debug,
        run_live_llm: settings.run_live_llm,
        base_url: settings.base_url,
        model: settings.model,
        api_key: apiKey || undefined,
        mic_hotkey: micHotkey as unknown as Record<string, unknown>,
        send_hotkey: sendHotkey as unknown as Record<string, unknown>,
      })
      localStorage.setItem(LS_FONT_SIZE, String(settings.font_size))
      document.documentElement.style.setProperty('--font-size-base', `${settings.font_size}px`)
      localStorage.setItem(LS_VOICE_ENABLED, String(settings.voice_enabled))
      localStorage.setItem(LS_VOICE_SPEED, String(settings.voice_speed))
      localStorage.setItem(LS_VOICE_ACCENT, settings.voice_accent)
      if (settings.show_debug) {
        localStorage.setItem(LS_SHOW_DEBUG, 'true')
      } else {
        localStorage.removeItem(LS_SHOW_DEBUG)
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (error && !settings) {
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

  if (!settings) {
    return <LoadingSpinner text={STRINGS.loading} />
  }

  return (
    <div className="mx-auto max-w-lg px-6 py-4">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="mb-3 text-sm text-blue-500 hover:text-blue-700"
      >
        ← 返回
      </button>
      {/* Voice section */}
      <div className="mt-4 rounded border bg-white p-4 shadow-sm">
        <h3 className="text-sm font-medium text-slate-700">
          {STRINGS.settingsVoice}
        </h3>

        <div className="mt-3 flex items-center justify-between">
          <label className="text-sm text-slate-500" htmlFor="voice-enabled">
            {STRINGS.settingsVoiceEnabled}
          </label>
          <button
            id="voice-enabled"
            type="button"
            data-testid="voice-toggle"
            className={`rounded-full px-3 py-1 text-xs ${
              settings.voice_enabled ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500'
            }`}
            onClick={() => updateField('voice_enabled', !settings.voice_enabled)}
          >
            {settings.voice_enabled ? 'ON' : 'OFF'}
          </button>
        </div>

        <div className="mt-3">
          <label className="text-sm text-slate-500" htmlFor="voice-speed">
            {STRINGS.settingsVoiceSpeed}: {settings.voice_speed}
          </label>
          <input
            id="voice-speed"
            type="range"
            min="0.5"
            max="2.0"
            step="0.1"
            value={settings.voice_speed}
            onChange={(e) => updateField('voice_speed', Number(e.target.value))}
            className="mt-1 w-full"
          />
        </div>

        <div className="mt-3">
          <label className="text-sm text-slate-500" htmlFor="voice-accent">
            {STRINGS.settingsVoiceAccent}
          </label>
          <select
            id="voice-accent"
            value={settings.voice_accent}
            onChange={(e) => updateField('voice_accent', e.target.value)}
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-1 text-sm disabled:bg-slate-50"
          >
            <option value="en-US">en-US</option>
            <option value="en-GB">en-GB</option>
          </select>
        </div>
      </div>

      {/* Display section */}
      <div className="mt-4 rounded border bg-white p-4 shadow-sm">
        <h3 className="text-sm font-medium text-slate-700">{STRINGS.settingsDisplay}</h3>

        <div className="mt-3">
          <label className="text-sm text-slate-500" htmlFor="font-size">
            {STRINGS.settingsFontSize}: {settings.font_size}px
          </label>
          <input
            id="font-size"
            type="range"
            min="12"
            max="20"
            step="1"
            value={settings.font_size}
            onChange={(e) => updateField('font_size', Number(e.target.value))}
            className="mt-1 w-full"
          />
        </div>

        <div className="mt-3 flex items-center justify-between">
          <label className="text-sm text-slate-500" htmlFor="show-debug">
            {STRINGS.settingsShowDebug}
          </label>
          <button
            id="show-debug"
            type="button"
            data-testid="debug-toggle"
            className={`rounded-full px-3 py-1 text-xs ${
              settings.show_debug ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500'
            }`}
            onClick={() => updateField('show_debug', !settings.show_debug)}
          >
            {settings.show_debug ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* LLM section */}
      <div className="mt-4 rounded border bg-white p-4 shadow-sm">
        <h3 className="text-sm font-medium text-slate-700">LLM</h3>
        <div className="mt-3 flex items-center justify-between">
          <label className="text-sm text-slate-500" htmlFor="run-live-llm">
            Live LLM
          </label>
          <button
            id="run-live-llm"
            type="button"
            data-testid="live-llm-toggle"
            className={`rounded-full px-3 py-1 text-xs ${
              settings.run_live_llm ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500'
            }`}
            onClick={() => updateField('run_live_llm', !settings.run_live_llm)}
          >
            {settings.run_live_llm ? 'ON' : 'OFF'}
          </button>
        </div>
        <div className="mt-3">
          <label className="text-sm text-slate-500" htmlFor="api-key">
            API Key
          </label>
          <input
            id="api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-1 text-sm placeholder:text-slate-400"
            placeholder="输入新 key 以替换，留空则不修改"
          />
        </div>
        <div className="mt-3">
          <label className="text-sm text-slate-500" htmlFor="base-url">
            Base URL
          </label>
          <input
            id="base-url"
            type="text"
            value={settings.base_url}
            onChange={(e) => updateField('base_url', e.target.value)}
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-1 text-sm"
            placeholder="https://api.minimaxi.com/anthropic"
          />
        </div>
        <div className="mt-3">
          <label className="text-sm text-slate-500" htmlFor="model-main">
            模型
          </label>
          <input
            id="model-main"
            type="text"
            value={settings.model}
            onChange={(e) => updateField('model', e.target.value)}
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-1 text-sm placeholder:text-slate-400"
            placeholder="MiniMax-M3"
          />
        </div>
      </div>

      {/* Hotkeys */}
      <div className="mt-4 rounded border bg-white p-4 shadow-sm">
        <h3 className="text-sm font-medium text-slate-700">快捷键</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <label className="text-slate-500">麦克风</label>
            <div className="mt-1">
              <HotkeyInput
                value={micHotkey}
                onChange={(h) => {
                  setMicHotkey(h)
                  localStorage.setItem(LS_MIC_HOTKEY, JSON.stringify(h))
                }}
                placeholder="Ctrl+Shift+M"
              />
            </div>
          </div>
          <div>
            <label className="text-slate-500">发送消息</label>
            <div className="mt-1">
              <HotkeyInput
                value={sendHotkey}
                onChange={(h) => {
                  setSendHotkey(h)
                  localStorage.setItem(LS_SEND_HOTKEY, JSON.stringify(h))
                }}
                placeholder="Enter"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="mt-4 rounded border border-red-300 bg-red-50 p-2"
          data-testid="error-banner"
        >
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Save / Cancel */}
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          data-testid="save-button"
          className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {saving ? STRINGS.settingsSaving : STRINGS.settingsSave}
        </button>
        <button
          type="button"
          onClick={() => navigate('/')}
          data-testid="cancel-button"
          className="rounded border border-slate-300 bg-white px-4 py-2 text-slate-700 hover:bg-slate-100"
        >
          {STRINGS.settingsCancel}
        </button>
        {saved && (
          <span className="text-sm text-green-600" data-testid="saved-toast">
            {STRINGS.settingsSaved}
          </span>
        )}
      </div>
    </div>
  )
}
