# pr-watch

Watches the pull requests Claude opens in a session, so you stop typing "merged, keep going".

- **Band row** above the prompt: `PRs  #1138 ✓ CI · mergeable   #1139 ✗ conflicts   #1140 ● CI running   #1141 merged`.
  Polls `gh pr view` every 60 s (up to 4 at a time). With PRs from more than one repo, rows read `owner/repo#n`.
  A failed poll shows `#12 ? gh failed 2m ago`, never the last good value; a PR still failing after 6 h is
  dropped with a toast. Merged and closed PRs drop off 10 minutes after they close. A PR with no checks
  reads `● CI running` for its first 3 minutes, then `no CI`; only passing checks get a ✓.
- **Merge** re-reads the PR, then runs `gh pr merge --squash --delete-branch --match-head-commit <sha>` from
  outside your checkout, so only the remote branch is deleted and a push since the last poll fails the merge.
  It shows only when checks pass (or there are none). **When green** merges on the first poll where checks
  pass, GitHub says mergeable and the merge state is `CLEAN`; it cancels if checks fail, and a failed attempt
  shows `auto failed` until you press OK or the PR changes.
- **Which PRs get buttons**: base in `mergeBases` (default `develop`), not a draft, and a head that isn't a
  long-lived branch (`develop`, `main`, `master`, `staging`, `production`, `release*`). Anything else is merged
  by hand; the pane says why.
- **Nudge** (on by default): when a PR merges and Claude is idle, Claude gets one prompt, e.g.
  `PR #1138 (feature/x → develop) merged.` It states a fact; Claude decides what to do with it. Turn it off
  with `nudge`.
- `/prs` opens a pane with every PR, failing check names, and the merge buttons (digit hotkeys `1`–`9`). The
  band's buttons have no hotkeys, since a digit typed into an empty prompt would press them.
  `/prs add <url|owner/repo#n>` watches a PR Claude didn't open (`owner/repo#n` means github.com).
  `/prs drop <n|url|owner/repo#n>` stops watching one; a bare number works when only one PR has it.

PRs are picked up from a successful Bash call running `gh pr create` whose output has a line that is exactly
a PR URL on github.com or a host in `hosts`. Needs `gh` signed in.

## Install

```bash
claude plugin marketplace add DominickGiordano/claude-mods
claude plugin install pr-watch@claude-mods
```

## Options

| Option | Default | |
|---|---|---|
| `nudge` | `true` | Send Claude a prompt when a watched PR merges. |
| `mergeBases` | `["develop"]` | Base branches the merge buttons may merge into. |
| `hosts` | `[]` | GitHub Enterprise hosts to watch besides github.com. |

Set them under `pluginConfigs["pr-watch@claude-mods"].options` in settings, or from `/config`.
