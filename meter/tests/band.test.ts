import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BAND, HOUR, complete, measure, start, step, stepUsage, usageAt, world } from './world'

async function band($: Engine, props = BAND) {
  const ui = await $.ui.mount({ plugin: 'meter', surface: 'terminal', component: 'AbovePrompt', props })
  const texts = await ui.findAll({ type: 'Text' })
  return { ui, row: texts.map(t => t.text).join(''), texts }
}

describe('band', () => {
  test('wide row shows every figure, cache hits and the per-request sparkline, never cost', async ($, on) => {
    const w = world(on)
    w.usage = { ...usageAt(61), cost: { usd: 70 } }
    w.steps = [stepUsage(100, 0, 900, 50), stepUsage(50, 9000, 0, 400)]
    await start($)
    await step($)
    await step($)
    const { row } = await band($)
    expect(row).toBe('ctx ▇▇▇▁▁ 61% 122k/200k · 5h 55% ↻1h12m · 7d 26% · cache 90% · ▁█ tok/req' + 'beneath')
  })

  test('narrow row keeps context and 5h', async ($, on) => {
    world(on)
    await start($)
    const { row } = await band($, { ...BAND, bodyColumns: 80 })
    expect(row).toBe('ctx 61% · 5h 55%beneath')
  })

  test('narrow row keeps 7d once it reaches 80%, colored like 5h', async ($, on) => {
    world(on)
    await start($)
    const u = usageAt(61)
    await measure($, { ...u, rateLimits: [u.rateLimits[0]!, { ...u.rateLimits[1]!, percentUsed: 84 }] })
    const { row, texts } = await band($, { ...BAND, bodyColumns: 80 })
    expect(row).toBe('ctx 61% · 5h 55% · 7d 84%beneath')
    expect(texts.find(t => t.text.startsWith('7d'))?.props.color).toBe('red')
  })

  test('measure pushes new figures; context and 5h turn yellow at 50% and red at 80%', async ($, on) => {
    world(on)
    await start($)
    const colorAt = async (percent: number) => {
      await measure($, usageAt(percent))
      return (await band($)).texts[0]?.props.color
    }
    expect(await colorAt(49)).toBe('green')
    expect(await colorAt(50)).toBe('yellow')
    expect(await colorAt(79)).toBe('yellow')
    expect(await colorAt(80)).toBe('red')
    const { texts } = await band($)
    expect(texts.find(t => t.text.startsWith('5h'))?.props.color).toBe('yellow')
  })

  test('at 80% an idle band offers Compact, a working one says ctx high', async ($, on) => {
    const w = world(on)
    w.usage = usageAt(85)
    await start($)
    const idle = await band($)
    w.usage = usageAt(20)
    await idle.ui.press({ key: 'compact' })
    expect(w.compacts).toBe(1)
    expect(w.toasts).toEqual(['meter: compact skipped, stubbed'])
    expect((await band($)).row, 'context re-read after compacting').toContain('ctx ▇▁▁▁▁ 20%')

    await measure($, usageAt(85))
    const busy = await band($, { ...BAND, isWorking: true })
    expect(busy.row).toContain('ctx high')
    expect(await busy.ui.find({ type: 'Button' })).toBeUndefined()
  })

  test('below 80% there is no compact control', async ($, on) => {
    world(on)
    await start($)
    const { ui, row } = await band($)
    expect(row).not.toContain('ctx high')
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
  })

  test('a window past its reset time says reset? instead of a stale percent', async ($, on) => {
    const w = world(on)
    await start($)
    await w.clock.advance(2 * HOUR)
    const { row } = await band($)
    expect(row).toContain('5h reset?')
    expect(row).not.toContain('55%')
  })

  test('no rate limits and no context percent: no limit figures, ctx – rather than 0%', async ($, on) => {
    world(on)
    await start($)
    const u = usageAt(61)
    await measure($, { ...u, context: { window: 200_000 }, rateLimits: [] })
    const { row, ui } = await band($)
    expect(row).toBe('ctx –beneath')
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
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
  test('appends this turn’s input+output tokens, labelled apart from the engine’s count', async ($, on) => {
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
    expect((await ui.find({ type: 'Text' }))?.text).toBe('Sauteing… · 4.2k in+out')

    await complete($)
    await ui.redraw()
    expect((await ui.find({ type: 'Text' }))?.text, 'no suffix once the turn ended').toBe('Sauteing…')
  })
})
