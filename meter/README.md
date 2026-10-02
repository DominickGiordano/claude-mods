# meter

One row above the prompt:

```
ctx ▇▇▇▁▁ 61% 122k/200k · 5h 55% ↻1h12m · 7d 26% · $3.41 · cache 92% · ▁▂▅▃▇ tok/req
```

- Context, 5h and 7d figures go yellow at 50% and red at 80%. At 80% context an idle band shows
  a **Compact** button (the same compaction `/compact` runs); mid-turn it says `ctx high`.
- A limit window whose reset time has passed shows `5h reset?` until the next reading.
  No context reading shows `ctx –`, never `0%`.
- Cache is cache reads over all input tokens, summed over every model request this session,
  subagents included. The sparkline is tokens per request, last 16.
- Under 100 columns the row drops to `ctx 61% · 5h 55% · $3.41`, plus 7d once it reaches 80%.
- The spinner gains `· 4.2k in+out`: uncached input plus output tokens this turn.

"tok" everywhere else means everything a request read or wrote: input, output and cache.

Figures are read once at start, then pushed by Claude Code's `session.measure` after each turn.

## /spend

Opens a pane: cost per day for the last 14 days, then the top repos, branches and models for
1, 7 or 30 days, and this session's cache-hit rate.

Every finished turn, subagents' included, books its tokens and the cost measured since the last
booking into `$.store` under `meter:YYYY-MM-DD`, by repo (the main checkout's folder name), git
branch and model. Totals are exact. The split is marked `≈`, because cost is only reported as a
session total and a subagent's cost can land on the turn that completes after it. Nothing is
booked until a first cost reading, so a session's earlier spend is never counted twice.

Days older than 30 are deleted. The store is shared by every session on the machine and has no
locking, so two sessions finishing a turn in the same instant can drop one of the two. A failed
write shows at the top of the pane.
