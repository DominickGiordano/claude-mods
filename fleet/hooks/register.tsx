import type { EngineInterface, On, Timer } from 'claude-code'

export type State = 'waiting' | 'working' | 'idle'

export type Entry = {
  id: string
  name: string
  repo: string
  cwd: string
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
  id?: string
  place?: Place
  isTurn: boolean
  asks: Set<string>
  lastPrompt: string
  written?: State
  since: number
  peers: Entry[]
  target?: Entry
  timers: Timer[]
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

export function ageOf(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

export function collisions(entries: readonly Entry[]) {
  const count = new Map<string, number>()
  for (const entry of entries) count.set(entry.checkout, (count.get(entry.checkout) ?? 0) + 1)
  return new Set([...count].filter(([, n]) => n > 1).map(([checkout]) => checkout))
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
  self.id ??= await $.session.id()
  const cwd = await $.session.cwd()
  self.place ??= await placeOf($, cwd)
  const { context } = await $.session.usage()
  const now = await $.clock.now()
  const state: State = self.asks.size > 0 ? 'waiting' : self.isTurn ? 'working' : 'idle'
  if (state !== self.written) self.since = now
  self.written = state
  const { repo, branch } = self.place
  const entry: Entry = {
    id: self.id,
    name: branch ? `${repo}:${branch}` : repo,
    cwd,
    ...self.place,
    state,
    since: self.since,
    contextPercent: context.percent ?? null,
    lastPrompt: self.lastPrompt,
    updatedAt: now,
  }
  await $.store.set(PREFIX + self.id, entry)
}

function pulse($: EngineInterface, self: Self) {
  beat($, self).catch(err => $.ui.log(`fleet: heartbeat failed: ${err}`, { to: 'debug' }))
}

export async function load($: EngineInterface) {
  const now = await $.clock.now()
  const live: Entry[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(PREFIX)) continue
    const entry = (await $.store.get(key)) as Entry | undefined
    if (!entry) continue
    const age = now - entry.updatedAt
    if (age > PRUNE_MS) await $.store.delete(key)
    else if (age <= LIVE_MS) live.push(entry)
  }
  return live
}

async function refresh($: EngineInterface, self: Self) {
  self.peers = await load($)
  $.ui.invalidate('ui.render')
}

async function sendTo($: EngineInterface, to: Entry, text: string) {
  const sent = await $.session.send({ to: { sessionId: to.id }, text })
  $.ui.toast(sent.isDelivered ? `fleet: sent to ${to.name}` : `fleet: send to ${to.name} failed: ${sent.reason}`)
}

export function register(on: On) {
  const self: Self = { isTurn: false, asks: new Set(), lastPrompt: '', since: 0, peers: [], timers: [] }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fleet', description: 'List every live Claude Code session on this machine', immediate: true })
    await $.command.register({
      name: 'send',
      description: 'Message another live session',
      argumentHint: '<session name or id prefix> <text>',
      immediate: true,
    })
    for (const timer of self.timers) timer.cancel()
    self.timers = [
      $.clock.every(BEAT_MS, () => pulse($, self)),
      $.clock.every(REFRESH_MS, () => {
        refresh($, self).catch(err => $.ui.log(`fleet: refresh failed: ${err}`, { to: 'debug' }))
      }),
    ]
    pulse($, self)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await $.store.delete(PREFIX + e.sessionId)
    // After /clear the process goes on under a new id with no session.start.
    self.id = undefined
    return next(e)
  })

  // A peer's /send also starts a turn; its envelope is not what the person last asked.
  on('prompt.submit', ($, e, next) => {
    const isPerson = ['composer', 'bridge', 'sdk'].includes(e.origin.kind)
    if (isPerson && e.text.trim()) self.lastPrompt = e.text.replace(/\s+/g, ' ').trim().slice(0, 80)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    self.isTurn = true
    self.place = undefined
    pulse($, self)
    return next(e)
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
    const peers = (await load($)).filter(p => p.id !== self.id)
    const found = pick(peers, query)
    const [to] = found
    if (found.length !== 1 || !to) {
      const names = found.map(p => `${p.name} (${p.id.slice(0, 8)})`).join(', ')
      $.ui.toast(found.length === 0 ? `fleet: no live session matches "${query}"` : `fleet: "${query}" matches ${names}`)
      return {}
    }
    await sendTo($, to, text)
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const waiting = self.peers.filter(p => p.id !== self.id && p.state === 'waiting')
    if (waiting.length === 0) return below
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const shown = waiting.slice(0, 2).map(p => `⏸ ${p.name} waiting ${ageOf(now - p.since)}`)
    const more = waiting.length > 2 ? `  +${waiting.length - 2}` : ''
    return (
      <Box flexDirection="column">
        <Text key="fleet-band" color="yellow" wrap="truncate-end">
          {`fleet  ${shown.join('  ')}${more}`}
        </Text>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const now = await $.clock.now()
    const clashes = collisions(self.peers)
    const canSend = 'Input' in els
    const aim = (to?: Entry) => {
      self.target = to
      $.ui.invalidate('ui.render')
    }
    const rows = ORDER.flatMap(state =>
      self.peers
        .filter(p => p.state === state)
        .map(p => {
          const isSelf = p.id === self.id
          const isClash = clashes.has(p.checkout)
          const ctx = p.contextPercent === null ? '?' : `${Math.round(p.contextPercent)}%`
          const line = [
            isSelf ? '*' : ' ',
            p.repo,
            (p.branch || '-') + (p.isWorktree ? ' (wt)' : ''),
            p.state,
            `ctx ${ctx}`,
            ageOf(now - p.since),
            p.lastPrompt && `"${p.lastPrompt}"`,
            isClash && `same checkout: ${p.checkout}`,
          ]
          return (
            <Box key={`row:${p.id}`} gap={1}>
              <Text key={`text:${p.id}`} color={isClash ? 'red' : COLOR[state]} bold={isSelf} wrap="truncate-end">
                {line.filter(Boolean).join('  ')}
              </Text>
              {canSend && !isSelf && (
                <Button
                  key={`send:${p.id}`}
                  label="Send"
                  dimColor
                  onPress={() => aim(p)}
                />
              )}
            </Box>
          )
        }),
    )
    const target = self.target
    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No live sessions yet.</Text>}
        {rows}
        {target && 'Input' in els && (
          <Box gap={1}>
            <els.Input
              key="send-text"
              label={`to ${target.name}: `}
              submitLabel="send"
              autoFocus
              onSubmit={text => {
                aim(undefined)
                if (text.trim()) void sendTo($, target, text.trim())
              }}
            />
            <Button key="send-cancel" label="Cancel" onPress={() => aim(undefined)} />
          </Box>
        )}
      </Box>
    )
  })
}
