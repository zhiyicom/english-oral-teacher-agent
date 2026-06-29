# English Oral Teacher — 用户手册

> 最后更新：2026-06-28
> 当前版本：v1.0.4
>
> 本文档随每次正式发布更新，是标准产品交付文档。

---

## 1. 安装部署

### 1.1 基础环境要求

| 组件 | 最低版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22.0 | JavaScript 运行时 |
| pnpm | ≥ 9.0 | 包管理器（推荐通过 `corepack enable` 启用）|
| Git | ≥ 2.40 | 版本控制（可选，仅开发需要）|
| 操作系统 | Windows 10+ / macOS 12+ / Linux | — |
| 磁盘空间 | ≥ 2 GB | 含 node_modules 和模型文件（首次启动时下载）|

### 1.2 浏览器要求

| 浏览器 | 最低版本 | 语音输入 (STT) | 语音输出 (TTS) |
|---|---|---|---|
| Chrome | ≥ 120 | 支持（中国区可能受限）| 全支持 |
| Edge | ≥ 120 | 全支持 | 全支持 |
| Firefox | ≥ 120 | 不支持 | 全支持 |
| Safari | ≥ 17 | 部分支持 | 全支持 |

- 语音输入依赖浏览器 `SpeechRecognition` API（Chrome/Edge 完全支持，Firefox 不支持）
- 语音输出依赖 `SpeechSynthesis` API（所有现代浏览器支持）
- **推荐使用 Edge 浏览器**以体验完整语音功能
- **重要**：`SpeechRecognition` API 的后端服务由浏览器厂商提供，不同浏览器走不同云端：
  - **Chrome** → Google Cloud Speech（中国区可能无法访问）
  - **Edge** → Microsoft Azure Speech（中国区可访问）
  - **Safari** → Apple Siri 引擎
  - 代码不绑定任何后端——浏览器自己决定调用哪个服务。如果你在中国，建议使用 Edge 来获得稳定的语音识别

### 1.3 安装步骤

**Step 1：克隆项目**

```bash
git clone <repo-url>
cd English-oral-teacher-Agent
```

**Step 2：安装依赖**

```bash
pnpm install
pnpm --dir web install
```

**Step 3：配置环境变量**

复制 `.env.example` 为 `.env`，至少填入 API Key（其他项可保持默认）：

```env
# 必填：LLM 厂商 API 密钥
API_KEY=你的API密钥

# 可选：设为 1 使用真实 LLM（不设默认 replay 模式，无需 API 调用）
RUN_LIVE_LLM=1

# 可选：设为 1 记录完整 LLM 请求日志到 data/llm-debug/
DEBUG_LOG_LLM=0

# 默认端口（Hono server 监听端口）
PORT=3000
```

`API_KEY` 留空也能启动 server，但实际对话会失败并返回 401。

**Step 4：安装 Playwright 浏览器（仅 E2E 测试需要）**

```bash
npx playwright install chromium
```

### 1.4 启动方式

**开发模式（推荐新手）**：同时启动 Hono server (3000) + Vite dev server (5173)，前者提供 API+SSE，后者提供 Web UI 的 HMR 热重载。

```bash
pnpm dev-web
```

浏览器访问 `http://localhost:5173`（自动通过 Vite 代理转发 `/api/*` 和 `/assets/*` 到 3000）。

**仅启动 Hono server**：仅 3000 端口（API + SSE + 已构建的 web 静态资源）。

```bash
pnpm serve    # tsx watch src/server.ts，开发态
```

**生产模式（单端口）**：先构建前端，再启动 server（v1.0.5.1 §1.1 起 `pnpm start` 直接起 server；CLI 改用 `pnpm cli`）。

```bash
pnpm build         # pnpm --dir web build && tsc && pnpm build:copy-assets → dist/web/ + dist/storage/migrations/
pnpm start         # node dist/server.js，单进程 3000 端口 serve SPA + API
```

浏览器访问 `http://localhost:3000`。

**CLI 模式**（无 Web UI，直接在终端对话）：

```bash
pnpm dev           # tsx watch src/cli.ts
# 或
pnpm build && pnpm cli     # node dist/cli.js
```

### 1.5 验证安装

```bash
# 健康检查
curl http://localhost:3000/api/health
# 返回: {"ok":true,"sessions":0,...}

# 类型检查
pnpm typecheck

# 运行测试
pnpm test          # vitest 单测
pnpm test:e2e      # Playwright 端到端（需先 install chromium）
```

---

## 2. 界面与对话

### 2.1 界面布局

界面分为左右两栏：

- **左侧（侧边栏）**：标题"English Oral Teacher" + [开始新练习] 按钮 + 按日期分组的会话列表 + 底部导航（话题库 / 设置）。当前查看的会话行用**强灰底**（`bg-slate-300`）高亮（v1.0.4 §1.5）；底部导航按钮用**浅蓝底**（`bg-blue-50`）高亮以示区分。鼠标悬停在某条会话上会出现红色 **×** 按钮，点击**直接删除**该会话（v1.0.3 §1.1，无二次确认）。
- **右侧（主内容区）**：根据当前路由显示对话窗口、历史记录、设置或话题库编辑器。

### 2.2 开始新对话

点击左侧 [开始新练习] 按钮：

1. 前端调用 `POST /api/sessions` 创建空会话
2. server 响应 `{ id, warmUpHook }`（`warmUpHook` 是上一会话结束时 LLM 抽取的暖场关键词，可能为 `null`）
3. 浏览器跳转到 `/session/:id`，首轮自动开始 WARM_UP 阶段，老师会基于 `warmUpHook`（或上次会话摘要）开场
4. 当 LLM 回复你消息时，对话正常流转

### 2.3 继续已有对话

在左侧会话列表中点击**未结束**的会话（没有结束时间的），右侧显示对话窗口，可以继续聊天。

### 2.4 查看历史记录

点击**已结束**的会话，右侧显示该会话的完整 transcript（只读），包含会话摘要、关键词、阶段历程和所有对话消息。

### 2.5 删除会话

将鼠标移到左侧会话项上，出现红色的 **×** 按钮。点击**直接删除**该会话（v1.0.3 起无确认对话框），session 行 + 所有 messages 记录 + 关联 mistakes + 缓存的 WARM_UP 种子（若该 session 是最近一次有摘要的）一并清空。

---

## 3. 对话功能

### 3.1 发送消息

- **点击 [发送] 按钮** 发送消息
- **按 Enter 键**：在对话页面任意位置按 Enter 即可发送（无需先点击输入框）
- **Shift + Enter**：在输入框中换行
- **自定义发送快捷键**：在设置中配置（见 §4.3）

### 3.2 语音输入（STT）

- 输入框左侧有 🎤 按钮
- 点击开始录音，再次点击停止
- 说话内容自动转为文字填入输入框
- 需要 Chrome 浏览器（使用浏览器内置 SpeechRecognition API）
- **快捷键**（可自定义）：在设置中配置麦克风快捷键

### 3.3 语音朗读（TTS）

- 在设置中开启"语音开关"后，老师的每条回复会自动朗读
- 语速（0.5-2.0）和口音（en-US / en-GB）可在设置中调整
- 发送新消息时自动停止当前朗读

### 3.4 实时流式显示

老师的回复会逐字显示（打字机效果，输入框旁显示"老师正在回复…"并锁定），通过 SSE 的 `text-chunk` 事件实现真正的逐字流式（v0.8.5 落地）。

### 3.5 结束对话

- 点击顶栏 [结束本次] 按钮 → server 触发 `stop` → 老师回复告别 → 会话立即结束（v1.0.1 起 END 阶段立即 return，避免无限告别循环）
- 或输入 "stop" / "end" / "bye" / "结束" / "停" 等关键词手动结束（严格的整句正则，匹配 `^stop.` / `OK. stop` 等整句，不匹配 `let's stop and continue`）
- 30 分钟到 → 系统自动触发 WRAP_UP → 老师做总结 → END 告别
- 会话结束后显示"本次练习已结束"，可点击 [返回主界面]

### 3.6 会话阶段

系统自动管理 4 个阶段，对话顶栏显示当前阶段标签和计时器：

| 阶段 | 时间 | 行为 |
|---|---|---|
| 热身 (WARM_UP) | 0-5 分钟 | 轻松寒暄、引用上一会话的 `warmUpHook` 关键词开场（v1.0.3）|
| 主体练习 (MAIN_ACTIVITY) | 5-25 分钟 | 进入阶段时强制调用 `topic_select` 工具选题；`W_KEYWORD=0.05` keyword-freshness 偏置优先选关键词命中少的 topic（v1.0.2）|
| 总结 (WRAP_UP) | 25-30 分钟 | 总结进步、鼓励、布置练习；`profile-extractor` 自动抽取兴趣 + `nextWarmUpSeed`（v1.0.3）|
| 结束 (END) | 30+ 分钟 | 温暖告别；`endSession` 流水线：summarize → markEnded → embedding → keyword_hits 统计 → profile-extract → USER.md 更新（v1.0.1）|

阶段切换时会向前缀注入完整 `[System Context]` 块和阶段 Reminder 文本，**打断 LLM 惯性**（v1.0.1）。

---

## 4. 设置功能

点击左侧底部 [设置] 进入。

### 4.1 语音设置

| 设置 | 说明 | 默认值 |
|---|---|---|
| 语音开关 | ON = 老师回复自动朗读 | OFF |
| 语速 | 0.5（慢）~ 2.0（快）| 1.0 |
| 口音 | en-US（美式）/ en-GB（英式）| en-US |

修改后点击 [保存]，即时生效（写入 `prompts/USER.md` frontmatter + localStorage + `data/preferences.json` 服务端备份，浏览器重启不丢）。

### 4.2 显示设置

| 设置 | 说明 | 默认值 |
|---|---|---|
| 字体大小 | 12-20px 滑块 | 14px |
| 显示调试信息 | ON = 显示 v1.0.2 引入的 turn-level 诊断日志 | OFF |

字体大小保存后实时生效（通过 CSS 变量 `--font-size-base` 控制）。

### 4.3 快捷键设置

| 快捷键 | 功能 | 默认 |
|---|---|---|
| 麦克风 | 开关语音输入 | 未设置（建议 Ctrl+Shift+M）|
| 发送消息 | 发送当前输入 | 未设置（默认 Enter 直接发送）|

点击快捷键输入框 → 按下想要的组合键 → 自动捕获。设置后点击 [保存]。

### 4.4 表单行为（v1.0.3 §1.2）

- 点击 [保存] → PUT `/api/settings` → 字段写入 USER.md + preferences.json
- 点击 [取消] → 丢弃未保存的改动，表单回滚到上次保存的值
- 离开页面时若有未保存改动，提示"是否放弃更改"

---

## 5. 话题库管理

点击左侧底部 [话题库] 进入。

- 显示所有话题（默认 30 个，按 text-library.md 分类）及其关键词标签
- **每个话题名右侧显示 `(N)`** —— 该话题已被讨论过的次数（v1.0.2 引入）
- **每个关键词 chip 内显示 `(N)`** —— 该 keyword 在历史会话中被命中过的次数（v1.0.2 引入）
- 点击 [编辑] 进入编辑模式，可修改 `name` / `keywords` / `description`
- 点击 [保存] → PUT `/api/topics` → 字段白名单过滤（`hitCount` / `keywordHits` 等只读统计字段被丢弃，防止误覆盖数据库）
- 话题按 A1-A2（初学者）/ B1（中级）/ B2（中高级）三级分类

**选题算法（v1.0.2 + v1.0.3）**：

系统在 MAIN_ACTIVITY 阶段会**优先选择讨论次数最少的话题**，评分函数：

```
score = -count*0.1  -  avgKeywordHit*0.05  +  interest*0.5  +  noise
       \_________/      \________________/    \_________/    \____/
        讨论次数惩罚      关键词命中新鲜度         兴趣匹配      抖动
```

- v1.0.3 §1.3 起，`interest` 项**默认禁用**（`useInterestBoost: false`）—— 兴趣匹配改由 WARM_UP 阶段 prompt 引导，不再参与算法评分
- 工具返回 `suggested_keyword`（命中次数最低的关键词）作为开场的软提示

---

## 6. 会话记忆

### 6.1 跨会话摘要

每个会话结束时，系统自动（endSession 流水线）：

1. **summarize** —— 调用 summarizer agent 生成 `{summary, keywords}`，写入 `sessions` 表
2. **markEnded** —— 写入 `ended_at` 时间戳
3. **embedding** —— `summary` → 384 维向量（本地 MiniLM-L6-v2 q8）→ 写入 `sessions.embedding` BLOB
4. **keyword_hits 统计** —— 把本会话的 `keywords` per-(topic, keyword) 累加到 `keyword_hits` 表
5. **topic_stats 更新** —— 匹配的话题 `discussion_count += 1`、`last_discussed_at = now`
6. **profile-extract** —— 从 `summary` 自动提取学生新信息（技能、兴趣）+ `nextWarmUpSeed`（1-3 词开场关键词），更新 `USER.md` frontmatter
7. **pendingWarmUpSeed 缓存** —— `nextWarmUpSeed` 缓存在 server 模块级变量，下次 `POST /api/sessions` 时返回

### 6.2 下次会话

新建会话时，`POST /api/sessions` 返回 `{id, warmUpHook}`，Web 在首次 `GET /api/sessions/:id/stream?action=turn&warmUpHook=...` 时把它作为 WARM_UP 阶段 hint 注入。Context 注入器（`src/agent/context-injector.ts`）生成 Block 1 上一会话：

```
[Last Session — pointer only]
date: 2026-06-28  duration: 28 min
keywords: basketball, anime, school, Roblox, pizza, weekend
(full summary in opening user message)
```

摘要全文保留在 WARM_UP 首轮合成的 user message（`Messages[0]`）—— 是 LLM 唯一阅读入口（v1.0.4 §1.2 单一来源）。

### 6.3 错误收集

- `mark_mistake` 工具：LLM 标记的语法/用词错误，存 `mistakes` 表，可在历史详情页看到
- `MIN_TOPIC_AGE=5` 强制约束：当前 topic 累计 ≥ 5 轮用户发言才允许切换（v1.0.2 Bug A 修复）；显式"换话题"/"switch topic"请求旁路
- `TOPIC_AGE_MIN=0` env var 可禁用该 gate（仅测试用）

---

## 7. 调试功能

### 7.1 LLM 请求日志

在 `.env` 文件中添加：

```env
DEBUG_LOG_LLM=1
```

重启服务后，每次发给 LLM 的完整请求（system prompt + 消息历史）写入 `data/llm-debug/` 目录。每个文件以时间戳 + 会话 ID + 轮次命名。

### 7.2 摘要日志

同样需要 `DEBUG_LOG_LLM=1`，每次会话结束后的摘要结果写入 `data/llm-debug/*_summarize.txt`。

### 7.3 Turn 级诊断（v1.0.2 起）

`src/llm/debug-log.ts` 的 `logTurnDiagnostic()` 在以下 4 个事件点写 JSONL per-turn snapshot 到 `data/llm-debug/<sessionId>_diag.jsonl`：

1. 1st-call done（LLM 首次响应后）
2. 2nd-call done（tool call 后跟进的二次调用后）
3. topic-select blocked（topic_select 工具被 MIN_TOPIC_AGE gate 拒绝）
4. turn done（整个 turn 完成）

Web 端可选 opt-in：localStorage 写入 `debug:web_diag=1` 后，SSE 事件追踪会 `POST /api/diagnostic/log` 上报到 server。

### 7.4 Live LLM 模式

在 `.env` 文件中设置：

```env
RUN_LIVE_LLM=1
API_KEY=你的API密钥
```

默认使用 replay 模式（无须 API key，用于测试）。Live 模式调用真实 LLM。

---

## 8. 提示词编辑

所有系统提示词都可以直接编辑 `.md` 文件（在 `prompts/` 目录），重启服务端后生效。

**进入主系统 prompt 的文件**（`buildSystemString()` 拼装顺序，参见 `src/prompts/loader.ts:135-144`）：

| 文件 | 加载后 | 作用 |
|---|---|---|
| `prompts/SOUL.md` | `# SOUL` 块（自带头部）| AI 角色身份、铁律、语气 |
| `prompts/AGENTS.md` | `# AGENTS` 块（自带头部）| 操作手册（怎么选话题、怎么记错）|
| `prompts/USER.md` | `# STUDENT` 块（自带头部）| 学生档案（系统自动补充）|
| `prompts/tools.md` | `# TOOLS` 块（自带头部，可选）| 工具使用规范（供 LLM 参考）|

> **v1.0.4 §1.1 变更**：loader 不再硬拼 `# SOUL` / `# AGENTS` / `# STUDENT` / `# TOOLS` 前缀。每个文件的 H1 必须在文件**自身**的第一行。如果手工编辑导致任一文件丢 H1，启动时 `assertHasH1()` 失败并明确报错（避免静默生成畸形 system prompt）。

**不进入主系统 prompt 的文件**（独立加载）：

| 文件 | 加载方式 | 作用 |
|---|---|---|
| `prompts/phases.md` | `loadPhaseInstructions()` → 注入 `[System Context]` 动态块 + 用户消息前缀 | 每个阶段的详细行为指令（Context + Reminder）|
| `prompts/topic-library.md` | 仅供参考（**不再注入** system prompt，v1.0.1 B4）| 话题列表（可通过 Web UI 编辑；`PUT /api/topics` 触发 `prompts/topic-library.md` 重生成）|
| `prompts/summarizer-system.md` | 摘要 agent 专用 system prompt | 会话结束 `summarize()` 时使用 |
| `prompts/USER.md.example` | 模板（`prompts/USER.md` 缺失时回退）| 不进 system prompt；git tracked |

---

## 9. 开发者参考

### 9.1 HTTP API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（返回 `{ok: true, sessions: <count>}`）|
| GET | `/api/sessions` | 会话列表（不含 messages）|
| POST | `/api/sessions` | 创建会话，返回 `{id, warmUpHook}` |
| GET | `/api/sessions/:id` | 会话详情 + `messages[]` |
| GET | `/api/sessions/:id/stream?action=init` | SSE：返回当前 phase + done |
| GET | `/api/sessions/:id/stream?action=turn&input=...&warmUpHook=...` | SSE：单轮 turn 完整事件流 |
| DELETE | `/api/sessions/:id` | 删除会话（级联清理 messages + 可能清空 orphaned WARM_UP 种子）|
| GET | `/api/settings` | 当前设置（USER.md + preferences.json）|
| PUT | `/api/settings` | 保存设置 |
| GET | `/api/topics` | 话题列表（含 `hitCount` + `keywordHits`）|
| PUT | `/api/topics` | 保存话题（白名单过滤）|
| POST | `/api/diagnostic/log` | Web 端 SSE 事件追踪上报（v1.0.2）|

### 9.2 SSE TurnEvent 类型

`text-chunk` / `phase` / `ctx` / `ctx-segment` / `ctx-block` / `student-text` / `tokens` / `tool-call` / `warn` / `error` / `done`。详细定义见 `src/agent/turn.ts`。

### 9.3 测试

- **L1（单元）**：`pnpm test`，覆盖 `src/agent/*` `src/prompts/*` `src/storage/*` 等
- **L3（CLI 集成）**：`pnpm test` 同上，依赖 `tests/fixtures/replay/` 的 fixture 字符串
- **E2E（Playwright）**：`pnpm test:e2e`，覆盖 6 个 spec（main / session / settings / sidebar / topic editor / ...）

详细测试金字塔见 `docs/DEVELOPMENT_PLAN.md`。
