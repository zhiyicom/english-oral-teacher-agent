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

  // v1.0.7 §1.1 — SpeechRecognition error code → user-facing hint
  // (replaces the misleading "Try Microsoft Edge" toast introduced in v1.0.6 §1.13)
  voiceErrorAudioCapture: '无法访问麦克风',
  voiceErrorNotAllowed: '需要麦克风权限',
  voiceErrorServiceNotAllowed: '浏览器禁用了语音识别',
  voiceErrorNetwork: '识别服务不可达，请检查网络',
  voiceErrorNoSpeech: '没有听到声音',
  voiceErrorLangNotSupported: '暂不支持该语言',
  voiceErrorUnknown: '语音输入出错，请重试',

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
  voiceAccentEnUS: '英语（美）',
  voiceAccentEnGB: '英语（英）',
  settingsDisplay: '显示',
  settingsFontSize: '字体大小',
  settingsShowDebug: '显示调试信息',
  settingsSave: '保存',
  settingsSaved: '已保存',
  settingsSaving: '保存中…',
  settingsCancel: '取消',
  settingsVoiceDisabled: 'v0.9+ 可用',

  // v1.0.8 §1.2 — Settings 语音源下拉 + §1.3 无匹配提示
  settingsVoiceSource: '语音源',
  voiceSourceLocal: '本地语音',
  voiceSourceOnline: '在线语音',
  voiceSourceNoMatchLocal: '本机没有 "{accent}" 的本地语音，请切换语音源或调整口音',
  voiceSourceNoMatchOnline: '没有可用的在线 "{accent}" 语音，请切换语音源或调整口音',

  // v1.0.6 §1.6 — SetupPage
  setupWelcome: '首次设置',
  setupApiKeyLabel: '请输入你的 API Key。可从你的 LLM 服务商获取。',
  setupApiKeyPlaceholder: 'sk-...',
  setupContinue: '继续',
  setupSaving: '保存中…',
  setupStudentProfile: '学生档案',
  setupName: '姓名',
  setupAge: '年龄',
  setupLevel: '英语水平',
  setupLevelBeginner: 'Beginner (初级)',
  setupLevelIntermediate: 'Intermediate (中级)',
  setupLevelAdvanced: 'Advanced (高级)',
  setupGoals: '学习目标（逗号分隔）',
  setupInterests: '兴趣爱好（逗号分隔）',
  setupBack: '上一步',
  setupFinish: '完成设置',
} as const
