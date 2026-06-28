# Architecture Design

> **本文是 PRD（要做什么）的工程实现层**。回答"由哪些部件组成、怎么协作、为什么这样设计"。
>
> **文档关系**
> - `REQUIREMENTS.md` —— 高层需求
> - `PRD.md` —— 详细需求
> - `ARCHITECTURE.md`（本文）—— 系统架构
> - `PROJECT_MANAGEMENT.md` —— 协作 / 流程
> - `docs/adr/` —— 单项决策记录（待建）

---

## 1. 系统概览

```
┌──────────────────────────────────────────────────────────────────┐
│  UI Layer (v0.8+) — React 19 + Vite 6, sidebar layout            │
│  ┌──────────────────┐ ┌─────────────────────────────────────────┐ │
│  │ SessionSidebar   │ │ Main Content (Routes)                   │ │
│  │ · Title          │ │ ┌──────────────────────────────────────┐ │ │
│  │ · New Session    │ │ │ SessionPage / HistoryPage / Settings │ │ │
│  │ · Session List   │ │ │ / WelcomePage / TopicLibraryPage     │ │ │
│  │ · Settings Link  │ │ └──────────────────────────────────────┘ │ │
│  │ · Topic Lib Link │ │                                          │ │
│  └──────────────────┘ └─────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                              │ HTTP REST + SSE
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Web Server (v0.8 — Hono on Node, src/server.ts)                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │
│  │  Sessions    │  │  Settings    │  │  SSE Stream  │            │
│  │  REST API    │  │  REST API    │  │  Handler     │            │
│  └──────────────┘  └──────────────┘  └──────────────┘            │
│                              │ uses                               │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────┐            │
│  │  turn.ts (v0.8.1 — extracted from cli.ts)        │            │
│  │  runTurn(input) → AsyncGenerator<TurnEvent>      │            │
│  └──────────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────────┘
                              │ (CLI 不退役: pnpm dev → src/cli.ts → 同一个 turn.ts)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Agent Core                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │  Session    │  │  State       │  │  Prompt      │             │
│  │  Manager    │◄─┤  Machine     │◄─┤  Builder     │             │
│  └─────────────┘  └──────────────┘  └──────────────┘             │
│         │                │                │                     │
│         ▼                ▼                ▼                     │
│  ┌──────────────────────────────────────────────────┐            │
│  │  Context Injector (middleware chain)             │            │
│  └──────────────────────────────────────────────────┘            │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │
│  │  Tool        │  │  Tool        │  │  Tool        │            │
│  │  memory_     │  │  topic_      │  │  mark_       │            │
│  │  search      │  │  select      │  │  mistake     │            │
│  └──────────────┘  └──────────────┘  └──────────────┘            │
└──────────────────────────────────────────────────────────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ LLM Client   │ │ Voice I/O    │ │ Storage      │ │ Memory       │
│ (provider    │ │ (Web Speech  │ │ (SQLite)     │ │ (transformers│
│  abstraction)│ │  STT + TTS)  │ │              │ │  .js + SQL)  │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
         │              │              │              │
         └──────────────┴──────────────┴──────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Prompt Sources                                                  │
│  - prompts/SOUL.md, AGENTS.md, USER.md (gitignored)              │
│  - prompts/topic-library.md, phases.md, tools.md, summarizer     │
└──────────────────────────────────────────────────────────────────┘
```

**核心原则**

1. **会话独立** —— 每个 session 是原子单元，对话原文不跨 session 滚动
2. **摘要是跨 session 的唯一通道** —— 历史相关 → SQLite BLOB cosine top-N 摘要 → 注入新 session
3. **单 agent + 工具** —— 主对话一个 agent；summarizer 是单独的 sub-agent
4. **本地优先** —— 所有数据（DB、向量、文件）都在 `data/`
5. **提示词即数据** —— SOUL/AGENTS/USER/topic 都是 markdown，git 进版本
6. **v0.8+ 双形态入口** —— CLI (`pnpm dev`) 和 Web (`pnpm serve` + 浏览器) 共享同一个 `turn.ts`，agent core 不动

---

## 2. Agent 核心

Agent Core 是整个系统的心脏。它由 6 个子模块组成。

### 2.1 Session Manager

**职责**：管理一个 session 的完整生命周期。

**关键方法**：

```ts
interface SessionManager {
  start(opts: StartOpts): Promise<Session>          // 开新 session
  resume(id: string): Promise<Session>              // 从未完成恢复
  end(id: string): Promise<void>                    // 正常结束
  abort(id: string): Promise<void>                  // 异常中止
  list(): Promise<SessionMeta[]>                    // 列出所有 session
  get(id: string): Promise<Session>                 // 取完整 session
}
```

**关键约束**

- 同时只能有 1 个 active session（其他都在 archive）
- 进程崩溃时，下次启动检测到 `sessions.ended_at IS NULL` 的记录 → 提示恢复

### 2.2 State Machine

**职责**：4 阶段转换 + 边界检测。

**状态**：`WARM_UP` / `MAIN_ACTIVITY` / `WRAP_UP` / `END`

**关键方法**：

```ts
interface StateMachine {
  current: Phase
  elapsedMin(): number
  tick(event: Event): PhaseTransition | null         // 每次 turn 后调用
  forceTransition(to: Phase, reason: string): void
  onTransition(cb: (from: Phase, to: Phase) => void): void
}
```

**事件类型**：

- `time_tick` —— 计时器每秒触发
- `user_message` —— 用户发消息
- `user_silent(durationMs)` —— 检测沉默
- `user_intent(action: 'stop' | 'continue')` —— 意图识别
- `system_error` —— LLM 错误

**转换表**（见 PRD §4）

### 2.3 Prompt Builder

**职责**：把静态 + 动态内容拼成最终的 LLM 输入。

**输入**：

```
[静态] SOUL.md, AGENTS.md, USER.md
[动态] [System Context] 块（阶段、时间、检索摘要、待办）
[动态] 当前 session 完整对话
[动态] 工具调用结果
[动态] 当前用户消息
```

**关键方法**：

```ts
interface PromptBuilder {
  buildSystemPrompt(): SystemMessage                 // 静态部分
  buildSystemContext(session: Session): SystemMessage // 动态块
  buildTurnInput(
    session: Session,
    toolResults: ToolResult[]
  ): Message[]                                      // [6] + [7]
}
```

**v0.7.5 拆分**：Prompt Builder 暴露两个函数：
- `buildFinalSystem(...)` —— legacy，返回拼接好的 string（既有 5 L1 + L3 测试不破）
- `buildFinalSystemSplit(...)` —— 新增，返回 `{ static, dynamic }` 两段。CLI 把两段作为独立 `systemBlocks` 传给 Anthropic SDK；第一段（SOUL + AGENTS + USER）带 `cache_control: ephemeral`，后续 turn 命中 prompt cache

**实现**：见 PRD §5.4 注入顺序

### 2.4 Context Injector

**职责**：在每次 LLM 调用前，把动态上下文拼进去。设计成**中间件链**，便于扩展。

**接口**：

```ts
type Middleware = (ctx: InjectCtx, next: () => Promise<void>) => Promise<void>

interface InjectCtx {
  session: Session
  systemContext: SystemContext     // 中间件可读 / 改
  messages: Message[]              // 中间件可读 / 改
}
```

**v1.0 内置中间件**：

```ts
const middleware: Middleware[] = [
  injectSystemContext,             // 注入 [System Context] 块
  injectLastReview,                // 注入"上次回顾"摘要
  injectHomework,                  // 注入未完成作业
  injectMistakes,                  // 注入待复习错例
  // 未来可加：injectVocabularyQuiz、injectContextDebug 等
]
```

### 2.5 Tool Registry

**职责**：定义 agent 可调用的工具。每个工具有明确的 schema 和执行函数。

**v1.0 工具清单**：

| 工具名 | 输入 | 副作用 | 用途 | 状态 |
|---|---|---|---|---|
| `memory_search` | `{query: string, top_k: int}` | 只读 | 检索历史相关摘要 | ✅ v0.7.3（top_k 1-5, default 2）|
| `summarize_history` | `{target_tokens: int}` | 改写 history | 压缩历史（保留 anchor + 近期 6 条）| ✅ v0.7.6 B2（target_tokens 100-3000, default 500）|
| `topic_select` | `{phase: Phase, exclude_recent_days: int}` | 只读 | 选题（带去重 + 加权随机）| ✅ v0.7.6 D5（exclude_recent_days 0-365, default 30）|
| `mark_mistake` | `{original, corrected, category}` | 写 SQLite | 记录错例（category ∈ `grammar` / `vocabulary` / `spelling`） | ✅ v0.7 |
| `mark_vocabulary` | `{word, context_sentence}` | 写 SQLite | 记录新词 | 📋 v1.0+（未实现）|
| `mark_homework` | `{content, due_days}` | 写 SQLite | 布置作业 | 📋 v1.0+（未实现）|

**Tool 接口（`src/agent/tool-registry.ts`）**：

```ts
export interface Tool {
  readonly name: string
  readonly description: string
  readonly schema: z.ZodTypeAny
  // v0.7.3 — widened to `Promise<unknown> | unknown` to admit both
  // sync side-effect tools (mark_mistake, v0.7) and async info-retrieval
  // tools (memory_search, v0.7.3 — embed is async). Callers can `await`
  // unconditionally; awaiting a non-Promise resolves to the value, so
  // sync tools are unaffected.
  execute(args: unknown): Promise<unknown> | unknown
}
```

**v0.7.3 A+B 混合协议**（用于 `memory_search`）：

v0.7 的 `mark_mistake` 是 sync 副作用工具（写 DB，LLM 不需要看 result）。v0.7.3 新增的 `memory_search` 是 async 信息检索工具（LLM 必须看 result 才能回复学生）。两者的 LLM ↔ CLI 协议不同：

- **A 形状**（v0.7 现有）：LLM 仍输出 `<tool>name({json})</tool>` 文本块；CLI 解析 → execute → 把工具块从 stdout 剥掉 → 学生看不到 tool 痕迹
- **A+B 混合**（v0.7.3 新增）：A 形状仍用，但 execute 完不直接写 stdout —— 而是把 tool result 拼成 synthetic user message 推回 history，**再做 1 次 LLM call（非流式）**，用 2nd-call 的回复作为 final output

A+B 的关键不变量：
- **1 round-trip**（2nd-call 不再调 tool，递归上限明确）
- 2nd-call 完成后 safety strip（防 LLM 误输出 `<tool>` 块；prompt 显式禁止 + cli 兜底）
- synthetic user message 含唯一 marker `[v073_followup_responder]` 供 Replay fixture 匹配 2nd call

**注册方式**：

```ts
const tools = [
  defineTool({
    name: 'memory_search',
    description: '搜索历史 session 摘要（v0.7.3，async + A+B 协议）',
    input: z.object({
      query: z.string().min(1).max(200),
      top_k: z.number().int().min(1).max(5).default(2)
    }),
    execute: async (input, ctx) => {
      // 1. embed query
      // 2. sessions.listWithEmbeddings() → candidates
      // 3. retrieveRelevant({candidates, queryVec, topK: input.top_k})
    }
  }),
  // ...
]
```

**v0.7.3 CLI 主循环分支**（`src/cli.ts`，替代 v0.7 的单分支）：

```
1st-call LLM chatStream
   │
   ▼
parseToolCall(response)  // null or {name, args, rawMatch}
   │
   ├─ null                       → stdout response, push to history（v0.7 旧行为）
   ├─ name === 'mark_mistake'    → strip + execute(sync) + log + stdout（v0.7 旧行为）
   ├─ name === 'memory_search'   → execute(async) → push synthetic user →
   │                                client.chat() 2nd call → safety strip → stdout
   └─ unknown                    → strip + log "tool unknown" + stdout
```

### 2.6 Summarizer

**职责**：在 session END 时，独立调用 LLM 生成摘要 + 关键词。

**为什么单独**：

- 主对话 agent 的 system prompt 是"扮演老师"，不适合写摘要
- 摘要任务 prompt 完全不同，需要专门指令
- 单独调用避免主对话状态干扰

**关键方法**：

```ts
interface Summarizer {
  summarize(transcript: string): Promise<{
    summary: string         // 50-150 tokens
    keywords: string[]      // 3-8 个英文词
  }>
}
```

**输入**：完整 transcript（可能很长，>10K tokens）

**实现思路**：

- 如果 transcript 太长，先做 chunk summarization，再合并
- 用与主对话不同的 prompt（"你是摘要助手..."）
- 输出 schema 严格校验（避免 LLM 自由发挥）

---

## 3. 支持模块

### 3.1 LLM Client（`src/llm/`）

**职责**：抽象不同 LLM provider，提供统一接口。

**接口**：

```ts
interface LLMClient {
  chat(opts: ChatOpts): Promise<ChatResult>           // 一次性
  chatStream(opts: ChatOpts): AsyncIterable<ChatChunk>// 流式
}

interface ChatOpts {
  /** Legacy: 单一 string 形式 system prompt（无 cache_control） */
  system?: string
  /** v0.7.5+：分块形式；首块可带 cache_control: ephemeral */
  systemBlocks?: SystemBlock[]
  messages: Message[]
  temperature?: number
  maxTokens?: number
}

type ChatChunk =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  /** v0.7.5: 流开头 yield 一次（对应 Anthropic message_start.usage） */
  | { type: 'usage'; inputTokens; outputTokens; cacheReadTokens; cacheCreationTokens }
```

**v1.0 provider**：

- `AnthropicProvider`（首选，claude-sonnet-4-6）
- `OpenAIProvider`（备选）

**v0.7.5 增强**：
- Anthropic SDK 0.41 支持 `cache_control: ephemeral` 标记 system 文本块（v0.7.5 用上）
- Provider 在 `message_start` 事件里捕获 `usage.{input,output,cache_read,cache_creation}_tokens`，作为 1 个 `usage` chunk 在流开头 yield 一次
- CLI 用这个 usage 做 post-call token log + 80% budget warn

**抽象层职责**：

- 消息格式转换（Anthropic content blocks vs OpenAI messages）
- 工具调用格式转换
- 流式协议差异
- 错误码统一
- prompt cache 协议差异（Anthropic cache_control vs OpenAI prompt caching）

### 3.2 Voice I/O（`src/voice/`）

**职责**：STT / TTS / 队列管理。

**STT**（Speech-to-Text）：

```ts
interface STT {
  start(): void                  // 开始识别
  stop(): void                   // 停止
  onResult(cb: (text: string, isFinal: boolean) => void): void
  onError(cb: (err: Error) => void): void
}
```

- 实现：浏览器原生 `window.SpeechRecognition`（零部署成本）
- 备选：whisper.cpp（本地，需要 Rust 工具链；v1.x 考虑）

**TTS**（Text-to-Speech）：

```ts
interface TTS {
  enqueue(text: string): void              // 增量入队
  setVoice(accent: 'en-US' | 'en-GB' | ...): void
  setRate(speed: number): void
  onStart(cb: () => void): void
  onEnd(cb: () => void): void
  clear(): void                            // 清空队列
}
```

- 实现：`window.speechSynthesis`
- 队列：FIFO；长回答按句号切分增量合成
- 30s 引擎挂起恢复（Chrome quirk，参考旧项目 `voice/`）

### 3.3 Storage（`src/storage/`）

**职责**：SQLite 持久化。

**技术选型**：`better-sqlite3`（同步 API，单进程本地应用最合适；不需要异步并发）

**模块组织**：

```
src/storage/
├── db.ts                 # 连接 + migration runner
├── migrations/
│   ├── 001_init.sql      # 初始 schema
│   ├── 002_keywords.sql  # 增量（v0.4 加）
│   └── 003_topic_stats.sql
├── sessions.ts           # sessions DAO
├── messages.ts
├── mistakes.ts
├── topics.ts
├── index.ts              # barrel export
└── (vocabulary.ts / homework.ts：v1.0+ 规划，DAO 未创建)
```

**关键设计**：

- 启动时跑 `PRAGMA integrity_check`
- migration 用 `schema_migrations` 表跟踪
- 每次写操作用事务

### 3.4 Memory（`src/memory/`）

**职责**：向量嵌入 + 语义检索。新 session 启动时用上次 session 的关键词 query top-K cosine 命中历史 session 的 summary 嵌入，注入 [System Context] "Relevant past sessions" 段。

**技术选型**：SQLite `sessions.embedding BLOB`（raw Float32Array bytes，零外部依赖）。**不引入 LanceDB**——v0.7.2 评估后决定 SQLite BLOB 已够用（brute-force cosine 在 1000 × 384 维 < 1ms，且省一个进程外依赖）。

**模块**：

```
src/memory/
├── embedder.ts           # Embedder 接口 + transformers.js 实现 + mock factory
├── vector-store.ts       # Float32Array ↔ Buffer + cosineSimilarity（纯函数）
├── retrieve-relevant.ts  # top-K cosine retrieval（纯函数，candidates 由调用方注入）
└── index.ts
```

**Embedding 模型选型**（v0.7.2 决策）：

- **本地 `Xenova/all-MiniLM-L6-v2` int8（q8 量化，~25MB 下载，384 维）**
- transformers.js v4 跑 ONNX，进程内 pipeline singleton（懒加载）
- `HF_ENDPOINT` env 走镜像（`hf-mirror.com` 等）
- 同 text → byte-identical vec（量化模型无随机性）
- 升级路径：换更大模型或 OpenAI `text-embedding-3-small` 是 v1.x 范围

**存储**：SQLite `sessions.embedding BLOB`（384 × 4 = 1536 字节/行）。`listWithEmbeddings()` 过滤 `summary IS NOT NULL AND embedding IS NOT NULL`，brute-force 算 cosine。**无 INDEX**（负优化）。

---

## 4. UI 层

### 4.1 框架选型

**v0.8 决策（2026-06-11）**：**React 19 + Vite 6 + Tailwind v4** + React Router 7

理由：
- React 19 生态最大，OSS 社区最熟悉（PRD F9.1 目标是 future-GitHub）
- Vite 6 dev 体验最佳（HMR < 50ms）
- Tailwind v4 zero-config（v4 是首个原生支持 Vite 6 的版本）
- React Router 7 = Remix 思路 + 简化 API，client-side 路由够用
- 状态管理：**用 React 19 内置 hooks（useState + useReducer）+ 自写 30 行 `useApi` cache**，**不引** Redux/Zustand/React Query

### 4.2 桌面壳

**v0.8 决策（2026-06-11）**：**纯 Web**（localhost:3000 / dev 5173）

理由：
- DEV_PLAN §8 风险：Tauri Windows 麻烦（Rust toolchain 链）
- 符合"minimal setups"偏好（无额外 deps）
- 单进程部署：server (Hono) 既 serve API 又 serve `web/dist/` static + SPA fallback
- 未来 Tauri 评估：v0.8.5+ 看用户反馈；包装 v0.8 已有的 server 即可

### 4.3 组件划分（v1.0.1 实际布局）

| 组件 | 路径 | 说明 | Sprint |
|---|---|---|---|
| SessionSidebar | `web/src/components/SessionSidebar.tsx` | 左侧会话列表 + 新建 + 删除 | v1.0.1 |
| Session Window | `web/src/components/SessionPage.tsx` | 对话窗口 + TTS + voice input | v0.8.3 |
| History Detail | `web/src/components/HistoryPage.tsx` | 只读 transcript | v0.8.4 |
| Settings Panel | `web/src/components/SettingsPage.tsx` | 语音/字体/快捷键设置 | v0.8.4 |
| Topic Library Editor | `web/src/components/TopicLibraryPage.tsx` | 话题库关键词编辑 | v1.0.1 |
| VoiceInput | `web/src/components/VoiceInput.tsx` | STT 麦克风按钮 | v0.9 |
| HotkeyInput | `web/src/components/HotkeyInput.tsx` | 快捷键捕获输入 | v0.9 |
| Shared (Bubble / Spinner) | `web/src/components/shared/` | 消息气泡、Loading | v0.8.5 |
| API client | `web/src/lib/api.ts` | REST + SSE 封装 | v0.8.2 |
| i18n (zh + en stub) | `web/src/i18n/` | 中文字符串 | v0.8.5 |

### 4.4 Web Server（v0.8 新模块）

| 路径 | 用途 |
|---|---|
| `src/server.ts` | Hono HTTP + SSE 入口；启动时 listen `env.PORT`（默认 3000）；SPA fallback（检测 web/dist/ 自动 serve 静态文件）|
| `src/agent/turn.ts` | REPL 主循环 → `runTurn(input): AsyncGenerator<TurnEvent, TurnOutput>`；CLI 和 server 共用；v1.0.1 支持 text-chunk 流式 + phase 强制前缀 + END 立即结束 |
| `src/prompts/loader.ts` | `updateUserSettings()` 原子写 USER.md（proper-lockfile）；`loadPhaseInstructions()` 读取 phases.md；topic-library 注入 |
| `src/agent/profile-extractor.ts` | [v1.0.1] 从会话摘要自动提取学生信息更新 USER.md |

API contract（v1.0.1 当前状态）：
- `GET /api/sessions` / `POST /api/sessions` / `GET /api/sessions/:id` / `DELETE /api/sessions/:id`
- `GET /api/sessions/:id/stream?action=turn&input=...` (SSE)
- `GET /api/settings` / `PUT /api/settings`
- `GET /api/topics` / `PUT /api/topics`
- `GET /api/health`

SSE events: `phase / text-chunk / ctx / ctx-segment / ctx-block / student-text / tokens / tool-call / warn / error / done`。text-chunk 通过 `chatStreamWithRetryGen` 实现真正的逐字流式。

---

## 5. 关键数据流

### 5.1 启动新 session

```
User clicks [开始新练习]
   │
   ▼
UI: emit('session:start')
   │
   ▼
SessionManager.start()
   │
   ├─→ loadUserProfile()      # prompts/USER.md
   ├─→ loadTopicsIndex()      # prompts/topics/_index.yaml
   ├─→ retrieveLastReview()   # SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1
   ├─→ retrieveHomework()     # SELECT * FROM homework WHERE completed_at IS NULL
   ├─→ retrieveMistakes()     # SELECT * FROM mistakes WHERE reviewed = 0
   ├─→ selectTopic()          # §3.5.3 三层筛选
   ├─→ buildSystemPrompt()    # SOUL + AGENTS + USER
   ├─→ buildSystemContext()   # 阶段 + 时间 + 摘要 + 待办
   ├─→ firstTurn()            # 第一个 agent 消息
   │
   ▼
LLMClient.chat(streaming)
   │
   ▼
UI: 渲染消息 + TTS 播放
```

### 5.2 主对话循环

```
User 发送消息（文字 / 语音）
   │
   ▼
[voice] STT → text
   │
   ▼
Session.appendUserMessage(text)
   │
   ▼
StateMachine.tick(user_message)
   │  - 检查沉默 / 短答 / 阶段时间
   │  - 可能触发 transition
   │
   ▼
v0.7.5: buildFinalSystemSplit() → { static, dynamic }
   │  - static:  SOUL + AGENTS + USER（session 内不变，cacheable）
   │  - dynamic: [System Context] 块（每 turn 变）
   │
   ▼
v0.7.5: truncateHistory(history, env.LLM_CONTEXT_BUDGET_TOKENS, systemSize)
   │  - estimator: chars/4（保守，零依赖）
   │  - drop oldest user/assistant pairs until under budget
   │  - 永远保留最近 1 对（loop invariant）
   │  - if dropped > 0: stderr "[cli] truncated: dropped N pairs, ..."
   │
   ▼
systemBlocks = [
  { type: 'text', text: static, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: dynamic }
]
   │
   ▼
LLMClient.chatStream({ systemBlocks, messages: history })   ← 1st call
   │  - 流开头 yield 1 次 usage chunk（Anthropic message_start.usage）
   │  - 后续 yield text/thinking chunks
   │
   ├─→ capture usage: inputTokens / outputTokens / cache_read / cache_creation
   ├─→ v0.7.5: stderr "[cli] tokens: input=X output=Y cache_read=Z cache_creation=W"
   ├─→ v0.7.5: if inputTokens / budget >= 0.8 (per session, 1 次):
   │     stderr "[cli] warn: context usage X% (budget=Y)"
   │
   ├─→ UI: 边显示边 TTS（按句切分增量合成）
   │
   ├─→ parseToolCall(response)  // v0.7.3 — 4 分支
   │
   ├─→ name === 'mark_mistake'   (sync side-effect, A 形状):
   │     ├─→ ToolRegistry.execute(toolCall)  // 写 SQLite
   │     ├─→ strip tool block from response
   │     └─→ stdout 剥过的 response
   │
   ├─→ name === 'memory_search'  (async info-retrieval, A+B 形状):
   │     ├─→ ToolRegistry.execute(toolCall)  // embed + DB read
   │     ├─→ push assistant 1st-call (含 tool 块) 到 history
   │     ├─→ push synthetic user message 含 [v073_followup_responder] marker
   │     ├─→ LLMClient.chat({ systemBlocks, ... })  ← 2nd call（非流式）
   │     ├─→ safety strip 2nd-call response（防 LLM 误输出 tool 块）
   │     └─→ stdout 2nd-call 剥过的 response
   │
   └─→ name === null / unknown
         └─→ stdout response（v0.7 旧行为）
   │
   ▼
完成本 turn，等待下一用户消息
```

**关键不变量**：
- `memory_search` 走 A+B = **1 round-trip**（2nd-call 不递归调 tool）
- 1 round-trip 总 token 成本 ~400（result 200 + 2nd-call 200）
- 2nd-call LLM 误调 tool → safety strip 兜底（prompt 显式禁止 + cli 兜底）
- v0.7.5 budget: pre-truncate 用 estimator（chars/4），post-call 用 SDK usage 校验；80% warn 一次/每 session
- v0.7.5 cache: `static` 段带 `cache_control: ephemeral`，跨 turn 复用（hit 时 cache_read 上升）

### 5.3 END + 归档

```
User clicks [结束本次]
   │
   ▼
SessionManager.end(id)
   │
   ├─→ StateMachine.transition(END)
   ├─→ Agent 发告别消息
   ├─→ 写 transcript → data/sessions/<timestamp>_<id>.md
   │
   ├─→ Summarizer.summarize(transcript)
   │     └─→ { summary, keywords }
   │
   ├─→ saveSession({summary, keywords, topics_used, ...})
   │
   ├─→ embed(summary) → vector
   ├─→ sessions.setEmbedding(sessionId, vector) → SQLite BLOB
   │
   ├─→ matchKeywords(keywords) → 命中 topics
   │     └─→ UPDATE topic_stats SET discussion_count += 1, last_discussed_at = now
   │
   ├─→ UI: 关闭窗口，回到主界面
   │
   ▼
进程继续运行，等待下一次 [开始新练习]
```

---

## 6. 模块结构（`src/` 映射）

```
src/
├── index.ts                  # 入口；启动 IPC / 路由
│
├── agent/                    # Agent 核心
│   ├── session-manager.ts
│   ├── state-machine.ts
│   ├── prompt-builder.ts
│   ├── context-injector.ts
│   ├── tools/
│   │   ├── memory-search.ts
│   │   ├── topic-select.ts
│   │   ├── mark-mistake.ts
│   │   ├── mark-vocabulary.ts
│   │   └── mark-homework.ts
│   ├── summarizer.ts
│   └── index.ts
│
├── llm/                      # LLM 客户端
│   ├── types.ts              # 抽象接口
│   ├── anthropic.ts
│   ├── openai.ts
│   └── index.ts              # 根据 env 选 provider
│
├── voice/                    # 语音 I/O
│   ├── stt.ts
│   ├── tts.ts
│   ├── queue.ts
│   └── index.ts
│
├── storage/                  # 持久化
│   ├── db.ts                 # 连接 + migration
│   ├── migrations/
│   ├── sessions.ts
│   ├── messages.ts
│   ├── mistakes.ts
│   ├── topics.ts
│   ├── index.ts
│   # 注：vocabulary.ts / homework.ts（对应 mark_vocabulary / mark_homework 工具，v1.0+ 规划）尚未创建
│
├── memory/                   # 向量记忆
│   ├── embeddings.ts
│   ├── vector-store.ts
│   └── index.ts
│
├── prompts/                  # 提示词加载（运行时）
│   ├── loader.ts             # 读 SOUL / AGENTS / USER
│   ├── topics.ts             # 扫描 topics/
│   ├── frontmatter.ts        # YAML frontmatter 解析
│   └── index.ts
│
├── config/                   # 配置
│   ├── env.ts                # 读 .env
│   ├── user.ts               # 读 USER.md
│   └── index.ts
│
└── ui/                       # 前端
    ├── main/                 # 会话列表
    ├── session/              # session 窗口
    ├── session-detail/       # 历史只读视图
    ├── settings/             # 设置面板
    └── shared/
```

**依赖方向**（单向，无循环）：

```
ui/  →  agent/  →  { llm/, voice/, storage/, memory/ }
                ↘  prompts/  →  config/
                ↘  config/
```

---

## 7. 关键设计决策

| # | 决策 | 理由 | 替代方案 |
|---|---|---|---|
| **D1** | 会话独立，不滚动跨 session 上下文 | 避免"长 context 膨胀" + 隐私隔离 | 滚动窗口（旧 OpenClaw 模型） |
| **D2** | 跨 session 唯一通道：摘要 + SQLite BLOB cosine 检索 | 压缩信息、降低 token 消耗、零外部依赖 | 滚动 N 轮原文 |
| **D3** | 单 agent + 工具，不上多 agent | 简化 prompt 工程、易调试 | 多 agent（planner/executor/...） |
| **D4** | Summarizer 是单独 agent 调用 | 任务 prompt 完全不同 | 在主 agent 里加 mode 切换 |
| **D5** | Local-first（SQLite + 本地 ONNX + 文件） | 隐私、零外部依赖、可移植 | 云存储 |
| **D6** | Voice 走浏览器 Web Speech API | 零部署、跨平台 | Whisper 本地 / 云 TTS |
| **D7** | Prompts 是 markdown 数据 | 改 prompt 不需 rebuild、走 git diff | 写在 .ts 里 |
| **D8** | 话题计数自动（关键词 Jaccard 匹配） | 无需手动标注 | 用户打 tag |
| **D9** | Context Injector 设计成中间件链 | 扩展性好、单元测试容易 | 单一函数拼装 |
| **D10** | Embedding 用本地 MiniLM-L6-v2（v0.7.2 决策） | 零网络、隐私、25MB 下载可接受 | OpenAI API（v1.x 可升级） |

每个决策的具体 rationale 见 `docs/adr/`（待 v0.2 启动时补 ADR 文件）。

---

## 8. 外部依赖

### 8.1 运行时（`dependencies`）

| 包 | 用途 | 备选 |
|---|---|---|
| `@anthropic-ai/sdk` | Claude API | OpenAI |
| `openai` | OpenAI API / embedding (fallback) | — |
| `better-sqlite3` | SQLite（含 embedding BLOB） | node:sqlite (实验性) |
| `@huggingface/transformers` + `onnxruntime-node` | 本地 embedding（MiniLM-L6-v2 q8） | OpenAI embedding API（v1.x 可切） |
| `gray-matter` | frontmatter 解析 | 自己写 |
| `zod` | schema 校验 | yup / ajv |

### 8.2 开发（`devDependencies`）

| 包 | 用途 |
|---|---|
| `typescript` | TS 编译器 |
| `@biomejs/biome` | lint + format |
| `@types/node` | Node 类型 |
| `tsx` | 开发态直接跑 TS |
| `vitest` | 测试框架（v0.2+） |

### 8.3 浏览器 API（仅 UI 层使用）

- `window.speechSynthesis` / `SpeechRecognition`
- `localStorage`（session-only 设置）
- `IndexedDB`（备选，TTS 引擎枚举缓存）

---

## 9. 待决问题（v0.2 启动时拍板）

| 问题 | 选项 | 决策时机 |
|---|---|---|
| UI 框架 | React / Svelte / Solid | v0.2 |
| 桌面壳 | Tauri / Electron / 纯 Web | v0.2 |
| LLM provider 优先级 | Claude / OpenAI / 可配置 | v0.2 |
| Embedding 模型 | OpenAI API / 本地 MiniLM | v0.2 |
| OpenClaw 旧数据迁移 | 脚本转 / 手转 / 不支持 | v0.5 |
| 进程间通信（如果用 Tauri/Electron） | Tauri IPC / Electron IPC | 选壳时定 |
| 第一版 LLM 默认模型 | sonnet-4-6 / opus-4-7 | v0.2 |

---

## 10. Configuration & Data Boundaries

> **核心原则**：能不改 `.ts` 的东西，**都应该能不改 `.ts`**。换模型、改人格、换话题——全都不该要求 rebuild。

### 10.1 五类资产

| 类别 | 路径 | 修改方式 | 何时生效 | 谁来改 |
|---|---|---|---|---|
| **代码** | `src/`, `tests/`, `package.json`, `tsconfig.json`, `biome.json` | 改 TS | rebuild + restart | 开发者 |
| **提示词内容** | `prompts/SOUL.md`, `prompts/AGENTS.md`, `prompts/topics/**/*.md` | 改 markdown | 下次 session 启动 | 维护者 / 教师 |
| **用户配置** | `prompts/USER.md`（gitignored） | 改 YAML | 下次 session 启动 | 学生 / 家长 |
| **运行配置** | `.env`（gitignored） | 改键值对 | 重启进程 | 维护者 / 高级用户 |
| **运行时数据** | `data/`（gitignored） | 系统写入 | 即时 | 自动 |

### 10.2 `.env` 完整可配项

| 键 | 默认 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | `anthropic` / `openai` |
| `ANTHROPIC_API_KEY` | — | Claude API key |
| `OPENAI_API_KEY` | — | OpenAI API key（fallback 或 embedding） |
| `LLM_MODEL_MAIN` | `claude-sonnet-4-6` | 主对话模型 |
| `LLM_MODEL_SUMMARIZER` | `claude-sonnet-4-6` | 摘要模型（可调小降本） |
| `LLM_MODEL_EMBEDDING` | `Xenova/all-MiniLM-L6-v2` (q8) | Embedding 模型（v0.7.2 用本地） |
| `LLM_EMBEDDING_PROVIDER` | `local` | `local`（v0.7.2）/ `openai`（v1.x 可切） |
| `HF_ENDPOINT` | — | HuggingFace 镜像 URL（可选，中国网络 `https://hf-mirror.com`） |
| `LLM_TEMPERATURE` | `0.7` | 采样温度 |
| `LLM_MAX_TOKENS` | `2048` | 单轮输出上限 |
| `LLM_CONTEXT_BUDGET_TOKENS` | `6000` | v0.7.5：单轮 input token cap；超此值 sliding window truncate；80% 时 warn（per session 1 次） |
| `APP_PORT` | `3000` | 本地服务端口 |
| `APP_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `APP_DATA_DIR` | `./data` | 数据目录 |
| `APP_TTS_ENGINE` | `web-speech` | `web-speech`（v1.x：`edge-tts` / `mmx-tts`） |

> **改 `.env` 后需要重启进程**。UI 不暴露这些——保持"高级配置"和"日常使用"分离。

### 10.3 `prompts/` 可编辑项

| 文件 | 用途 | 何时加载 |
|---|---|---|
| `SOUL.md` | Agent 核心规则（人格、铁律、行为） | 每次 session 启动 |
| `AGENTS.md` | 操作手册（怎么选话题、怎么记错） | 每次 session 启动 |
| `USER.md` | 学生画像（覆盖模板即可） | 每次 session 启动 |
| `topics/**/*.md` | 话题库 | session 启动 + 自动生成 `_index.yaml` |

> **改 markdown 不需要 rebuild**。代码层每次都重读这些文件。

### 10.4 `data/` 运行时

| 路径 | 内容 | 何时写入 |
|---|---|---|
| `data/oral-teacher.db` | SQLite（含 sessions.embedding BLOB） | 实时 |
| `data/sessions/*.md` | 完整 transcript | session END 时 |
| `~/.cache/huggingface/` | transformers.js 模型缓存 | 首次 `embed()` 时下载 |

> `data/` 全部 gitignored。删掉 `data/` = 重置到全新状态（应用首次启动会创建空库）。

### 10.5 UI 与配置的边界

- **UI 可见**：语音开关 / 语速 / 口音 / 字体大小 / 显示调试（写回 USER.md 或 session-only）
- **UI 不可见**：LLM 模型、provider、API key、TTS 引擎、生成参数、日志级别——**只在 `.env` 改**

> 原则：UI 暴露的是"日常使用可能想换的"；`.env` 暴露的是"装好之后基本不动的"。两者物理隔离。

---

## 11. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-06-02 | 0.1 | 初稿：系统概览、Agent 核心 6 模块、支持模块、UI 层、3 个数据流、模块结构、10 项设计决策、依赖、待决问题 |
| 2026-06-02 | 0.2 | 新增 §10 Configuration & Data Boundaries；`.env` 扩展为 provider 切换 + per-task 模型（main / summarizer / embedding）+ 生成参数；明确"UI 不可见"原则 |
| 2026-06-10 | 0.3 | §3.4 Memory：LanceDB 换成 SQLite `sessions.embedding BLOB`（v0.7.2 决策）；模块结构改成 embedder + vector-store + retrieve-relevant；模型选型定到本地 MiniLM-L6-v2 int8（384 维）；D2/D5/D10 更新；§8 依赖 `lancedb` → `@huggingface/transformers` + `onnxruntime-node`；§10 `data/vectors/` 路径移除；env 增加 `HF_ENDPOINT` |
| 2026-06-10 | 0.4 | §2.3 Prompt Builder：新增 `buildFinalSystemSplit` → `{ static, dynamic }`；§3.1 LLM Client：`SystemBlock` / `UsageChunk` / `ChatChunk` v0.7.5 字段；§5.2 主对话循环：加 `truncateHistory` + `systemBlocks` + `cache_control` + usage log + 80% warn 步骤；§10.2 env 新增 `LLM_CONTEXT_BUDGET_TOKENS`（默认 6000） |
| 2026-06-11 | 0.5 | **v0.7.6 (3-axis wrap-up)** — §2.3 Prompt Builder：`buildFinalSystemSplit` → `buildFinalSystemSegments` (return type 增 `segments: {phase,last,relevant,active,mistakes}` token counts)；§3.1 LLM Client：`toAnthropicMessages` 给 messages[] 末尾 2 条加 `cache_control: ephemeral` (B4)；§4 Tools：v0.7.6 B2 增 `summarize_history` (marker tool, CLI 改写 history → A+B 2nd call)，D5 增 `topic_select` (pure compute, A+B 2nd call)；§5.2 主循环：4 工具分支 (no-tool / mark_mistake / memory_search / summarize_history / topic_select)；`truncateHistory` 加 `anchorPair` 选项 (B1) 保护首对 user/assistant；`chatStreamWithRetry` 1x retry + catch-all 友好降级 + auto-save (V751-002)；`buildSystemContext` 返 `SystemContextResult` 带 5 段 token counts；`formatToolResult` 增 `[v076_*]` 标记 |
| 2026-06-11 | 0.6 | **v0.7.7 (V752-001 cosmetic closeout)** — `src/cli.ts:454` 去掉 stderr 模板里冗余 `[System Context]` 前缀（`sysSeg.dynamic` 已自带 header；`context-injector.test.ts:50` L1 锁住）；新增 1 L3 test (`tests/agent/cli-integration.test.ts`) 断言 ctx-block 第一内容行精确等于 `[System Context]` + 双前缀 string 全文不出现；v0.7.x **真正收官**。 |
| 2026-06-11 | 0.7 | **v0.8 计划 (Web UI)** — §1 系统概览加 Web Server 层 (Hono on Node)；§4.1 框架选型 **决策** = React 19 + Vite 6 + Tailwind v4 + React Router 7（react-query/zustand 不引）；§4.2 桌面壳 **决策** = 纯 Web（localhost，Tauri 不做）；§4.3 组件划分：`src/ui/*` → `web/src/components/*`（4 页 + shared + lib + i18n）；§4.4 新模块 Web Server：`src/server.ts` (Hono) + `src/agent/turn.ts` (从 cli.ts 抽 REPL 主循环) + `src/prompts/loader.ts` 新增 `updateUserSettings()` 原子写。拆 5 sub-sprint (v0.8.1-v0.8.5)，8.5 天；3 REST + 1 SSE + 2 settings endpoints；CLI 不退役。详见 [v0.8-scope.md](./sprint/v0.8-scope.md) + [v0.8-design.md](./sprint/v0.8-design.md)。 |
| 2026-06-12 | 0.8 | **v0.8.2 (React 19 + Vite 6 skeleton + MainPage)** — `web/` 子项目落地（独立 `package.json` + `vite.config.ts` + `tsconfig.json` + `index.html`）；React 19 + react-router-dom 7 + Tailwind v4 (`@tailwindcss/vite`)；4 路由 (`/` `/session/:id` `/history/:id` `/settings`)；MainPage 调 `GET /api/sessions` 渲染列表 + [开始新练习] 按钮调 `POST /api/sessions` 跳 `/session/:id`；其余 3 页 placeholder；root 加 `concurrently` devDep + `dev-web`/`build`/`preview`/`test:e2e` 4 个 script + `typecheck` 扩到 3 个 tsc；Playwright E2E #1 (main.spec.ts，4 tests)；root `playwright.config.ts` `webServer` 跑 `pnpm dev-web`；详见 [v0.8.2-scope.md](./sprint/v0.8.2-scope.md) + [v0.8.2-design.md](./sprint/v0.8.2-design.md)。 |
| 2026-06-13 | 0.9 | **v0.8.3 (SSE turn loop + SessionPage)** — 服务端 SSE 桩替换为真实 `runTurn()` 集成：`GET /api/sessions/:id/stream?action=init` 返回当前阶段，`?action=turn&input=...` 流式输出完整 TurnEvent 序列；内存 `SessionRuntime` 存储 (`Map<id, {state,phaseHistory,firstPair,isFirstTurn}>`)；SessionPage 从占位页重写为完整会话 UI（阶段标签 + 计时器 + 消息气泡 + 输入框 + 发送/结束按钮 + 5 状态）；通过原生 `EventSource` 实现 SSE（零新依赖）；E2E #2 (session.spec.ts，完整 2 轮会话流程)；5/5 Playwright E2E 通过；347/348 vitest（1 个预存在 CLI 超时）；详见 [v0.8.3-scope.md](./sprint/v0.8.3-scope.md) + [v0.8.3-design.md](./sprint/v0.8.3-design.md)。 |
| 2026-06-13 | 0.10 | **v0.8.4 (HistoryPage detail + SettingsPage wiring)** — 扩展 `GET /api/sessions/:id` 返回 `messages[]`；HistoryPage 从占位页重写（元数据卡片 + 只读消息流）；新增 `GET/PUT /api/settings` 端点 + `updateUserSettings()` 通过 proper-lockfile 原子写 USER.md frontmatter；SettingsPage 从占位页重写（5 控件 + localStorage + 保存）；E2E #3 (settings.spec.ts)；6/6 Playwright E2E 通过；20/20 server vitest 通过；详见 [v0.8.4-scope.md](./sprint/v0.8.4-scope.md) + [v0.8.4-design.md](./sprint/v0.8.4-design.md)。 |
| 2026-06-13 | 0.11 | **v0.8.5 (Polish + streaming + SPA)** — 真正逐字流式：`chatStreamWithRetryGen` async generator + `runTurn()` yield `text-chunk` + SessionPage 实时渲染闪烁光标；MessageBubble + LoadingSpinner 共享组件（4 页面复用）；字体大小 CSS 变量 `--font-size-base` 实时生效；Esc 键离开 session；生产 SPA fallback（`pnpm build && pnpm serve` → localhost:3000）；14 个预存在 test typecheck 错误全部修复（三项目首次全部 0 错误）；6/6 E2E、20/20 vitest 通过。v0.8 全部 5 个 sub-sprint 完成。详见 [v0.8.5-scope.md](./sprint/v0.8.5-scope.md) + [v0.8.5-design.md](./sprint/v0.8.5-design.md)。 |
| 2026-06-14 | 0.12 | **v0.8.5 后打磨 (Phase 推进 + Prompt 增强)** — 30 分钟到不再硬终止；SOUL.md 4 阶段指引 + WARM_UP 跨会话多样化；新建 `prompts/topic-library.md` 注入 system prompt；阶段指令移至 `prompts/phases.md` 可编辑文件；用户消息前缀注入阶段提醒，阶段切换时使用完整 Context 文本；沉默跳过 WRAP_UP 补一轮总结；`DEBUG_LOG_LLM=1` 记录完整 LLM 请求。53/53 vitest 通过。 |
| 2026-06-14 | 0.13 | **Phase 推进 + 会话记忆 (Round 2)** — AGENTS.md 合并入 SOUL.md 消除重复；`lastReview` 改为每次新会话动态查询 DB（修复摘要不可见 bug）；Web 会话结束时补充 summarize + markEnded + topic matching + embedding 完整流水线；新建 `profile-extractor.ts` 从摘要自动提取学生信息更新 USER.md；"结束本次" 按钮发送 `stop`（匹配 STOP_REGEX）触发完整结束流程；topic-matcher 降低阈值 + 支持 keyword-hit ratio，扩展 music 话题词库（8→24 词）；回补历史会话话题匹配数据。26/26 vitest 通过。 |
| 2026-06-14 | 0.14 | **Web UI sidebar 重构** — 左侧 SessionSidebar 常驻（288px，标题 + 新建按钮 + 按日期分组的会话列表 + 当前活跃高亮 + 设置入口 + hover 删除）；右侧主内容区根据路由切换；点侧边栏会话即时切换；DELETE /api/sessions/:id 端点 + ON DELETE CASCADE 清理关联数据；6/6 E2E、22/22 vitest 通过。 |
| 2026-06-14 | 0.15 | **v0.9 语音 I/O** — STT 通过浏览器 `SpeechRecognition` API（Chrome 内置），🎤 按钮在输入区；TTS 通过 `SpeechSynthesis` 朗读回复；Settings 语音控件启用；可自定义麦克风/发送快捷键（HotkeyInput）；全局 Enter 键发送消息；零新依赖、零 API 成本。6/6 E2E、web build 通过。 |
| 2026-06-15 | 0.16 | **v1.0.1 功能打磨** — Phase 首次切换注入完整 Context 前缀打断 LLM 惯性；END 阶段立即结束防无限告别循环；30 分钟优雅结束；catch-up WRAP_UP；话题库完全重建（30 话题对齐分类体系）+ countScore 评分 + Web UI 话题编辑器 + GET/PUT /api/topics；lastReview 动态查询；Web 会话结束 summarize + markEnded + embedding 流水线；profile-extractor 自动更新 USER.md；侧边栏删除会话；tool 标签过滤；AGENTS 合并入 SOUL；阶段指令移至 phases.md；DEBUG_LOG_LLM。22/22 vitest 通过。 |
| 2026-06-16 | 0.17 | **v1.0.1 Phase 推进 (Round 3)** — **MAIN_ACTIVITY 自动调用 `topic_select` 工具选题**：进入 MAIN_ACTIVITY 时强制选话题，合成 `[TOPIC: xxx]` 独立消息发给 LLM，彻底解决文本指令被无视的问题。**WARM_UP 改为独立消息 + 完整摘要文本**："make a natural connection to last session"而非"avoid topics"。**lastReview 过滤无效摘要**（`length(summary) > 30` 跳过 `summarization failed` 占位符）。**localStorage 双重持久化**：`data/preferences.json` 服务端存储 + `main.tsx` 启动恢复，修复热键/字体设置浏览器重启后丢失。Phase 切换确认丝滑：WARM_UP→MAIN_ACTIVITY(topic_select 工具)→WRAP_UP(PHASE TRANSITION 指令)→END(立即 return)。28/28 vitest 通过。 |
| 2026-06-28 | 0.18 | **v1.0.2 落地 (Topic 命中统计 + Bug 修复)** — 详见 [v1.0.2-scope.md](./sprint/v1.0.2-scope.md) + [v1.0.2-design.md](./sprint/v1.0.2-design.md) + [v1.0.2-test-report.md](./sprint/v1.0.2-test-report.md)。包含两个阶段：**HOTFIX 阶段**（commit `e35d70e`）— Bug A `topic-counter.ts` MIN_TOPIC_AGE=5 强制 topic 停留 ≥5 轮（旁路：`switch topic` / `换个话题` 正则）；Bug B 删除 SessionPage `student-text` handler 的 v0.8 兼容 shim（修复 2nd-call SSE 响应被丢弃）；turn-level 诊断基础设施（`logTurnDiagnostic` + `POST /api/diagnostic/log` + Web 端 opt-in SSE event 追踪）。**新功能阶段** — 新增 `keyword_hits` 表 + `KeywordHitsDao` 记录 per-(topic, keyword) 命中次数；`selectTopic()` 加 keyword-freshness 评分（`W_KEYWORD=0.05`）优先选 keyword 命中少的 topic；`topic_select` 工具返回 `suggested_keyword` 给 LLM 作开场角度；`GET /api/topics` JOIN topic_stats + keyword_hits 返回 `hitCount` + `keywordHits`；Web UI `/topics` 页面话题名右侧展示 `(N)`、keyword chip 内展示 `(N)`；`PUT /api/topics` 字段白名单防误覆盖统计。零新依赖。Migration `006_keyword_hits.sql` 热加载。`pnpm typecheck` / `pnpm --dir web build` / 354/366 L1（12 个 pre-existing 失败）通过。 |
| 2026-06-28 | 0.19 | **v1.0.3 落地 (UI polish + 阶段化话题策略)** — 详见 [v1.0.3-scope.md](./sprint/v1.0.3-scope.md) + [v1.0.3-design.md](./sprint/v1.0.3-design.md) + [v1.0.3-test-report.md](./sprint/v1.0.3-test-report.md)。三个 in-scope 段：**§1.1 删除会话去 confirm**（commit `3f3cdd6` 已落地，sidebar × 直接删除）；**§1.2 Settings 加 Cancel**（commit `3f3cdd6` 已落地，表单可放弃未保存改动）；**§1.3 阶段化话题策略**（本次报告主体）— D3 (interest boost) 在 `topic_select` 工具中永久禁用，兴趣匹配交由 WARM_UP 阶段 prompt 处理；`extractStudentDiscoveries` 输出扩展 `nextWarmUpSeed`（LLM 选 1-3 词开场关键词）；`pendingWarmUpSeed` 模块级状态在 CLI + server 双端实现，session-end 写入、startup 读+清零；`POST /api/sessions` 返回 `{id, warmUpHook}`；`/api/sessions/:id/stream` 接受 `?warmUpHook=` query param；`TurnInput.warmUpHook`（可选）注入 WARM_UP 阶段首轮 hint 为聚焦开场行。CLI 端补齐 v1.0.2 缺失的 profile-extract parity（commit `3f3cdd6` 之前）。零新依赖。`pnpm typecheck` / `pnpm --dir web build` 通过；L1 382/415 (33 pre-existing 失败，与本 sprint 无关)。 |
