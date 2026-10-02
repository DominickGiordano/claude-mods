# claude-mods

[Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview) are JS/TS plugins
that run inside Claude Code. These need Claude Code 2.1.287 or later.

| Mod | What it does |
|---|---|
| `pr-watch` | Band row per PR Claude opened: CI, conflicts, merged. Merge buttons, and a nudge when one merges. |
| `meter` | Memory, 5-hour and weekly limits as bars above the prompt. `/tokens` charts token usage by day, repo, branch and model. |
| `fleet` | `/fleet` lists every live session on this machine; `/send` messages one. |
| `quick` | Commands that run with no Claude turn: `/k`, `/also`, `/links`, `/copy`, `/status`. |
| `auth-guard` | Spots an expired CLI login in tool output; a Login button signs in and retries. |

## Install

```bash
claude plugin marketplace add DominickGiordano/claude-mods
claude plugin install meter@claude-mods
```

Run `/reload-plugins` in an open session. None of these register tools for Claude, so they add
nothing to context. A mod runs with your permissions: read one before installing it, or run
`claude plugin validate <dir>` to list its hooks and calls.

## Develop

```bash
claude --plugin-dir ./meter     # load from source
claude plugin test meter        # offline tests
claude plugin validate meter    # hooks: and calls: lines
tsc -p .                        # typecheck against types/claude-code.d.ts
```

Refresh `types/claude-code.d.ts` after a Claude Code upgrade: load any mod with `--plugin-dir`
and copy `<mod>/.claude-plugin/types/claude-code/index.d.ts` over it.
