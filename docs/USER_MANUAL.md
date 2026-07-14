# English Oral Teacher — User Manual

## 1. Installation

### Windows installer (recommended)

1. Download `EnglishOralTeacher-Setup-v1.1.0.exe` from [GitHub Releases](https://github.com/zhiyicom/english-oral-teacher-agent/releases)
2. Double-click → follow the wizard → shortcuts created automatically
3. Launch → browser opens → setup wizard appears

**No command line. No Node.js. No configuration files.** The installer bundles everything.

### Developer installation

```bash
git clone https://github.com/zhiyicom/english-oral-teacher-agent.git
cd english-oral-teacher-agent
pnpm install
pnpm --dir web install
cp .env.example .env   # edit API_KEY + provider settings
pnpm dev-web            # Hono (8787) + Vite (5173)
```

Open `http://localhost:5173`.

### Browser compatibility

| Browser | STT (voice input) | TTS (voice output) |
|---------|-------------------|---------------------|
| Edge ≥ 120 | Full support | Full support |
| Chrome ≥ 120 | Limited (China region issues) | Full support |
| Firefox ≥ 120 | Not supported | Full support |
| Safari ≥ 17 | Partial | Full support |

**Recommendation**: Microsoft Edge for reliable voice input in China.

## 2. First-Time Setup

On first launch, the setup wizard guides you through two steps:

### Step 1 — LLM Configuration

| Field | Description | Example |
|-------|-------------|---------|
| API Key | Your LLM provider's API key | `sk-...` |
| API Protocol | `Anthropic Compatible` (MiniMax, default) or `OpenAI Compatible` (DeepSeek, OpenAI) | — |
| Base URL | API endpoint | `https://api.deepseek.com/anthropic` |
| Model | Model name | `deepseek-v4-flash` |

**Default provider**: MiniMax (`https://api.minimaxi.com/anthropic`, model `MiniMax-M3`).

**To use DeepSeek**: switch protocol to "OpenAI Compatible", set Base URL to `https://api.deepseek.com/v1`, and model to e.g. `deepseek-chat`.

### Step 2 — Student Profile

- **Name**: How the AI teacher addresses you
- **Age**: For difficulty adjustment
- **Level**: Beginner / Intermediate / Advanced
- **Goals**: Learning objectives (comma-separated)
- **Interests**: Topics you enjoy (comma-separated), used for warm-up personalization

All settings can be changed later via the Settings page.

## 3. Interface

The UI has two panels:

- **Left sidebar**: session list (sorted by date, newest first), [New Session] button, navigation to Topics and Settings
- **Right main area**: current session chat, history viewer, or settings/topics editor

### Session list

- Each row shows: session number, date, duration, topic summary
- Hover → red × button appears → click to delete (no confirmation dialog)
- Click any row to view its full transcript (read-only)
- Current session is highlighted with a dark background

## 4. Conversation

### Starting a session

Click [New Session] → server creates a session → AI teacher greets you.

The session flows through four phases automatically:

| Phase | Time | Behavior |
|-------|------|----------|
| Warm Up | 0-5 min | Light chat, references last session's topic |
| Main Activity | 5-25 min | Topic discussion, error correction, vocabulary teaching |
| Wrap Up | 25-30 min | Summarizes progress, highlights 1-2 errors |
| End | 30+ min | Goodbye, writes summary + embedding to database |

### Sending messages

- Press **Enter** anywhere on the page to send
- **Shift+Enter** for newline in the input box
- Custom send hotkey configurable in Settings

### Voice input (STT)

Click the microphone button (🎤) → speak → click again to stop. The recognized text appears in the input box.

Error messages appear above the input bar (centered) and auto-dismiss after 2.5 seconds:

| Error | Message |
|-------|---------|
| No speech detected | "No speech detected" |
| Microphone denied | "Microphone permission needed" |
| Network unreachable | "Speech service unreachable, check network" |
| Browser disabled | "Browser disabled speech recognition" |

### Voice output (TTS)

Enable in Settings → AI teacher's replies are read aloud. Speed (0.5-2.0) and accent (en-US/en-GB) adjustable.

### Ending a session

- Click [End Session] in the top bar
- Or type "stop" / "bye" / "end"
- After 30 minutes the session auto-ends

## 5. Settings

Access via the bottom-left navigation. All changes take effect immediately — no restart needed.

### Voice

| Setting | Values | Default |
|---------|--------|---------|
| Voice on/off | toggle | Off |
| Speed | 0.5 – 2.0 | 1.0 |
| Accent | en-US / en-GB | en-US |
| Voice source | online / local | online |

### Display

| Setting | Values | Default |
|---------|--------|---------|
| Font size | 12-20 px | 14 px |
| Show debug info | toggle | Off |

### Hotkeys

| Hotkey | Action | Suggested |
|--------|--------|-----------|
| Microphone | Toggle voice input | Ctrl+Shift+M |
| Send | Send message | Ctrl+Enter |

### LLM

| Setting | Description |
|---------|-------------|
| API Key | Your LLM provider API key. Displayed masked (`sk-...xxxx`). |
| API Protocol | Anthropic-compatible or OpenAI-compatible wire format. |
| Base URL | API endpoint URL. |
| Model | Model name. |

### Topic auto-expand

| Setting | Values | Default |
|---------|--------|---------|
| Auto-expand topic library | toggle | Off |

When enabled, after each session the system checks whether the conversation covered new topics or keywords not in the library. If so, it either merges them into existing topics or creates new topic entries. Recommended for students who frequently discuss niche interests.

### Form behavior

- **Save**: writes to AppData and updates the running LLM client immediately
- **Cancel**: discards unsaved changes, reverts to last saved values
- Leaving the page with unsaved changes prompts a confirmation

## 6. Topic Library

Access via the bottom-left navigation. 34 default topics across three levels (A1-A2, B1, B2).

### Topic list

- Each topic shows its name, level, keywords, and discussion count `(N)`
- Each keyword chip shows its individual hit count `keyword (N)`
- Click [Edit] to enter edit mode → modify name, keywords, description → [Save]

### Selection algorithm

The system prioritizes:

1. **Hard exclusion**: topics discussed in the last 30 days are excluded
2. **Soft preference**: less-discussed topics are preferred
3. **Keyword freshness**: topics whose keywords haven't appeared recently get a slight boost
4. **Random noise**: small random factor prevents identical selections every time

The AI teacher is prompted to respect the selected topic and not re-select aggressively.

## 7. Session Memory

At the end of each session, the system automatically:

1. **Summarizes**: calls a dedicated summarizer LLM → 1-3 sentence summary + 3-8 keywords
2. **Embeds**: converts the summary to a 384-dim vector (MiniLM-L6-v2) → stores as BLOB
3. **Records topics**: writes adopted topics to `topic_stats` and `keyword_hits`
4. **Extracts profile**: updates student interests and warm-up seed in USER.md

When you start a new session, the system injects:
- **Last session review**: date, duration, keywords, summary text
- **Relevant past sessions**: top 2 via cosine similarity search (optional)

**Session boundaries are strict** — previous conversation text is never carried into a new session. Only summaries are shared across sessions.

### Mistake tracking

The AI teacher tags errors during conversation (grammar, vocabulary, word choice). All mistakes are stored and viewable in the session history.

## 8. Data Storage

All user data is stored in `%APPDATA%\EnglishOralTeacher\` (Windows):

| Path | Content |
|------|---------|
| `.env` | LLM configuration (API key, base URL, model, protocol) |
| `oral-teacher.db` | SQLite database (sessions, messages, mistakes, topics, stats) |
| `preferences.json` | UI preferences (font size, voice settings, hotkeys) |
| `USER.md` | Student profile |
| `llm-debug/` | Debug logs (when enabled) |

To **reset everything**: uninstall and choose "Delete conversation history, settings, and student profile" when prompted.

## 9. Troubleshooting

### "API key not configured"

The setup wizard hasn't been completed. Navigate to the app (it should redirect to `/setup` automatically).

### "Connection error" after configuring provider

- Check your API key is correct
- Check the Base URL — ensure it matches your provider's API endpoint
- Check network connectivity to the API endpoint (`curl https://api.example.com`)
- For Anthropic-compatible: URL should end with the base path (e.g. `/anthropic` not `/anthropic/v1/messages`)
- For OpenAI-compatible: URL should end with `/v1`

### Voice input doesn't work

- Chrome users in China: try Microsoft Edge instead
- Check microphone permissions in browser settings
- Try speaking within 5 seconds of clicking the mic button

### Switching providers

Change settings in the Settings page → Save. The LLM client is recreated immediately with the new configuration. No restart needed.

### Debug logging

Create a `.env` file in the installation directory (next to `EnglishOralTeacher.exe`):

```env
DEBUG_LOG_LLM=1
```

Restart the app. Per-turn LLM request logs will be written to `%APPDATA%\EnglishOralTeacher\llm-debug\`.
