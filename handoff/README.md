# handoff

When Claude hands you shell commands to run yourself (a merge auto mode won't do, a login, a
delete), they go on a checklist per repo instead of scrolling away.

- **Asked for explicitly.** The first prompt of each conversation (and after `/clear` or a
  compaction) carries one line asking Claude to put such commands in a ```` ```handoff ```` block,
  one per task, with a leading `# comment` as its label. Only those blocks are captured, never a
  plain `bash` block. A user mod can't add to the system prompt (sec-default bypasses
  `prompt.compose` and `prompt.section`), so the line rides that prompt and stays in history.
- **One item per block**, kept whole: Copy gives you the block verbatim, heredocs and loops
  included. No `# comment` first: the label is the block's first line.
- **Ran** when you paste terminal output that shows the block's first command after a shell
  prompt (`❯ `, `$ `, `% `, `host:/x# `). A command merely mentioned in a prompt doesn't count.
  Running it with `!` in the prompt is not detected: no mod event is documented for bash-mode input.
- **Confirmed** when Claude writes `[done #id]` in its prose (not inside code). While anything
  is pending, each of your prompts carries the 5 newest pending items under 48 hours old, as
  `#id label`, and asks for that tag. Nothing pending, nothing added.
- **Band:** `handoff  ☐ 3 to run  ✓ 1 ran` with an Open button, hidden when nothing is pending.
  If the store can't be read or written, the band and pane say `handoff: store unavailable`.

| Command | What it does |
|---|---|
| `/handoff` | Pane: To run, Ran, Done, and a collapsed Dismissed. Copy, ✓ and ✕ per item; Copy all to run (`c`), Clear done (`x`, also clears dismissed); `1`-`9` tick an item. |
| `/handoff add <cmd>` | Adds an item by hand. |
| `/handoff all` | The pane across every repo. No Copy all: one shell can't run several repos' commands. |

Re-handing a block reopens it unless you dismissed it. Lists live in the plugin's store, keyed by
the session's project root, so they survive `/clear` and new sessions. Done and dismissed items
are dropped after 7 days.
