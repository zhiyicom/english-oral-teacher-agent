# PRD: English Oral Teacher Agent

> **本文档是 `docs/REQUIREMENTS.md` 的细化版**。聚焦在数据 schema、状态机、交互流程、错误处理、按功能的验收标准等可落地细节。
>
> **文档关系**
> - `REQUIREMENTS.md` —— 高层需求（为什么做、给谁做、做什么、范围外）
> - `PRD.md`（本文）—— 详细需求（怎么做、做到什么程度）
> - `prompts/` —— 提示词源（agent 的具体行为指令）
> - `docs/adr/` —— 架构决策记录（为什么选这个技术）

---

## 1. 用户画像配置（USER.md Schema）

### 1.1 文件位置

- **模板**：`prompts/USER.md.example`（commit 进 git）
- **实例**：`prompts/USER.md`（**gitignored**），由模板复制 + 填实际信息

### 1.2 字段定义

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `name` | string | ✓ | — | 称呼（agent 用来称呼学生） |
| `age` | int | — | null | 岁数；用于难度调节 |
| `native_language` | enum | — | `zh-CN` | 母语，用于 `allow_chinese_help` 时的辅助语言 |
| `target_language` | enum | — | `en-US` | 目标语言 |
| `level` | enum | ✓ | `unspecified` | 见 1.3 |
| `goals` | string[] | — | `[]` | 学习目标，每条一句话 |
| `interests` | string[] | — | `[]` | 兴趣话题关键词，用于话题库筛选 |
| `avoid_topics` | string[] | — | `[]` | 不希望谈的话题 |
| `schedule.frequency_per_week` | int | — | 5 | 每周几次 |
| `schedule.duration_min` | int | — | 30 | 每次目标时长 |
| `schedule.preferred_time` | enum | — | `evening` | `morning` / `afternoon` / `evening` |
| `preferences.tone` | enum | — | `friendly` | `friendly` / `strict` / `playful` |
| `preferences.correction_style` | enum | — | `gentle` | `gentle` / `direct` / `after_session` |
| `preferences.allow_chinese_help` | bool | — | true | 是否允许必要时用母语辅助 |
| `preferences.voice_enabled` | bool | — | true | 是否默认开语音 |
| `preferences.voice_speed` | float | — | 1.0 | TTS 语速倍率（0.8-1.5） |
| `preferences.voice_accent` | enum | — | `en-US` | TTS 口音：见 1.3 |
| `notes` | string | — | `""` | 自由文本备注（性格、家庭情况、特殊情况） |

### 1.3 枚举值

**`level`**：
- `unspecified` —— 未设定（agent 用温和默认）
- `beginner` —— 零基础
- `elementary` —— 小学水平（A1-A2）
- `intermediate` —— 初中水平（B1）
- `upper-intermediate` —— 高中水平（B2）
- `advanced` —— C1+
- `ielts-{n}` / `toeic-{n}` / `cet-{n}` —— 标准化考试分数（如 `ielts-6.5`）

**`correction_style`**：
- `gentle` —— 不打断，引导学生自己改
- `direct` —— 立即纠正
- `after_session` —— 不在对话中纠，session 末统一列出

**`voice_accent`**：
- `en-US` —— 美式英语（默认）
- `en-GB` —— 英式英语
- `en-AU` —— 澳式英语
- `en-IN` —— 印度英语

### 1.4 完整示例

```yaml
# 示例 A：初中生
name: 小张
age: 13
level: elementary
goals:
  - 能流利聊学校生活
  - 准备 PETS 二级
interests: [篮球, 学校趣事, 游戏, 朋友]
avoid_topics: [政治]
schedule:
  frequency_per_week: 5
  duration_min: 30
  preferred_time: evening
preferences:
  tone: friendly
  correction_style: gentle
  allow_chinese_help: true
  voice_enabled: true
  voice_speed: 1.0
notes: |
  性格偏内向，被直接纠正容易紧张。家长希望他每天 30 分钟。
  周末可以延长到 45 分钟。
```

```yaml
# 示例 B：备考高中生
name: Sarah
age: 17
level: ielts-6.5
goals:
  - 半年内雅思口语 6.5
  - 能就抽象话题连贯表达
interests: [climate change, AI, 留学申请, 心理学]
schedule:
  frequency_per_week: 4
  duration_min: 45
  preferred_time: afternoon
preferences:
  tone: strict
  correction_style: direct
  allow_chinese_help: false
notes: 已在准备雅思，已有较好基础但表达不够展开。
```

### 1.5 加载规则

- 启动时读 `prompts/USER.md`，若不存在则提示"未配置用户画像，请编辑 prompts/USER.md"
- 配置变更后无需重启，下次 session 开始时生效
- 配置字段缺失时使用默认值（不报错）

---

## 2. 话题库 Schema

### 2.1 目录结构

```
prompts/topics/
├── daily_life/
│   ├── morning-routine.md
│   └── favorite-hobby.md
├── school/
│   ├── favorite-subject.md
│   └── best-friend.md
├── current_events/
│   ├── climate-change.md
│   └── ai-impact.md
└── _index.yaml          # 话题索引（供 LLM 检索）
```

### 2.2 Frontmatter 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | string | ✓ | 话题标题（对话中显示给学生） |
| `level` | enum | ✓ | 适合的水平（见 1.3） |
| `age_range` | [int, int] | — | 适合年龄区间 |
| `est_minutes` | int | ✓ | 预估时长（5-30） |
| `category` | string | ✓ | 分类（与目录名一致） |
| `keywords` | string[] | ✓ | 关键词（用于匹配学生 interests） |
| `opening` | string | ✓ | 开场问题，agent 直接问 |
| `core_questions` | string[] | ✓ | 核心问题（3-5 个） |
| `backup_questions` | string[] | — | 备用问题（卡壳时用） |
| `target_vocab` | string[] | — | 重点词汇 |
| `transition_phrases` | string[] | — | 引导学生深入的句型 |

### 2.3 Markdown 正文

可选部分，放在 frontmatter 之后：

```markdown
# 引导方向

> 写给 agent 的隐性指令：什么时候追问、什么时候切话题、学生沉默时怎么提示。

- 如果学生回答 < 5 个词：用 "Could you tell me a bit more?" 追问
- 如果学生讲得很细：先肯定，再用 transition_phrases 拉回来
- 5 分钟讲不到核心点：切换到 backup_questions
```

### 2.4 完整示例

```markdown
---
title: Your favorite hobby
level: elementary
age_range: [10, 14]
est_minutes: 15
category: daily_life
keywords: [hobby, free time, interest, weekend]
opening: "Hi! Tell me, what do you like to do when you have free time?"
core_questions:
  - "What's your favorite hobby? Why do you enjoy it?"
  - "When did you start doing it? Who introduced you to it?"
  - "How often do you do it each week?"
  - "Do your friends share the same hobby?"
backup_questions:
  - "What do you need for it? Any special equipment?"
  - "Is it popular in China? How about in other countries?"
target_vocab:
  - hobby / pastime
  - be into / be passionate about
  - spend time on / devote time to
transition_phrases:
  - "That's interesting! Could you give me an example?"
  - "I see. How did that make you feel?"
---

# 引导方向

- 鼓励具体例子（不要停留在 "I like it" 层面）
- 5 分钟未到 core_question #2，主动追问
- 末段尝试把"我"扩展到"我身边的人"
```

### 2.5 索引文件 `_index.yaml`

```yaml
# 启动时一次性加载，供选题器快速筛选
topics:
  - slug: daily_life/favorite-hobby
    title: Your favorite hobby
    level: elementary
    est_minutes: 15
    keywords: [hobby, free time]
  - slug: school/favorite-subject
    title: Your favorite subject
    level: elementary
    est_minutes: 12
    keywords: [school, study]
```

> 索引可在启动时由代码扫描 `prompts/topics/**/*.md` 自动生成，不需要手写。

---

## 3. 记忆系统 Schema

### 3.1 三层记忆

| 层级 | 范围 | 存储 | 用途 |
|---|---|---|---|
| **会话内** | 当前 session | 内存（结束时落盘） | 维持当前 session 对话流畅性 |
| **跨会话结构化** | 跨 session | SQLite | 统计、归档、用户查询 |
| **跨会话语义** | 跨 session | SQLite BLOB（`sessions.embedding`） | 新 session 启动时检索相关历史摘要 |

> **会话独立性原则**：每个 session 是独立单元。**session 之间不共享滚动上下文**——上一 session 的对话原文不会自动带入下一 session。跨 session 信息仅通过摘要检索（在新 session 启动时做一次）注入。

### 3.2 SQLite Schema

```sql
-- 一次完整会话
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,        -- UUID
  started_at      TEXT NOT NULL,           -- ISO 8601
  ended_at        TEXT,
  duration_min    INTEGER,
  phase_history   TEXT,                    -- JSON: [{phase, at_min}]
  summary         TEXT,                    -- 1-3 句总结
  keywords        TEXT,                    -- JSON: ["hobby", "reading"] —— 提取自摘要
  topics_used     TEXT,                    -- JSON: [{slug, est_minutes}] —— 关键词匹配后命中
  homework        TEXT,                    -- 本次布置的作业
  transcript_path TEXT                     -- 完整 transcript 文件路径
);

-- 单条消息
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL,              -- 'user' | 'assistant' | 'system'
  content     TEXT NOT NULL,
  ts          TEXT NOT NULL,
  voice_used  INTEGER DEFAULT 0,          -- 0/1
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 学生学过的单词
CREATE TABLE vocabulary (
  word         TEXT PRIMARY KEY,
  learned_at   TEXT NOT NULL,
  last_seen_at TEXT,
  mastery      INTEGER DEFAULT 0,         -- 0-5，0=刚学，5=完全掌握
  source_topic TEXT                       -- 哪个话题里学到的
);

-- 错例
CREATE TABLE mistakes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type       TEXT,                        -- 'grammar' | 'vocab' | 'word_choice'
  original   TEXT NOT NULL,
  corrected  TEXT NOT NULL,
  ts         TEXT NOT NULL,
  reviewed   INTEGER DEFAULT 0            -- 是否已在之后 session 复习
);

-- 作业
CREATE TABLE homework (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  assigned_at   TEXT NOT NULL,
  content       TEXT NOT NULL,
  due_at        TEXT,
  completed_at  TEXT
);

-- 索引
CREATE INDEX idx_messages_session ON messages(session_id, ts);
CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_mistakes_session ON mistakes(session_id);
```

### 3.3 向量索引（SQLite BLOB）

**存储位置**：`sessions` 表新增 `embedding BLOB` 列（migration 005，v0.7.2）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` (主键) | string | session_id（与 sessions.id 同一行） |
| `embedding` | BLOB (1536 bytes) | raw Float32Array bytes，summary 文本的 384-dim embedding |
| `summary` | TEXT | 原始 summary（同一行，供 LLM 用） |
| `keywords` | TEXT (JSON) | 提取自摘要的关键词（3-8 个） |
| `started_at` | TEXT | 会话开始时间 |

**Embedding 模型**：本地 `Xenova/all-MiniLM-L6-v2` int8 量化（q8），384 维，~25MB 下载。`@huggingface/transformers` 跑 ONNX，进程内 pipeline singleton 懒加载。`HF_ENDPOINT` env 支持镜像（`hf-mirror.com` 等）。**不引入 LanceDB**——v0.7.2 评估后决定 SQLite BLOB 已够用（brute-force cosine 在 1000 × 384 维 < 1ms，省一个进程外依赖）。

**写入时机**：session END 时，summary 写入 SQLite 后嵌入成 1536-byte BLOB 写回同 row 的 `embedding` 列。占位 summary `"(summarization failed)"` 跳过 embed（不污染向量库）。

**检索方式**：brute-force cosine similarity on candidate set（listWithEmbeddings 过滤 NULL）。**无 INDEX**（负优化）。

### 3.4 检索规则

| 场景 | 时机 | 检索方式 | 返回数量 |
|---|---|---|---|
| **启动时回顾上次** | 新 session 启动 | `SELECT summary, keywords, topics_used FROM sessions ORDER BY started_at DESC LIMIT 1` | **1**（最近一次） |
| 启动时引用相关（v0.7.2） | 新 session 启动 | cosine 检索 `sessions.embedding`（query = 上次 session 关键词） | top 2 |
| 选题（去重 + 偏好） | 新 session 启动 | 见 §3.5.3 | 1 |
| 错例复习 | 新 session 启动 | `SELECT * FROM mistakes WHERE reviewed = 0` | 全部 |
| 作业跟进 | 新 session 启动 | `SELECT * FROM homework WHERE completed_at IS NULL` | 全部 |
| 工具调用（mid-session） | agent 主动调用 | 同上 | 1-3 |

> **新 session 启动时**至少把"上次 session 摘要 + 待复习错例 + 待办作业"打包注入 [System Context]。  
> "回顾上次"是**默认行为**（用户可关闭，见 §11.x），引用相关是**可选补充**。  
> session 进行中 agent 可以通过工具主动查询，但**默认不滚动带入之前的对话原文**。

---

### 3.5 话题统计与关键词匹配

#### 3.5.1 `topic_stats` 表

```sql
CREATE TABLE topic_stats (
  topic_slug        TEXT PRIMARY KEY,    -- 话题 slug（与 topic library 一致）
  discussion_count  INTEGER DEFAULT 0,   -- 被讨论的累计次数
  last_discussed_at TEXT                 -- 上次被讨论的 session 开始时间
);
```

> 计数是**累计**的，不会因为时间推移而衰减；时间维度单独由 `last_discussed_at` 表达。

#### 3.5.2 关键词匹配流程

session END 时，summarizer 输出 `session.keywords`（3-8 个英文词或短语）后：

1. 对 topic library 每个 topic，计算两个评分（`src/agent/topic-matcher.ts:33-55`）：
   ```
   jaccard    = |session.keywords ∩ topic.keywords| / |session.keywords ∪ topic.keywords|
   hitRatio   = |session.keywords ∩ topic.keywords| / |session.keywords|
   score      = max(jaccard, hitRatio)
   ```
2. 命中条件：**至少 1 个关键词共有** AND `score ≥ 0.1`（阈值 `topic-matcher.ts:36`）
3. 命中的 topic：
   - 追加到 `session.topics_used`（去重）
   - `UPDATE topic_stats SET discussion_count = discussion_count + 1, last_discussed_at = session.started_at`

> **阈值说明**：topic.keywords 数组通常 3-6 个词，session.keywords 3-8 个词。0.1 是宽松阈值——只要有 1 个词命中就匹配（hitRatio 至少 `1/sessionKwCount`，3-8 词时为 0.125-0.33）。hitRatio 评分让单关键词也能匹配（如 "football" → sports），不需要全部 session 关键词都属于该话题。
> 关键词匹配是**自动的**——用户不能手动把某次 session 算到不相关的话题下。

#### 3.5.3 选题去重 + 偏好策略

新 session 启动时，按以下顺序筛选：

| 步骤 | 规则 | 行为 |
|---|---|---|
| 1. 硬排除 | `topic_stats.last_discussed_at > date('now', '-N days')` | 直接踢出候选池。`N` 默认 30（`topic-select.ts:22` 工具参数 `exclude_recent_days`），LLM 可传 0-365。0 = 不排除 |
| 2. 软偏好 | 在剩余候选中 `ORDER BY topic_stats.discussion_count ASC` | 讲得少的优先 |
| 3. 兴趣匹配 | `student.interests ∩ topic.keywords` 非空优先 | 提升排序 |
| 4. 加权随机 | 综合 1-3 得分，加小量随机噪声避免每次都同一话题 | 选 top 1 |

> 三个信号（时间、计数、兴趣）共同作用，但**时间是最硬的**——`exclude_recent_days` 天内讲过的绝对不会重讲；计数和兴趣是软偏好。

---

## 4. 状态机详细规范

### 4.1 阶段定义

| 阶段 | 时长 | 进入条件 | 行为 | 退出条件 |
|---|---|---|---|---|
| **WARM_UP** | 0-5 min | session_start | 寒暄、1 个简单问题 | 5 分钟到 → MAIN_ACTIVITY |
| **MAIN_ACTIVITY** | 5-25 min | WARM_UP 结束 | 主动对话、学生说 70%、教词汇 | 25 分钟到 → WRAP_UP；用户要停 → END |
| **WRAP_UP** | 25-30 min | MAIN_ACTIVITY 结束 | 总结今日、布置作业、写入会话记录 | 30 分钟到 → END；用户要停 → END |
| **END** | — | WRAP_UP 结束 / 用户要停 / 30 分钟到 | 写入 summary 和 transcript、告别 | 进程退出 |

### 4.2 转换触发分类

- **时间触发**：基于 `session.elapsed_min`
- **用户触发**：用户说 "stop" / "bye" / "I'm tired" / "下课了"
- **系统触发**：LLM 错误、UI 关闭

### 4.3 边界情况处理

| 情况 | 检测 | 处理 |
|---|---|---|
| 用户沉默 2 分钟 | `last_user_message_ts - now > 2min` | 提示 "Are you still there? Take your time." |
| 用户沉默 5 分钟 | > 5min | 提示 "Want to continue, or call it a day?" |
| 用户沉默 10 分钟 | > 10min | 自动进入 WRAP_UP |
| 用户明确要停 | 关键词匹配 + LLM 意图识别 | 立即进入 END |
| 连续 3 次短答（<5 词） | `messages[-3:].content.length < 5` | 切话题或给提示 |
| LLM 错误 | API 4xx/5xx | 见 §7.1 |
| 用户跑题 | LLM 意图识别 | 1 次温和拉回；持续跑题则顺势聊 1 轮 |
| 网络中断 | 流超时 | 见 §7.2 |

### 4.4 跨天重置

- 检测：`new Date(session.started_at).toDateString() !== new Date().toDateString()`
- 触发时：提示 "Looks like a new day — should we start fresh?"
- 若用户确认：重置 `start_time`、清空 `last_message_time`、保留所有历史记录

---

## 5. LLM 交互规范

### 5.1 Agent 架构

**单 Agent + 工具调用**（v1.0）：

- 主对话走单 agent
- 工具：
  - `memory_search(query, top_k)` —— 向量检索历史
  - `topic_select(phase, exclude_recent_days)` —— 选题（去重 + 兴趣匹配）
  - `mark_homework(content, due_days)` —— 记录作业
  - `mark_mistake(type, original, corrected)` —— 记录错例

**未来扩展**（v1.x）：单独的 summarizer agent 在 session 末调用。

### 5.2 流式输出

- **是**，所有 agent 回复走 SSE 或 WebSocket 流
- UI 收到第一个 token 后立即显示
- TTS 在收到第一句完整句子时开始播放（不等待全文）

### 5.3 Token 预算（初始值，可调）

| 部分 | 上限 | 说明 |
|---|---|---|
| 系统提示词（SOUL + AGENTS） | 1.5K | 静态 |
| USER.md 渲染 | 0.3K | 静态 |
| 注入的 `[System Context]` | 0.2K | 动态 |
| 启动时检索到的历史摘要（≤3 条） | 0.6K | 动态，仅 WARM_UP 前注入一次 |
| 启动时加载的待办 / 错例 | 0.3K | 动态，仅 WARM_UP 前注入一次 |
| **当前 session 完整对话** | < 3K | 动态，session 内累积 |
| 工具结果（如有） | 0.5K | 动态 |
| **单轮总输入** | **< 6K** | 硬性（v1.0 起点） |
| 单轮 assistant 输出 | < 0.5K | 软性 |

> **关键变化**：去掉"最近 10 轮"硬限制。当前 session 是独立单元，理论上可累积到 ~30 轮（30 × 平均 50 token ≈ 1.5K-3K）。超出后由 agent 主动调用 summarizer 工具压缩当 session 的历史（不跨 session 滚动）。

### 5.4 Prompt 注入顺序

```
[1] System: SOUL.md 内容（# SOUL 块）
[2] System: AGENTS.md 内容（# AGENTS 块）
[3] System: USER.md 渲染（# STUDENT 块）
[4] System: tools.md 内容（# TOOLS 块，可选）
[5] System: [System Context] 块（动态；WARM_UP 前含历史摘要、待办等）
[6] Tool results（如有）
[7] User: 当前 session 完整对话
[8] User: 当前消息
```

> 与旧版的本质区别：`[7]` 是**当前 session 的完整对话**（从 session 开始到当前 turn），不是滚动窗口。
> `[1]` 和 `[2]` 的实际拼装见 `src/prompts/loader.ts:112-127`（`buildSystemString`）。v0.7.6 起 `[7]` 的最后 2 条消息加 `cache_control: ephemeral`（Anthropic 提示缓存），详见 `docs/ARCHITECTURE.md` §5.2。

---

## 6. 关键交互流程

### 6.1 启动 → WARM_UP

```
1. 读 prompts/USER.md（无则提示配置）
2. 读 prompts/topics/_index.yaml
3. 加载"上次回顾"（注入 WARM_UP 用）：
   a. 从 sessions 表读 `ORDER BY started_at DESC LIMIT 1` → 上次 summary + keywords + topics_used
   b. （可选）向量检索补充 top 2 相关历史摘要
   c. 加载未完成作业
   d. 加载待复习错例
4. 选开场话题（按 §3.5.3 三层筛选）：
   a. 硬排除：topic_stats.last_discussed_at 在 30 天内
   b. 软偏好：剩余候选按 topic_stats.discussion_count ASC
   c. 兴趣匹配：student.interests 与 topic.keywords 命中
   d. 综合排序选 top 1
5. 注入 [System Context] WARM_UP（含上次摘要、待办、阶段、计时）
6. agent 说开场白（可软引用上次摘要作为"承接"——可选，不是硬性）
7. 等待用户回复 → 进入主循环

> "回顾上次"是**默认行为**。新 session 启动时一定会带上"上次 session 的 summary + 关键词 + 涉及话题"，但是否引用、怎么引用由 agent 决定（软）。

### 6.2 MAIN_ACTIVITY 主循环

```
loop:
  1. 收到用户消息
  2. 检查是否要切换话题（短答 3 次 / 跑题 / 长时间停留）
  3. 注入 [System Context] MAIN_ACTIVITY
  4. 调用 LLM（带工具）
  5. 流式输出到 UI + TTS
  6. agent 可能调用 tool：
     - mark_mistake：记录到 SQLite
     - mark_vocabulary：记录新词
  7. 检查阶段时间 → 可能进入 WRAP_UP
  8. 检查用户意图 → 可能进入 END
```

### 6.3 WRAP_UP

```
1. 注入 [System Context] WRAP_UP
2. agent 总结今日（"Today we talked about X. You learned Y."）
3. agent 布置 1-2 个小作业 → mark_homework
4. 提示 "Anything you want to add or ask?"
5. 写 SQLite: sessions.summary, topics_used
6. （异步）生成向量索引
7. 等待用户确认或继续聊
```

### 6.4 END + 归档

```
1. 注入 [System Context] END
2. agent 告别
3. 关闭流式连接
4. 写 transcript 文件到 data/sessions/<id>.md（完整原文）
5. **调用 summarizer 生成 1-3 句摘要 + 关键词**：
   - 输入：完整 transcript
   - 输出：
     a. 摘要文本（50-150 tokens）
     b. 关键词数组（3-8 个英文词或短语）
   - 写入 SQLite `sessions.summary` 和 `sessions.keywords`
   - 嵌入并存入 SQLite `sessions.embedding` BLOB（1536 bytes）
6. **关键词匹配 + 更新 topic_stats**（见 §3.5.2）：
   - 计算 session.keywords 与每个 topic.keywords 的 Jaccard 相似度
   - 命中 topic 写入 session.topics_used
   - UPDATE topic_stats SET discussion_count += 1, last_discussed_at = session.started_at
7. **关闭当前 session 的 UI 窗口**
8. 退出会话；**进程不退出**，等待用户开下一个新 session
```

> **关键变化**：默认流程中**进程不退出**——用户可以连续开多个 session。第 7 步关闭的是 UI 窗口（独立的对话记录），不是应用本身。进程退出是另一个独立的操作（关闭应用）。

### 6.5 跨天恢复

```
1. 启动时检测：上次 session 是几天前
2. 若 > 1 天：显示"上次是 X 天前，咱们继续/还是新开？"
3. 继续上次：加载上次 summary 作为开场
4. 新开：正常流程
```

---

## 7. 错误处理与降级

### 7.1 LLM API 错误

| 错误 | 检测 | 处理 |
|---|---|---|
| 4xx（客户端错误） | 状态码 | 检查 API key / 模型名，提示用户去 `.env` 检查 |
| 5xx（服务端错误） | 状态码 | 退避重试 3 次（1s/2s/4s），仍失败 → §7.1.1 |
| 流中断 | 30s 无新 token | 视为失败，重试 |
| 内容过滤 | 响应包含 refusal | 重写 prompt 去除敏感内容，再试一次 |

**7.1.1 持续失败降级**：
- 写一条 fallback 消息到 UI："AI service is having issues. Your session is saved at <path>."
- 自动保存当前 session 到 SQLite
- 退出，不丢失数据

### 7.2 网络中断

- **检测**：fetch 抛错 / 流超时
- **处理**：UI 显示离线指示；保留用户消息到本地队列；恢复后自动重发
- **超时**：2 分钟无网络 → 同 §7.1.1 降级

### 7.3 数据文件损坏

- **检测**：启动时跑 `PRAGMA integrity_check`
- **处理**：
  - SQLite 损坏 → 备份为 `<file>.corrupt.<ts>`，创建新库，提示用户
  - 话题库 md 解析失败 → 跳过该话题，警告日志
  - SQLite 损坏（同 sessions.embedding BLOB） → 备份为 `<file>.corrupt.<ts>`，创建新库，提示用户

### 7.4 磁盘满

- **检测**：每次写库前查可用空间
- **处理**：< 100MB → 警告；< 10MB → 拒绝写入，提示用户清理
- **不静默吞错**

### 7.5 进程崩溃

- **预防**：每条消息写入后立即落盘（不缓存）
- **恢复**：启动时检查未关闭的 session，提示"上次的 session 没正常结束，要恢复吗？"

### 7.6 提示词注入失败

- 检测：SOUL.md / AGENTS.md / USER.md 任一缺失或解析失败
- 处理：阻止启动，提示"提示词文件缺失，请检查 prompts/ 目录"

---

## 8. 验收标准（按功能模块）

### F1 对话核心

- [ ] 智能体能就 3 种水平（elementary / intermediate / upper-intermediate）切换语言复杂度
- [ ] 连续 3 次学生答 < 5 词，agent 切话题或主动给提示
- [ ] 至少 1 个 open-ended question 模板（来自 SOUL.md）
- [ ] 不主动纠错（gentle 模式），但记入 mistakes 表

### F2 状态机

- [ ] WARM_UP → MAIN_ACTIVITY 切换在 5 ± 0.5 分钟
- [ ] MAIN_ACTIVITY → WRAP_UP 切换在 25 ± 0.5 分钟
- [ ] WRAP_UP → END 切换在 30 ± 0.5 分钟
- [ ] 用户说"下课"时立即进入 END（< 10s）
- [ ] 跨天后状态机正确重置

### F3 提示词注入

- [ ] 每次 LLM 调用前的 prompt 包含完整的 SOUL + AGENTS + USER + [System Context]
- [ ] 注入顺序符合 §5.4
- [ ] 总输入 < 5K tokens

### F4 记忆系统

- [ ] session 数据 100% 持久化（崩溃后能恢复）
- [ ] USER.md 修改后下次启动生效
- [ ] 选题时**硬排除**最近 30 天内讲过的话题
- [ ] 选题时**软偏好**低 `discussion_count` 的话题
- [ ] 错例、词汇、作业三类数据可查询
- [ ] **新 session 启动时默认加载"上次回顾"**（最近一次 session 的 summary + keywords + topics_used）
- [ ] **新 session 不带入上一 session 的对话原文**（prompt 中无滚动跨 session 上下文）
- [ ] session END 时 summarizer 输出 50-150 token 摘要 + 3-8 个关键词
- [ ] 关键词自动与 topic library 匹配（`max(Jaccard, hitRatio) >= 0.1`），命中后 `topic_stats.discussion_count += 1`

### F5 快速查询

- [ ] 语义查询 "上次讲了什么关于宠物的话题" 返回相关 session
- [ ] 选题查询 0 重复（30 天内）
- [ ] 检索延迟 < 200ms

### F6 语音 I/O

- [ ] STT 转写准确率 > 90%（中英混合场景）
- [ ] TTS 队列无重复播放
- [ ] TTS 30s 引擎暂停可恢复（兼容 Chrome quirk）

### F7 话题库

- [ ] 至少 20 个内置话题
- [ ] 用户编辑 `.md` 后重启生效
- [ ] 自动生成 `_index.yaml`

### F8 会话归档

- [ ] 每次 session END 生成 `conversation-history.md` 摘要
- [ ] 完整 transcript 写入 `teaching-transcript.md`（追加，不覆盖）
- [ ] 旧项目文件格式兼容

### F9 UI

- [ ] 一键开始 / 结束会话
- [ ] 实时显示当前阶段和已用时间
- [ ] 语音按钮可点可关
- [ ] 消息流支持文本 + 语音气泡
- [ ] UI 在 1280×720 分辨率下无横向滚动
- [ ] **主界面显示历史 session 列表，按时间倒序，自动编号（#1, #2, ...）**
- [ ] **历史行可点击查看只读完整 transcript**
- [ ] **[开始新练习] 按钮可开新 session；[结束本次] 按钮关闭当前 session 窗口并回到列表**
- [ ] **session 关闭后不退出应用，可继续开新 session**

---

## 9. UI 设置（运行时可调项）

> 除 `USER.md` 里的默认值外，UI 上也应提供控件让学生随时调整。  
> 设置项分两类：**持久化到 USER.md**（重启保留）/ **session-only**（进程退出后丢失）。

### 9.1 设计原则

- 所有设置变更**即时生效**，不需要重启或重连
- 写回 USER.md 的设置变更采用**原子写**（先写临时文件再 rename），避免崩溃半写入
- session-only 设置在 UI 层用 `localStorage` / `IndexedDB` 临时存储
- 任何设置变更**不影响当前 session 已经在用的 prompt 注入**——只对未来 turn 生效（避免对话中途语境突变）

### 9.2 设置项清单

| 设置项 | 持久化 | 取值 | 默认值来源 | 控件 | v1.0 |
|---|---|---|---|---|---|
| 语音开关 | 写回 USER.md | bool | `preferences.voice_enabled` | 开关按钮 | ✓ |
| 语音语速 | 写回 USER.md | 0.8 - 1.5（步进 0.05） | `preferences.voice_speed` | 滑块 | ✓ |
| 语音口音 | 写回 USER.md | `en-US` / `en-GB` / `en-AU` / `en-IN` | `preferences.voice_accent` | 下拉单选 | ✓ |
| 字体大小 | session-only | 12 - 20 px | 14 px | 滑块 | ✓ |
| 显示调试信息 | session-only | bool | false | 开关 | ✓ |

> 未来扩展位（v1.0 不做）：主题（light/dark）、快捷键自定义、TTS 引擎选择（Web Speech vs edge-tts vs MiniMax TTS）、语种切换。

### 9.3 TTS 引擎映射

口音选项 → 浏览器 TTS voice 选取：

| `voice_accent` | 推荐 voice（Web Speech API 示例） |
|---|---|
| `en-US` | `en-US-*`（Google US English, Microsoft Aria Online） |
| `en-GB` | `en-GB-*`（Microsoft Sonia Neural, Google UK English Female） |
| `en-AU` | `en-AU-*`（Microsoft Natasha, Google AU English） |
| `en-IN` | `en-IN-*`（Microsoft Neerja, Google IN English） |

**降级策略**：

- 应用启动时枚举 `window.speechSynthesis.getVoices()` 并按语言代码筛选
- 若目标口音的 voice 不可用 → 降级到 `en-US` 默认，并在 UI 提示"该口音在当前系统不可用，已切换到美式英语"
- 若系统**完全无 TTS 引擎**（极少数 Linux） → 禁用语音按钮，提示用户

### 9.4 验收增项（F9）

- [ ] 语速滑块 0.8-1.5 范围，0.05 步进，UI 上拖动后下一次 TTS 立即反映
- [ ] 口音下拉至少含 en-US 和 en-GB 两项
- [ ] 切换口音后，下一次 TTS 输出明显改变（人耳可辨）
- [ ] 任何写回 USER.md 的设置变更不需要重启即生效
- [ ] 进程异常退出时，session-only 设置不污染 USER.md

---

## 11. UI 会话列表与编号

### 11.1 模型

应用**始终在运行**（不是"开一个 session、关应用"的模式）。  
每个练习对话是一个**独立单元**，有完整生命周期：

```
[主界面] → [开始新练习] → 检索历史 → 选题 → 对话 → [结束本次] → 关闭窗口 → 回到主界面
```

### 11.2 主界面：会话列表

默认页面，显示所有历史 session：

```
+--------------------------------------------------+
|  English Oral Teacher                            |
|  [🔍 搜索历史]   [开始新练习]                    |
|--------------------------------------------------|
|  会话 #3  2026-06-03 19:30  22 min              |
|           School life — favorite subject        |
|                                                  |
|  会话 #2  2026-06-01 20:00  28 min              |
|           Talking about hobbies                 |
|                                                  |
|  会话 #1  2026-05-30 19:15  18 min              |
|           Weekend activities                    |
+--------------------------------------------------+
```

- **排序**：按时间倒序（最新在最上）
- **编号**：按创建时间升序自动分配（`#1`, `#2`, ...）；一旦分配不可变
- **每行**：编号 / 开始时间 / 时长 / 标题 / 摘要预览
- **单击行** → 进入只读 transcript 视图
- **搜索框** → 跨 session 搜索（关键词 / 语义）

### 11.3 单个 session 窗口

点 [开始新练习] 进入：

```
+--------------------------------------------------+
|  会话 #4  WARM_UP  02:13  ⚙️  [结束本次]         |
|--------------------------------------------------|
|  Agent  Hi! Today let's talk about hobbies...   |
|         [voice ▶]                                |
|  You    I like reading.                          |
|  Agent  Oh nice! What kind of books?            |
|  ...                                             |
|--------------------------------------------------|
|  [🎤 语音]  [输入文字...              ] [发送]   |
+--------------------------------------------------+
```

- 顶部状态栏：会话编号 / 阶段 / 计时器 / 设置按钮 / [结束本次] 按钮
- 主体：消息流（文本 + 语音气泡）
- 底部：输入区（语音 / 文字切换）

### 11.4 结束流程

用户点 [结束本次]：

1. agent 收到 end 信号，进入 END 阶段
2. agent 写告别 + 触发 summarizer
3. transcript + 摘要落盘
4. **窗口关闭，回到主界面列表**
5. 列表自动刷新（新增一行）

> **进程不退出**。用户可以继续点 [开始新练习] 开启新会话。

### 11.5 历史 session 检索

- 在 [开始新练习] 之前，**自动**用新选题关键词去检索 SQLite `sessions.embedding` cosine top-K，top 2 摘要注入新 session 的 [System Context] 的 "Relevant past sessions" 段（见 §6.1）
- 主界面搜索框支持手动跨 session 搜索（关键词 / 语义）

### 11.6 会话编号 vs 文件命名

- **UI 显示**：`会话 #3`
- **内部存储**：`sessions/<YYYY-MM-DDTHH-MM-SS>_<short-id>.md`（仍用时间戳，保证排序稳定）
- **编号**（`#1`, `#2`）是 UI 渲染层根据时间顺序动态计算的，**不是**文件名前缀

---

## 12. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-06-02 | 0.1 | 初稿：USER.md schema、话题库 schema、SQLite schema、状态机、交互流程、错误处理、验收标准 |
| 2026-06-02 | 0.2 | 新增 §9 UI 设置；USER.md schema 新增 `voice_accent` 字段；F9 验收增项 |
| 2026-06-02 | 0.3 | **会话独立性原则**：去掉"最近 N 轮"滚动窗口；新 session 启动时一次性检索 top 3 摘要；session END 时显式 summarizer；新增 §11 UI 会话列表与编号；§10 变更为 §12 |
| 2026-06-02 | 0.4 | **回顾上次机制**：新 session 启动默认加载最近 1 次 session（不再是 top 3 相关）；摘要新增 keywords 字段；新增 §3.5 话题统计与关键词匹配（topic_stats 表 + Jaccard 匹配 + 硬排除/软偏好选题） |
| 2026-06-10 | 0.5 | **§3.3 向量索引改 SQLite BLOB**（v0.7.2）：LanceDB → `sessions.embedding BLOB` (1536 bytes)；embedding 模型定本地 MiniLM-L6-v2 int8 (384 维, ~25MB)；brute-force cosine on candidate set，无 INDEX；§3.1 跨会话语义层存储字段更新；§3.4 启动时引用相关改成 top 2 cosine 检索（排除 lastReview 自己）；§7.3 损坏处理去掉 LanceDB 行 |
