# claude-mods

Public repo of Claude Code mods. Read `README.md` for layout and commands. The API is
`types/claude-code.d.ts` (written by 2.1.287); it beats the web docs where they disagree.

Branch flow: feature branch off `develop`, PR into `develop`. Never target `main`.

## Rules every mod follows

- **TypeScript**, `hooks/register.ts` (`.tsx` when it draws with JSX), tests in `tests/*.test.ts(x)` with `claude-code/testing`.
  Stub every `$` call a test triggers with `on('<event>', ...)`; unanswered calls throw.
- **Static analysis:** literal event names, full `$.ns.method()` calls, never alias or
  destructure `$`. Helpers that take `$` are top-level functions in the same file.
- **The band is shared.** An `AbovePrompt` hook calls `await next(e)` and renders its own row
  above whatever that returns, so every mod's row shows. Return `next(e)` untouched when the
  mod has nothing to say. Never hide another mod's row.
- **No tokens.** Don't register tools for Claude. A command returns `{}` and shows output with
  `$.ui` (toast, notice, pane), because a `{ text }` reply is read by Claude.
- **Public.** No company repo names, hosts, or secret paths in code. Anything like that is a
  `userConfig` option in `plugin.json`.
- **Display mods fail open, actions don't.** A hook that throws is skipped. Anything that runs
  a command or sends a prompt does it only from a button the user pressed or an explicit
  option, and says what it did.
- **Show stale data as stale.** If a poll fails, the row says so (`#12 ? gh failed 2m ago`)
  instead of keeping the last good value looking fresh.
