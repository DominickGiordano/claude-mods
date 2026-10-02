declare module 'claude-code' {
  interface PluginState {
    'pr-watch': {
      prs: {
        url: string
        repo: string
        number: number
        title: string
        base: string
        head: string
        headOid: string
        draft: boolean
        state: string
        mergeable: string
        mergeState: string
        checks: 'pass' | 'fail' | 'pending' | 'none'
        failed: string[]
        // Set while polls fail: when the first failure happened and gh's message.
        error: { since: number; text: string } | null
        trackedAt: number
        doneAt: number | null
        auto: boolean
        // Why the last merge-when-green attempt failed, until dismissed or the PR changes.
        autoFailed: string | null
        nudged: boolean
      }[]
    }
  }
}
