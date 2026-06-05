# Development Plan

> **本文是工程的整体路线图**。回答"按什么顺序、什么算完成"。
> 整体 PRD / ARCHITECTURE / DEVELOPMENT_PLAN 在普通 sprint 中**不变**；sprint 内的细节写在 `docs/sprint/`。
>
> **文档关系**
> - `REQUIREMENTS.md` —— 高层需求
> - `PRD.md` —— 详细需求
> - `ARCHITECTURE.md` —— 系统架构
> - `DEVELOPMENT_PLAN.md`（本文）—— 整体路线图
> - `PROJECT_MANAGEMENT.md` —— 协作流程
> - `docs/sprint/v0.X-*.md` —— **sprint 级设计 / 计划（每个 sprint 一份）**

---

## 1. 迭代原则

1. **每个 sprint 独立可演示** —— 能 `pnpm dev` 跑起来给真人看
2. **每个 sprint 自动化测试必须通过** —— CI 是 sprint 完成的硬性条件
3. **测试和实现同步增长** —— 新模块必有测试，测试不是事后补
4. **能 headless 测的不用人测** —— CLI / API / 库都能跑 vitest；UI 不是测试的前置
5. **UI 是最后包装** —— v0.2-v0.7 全在 headless；v0.8 才有 Web UI
6. **不阻塞在选择上** —— UI 框架 / 桌面壳 / embedding 模型等，待 v0.2 启动时一起拍板
7. **失败早暴露** —— 每个 sprint 跑通前一个 sprint 的所有测试
8. **全局文档稳定** —— PRD / ARCH / DEV_PLAN 只在大方向变化时才改；sprint 内细节进 `docs/sprint/`

---

## 2. Sprint 工作流

每个 sprint 是一次完整的"**计划 → 详细设计 → 编码 → 测试**"循环：

```
[整体 PRD / ARCH / DEV_PLAN 保持稳定]
                ↓
[Sprint 计划]   docs/sprint/v0.X-scope.md     ← 本 sprint 目标 + 验收 + DoD
                ↓
[详细设计]      docs/sprint/v0.X-design.md    ← 文件清单、算法、fixture、风险
                ↓
[编码]          按设计实现
                ↓
[测试]          L1-L3 自动化测试全绿
                ↓
[Demo + CHANGELOG]
                ↓
[设计 doc 标 IMPLEMENTED]
                ↓
[下一个 sprint]
```

### 2.1 Sprint 时间分配（粗略）

| 活动 | 时间占比 |
|---|---|
| Sprint 计划 + 详细设计 | 15-20% |
| 编码 | 50-60% |
| 测试 | 20-30% |
| Demo + 收尾 | 5% |

### 2.2 Sprint 文档应包含

- 本 sprint 涉及的文件清单
- 关键算法 / 伪代码
- 测试 fixture 清单（要录制哪些 LLM 响应）
- 实现顺序
- 本 sprint 内风险

### 2.3 Sprint 文档**不**应包含

- 整体架构（ARCHITECTURE 写过）
- 需求 / schema（PRD 写过）
- 测试原则（见 §4）
- 路线图（见 §3）

### 2.4 全局文档何时更新

| 触发 | 文档 | 操作 |
|---|---|---|
| 整体需求变了 | PRD | 改 + commit |
| 模块边界变了 | ARCHITECTURE | 改 + commit |
| 路线图调整 | DEVELOPMENT_PLAN | 改 + commit |
| sprint 内细节 | `docs/sprint/v0.X-*` | 改本 sprint 文档 |

> **规则**：在 sprint 内部能改清楚的，就不要动全局文档。**反过来**：发现全局文档不对，先停 sprint，改全局文档，再继续。

### 2.5 Sprint 完成标记

设计 doc 头部加：

```markdown
<!-- STATUS: IMPLEMENTED on 2026-06-XX -->
```

---

## 3. 路线图

| Sprint | 状态 | 主题 | 关键 demo | 估计工时 | 自动化测试要求 |
|---|---|---|---|---|---|
| v0.1 | ✅ | 工程脚手架 | `pnpm dev` 打印一行 | 半天 | L1 ≥ 3 |
| v0.2 | ⏳ | **CLI + LLM** | 终端和 Claude 用 persona 对话 5 分钟 | 2-3 天 | L1 ≥ 5, L3 ≥ 1 |
| v0.3 | ⏳ | 持久化 | 1 session 结束后，DB 能查回 | 2 天 | L1 ≥ 5, L2 ≥ 2, L3 ≥ 1 |
| v0.4 | ⏳ | 状态机 | 模拟 30 分钟，session phase 切换 4 次 | 3-4 天 | L1 ≥ 8, L2 ≥ 2, L3 ≥ 2 |
| v0.5 | ⏳ | 记忆 | 跑 2 个 session，第二个看到第一个的摘要 | 3 天 | L1 ≥ 3, L2 ≥ 2, L3 ≥ 2, **L4 ≥ 1** |
| v0.6 | ⏳ | 摘要 + 话题 | session 结束生成 summary + 更新 topic_stats | 2 天 | L1 ≥ 3, L3 ≥ 2 |
| v0.7 | ⏳ | 工具 | agent 在对话中调用 mark_mistake 并写入 | 2 天 | L1 ≥ 3, L3 ≥ 2 |
| v0.8 | ⏳ | Web UI | 浏览器看到主界面 + session 窗口 | 5-7 天 | L1 ≥ 5, L3 ≥ 3, **E2E ≥ 2** |
| v0.9 | ⏳ | 语音 | 浏览器语音输入 + TTS 播放 | 3 天 | L1 ≥ 3, L3 ≥ 1 |
| v1.0 | ⏳ | 打磨 | 端到端跑通 + 文档 + 发布 | 5-7 天 | 全 L1-L4 绿 |

> **L1** 纯单元（毫秒）/**L2** 单元+IO mock（<1s）/**L3** 集成（秒）/**L4** 烟雾测试（真 LLM，分钟）。详见 §4。

> "session phase 切换 4 次"指的是 WARM_UP / MAIN_ACTIVITY / WRAP_UP / END 四个**会话阶段**——和 sprint 是不同概念。

---

## 4. 测试架构

### 4.1 四层测试金字塔

| 层 | 名称 | 工具 | 速度 | 何时跑 | 失败影响 |
|---|---|---|---|---|---|
| **L1** | 纯单元 | vitest | 毫秒 | 每次 commit / save | 阻塞 PR |
| **L2** | 单元 + I/O mock | vitest + mock LLM / mock DB | < 1s | 每次 commit | 阻塞 PR |
| **L3** | 集成（真组件 + mock LLM） | vitest | 秒 | 每次 PR | 阻塞 merge |
| **L4** | 烟雾测试（真 LLM） | vitest + 真 API | 秒到分钟 | 发版前 / nightly | 阻塞 release |

**L1-L3 必须在 CI 通过**才算 sprint 完成。L4 是发版门槛，sprint 阶段可选跑。

**每 sprint 至少要有**：L1 单元测试 + L3 集成测试。从 v0.5 起建议加 L4 烟雾测试。

### 4.2 LLM 调用：Replay 模式 vs Live 模式

测试 agent 时不可能每次都打真 LLM——贵、慢、不稳定。引入两种模式：

**Replay 模式**（默认，CI 用）：

- 从 `tests/fixtures/llm/*.json` 读预录的 LLM 响应
- 速度快（<1s）、CI 友好、确定性
- 第一次跑 `pnpm test:live` 时自动录制
- 缺点：fixture 可能过期（prompt 改了就重录）

**Live 模式**（手动 / 发版前）：

- 真打 LLM，需要 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`
- 跑 `RUN_LIVE_LLM=1 pnpm test:live`
- 跑通后自动更新 fixture
- 验证：响应非空、含 persona 风格、不含禁忌词

**实现**：

```ts
// src/llm/testing.ts
export function getTestLLMClient(opts: {fixture: string}): LLMClient {
  if (process.env.RUN_LIVE_LLM === '1') {
    return new AnthropicProvider({apiKey: process.env.ANTHROPIC_API_KEY})
  }
  return new ReplayProvider(loadFixture(opts.fixture))
}
```

### 4.3 Agent 行为测试

测试 agent 不是测试代码，而是测试"**给定输入，agent 做什么**"：

```ts
test('agent 拒绝回答明显跑题的问题', async () => {
  const response = await runAgent({userMsg: '写一首关于猫的诗'})
  expect(response.text).not.toMatch(/猫/)           // 不该接诗
  expect(response.text).toMatch(/let's focus on/i)  // 应该拉回话题
})

test('agent 在 WARM_UP 阶段问 open-ended 问题', async () => {
  const response = await runAgent({
    userMsg: 'I had lunch.',
    phase: 'WARM_UP',  // ← session phase
  })
  expect(response.text).toMatch(/\?$/)  // 应该以问号结尾
})

test('agent 调用 mark_mistake 工具记录错例', async () => {
  const response = await runAgent({userMsg: 'I go to school yesterday'})
  expect(response.toolCalls).toContainEqual(
    expect.objectContaining({name: 'mark_mistake'})
  )
})
```

**断言套路**（避免脆性）：

| 模式 | 例子 | 适用 |
|---|---|---|
| 包含关键词 | `toMatch(/let's focus/)` | persona 行为 |
| 不包含禁忌词 | `not.toMatch(/[[audio_as_voice]]/)` | 铁律验证 |
| 以问号结尾 | `toMatch(/\?$/)` | 引导式回复 |
| 工具被调用 | `toolCalls` 数组包含某 tool | 工具调用 |
| 状态转换 | `stateMachine.current === 'MAIN_ACTIVITY'` | 状态机 |
| 副作用 | DB 查询断言某行存在 | 持久化 |

**不**断言具体措辞（agent 措辞会变）。

### 4.4 测试目录结构

```
tests/
├── unit/                     # L1
│   ├── env.test.ts
│   ├── state-machine.test.ts
│   └── jaccard.test.ts
├── integration/              # L2 + L3
│   ├── session-e2e.test.ts
│   ├── retrieval.test.ts
│   └── tools.test.ts
├── fixtures/
│   ├── llm/                  # Replay 用
│   │   ├── claude-hello.json
│   │   ├── claude-goodbye.json
│   │   └── claude-tool-call.json
│   └── transcripts/
│       └── sample-session.md
└── e2e/                      # v0.8+ 用
    └── ui.spec.ts            # Playwright
```

### 4.5 CI 流水线（v0.3 起）

```yaml
# .github/workflows/ci.yml（待 v0.3 创建）
- pnpm install
- pnpm typecheck
- pnpm lint
- pnpm test          # L1+L2+L3
# L4 不在 CI（用真 API key），改 nightly
```

---

## 5. 各 Sprint 详细说明

> 每个 sprint 实施时，先在 `docs/sprint/v0.X-scope.md` 写 sprint 计划、`docs/sprint/v0.X-design.md` 写详细设计，再开始编码。

### v0.1 工程脚手架 ✅

**目标**：仓库可初始化、所有工具链跑通

**自动化测试**：L1 ≥ 3（env 解析、biome 配置、tsconfig 路径）

**已完成**：
- 目录结构、配置
- `package.json` + `tsconfig.json` + `biome.json`
- 文档

---

### v0.2 CLI + LLM ← **下一个 sprint**

**目标**：用户在终端输入 → 调用 LLM → 看到响应（**用 persona 说话**）

这是整个项目的"心脏验证"。

**模块**：

```
src/
├── config/env.ts             # 读 .env
├── prompts/loader.ts         # 读 SOUL/AGENTS/USER
├── llm/
│   ├── types.ts
│   ├── anthropic.ts
│   └── testing.ts            # Replay/Live 切换
├── cli.ts                    # 简单 REPL
└── index.ts
```

**新依赖**：`@anthropic-ai/sdk`, `gray-matter`, `zod`, `dotenv`

**自动化测试**（L1 ≥ 5, L3 ≥ 1）：

| 层 | 测试 | 工具 |
|---|---|---|
| L1 | `env.ts` 解析 .env 4 个 case | vitest |
| L1 | `prompts/loader.ts` 读 SOUL.md 返回非空 | vitest |
| L1 | `AnthropicProvider` 消息格式转换（user / assistant / system） | vitest |
| L1 | `ReplayProvider` 从 fixture 读响应 | vitest |
| L3 | CLI 跑 1 turn，Replayed 响应包含 greeting 关键词 | vitest + tsx |

**L4 烟雾测试**（手动 / 发版前）：

```bash
RUN_LIVE_LLM=1 pnpm test:live
# 1. 启动 CLI
# 2. 输入 "hi"
# 3. 验证响应非空、引用 persona 风格
# 4. 录制 fixture
```

**手动 demo**（可选，给真人看）：

```bash
$ pnpm dev
English Oral Teacher Agent — CLI mode
Type "exit" to quit.

> Hi
[Claude]: Hi there! How are you doing today? ...
```

**暂不做**：状态机、记忆、工具、UI、语音、持久化

---

### v0.3 持久化

**目标**：session 内的消息写到 SQLite，关掉应用再开能查回

**模块**：

```
src/storage/
├── db.ts                     # better-sqlite3 连接 + 迁移
├── migrations/001_init.sql
├── sessions.ts               # sessions DAO
└── messages.ts               # messages DAO
```

**新依赖**：`better-sqlite3`, `@types/better-sqlite3`

**自动化测试**（L1 ≥ 5, L2 ≥ 2, L3 ≥ 1）：

| 层 | 测试 | 工具 |
|---|---|---|
| L1 | migration 跑通，6 张表都存在 | vitest + 临时 DB |
| L1 | sessions DAO CRUD | vitest + 临时 DB |
| L1 | messages DAO append / getBySession 顺序 | vitest + 临时 DB |
| L2 | db 文件创建在临时目录 | fs + 清理 |
| L2 | PRAGMA integrity_check 通过 | vitest |
| L3 | CLI 跑 5 轮对话 → 重启 → 历史可查回 | vitest + tsx + 临时 DB |

**手动 demo**：

```bash
$ pnpm dev
> Hi
...
$ ls data/
oral-teacher.db
$ sqlite3 data/oral-teacher.db "SELECT count(*) FROM messages;"
5
```

---

### v0.4 状态机（model C：silence=hint 不切 phase）

**目标**：4 个 session phase 按时切换 + [System Context] 注入 + silence 作为 hint 给 LLM

**phase 切换的两条路径**：
1. **时间边界**（5 / 25 / 30 min）—— 自动
2. **用户说 stop**（整句）—— 立即到 END

**silence 不切 phase**：state machine 仍计算 `silenceMin` 并塞进 state，但**不**据此切 phase。理由：13 岁小孩沉默多在思考，state machine 硬切会打断；让 LLM 看到 `Silence: 4.0 min` 自己决定怎么回应。`phaseHistory` 只记 time-based + user_stop 两类切换。

**模块**：

```
src/agent/
├── clock.ts
├── state-machine.ts        # getPhase + applyEvent（model C：TICK 不带 silence 分支）
├── context-injector.ts     # buildSystemContext（包含 phase + elapsed + silence）
├── prompt-builder.ts       # 拼 final system
└── index.ts
```

**自动化测试**（L1 ≥ 8, L2 ≥ 2, L3 ≥ 2）：

| 层 | 测试 | 工具 |
|---|---|---|
| L1 | `getPhase(0/4/6/24/26/29/30/31)` 8 个 | vitest |
| L1 | 用户说 "stop" → 立即 END | vitest |
| L1 | **silence 10 min 不切 phase**（WARM_UP / MAIN_ACTIVITY / WRAP_UP 各自断言） | fake timer |
| L1 | `buildSystemContext` 包含 phase + elapsed + silence（即便 silence=0 也显示） | vitest |
| L1 | USER_MSG 重置 silenceMin=0 | vitest |
| L2 | fake timer 模拟 30 分钟，phaseHistory 3 条 time-based 切换 | fake timer |
| L2 | 状态转换不合法时报错（`validatePhaseTransition` 抛错） | vitest |
| L3 | CLI 1 turn：stdout 含 `[System Context] Phase: WARM_UP` | vitest + tsx |
| L3 | CLI MOCK_TIME 6 轮：第 6 轮 phase = MAIN_ACTIVITY | fake timer |
| L3 | CLI 用户说 "stop"：下一轮 phase = END + loop 退出 | vitest + tsx |

**手动 demo**：`MOCK_TIME=true pnpm dev`，跑 5 轮看 elapsed 跳到 5.0、silence 几乎 0。跑 6 轮看 phase 切到 MAIN_ACTIVITY。

**详细设计 / 范围**：[sprint/v0.4-scope.md](./sprint/v0.4-scope.md) / [sprint/v0.4-design.md](./sprint/v0.4-design.md)

> **历史**：v0.4 原本想用 model A（silence 阈值触发 phase 切），review 时改为 model C——见 v0.4-scope.md §9 变更记录。

---

### v0.5 记忆

**目标**：session 启动时加载"上次回顾"摘要

**模块**：

```
src/memory/
├── embeddings.ts             # OpenAI embedding
├── vector-store.ts           # LanceDB
└── index.ts

src/agent/
└── retrieval.ts              # retrieveLastReview()
```

**新依赖**：`lancedb`

**自动化测试**（L1 ≥ 3, L2 ≥ 2, L3 ≥ 2, L4 ≥ 1）：

| 层 | 测试 | 工具 |
|---|---|---|
| L1 | Jaccard 相似度算法 | vitest |
| L1 | `retrieveLastReview` 返最近 1 条 | vitest + 临时 DB |
| L2 | embedding 调用（Replayed）返 vector 长度 1536 | Replay |
| L2 | LanceDB upsert + search top-1 命中自己 | LanceDB 临时目录 |
| L3 | session A 写入摘要 → session B 启动 prompt 包含 A 的摘要 | vitest + Replay |
| L3 | session B 启动后第一次 LLM call 包含 A 的关键词 | mock LLM 断言 input |
| L4 | 真 embedding + 真 LanceDB，跑 2 session，验证检索 | RUN_LIVE_LLM=1 |

---

### v0.6 摘要 + 话题统计

**目标**：session END 自动生成 summary + keywords + 匹配 topic + 更新 topic_stats

**模块**：

```
src/agent/summarizer.ts       # 单独 agent 调用
src/storage/topic-stats.ts
src/storage/migrations/002_topic_stats.sql
```

**自动化测试**（L1 ≥ 3, L3 ≥ 2）：

| 层 | 测试 | 工具 |
|---|---|---|
| L1 | summarizer 输出 schema 校验（summary 长度、keywords 数量） | zod |
| L1 | Jaccard 匹配算法（已在 v0.5 写过，验证复用） | vitest |
| L3 | session END → DB + LanceDB + topic_stats 全部更新 | vitest + Replay |
| L3 | summarizer Replayed 响应 → topic_stats `discussion_count += 1` | vitest |

---

### v0.7 工具

**目标**：agent 在对话中能调用工具

**模块**：

```
src/agent/tools/
├── memory-search.ts
├── topic-select.ts
├── mark-mistake.ts
├── mark-vocabulary.ts
└── mark-homework.ts

src/agent/tool-registry.ts
```

**自动化测试**（L1 ≥ 3, L3 ≥ 2）：

| 层 | 测试 | 工具 |
|---|---|---|
| L1 | 每个工具的 zod schema 验证（错误输入抛错） | zod |
| L1 | tool-registry 注册和查找 | vitest |
| L3 | agent 调用 mark_mistake → DB 出现新行 | vitest + Replay |
| L3 | agent 调用 memory_search → 返回相关 session | vitest + Replay |

---

### v0.8 Web UI

**目标**：从 CLI 升级到 Web 界面

**模块**：

```
src/ui/                       # 前端
├── main/
├── session/
├── session-detail/
├── settings/
└── shared/
```

**新依赖**：UI 框架（v0.2 启动时定）、`@playwright/test`（E2E）

**自动化测试**（L1 ≥ 5, L3 ≥ 3, E2E ≥ 2）：

| 层 | 测试 | 工具 |
|---|---|---|
| L1 | 各组件渲染快照 | vitest + @testing-library |
| L1 | IPC 客户端到 server 序列化 | vitest |
| L3 | API 端到端（POST /sessions, GET /sessions/:id） | vitest + supertest |
| L3 | SSE 流式响应正确 | vitest |
| E2E | 浏览器开主界面 → 看到列表 | Playwright |
| E2E | 点 [开始新练习] → session 窗口 → 看到流式回复 → 结束 → 列表多 1 行 | Playwright |

---

### v0.9 语音

**目标**：STT 输入 + TTS 输出

**模块**：

```
src/voice/
├── stt.ts
├── tts.ts
└── queue.ts
```

**自动化测试**（L1 ≥ 3, L3 ≥ 1）：

| 层 | 测试 | 工具 |
|---|---|---|
| L1 | TTS 队列 FIFO | vitest |
| L1 | voice accent 切换重新选 voice | mock speechSynthesis |
| L1 | 句子切分（按 `.` `?` `!` 切） | vitest |
| L3 | 浏览器 STT 按钮 → mock SpeechRecognition → 文字进入输入框 | Playwright + mock |

> Web Speech API 难自动化，主要靠手动 demo。

---

### v1.0 打磨

**目标**：可发布版本

**包含**：
- 错误处理完善（PRD §7）
- 设置面板 UI（PRD §9）
- 旧 OpenClaw 数据迁移脚本
- README 完善
- 第一次 GitHub Release
- CI 配置（lint + test + build）

**验收**（PRD §6）：所有 L1-L4 测试全绿，30 分钟 e2e 跑通。

---

## 6. Definition of Done

**每个 sprint 完成的硬性条件**：

- [ ] 该 sprint 计划的 L1/L2/L3 自动化测试**全部通过**（`pnpm test`）
- [ ] v0.5 起至少 1 个 L4 测试**真跑过**（手记日志或 CI artifact）
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm lint` 通过
- [ ] Demo 命令能跑（`pnpm dev` 或 `pnpm demo:v0.x`）
- [ ] CHANGELOG.md 新增一行
- [ ] 没有未提交的代码

**未达到上述 7 条不算 sprint 完成**，不允许进入下一个。

---

## 7. Agile 实践总结

| 实践 | 本计划如何落实 |
|---|---|
| **Working software over docs** | 每个 sprint 都有可跑的 demo |
| **Iterations** | 10 个 sprint，每个 2-7 天 |
| **Customer collaboration** | 单人项目 = 维护者本人 + 学生用户；每 sprint 自己 review 一次 |
| **Responding to change** | 路线图不是死的——v0.2 启动时会拍板 UI / embedding / 桌面壳 |
| **TDD-friendly** | vitest 已配；新模块"测试和实现同步增长"原则 |
| **Continuous integration** | v0.3 起配 GitHub Actions |
| **Sustainable pace** | 估计工时按"每天 4-6 小时有效编码"算，不爆肝 |

---

## 8. 风险与回退

| 风险 | 触发条件 | 回退方案 |
|---|---|---|
| LLM API 成本超预期 | 月账单 > $X | 切到本地小模型（v1.x 评估） |
| Web Speech 不可用 | 用户用 Linux 桌面 | 禁用语音按钮，纯文本 |
| LanceDB 性能差 | session 数 > 1000 检索变慢 | 改 Qdrant（需 server） |
| Tauri 打包问题 | 二进制启动失败 | 退回纯 Web（localhost） |
| 旧 OpenClaw 迁移数据脏 | 字段对不上 | 提供"重新摘要"工具 |
| LLM Replay fixture 维护成本高 | prompt 一改就要重录大量 fixture | 缩小 fixture 覆盖范围，只录关键场景 |

---

## 9. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-06-02 | 0.1 | 初稿：10 个 sprint、模块 / 测试 / demo / 风险 |
| 2026-06-02 | 0.2 | **重写**：引入 4 层测试金字塔（L1-L4）、Replay/Live LLM 测试模式、Agent 行为测试套路、Definition of Done 7 条、Agile 实践总结；每 sprint 自动化测试要求显式列出 |
| 2026-06-02 | 0.3 | **命名变更**：`phase` → `sprint`；新增 §2 Sprint 工作流（计划 → 设计 → 编码 → 测试循环），明确"全局文档 vs sprint 文档"边界；§3 表格加 sprint 状态列 |
