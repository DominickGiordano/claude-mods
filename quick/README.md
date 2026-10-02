# quick

Slash commands that answer on the spot, with no Claude turn of their own. All four run
mid-turn too.

| Command | What it does |
|---|---|
| `/k [more]` | Sends "keep going" (or "keep going. more") as your own words. Mid-turn it queues for when the turn ends. |
| `/links` | Every URL in this session, newest first, grouped: PRs (`owner/repo#n`), other GitHub, claude.ai artifacts, the rest. A pane with Copy per row and Copy all. |
| `/yank [n]` | Copies the last code block of Claude's latest reply, or the nth from last. No code block: the whole reply. Copying out of the terminal picks up gutter characters; this doesn't. |
| `/now` | A toast: turn running and for how long, the running or last tool, running subagents, context %. |

Turn and tool state is tracked from the moment the mod loads, so `/now` right after a
reload says it hasn't seen a turn yet.
