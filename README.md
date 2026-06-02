# English Oral Teacher Agent

A local AI agent for English oral practice. Runs entirely on your PC, with a dedicated UI, memory system, timed lesson phases, and voice I/O.

> **Status: pre-development scaffold.** No code yet — only the project skeleton.

## Goals

- Standalone agent (not built on top of an existing framework)
- Local PC execution with its own AI interface
- Long-term memory across sessions
- Timed state machine (warm-up → main → wrap-up → end)
- Fast semantic + structured retrieval
- Automatic prompt injection (system context, phase, student profile)

## Quick start (planned)

```bash
pnpm install
cp .env.example .env       # then fill in your API key
pnpm dev
```

## Project layout

```
src/
├── agent/      # core agent: state machine, prompt injection, memory
├── llm/        # LLM client abstractions
├── voice/      # STT / TTS
├── storage/    # SQLite, file IO
└── ui/         # frontend
prompts/        # prompt sources (markdown, versioned)
data/           # runtime data (gitignored — student sessions, vectors)
tests/          # unit / integration tests
docs/           # design notes
```

## License

[MIT](LICENSE)
