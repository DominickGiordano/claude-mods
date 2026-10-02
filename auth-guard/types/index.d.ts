export type Problem = {
  provider: string
  state: 'expired' | 'check failed' | 'not installed' | 'logging in' | 'login failed' | 'unknown provider'
  checkedAt: number
  // A login the band may run; absent when the user has to run it in a terminal.
  login?: readonly string[]
  // Shown on press: why the check failed, or what to run.
  detail?: string
}

declare module 'claude-code' {
  interface PluginState {
    'auth-guard': { problems: readonly Problem[] }
  }
}
