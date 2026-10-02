# quick

Slash commands that answer on the spot, with no Claude turn of their own. All four can be
typed mid-turn: `/k` queues, `/yank` copies from the last completed reply, `/links` lists what
the transcript holds so far, and `/now` reports the running turn.

| Command | What it does |
|---|---|
| `/k [more]` | Sends "keep going" (or "keep going. more") as your own words. Mid-turn it queues for when the turn ends. |
| `/links` | Every URL in this session's messages and Bash/WebFetch output, newest first, grouped: PRs (`owner/repo#n`), other GitHub, claude.ai artifacts, the rest. A pane with Copy per row and Copy all. |
| `/yank [n]` | Copies the last code block of Claude's latest reply, or the nth from last. No code block: the whole reply. An interrupted reply's unclosed block is copied as a partial block. Copying out of the terminal picks up gutter characters; this doesn't. |
| `/now` | A toast: turn running and for how long, the running or last tool, running subagents, context %. |

Turn and tool state is tracked from the moment the mod loads. Right after a reload, `/now`
says it hasn't seen a turn until the prompt hint or a turn event tells it otherwise.
