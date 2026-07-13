# English Oral Teacher

A local AI agent for English oral practice. Runs entirely on your PC — one-click Windows installer, zero command line, zero Node.js required.

## Features

- **Windows one-click installer** — desktop/start-menu shortcuts, uninstaller, upgrade detection
- **Two LLM protocols** — supports Anthropic-compatible (MiniMax, etc.) and OpenAI-compatible (DeepSeek, OpenAI, OpenRouter, etc.) APIs
- **Voice I/O** — speech recognition (STT) and text-to-speech (TTS) via browser Web Speech APIs
- **Four-phase session** — Warm Up → Main Activity → Wrap Up → End, with automatic state transitions and timers
- **30-topic default library** — A1 through B2 levels, editable via Web UI with per-keyword hit statistics
- **Topic dedup** — automatic 30-day hard exclusion and discussion-count-based soft preference to keep conversations fresh
- **Long-term memory** — session summaries, 384-dim embeddings (MiniLM-L6-v2), cosine-similarity retrieval across sessions
- **Mistake collection** — grammar/vocab/word-choice errors auto-tagged by the AI teacher, reviewable in history
- **Student profile** — YAML-based profile with level, goals, interests; auto-extracted and updated each session
- **Web UI** — React 19 + Vite 6, sidebar layout with session list, history viewer, settings, and topic editor
- **Debug logging** — opt-in per-turn LLM request logging for troubleshooting
- **Setup wizard** — first-launch guided configuration for API key and student profile

## Quick Start

### Windows installer (recommended)

1. Download `EnglishOralTeacher-Setup-v1.0.9.exe` from [GitHub Releases](https://github.com/zhiyicom/english-oral-teacher-agent/releases)
2. Double-click → install → desktop/start-menu shortcuts created
3. Launch → browser opens → fill in API key + LLM settings + student profile → start practicing

### Dev mode (for contributors)

```bash
pnpm install
pnpm --dir web install
cp .env.example .env       # fill in API_KEY + provider settings
pnpm dev-web                # Hono server (8787) + Vite dev (5173)
```

Open `http://localhost:5173`. The Vite dev server proxies `/api/*` to the Hono server on port 8787.

### Production single-port

```bash
pnpm build
pnpm start                 # single process serves SPA + API on :8787
```

Open `http://localhost:8787`.

### CLI mode (no Web UI)

```bash
pnpm dev                   # tsx watch src/cli.ts
```

## Project Layout

```
src/
├── agent/          # state machine, turn loop, topic engine, tools, summarizer, profile-extractor
├── llm/            # Anthropic SDK + OpenAI fetch providers, debug log, retry logic
├── memory/         # embeddings (MiniLM-L6-v2 via transformers.js ONNX), vector store, retrieval
├── storage/        # SQLite DAOs (sessions, messages, mistakes, topics, keyword_hits) + migrations
├── config/         # env loading, secrets (API key), paths (AppData directory)
├── prompts/        # prompt loader + LLM prompt files (SOUL, AGENTS, phases, tools, summarizer)
├── cli.ts          # CLI entry point (REPL)
└── server.ts       # Hono API server (REST + SSE)
web/
├── src/
│   ├── components/   # MainPage, SessionPage, SetupPage, SettingsPage, HistoryPage, TopicLibraryPage
│   ├── lib/          # api.ts, types.ts, i18n/strings.ts
│   └── ...
prompts/            # SOUL.md, AGENTS.md, USER.md.example, phases.md, tools.md, summarizer-system.md
data/               # runtime data (gitignored) — sessions DB, embeddings, debug logs, preferences
installer/          # pkg config, Inno Setup script (.iss), icons
scripts/            # build-installer.sh, patch-bundle.cjs, etc.
docs/               # ARCHITECTURE.md, USER_MANUAL.md, PRD.md, BUILD_INSTALLER.md, sprint/
```

## License

[MIT](LICENSE)
