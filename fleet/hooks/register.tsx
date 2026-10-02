import type { EngineInterface, On, Timer } from 'claude-code'

export type State = 'waiting' | 'working' | 'idle'

export type Entry = {
  id: string
  name: string
  repo: string
  checkout: string
  branch: string
  isWorktree: boolean
  state: State
  since: number
  contextPercent: number | null
  lastPrompt: string
  updatedAt: number
}

type Place = Pick<Entry, 'repo' | 'checkout' | 'branch' | 'isWorktree'>

type Self = {
  isHeadless: boolean
  place?: Place
  isTurn: boolean
  asks: Set<string>
  lastPrompt: string
  mark?: { state: State; since: number }
  ended: Set<string>
  peers: Entry[]
  bad: number
  isUnreadable: boolean
  goodAt: number
  target?: Entry
  timers: Timer[]
  tickAt: number
}

export const PREFIX = 'fleet:'
export const BEAT_MS = 15_000
export const REFRESH_MS = 5_000
export const LIVE_MS = 60_000
export const PRUNE_MS = 600_000
const PANE = 'fleet'
const ORDER: readonly State[] = ['waiting', 'working', 'idle']
const COLOR: Record<State, string> = { waiting: 'yellow', working: 'green', idle: 'gray' }

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path
// Entries come from other processes; a stray escape would repaint the terminal.
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
const isStale = (age: number) => age < 0 || age > 2 * BEAT_MS

export function ageOf(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    ['id', 'name', 'repo', 'checkout', 'branch', 'lastPrompt'].every(k => typeof e[k] === 'string') &&
    ORDER.includes(e.state as State) &&
    Number.isFinite(e.updatedAt) &&
    Number.isFinite(e.since) &&
    typeof e.isWorktree === 'boolean' &&
    (e.contextPercent === null || Number.isFinite(e.contextPercent))
  )
}

// Exact beats prefix; two sessions on one branch stay ambiguous rather than guess.
export function pick(peers: readonly Entry[], query: string) {
  const exact = peers.filter(p => p.name === query || p.id === query)
  if (exact.length > 0) return exact
  return peers.filter(p => p.id.startsWith(query) || p.name.startsWith(query))
}

async function placeOf($: EngineInterface, cwd: string): Promise<Place> {
  const dirs = await $.process.run(
    ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
    { cwd },
  )
  if (dirs.exitCode !== 0) return { repo: basename(cwd), checkout: cwd, branch: '', isWorktree: false }
  const [checkout = cwd, gitDir = '', commonDir = ''] = dirs.stdout.trim().split('\n')
  const branch = await $.process.run(['git', 'branch', '--show-current'], { cwd })
  return {
    // The common dir names the main checkout, so a worktree reports its repo, not its folder.
    repo: basename(commonDir.replace(/\/?\.git$/, '')),
    checkout,
    branch: branch.stdout.trim(),
    isWorktree: gitDir !== commonDir,
  }
}

async function beat($: EngineInterface, self: Self) {
  const id = await $.session.id()
  // A beat queued before session.end would bring the deleted key back.
  if (self.isHeadless || self.ended.has(id)) return
  self.place ??= await placeOf($, await $.session.cwd())
  const { context } = await $.session.usage()
  const now = await $.clock.now()
  arm($, self, now)
  const state: State = self.asks.size > 0 ? 'waiting' : self.isTurn ? 'working' : 'idle'
  if (self.mark?.state !== state) self.mark = { state, since: now }
  const { repo, branch } = self.place
  const entry: Entry = {
    id,
    name: branch ? `${repo}:${branch}` : repo,
    ...self.place,
    state,
    since: self.mark.since,
    contextPercent: context.percent ?? null,
    lastPrompt: self.lastPrompt,
    updatedAt: now,
  }
  await $.store.set(PREFIX + id, entry)
}

function pulse($: EngineInterface, self: Self) {
  beat($, self).catch(err => $.ui.log(`fleet: heartbeat failed: ${err}`, { to: 'debug' }))
}

// clock.every ends quietly when a hook refuses a period, so a refresh gone silent means re-arm.
function arm($: EngineInterface, self: Self, now: number) {
  if (self.isHeadless || (self.timers.length > 0 && now - self.tickAt < 3 * REFRESH_MS)) return
  if (self.timers.length > 0) $.ui.log('fleet: timers went silent, re-armed', { to: 'debug' })
  for (const timer of self.timers) timer.cancel()
  self.tickAt = now
  self.timers = [
    $.clock.every(BEAT_MS, () => pulse($, self)),
    $.clock.every(REFRESH_MS, () => {
      refresh($, self).catch(err => $.ui.log(`fleet: refresh failed: ${err}`, { to: 'debug' }))
    }),
  ]
}

// Throws only when the key list itself is unreadable; a bad entry is skipped and counted.
export async function load($: EngineInterface) {
  const now = await $.clock.now()
  const live: Entry[] = []
  let bad = 0
  for (const key of await $.store.keys()) {
    if (!key.startsWith(PREFIX)) continue
    const entry = await $.store.get(key).catch(() => null)
    if (entry === undefined) continue
    if (!isEntry(entry)) {
      bad += 1
      continue
    }
    const age = now - entry.updatedAt
    if (age > PRUNE_MS) await $.store.delete(key).catch(err => $.ui.log(`fleet: prune failed: ${err}`, { to: 'debug' }))
    else if (age <= LIVE_MS) live.push(entry)
  }
  return { live, bad }
}

async function refresh($: EngineInterface, self: Self) {
  self.tickAt = await $.clock.now()
  const before = JSON.stringify([self.peers, self.bad, self.isUnreadable])
  try {
    const { live, bad } = await load($)
    Object.assign(self, { peers: live, bad, isUnreadable: false, goodAt: await $.clock.now() })
  } catch (err) {
    if (!self.isUnreadable) $.ui.log(`fleet: store unreadable: ${err}`, { to: 'debug' })
    self.isUnreadable = true
  }
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen || JSON.stringify([self.peers, self.bad, self.isUnreadable]) !== before) $.ui.invalidate('ui.render')
}

async function sendTo($: EngineInterface, to: Entry, text: string) {
  try {
    const sent = await $.session.send({ to: { sessionId: to.id }, text })
    $.ui.toast(sent.isDelivered ? `fleet: queued for ${to.name}` : `fleet: send to ${to.name} failed: ${sent.reason}`)
  } catch (err) {
    $.ui.toast(`fleet: send to ${to.name} failed: ${err}`)
  }
}

export function register(on: On) {
  const self: Self = {
    isHeadless: false, isTurn: false, asks: new Set(), lastPrompt: '', ended: new Set(),
    peers: [], bad: 0, isUnreadable: false, goodAt: 0, timers: [], tickAt: 0,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fleet', description: 'List live Claude Code sessions', immediate: true })
    const argumentHint = '<session name or id prefix> <text>'
    await $.command.register({ name: 'send', description: 'Message another live session', argumentHint, immediate: true })
    self.isHeadless = !e.isInteractive
    arm($, self, await $.clock.now())
    pulse($, self)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    self.ended.add(e.sessionId)
    await $.store.delete(PREFIX + e.sessionId)
    if (e.reason === 'clear') {
      Object.assign(self, { lastPrompt: '', asks: new Set(), isTurn: false, mark: undefined })
      // The new id is in place once the end step returns.
      $.clock.after(0, () => pulse($, self))
    }
    return next(e)
  })

  // A peer's /send also starts a turn; its envelope is not what the person last asked.
  on('prompt.submit', ($, e, next) => {
    const isPerson = ['composer', 'bridge', 'sdk'].includes(e.origin.kind)
    if (isPerson && e.text.trim()) self.lastPrompt = clean(e.text).replace(/\s+/g, ' ').trim().slice(0, 80)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    self.isTurn = true
    self.place = undefined
    pulse($, self)
    return started
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    self.isTurn = false
    pulse($, self)
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id) {
      self.asks.add(e.tool_use_id)
      pulse($, self)
    }
    return verdict
  })

  // The pill only draws once an approved tool runs, so a long Bash stops reading as waiting.
  on('ui.render', { component: 'ToolProgress' }, ($, e, next) => {
    if (self.asks.delete(e.props.tool_use_id)) pulse($, self)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion') {
      self.asks.add(e.tool_use_id)
      pulse($, self)
    }
    try {
      return await next(e)
    } finally {
      if (self.asks.delete(e.tool_use_id)) pulse($, self)
    }
  })

  on('command.run', { command: 'fleet' }, async $ => {
    await refresh($, self)
    await $.ui.open({ id: PANE, title: 'Fleet' })
    return {}
  })

  on('command.run', { command: 'send' }, async ($, e) => {
    const [, query, text] = /^(\S+)\s+([\s\S]+)$/.exec(e.args.trim()) ?? []
    if (!query || !text) {
      $.ui.toast('fleet: usage /send <session name or id prefix> <text>')
      return {}
    }
    const me = await $.session.id()
    const now = await $.clock.now()
    const loaded = await load($).catch(() => undefined)
    if (!loaded) {
      $.ui.toast('fleet: store unreadable, nothing sent')
      return {}
    }
    const found = pick(loaded.live.filter(p => p.id !== me && !isStale(now - p.updatedAt)), query)
    const [to, ...rest] = found
    if (!to || rest.length > 0) {
      const names = found.map(p => `${p.name} (${p.id.slice(0, 8)})`).join(', ')
      $.ui.toast(to ? `fleet: "${query}" matches ${names}` : `fleet: no live session matches "${query}"`)
      return {}
    }
    await sendTo($, to, text)
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (self.isUnreadable) return below
    const me = await $.session.id()
    const now = await $.clock.now()
    const waiting = self.peers.filter(p => p.id !== me && p.state === 'waiting' && !isStale(now - p.updatedAt))
    if (waiting.length === 0) return below
    const { Box, Text } = $.ui.resolve(e)
    const shown = waiting.slice(0, 2).map(p => `⏸ ${p.name} waiting ${ageOf(now - p.since)}`)
    const more = waiting.length > 2 ? `  +${waiting.length - 2}` : ''
    return (
      <Box flexDirection="column">
        <Text key="fleet-band" color="yellow" wrap="truncate-end">
          {clean(`fleet  ${shown.join('  ')}${more}`)}
        </Text>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const me = await $.session.id()
    const now = await $.clock.now()
    const checkouts = self.peers.map(p => p.checkout)
    const aim = (to?: Entry) => {
      self.target = to
      $.ui.invalidate('ui.render')
    }
    const rows = ORDER.flatMap(state =>
      self.peers
        .filter(p => p.state === state)
        .map(p => {
          const isSelf = p.id === me
          const isClash = checkouts.indexOf(p.checkout) !== checkouts.lastIndexOf(p.checkout)
          const seen = now - p.updatedAt
          const isOld = self.isUnreadable || isStale(seen)
          const ctx = p.contextPercent === null ? '?' : `${Math.round(p.contextPercent)}%`
          const line = [
            isSelf ? '*' : ' ',
            p.repo,
            (p.branch || '-') + (p.isWorktree ? ' (wt)' : ''),
            isOld ? `last seen ${seen < 0 ? '?' : ageOf(seen)} ago` : `${p.state}  ${ageOf(now - p.since)}`,
            `ctx ${ctx}`,
            p.lastPrompt && `"${p.lastPrompt}"`,
            isClash && `same checkout: ${p.checkout}`,
          ]
          return (
            <Box key={`row:${p.id}`} gap={1}>
              <Text key={p.id} color={isClash ? 'red' : COLOR[state]} dimColor={isOld} bold={isSelf} wrap="truncate-end">
                {clean(line.filter(Boolean).join('  '))}
              </Text>
              {Input && !isSelf && <Button key={`send:${p.id}`} label="Send" dimColor onPress={() => aim(p)} />}
            </Box>
          )
        }),
    )
    const target = self.target
    return (
      <Box flexDirection="column">
        {self.isUnreadable && (
          <Text key="unreadable" color="red">{`store unreadable (last good ${ageOf(now - self.goodAt)} ago)`}</Text>
        )}
        {self.bad > 0 && <Text key="bad" dimColor>{`${self.bad} malformed entries skipped`}</Text>}
        {rows.length === 0 && <Text dimColor>No sessions seen in the last 60s.</Text>}
        {rows}
        {target && Input && (
          <Box gap={1}>
            <Input
              key="send-text"
              label={clean(`to ${target.name}: `)}
              submitLabel="send"
              autoFocus
              onSubmit={async text => {
                if (text.trim()) await sendTo($, target, text.trim())
                aim(undefined)
              }}
            />
            <Button key="send-cancel" label="Cancel" onPress={() => aim(undefined)} />
          </Box>
        )}
      </Box>
    )
  })
}
