// v0.8.2 — Chinese-first UI strings. English stubs are placeholders.
// Full i18n switching (toggle UI + complete en translations) is v0.8.5.
export const STRINGS = {
  appTitle: 'English Oral Teacher',
  appSubtitle: '英语口语练习',

  // MainPage
  startPractice: '开始新练习',
  loading: '加载中…',
  emptyState: '暂无练习记录 — 开始第一次练习吧',
  errorPrefix: '加载失败',
  retry: '重试',
  minutesShort: '分钟',

  // Header
  navHome: '主界面',
  navSettings: '设置',

  // Placeholder pages
  sessionTitle: '练习中',
  historyTitle: '历史记录',
  settingsTitle: '设置',
  placeholderSession: (id: string) => `Session #${id} — 对话窗口将在 v0.8.3 实现`,
  placeholderHistory: (id: string) => `Session #${id} — 历史详情将在 v0.8.4 实现`,
  placeholderSettings: '设置面板将在 v0.8.4 实现',
} as const
