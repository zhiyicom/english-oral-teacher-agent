import { useCallback, useEffect, useState } from 'react'
import { getTopics, updateTopics } from '../lib/api'
import type { TopicApi } from '../lib/api'
import LoadingSpinner from './shared/LoadingSpinner'

export default function TopicLibraryPage() {
  const [topics, setTopics] = useState<TopicApi[] | null>(null)
  const [editingTopic, setEditingTopic] = useState<string | null>(null)
  const [keywordsText, setKeywordsText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    getTopics()
      .then(setTopics)
      .catch(() => {})
  }, [])

  const startEdit = useCallback((name: string, keywords: string[]) => {
    setEditingTopic(name)
    setKeywordsText(keywords.join(', '))
  }, [])

  async function saveTopic() {
    if (!editingTopic || !topics) return
    const keywords = keywordsText
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
    const updated = topics.map((t) =>
      t.name === editingTopic ? { ...t, keywords } : t,
    )
    setTopics(updated)
    setEditingTopic(null)
    setSaving(true)
    try {
      await updateTopics(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      // Keep edit on error
    } finally {
      setSaving(false)
    }
  }

  function cancelEdit() {
    setEditingTopic(null)
  }

  if (!topics) return <LoadingSpinner text="加载话题库…" />

  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <h2 className="text-lg font-semibold text-slate-800">话题库管理</h2>
      <p className="mt-1 text-sm text-slate-500">
        编辑话题关键词以匹配摘要输出。修改后自动更新 LLM 话题库和数据库。共 {topics.length} 个话题。
      </p>

      {saved && (
        <div className="mt-2 text-sm text-green-600">已保存，重启服务端后 LLM 话题库生效</div>
      )}

      <div className="mt-4 space-y-1">
        {topics.map((t) => (
          <div
            key={t.name}
            className="rounded border border-slate-200 bg-white p-3"
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium text-sm text-slate-700">{t.description}</span>
                <span className="ml-2 text-xs text-slate-400">({t.name})</span>
              </div>
              <button
                type="button"
                onClick={() => startEdit(t.name, t.keywords)}
                className="text-xs text-blue-500 hover:text-blue-700"
              >
                编辑
              </button>
            </div>
            {editingTopic === t.name ? (
              <div className="mt-2">
                <textarea
                  value={keywordsText}
                  onChange={(e) => setKeywordsText(e.target.value)}
                  rows={3}
                  className="w-full rounded border border-blue-300 px-2 py-1 text-xs font-mono focus:outline-none"
                />
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={saveTopic}
                    disabled={saving}
                    className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="rounded border px-3 py-1 text-xs text-slate-500 hover:bg-slate-100"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1">
                {t.keywords.map((kw) => (
                  <span
                    key={kw}
                    className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500"
                  >
                    {kw}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
