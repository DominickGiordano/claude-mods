import type { RenderPropsOf } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { keyOf } from '../hooks/ledger'
import type { Day } from '../hooks/ledger'
import { complete, measure, start, step, stepUsage, usageAt, world } from './world'

const NOW = new Date(2026, 9, 2, 15, 0).getTime()

const PANE: RenderPropsOf['Pane'] = {
  title: 'Spend',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

function costAt(usd: number) {
  return { ...usageAt(40, NOW), cost: { usd } }
}

function day(w: ReturnType<typeof world>) {
  return w.store.get(keyOf(NOW)) as Day
}

async function pane($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'meter', surface, component: 'Pane', requestId: 'spend', props: PANE })
  const text = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  return { ui, text }
}

describe('ledger', () => {
  test('each turn books its tokens and the cost measured before it, by repo, branch and model', async ($, on) => {
    const w = world(on, NOW)
    w.usage = costAt(3.5)
    await start($)

    await $.turn.start({ text: 'go', turnId: 't1' })
    await measure($, costAt(4))
    await complete($, stepUsage(100, 1000, 0, 50, 'claude-sonnet-4-5'), 't1')
    await complete($, stepUsage(10, 0, 0, 5, 'claude-haiku-4-5'), 'sub-1', 'agent-1')
    expect(w.gitRuns, 'one git run per main turn, subagent turns reuse it').toBe(1)

    w.branch = 'main'
    await $.turn.start({ text: 'again', turnId: 't2' })
    await measure($, costAt(5.25))
    await complete($, stepUsage(200, 0, 0, 100, 'claude-sonnet-4-5'), 't2')
    expect(w.gitRuns).toBe(2)

    expect(day(w)).toEqual({
      repos: { 'claude-mods': { usd: 1.75, tokens: 1465 } },
      branches: {
        'feature/1138 (claude-mods)': { usd: 0.5, tokens: 1165 },
        'main (claude-mods)': { usd: 1.25, tokens: 300 },
      },
      models: {
        'claude-sonnet-4-5': { usd: 1.75, tokens: 1450 },
        'claude-haiku-4-5': { usd: 0, tokens: 15 },
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

  test('without a seed reading nothing is booked until a measure seeds it', async ($, on) => {
    const w = world(on, NOW)
    w.usage = null
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    expect(w.logs.some(l => l.startsWith('meter: usage read failed'))).toBe(true)
    await measure($, costAt(9))
    await complete($, stepUsage(1, 0, 0, 1), 't1')
    expect(day(w).repos['claude-mods']?.usd, 'the whole session total is never booked').toBe(0)
    await $.turn.start({ text: 'go', turnId: 't2' })
    await measure($, costAt(9.5))
    await complete($, stepUsage(1, 0, 0, 1), 't2')
    expect(day(w).repos['claude-mods']?.usd).toBe(0.5)
  })

  test('an aborted turn without usage still books its cost, model unknown', async ($, on) => {
    const w = world(on, NOW)
    w.usage = costAt(1)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await measure($, costAt(1.25))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, reason: 'aborted', turnId: 't1' })
    expect(day(w).models).toEqual({ unknown: { usd: 0.25, tokens: 0 } })
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

  test('after /clear the next turn re-seeds the cost baseline and session cache', async ($, on) => {
    const w = world(on, NOW)
    w.usage = costAt(6)
    w.steps = [stepUsage(0, 1000, 0, 1)]
    await start($)
    await step($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    w.usage = costAt(0)
    await $.turn.start({ text: 'fresh', turnId: 't1' })
    await measure($, costAt(0.25))
    await complete($, undefined, 't1')
    expect(day(w).repos['claude-mods']?.usd, 'booked from the post-clear baseline').toBe(0.25)
    const { text } = await pane($)
    expect(await text()).toContain("This session's cache hits: no requests yet")
  })
})

describe('/spend', () => {
  const STORED = {
    [keyOf(NOW)]: {
      repos: { app: { usd: 2, tokens: 2000 } },
      branches: { 'feature/1138 (app)': { usd: 2, tokens: 2000 } },
      models: { 'claude-opus-4-5': { usd: 2, tokens: 2000 } },
    },
    [keyOf(NOW, 1)]: { repos: 'garbage' },
    [keyOf(NOW, 10)]: {
      repos: { api: { usd: 8, tokens: 9000 } },
      branches: { 'main (api)': { usd: 8, tokens: 9000 } },
      models: { 'claude-sonnet-4-5': { usd: 8, tokens: 9000 } },
    },
  }

  test('opens the pane and answers nothing Claude reads', async ($, on) => {
    const w = world(on, NOW)
    await start($)
    const run = await $.command.run({ command: 'spend', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(run).toEqual({})
    expect(w.opened).toEqual(['spend'])
  })

  test('chart rows, then the range’s repos, branches and models with ≈ shares', async ($, on) => {
    const w = world(on, NOW, STORED)
    w.steps = [stepUsage(100, 900, 0, 10)]
    await start($)
    await step($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const { ui, text } = await pane($, surface)
      const rows = (await ui.findAll({ type: 'Text' })).filter(t => t.props.color === 'cyan')
      expect(rows).toHaveLength(6)
      expect(rows[0]?.text.startsWith(' '.repeat(9) + '██')).toBe(true)
      expect(rows[4]?.text.endsWith('▄▄')).toBe(true)
      expect(rows[5]?.text.endsWith('██')).toBe(true)
      expect(await text()).toContain('max $8.00')
      expect(await text()).toContain('7d total $2.00 · 2.0k tok')
      expect(await text()).toContain('   ≈$2.00    2.0k tok  feature/1138 (app)')
      expect(await text()).not.toContain('main (api)')
      expect(await text()).toContain("This session's cache hits: 90%")
      await ui.unmount()
    }

    const { ui, text } = await pane($)
    await ui.press({ key: '30d' })
    expect(await text()).toContain('30d total $10.00 · 11.0k tok')
    expect(await text()).toMatch(/≈\$8\.00 +9\.0k tok  main \(api\)\n.*≈\$2\.00/)
  })

  test('a tiny day still draws a bar', async ($, on) => {
    world(on, NOW, {
      [keyOf(NOW)]: { repos: { a: { usd: 0.01, tokens: 1 } }, branches: {}, models: {} },
      [keyOf(NOW, 1)]: { repos: { a: { usd: 100, tokens: 1 } }, branches: {}, models: {} },
    })
    await start($)
    const { ui } = await pane($)
    const rows = (await ui.findAll({ type: 'Text' })).filter(t => t.props.color === 'cyan')
    expect(rows[5]?.text.endsWith('▁▁')).toBe(true)
  })

  test('more than five entries says how many are hidden', async ($, on) => {
    const repos = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((r, i) => [r, { usd: i + 1, tokens: 1 }]))
    world(on, NOW, { [keyOf(NOW)]: { repos, branches: {}, models: {} } })
    await start($)
    const { text } = await pane($)
    expect(await text()).toContain('Repos\n     ≈$7.00')
    expect(await text()).toContain('  +2 more\nBranches')
  })

  test('the empty state shows only with no day records; a $0 day still draws the chart', async ($, on) => {
    const w = world(on, NOW)
    await start($)
    const empty = await pane($)
    expect(await empty.text()).toContain('No spend recorded in the last 14 days.')
    await empty.ui.unmount()
    w.store.set(keyOf(NOW), { repos: { a: { usd: 0, tokens: 5 } }, branches: {}, models: {} })
    await $.command.run({ command: 'spend', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(await (await pane($)).text()).not.toContain('No spend recorded')
  })
})
