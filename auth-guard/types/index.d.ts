export type Problem = {
  provider: string
  state: 'expired' | 'check failed' | 'logging in' | 'login failed' | 'unknown provider'
  login?: readonly string[]
}

declare module 'claude-code' {
  interface PluginState {
    'auth-guard': { problems: readonly Problem[] }
  }
}
