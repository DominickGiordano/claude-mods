import type { EngineInterface, On, RenderElement, SessionUsage, Timer, TurnUsage } from 'claude-code'

import { cachePercent, elapsed, gauge, levelColor, requestTokens, short, sparkline, until, usd } from './format'
import type { CacheTotals } from './format'
import { barRows, rasterCells } from './chart'
import { KEEP_DAYS, addTo, dayOf, isExpired, keyOf, merge, top, total } from './ledger'
import type { Bucket, Day } from './ledger'

const SPARK_REQUESTS = 16
const WIDE_COLUMNS = 100
const CHART_DAYS = 14
const CHART_ROWS = 6
const CHART_COLOR = 0x5fafd7
const RANGES = [1, 7, 30] as const

let usage: SessionUsage | null = null
let isStale = false
let perRequest: number[] = []
const cache: CacheTotals = { read: 0, written: 0, uncached: 0 }
const turn = { isRunning: false, startedAt: 0, tokens: 0 }
let ticker: Timer | null = null
let mainTurnId = ''
let lastUsd = 0
const git = { turnId: '', branch: '' }
let range: (typeof RANGES)[number] = 7

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await seed($)
    await $.command.register({ name: 'spend', description: 'Token spend by day, repo, branch and model' })
    return result
  })

  on('command.run', { command: 'spend' }, async ($, e) => {
    await $.ui.open({ id: 'spend', title: 'Spend', focus: true, closeOnEscape: true })
    return {}
  })

  // session.start doesn't fire again after /clear or /resume, so the next turn.start re-seeds.
  on('session.end', { reason: ['clear', 'resume'] }, async ($, e, next) => {
    usage = null
    perRequest = []
    cache.read = cache.written = cache.uncached = 0
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!usage) await seed($)
    turn.isRunning = true
    mainTurnId = e.turnId
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
    if (e.usage) await record($, e.usage)
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

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== 'spend') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const days: (Day | undefined)[] = []
    for (let back = 0; back < KEEP_DAYS; back++) days.push((await $.store.get(keyOf(now, back))) as Day | undefined)

    const daily = days.slice(0, CHART_DAYS).map(d => total(d?.repos ?? {}).usd).reverse()
    const lines = barRows(daily, CHART_ROWS)
    let chart = lines.map(l => Text({ color: 'cyan', children: l }))
    if (Math.max(...daily) === 0) chart = [Text({ dimColor: true, children: `No spend recorded in the last ${CHART_DAYS} days.` })]
    else if (e.surface === 'terminal') {
      // Raster is terminal-only; elsewhere the same glyph rows go out as Text.
      const { Raster } = $.ui.resolve(e)
      chart = [Raster({ key: 'chart', columns: lines[0]!.length, rows: CHART_ROWS, cells: rasterCells(lines, CHART_COLOR) })]
    }

    const picked = merge(days.slice(0, range))
    const sum = total(picked.repos)
    const section = (title: string, buckets: Record<string, Bucket>) => [
      Text({ bold: true, children: title }),
      ...top(buckets).map(([name, b]) =>
        Text({ wrap: 'truncate-end', children: `  ${usd(b.usd).padStart(8)}  ${short(b.tokens).padStart(6)} tok  ${name}` }),
      ),
    ]
    const hit = cachePercent(cache)

    return Box({
      flexDirection: 'column',
      children: [
        Text({ bold: true, children: `Cost per day, last ${CHART_DAYS} days (max ${usd(Math.max(...daily))})` }),
        ...chart,
        Text({ dimColor: true, children: `${dayOf(now, CHART_DAYS - 1).slice(5)} … ${dayOf(now).slice(5)}` }),
        Box({
          flexDirection: 'row',
          gap: 1,
          children: RANGES.map(n =>
            Button({
              key: `${n}d`,
              label: `${n}d`,
              ...(n === range && { variant: 'primary' as const }),
              onPress: () => {
                range = n
                $.ui.invalidate('ui.render')
              },
            }),
          ),
        }),
        Text({ children: `${range}d total ${usd(sum.usd)} · ${short(sum.tokens)} tok` }),
        ...section('Repos', picked.repos),
        ...section('Branches', picked.branches),
        ...section('Models', picked.models),
        Text({ dimColor: true, children: `This session's cache hits: ${hit === null ? 'no requests yet' : `${hit}%`}` }),
      ],
    })
  })
}

async function record($: EngineInterface, u: TurnUsage) {
  const now = await $.clock.now()
  // Cost is only reported as a session total, so a turn books the growth since the last booking.
  // Subagents finishing together can swap shares; the day's total stays right.
  const usdNow = usage?.cost?.usd ?? lastUsd
  const spent = usdNow >= lastUsd ? usdNow - lastUsd : usdNow
  lastUsd = usdNow

  const root = (await $.session.repo())?.root
  const repo = (root ?? (await $.session.root())).split('/').filter(Boolean).at(-1) ?? '/'
  const branch = root ? await branchOf($) : '(no git)'

  const key = keyOf(now)
  // Read-modify-write without a lock: two sessions finishing a turn in the same instant can drop one
  // of the two turns. A rare undercount in a spend estimate costs less than anything $.store could lock with.
  const stored = (await $.store.get(key)) as Day | undefined
  await $.store.set(key, addTo(stored, { repo, branch, model: u.model, usd: spent, tokens: requestTokens(u) }))
  if (!stored) {
    for (const k of await $.store.keys()) if (isExpired(k, now)) await $.store.delete(k)
  }
  $.ui.invalidate('ui.render')
}

// Runs in the session's cwd, not repo.root: for a worktree that root is the main checkout, on another branch.
async function branchOf($: EngineInterface): Promise<string> {
  if (git.turnId === mainTurnId && git.branch) return git.branch
  const run = await $.process.run(['git', 'branch', '--show-current']).catch(() => null)
  git.turnId = mainTurnId
  git.branch = !run || run.exitCode !== 0 ? '(git failed)' : run.stdout.trim() || '(detached)'
  return git.branch
}

async function seed($: EngineInterface) {
  await refresh($)
  lastUsd = usage?.cost?.usd ?? 0
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
