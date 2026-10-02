# meter

One row above the prompt:

```
ctx ▇▇▇▁▁ 61% 122k/200k · 5h 55% ↻1h12m · 7d 26% · $3.41 · cache 92% · ▁▂▅▃▇ per req
```

- Context and 5h figures go yellow at 50% and red at 80%. At 80% an idle band shows a
  **Compact** button (the same compaction `/compact` runs); mid-turn it says `compact soon`.
- Cache is cache reads over all input tokens, summed over every model request this session,
  subagents included. The sparkline is tokens per request, last 16.
- Under 100 columns the row drops to `ctx 61% · 5h 55% · $3.41`.
- The spinner gains `· 4.2k in+out`: uncached input plus output tokens this turn.

Figures come from `$.session.usage()`, the status line's numbers. If a read fails, the row says
the figures are stale rather than showing them as current.

## /spend

Opens a pane: cost per day for the last 14 days (a Raster in the terminal, text rows on the
desktop), then the top repos, branches and models for 1, 7 or 30 days, and this session's
cache-hit rate.

Every finished turn, subagents' included, books its tokens and its share of the session's cost
into `$.store` under `meter:YYYY-MM-DD`, by repo (the main checkout's folder name), git branch and
model. Days older than 30 are deleted. The store is shared by every session on the machine and
has no locking, so two sessions finishing a turn in the same instant can drop one of the two.
