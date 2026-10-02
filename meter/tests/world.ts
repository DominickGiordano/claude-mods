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

// The engine beneath the mod: usage, clock and the draw stubs a chained hook needs.
export function world(on: On, now = 0) {
  const w = {
    usage: usageAt(61, now) as SessionUsage | null,
    steps: [] as TurnUsage[],
    compacts: 0,
    toasts: [] as string[],
    clock: mock.clock(on, { now }),
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => (w.usage ? { value: w.usage } : { deny: 'no reading' }))
  on('session.compact', () => {
    w.compacts++
    return { skip: 'stubbed' }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: w.steps.shift() ?? null }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.invalidate', () => ({ value: undefined }))
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
