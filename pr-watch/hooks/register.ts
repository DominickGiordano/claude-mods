import type { EngineInterface, PluginState, Register, RenderElement } from 'claude-code'
import { atom, read, update } from 'claude-code'

type Pr = PluginState['pr-watch']['prs'][number]
type Api = EngineInterface
type Config = { nudge: boolean; bases: readonly string[]; hosts: readonly string[] }

const PANE = 'pr-watch'
const MINUTE = 60_000
const DONE_TTL_MS = 10 * MINUTE
const ERROR_TTL_MS = 6 * 60 * MINUTE
// A fresh PR's checks take a moment to register; until then an empty rollup means "not yet".
const CHECKS_GRACE_MS = 3 * MINUTE
const VIEWS_AT_ONCE = 4
const FIELDS = 'number,title,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,baseRefName,headRefName,headRefOid,url'
// Heads that are promotions or release lines: merging those ships somewhere, so it stays manual.
const LONG_LIVED = /^(develop|main|master|staging|production|release.*)$/i
const FAILED = ['FAILURE', 'ERROR', 'STALE', 'ACTION_REQUIRED', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE']
// UNSTABLE means a non-required check failed or is pending; auto waits for a fully clean state.
const AUTO_STATES = ['CLEAN', 'HAS_HOOKS']

const prs = atom({ plugin: 'pr-watch', key: 'prs' }, [])

// $.state resets on /clear while the PRs stay open; `kept` mirrors every write so it can be
// put back. Not from classic.SessionStart: sec-default bypasses user mods' classic.* hooks.
let kept: Pr[] = []
let cleared = false
let working = false
let polling = false
// PRs whose nudge was submitted and hasn't settled; `nudged` is set only once it has.
const inFlight = new Set<string>()

export const register: Register = (on, options) => {
  const config: Config = {
    nudge: options.nudge !== false,
    bases: Array.isArray(options.mergeBases) ? options.mergeBases : ['develop'],
    hosts: ['github.com', ...(Array.isArray(options.hosts) ? options.hosts : [])],
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    kept = await read($, prs)
    $.clock.every(MINUTE, () => void poll($, config))
    await $.command.register({ name: 'prs', description: 'Watched PRs: open the list, add <url|owner/repo#n>, drop <n|url|owner/repo#n>', argumentHint: '[add <pr> | drop <pr>]' })
    return result
  })

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    cleared = true
    $.clock.after(1000, () => void restore($))
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
    if (result.deny !== undefined || result.isError || !/\bgh\s+pr\s+create\b/.test(String(e.command ?? ''))) return result
    const out = result.text ?? String((result.result as { stdout?: unknown } | undefined)?.stdout ?? '')
    const url = created(out, config.hosts)
    if (url) await track($, url)
    return result
  })

  on('command.run', { command: 'prs' }, async ($, e) => {
    const [verb, arg = ''] = e.args.trim().split(/\s+/)
    const list = await read($, prs)
    if (verb === 'add') {
      const url = urlOf(arg, config.hosts)
      if (url) await track($, url)
      else $.ui.toast(`pr-watch: not a PR on ${config.hosts.join(', ')}: ${arg}`)
      return {}
    }
    if (verb === 'drop') {
      const url = urlOf(arg, config.hosts)
      const matches = list.filter(pr => pr.url === url || String(pr.number) === arg.replace('#', ''))
      if (matches.length === 1) await save($, l => l.filter(pr => pr.url !== matches[0]?.url))
      else $.ui.toast(matches.length === 0 ? `pr-watch: not watching ${arg}` : `pr-watch: ${arg} is ambiguous, use owner/repo#n`)
      return {}
    }
    if (list.length === 0) {
      $.ui.toast('pr-watch: no PRs watched')
      return {}
    }
    await $.ui.open({ id: PANE, title: 'PRs', focus: true, closeOnEscape: true, rows: list.length * 3 + 1 })
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, prs)
    if (list.length === 0 || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const multi = new Set(list.map(pr => pr.repo)).size > 1
    const row: RenderElement[] = [Text({ bold: true, children: 'PRs' })]
    for (const pr of list) {
      const [text, color] = label(pr, now)
      row.push(Text({ color, dimColor: color === 'dim', children: `${nameOf(pr, multi)} ${text}` }))
      // No digit hotkeys here: a bare digit typed into an empty prompt presses a band button.
      if (canMerge(pr, config)) row.push(Button({ key: `merge:${pr.url}`, label: 'Merge', dimColor: true, onPress: () => void merge($, pr.url, config, false) }))
      if (canAuto(pr, config)) row.push(Button({ key: `auto:${pr.url}`, label: pr.auto ? 'Cancel auto' : 'When green', dimColor: true, onPress: () => void patch($, pr.url, { auto: !pr.auto, autoFailed: null }) }))
      if (pr.autoFailed) row.push(Button({ key: `dismiss:${pr.url}`, label: 'OK', dimColor: true, onPress: () => void patch($, pr.url, { autoFailed: null }) }))
    }
    const band = Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, paddingX: 1, children: row })
    return Box({ flexDirection: 'column', children: [band, await next(e)] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const list = await read($, prs)
    const multi = new Set(list.map(pr => pr.repo)).size > 1
    let hotkey = 0
    const rows = list.map(pr => {
      const [text, color] = label(pr, now)
      const head: RenderElement[] = [
        Text({ bold: true, children: nameOf(pr, multi) }),
        Text({ children: `${pr.head || '?'} → ${pr.base || '?'}` }),
        Text({ color, dimColor: color === 'dim', children: text }),
      ]
      if (canMerge(pr, config)) head.push(Button({ key: `merge:${pr.url}`, label: 'Merge', ...digit(++hotkey), onPress: () => void merge($, pr.url, config, false) }))
      if (canAuto(pr, config)) head.push(Button({ key: `auto:${pr.url}`, label: pr.auto ? 'Cancel auto' : 'Merge when green', ...digit(++hotkey), onPress: () => void patch($, pr.url, { auto: !pr.auto, autoFailed: null }) }))
      const why = blocker(pr, config)
      if (why) head.push(Text({ dimColor: true, children: why }))
      const detail = pr.error ? `gh: ${pr.error.text}` : pr.autoFailed ? `auto failed: ${pr.autoFailed}` : pr.failed.length > 0 ? `failed: ${pr.failed.join(', ')}` : pr.title
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
  // Empty state beside a non-empty mirror only follows a reset: every write updates both.
  if (!cleared || kept.length === 0 || (await read($, prs)).length > 0) return
  await $.state.set({ plugin: 'pr-watch', key: 'prs' }, kept)
}

async function save($: Api, change: (list: Pr[]) => Pr[]) {
  await restore($)
  kept = await update($, prs, change)
}

// Never writes `nudged`: callers pass whole views whose copy may be stale; the nudge owns it.
async function patch($: Api, url: string, fields: Partial<Pr>) {
  await save($, list => list.map(pr => (pr.url === url ? { ...pr, ...fields, nudged: pr.nudged } : pr)))
}

async function track($: Api, url: string) {
  const [, repo = '', number = '0'] = url.match(/\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/) ?? []
  const now = await $.clock.now()
  const fresh: Pr = { url, repo, number: Number(number), title: '', base: '', head: '', headOid: '', draft: false, state: '', mergeable: '', mergeState: '', checks: 'none', failed: [], error: null, trackedAt: now, doneAt: null, auto: false, autoFailed: null, nudged: false }
  await save($, list => (list.some(pr => pr.url === url) ? list : [...list, fresh]))
  const viewed = await view($, (await read($, prs)).find(pr => pr.url === url) ?? fresh, now)
  await save($, list => list.map(pr => (pr.url === url ? viewed : pr)))
}

async function poll($: Api, config: Config) {
  if (polling) return
  polling = true
  try {
    await restore($)
    await tick($, config)
  } finally {
    polling = false
  }
}

async function tick($: Api, config: Config) {
  const now = await $.clock.now()
  const live = (await read($, prs)).filter(pr => pr.doneAt === null || now - pr.doneAt < DONE_TTL_MS)
  const viewed: Pr[] = []
  for (let i = 0; i < live.length; i += VIEWS_AT_ONCE) {
    viewed.push(...(await Promise.all(live.slice(i, i + VIEWS_AT_ONCE).map(pr => (pr.doneAt === null ? view($, pr, now) : pr)))))
  }
  const expired = viewed.filter(pr => pr.error !== null && now - pr.error.since >= ERROR_TTL_MS).map(pr => pr.url)
  for (const pr of viewed.filter(pr => expired.includes(pr.url))) $.ui.toast(`pr-watch: stopped watching ${pr.repo}#${pr.number}, gh failing for 6h: ${pr.error?.text}`)
  const byUrl = new Map(viewed.map(pr => [pr.url, pr]))
  await save($, list => list.flatMap(pr => {
    const fresh = byUrl.get(pr.url)
    if (expired.includes(pr.url)) return []
    if (!fresh) return pr.doneAt === null ? [pr] : []
    return [{ ...fresh, auto: pr.auto, autoFailed: signature(fresh) === signature(pr) ? pr.autoFailed : null, nudged: pr.nudged || fresh.nudged }]
  }))
  for (const pr of (await read($, prs)).filter(pr => pr.auto && pr.error === null && pr.state === 'OPEN')) {
    if (pr.checks === 'fail') {
      await patch($, pr.url, { auto: false })
      $.ui.toast(`pr-watch: #${pr.number} checks failed, merge when green cancelled`)
    } else if (greenForAuto(pr)) {
      await merge($, pr.url, config, true)
    }
  }
  const merged = (await read($, prs)).filter(pr => pr.state === 'MERGED' && !pr.nudged && !inFlight.has(pr.url))
  if (config.nudge && !working && merged.length > 0) nudge($, merged)
}

// Not awaited by the poll: submit resolves when the turn starts, and a poll held on it would stall.
function nudge($: Api, merged: Pr[]) {
  const urls = merged.map(pr => pr.url)
  const names = merged.map(pr => `#${pr.number} (${clean(pr.head)} → ${clean(pr.base)})`)
  const text = names.length === 1 ? `PR ${names[0]} merged.` : `PRs merged: ${names.join(', ')}.`
  const unsent = (why: string) => {
    for (const url of urls) inFlight.delete(url)
    $.ui.log(`pr-watch: merge nudge not sent: ${why}`, { to: 'debug' })
    $.ui.toast(`pr-watch: couldn't tell Claude about the merge: ${why}`)
  }
  for (const url of urls) inFlight.add(url)
  $.prompt.submit({ text }).then(async sent => {
    if (sent.drop !== undefined) return unsent(`dropped: ${sent.drop}`)
    await save($, list => list.map(pr => (urls.includes(pr.url) ? { ...pr, nudged: true } : pr)))
    for (const url of urls) inFlight.delete(url)
  }, err => unsent(err instanceof Error ? err.message : String(err)))
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
  const rollup: { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string }[] = v.statusCheckRollup ?? []
  const failures = rollup.filter(c => FAILED.includes(c.conclusion || c.state || '')).map(c => c.name ?? c.context ?? '?')
  const pending = rollup.some(c => (c.status !== undefined && (c.status !== 'COMPLETED' || !c.conclusion)) || c.state === 'PENDING' || c.state === 'EXPECTED')
  const empty = rollup.length === 0
  const done = v.state === 'MERGED' || v.state === 'CLOSED'
  return {
    ...pr,
    title: v.title,
    base: v.baseRefName,
    head: v.headRefName,
    headOid: v.headRefOid,
    draft: v.isDraft === true,
    state: v.state,
    mergeable: v.mergeable,
    mergeState: v.mergeStateStatus,
    checks: failures.length > 0 ? 'fail' : pending || (empty && now - pr.trackedAt < CHECKS_GRACE_MS) ? 'pending' : empty ? 'none' : 'pass',
    failed: failures,
    error: null,
    doneAt: done ? (pr.doneAt ?? now) : null,
    // Already merged when first seen: nothing happened this session to tell Claude about.
    nudged: pr.nudged || (done && pr.state !== 'OPEN'),
  }
}

async function merge($: Api, url: string, config: Config, auto: boolean) {
  const seen = (await read($, prs)).find(pr => pr.url === url)
  if (!seen) return
  const pr = await view($, seen, await $.clock.now())
  await patch($, url, { ...pr, auto: false })
  const gate = auto ? (greenForAuto(pr) ? null : 'no longer green') : canMerge(pr, config) ? null : `checks ${pr.checks}`
  const why = pr.error ? `gh failed: ${pr.error.text}` : pr.state !== 'OPEN' ? `PR is ${pr.state.toLowerCase()}` : (blocker(pr, config) ?? gate)
  if (why) return mergeFailed($, pr, auto, why)
  // cwd outside any repo: run in the session's checkout, --delete-branch also switches it to the
  // base branch and deletes the local branch under the user. Run here, gh deletes the remote only.
  const argv = ['gh', 'pr', 'merge', url, '--squash', '--delete-branch', '--match-head-commit', pr.headOid]
  let run
  try {
    run = await $.process.run(argv, { cwd: '/', timeoutMs: 120_000 })
  } catch (err) {
    return mergeFailed($, pr, auto, err instanceof Error ? err.message : String(err))
  }
  if (run.exitCode !== 0) return mergeFailed($, pr, auto, run.stderr.trim() || `exit ${run.exitCode}`)
  const after = await view($, pr, await $.clock.now())
  await patch($, url, { ...after, auto: false })
  $.ui.toast(after.state === 'MERGED' ? `pr-watch: merged #${pr.number} into ${pr.base}` : `pr-watch: merge requested for #${pr.number}`)
}

async function mergeFailed($: Api, pr: Pr, auto: boolean, why: string) {
  if (auto) await patch($, pr.url, { autoFailed: why })
  $.ui.toast(`pr-watch: merge #${pr.number} failed: ${why}`, { timeoutMs: 10_000 })
}

function blocker(pr: Pr, config: Config) {
  if (pr.state !== 'OPEN' || pr.error) return null
  if (pr.draft) return 'draft'
  if (LONG_LIVED.test(pr.head)) return 'promotion: merge by hand'
  if (!config.bases.includes(pr.base)) return `base ${pr.base} not in mergeBases`
  return null
}

function mergeable(pr: Pr, config: Config) {
  return pr.state === 'OPEN' && pr.error === null && blocker(pr, config) === null
}

function canMerge(pr: Pr, config: Config) {
  return mergeable(pr, config) && (pr.checks === 'pass' || pr.checks === 'none')
}

function canAuto(pr: Pr, config: Config) {
  return mergeable(pr, config) && (pr.checks === 'pass' || pr.checks === 'pending')
}

function greenForAuto(pr: Pr) {
  return pr.checks === 'pass' && pr.mergeable === 'MERGEABLE' && AUTO_STATES.includes(pr.mergeState) && !pr.draft
}

function signature(pr: Pr) {
  return [pr.state, pr.checks, pr.mergeState, pr.headOid].join('|')
}

function label(pr: Pr, now: number): [string, string] {
  if (pr.error) return [`? gh failed ${ago(now - pr.error.since)}`, 'yellow']
  if (pr.state === '') return ['…', 'dim']
  if (pr.state === 'MERGED') return ['merged', 'dim']
  if (pr.state === 'CLOSED') return ['closed', 'dim']
  if (pr.autoFailed) return ['✗ auto failed', 'red']
  if (pr.draft) return ['draft', 'yellow']
  const auto = pr.auto ? ' · auto' : ''
  if (pr.mergeable === 'CONFLICTING') return [`✗ conflicts${auto}`, 'red']
  if (pr.checks === 'fail') return [`✗ CI failed${auto}`, 'red']
  if (pr.checks === 'pending') return [`● CI running${auto}`, 'yellow']
  const ci = pr.checks === 'pass' ? '✓ CI' : 'no CI'
  if (pr.checks === 'pass' && pr.mergeable === 'MERGEABLE' && AUTO_STATES.includes(pr.mergeState)) return [`${ci} · mergeable${auto}`, 'green']
  return [`${ci} · ● ${(pr.mergeState || pr.mergeable).toLowerCase()}${auto}`, 'yellow']
}

function nameOf(pr: Pr, multi: boolean) {
  return multi ? `${pr.repo}#${pr.number}` : `#${pr.number}`
}

function ago(ms: number) {
  const minutes = Math.floor(ms / MINUTE)
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`
}

function digit(n: number) {
  return n <= 9 ? { hotkey: String(n) } : {}
}

function clean(branch: string) {
  return branch.replace(/[^\w./-]/g, '')
}

// A line that is exactly a PR URL (what gh pr create prints), or gh's "already exists:" line.
function created(out: string, hosts: readonly string[]) {
  for (const m of out.matchAll(/^(?:.*already exists:\s*)?(https?:\/\/([^\s/]+)\/[^\s/]+\/[^\s/]+\/pull\/\d+)\s*$/gm)) {
    if (hosts.includes(m[2] ?? '')) return m[1]
  }
  return undefined
}

function urlOf(arg: string, hosts: readonly string[]) {
  const url = created(arg, hosts)
  if (url) return url
  const short = arg.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/)
  return short ? `https://github.com/${short[1]}/${short[2]}/pull/${short[3]}` : undefined
}
