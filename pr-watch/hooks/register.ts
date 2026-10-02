import type { EngineInterface, PluginState, Register, RenderElement } from 'claude-code'
import { atom, read, update } from 'claude-code'

type Pr = PluginState['pr-watch']['prs'][number]
type Api = EngineInterface

const PANE = 'pr-watch'
const POLL_MS = 60_000
const DONE_TTL_MS = 10 * 60_000
const FIELDS = 'number,title,state,mergedAt,mergeable,mergeStateStatus,statusCheckRollup,baseRefName,headRefName,url'
const PR_URL = /https?:\/\/[^\s/"']+\/[^\s/"']+\/[^\s/"']+\/pull\/\d+/
// A merge into the release branch ships to production, so it stays manual.
const PROMOTION_BASES = ['main', 'master']
const LONG_LIVED = ['develop', 'main', 'master']
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

const prs = atom({ plugin: 'pr-watch', key: 'prs' }, [])

// $.state resets on /clear while the PRs stay open; this copy re-seeds it. Not from
// classic.SessionStart: sec-default bypasses user mods' classic.* hooks.
let kept: Pr[] = []
let cleared = false
let working = false

export const register: Register = (on, options) => {
  const nudge = options.nudge !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    kept = await read($, prs)
    $.clock.every(POLL_MS, () => void poll($, nudge))
    await $.command.register({ name: 'prs', description: 'Watched PRs: open the list, add <url|owner/repo#n>, drop <n>', argumentHint: '[add <pr> | drop <n>]' })
    return result
  })

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    cleared = true
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    working = true
    await restore($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) working = false
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (!/\bgh\s+pr\s+create\b/.test(String(e.command ?? ''))) return result
    const url = (result.text ?? JSON.stringify(result.result ?? '')).match(PR_URL)?.[0]
    if (url) await track($, url)
    return result
  })

  on('command.run', { command: 'prs' }, async ($, e) => {
    const [verb, arg = ''] = e.args.trim().split(/\s+/)
    if (verb === 'add') {
      const url = urlOf(arg)
      if (url) await track($, url)
      else $.ui.toast(`pr-watch: not a PR: ${arg}`)
      return {}
    }
    if (verb === 'drop') {
      await save($, list => list.filter(pr => String(pr.number) !== arg.replace('#', '')))
      return {}
    }
    const count = (await read($, prs)).length
    if (count === 0) {
      $.ui.toast('pr-watch: no PRs watched')
      return {}
    }
    await $.ui.open({ id: PANE, title: 'PRs', focus: true, closeOnEscape: true, rows: count * 3 + 1 })
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, prs)
    if (list.length === 0 || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const row: RenderElement[] = [Text({ bold: true, children: 'PRs' })]
    for (const pr of list) {
      const [text, color] = label(pr, now)
      row.push(Text({ color, dimColor: color === 'dim', children: `#${pr.number} ${text}` }))
      if (!canMerge(pr)) continue
      // No digit hotkeys here: a bare digit typed into an empty prompt presses a band button.
      row.push(Button({ key: `merge-${pr.number}`, label: 'Merge', dimColor: true, onPress: () => void merge($, pr) }))
      row.push(Button({ key: `auto-${pr.number}`, label: pr.auto ? 'Cancel auto' : 'When green', dimColor: true, onPress: () => void toggleAuto($, pr) }))
    }
    const band = Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, paddingX: 1, children: row })
    return Box({ flexDirection: 'column', children: [band, await next(e)] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    let hotkey = 0
    const rows = (await read($, prs)).map(pr => {
      const [text, color] = label(pr, now)
      const head: RenderElement[] = [
        Text({ bold: true, children: `#${pr.number}` }),
        Text({ children: `${pr.head || '?'} → ${pr.base || '?'}` }),
        Text({ color, dimColor: color === 'dim', children: text }),
      ]
      if (canMerge(pr)) {
        head.push(Button({ key: `merge-${pr.number}`, label: 'Merge', ...digit(++hotkey), onPress: () => void merge($, pr) }))
        head.push(Button({ key: `auto-${pr.number}`, label: pr.auto ? 'Cancel auto' : 'Merge when green', ...digit(++hotkey), onPress: () => void toggleAuto($, pr) }))
      } else if (pr.state === 'OPEN' && PROMOTION_BASES.includes(pr.base)) {
        head.push(Text({ dimColor: true, children: 'promotion: merge by hand' }))
      }
      const detail = pr.error ? `gh: ${pr.error.text}` : pr.failed.length > 0 ? `failed: ${pr.failed.join(', ')}` : pr.title
      return Box({ key: pr.url, flexDirection: 'column', children: [
        Box({ flexDirection: 'row', columnGap: 2, children: head }),
        Text({ dimColor: true, children: `  ${detail}` }),
        Text({ dimColor: true, children: `  ${pr.url}` }),
      ] })
    })
    return Box({ flexDirection: 'column', children: rows.length > 0 ? rows : [Text({ dimColor: true, children: 'No PRs watched.' })] })
  })
}

async function restore($: Api) {
  if (!cleared) return
  cleared = false
  await $.state.set({ plugin: 'pr-watch', key: 'prs' }, kept)
}

async function save($: Api, change: (list: Pr[]) => Pr[]) {
  await restore($)
  kept = await update($, prs, change)
}

async function track($: Api, url: string) {
  const number = Number(url.split('/').pop())
  const fresh: Pr = { url, number, title: '', base: '', head: '', state: '', mergeable: '', mergeState: '', checks: 'none', failed: [], error: null, doneAt: null, auto: false, nudged: false }
  await save($, list => (list.some(pr => pr.url === url) ? list : [...list, fresh]))
  const viewed = await view($, fresh, await $.clock.now())
  await save($, list => list.map(pr => (pr.url === url ? viewed : pr)))
}

async function poll($: Api, nudge: boolean) {
  await restore($)
  const now = await $.clock.now()
  const live = (await read($, prs)).filter(pr => pr.doneAt === null || now - pr.doneAt < DONE_TTL_MS)
  const viewed = await Promise.all(live.map(pr => (pr.doneAt === null ? view($, pr, now) : pr)))
  const byUrl = new Map(viewed.map(pr => [pr.url, pr]))
  const merged = viewed.filter(pr => pr.state === 'MERGED' && !pr.nudged)
  const sending = nudge && !working && merged.length > 0
  await save($, list => list.flatMap(pr => {
    const fresh = byUrl.get(pr.url)
    if (!fresh) return pr.doneAt === null ? [pr] : []
    return [{ ...fresh, auto: pr.auto, nudged: fresh.nudged || (sending && fresh.state === 'MERGED') }]
  }))
  if (sending) {
    const names = merged.map(pr => `#${pr.number} (${pr.head} → ${pr.base})`)
    void $.prompt.submit({ text: names.length === 1 ? `PR ${names[0]} merged.` : `PRs merged: ${names.join(', ')}.` })
  }
  for (const pr of (await read($, prs)).filter(pr => pr.auto && pr.error === null && pr.state === 'OPEN')) {
    if (pr.checks === 'fail') {
      await save($, list => list.map(p => (p.url === pr.url ? { ...p, auto: false } : p)))
      $.ui.toast(`pr-watch: #${pr.number} checks failed, merge when green cancelled`)
    } else if (pr.checks !== 'pending' && pr.mergeable === 'MERGEABLE') {
      await merge($, pr)
    }
  }
}

async function view($: Api, pr: Pr, now: number): Promise<Pr> {
  const failed = (text: string): Pr => ({ ...pr, error: { since: pr.error?.since ?? now, text } })
  let v
  try {
    const run = await $.process.run(['gh', 'pr', 'view', pr.url, '--json', FIELDS])
    if (run.exitCode !== 0) return failed(run.stderr.trim().split('\n')[0] || `exit ${run.exitCode}`)
    v = JSON.parse(run.stdout)
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err))
  }
  const rollup: { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[] = v.statusCheckRollup ?? []
  const failures = rollup.filter(c => FAILED.includes(c.conclusion || c.state || '')).map(c => c.name ?? c.context ?? '?')
  const pending = rollup.some(c => (c.status !== undefined && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED')
  const done = v.state === 'MERGED' || v.state === 'CLOSED'
  return {
    ...pr,
    title: v.title,
    base: v.baseRefName,
    head: v.headRefName,
    state: v.state,
    mergeable: v.mergeable,
    mergeState: v.mergeStateStatus,
    checks: failures.length > 0 ? 'fail' : pending ? 'pending' : rollup.length > 0 ? 'pass' : 'none',
    failed: failures,
    error: null,
    doneAt: done ? (pr.doneAt ?? now) : null,
    // Already merged when first seen: nothing happened this session to tell Claude about.
    nudged: pr.nudged || (done && pr.state !== 'OPEN'),
  }
}

async function merge($: Api, pr: Pr) {
  if (PROMOTION_BASES.includes(pr.base)) {
    $.ui.toast(`pr-watch: #${pr.number} targets ${pr.base}. Promotion: merge by hand`)
    return
  }
  const argv = ['gh', 'pr', 'merge', pr.url, '--squash']
  if (!LONG_LIVED.includes(pr.head)) argv.push('--delete-branch')
  await save($, list => list.map(p => (p.url === pr.url ? { ...p, auto: false } : p)))
  let run
  try {
    run = await $.process.run(argv, { timeoutMs: 120_000 })
  } catch (err) {
    $.ui.toast(`pr-watch: merge #${pr.number} failed: ${err instanceof Error ? err.message : String(err)}`, { timeoutMs: 10_000 })
    return
  }
  if (run.exitCode !== 0) {
    $.ui.toast(`pr-watch: merge #${pr.number} failed: ${run.stderr.trim() || `exit ${run.exitCode}`}`, { timeoutMs: 10_000 })
    return
  }
  $.ui.toast(`pr-watch: merged #${pr.number} into ${pr.base}`)
  const viewed = await view($, pr, await $.clock.now())
  await save($, list => list.map(p => (p.url === pr.url ? { ...viewed, auto: false } : p)))
}

async function toggleAuto($: Api, pr: Pr) {
  await save($, list => list.map(p => (p.url === pr.url ? { ...p, auto: !p.auto } : p)))
}

function canMerge(pr: Pr) {
  return pr.state === 'OPEN' && pr.error === null && !PROMOTION_BASES.includes(pr.base)
}

function label(pr: Pr, now: number): [string, string] {
  if (pr.error) return [`? gh failed ${ago(now - pr.error.since)}`, 'yellow']
  if (pr.state === '') return ['…', 'dim']
  if (pr.state === 'MERGED') return ['merged', 'dim']
  if (pr.state === 'CLOSED') return ['closed', 'dim']
  const auto = pr.auto ? ' · auto' : ''
  if (pr.mergeable === 'CONFLICTING') return [`✗ conflicts${auto}`, 'red']
  if (pr.checks === 'fail') return [`✗ CI failed${auto}`, 'red']
  if (pr.checks === 'pending') return [`● CI running${auto}`, 'yellow']
  const ci = pr.checks === 'pass' ? '✓ CI · ' : '✓ '
  if (pr.mergeable === 'MERGEABLE' && pr.mergeState !== 'BLOCKED') return [`${ci}mergeable${auto}`, 'green']
  return [`${ci}${(pr.mergeState || pr.mergeable).toLowerCase()}${auto}`, 'yellow']
}

function ago(ms: number) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`
}

function digit(n: number) {
  return n <= 9 ? { hotkey: String(n) } : {}
}

function urlOf(arg: string) {
  const url = arg.match(PR_URL)?.[0]
  if (url) return url
  const short = arg.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/)
  return short ? `https://github.com/${short[1]}/${short[2]}/pull/${short[3]}` : undefined
}
