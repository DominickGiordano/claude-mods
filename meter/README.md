# meter

Above the prompt, one bar per limit:

```
memory ████████░░ 78%  ⚠ clear soon  [Compact]
plan   ███░░░░░░░ 31%  resets 2h 10m
week   ██░░░░░░░░ 22%
```

| Row | What it means | When to act |
|---|---|---|
| `memory` | How full this conversation's context window is. | 60%: clear (`/clear`) when you next switch tasks. 80%: clear or press **Compact** soon. |
| `plan` | Your plan's 5-hour usage limit. `resets` says when it refills. | 90%: `⚠ near limit`, slow down or wait for the reset. |
| `week` | Your plan's 7-day usage limit. Shows the reset day from 50%. | Near 100%, save heavy work for after the reset. |
| cache hits | Not in the band. `/tokens` shows this session's cache hit rate. | Nothing to do. Higher is better. |

- Bars go yellow at 50% and red at 80%. They are 10 cells wide, fewer on a narrow terminal.
- While memory is under 60% and plan and week under 50%, the band is one dim line:
  `memory 41% · plan 31% · week 22%`. It opens to three rows when any crosses its threshold.
- A figure Claude Code didn't report has no row, never `0%`. With an API key there are no plan
  limits, so only `memory` shows. A limit whose reset time has passed shows `reset?` until the
  next reading.
- **Compact** runs the same compaction as `/compact`. Mid-turn the button hides.
- The spinner gains `· 4.2k tokens`: uncached input plus output tokens this turn.

"tok" in `/tokens` means everything a request read or wrote: input, output and cache.

Figures are read once at start, then pushed by Claude Code's `session.measure` after each turn.
meter never shows a dollar figure.

## /tokens

Opens a pane: tokens per day for the last 14 days, then the top repos, branches and models by
tokens for 1, 7 or 30 days. The header shows this session's cache hits, the share of input
tokens read from cache (higher is better).

Every finished turn that reports usage, subagents' included, books its tokens into `$.store`
under `meter:YYYY-MM-DD`, by repo (the main checkout's folder name), git branch and model. Days
recorded by 0.1.0 still load; the cost they carry is ignored.

Days older than 30 are deleted. The store is shared by every session on the machine and has no
locking, so two sessions finishing a turn in the same instant can drop one of the two. A failed
write shows at the top of the pane.
