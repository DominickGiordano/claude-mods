import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { SessionUsage } from 'claude-code'

import { BAND, HOUR, complete, measure, start, step, stepUsage, usageAt, world } from './world'

async function band($: Engine, props = BAND) {
  const ui = await $.ui.mount({ plugin: 'meter', surface: 'terminal', component: 'AbovePrompt', props })
  const texts = await ui.findAll({ type: 'Text' })
  return { ui, row: texts.map(t => t.text).join(''), texts }
}

function at(memory: number, plan: number, week: number): SessionUsage {
  const u = usageAt(memory)
  return { ...u, rateLimits: [{ ...u.rateLimits[0]!, percentUsed: plan }, { ...u.rateLimits[1]!, percentUsed: week }] }
}

describe('band', () => {
  test('quiet: one dim line while everything is below its threshold', async ($, on) => {
    world(on)
    await start($)
    await measure($, at(41, 31, 22))
    const { texts, row } = await band($)
    expect(row).toBe('memory 41% · plan 31% · week 22%' + 'beneath')
    expect(texts[0]?.props.dimColor).toBe(true)
  })

  test('expanded: three aligned rows with bars, hints only where they apply, never cache or cost', async ($, on) => {
    const w = world(on)
    w.usage = { ...at(78, 31, 22), cost: { usd: 70 } }
    w.steps = [stepUsage(100, 0, 900, 50)]
    await start($)
    await step($)
    const { ui } = await band($)
    const lines = (await ui.findAll({ type: 'Box' })).filter(b => b.props.flexDirection === 'row').map(b => b.text)
    expect(lines).toEqual([
      'memory ███████▊░░  78%  clear when you switch tasks',
      'plan   ███▏░░░░░░  31%  resets 1h 12m',
      'week   ██▎░░░░░░░  22%',
    ])
    expect((await band($)).row).not.toMatch(/cache|\$/)
  })

  test('bar color green <50, yellow 50–79, red ≥80; label dim, percent bold in the bar color', async ($, on) => {
    world(on)
    await start($)
    const styleAt = async (percent: number) => {
      await measure($, at(percent, 55, 22))
      const { texts } = await band($)
      const fill = texts[1]!
      const pct = texts.find(t => t.text.trim() === `${percent}%`)!
      expect(texts[0]?.props.dimColor).toBe(true)
      expect(pct.props.bold).toBe(true)
      expect(pct.props.color).toBe(fill.props.color)
      return fill.props.color
    }
    expect(await styleAt(49)).toBe('green')
    expect(await styleAt(50)).toBe('yellow')
    expect(await styleAt(79)).toBe('yellow')
    expect(await styleAt(80)).toBe('red')
  })

  test('partial cells in eighths, a full bar has no track', async ($, on) => {
    world(on)
    await start($)
    const memoryRow = async (percent: number) => {
      await measure($, at(percent, 55, 22))
      return (await band($)).row.split('plan')[0]
    }
    expect(await memoryRow(78)).toMatch(/^memory ███████▊░░  78%/)
    expect(await memoryRow(5)).toMatch(/^memory ▌░░░░░░░░░   5%/)
    expect(await memoryRow(100)).toMatch(/^memory ██████████ 100%/)
  })

  test('narrow width shrinks the bar', async ($, on) => {
    world(on)
    await start($)
    await measure($, at(78, 31, 22))
    expect((await band($, { ...BAND, bodyColumns: 55 })).row).toMatch(/^memory ███▉░  78%/)
    expect((await band($, { ...BAND, bodyColumns: 30 })).row).toMatch(/^memory ███▏  78%/)
  })

  test('memory ≥80: clear soon and Compact when idle; just the warning mid-turn', async ($, on) => {
    const w = world(on)
    w.usage = usageAt(85)
    await start($)
    const idle = await band($)
    expect(idle.row).toContain('85%  ⚠ clear soon')
    expect(idle.texts.find(t => t.text === '⚠ clear soon')?.props.color).toBe('red')
    w.usage = usageAt(20)
    await idle.ui.press({ key: 'compact' })
    expect(w.compacts).toBe(1)
    expect(w.toasts).toEqual(['meter: compact skipped, stubbed'])
    expect((await band($)).row, 'context re-read after compacting').toContain('memory ██░░░░░░░░  20%')

    await measure($, usageAt(85))
    const busy = await band($, { ...BAND, isWorking: true })
    expect(busy.row).toContain('⚠ clear soon')
    expect(await busy.ui.find({ type: 'Button' })).toBeUndefined()
  })

  test('below 80% memory there is no compact control', async ($, on) => {
    world(on)
    await start($)
    const { ui, row } = await band($)
    expect(row).not.toContain('clear soon')
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
  })

  test('plan ≥90 says near limit in red, beside its reset time', async ($, on) => {
    world(on)
    await start($)
    await measure($, at(20, 92, 22))
    const { row, texts } = await band($)
    expect(row).toContain('plan   █████████▎  92%  ⚠ near limit  resets 1h 12m')
    expect(texts.find(t => t.text === '⚠ near limit')?.props.color).toBe('red')
  })

  test('plan alone past 50% expands the band', async ($, on) => {
    world(on)
    await start($)
    await measure($, at(20, 50, 22))
    expect((await band($)).row).toContain('memory ██░░░░░░░░  20%plan')
  })

  test('week shows its reset day only from 50%, the hours when under a day away', async ($, on) => {
    world(on)
    await start($)
    await measure($, at(70, 31, 49))
    expect((await band($)).row).toMatch(/week   .* 49%beneath$/)
    await measure($, at(20, 31, 50))
    expect((await band($)).row).toContain(' 50%  resets Sun')
    const u = at(20, 31, 50)
    await measure($, { ...u, rateLimits: [u.rateLimits[0]!, { ...u.rateLimits[1]!, resetsAt: new Date(5 * HOUR).toISOString() }] })
    expect((await band($)).row).toContain(' 50%  resets 5h 0m')
  })

  test('a window past its reset time says reset? instead of a stale percent', async ($, on) => {
    const w = world(on)
    await start($)
    await w.clock.advance(2 * HOUR)
    await measure($, at(41, 55, 26))
    expect((await band($)).row, 'a stale plan does not hold the band open').toBe('memory 41% · plan reset? · week 26%beneath')
    await measure($, at(85, 55, 26))
    const { row } = await band($)
    expect(row).toContain('plan   reset?week')
    expect(row).not.toContain('55%')
  })

  test('API-key users: no limits, only the memory row', async ($, on) => {
    world(on)
    await start($)
    const u = usageAt(70)
    await measure($, { ...u, rateLimits: [] })
    expect((await band($)).row).toBe('memory ███████░░░  70%  clear when you switch tasks' + 'beneath')
    await measure($, { ...usageAt(30), rateLimits: [] })
    expect((await band($)).row).toBe('memory 30%beneath')
  })

  test('a missing figure drops its row rather than showing 0%', async ($, on) => {
    world(on)
    await start($)
    const u = at(70, 31, 22)
    await measure($, { ...u, context: { window: 200_000 }, rateLimits: [u.rateLimits[0]!, { ...u.rateLimits[1]!, percentUsed: NaN }] })
    expect((await band($)).row).toBe('plan 31%beneath')
    await measure($, { ...u, context: { window: 200_000 }, rateLimits: [] })
    expect((await band($)).row).toBe('beneath')
  })

  test('passes through untouched before any reading and under a survey', async ($, on) => {
    const w = world(on)
    w.usage = null
    await start($)
    expect((await band($)).row).toBe('beneath')
    await measure($, usageAt(61))
    expect((await band($, { ...BAND, hasSurvey: true })).row).toBe('beneath')
  })
})

describe('spinner', () => {
  test('appends this turn’s tokens', async ($, on) => {
    const w = world(on)
    w.steps = [stepUsage(1000, 50_000, 0, 1200), stepUsage(500, 60_000, 0, 1500)]
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await step($)
    await step($)
    const ui = await $.ui.mount({
      plugin: 'meter',
      surface: 'terminal',
      component: 'Spinner',
      props: { word: 'Sauteing', message: null, suffix: '…', mode: 'responding' },
    })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('Sauteing… · 4.2k tokens')

    await complete($)
    await ui.redraw()
    expect((await ui.find({ type: 'Text' }))?.text, 'no suffix once the turn ended').toBe('Sauteing…')
  })
})
