# Architecture Design

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  UI Layer — React 19 + Vite 6 + Tailwind CSS 4                   │
│  ┌──────────────────┐ ┌─────────────────────────────────────────┐ │
│  │ SessionSidebar   │ │ Main Content (Routes)                   │ │
│  │ · New Session    │ │ ┌──────────────────────────────────────┐ │ │
│  │ · Session List   │ │ │ SessionPage / HistoryPage / Settings │ │ │
│  │ · Settings Link  │ │ │ / SetupPage / TopicLibraryPage       │ │ │
│  │ · Topic Lib Link │ │ └──────────────────────────────────────┘ │ │
│  └──────────────────┘ └─────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                              │ HTTP REST + SSE
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Web Server — Hono on Node.js, src/server.ts                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │
│  │  Sessions    │  │  Settings    │  │  SSE Stream  │            │
│  │  REST API    │  │  REST API    │  │  Handler     │            │
│  └──────────────┘  └──────────────┘  └──────────────┘            │
│                              │ uses                               │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  turn.ts — runTurn(input) → AsyncGenerator<TurnEvent>       │ │
│  │  Shared by server and CLI. Houses the core conversation loop.│ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Agent Core                                                      │
│  ┌──────────────┐ ┌───────────────┐ ┌────────────────┐          │
│  │  State       │ │  Prompt       │ │  Topic         │          │
│  │  Machine     │ │  Builder      │ │  Engine        │          │
│  │  (4 phases)  │ │  (system +    │ │  (select/      │          │
│  │              │ │   context)    │ │   dedup/record)│          │
│  └──────────────┘ └───────────────┘ └────────────────┘          │
│  ┌──────────────┐ ┌───────────────┐ ┌────────────────┐          │
│  │  Tools       │ │  Summarizer  │ │  Profile       │          │
│  │  (mistake/   │ │  (session-end│ │  Extractor     │          │
│  │   search/    │ │   summary)   │ │  (interests/   │          │
│  │   select)    │ │              │ │   warmUpSeed)  │          │
│  └──────────────┘ └───────────────┘ └────────────────┘          │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  LLM Layer                                                       │
│  ┌──────────────────┐ ┌──────────────────┐                       │
│  │  Anthropic SDK   │ │  OpenAI Fetch    │                       │
│  │  (x-api-key)     │ │  (Authorization) │                       │
│  │  MiniMax/default │ │  DeepSeek/OpenAI │                       │
│  └──────────────────┘ └──────────────────┘                       │
│  ┌──────────────────┐ ┌──────────────────┐                       │
│  │  Retry (2 tries) │ │  Debug Log       │                       │
│  └──────────────────┘ └──────────────────┘                       │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Storage Layer                                                   │
│  ┌──────────────────┐ ┌──────────────────┐ ┌────────────────┐   │
│  │  SQLite          │ │  Vector Store    │ │  File System   │   │
│  │  (better-        │ │  (384-dim BLOB)  │ │  (preferences, │   │
│  │   sqlite3)       │ │  brute-force     │ │   USER.md,     │   │
│  │  sessions,       │ │  cosine search   │ │   debug logs)  │   │
│  │  messages,       │ │  (MiniLM-L6-v2)  │ │                │   │
│  │  mistakes,       │ │                  │ │                │   │
│  │  topics, stats   │ │                  │ │                │   │
│  └──────────────────┘ └──────────────────┘ └────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

## 2. Module Boundaries

### 2.1 `src/agent/` — Agent Core

| File | Responsibility |
|------|---------------|
| `turn.ts` | Main conversation loop. Builds system prompt, calls LLM, handles tool calls, yields SSE events. Used by both server and CLI. |
| `state-machine.ts` | Phase detection and transition (WARM_UP → MAIN_ACTIVITY → WRAP_UP → END) based on elapsed time and user signals. |
| `context-injector.ts` | Builds the `[System Context]` block injected into each turn's prompt. Contains last session summary, current phase, timer. |
| `prompt-builder.ts` | Assembles the full system prompt: SOUL + AGENTS + STUDENT profile + TOOLS reference + dynamic context. |
| `tool-registry.ts` | Registers available LLM tools (`mark_mistake`, `memory_search`, `summarize_history`, `topic_select`). |
| `tool-parser.ts` | Parses `<tool>...</tool>` XML blocks from LLM responses. |
| `topic-engine.ts` | Topic selection algorithm with three-tier dedup: 30-day hard exclusion (D1), discussion-count soft penalty (D2), keyword-freshness bias (D5). |
| `topic-counter.ts` | MIN_TOPIC_AGE gate — prevents topic switching for the first 5 user turns. Explicit requests bypass via regex. |
| `topic-recorder.ts` | Write-on-selection ledger. Records adopted topics (from phase auto-inject or LLM tool calls) to `topic_stats` and `keyword_hits` at session end. |
| `topic-matcher.ts` | Fallback topic matching: Jaccard + hitRatio similarity between session keywords and topic library keywords. |
| `summarizer.ts` | Calls a separate LLM call at session end to produce a 50-150 token summary + 3-8 keywords. |
| `profile-extractor.ts` | Extracts new student interests and warm-up seeds from the session summary; updates USER.md. |
| `retrieval.ts` | Loads last session review (summary + keywords) and relevant past sessions via vector similarity. |

### 2.2 `src/llm/` — LLM Providers

Two wire formats supported:

| Provider | File | Header | Endpoint Path | SDK |
|----------|------|--------|---------------|-----|
| Anthropic-compatible | `anthropic.ts` | `X-Api-Key` | `/v1/messages` | `@anthropic-ai/sdk` |
| OpenAI-compatible | `openai.ts` | `Authorization: Bearer` | `/chat/completions` | native `fetch` |

**Design decision**: The API style is user-selectable via Web UI (`API_STYLE` env var). The Anthropic SDK provides native streaming and caching support; the OpenAI path uses raw fetch for minimal dependencies.

- `retry.ts` — Classified retry: 5xx + connection errors retry up to 2 times (1s delay); 4xx errors pass through immediately.
- `debug-log.ts` — Writes per-turn JSONL diagnostic logs to `data/llm-debug/` when `DEBUG_LOG_LLM=1`.
- `testing.ts` — Replay and throwing providers for automated tests. Replay reads fixture files from `tests/fixtures/replay/`.

### 2.3 `src/memory/` — Embedding & Vector Store

- **Model**: `Xenova/all-MiniLM-L6-v2` (int8 quantized), 384-dim, ~25MB. Loaded via `@huggingface/transformers` ONNX pipeline. Singleton with lazy initialization.
- **Storage**: `sessions.embedding` BLOB column (1536 bytes = 384 × Float32). No external vector DB — brute-force cosine similarity on ~1K rows is <1ms.
- **Index**: `embedder.ts` generates embeddings from summary text. `vector-store.ts` provides `findSimilar(summaryEmbedding, topK)` with cosine distance.
- **No INDEX on embedding column** — negative optimization for tiny row counts. Brute-force is faster than the B-tree overhead.

### 2.4 `src/storage/` — Persistence

**Database**: SQLite via `better-sqlite3` (synchronous, no WAL for single-process safety).

| Table | Purpose |
|-------|---------|
| `sessions` | Session metadata (start/end time, duration, phase history, summary, keywords, topics_used, embedding BLOB) |
| `messages` | Per-turn messages (role, content, timestamp, voice_used) |
| `mistakes` | Tagged errors (type, original, corrected, reviewed flag) |
| `topics` | Topic library entries (name, keywords JSON, description, level) |
| `topic_stats` | Per-topic discussion counters (discussion_count, last_discussed_at) |
| `keyword_hits` | Per-(topic, keyword) hit counts for freshness bias |

**Migrations**: Sequential `.sql` files in `src/storage/migrations/`. Applied via `applyMigrations()` at startup. Migration files are embedded into the pkg bundle by `scripts/patch-bundle.cjs`.

### 2.5 `src/config/` — Configuration

- `env.ts` — Zod-validated environment schema with defaults. `loadEnv()` merges `process.env` + `AppData/.env` + `CWD/.env` with priority: process.env > AppData > CWD > schema defaults.
- `secrets.ts` — API key resolution chain: `process.env` → `AppData/.env` → `CWD/.env`. `setEnvVar()` and `setApiKey()` write atomically to `AppData/.env` and update `process.env` for immediate effect.
- `paths.ts` — Platform-aware data directory resolution. Windows: `%APPDATA%\EnglishOralTeacher\`. macOS: `~/Library/Application Support/english-oral-teacher/`. Linux: `$XDG_CONFIG_HOME/english-oral-teacher/`.

### 2.6 `src/prompts/` — Prompt Management

- `loader.ts` — Loads `.md` prompt files at startup. In production (pkg bundle), reads from `globalThis.EMBEDDED_PROMPTS` (injected at build time). In dev mode, reads from disk with hot-reload on server restart. Validates H1 presence via `assertHasH1()`.

**Prompt files** (loaded into system prompt):

| File | Role |
|------|------|
| `SOUL.md` | AI persona — identity as Alex the English teacher, 7 iron rules, tone |
| `AGENTS.md` | Operating manual — session mechanics, tool usage guidelines |
| `USER.md` | Student profile — name, age, level, goals, interests (auto-updated by profile-extractor) |
| `tools.md` | Tool calling specification — exact XML syntax and rules for each tool |
| `phases.md` | Per-phase instructions (Context + Reminder blocks for WARM_UP, MAIN_ACTIVITY, WRAP_UP, END) |
| `summarizer-system.md` | Summarizer agent system prompt (separate LLM call, not injected into main prompt) |

### 2.7 `src/agent/tools/` — LLM Tools

Three tools available to the AI teacher:

| Tool | Function | When called |
|------|----------|-------------|
| `topic_select` | Selects the next conversation topic. Returns slug, title, keywords, suggested_keyword. | On MAIN_ACTIVITY entry (auto) or when LLM decides to switch topics. |
| `mark_mistake` | Records a student error to the `mistakes` table. | When LLM detects a grammar/vocab/word-choice error. |
| `memory_search` | Searches past session summaries via vector similarity. | When LLM needs context from previous conversations. |

## 3. Data Flow: One Conversation Turn

```
1. Browser sends user message → POST /api/sessions/:id/stream?action=turn&input=...
2. server.ts creates TurnInput { messages, phase, warmUpHook, adoptedTopics }
3. turn.ts runTurn():
   a. Build system prompt (prompt-builder: SOUL + AGENTS + USER + TOOLS + context-injector)
   b. Check context budget (LLM_CONTEXT_BUDGET_TOKENS); truncate history if needed
   c. Mark last 2 messages with cache_control (Anthropic ephemeral caching)
   d. Call LLM → stream tokens via SSE
   e. Parse <tool> blocks from LLM response
   f. Execute tools, yield results to caller
   g. If tool results exist, make a 2nd LLM call with tool context
   h. Record adopted topics (topic-recorder)
   i. Yield TurnEvents (text-chunk, phase, ctx, tool-call, topic-adopted, warn, error, done)
4. server.ts forwards TurnEvents as SSE text-chunk events
5. Browser renders text progressively (typewriter effect)
```

## 4. Session Lifecycle

```
POST /api/sessions → create session (in-memory SessionRuntime)
  ↓
WARM_UP (0-5 min) → casual greeting, reference last session's warmUpHook
  ↓ auto topic_select at phase transition
MAIN_ACTIVITY (5-25 min) → topic discussion, tool calls, MIN_TOPIC_AGE gate
  ↓ 25 min or user says "stop"
WRAP_UP (25-30 min) → summarize progress, highlight errors, homework
  ↓ 30 min or goodbye exchange
END → summarize → embed → record topics → extract profile → mark ended
  ↓
Session closes, sidebar auto-refreshes. Server stays alive for next session.
```

## 5. API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/sessions` | List sessions (no messages) |
| POST | `/api/sessions` | Create session, returns `{id, warmUpHook}` |
| GET | `/api/sessions/:id` | Session detail with messages |
| GET | `/api/sessions/:id/stream?action=turn&input=...` | SSE turn stream |
| DELETE | `/api/sessions/:id` | Delete session (cascade) |
| GET | `/api/settings` | Current settings (USER.md + preferences) |
| PUT | `/api/settings` | Save settings |
| GET | `/api/topics` | Topic list with hitCount + keywordHits |
| PUT | `/api/topics` | Save topic edits (whitelist filter) |
| GET | `/api/setup/status` | Setup wizard status |
| GET | `/api/setup/profile-default` | Profile defaults |
| POST | `/api/setup/api-key` | Save API key + LLM config |
| POST | `/api/setup/profile` | Save student profile |
| POST | `/api/diagnostic/log` | Web-side diagnostic event log |
| GET | `/api/update/check` | Update check (reserved) |
| GET | `/assets/*` | Static SPA assets |
| GET | `/*` | SPA fallback (index.html) |

## 6. SSE TurnEvent Types

| Event | Description |
|-------|-------------|
| `text-chunk` | Streaming text delta from LLM |
| `phase` | Phase transition notification |
| `ctx` / `ctx-segment` / `ctx-block` | Debug: injected system context |
| `student-text` | Echo of the user's input text |
| `tokens` | Usage stats (input/output/cache tokens) |
| `tool-call` | Tool invocation result |
| `topic-adopted` | Topic recorded to ledger (source: auto or llm) |
| `warn` | Context budget warning |
| `error` | Error message |
| `done` | Turn complete |

## 7. Build Pipeline

```
TypeScript + Vite build
    ↓
esbuild --bundle (ESM → CJS, inlines all JS)
    ↓
scripts/patch-bundle.cjs (polyfill import.meta.url, inline prompts/SQL/web assets)
    ↓
@yao-pkg/pkg (bundles Node.js runtime → standalone .exe)
    ↓
Inno Setup 6 (.iss script → Windows installer .exe)
```

Key dependencies kept external from esbuild: `better-sqlite3`, `onnxruntime-node`, `@huggingface/transformers` (native `.node` binaries).

## 8. Key Design Decisions

1. **Single-process architecture** — CLI and server share the same DB engine. No multi-process coordination needed.
2. **SQLite without WAL** — single writer, synchronous mode. `proper-lockfile` for cross-process coordination when CLI + server run concurrently.
3. **Brute-force vector search** — 384-dim × ~1K rows < 1ms. No external vector DB dependency.
4. **Write-on-selection topic tracking** — topic statistics recorded at selection time (not from summary keywords), ensuring accurate dedup signals.
5. **ESM → CJS bundle for pkg** — `@yao-pkg/pkg` cannot resolve ESM exports. esbuild `--bundle` inlines everything into a single CJS file. Patch script handles the remaining incompatibilities.
6. **AppData/.env as single source of truth** — Web UI writes here; `loadEnv()` reads from here. No need for a .env in the install directory.
7. **No RUN_LIVE_LLM toggle** — system always runs in live mode. Testing uses `LLM_TEST_FAIL` env var for injecting failures.
8. **Anthropic ephemeral caching** — last 2 messages marked with `cache_control` to reduce token costs on multi-turn conversations.
