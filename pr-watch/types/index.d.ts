declare module 'claude-code' {
  interface PluginState {
    'pr-watch': {
      prs: {
        url: string
        number: number
        title: string
        base: string
        head: string
        state: string
        mergeable: string
        mergeState: string
        checks: 'pass' | 'fail' | 'pending' | 'none'
        failed: string[]
        // Set while polls fail: when the first failure happened and gh's message.
        error: { since: number; text: string } | null
        doneAt: number | null
        auto: boolean
        nudged: boolean
      }[]
    }
  }
}
