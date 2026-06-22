# English Oral Teacher Agent

A local AI agent for English oral practice. Runs entirely on your PC, with a dedicated UI, memory system, timed lesson phases, and voice I/O.

> **Status: v1.0.1** — voice I/O (STT/TTS), multi-session memory with vector search, editable topic library, Web UI with sidebar, phase-graded explicit correction, no-emoji rule.
>
> See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design and [CHANGELOG.md](CHANGELOG.md) for release history.

## Goals

- Standalone agent (not built on top of an existing framework)
- Local PC execution with its own AI interface
- Long-term memory across sessions (summaries + 384-dim embeddings in SQLite BLOB)
- Timed state machine (warm-up → main → wrap-up → end)
- Voice I/O via browser Web Speech APIs
- Automatic prompt injection (system context, phase, student profile)

## Quick start

```bash
pnpm install
pnpm --dir web install
cp .env.example .env       # fill in ANTHROPIC_API_KEY or OPENAI_API_KEY
pnpm dev-web                # server (3000) + Vite dev (5173) concurrently
```

Open `http://localhost:5173`.

## Project layout

```
src/
├── agent/         # state machine, turn loop, topic matcher, tools
├── llm/           # Anthropic / OpenAI / Replay clients
├── memory/        # embeddings + vector search (transformers.js ONNX)
├── voice/         # STT / TTS orchestration
├── storage/       # SQLite DAOs + migrations
├── prompts/       # prompt loader (loader.ts)
└── server.ts      # Hono API server
web/
├── src/
│   ├── components/  # SessionPage, HistoryPage, SettingsPage, TopicLibraryPage, …
│   ├── lib/         # api.ts, types.ts
│   └── i18n/        # strings.ts (zh-CN)
prompts/           # SOUL.md, AGENTS.md, phases.md, USER.md, tools.md, …
data/              # runtime data (gitignored — sessions DB, embeddings, llm-debug/)
tests/             # vitest (server) + Playwright (web e2e)
docs/              # ARCHITECTURE.md + sprint/{v*,scope,design,test-report}/
```

## License

[MIT](LICENSE)
