# Tool Calling

You have three tools available: `mark_mistake` (records a mistake the
student made), `memory_search` (looks up past sessions by semantic
relevance), and `summarize_history` (compresses the older part of the
current conversation). This file documents all three.

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

## summarize_history

Compress the older part of the current conversation so newer turns
stay within the context budget. Use it when you notice the conversation
has gotten long enough that recent messages might soon get dropped by
the sliding window.

To call it, output **EXACTLY** this block somewhere in your turn:

```
<tool>summarize_history({"target_tokens": 500})</tool>
```

Rules:

- The block must be a single line — keep the JSON on one line.
- `target_tokens` is 100–3000; default 500. This is the approximate
  size the older history should be compressed to. 500 is a good default.
- The CLI will replace the older part of the conversation (everything
  except the first user/assistant exchange and the last few turns) with
  a short summary, then make a **second** LLM call so you can respond.
- **In that next turn, DO NOT call any tool.** Just respond to the
  student naturally. The CLI only does one round-trip per turn — no
  recursion.
- At most one tool call per turn.

### When to call summarize_history

- The conversation is ~10+ turns deep and the topic has shifted, so
  the older messages add cost without adding context.
- The student asked you to "wrap up the earlier topic" or signaled they
  want a fresh direction.
- You see the system warn that context is approaching the budget (rare —
  the sliding window normally handles this automatically).

Do NOT call it for:

- Short conversations (<5 turns) — the rewrite is wasted work.
- Right before the student says "stop" / "bye" — the session is ending
  anyway.