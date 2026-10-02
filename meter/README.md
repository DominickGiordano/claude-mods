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
- The spinner gains `· 12s · 4.2k tok`: time and input+output tokens this turn.

Figures come from `$.session.usage()`, the status line's numbers. If a read fails, the row says
the figures are stale rather than showing them as current.
