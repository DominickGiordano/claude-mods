import type { On, RenderPropsOf, SessionUsage, TurnUsage } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

export const HOUR = 3_600_000

export const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

export function usageAt(percent: number, now = 0): SessionUsage {
  return {
    startedAt: 0,
    context: { tokens: percent * 2000, window: 200_000, percent },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 55, resetsAt: new Date(now + HOUR + 12 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 26, resetsAt: new Date(now + 90 * HOUR).toISOString() },
    ],
    cost: { usd: 3.41 },
  }
}

export function stepUsage(input: number, read: number, written: number, output: number, model = 'claude-sonnet-4-5'): TurnUsage {
  return { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: written, output_tokens: output, model }
}

// The engine beneath the mod: usage, clock, store, git and the draw stubs a chained hook needs.
export function world(on: On, now = 0, stored: Record<string, unknown> = {}) {
  const w = {
    store: new Map(Object.entries(stored)),
    usage: usageAt(61, now) as SessionUsage | null,
    steps: [] as TurnUsage[],
    compacts: 0,
    branch: 'feature/1138',
    repoRoot: '/work/claude-mods' as string | null,
    gitRuns: 0,
    opened: [] as string[],
    toasts: [] as string[],
    clock: mock.clock(on, { now }),
  }
  // Own store stubs rather than mock.store: the test's engine has no $.store to read the ledger back with.
  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.usage', () => (w.usage ? { value: w.usage } : { deny: 'no reading' }))
  on('session.compact', () => {
    w.compacts++
    return { skip: 'stubbed' }
  })
  on('session.repo', () => ({ value: w.repoRoot ? { root: w.repoRoot, remote: null, internal: false, name: null } : null }))
  on('session.root', () => ({ value: '/work/scratch' }))
  on('process.run', () => {
    w.gitRuns++
    return { value: { exitCode: 0, stdout: `${w.branch}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: w.steps.shift() ?? null }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['beneath'] }))
  on('ui.render', { component: 'Spinner' }, (_$, e) => ({ type: 'Text', children: [`${e.props.word}${e.props.suffix}`] }))
  return w
}

export async function start($: Engine) {
  await $.session.start({ cwd: '/work/claude-mods', surface: 'terminal', isInteractive: true })
}

export async function step($: Engine, turnId = 't1', agentId?: string) {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-sonnet-4-5', messageCount: 1, ...(agentId && { agentId }) })
  for await (const _ of stream);
  return stream.result
}

export async function complete($: Engine, usage?: TurnUsage, turnId = 't1', agentId?: string) {
  return $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', turnId, ...(usage && { usage }), ...(agentId && { agentId }) })
}
