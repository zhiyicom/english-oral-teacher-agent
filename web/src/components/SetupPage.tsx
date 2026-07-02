import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

type Step = 'apiKey' | 'profile'

export default function SetupPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('apiKey')
  const [apiKey, setApiKey] = useState('')
  const [runLiveLlm, setRunLiveLlm] = useState(true)
  const [profile, setProfile] = useState<{
    name: string; age: number; level: 'beginner' | 'intermediate' | 'advanced';
    goals: string[]; interests: string[];
  }>({
    name: '', age: 13, level: 'intermediate',
    goals: [], interests: [],
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
                body: JSON.stringify({ apiKey, runLiveLlm }),
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
            请输入你的 API Key。可从你的 LLM 服务商获取。
          </p>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="w-full rounded border px-3 py-2"
            autoFocus
            required
          />
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={runLiveLlm}
              onChange={(e) => setRunLiveLlm(e.target.checked)}
              className="rounded"
            />
            启用在线 LLM（需要网络连接）
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
