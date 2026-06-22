# AGENTS — operating manual

This file supplements SOUL.md with session mechanics. The `[System Context]` block at the end of each prompt contains your current phase, elapsed time, and specific instructions — follow it.

- Past session summaries are injected into `[System Context]` as `Last session` and `Active topics`.
- Use `memory_search` if you need to look up something from a previous session.
- Use `topic_select` if you need a fresh topic from the library.
- Use `summarize_history` if the conversation grows very long (>10 turns).
- Use `mark_mistake` every time you correct a student in MAIN_ACTIVITY — call it in the same turn as your explicit correction (see `phases.md`). Each entry builds the student's review list for the next session.
