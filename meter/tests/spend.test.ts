import type { RenderPropsOf } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { keyOf } from '../hooks/ledger'
import type { Day } from '../hooks/ledger'
import { complete, start, step, stepUsage, usageAt, world } from './world'

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

describe('ledger', () => {
  test('books each turn’s cost delta by repo, branch and model, subagents included', async ($, on) => {
    const w = world(on, NOW)
    w.usage = costAt(3.5)
    await start($)

    await $.turn.start({ text: 'go', turnId: 't1' })
    w.usage = costAt(4)
    await complete($, stepUsage(100, 1000, 0, 50, 'claude-sonnet-4-5'), 't1')
    w.usage = costAt(4.5)
    await complete($, stepUsage(10, 0, 0, 5, 'claude-haiku-4-5'), 'sub-1', 'agent-1')
    expect(w.gitRuns, 'one git run per main turn, subagent turns reuse it').toBe(1)

    w.branch = 'main'
    await $.turn.start({ text: 'again', turnId: 't2' })
    w.usage = costAt(5.25)
    await complete($, stepUsage(200, 0, 0, 100, 'claude-sonnet-4-5'), 't2')
    expect(w.gitRuns).toBe(2)

    expect(day(w)).toEqual({
      repos: { 'claude-mods': { usd: 1.75, tokens: 1465 } },
      branches: {
        'feature/1138 (claude-mods)': { usd: 1, tokens: 1165 },
        'main (claude-mods)': { usd: 0.75, tokens: 300 },
      },
      models: {
        'claude-sonnet-4-5': { usd: 1.25, tokens: 1450 },
        'claude-haiku-4-5': { usd: 0.5, tokens: 15 },
      },
    })
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
})

describe('/spend', () => {
  const STORED = {
    [keyOf(NOW)]: {
      repos: { app: { usd: 2, tokens: 2000 } },
      branches: { 'feature/1138 (app)': { usd: 2, tokens: 2000 } },
      models: { 'claude-opus-4-5': { usd: 2, tokens: 2000 } },
    },
    [keyOf(NOW, 10)]: {
      repos: { api: { usd: 8, tokens: 9000 } },
      branches: { 'main (api)': { usd: 8, tokens: 9000 } },
      models: { 'claude-sonnet-4-5': { usd: 8, tokens: 9000 } },
    },
  }

  test('opens the pane and answers nothing Claude reads', async ($, on) => {
    const w = world(on, NOW)
    await start($)
    expect(await $.command.run({ command: 'spend', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).toEqual({})
    expect(w.opened).toEqual(['spend'])
  })

  test('terminal draws a Raster chart, then the range’s repos, branches and models', async ($, on) => {
    const w = world(on, NOW, STORED)
    w.steps = [stepUsage(100, 900, 0, 10)]
    await start($)
    await step($)
    const ui = await $.ui.mount({ plugin: 'meter', surface: 'terminal', component: 'Pane', requestId: 'spend', props: PANE })
    const raster = await ui.find({ type: 'Raster' })
    expect(raster?.props).toMatchObject({ columns: 41, rows: 6 })

    const text = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(await text()).toContain('max $8.00')
    expect(await text()).toContain('7d total $2.00 · 2.0k tok')
    expect(await text()).toContain('$2.00    2.0k tok  feature/1138 (app)')
    expect(await text()).not.toContain('main (api)')
    expect(await text()).toContain("This session's cache hits: 90%")

    await ui.press({ key: '30d' })
    expect(await text()).toContain('30d total $10.00 · 11.0k tok')
    expect(await text()).toMatch(/\$8\.00 +9\.0k tok  main \(api\)\n.*\$2\.00/)
  })

  test('desktop draws the same chart as Text rows', async ($, on) => {
    world(on, NOW, STORED)
    await start($)
    const ui = await $.ui.mount({ plugin: 'meter', surface: 'desktop', component: 'Pane', requestId: 'spend', props: PANE })
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    const rows = (await ui.findAll({ type: 'Text' })).filter(t => t.props.color === 'cyan')
    expect(rows).toHaveLength(6)
    expect(rows[0]?.text.startsWith(' '.repeat(9) + '██')).toBe(true)
    expect(rows[4]?.text.endsWith('▄▄')).toBe(true)
    expect(rows[5]?.text.endsWith('██')).toBe(true)
  })

  test('an empty ledger says so instead of drawing flat bars', async ($, on) => {
    world(on, NOW)
    await start($)
    const ui = await $.ui.mount({ plugin: 'meter', surface: 'terminal', component: 'Pane', requestId: 'spend', props: PANE })
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'No spend recorded in the last 14 days.' })).toBeDefined()
  })
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
  w.usage = costAt(0.25)
  await complete($, stepUsage(1, 0, 0, 1), 't1')
  expect(day(w).repos['claude-mods']?.usd, 'booked from the post-clear baseline').toBe(0.25)
  const ui = await $.ui.mount({ plugin: 'meter', surface: 'terminal', component: 'Pane', requestId: 'spend', props: PANE })
  expect(await ui.find({ type: 'Text', text: "This session's cache hits: no requests yet" })).toBeDefined()
})
