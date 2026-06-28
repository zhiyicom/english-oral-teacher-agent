# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note**: Sprint-by-sprint release history (v0.2 → v1.0.3) lives in
> [docs/ARCHITECTURE.md §11](docs/ARCHITECTURE.md). This file tracks user-facing
> changes only.

## [v1.0.3] — 2026-06-28 — UI polish + phase-based topic strategy

> Sprint details: [v1.0.3-scope.md](docs/sprint/v1.0.3-scope.md) /
> [v1.0.3-design.md](docs/sprint/v1.0.3-design.md)

### Added
- **WARM_UP opener hook** (§1.3): the LLM-curated `next_warm_up_seed` keyword from the previous session's profile-extract is cached in module-scoped state on the server (and in the CLI's process memory). The next `POST /api/sessions` returns it as `warmUpHook` and the Web/CLI threads it into the first-turn `WARM_UP` hint as a focused opener line: `Your opener topic for today: "<seed>". Make the first question naturally about this…`. Falls back gracefully to the existing "natural connection" text on first-ever session / server restart / LLM failure. Zero new LLM calls — reuses the existing session-end profile-extract.
- **Phase-based topic strategy** (§1.3): D3 (interest boost) is now permanently disabled in `topic_select` tool. Interest matching is handled by the WARM_UP phase prompt, not by the selection algorithm. The `topic_select` tool description no longer advertises interest boost. `selectTopic()` accepts a new `useInterestBoost?: boolean` flag (default `false`) for callers that need the legacy D3 behavior (e.g. unit tests).
- **Sidebar session delete** (no confirm dialog) (§1.1): the delete `×` button now removes the session immediately — no second click required. Removes the destructive confirm UX (matches desktop email-app conventions).
- **SettingsPage Cancel button** (§1.2): the Settings page Save button now shows a Cancel that discards in-flight form changes. The Cancel button resets form state to the last saved values.
- **`POST /api/sessions` returns `warmUpHook`** (§1.3): the response shape now includes `{id, warmUpHook}`. `warmUpHook` is `null` on first-ever session; read-once semantics (subsequent POSTs after a session-end return the latest seed and clear the cache).
- **`GET /api/sessions/:id/stream?warmUpHook=...`** (§1.3): the SSE stream URL accepts an optional `warmUpHook` query param for the first turn only. The server threads it into `TurnInput.warmUpHook` for the WARM_UP hint.
- **CLI parity** (§1.3): the CLI now also calls `extractStudentDiscoveries` at session-end (was missing in v1.0.2 server-only) and threads the seed into the next session-startup's first turn.

### Changed
- **CLI startup topic_select wiring** (§1.3): `useInterestBoost: false` is now passed at startup so the algorithm matches the new server behavior.
- **`topic_select` tool description** (§1.3): explicitly notes that interest matching happens via the WARM_UP phase prompt and that this tool does NOT consult `user.interests`. Removes ambiguity that previously led the LLM to waste turns trying to influence selection via interests.
- **`TurnInput.warmUpHook` made optional**: tests that don't care about WARM_UP behaviour no longer need to pass it.

## [v1.0.2] — 2026-06-28 — Topic hit stats + Bug fixes

> Sprint details: [v1.0.2-scope.md](docs/sprint/v1.0.2-scope.md) /
> [v1.0.2-design.md](docs/sprint/v1.0.2-design.md)

### Fixed
- **Bug A (frequent topic switching)**: MIN_TOPIC_AGE=5 gate on `topic_select` tool. New `src/agent/topic-counter.ts` enforces ≥5 user turns on current topic before allowing another switch. Explicit user requests like "switch topic" / "换个话题" bypass via regex. Resolves the 11-switches-in-27-min symptom in session `ddb32b4f` (2026-06-27).
- **Bug B (SSE 2nd-call drop)**: removed `if (!streamingRef.current)` compat shim in `SessionPage` student-text handler. The shim was a v0.8 holdover that silently dropped 2nd-call LLM responses whenever the 1st call had streamed anything — including pure `<tool>...</tool>` calls that strip down to empty. Now `student-text` always replaces `streamingRef`. Resolves the 11-of-33 affected turns in session `ddb32b4f`.

### Added
- **Turn-level diagnostic logging** (opt-in): `src/llm/debug-log.ts` `logTurnDiagnostic()` writes JSONL per-turn snapshots to `data/llm-debug/<sessionId>_diag.jsonl` at 4 key events (1st-call done, 2nd-call done, topic-select blocked, turn done). `POST /api/diagnostic/log` accepts web-side SSE event traces when `localStorage('debug:web_diag=1')`. Purpose: shorten root-cause time for future "no reply / wrong reply" symptoms.
- **`TOPIC_AGE_MIN` env var**: 0 disables the topic-age gate (used by regression tests); default 5.
- **Per-keyword hit stats** (`keyword_hits` table): new SQLite table `keyword_hits(topic, keyword, hit_count, first_hit_at, last_hit_at)` PK `(topic, keyword)` records per-session per-keyword discussion frequency. `KeywordHitsDao.upsertMany()` is wired into the session-end pipeline in both CLI and server. `selectTopic()` adds a keyword-freshness bias (`score = -count*0.1 - avgKeywordHit*0.05 + interest*0.5 + noise`, `W_KEYWORD=0.05`) so topics whose inner keywords are still fresh get picked more often. `topic_select` tool now returns `suggested_keyword` (lowest-hit keyword, alphabetical tiebreak) so the LLM has a soft hint on the under-used opening angle.
- **`GET /api/topics` extended**: response now includes `hitCount` (total discussion_count from `topic_stats`) and `keywordHits` (per-keyword hit_count map) per topic. `PUT /api/topics` accepts only the legacy 3 fields (name/keywords/description) and silently drops the read-only stats fields to prevent the editor from clobbering the live counters.
- **Web UI: topic stats display**: the `/topics` page now shows `(N)` next to the topic slug in gray small text (the total discussion count), and each keyword chip displays `keyword (N)` so the user can see at a glance which keywords have been used heavily.

## [v1.0.1] — 2026-06-22 — Feature polish

### Added
- No-emoji rule (SOUL Iron rule #7) + client-side emoji strip in `SessionPage` (safety net for LLM that ignore the rule)
- Explicit error correction in `MAIN_ACTIVITY` phase: rephrase + brief "Better: …" line + auto `mark_mistake` tool call
- `WRAP_UP` highlights 1–2 errors or non-idiomatic phrases the student used, with correct form
- `topic_select` tool auto-called on `MAIN_ACTIVITY` entry (replaces ignored text instructions — Round 3 of phase push)
- WARM_UP opens with **connected** message referencing last session (not avoided)
- Sidebar session deletion (hover × → confirm → DB cascade)
- Dynamic lastReview lookup at first turn of each session (not startup-time cache)
- Web session-end pipeline: summarize → markEnded → embedding → profile extraction → USER.md update
- Topic library Web editor (`/topics` route, GET/PUT `/api/topics`)
- SettingsPage wiring: voice toggle / speed / accent / font size / show debug; persists to `USER.md` (voice) + `data/preferences.json` (UI)
- Global Enter to send (works without focusing textarea)
- `<tool>…</tool>` strip from display + TTS
- `phases.md` externalized (Context + Reminder per phase, hot-reload on server restart)
- `data/preferences.json` server-side fallback for localStorage (browser-restart safe)

### Changed
- **B4**: Removed `# TOPIC_LIBRARY` block from system prompt (~4k tokens). `topic_select` tool handles topic selection; `prompts/topic-library.md` retained as human reference and regenerated by Web UI editor.
- DEBUG_LOG_LLM now writes per-turn and per-summarize logs
- RUN_LIVE_LLM priority fixed (1 = always live, fixtures dir = replay default, no env = replay)
- 30-min hard kill replaced with LLM-driven goodbye turn
- END phase ends immediately if user sends anything after the goodbye (no infinite farewell loop)
- catch-up WRAP_UP turn if silence ≥ 10 min skipped the phase

### Fixed
- Hotkey persistence (lazy init + onChange instant write + server-side fallback)
- lastReview filter `length(summary) > 30` skips `(summarization failed)` placeholders
- Profile-extractor merges new interests (dedup) + appends to body via `updateUserSettings()`

## [v0.9] — 2026-06-13 — Voice I/O (F6)

### Added
- STT via browser `SpeechRecognition` API (Chrome / Edge)
- TTS via browser `SpeechSynthesis` API
- Voice hotkey (customizable in Settings)
- Voice settings persist to `USER.md` (`voice_enabled`, `voice_speed`, `voice_accent`)

## [v0.8.4] — 2026-06-12 — HistoryPage + SettingsPage wiring

### Added
- `GET /api/sessions/:id` returns `messages[]` for full transcript
- `GET / PUT /api/settings` endpoints + `updateUserSettings()` (proper-lockfile atomic write)
- HistoryPage: metadata card + read-only message bubbles
- SettingsPage: 5 controls + localStorage + Save button
- E2E #3 (settings.spec.ts)

## [v0.8.2] — 2026-06-10 — Web UI foundation

### Added
- Vite + React 18 + Hono SPA skeleton
- MainPage (session list), SessionPage (active chat), HistoryPage, SettingsPage placeholders
- SSE turn loop, text-chunk streaming, message bubbles

## [v0.2]–[v0.7.7] — Core agent + memory

CLI mode, state machine, tools (`mark_mistake`, `memory_search`, `summarize_history`, `topic_select`),
SQLite + migrations, sentence-window truncation, 80% context-budget warn, Anthropic `cache_control`.

See [docs/ARCHITECTURE.md §11](docs/ARCHITECTURE.md) for sprint-by-sprint deltas.

## [Unreleased]

### Added
- Initial project scaffold (directory layout, git config, build tooling)
