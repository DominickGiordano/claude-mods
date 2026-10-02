import type { EngineInterface, On, RenderElement, SessionUsage, Timer } from 'claude-code'

import { cachePercent, elapsed, gauge, levelColor, requestTokens, short, sparkline, until, usd } from './format'
import type { CacheTotals } from './format'

const SPARK_REQUESTS = 16
const WIDE_COLUMNS = 100

let usage: SessionUsage | null = null
let isStale = false
let perRequest: number[] = []
const cache: CacheTotals = { read: 0, written: 0, uncached: 0 }
const turn = { isRunning: false, startedAt: 0, tokens: 0 }
let ticker: Timer | null = null

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('turn.start', async ($, e, next) => {
    turn.isRunning = true
    turn.startedAt = await $.clock.now()
    turn.tokens = 0
    ticker?.cancel()
    // The spinner's props don't change every second, so nothing redraws the elapsed time unasked.
    ticker = $.clock.every(1000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (!u) return result
    perRequest = [...perRequest, requestTokens(u)].slice(-SPARK_REQUESTS)
    cache.read += u.cache_read_input_tokens
    cache.written += u.cache_creation_input_tokens
    cache.uncached += u.input_tokens
    turn.tokens += u.input_tokens + u.output_tokens
    $.ui.invalidate('ui.render')
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      turn.isRunning = false
      ticker?.cancel()
      ticker = null
    }
    await refresh($)
    return result
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!turn.isRunning) return next(e)
    const now = await $.clock.now()
    const suffix = `${e.props.suffix} · ${elapsed(now - turn.startedAt)} · ${short(turn.tokens)} tok`
    return next({ ...e, props: { ...e.props, suffix } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !usage) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const wide = e.props.bodyColumns >= WIDE_COLUMNS
    const sep = () => Text({ dimColor: true, children: ' · ' })

    const ctx = usage.context.percent ?? 0
    const parts: RenderElement[] = [
      Text({
        color: levelColor(ctx),
        children: wide
          ? `ctx ${gauge(ctx)} ${ctx}% ${short(usage.context.tokens ?? 0)}/${short(usage.context.window)}`
          : `ctx ${ctx}%`,
      }),
    ]

    const five = usage.rateLimits.find(l => l.kind === 'five_hour')
    if (five) {
      const reset = wide && five.resetsAt ? ` ↻${until(five.resetsAt, now)}` : ''
      parts.push(sep(), Text({ color: levelColor(five.percentUsed), children: `5h ${Math.round(five.percentUsed)}%${reset}` }))
    }
    const seven = usage.rateLimits.find(l => l.kind === 'seven_day')
    if (seven && wide) parts.push(sep(), Text({ children: `7d ${Math.round(seven.percentUsed)}%` }))
    if (usage.cost) parts.push(sep(), Text({ children: usd(usage.cost.usd) }))

    const hit = cachePercent(cache)
    if (wide && hit !== null) parts.push(sep(), Text({ children: `cache ${hit}%` }))
    if (wide && perRequest.length > 0) parts.push(sep(), Text({ children: `${sparkline(perRequest)} per req` }))

    if (ctx >= 80) {
      parts.push(
        sep(),
        e.props.isWorking
          ? Text({ color: 'red', children: 'compact soon' })
          : Button({ key: 'compact', label: 'Compact', onPress: () => compact($) }),
      )
    }
    if (isStale) parts.push(sep(), Text({ color: 'yellow', children: 'usage read failed, figures stale' }))

    return Box({
      flexDirection: 'column',
      children: [Box({ flexDirection: 'row', children: parts }), await next(e)],
    })
  })
}

async function refresh($: EngineInterface) {
  try {
    usage = await $.session.usage()
    isStale = false
  } catch {
    isStale = true
  }
  $.ui.invalidate('ui.render')
}

async function compact($: EngineInterface) {
  const result = await $.session.compact().catch((err: unknown) => ({ skip: String(err) }))
  $.ui.toast(result.skip === undefined ? 'meter: compacted' : `meter: compact skipped, ${result.skip}`)
  await refresh($)
}
