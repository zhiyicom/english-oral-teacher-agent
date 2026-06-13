import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { STRINGS } from '../i18n/strings'
import { getSettings, updateSettings } from '../lib/api'
import type { SettingsApi } from '../lib/types'

const LS_FONT_SIZE = 'settings:font_size'
const LS_SHOW_DEBUG = 'settings:show_debug'

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsApi | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    getSettings()
      .then((srv) => {
        const fontSize = Number(localStorage.getItem(LS_FONT_SIZE)) || srv.font_size
        const showDebug = localStorage.getItem(LS_SHOW_DEBUG) === 'true' || srv.show_debug
        setSettings({ ...srv, font_size: fontSize, show_debug: showDebug })
      })
      .catch((e: Error) => setError(e.message))
  }, [])

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
      })
      localStorage.setItem(LS_FONT_SIZE, String(settings.font_size))
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
    return (
      <div className="py-16 text-center text-slate-500" data-testid="loading">
        {STRINGS.loading}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg">
      <Link to="/" className="text-sm text-slate-500 hover:text-slate-700">
        &larr; {STRINGS.navHome}
      </Link>

      {/* Voice section (disabled — v0.9+) */}
      <div className="mt-4 rounded border bg-white p-4 opacity-60 shadow-sm">
        <h3 className="text-sm font-medium text-slate-400">
          {STRINGS.settingsVoice}{' '}
          <span className="text-xs text-slate-300">({STRINGS.settingsVoiceDisabled})</span>
        </h3>

        <div className="mt-3 flex items-center justify-between">
          <label className="text-sm text-slate-500" htmlFor="voice-enabled">
            {STRINGS.settingsVoiceEnabled}
          </label>
          <button
            id="voice-enabled"
            type="button"
            data-testid="voice-toggle"
            disabled
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
            disabled
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
            disabled
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

      {/* Error banner */}
      {error && (
        <div
          className="mt-4 rounded border border-red-300 bg-red-50 p-2"
          data-testid="error-banner"
        >
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Save */}
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
        {saved && (
          <span className="text-sm text-green-600" data-testid="saved-toast">
            {STRINGS.settingsSaved}
          </span>
        )}
      </div>
    </div>
  )
}
