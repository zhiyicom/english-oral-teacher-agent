# Tool Calling

You have one tool available: `mark_mistake`. It records a mistake the
student made (grammar / vocabulary / spelling) to a database so future
sessions can refer back to it.

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
