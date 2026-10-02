# handoff

When Claude hands you shell commands to run yourself (a merge auto mode won't do, a login, a
delete), they go on a checklist per repo instead of scrolling away.

- **Captured** from Claude's reply: a `bash`/`sh`/`shell`/`zsh`/`console` block with a cue
  nearby ("run", "paste", "with `!`", "yourself", "you'll need to", "for you"). One item per
  command; `\`, `&&` and `|` continuations are joined, and a `# comment` above one is its label.
- **Ran** when you run it with `!` in the prompt, or paste output that echoes the command.
- **Confirmed** when Claude writes `[done #id]`. While anything is unconfirmed, each prompt
  carries a short note listing the items and asking for that tag. Nothing pending, no note.
- **Band:** `handoff  ☐ 3 to run  ✓ 1 ran` with an Open button, hidden when nothing is pending.

| Command | What it does |
|---|---|
| `/handoff` | Pane: To run, Ran, Done. Copy, ✓ and ✕ per item; Copy all to run (`c`), Clear done (`x`); `1`-`9` tick an item. |
| `/handoff add <cmd>` | Adds an item by hand. |
| `/handoff all` | The pane across every repo. |

Lists live in the plugin's store, keyed by the session's project root, so they survive `/clear`
and new sessions. Done and dismissed items are dropped after 7 days.
