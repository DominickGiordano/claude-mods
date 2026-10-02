import type { Args, CommandRunInput, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Entry } from '../hooks/register'
import { BEAT_MS, LIVE_MS, PRUNE_MS, REFRESH_MS } from '../hooks/register'

const NOW = 1_000_000_000
const SELF = 'self-0000'

const PANE = {
  plugin: 'fleet',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'fleet',
  viewport: { columns: 160, rows: 40 },
  props: { title: 'Fleet', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const BAND = {
  plugin: 'fleet',
  surface: 'terminal',
  component: 'AbovePrompt',
  viewport: { columns: 160, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

function peer(id: string, fields: Partial<Entry> = {}): Entry {
  return {
    id,
    name: 'widgets:main',
    repo: 'widgets',
    checkout: `/src/${id}`,
    branch: 'main',
    isWorktree: false,
    state: 'idle',
    since: NOW - 180_000,
    contextPercent: 12,
    lastPrompt: 'fix the login',
    updatedAt: NOW - 5_000,
    ...fields,
  }
}

const command = (name: string, args = ''): CommandRunInput => ({
  command: name,
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
})

const GIT = { dirs: '/src/acme\n/src/acme/.git\n/src/acme/.git\n', branch: 'feature/x\n' }

type Options = { stored?: Record<string, unknown>; git?: typeof GIT; refusal?: string }

// A session in /src/acme on feature/x; git, the store and the session answered from memory.
// Flip `broken` to make the key list unreadable, `throwing` to make a send reject.
function world(on: On, { stored = {}, git = GIT, refusal }: Options = {}) {
  const store = new Map(Object.entries(stored))
  const w = {
    store,
    runs: [] as string[][],
    sends: [] as Args<'session.send'>[],
    toasts: [] as string[],
    broken: false,
    throwing: false,
    unreadableKeys: new Set<string>(),
    clock: mock.clock(on, { now: NOW }),
    own: () => store.get(`fleet:${SELF}`) as Entry | undefined,
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: SELF }))
  on('session.cwd', () => ({ value: '/src/acme/web' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: 42 }, rateLimits: [] },
  }))
  on('process.run', ($, e) => {
    w.runs.push([...e.argv])
    const stdout = e.argv.includes('rev-parse') ? git.dirs : git.branch
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', ($, e) => {
    if (w.throwing) throw new Error('socket closed')
    w.sends.push(e)
    return refusal === undefined ? { isDelivered: true } : { isDelivered: false, reason: refusal }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="core">core band</Text>
  })
  on('ui.render', { component: 'ToolProgress' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="pill">{e.props.hint}</Text>
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('store.get', ($, e) => {
    if (w.unreadableKeys.has(e.key)) throw new Error('bad json')
    return { value: store.get(e.key) }
  })
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => {
    if (w.broken) throw new Error('EACCES')
    return { value: [...store.keys()] }
  })
  return w
}

async function start($: Engine, on: On, options: Options = {}, isInteractive = true) {
  const w = world(on, options)
  await $.session.start({ cwd: '/src/acme/web', surface: isInteractive ? 'terminal' : null, isInteractive })
  await w.clock.settle()
  return w
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text)

describe('heartbeat', () => {
  test('writes its own key with repo, branch, state and context', async ($, on) => {
    const w = await start($, on)
    expect(w.own()).toEqual({
      id: SELF,
      name: 'acme:feature/x',
      repo: 'acme',
      checkout: '/src/acme',
      branch: 'feature/x',
      isWorktree: false,
      state: 'idle',
      since: NOW,
      contextPercent: 42,
      lastPrompt: '',
      updatedAt: NOW,
    })
  })

  test('a headless session writes nothing', async ($, on) => {
    const w = await start($, on, {}, false)
    await w.clock.advance(BEAT_MS)
    expect(w.own()).toBeUndefined()
  })

  test("tracks the turn and the person's last prompt, not a peer's", async ($, on) => {
    const w = await start($, on)
    await $.prompt.submit({ text: `  fix \u001b[2J  the\nbuild ${'x'.repeat(100)}`, wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: '<cross-session-message>hi</cross-session-message>', wait: false, origin: { kind: 'peer' } })
    await $.turn.start({ text: 'fix the build', turnId: 't1' })
    await w.clock.settle()
    const working = w.own()
    expect(working?.state).toBe('working')
    expect(working?.lastPrompt).toHaveLength(80)
    expect(working?.lastPrompt.startsWith('fix [2J the build x')).toBe(true)
  })

  test('an open question reads as waiting until it is answered', async ($, on) => {
    const seen: (string | undefined)[] = []
    const w = world(on)
    on('tool.call', async () => {
      await w.clock.settle()
      seen.push(w.own()?.state)
      return { result: 'Blue' }
    })
    await $.session.start({ cwd: '/src/acme/web', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'ask me', turnId: 't1' })
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
    await w.clock.settle()
    expect(seen).toEqual(['waiting'])
    expect(w.own()?.state).toBe('working')
  })

  test('a permission ask waits until the call is denied', async ($, on) => {
    let release = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    let callId = ''
    const w = world(on)
    on('tool.check', () => ({ decision: 'ask' }))
    on('tool.call', async ($, e) => {
      callId = e.tool_use_id
      await gate
      return { deny: 'the person said no' }
    })
    await $.session.start({ cwd: '/src/acme/web', surface: 'terminal', isInteractive: true })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' }).catch(() => undefined)
    await w.clock.settle()
    await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: callId })
    await w.clock.settle()
    expect(w.own()?.state).toBe('waiting')
    release()
    await call
    await w.clock.settle()
    expect(w.own()?.state).toBe('idle')
  })

  test('the run-in-background pill ends a permission wait', async ($, on) => {
    on('tool.check', () => ({ decision: 'ask' }))
    const w = await start($, on)
    await $.tool.check({ tool: 'Bash', input: { command: 'make' }, tool_use_id: 'u1' })
    await w.clock.settle()
    expect(w.own()?.state).toBe('waiting')
    await $.ui.render({
      component: 'ToolProgress',
      surface: 'terminal',
      requestId: 'u1',
      props: { tool_use_id: 'u1', kind: 'background_hint', hint: '(ctrl+b to run in background)' },
    })
    await w.clock.settle()
    expect(w.own()?.state).toBe('idle')
  })

  test('a permission query with no call id is not a dialog', async ($, on) => {
    on('tool.check', () => ({ decision: 'ask' }))
    const w = await start($, on)
    await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })
    await w.clock.settle()
    expect(w.own()?.state).toBe('idle')
  })

  test('git runs at start and once per turn, never per beat', async ($, on) => {
    const w = await start($, on)
    expect(w.runs).toHaveLength(2)
    await w.clock.advance(BEAT_MS * 3)
    expect(w.runs).toHaveLength(2)
    expect(w.own()?.updatedAt).toBe(NOW + BEAT_MS * 3)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await w.clock.settle()
    expect(w.runs).toHaveLength(4)
  })

  test('a worktree reports its main repo', async ($, on) => {
    const git = { dirs: '/wt/fx\n/src/widgets/.git/worktrees/fx\n/src/widgets/.git\n', branch: 'fx\n' }
    const w = await start($, on, { git })
    expect(w.own()).toMatchObject({ repo: 'widgets', checkout: '/wt/fx', isWorktree: true, name: 'widgets:fx' })
  })

  test('session end deletes the key and a late beat does not bring it back', async ($, on) => {
    const w = await start($, on)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: SELF, resume: { id: SELF } })
    await w.clock.advance(BEAT_MS)
    expect(w.own()).toBeUndefined()
  })
})

describe('/fleet pane', () => {
  test('drops rows past 60s, prunes keys past 10 minutes, shows stale ones as last seen', async ($, on) => {
    const w = await start($, on, {
      stored: {
        'fleet:fresh': peer('fresh', { branch: 'fresh' }),
        'fleet:quiet': peer('quiet', { branch: 'quiet', state: 'waiting', updatedAt: NOW - 45_000 }),
        'fleet:stale': peer('stale', { branch: 'stale', updatedAt: NOW - LIVE_MS - 1 }),
        'fleet:gone': peer('gone', { branch: 'gone', updatedAt: NOW - PRUNE_MS - 1 }),
      },
    })
    await $.command.run(command('fleet'))
    const ui = await $.ui.mount(PANE)
    const shown = (await texts(ui)).join('\n')
    expect(shown).toContain('fresh')
    expect(shown).toContain('quiet  last seen 45s ago')
    expect(shown).not.toContain('stale')
    expect(w.store.has('fleet:stale')).toBe(true)
    expect(w.store.has('fleet:gone')).toBe(false)
  })

  test('waiting first, this session marked, a shared checkout in red', async ($, on) => {
    await start($, on, {
      stored: {
        'fleet:a': peer('a', { checkout: '/src/acme' }),
        'fleet:b': peer('b', { state: 'waiting', branch: 'b' }),
      },
    })
    await $.command.run(command('fleet'))
    const ui = await $.ui.mount(PANE)
    const rows = await ui.findAll({ type: 'Text' })
    expect(rows.map(r => r.props.color)).toEqual(['yellow', 'red', 'red'])
    expect(rows[0]?.text).toContain('widgets  b  waiting')
    expect(rows[2]?.text.startsWith('*  acme')).toBe(true)
    expect(rows[2]?.text).toContain('same checkout: /src/acme')
    expect(await ui.find({ key: `send:${SELF}` })).toBeUndefined()
    expect(await ui.find({ key: 'send:b' })).toBeDefined()
  })

  test('malformed entries are skipped and counted', async ($, on) => {
    const w = world(on, {
      stored: { 'fleet:a': peer('a'), 'fleet:junk': { id: 'junk', state: 'asleep' }, 'fleet:b': peer('b', { branch: 'b' }) },
    })
    w.unreadableKeys.add('fleet:b')
    await $.session.start({ cwd: '/src/acme/web', surface: 'terminal', isInteractive: true })
    await $.command.run(command('fleet'))
    const shown = await texts(await $.ui.mount(PANE))
    expect(shown[0]).toBe('2 malformed entries skipped')
    expect(shown.filter(t => t.includes('widgets'))).toHaveLength(1)
  })

  test('an unreadable store keeps the last rows, marked stale, and quiets the band', async ($, on) => {
    const w = await start($, on, { stored: { 'fleet:b': peer('b', { state: 'waiting' }) } })
    await $.command.run(command('fleet'))
    w.broken = true
    await w.clock.advance(REFRESH_MS * 8)
    const shown = await texts(await $.ui.mount(PANE))
    expect(shown[0]).toBe('store unreadable (last good 40s ago)')
    expect(shown[1]).toContain('last seen 45s ago')
    expect(await texts(await $.ui.mount(BAND))).toEqual(['core band'])
  })

  test('Send keeps the field until the send settles, then says it was queued', async ($, on) => {
    const w = await start($, on, { stored: { 'fleet:b': peer('b') } })
    await $.command.run(command('fleet'))
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'send:b' })
    await ui.input({ key: 'send-text', text: 'rebase on develop' })
    expect(w.sends).toMatchObject([{ to: 'b', text: 'rebase on develop' }])
    expect(w.toasts).toEqual(['fleet: queued for widgets:main'])
    expect(await ui.find({ key: 'send-text' })).toBeUndefined()
  })

  test('a rejected send toasts instead of failing silently', async ($, on) => {
    const w = await start($, on, { stored: { 'fleet:b': peer('b') } })
    w.throwing = true
    await $.command.run(command('fleet'))
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'send:b' })
    await ui.input({ key: 'send-text', text: 'hi' })
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toContain('fleet: send to widgets:main failed:')
  })
})

describe('band', () => {
  test('passes the band through when nobody waits', async ($, on) => {
    const w = await start($, on, { stored: { 'fleet:a': peer('a', { state: 'working' }) } })
    await w.clock.advance(REFRESH_MS)
    expect(await texts(await $.ui.mount(BAND))).toEqual(['core band'])
  })

  test('shows up to two fresh waiting sessions above the rest, then +N', async ($, on) => {
    const w = await start($, on, {
      stored: {
        'fleet:a': peer('a', { state: 'waiting', name: 'widgets:feature/x' }),
        'fleet:b': peer('b', { state: 'waiting', name: 'api:main' }),
        'fleet:c': peer('c', { state: 'waiting', name: 'web:main' }),
        'fleet:d': peer('d', { state: 'waiting', name: 'old:main', updatedAt: NOW - 45_000 }),
      },
    })
    await w.clock.advance(REFRESH_MS)
    expect(await texts(await $.ui.mount(BAND))).toEqual([
      'fleet  ⏸ widgets:feature/x waiting 3m  ⏸ api:main waiting 3m  +1',
      'core band',
    ])
  })
})

describe('/send', () => {
  const stored = {
    'fleet:abc123': peer('abc123', { name: 'widgets:main' }),
    'fleet:abd456': peer('abd456', { name: 'widgets:main-2' }),
  }

  test('an ambiguous prefix toasts the matches and sends nothing', async ($, on) => {
    const w = await start($, on, { stored })
    await $.command.run(command('send', 'ab hello'))
    expect(w.sends).toEqual([])
    expect(w.toasts).toEqual(['fleet: "ab" matches widgets:main (abc123), widgets:main-2 (abd456)'])
  })

  test('two sessions on the same repo:branch stay ambiguous', async ($, on) => {
    const w = await start($, on, { stored: { ...stored, 'fleet:fff999': peer('fff999', { name: 'widgets:main' }) } })
    await $.command.run(command('send', 'widgets:main hi'))
    expect(w.sends).toEqual([])
    expect(w.toasts).toEqual(['fleet: "widgets:main" matches widgets:main (abc123), widgets:main (fff999)'])
  })

  test('an exact name beats a longer name it prefixes', async ($, on) => {
    const w = await start($, on, { stored })
    await $.command.run(command('send', 'widgets:main run the tests'))
    expect(w.sends).toMatchObject([{ to: 'abc123', text: 'run the tests', origin: { kind: 'plugin', name: 'fleet' } }])
    expect(w.toasts).toEqual(['fleet: queued for widgets:main'])
  })

  test('an id prefix sends; a failed delivery says why', async ($, on) => {
    const w = await start($, on, { stored, refusal: 'session not running' })
    await $.command.run(command('send', 'abd hi'))
    expect(w.sends).toMatchObject([{ to: 'abd456', text: 'hi' }])
    expect(w.toasts).toEqual(['fleet: send to widgets:main-2 failed: session not running'])
  })

  test('this session is never a target', async ($, on) => {
    const w = await start($, on, { stored })
    await $.command.run(command('send', 'acme:feature/x hi'))
    await $.command.run(command('send', 'self hi'))
    expect(w.sends).toEqual([])
    expect(w.toasts).toEqual([
      'fleet: no live session matches "acme:feature/x"',
      'fleet: no live session matches "self"',
    ])
  })

  test('no text toasts usage', async ($, on) => {
    const w = await start($, on, { stored })
    await $.command.run(command('send', 'abc'))
    expect(w.sends).toEqual([])
    expect(w.toasts).toEqual(['fleet: usage /send <session name or id prefix> <text>'])
  })
})
