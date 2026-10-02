# pr-watch

Watches the pull requests Claude opens in a session, so you stop typing "merged, keep going".

- **Band row** above the prompt: `PRs  #1138 ✓ CI · mergeable   #1139 ✗ conflicts   #1140 ● CI running   #1141 merged`.
  Polls `gh pr view` every 60 s. A failed poll shows as `#12 ? gh failed 2m ago`, never as the last good value.
  Merged and closed PRs drop off 10 minutes later.
- **Merge** squash-merges with `gh pr merge --squash` (plus `--delete-branch` unless the head is `develop`, `main`
  or `master`). **When green** merges on the first poll where checks pass and GitHub says mergeable, and
  cancels if checks fail. A PR into `main` or `master` gets no merge button: promotions are merged by hand.
- **Nudge**: when a PR merges and Claude is idle, Claude gets one prompt, e.g. `PR #1138 (feature/x → develop) merged.`
- `/prs` opens a pane with every PR, its failing check names, and the merge buttons (digit hotkeys `1`–`9`).
  `/prs add <url|owner/repo#n>` watches a PR Claude didn't open; `/prs drop <n>` stops watching one.

PRs are picked up from the output of any Bash call that runs `gh pr create`. Needs `gh` signed in.

## Install

```bash
claude plugin marketplace add DominickGiordano/claude-mods
claude plugin install pr-watch@claude-mods
```

## Options

| Option | Default | |
|---|---|---|
| `nudge` | `true` | Send Claude a prompt when a watched PR merges. |

Set it under `pluginConfigs["pr-watch@claude-mods"].options` in settings, or from `/config`.
