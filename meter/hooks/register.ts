import type { EngineInterface, On, RenderElement, SessionRateLimit, SessionUsage } from 'claude-code'

import { bar, barRows, cachePercent, levelColor, short, totalTokens, until } from './format'
import type { CacheTotals } from './format'
import { KEEP_DAYS, addTo, dayOf, isDay, isExpired, keyOf, merge, top, total } from './ledger'
import type { Bucket, Day, Entry } from './ledger'

const MEMORY_WARN = 60
const LIMIT_WARN = 50
const BAR_CELLS = 10
const MIN_BAR_CELLS = 4
const DAY = 86_400_000
const CHART_DAYS = 14
const CHART_ROWS = 6
const TOP = 5
const RANGES = [1, 7, 30] as const

type Figures = Pick<SessionUsage, 'context' | 'rateLimits'>
type Limit = { percent: number; resetAt: number | null; isPast: boolean }

let figures: Figures | null = null
const cache: CacheTotals = { read: 0, written: 0, uncached: 0 }
const turn = { isRunning: false, tokens: 0 }
let mainTurnId = ''
const git = { turnId: '', branch: '' }
let range: (typeof RANGES)[number] = 7
let days: (Day | undefined)[] | null = null
let ledgerFailure: string | null = null
let writes: Promise<void> = Promise.resolve()

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await seed($)
    await $.command.register({ name: 'tokens', description: 'Token usage by day, repo, branch and model' })
    return result
  })

  on('command.run', { command: 'tokens' }, async ($, e) => {
    days = null
    await $.ui.open({ id: 'tokens', title: 'Tokens', focus: true, closeOnEscape: true })
    return {}
  })

  // session.start doesn't fire again after /clear or /resume, so the next turn.start re-seeds.
  on('session.end', { reason: ['clear', 'resume'] }, async ($, e, next) => {
    figures = null
    cache.read = cache.written = cache.uncached = 0
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!figures) await seed($)
    turn.isRunning = true
    turn.tokens = 0
    mainTurnId = e.turnId
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (!u) return result
    cache.read += u.cache_read_input_tokens
    cache.written += u.cache_creation_input_tokens
    cache.uncached += u.input_tokens
    turn.tokens += u.input_tokens + u.output_tokens
    $.ui.invalidate('ui.render')
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) turn.isRunning = false
    if (e.usage) await book($, { model: e.usage.model, tokens: totalTokens(e.usage) })
    return result
  })

  on('session.measure', async ($, e, next) => {
    figures = { context: e.context, rateLimits: e.rateLimits }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!turn.isRunning) return next(e)
    const suffix = `${e.props.suffix} · ${short(turn.tokens)} tokens`
    return next({ ...e, props: { ...e.props, suffix } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !figures) return next(e)
    const now = await $.clock.now()
    const memory = figures.context.percent
    const plan = limitOf(figures.rateLimits, 'five_hour', now)
    const week = limitOf(figures.rateLimits, 'seven_day', now)
    if (memory === undefined && !plan && !week) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    if ((memory ?? 0) < MEMORY_WARN && isCalm(plan) && isCalm(week)) {
      const figure = (label: string, l: Limit | null) => (l ? [`${label} ${l.isPast ? 'reset?' : `${l.percent}%`}`] : [])
      const line = [...(memory === undefined ? [] : [`memory ${memory}%`]), ...figure('plan', plan), ...figure('week', week)]
      return Box({ flexDirection: 'column', children: [Text({ dimColor: true, children: line.join(' · ') }), await next(e)] })
    }

    const cells = Math.min(BAR_CELLS, Math.max(MIN_BAR_CELLS, e.props.bodyColumns - 50))
    const dim = (text: string) => Text({ dimColor: true, children: text })
    const label = (name: string) => dim(name.padEnd(7))
    const row = (name: string, percent: number, hints: RenderElement[]) => {
      const color = levelColor(percent)
      const [fill, track] = bar(percent, cells)
      return Box({
        flexDirection: 'row',
        children: [
          label(name),
          ...(fill ? [Text({ color, children: fill })] : []),
          ...(track ? [dim(track)] : []),
          Text({ bold: true, color, children: ` ${percent}%`.padStart(5) }),
          ...hints.flatMap(h => [Text({ children: '  ' }), h]),
        ],
      })
    }
    const stale = (name: string) => Box({ flexDirection: 'row', children: [label(name), dim('reset?')] })

    const rows: RenderElement[] = []
    if (memory !== undefined) {
      const hints: RenderElement[] = []
      if (memory >= 80) {
        hints.push(Text({ color: 'red', children: '⚠ clear soon' }))
        if (!e.props.isWorking) hints.push(Button({ key: 'compact', label: 'Compact', onPress: () => compact($) }))
      } else if (memory >= MEMORY_WARN) {
        hints.push(dim('clear when you switch tasks'))
      }
      rows.push(row('memory', memory, hints))
    }
    if (plan?.isPast) rows.push(stale('plan'))
    else if (plan) {
      const hints: RenderElement[] = []
      if (plan.percent >= 90) hints.push(Text({ color: 'red', children: '⚠ near limit' }))
      if (plan.resetAt !== null) hints.push(dim(`resets ${until(plan.resetAt, now)}`))
      rows.push(row('plan', plan.percent, hints))
    }
    if (week?.isPast) rows.push(stale('week'))
    else if (week) {
      const isSoon = week.resetAt !== null && week.percent >= LIMIT_WARN
      rows.push(row('week', week.percent, isSoon ? [dim(`resets ${resetDay(week.resetAt!, now)}`)] : []))
    }

    return Box({ flexDirection: 'column', children: [...rows, await next(e)] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== 'tokens') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    days ??= await load($, now)

    const recent = days.slice(0, CHART_DAYS)
    const daily = recent.map(d => total(d?.repos ?? {})).reverse()
    const chart = recent.some(d => d)
      ? barRows(daily, CHART_ROWS).map(l => Text({ color: 'cyan', children: l }))
      : [Text({ dimColor: true, children: `No tokens recorded in the last ${CHART_DAYS} days.` })]

    const picked = merge(days.slice(0, range))
    const section = (title: string, buckets: Record<string, Bucket>) => {
      const more = Object.keys(buckets).length - TOP
      return [
        Text({ bold: true, children: title }),
        ...top(buckets, TOP).map(([name, b]) =>
          Text({ wrap: 'truncate-end', children: `  ${short(b.tokens).padStart(6)} tok  ${name}` }),
        ),
        ...(more > 0 ? [Text({ dimColor: true, children: `  +${more} more` })] : []),
      ]
    }
    const hit = cachePercent(cache)

    return Box({
      flexDirection: 'column',
      children: [
        ...(ledgerFailure ? [Text({ color: 'red', children: `ledger write failed: ${ledgerFailure}` })] : []),
        Text({ bold: true, children: `Tokens per day, last ${CHART_DAYS} days (max ${short(Math.max(...daily))})` }),
        Text({ dimColor: true, children: hit === null ? 'cache hits: no requests yet' : `cache hits ${hit}% (higher is better)` }),
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
        Text({ children: `${range}d total ${short(total(picked.repos))} tok` }),
        ...section('Repos', picked.repos),
        ...section('Branches', picked.branches),
        ...section('Models', picked.models),
      ],
    })
  })
}

function limitOf(limits: readonly SessionRateLimit[], kind: SessionRateLimit['kind'], now: number): Limit | null {
  const l = limits.find(l => l.kind === kind && Number.isFinite(l.percentUsed))
  if (!l) return null
  const resetAt = Date.parse(l.resetsAt ?? '')
  return { percent: Math.round(l.percentUsed), resetAt: Number.isFinite(resetAt) ? resetAt : null, isPast: resetAt <= now }
}

// A limit past its reset is stale, so it doesn't hold the band open.
function isCalm(l: Limit | null): boolean {
  return !l || l.isPast || l.percent < LIMIT_WARN
}

function resetDay(at: number, now: number): string {
  return at - now < DAY ? until(at, now) : new Date(at).toLocaleDateString('en-US', { weekday: 'short' })
}

async function load($: EngineInterface, now: number): Promise<(Day | undefined)[]> {
  const loaded: (Day | undefined)[] = []
  for (let back = 0; back < KEEP_DAYS; back++) {
    const stored = await $.store.get(keyOf(now, back))
    loaded.push(isDay(stored) ? stored : undefined)
  }
  return loaded
}

// Serialized because interleaved read-modify-writes in this process drop a booking. Across sessions
// $.store has no lock, so that race remains, rare and tolerated for a usage tally.
function book($: EngineInterface, part: Omit<Entry, 'repo' | 'branch'>): Promise<void> {
  writes = writes.then(() => write($, part))
  return writes
}

async function write($: EngineInterface, part: Omit<Entry, 'repo' | 'branch'>) {
  try {
    const now = await $.clock.now()
    const root = (await $.session.repo())?.root
    const repo = (root ?? (await $.session.root())).split('/').filter(Boolean).at(-1) ?? '/'
    const branch = root ? await branchOf($) : '(no git)'
    const key = keyOf(now)
    const stored = await $.store.get(key)
    await $.store.set(key, addTo(isDay(stored) ? stored : undefined, { repo, branch, ...part }))
    if (stored === undefined) {
      for (const k of await $.store.keys()) if (isExpired(k, now)) await $.store.delete(k)
    }
    ledgerFailure = null
  } catch (err) {
    ledgerFailure = String(err)
    $.ui.log(`meter: ledger write failed: ${ledgerFailure}`, { to: 'debug' })
  }
  days = null
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
  try {
    figures = await $.session.usage()
  } catch (err) {
    $.ui.log(`meter: usage read failed, waiting for the next measure: ${String(err)}`, { to: 'debug' })
  }
  $.ui.invalidate('ui.render')
}

async function compact($: EngineInterface) {
  const result = await $.session.compact().catch((err: unknown) => ({ skip: String(err) }))
  $.ui.toast(result.skip === undefined ? 'meter: compacted' : `meter: compact skipped, ${result.skip}`)
  // No measure follows a compaction until the next turn, so read the shrunken context now.
  figures = await $.session.usage()
  $.ui.invalidate('ui.render')
}
