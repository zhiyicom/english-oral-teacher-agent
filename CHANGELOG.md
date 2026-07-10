# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note**: Sprint-by-sprint release history (v0.2 → v1.0.4) lives in
> [docs/ARCHITECTURE.md §11](docs/ARCHITECTURE.md). This file tracks user-facing
> changes only.

## [v1.0.7] — 2026-07-10 — Topic stats fix + voice hint UX + installer icon

> Sprint details: [v1.0.7-scope.md](docs/sprint/v1.0.7-scope.md) /
> [v1.0.7-design.md](docs/sprint/v1.0.7-design.md) /
> [v1.0.7-test-report.md](docs/sprint/v1.0.7-test-report.md)

### Changed
- **Topic stats write-on-selection (F1–F4)**: replaced the END-of-session summary-keyword matching pipeline with a write-on-selection ledger (`adoptedTopics` Map + `recordAdoptedTopics()`). Topic usage is now recorded at the moment a topic is actually selected (Hook A: phase-driven auto-inject; Hook B: LLM `topic_select` success), not from noisy summary meta-words ("engagement challenges", "topic refusal", etc.). `sessions.topics_used` column activated (was dead since v0.6). `prompts/phases.md` strengthened with "Topic selection discipline" to reduce LLM re-selection spam.
- **Voice input error hints**: replaced the single misleading "Try Microsoft Edge" message with 7 specific W3C SpeechRecognition error-code hints (`audio-capture`, `not-allowed`, `service-not-allowed`, `network`, `no-speech`, `language-not-supported`, fallback for `unknown`).
- **Voice hint layout**: error messages now render above the input bar (centered) instead of inline inside `<VoiceInput>`, fixing textarea squeezing.

### Fixed
- **Installer crash on "Creating shortcuts"**: pkg-built EXE had no Windows icon resources. Inno Setup's `IconFilename: "{app}\EnglishOralTeacher.exe"` triggered ACCESS Violation in `virtdisk.dll` when trying to extract the icon. Fixed by shipping a standalone `app.ico` with the installer and referencing it directly.
- **Build script compatibility**: `build-installer.sh` now uses esbuild `--bundle` + `node scripts/patch-bundle.cjs` + pkg CLI arguments instead of the incompatible `pkg.config.json` format (deprecated by `@yao-pkg/pkg`).

### Added
- **Application icon** (`installer/icons/app.ico`): blue speech-bubble icon (256×256) bundled with installer and used for shortcuts, wizard, and uninstall display.
- **`src/agent/topic-recorder.ts`**: shared `recordAdoptedTopics()` function (ledger-first / `matchTopic` fallback) used by both server and CLI.
- **`topic-adopted` TurnEvent**: new SSE/CLI event emitted when a topic is adopted (source: `auto` or `llm`).
- **14 new unit tests**: 8 `topic-recorder.test.ts` + 6 `sessions.test.ts` (topics_used column write/read/COALESCE/idempotent startup patch).

## [v1.0.6] — 2026-07-06 — Windows installer + setup wizard + UX polish

> Sprint details: [v1.0.6-scope.md](docs/sprint/v1.0.6-scope.md)

### Added
- **Windows one-click installer**: Inno Setup based `.exe` with desktop/start-menu shortcuts, uninstaller, upgrade detection. Zero command line, zero Node.js required.
- **/setup wizard**: GUI two-step form (API Key + student profile) at first launch. No manual editing of `.env` or `USER.md`.
- **API Key management in Settings**: set/change LLM API key from the Settings page. Masked display (`sk-...xxxx`) shows current key status.
- **Voice input error feedback**: when Chrome SpeechRecognition fails (Google servers unreachable from China), the mic button shows a persistent hint to use Microsoft Edge instead.
- **Sidebar auto-refresh**: session list updates automatically when a session ends — no manual page refresh needed.
- **Back navigation to latest session**: back buttons on topic library, settings, and history pages navigate to the most recent session if one exists, instead of a blank welcome page.
- **Debug logging config in `.env`**: first-run `.env` includes Chinese-commented `DEBUG_LOG_LLM` and `APP_LOG_LEVEL` entries with usage instructions.
- **`GET /api/setup/status`** / **`POST /api/setup/api-key`** / **`POST /api/setup/profile`** / **`GET /api/setup/profile-default`** endpoints for the setup wizard.
- **`GET /api/update/check`** endpoint (reserved for future auto-update).

### Changed
- **Port changed from 3000 to 8787**: avoids conflicts with common dev servers.
- **Version number**: UI footer now displays `v1.0.6`.
- **Settings page UX**: Cancel button renamed to "返回" (Back); redundant top back button removed.
- **Voice default**: `voice_enabled` defaults to `true` for new installs.
- **LLM model config**: unified single `LLM_MODEL` field replaces `LLM_MODEL_MAIN` / `LLM_MODEL_SUMMARIZER`.

### Fixed
- **Summary generation in packaged builds**: `summarizer-system.md` was not included in the pkg VFS because `readFileSync` calls are not traced. Fixed by embedding all prompt files via `globalThis.EMBEDDED_PROMPTS` at build time.
- **Exe crash on startup**: missing `--bundle` flag in esbuild caused ESM modules to be loaded via CJS `require()`, failing with "module is not defined in ES module scope".
- **SPA serving in packaged builds**: SPA handler regexes in `patch-bundle.cjs` updated to match esbuild's variable renaming (`c` → `c2`).

### Build System
- **esbuild `--bundle`** ESM → CJS with external native modules (`better-sqlite3`, `onnxruntime-node`)
- **`scripts/patch-bundle.cjs`**: post-processes the CJS bundle — inlines prompt files, SQL migrations, and web assets; replaces SPA handlers to serve from memory
- **`@yao-pkg/pkg`** with `node24-win-x64` target produces standalone 127MB `.exe`
- **Inno Setup 6** produces 29MB installer

## [v1.0.5] — 2026-06-30 — Topic-selection tool widening + 30-topic default library

> Sprint details: [v1.0.5-scope.md](docs/sprint/v1.0.5-scope.md) /
> [v1.0.5-design.md](docs/sprint/v1.0.5-design.md) /
> [v1.0.5-test-report.md](docs/sprint/v1.0.5-test-report.md)
>
> **Scope note**: 原 v1.0.5 scope 定义的"安装器架构前置 4 段（§1.1 单进程 + §1.2 AppData + §1.3 USER.md 种子 + §1.4 /setup 向导）"推迟到 v1.0.5.1+ 实施（v1.0.6 启动前必须完成）。完整设计稿保留在 [v1.0.5-design.md](docs/sprint/v1.0.5-design.md) 作为 v1.0.5.1+ 蓝图。当前 v1.0.5 实际完成的是 §A 提示词禁令 + §B tool 返回拓宽 + §C 默认 30 话题库 seed。

### Changed
- **`topic_select` tool returns `keywords[]` + description-based title** (§B): the LLM now gets the full keyword list (e.g. `["morning","afternoon","breakfast","lunch","dinner","school","homework","habit",...]` for `daily_routine`) and the human-readable `title` from the topic's `description` field (e.g. "日常生活习惯") instead of the raw slug. Gives the LLM concrete vocabulary to anchor the opening question so it no longer falls back to mining `# STUDENT` interests for topic material. Backwards compatible — no DB migration, no new endpoints, no schema break.
- **Anti-# STUDENT rule in MAIN_ACTIVITY prompt** (§A): `prompts/phases.md` MAIN_ACTIVITY Context now explicitly states "Do NOT use `# STUDENT` interests as a topic source" and the per-turn Reminder now appends "(NEVER pick from `# STUDENT` interests directly)". The profile is for personalizing the LLM's tone, not for picking conversation topics — variety is the point.

### Added
- **30-topic default library ships in repo + auto-seeds on new install** (§C): any fresh `git clone` + `pnpm install` + `pnpm serve` now starts with 30 baseline topics (A1-A2 / B1 / B2 mix, covering personal_info through tech_future) instead of the v0.6 7-starter pack (minecraft / school / sports / food / family / movies / music). Two new files: `data/topics-default.json` (human-readable form, project asset) and `src/storage/migrations/007_topics_default.sql` (30 `INSERT OR IGNORE` rows that run on `applyMigrations()`). Both files are physically co-generated from the same in-memory array by `scripts/export-topics-default.ts` — no hand-edit drift possible. Existing users keep their existing topic edits (`OR IGNORE` skips conflicts, never overwrites). Migration 003 was modified to remove the 7 v0.6 starter seeds (they were superseded by the 30 baseline) — `schema_migrations` tracks by filename so old DBs that already applied 003 keep their 7 v0.6 topics untouched.

### Notes
- This release is internal-only: student-visible behavior changes are (1) "Alex picks a wider variety of topics instead of repeatedly mining the same interests" (§A+§B), and (2) "Alex can choose from 30 conversation topics instead of 7 from day one on any new install" (§C). No new LLM calls. §C adds 2 migration files and 2 supporting scripts/tests — zero new API endpoints, zero new npm deps.
- Root cause for §A+§B: 2026-06-28 session `dc50b481` showed the LLM bypassing `topic_select` for 4 consecutive turns and inventing "travel anywhere in the world" questions from the student's interest list. After this change, the LLM has concrete material inside the tool's return shape (`keywords[]` + descriptive `title`) and an explicit prompt rule against the bypass.
- Root cause for §C: 2026-06-28 the user deployed from GitHub on a second machine and found only 7 topics in DB (vs 30 locally). The extra 23 topics were runtime Web UI additions in the local DB — host-local, never in the repo. Now those 30 baseline topics ship as project assets and any new host gets them on first migration.

## [v1.0.4] — 2026-06-28 — LLM prompt assembly cleanup (no behavior change)

> Sprint details: [v1.0.4-scope.md](docs/sprint/v1.0.4-scope.md) /
> [v1.0.4-design.md](docs/sprint/v1.0.4-design.md) /
> [v1.0.4-test-report.md](docs/sprint/v1.0.4-test-report.md)

### Changed
- **System prompt H1 dedup** (§1.1): the prompt sent to the LLM no longer contains duplicate headings. `buildSystemString()` no longer prepends `# SOUL` / `# AGENTS` / `# STUDENT` / `# TOOLS` — each section's H1 now comes from the source file itself (`prompts/SOUL.md`, `prompts/AGENTS.md`, `prompts/USER.md`, `prompts/tools.md`). Each H1 appears exactly once in the rendered system prompt. Visible bytes saved: ~48 B per turn x every turn.
- **Last session summary single-source** (§1.2): Block 1's last-review line is now a one-line pointer (date, duration, 6 keywords, and `(full summary in opening user message)`) instead of repeating the full summary. The full summary text still appears in the WARM_UP first-turn synthetic user message (`Messages[0]`), which remains the LLM's sole reading point. Visible bytes saved: ~250-400 B on the WARM_UP turn 1 only.
- **Keyword list count alignment** (§1.2): the keyword list shown to the LLM in both Block 1 and `Messages[0]` now shows 6 keywords (was 4 in `Messages[0]`, 6 in Block 1). Both segments now carry the same 6 keywords in the same order.
- **Runtime guard on prompt source files**: `assertHasH1()` is called on every `loadSystemPrompt()`. If any of `SOUL.md` / `AGENTS.md` / `USER.md` / `tools.md` loses its `# <Title>` first line, startup throws a clear error pointing at the offending file. Prevents silently malformed prompts when someone hand-edits a source file.
- **Sidebar active-session highlight is now visually obvious** (§1.5): the row corresponding to the session you're looking at on the right is highlighted with a strong gray background (`bg-slate-300 text-slate-900 font-medium`) instead of the previous subtle `bg-blue-50` which was too low-contrast to read at a glance. The bottom nav (Topics / Settings) keeps its blue-50 highlight so a session row (gray) and a nav button (blue) are immediately distinguishable: "session data view" vs "page nav".
- **History detail page now also highlights the matching session row** (§1.5, bug fix): previously `activeId` only matched `/session/:id`, so while you were reading the transcript of a past session on `/history/:id` the sidebar showed no highlight even though the corresponding row was visible. `activeId` now matches both prefixes.

### Notes
- This release is internal-only on the prompt-assembly side (§1.1 / §1.2): the student's first-turn greeting, the LLM's tool-calling behavior, and the visible session transcript are all unchanged — verified by replay-fixture diffs and unit tests asserting no message-shape regression.
- The §1.5 sidebar highlight is a visible UX change: when you're on `/session/:id` or `/history/:id`, the matching row in the left list is now clearly highlighted.
- Total per-session prompt savings on a 64-turn session: ~3 KB (H1 dedup, all turns) + ~400 B (Last session pointer, WARM_UP turn 1). Tool-examples dedup (~400 KB/session) is deliberately out of scope; requires cache-strategy + A/B validation.

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
