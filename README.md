# English Oral Teacher Agent

A local AI agent for English oral practice. Runs entirely on your PC, with a dedicated UI, memory system, timed lesson phases, and voice I/O.

> **Status: v1.0.4** — voice I/O (STT/TTS), multi-session memory with vector search, editable topic library with per-keyword hit stats, Web UI with persistent sidebar, phase-graded explicit correction, no-emoji rule, clean LLM prompt assembly (H1 dedup + last-session single-source + visually obvious active row).
>
> See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design and [CHANGELOG.md](CHANGELOG.md) for release history.

## Goals

- Standalone agent (not built on top of an existing framework)
- Local PC execution with its own AI interface
- Long-term memory across sessions (summaries + 384-dim embeddings in SQLite BLOB)
- Timed state machine (warm-up → main → wrap-up → end)
- Voice I/O via browser Web Speech APIs
- Automatic prompt injection (system context, phase, student profile)
- Editable topic library with hit statistics (`prompts/topic-library.md` + Web UI at `/topics`)
- LLM provider: **MiniMax** (Anthropic-SDK compatible — `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`); other Anthropic-API-compatible vendors work by changing that URL

## Quick start

```bash
pnpm install
pnpm --dir web install
cp .env.example .env       # fill in API_KEY (MiniMax key) and set RUN_LIVE_LLM=1
pnpm dev-web                # Hono server (3000) + Vite dev (5173) concurrently
```

Open `http://localhost:5173`. The Vite dev server proxies `/api/*` and `/assets/*` to the Hono server on port 3000.

### Production single-port (UI + API on 3000)

```bash
pnpm build                 # pnpm --dir web build && tsc && pnpm build:copy-assets → dist/web/ + dist/storage/migrations/
pnpm start                 # node dist/server.js — single process serves SPA + API on :3000
```

Open `http://localhost:3000`.

### CLI mode (no Web UI)

```bash
pnpm dev                   # tsx watch src/cli.ts
# or
pnpm build && pnpm cli     # node dist/cli.js
```

## What's in v1.0.4

- **Prompt assembly cleanup** (§1.1 / §1.2): system prompt is now byte-clean — each section's `# <Title>` H1 lives in the source file itself (`prompts/SOUL.md`, `prompts/AGENTS.md`, `prompts/USER.md`, `prompts/tools.md`); the last-session summary is a one-line pointer in `[System Context]` and the full text lives in the WARM_UP first-turn synthetic user message (single source, no duplication). Runtime guard `assertHasH1()` fails fast if a hand-maintained prompt file loses its heading.
- **Sidebar active-row highlight** (§1.5): the row corresponding to the session you're looking at is now visually obvious (`bg-slate-300 text-slate-900 font-medium`). The previous `bg-blue-50` was too low-contrast. Bug fix: the highlight now also applies on `/history/:id`, not just `/session/:id`.
- **v1.0.3 (still in v1.0.4)**: WARM_UP opener hook — the LLM-curated `next_warm_up_seed` keyword from the previous session is cached server-side and threaded into the next session's first-turn hint. Sidebar session delete is now one-click (no confirm dialog). Settings page has a Cancel button.
- **v1.0.2 (still in v1.0.4)**: per-(topic, keyword) hit stats in `keyword_hits` table; `topic_select` tool returns `suggested_keyword`; Web `/topics` page shows `(N)` next to each topic and each keyword chip; `MIN_TOPIC_AGE=5` bug fix for rapid topic-switching; SSE 2nd-call drop bug fix; turn-level diagnostic logging.

## Project layout

```
src/
├── agent/         # state machine, turn loop, topic engine, tools, profile-extractor
├── llm/           # Anthropic-SDK client (pointed at MiniMax), replay, debug-log
├── memory/        # embeddings (transformers.js ONNX, MiniLM-L6-v2 q8) + vector search
├── storage/       # SQLite DAOs + migrations (sessions, messages, mistakes, topics, keyword_hits)
├── prompts/       # prompt loader (loader.ts) — SOUL/AGENTS/USER/tools + assertHasH1
├── cli.ts         # CLI entry (REPL)
└── server.ts      # Hono API server (REST + SSE)
web/
├── src/
│   ├── components/  # MainPage, SessionPage, HistoryPage, SettingsPage, TopicLibraryPage, SessionSidebar, VoiceInput, HotkeyInput, shared/
│   ├── lib/         # api.ts, types.ts
│   └── i18n/        # strings.ts (zh-CN)
prompts/           # SOUL.md, AGENTS.md, USER.md, USER.md.example, phases.md, summarizer-system.md, tools.md, topic-library.md
data/              # runtime data (gitignored — sessions DB, embeddings, llm-debug/, preferences.json)
tests/             # vitest (server) + Playwright (web e2e)
docs/              # ARCHITECTURE.md + USER_MANUAL.md + PRD.md + REQUIREMENTS.md + sprint/{v*,scope,design,test-report}/
```

## License

[MIT](LICENSE)
