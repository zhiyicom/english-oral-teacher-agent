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
│  UI Layer                                                        │
│  ┌──────────┐  ┌──────────────┐  ┌────────────┐                 │
│  │  Main    │  │  Session     │  │  Settings  │                 │
│  │  Screen  │  │  Window      │  │  Panel     │                 │
│  └──────────┘  └──────────────┘  └────────────┘                 │
└──────────────────────────────────────────────────────────────────┘
                              │ IPC / events
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
│ (provider    │ │ (Web Speech  │ │ (SQLite)     │ │ (LanceDB)    │
│  abstraction)│ │  STT + TTS)  │ │              │ │              │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
         │              │              │              │
         └──────────────┴──────────────┴──────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Prompt Sources                                                  │
│  - prompts/SOUL.md, AGENTS.md, USER.md                          │
│  - prompts/topics/**/*.md                                        │
└──────────────────────────────────────────────────────────────────┘
```

**核心原则**

1. **会话独立** —— 每个 session 是原子单元，对话原文不跨 session 滚动
2. **摘要是跨 session 的唯一通道** —— 历史相关 → LanceDB top-N 摘要 → 注入新 session
3. **单 agent + 工具** —— 主对话一个 agent；summarizer 是单独的 sub-agent
4. **本地优先** —— 所有数据（DB、向量、文件）都在 `data/`
5. **提示词即数据** —— SOUL/AGENTS/USER/topic 都是 markdown，git 进版本

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

| 工具名 | 输入 | 副作用 | 用途 |
|---|---|---|---|
| `memory_search` | `{query: string, top_k: int}` | 只读 | 检索历史相关摘要 |
| `topic_select` | `{phase: Phase, exclude_recent_days: int}` | 只读 | 选题（带去重） |
| `mark_mistake` | `{type, original, corrected}` | 写 SQLite | 记录错例 |
| `mark_vocabulary` | `{word, context_sentence}` | 写 SQLite | 记录新词 |
| `mark_homework` | `{content, due_days}` | 写 SQLite | 布置作业 |

**注册方式**：

```ts
const tools = [
  defineTool({
    name: 'memory_search',
    description: '搜索历史 session 摘要',
    input: z.object({
      query: z.string(),
      top_k: z.number().int().min(1).max(10).default(3)
    }),
    execute: async (input, ctx) => { /* ... */ }
  }),
  // ...
]
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
  chat(opts: ChatOpts): AsyncIterable<Token>          // 流式
  complete(opts: CompleteOpts): Promise<Completion>   // 一次性
}

interface ChatOpts {
  system: Message[]
  messages: Message[]
  tools?: ToolDef[]
  temperature?: number
  max_tokens?: number
}
```

**v1.0 provider**：

- `AnthropicProvider`（首选，claude-sonnet-4-6）
- `OpenAIProvider`（备选）

**抽象层职责**：

- 消息格式转换（Anthropic content blocks vs OpenAI messages）
- 工具调用格式转换
- 流式协议差异
- 错误码统一

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
├── vocabulary.ts
├── homework.ts
└── topic-stats.ts
```

**关键设计**：

- 启动时跑 `PRAGMA integrity_check`
- migration 用 `schema_migrations` 表跟踪
- 每次写操作用事务

### 3.4 Memory（`src/memory/`）

**职责**：向量存储 + 语义检索。

**技术选型**：`lancedb`（嵌入式，文件式，零外部依赖）

**模块**：

```
src/memory/
├── embeddings.ts         # embedding 模型客户端
├── vector-store.ts       # LanceDB 封装
└── index.ts
```

**Embedding 模型选型**（待决，v0.2 决定）：

- 候选 A：OpenAI `text-embedding-3-small`（便宜、效果好，但联网）
- 候选 B：本地 `all-MiniLM-L6-v2`（~80MB，零网络）
- 决策：v1.0 用 A（保证质量），v1.x 评估 B

---

## 4. UI 层

### 4.1 框架选型（待决）

候选：

| 框架 | 优点 | 缺点 |
|---|---|---|
| **React** | 生态最大、招人容易 | 包大 |
| **Svelte** | 编译时优化、响应式简洁 | 生态较小 |
| **Solid** | 细粒度响应式、性能极佳 | 生态最小 |

**建议**：Svelte（性能 + 简洁性最佳，符合"轻量"基调）；v0.2 拍板。

### 4.2 桌面壳（待决）

候选：

| 方案 | 优点 | 缺点 |
|---|---|---|
| **Tauri** | 小（~5MB）、快、Rust 后端 | 需装 Rust |
| **Electron** | 成熟、npm 生态 | 大（>100MB） |
| **纯 Web**（localhost） | 零安装 | 每次启动需开服务 |

**建议**：先做**纯 Web**（localhost），v1.0 后评估 Tauri 包装。

### 4.3 组件划分

| 组件 | 路径 | 状态 |
|---|---|---|
| Main Screen（会话列表） | `src/ui/main/` | PRD §11.2 |
| Session Window | `src/ui/session/` | PRD §11.3 |
| Settings Panel | `src/ui/settings/` | PRD §9 |
| Session Detail（只读） | `src/ui/session-detail/` | PRD §11.2 |

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
ContextInjector.run(messages)
   │  - injectSystemContext
   │  - injectLastReview
   │  - injectHomework
   │  - injectMistakes
   │
   ▼
LLMClient.chat(streaming)
   │  - 流式返回 tokens
   │
   ├─→ UI: 边显示边 TTS（按句切分增量合成）
   │
   ├─→ 若有 tool_call:
   │     ├─→ ToolRegistry.execute(toolCall)
   │     ├─→ 把 tool result 追加到 messages
   │     └─→ 递归调用 LLMClient.chat
   │
   ▼
完成本 turn，等待下一用户消息
```

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
   ├─→ LanceDB.upsert({vector, text: summary, keywords, ...})
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
│   ├── vocabulary.ts
│   ├── homework.ts
│   ├── topic-stats.ts
│   └── index.ts
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
| **D2** | 跨 session 唯一通道：摘要 + LanceDB 检索 | 压缩信息、降低 token 消耗 | 滚动 N 轮原文 |
| **D3** | 单 agent + 工具，不上多 agent | 简化 prompt 工程、易调试 | 多 agent（planner/executor/...） |
| **D4** | Summarizer 是单独 agent 调用 | 任务 prompt 完全不同 | 在主 agent 里加 mode 切换 |
| **D5** | Local-first（SQLite + LanceDB + 文件） | 隐私、零外部依赖、可移植 | 云存储 |
| **D6** | Voice 走浏览器 Web Speech API | 零部署、跨平台 | Whisper 本地 / 云 TTS |
| **D7** | Prompts 是 markdown 数据 | 改 prompt 不需 rebuild、走 git diff | 写在 .ts 里 |
| **D8** | 话题计数自动（关键词 Jaccard 匹配） | 无需手动标注 | 用户打 tag |
| **D9** | Context Injector 设计成中间件链 | 扩展性好、单元测试容易 | 单一函数拼装 |
| **D10** | Embedding 先用 OpenAI API | 质量保证 | 本地 MiniLM（v1.x 评估） |

每个决策的具体 rationale 见 `docs/adr/`（待 v0.2 启动时补 ADR 文件）。

---

## 8. 外部依赖

### 8.1 运行时（`dependencies`）

| 包 | 用途 | 备选 |
|---|---|---|
| `@anthropic-ai/sdk` | Claude API | OpenAI |
| `openai` | OpenAI API / embedding | — |
| `better-sqlite3` | SQLite | node:sqlite (实验性) |
| `lancedb` | 向量存储 | chromadb (需 server) |
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
| `LLM_MODEL_EMBEDDING` | `text-embedding-3-small` | Embedding 模型 |
| `LLM_EMBEDDING_PROVIDER` | `openai` | `openai` / `local`（v1.x） |
| `LLM_TEMPERATURE` | `0.7` | 采样温度 |
| `LLM_MAX_TOKENS` | `2048` | 单轮输出上限 |
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
| `data/oral-teacher.db` | SQLite | 实时 |
| `data/vectors/` | LanceDB 文件 | session END 时 |
| `data/sessions/*.md` | 完整 transcript | session END 时 |
| `data/cache/` | 临时文件（embedding 缓存） | 实时 |

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
