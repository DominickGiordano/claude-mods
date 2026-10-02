import type { RenderPropsOf } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { keyOf } from '../hooks/ledger'
import type { Day } from '../hooks/ledger'
import { BAND, complete, start, step, stepUsage, usageAt, world } from './world'

const NOW = new Date(2026, 9, 2, 15, 0).getTime()

const PANE: RenderPropsOf['Pane'] = {
  title: 'Tokens',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

function day(w: ReturnType<typeof world>) {
  return w.store.get(keyOf(NOW)) as Day
}

async function pane($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'meter', surface, component: 'Pane', requestId: 'tokens', props: PANE })
  const text = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  return { ui, text }
}

describe('ledger', () => {
  test('each turn books its tokens by repo, branch and model', async ($, on) => {
    const w = world(on, NOW)
    await start($)

    await $.turn.start({ text: 'go', turnId: 't1' })
    await complete($, stepUsage(100, 1000, 0, 50, 'claude-sonnet-4-5'), 't1')
    await complete($, stepUsage(10, 0, 0, 5, 'claude-haiku-4-5'), 'sub-1', 'agent-1')
    expect(w.gitRuns, 'one git run per main turn, subagent turns reuse it').toBe(1)

    w.branch = 'main'
    await $.turn.start({ text: 'again', turnId: 't2' })
    await complete($, stepUsage(200, 0, 0, 100, 'claude-sonnet-4-5'), 't2')
    expect(w.gitRuns).toBe(2)

    expect(day(w)).toEqual({
      repos: { 'claude-mods': { tokens: 1465 } },
      branches: {
        'feature/1138 (claude-mods)': { tokens: 1165 },
        'main (claude-mods)': { tokens: 300 },
      },
      models: {
        'claude-sonnet-4-5': { tokens: 1450 },
        'claude-haiku-4-5': { tokens: 15 },
      },
    })
  })

  test('concurrent completes in one process both land', async ($, on) => {
    const w = world(on, NOW)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await Promise.all([
      complete($, stepUsage(100, 0, 0, 0, 'claude-sonnet-4-5'), 't1'),
      complete($, stepUsage(10, 0, 0, 0, 'claude-haiku-4-5'), 'sub-1', 'agent-1'),
      complete($, stepUsage(1, 0, 0, 0, 'claude-haiku-4-5'), 'sub-2', 'agent-2'),
    ])
    expect(day(w).repos['claude-mods']?.tokens).toBe(111)
  })

  test('a turn without usage books nothing', async ($, on) => {
    const w = world(on, NOW)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, reason: 'aborted', turnId: 't1' })
    expect(w.store.has(keyOf(NOW))).toBe(false)
  })

  test('a day stored with usd before 0.2.0 still loads and keeps adding tokens', async ($, on) => {
    const w = world(on, NOW, {
      [keyOf(NOW)]: {
        repos: { 'claude-mods': { usd: 3, tokens: 1000 } },
        branches: { 'feature/1138 (claude-mods)': { usd: 3, tokens: 1000 } },
        models: { 'claude-sonnet-4-5': { usd: 3, tokens: 1000 } },
      },
    })
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await complete($, stepUsage(10, 0, 0, 5), 't1')
    expect(day(w).repos['claude-mods']?.tokens).toBe(1015)
    const { text } = await pane($)
    expect(await text()).toContain('7d total 1.0k tok')
    expect(await text()).not.toContain('$')
  })

  test('outside a repository the directory names it and git never runs', async ($, on) => {
    const w = world(on, NOW)
    w.repoRoot = null
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await complete($, stepUsage(1, 0, 0, 1), 't1')
    expect(w.gitRuns).toBe(0)
    expect(Object.keys(day(w).branches)).toEqual(['(no git) (scratch)'])
  })

  test('the first write of a day deletes days past 30 and nothing else', async ($, on) => {
    const w = world(on, NOW, {
      [keyOf(NOW, 29)]: { repos: {}, branches: {}, models: {} },
      [keyOf(NOW, 30)]: { repos: {}, branches: {}, models: {} },
      [keyOf(NOW, 400)]: { repos: {}, branches: {}, models: {} },
      'meter:not-a-day': 1,
    })
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await complete($, stepUsage(1, 0, 0, 1), 't1')
    expect([...w.store.keys()].sort()).toEqual([keyOf(NOW, 29), keyOf(NOW), 'meter:not-a-day'].sort())
  })

  test('a failed store write is logged and shown on the pane until one succeeds', async ($, on) => {
    const w = world(on, NOW)
    await start($)
    w.storeFails = true
    await complete($, stepUsage(1, 0, 0, 1))
    expect(w.logs.some(l => l.startsWith('meter: ledger write failed'))).toBe(true)
    const { text } = await pane($)
    expect(await text()).toContain('ledger write failed')
    w.storeFails = false
    await complete($, stepUsage(1, 0, 0, 1))
    expect(await text()).not.toContain('ledger write failed')
  })

  test('a failed seed read is logged and retried on the next turn', async ($, on) => {
    const w = world(on, NOW)
    w.usage = null
    await start($)
    expect(w.logs.some(l => l.startsWith('meter: usage read failed'))).toBe(true)
    w.usage = usageAt(40, NOW)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'meter', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('')).toContain('ctx ▇▇▁▁▁ 40%')
  })

  test('after /clear the session cache resets', async ($, on) => {
    const w = world(on, NOW)
    w.steps = [stepUsage(0, 1000, 0, 1)]
    await start($)
    await step($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    const { text } = await pane($)
    expect(await text()).toContain("This session's cache hits: no requests yet")
  })
})

describe('/tokens', () => {
  const STORED = {
    [keyOf(NOW)]: {
      repos: { app: { tokens: 2000 } },
      branches: { 'feature/1138 (app)': { tokens: 2000 } },
      models: { 'claude-opus-4-5': { tokens: 2000 } },
    },
    [keyOf(NOW, 1)]: { repos: 'garbage' },
    [keyOf(NOW, 10)]: {
      repos: { api: { tokens: 9000 } },
      branches: { 'main (api)': { tokens: 9000 } },
      models: { 'claude-sonnet-4-5': { tokens: 9000 } },
    },
  }

  test('opens the pane and answers nothing Claude reads', async ($, on) => {
    const w = world(on, NOW)
    await start($)
    const run = await $.command.run({ command: 'tokens', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(run).toEqual({})
    expect(w.opened).toEqual(['tokens'])
  })

  test('chart rows, then the range’s repos, branches and models by tokens', async ($, on) => {
    const w = world(on, NOW, STORED)
    w.steps = [stepUsage(100, 900, 0, 10)]
    await start($)
    await step($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const { ui, text } = await pane($, surface)
      const rows = (await ui.findAll({ type: 'Text' })).filter(t => t.props.color === 'cyan')
      expect(rows).toHaveLength(6)
      expect(rows[0]?.text.startsWith(' '.repeat(9) + '██')).toBe(true)
      expect(rows[5]?.text.endsWith('██')).toBe(true)
      expect(await text()).toContain('Tokens per day, last 14 days (max 9.0k)')
      expect(await text()).toContain('7d total 2.0k tok')
      expect(await text()).toContain('    2.0k tok  feature/1138 (app)')
      expect(await text()).not.toContain('main (api)')
      expect(await text()).toContain("This session's cache hits: 90%")
      await ui.unmount()
    }

    const { ui, text } = await pane($)
    await ui.press({ key: '30d' })
    expect(await text()).toContain('30d total 11.0k tok')
    expect(await text()).toMatch(/9\.0k tok  main \(api\)\n.*2\.0k tok  feature/)
  })

  test('a tiny day still draws a bar', async ($, on) => {
    world(on, NOW, {
      [keyOf(NOW)]: { repos: { a: { tokens: 1 } }, branches: {}, models: {} },
      [keyOf(NOW, 1)]: { repos: { a: { tokens: 10_000 } }, branches: {}, models: {} },
    })
    await start($)
    const { ui } = await pane($)
    const rows = (await ui.findAll({ type: 'Text' })).filter(t => t.props.color === 'cyan')
    expect(rows[5]?.text.endsWith('▁▁')).toBe(true)
  })

  test('more than five entries says how many are hidden', async ($, on) => {
    const repos = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((r, i) => [r, { tokens: i + 1 }]))
    world(on, NOW, { [keyOf(NOW)]: { repos, branches: {}, models: {} } })
    await start($)
    const { text } = await pane($)
    expect(await text()).toContain('Repos\n       7 tok  g')
    expect(await text()).toContain('  +2 more\nBranches')
  })

  test('the empty state shows only with no day records; a zero day still draws the chart', async ($, on) => {
    const w = world(on, NOW)
    await start($)
    const empty = await pane($)
    expect(await empty.text()).toContain('No tokens recorded in the last 14 days.')
    await empty.ui.unmount()
    w.store.set(keyOf(NOW), { repos: { a: { tokens: 0 } }, branches: {}, models: {} })
    await $.command.run({ command: 'tokens', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(await (await pane($)).text()).not.toContain('No tokens recorded')
  })
})
