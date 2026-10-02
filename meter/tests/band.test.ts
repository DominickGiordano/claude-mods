import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BAND, complete, start, step, stepUsage, usageAt, world } from './world'

async function band($: Engine, props = BAND) {
  const ui = await $.ui.mount({ plugin: 'meter', surface: 'terminal', component: 'AbovePrompt', props })
  const texts = await ui.findAll({ type: 'Text' })
  return { ui, row: texts.map(t => t.text).join(''), texts }
}

describe('band', () => {
  test('wide row shows every figure, cache hits and the per-request sparkline', async ($, on) => {
    const w = world(on)
    w.steps = [stepUsage(100, 0, 900, 50), stepUsage(50, 9000, 0, 400)]
    await start($)
    await step($)
    await step($)
    const { row } = await band($)
    expect(row).toBe('ctx ▇▇▇▁▁ 61% 122k/200k · 5h 55% ↻1h12m · 7d 26% · $3.41 · cache 90% · ▁█ per req' + 'beneath')
  })

  test('narrow row keeps context, 5h and cost', async ($, on) => {
    world(on)
    await start($)
    const { row } = await band($, { ...BAND, bodyColumns: 80 })
    expect(row).toBe('ctx 61% · 5h 55% · $3.41beneath')
  })

  test('context and 5h figures turn yellow at 50% and red at 80%', async ($, on) => {
    const w = world(on)
    await start($)
    const colorAt = async (percent: number) => {
      w.usage = usageAt(percent)
      await complete($)
      const { texts } = await band($)
      return texts[0]?.props.color
    }
    expect(await colorAt(49)).toBe('green')
    expect(await colorAt(50)).toBe('yellow')
    expect(await colorAt(79)).toBe('yellow')
    expect(await colorAt(80)).toBe('red')
    const { texts } = await band($)
    expect(texts.find(t => t.text.startsWith('5h'))?.props.color).toBe('yellow')
  })

  test('at 80% an idle band offers Compact, a working one says compact soon', async ($, on) => {
    const w = world(on)
    w.usage = usageAt(85)
    await start($)
    const idle = await band($)
    await idle.ui.press({ key: 'compact' })
    expect(w.compacts).toBe(1)
    expect(w.toasts).toEqual(['meter: compact skipped, stubbed'])

    const busy = await band($, { ...BAND, isWorking: true })
    expect(busy.row).toContain('compact soon')
    expect(await busy.ui.find({ type: 'Button' })).toBeUndefined()
  })

  test('below 80% there is no compact control', async ($, on) => {
    world(on)
    await start($)
    const { ui, row } = await band($)
    expect(row).not.toContain('compact')
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
  })

  test('a failed usage read marks the figures stale', async ($, on) => {
    const w = world(on)
    await start($)
    w.usage = null
    await complete($)
    const { row } = await band($)
    expect(row).toContain('ctx ▇▇▇▁▁ 61%')
    expect(row).toContain('usage read failed, figures stale')
  })

  test('passes through untouched before any reading and under a survey', async ($, on) => {
    const w = world(on)
    w.usage = null
    await start($)
    expect((await band($)).row).toBe('beneath')
    w.usage = usageAt(61)
    await complete($)
    expect((await band($, { ...BAND, hasSurvey: true })).row).toBe('beneath')
  })
})

describe('spinner', () => {
  test('appends elapsed time and this turn’s input+output tokens', async ($, on) => {
    const w = world(on)
    w.steps = [stepUsage(1000, 50_000, 0, 1200), stepUsage(500, 60_000, 0, 1500)]
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await step($)
    await step($)
    await w.clock.advance(12_400)
    const ui = await $.ui.mount({
      plugin: 'meter',
      surface: 'terminal',
      component: 'Spinner',
      props: { word: 'Sauteing', message: null, suffix: '…', mode: 'responding' },
    })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('Sauteing… · 12s · 4.2k tok')

    await complete($)
    await ui.redraw()
    expect((await ui.find({ type: 'Text' }))?.text, 'no suffix once the turn ended').toBe('Sauteing…')
  })
})
