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
  historyTitle: '历史记录',
  settingsTitle: '设置',

  // v0.8.3 — SessionPage
  sessionTitle: '练习中',
  send: '发送',
  endSession: '结束本次',
  backToMain: '返回主界面',
  phaseWarmUp: '热身',
  phaseMainActivity: '主体练习',
  phaseWrapUp: '总结',
  phaseEnd: '已结束',
  sessionEnded: '本次练习已结束',
  inputPlaceholder: '输入你的回答…',
  turnInProgress: '老师正在回复…',
  sessionLoadError: '加载会话失败',
  voiceListening: '点击停止录音',
  voiceNotSupported: '浏览器不支持语音',
  voiceStart: '点击开始说话',

  // v0.8.4 — HistoryPage
  historyDate: '日期',
  historyDuration: '时长',
  historySummary: '摘要',
  historyKeywords: '关键词',
  historyPhaseHistory: '阶段历程',
  historyMessages: '对话记录',
  historyNoMessages: '暂无对话记录',

  // v0.8.4 — SettingsPage
  settingsVoice: '语音',
  settingsVoiceEnabled: '语音开关',
  settingsVoiceSpeed: '语速',
  settingsVoiceAccent: '口音',
  settingsDisplay: '显示',
  settingsFontSize: '字体大小',
  settingsShowDebug: '显示调试信息',
  settingsSave: '保存',
  settingsSaved: '已保存',
  settingsSaving: '保存中…',
  settingsCancel: '取消',
  settingsVoiceDisabled: 'v0.9+ 可用',
} as const
