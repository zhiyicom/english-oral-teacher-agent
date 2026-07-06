# English Oral Teacher Agent

A local AI agent for English oral practice. Runs entirely on your PC, with a dedicated UI, memory system, timed lesson phases, and voice I/O. **Now available as a one-click Windows installer.**

> **Status: v1.0.6** — Windows one-click installer, zero-command setup wizard, editable topic library, per-keyword hit stats, voice I/O (STT/TTS) with Chrome/Edge detection, multi-session memory, debug logging.
>
> See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design and [CHANGELOG.md](CHANGELOG.md) for release history.

## Quick start

### Windows installer (recommended for end users)

1. Download `EnglishOralTeacher-Setup-v1.0.6.exe` from [GitHub Releases](https://github.com/zhiyicom/english-oral-teacher-agent/releases)
2. Double-click → install → desktop shortcut created
3. Launch → browser opens automatically → fill in API key + student profile → start practicing

**Zero command line. Zero Node.js required.** The installer bundles everything.

### Dev mode (for contributors)

```bash
pnpm install
pnpm --dir web install
cp .env.example .env       # fill in API_KEY (MiniMax key) and set RUN_LIVE_LLM=1
pnpm dev-web                # Hono server (8787) + Vite dev (5173) concurrently
```

Open `http://localhost:5173`. The Vite dev server proxies `/api/*` and `/assets/*` to the Hono server on port 8787.

### Production single-port (UI + API on 8787)

```bash
pnpm build                 # pnpm --dir web build && tsc && pnpm build:copy-assets → dist/web/ + dist/migrations/
pnpm start                 # node dist/server.js — single process serves SPA + API on :8787
```

Open `http://localhost:8787`.

### CLI mode (no Web UI)

```bash
pnpm dev                   # tsx watch src/cli.ts
# or
pnpm build && pnpm cli     # node dist/cli.js
```

## Goals

- Standalone agent (not built on top of an existing framework)
- Local PC execution with its own AI interface
- Long-term memory across sessions (summaries + 384-dim embeddings in SQLite BLOB)
- Timed state machine (warm-up → main → wrap-up → end)
- Voice I/O via browser Web Speech APIs
- Automatic prompt injection (system context, phase, student profile)
- Editable topic library with hit statistics (`prompts/topic-library.md` + Web UI at `/topics`)
- LLM provider: **MiniMax** (Anthropic-SDK compatible — `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`); other Anthropic-API-compatible vendors work by changing that URL

## What's in v1.0.6

- **Windows one-click installer** — Inno Setup based, desktop/start-menu shortcuts, uninstaller, no dependencies
- **/setup wizard** — GUI form for API key + student profile; no editing `.env` or `USER.md` by hand
- **Single-port mode** — server serves both API and SPA on port 8787 (dev proxy on 5173)
- **API Key management** — set/change in Settings page; masked display shows current key
- **Back navigation** — back buttons on topic/settings/history pages return to the latest session
- **Sidebar auto-refresh** — session list updates automatically when a session ends
- **Voice input error feedback** — Chrome users see a hint to use Edge when Google Speech is unreachable
- **Debug logging** — `DEBUG_LOG_LLM` and `APP_LOG_LEVEL` env vars with Chinese comments in `.env`
- **Build system** — esbuild ESM→CJS bundle + pkg standalone exe + Inno Setup installer pipeline
- **Prompt loading** — all prompt files embedded at build time; no filesystem reads needed at runtime

### What was in v1.0.5

- Single-process architecture (CLI + server share the same DB, no port conflicts)
- Per-user data isolation in `%APPDATA%\EnglishOralTeacher\`
- USER.md auto-seed on first run — no manual setup needed beyond API key
- LLM client lazy re-init (live ↔ replay mode switching without restart)
- Unified LLM model field (`LLM_MODEL`) with placeholder showing default

## Project layout

```
src/
├── agent/         # state machine, turn loop, topic engine, tools, profile-extractor
├── llm/           # Anthropic-SDK client (pointed at MiniMax), replay, debug-log
├── memory/        # embeddings (transformers.js ONNX, MiniLM-L6-v2 q8) + vector search
├── storage/       # SQLite DAOs + migrations (sessions, messages, mistakes, topics, keyword_hits)
├── config/        # paths, env, secrets (AppData/.env for production)
├── prompts/       # prompt loader (loader.ts) — SOUL/AGENTS/USER/tools + assertHasH1
├── cli.ts         # CLI entry (REPL)
└── server.ts      # Hono API server (REST + SSE)
web/
├── src/
│   ├── components/  # MainPage, SessionPage, HistoryPage, SettingsPage, SetupPage, TopicLibraryPage, SessionSidebar, VoiceInput, HotkeyInput, shared/
│   ├── lib/         # api.ts, types.ts
│   └── i18n/        # strings.ts (zh-CN)
prompts/           # SOUL.md, AGENTS.md, USER.md, USER.md.example, phases.md, summarizer-system.md, tools.md, topic-library.md
data/              # runtime data (gitignored — sessions DB, embeddings, llm-debug/, preferences.json)
installer/         # pkg config, Inno Setup script (.iss), icons
scripts/           # patch-bundle.cjs (post-esbuild CJS patching)
tests/             # vitest (server) + Playwright (web e2e)
docs/              # ARCHITECTURE.md + USER_MANUAL.md + PRD.md + REQUIREMENTS.md + BUILD_INSTALLER.md + sprint/
```

## License

[MIT](LICENSE)
