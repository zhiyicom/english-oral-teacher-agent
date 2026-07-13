import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

type Step = 'apiKey' | 'profile'

export default function SetupPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('apiKey')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [defaultBaseUrl, setDefaultBaseUrl] = useState('https://api.minimaxi.com/anthropic')
  const [defaultModel, setDefaultModel] = useState('MiniMax-M3')
  // v1.0.8 §1.7 — wizard exposes API 协议 as the first LLM-related dropdown.
  const [apiStyle, setApiStyle] = useState<'anthropic' | 'openai'>('anthropic')
  const [profile, setProfile] = useState<{
    name: string; age: number; level: 'beginner' | 'intermediate' | 'advanced';
    goals: string[]; interests: string[];
  }>({
    name: '', age: 13, level: 'intermediate',
    goals: [], interests: [],
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/setup/status')
      .then((r) => r.json())
      .then((s: {
        baseUrl?: string; model?: string; apiStyle?: string
      }) => {
        if (typeof s.baseUrl === 'string' && s.baseUrl.trim()) setDefaultBaseUrl(s.baseUrl.trim())
        if (typeof s.model === 'string' && s.model.trim()) setDefaultModel(s.model.trim())
        // v1.0.8 §1.7 — surface the persisted api_style so the wizard matches Settings.
        if (s.apiStyle === 'anthropic' || s.apiStyle === 'openai') {
          setApiStyle(s.apiStyle)
        }
      })
      .catch(() => {})
  }, [])

  async function fetchDefaults() {
    try {
      const r = await fetch('/api/setup/profile-default')
      const d = (await r.json()) as {
        name?: string; age?: number; level?: string; goals?: string[]; interests?: string[]
      }
      const lvl = d.level
      const level: 'beginner' | 'intermediate' | 'advanced' =
        lvl === 'beginner' || lvl === 'advanced' ? lvl : 'intermediate'
      setProfile({
        name: d.name ?? '',
        age: typeof d.age === 'number' ? d.age : 13,
        level,
        goals: d.goals ?? [],
        interests: d.interests ?? [],
      })
    } catch { /* fallback to current state */ }
  }

  if (step === 'apiKey') {
    return (
      <div className="flex h-full items-center justify-center">
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true); setError(null)
            try {
              const r = await fetch('/api/setup/api-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  apiKey,
                  apiStyle,
                  baseUrl: baseUrl.trim() || undefined,
                  model: model.trim() || undefined,
                }),
              })
              if (!r.ok) throw new Error((await r.json()).error ?? 'failed')
              setApiKey('')
              await fetchDefaults()
              setStep('profile')
            } catch (err) {
              setError((err as Error).message)
            } finally { setBusy(false) }
          }}
          className="w-full max-w-md space-y-4 p-6"
        >
          <h2 className="text-xl font-semibold">Welcome — 首次设置</h2>
          <p className="text-sm text-slate-600">
            请输入你的 API Key 和 LLM 配置信息。
          </p>

          <label className="block">
            <span className="text-sm text-slate-700">API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="mt-1 w-full rounded border px-3 py-2"
              autoFocus
              required
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-700">API 协议</span>
            <select
              value={apiStyle}
              onChange={(e) => setApiStyle(e.target.value as 'anthropic' | 'openai')}
              className="mt-1 w-full rounded border px-3 py-2"
            >
              <option value="anthropic">Anthropic 兼容 (x-api-key) — 默认</option>
              <option value="openai">OpenAI 兼容 (Bearer) — DeepSeek / OpenAI</option>
            </select>
          </label>

          <label className="block">
            <span className="text-sm text-slate-700">Base URL</span>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={defaultBaseUrl}
              className="mt-1 w-full rounded border px-3 py-2 placeholder:text-slate-400"
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-700">模型</span>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={defaultModel}
              className="mt-1 w-full rounded border px-3 py-2 placeholder:text-slate-400"
            />
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={busy || !apiKey}
            className="w-full rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          >
            {busy ? '保存中…' : '继续'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center">
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true); setError(null)
          try {
            const r = await fetch('/api/setup/profile', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(profile),
            })
            if (!r.ok) throw new Error((await r.json()).error ?? 'failed')
            navigate('/')
          } catch (err) {
            setError((err as Error).message)
          } finally { setBusy(false) }
        }}
        className="w-full max-w-md space-y-4 p-6"
      >
        <h2 className="text-xl font-semibold">学生档案</h2>
        <label className="block">
          <span className="text-sm text-slate-700">姓名</span>
          <input
            value={profile.name}
            onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            className="mt-1 w-full rounded border px-3 py-2"
            required
          />
        </label>
        <label className="block">
          <span className="text-sm text-slate-700">年龄</span>
          <input
            type="number"
            min={3}
            max={120}
            value={profile.age}
            onChange={(e) => setProfile({ ...profile, age: Number(e.target.value) })}
            className="mt-1 w-full rounded border px-3 py-2"
            required
          />
        </label>
        <label className="block">
          <span className="text-sm text-slate-700">英语水平</span>
          <select
            value={profile.level}
            onChange={(e) => {
              const v = e.target.value
              setProfile({ ...profile, level: v === 'beginner' || v === 'advanced' ? v : 'intermediate' })
            }}
            className="mt-1 w-full rounded border px-3 py-2"
          >
            <option value="beginner">Beginner (初级)</option>
            <option value="intermediate">Intermediate (中级)</option>
            <option value="advanced">Advanced (高级)</option>
          </select>
        </label>
        <label className="block">
          <span className="text-sm text-slate-700">学习目标（逗号分隔）</span>
          <input
            value={profile.goals.join(', ')}
            onChange={(e) => setProfile({ ...profile, goals: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        <label className="block">
          <span className="text-sm text-slate-700">兴趣爱好（逗号分隔）</span>
          <input
            value={profile.interests.join(', ')}
            onChange={(e) => setProfile({ ...profile, interests: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setStep('apiKey')}
            className="flex-1 rounded border px-4 py-2"
          >上一步</button>
          <button
            type="submit"
            disabled={busy}
            className="flex-1 rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          >{busy ? '保存中…' : '完成设置'}</button>
        </div>
      </form>
    </div>
  )
}
