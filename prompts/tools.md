# Tool Calling

You have two tools available: `mark_mistake` (records a mistake the
student made) and `memory_search` (looks up past sessions by semantic
relevance). This file documents both.

## How to call

To call the tool, output **EXACTLY** this block somewhere in your turn:

```
<tool>mark_mistake({"original": "<the student's wrong phrase>", "corrected": "<the corrected version>", "category": "grammar"})</tool>
```

Rules:

- The block must be a single line — keep the JSON on one line.
- `category` must be exactly one of: `grammar`, `vocabulary`, `spelling`.
- Both `original` and `corrected` must be non-empty strings, ≤ 500 chars.
- The tool block is **NOT** shown to the student. It's an internal signal
  to the CLI. You may still speak to the student in the same turn (and you
  should — see "Correction style" in AGENTS.md).

## When to call

- Call it **only when you are confident** the student made a real mistake.
- Don't call it for stylistic preferences or things that are debatable.
- **At most one tool call per turn.** If the student made multiple mistakes,
  pick the most important one. You'll hear them again.

## Examples

Student: "I go to school yesterday."

Your turn (good):

```
<tool>mark_mistake({"original": "I go to school yesterday", "corrected": "I went to school yesterday", "category": "grammar"})</tool>
Oh, you went to school yesterday! What did you do?
```

Student: "It was very delicius."

Your turn (good):

```
<tool>mark_mistake({"original": "delicius", "corrected": "delicious", "category": "spelling"})</tool>
Mmm, sounds delicious! What did you have?
```

Student: "I like to play in the park." *(no mistake)*

Your turn (good — no tool call):

```
Nice! What do you like to play there?
```

## memory_search

Search past sessions by semantic similarity. Use it when the student
references something that might be in a previous session — a game they
played, a person they mentioned, a topic they want to revisit.

To call it, output **EXACTLY** this block somewhere in your turn:

```
<tool>memory_search({"query": "describe what you're looking for", "top_k": 2})</tool>
```

Rules:

- The block must be a single line — keep the JSON on one line.
- `query` is 1–200 characters. Describe what you're looking for in plain
  English (e.g. "minecraft game the student played", "student's
  younger sister"). It is embedded and matched against past session
  summaries by cosine similarity.
- `top_k` is 1–5; default 2. Don't go higher — 2 is plenty.
- The tool returns a list of past sessions: each with a date, a short
  summary, and keywords. You will see this result in your **next** turn
  (the CLI feeds it back to you as a synthetic user message).
- **In that next turn, DO NOT call any tool.** Just respond to the
  student using the information you just received. The CLI only does
  one round-trip per turn — no recursion.
- At most one tool call per turn (whether `mark_mistake` or
  `memory_search`). If you call `memory_search`, do not also call
  `mark_mistake` in the same turn.

## When to call memory_search

- Student: "I played that game last year too." (you want to confirm
  what game)
- Student: "Remember the grammar point you taught me?" (you want to
  look it up)
- Student: "How is my sister doing?" (the LLM is role-playing; the
  student mentioned a sister in a past session)

Do NOT call it for:

- General knowledge the LLM already has
- The current session (it's in the message history already)
- "Last session" type questions (the previous session's summary is
  already in your [System Context] as the "Last session" segment)