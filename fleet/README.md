# fleet

Every live interactive Claude Code session sharing this Claude config dir, in one pane.

- `/fleet` lists sessions grouped waiting, working, idle: repo, branch, context %, time in state,
  last prompt. `*` marks this session. Two sessions in the same checkout turn red.
- The band shows sessions waiting on you (a permission prompt or a question), at most two then `+N`.
  Nothing shows when none wait.
- `/send <name or id prefix> <text>` messages another session. An exact `repo:branch` wins over a
  prefix; an ambiguous match sends nothing. The pane's Send button does the same.

## How it works

Each session writes its own `$.store` key every 15 s and on every state change; readers drop
entries older than 60 s, show ones silent past 30 s as "last seen", and delete ones older than
10 minutes. A session that exits removes its key. Headless runs (`-p`, the SDK) write nothing but
can still `/send`. If the store cannot be read, the pane says so and keeps the last rows as stale.

`/send` uses `$.session.send`: the message is queued at the other session as a cross-session
message from the `fleet` plugin, and the model there reads it (mid-turn, inside the running turn).
"Sent" means queued, not read.

"Waiting" starts when a tool call needs permission or `AskUserQuestion` opens, and ends when the
call settles or the tool's run-in-background hint appears. In auto mode a classifier verdict can
show as a brief wait.
