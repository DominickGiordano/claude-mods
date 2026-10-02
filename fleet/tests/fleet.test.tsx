import type { Args, CommandRunInput, On, RenderInput } from 'claude-code'
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
    name: 'vector:main',
    repo: 'vector',
    cwd: `/src/${id}`,
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

const GIT = { dirs: '/src/app\n/src/app/.git\n/src/app/.git\n', branch: 'feature/x\n' }

type Options = { stored?: Record<string, unknown>; git?: typeof GIT; refusal?: string }

// A session in /src/app on feature/x, git, the store and the session answered from memory.
function world(on: On, { stored = {}, git = GIT, refusal }: Options = {}) {
  const store = new Map(Object.entries(stored))
  const runs: string[][] = []
  const sends: Args<'session.send'>[] = []
  const toasts: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: SELF }))
  on('session.cwd', () => ({ value: '/src/app/web' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: 42 }, rateLimits: [] },
  }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const stdout = e.argv.includes('rev-parse') ? git.dirs : git.branch
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', ($, e) => {
    sends.push(e)
    return refusal === undefined ? { isDelivered: true } : { isDelivered: false, reason: refusal }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="core">core band</Text>
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  const clock = mock.clock(on, { now: NOW })
  return { store, runs, sends, toasts, clock, own: () => store.get(`fleet:${SELF}`) as Entry | undefined }
}

async function start($: Engine, on: On, options: Options = {}) {
  const w = world(on, options)
  await $.session.start({ cwd: '/src/app/web', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  return w
}

describe('heartbeat', () => {
  test('writes its own key with repo, branch, state and context', async ($, on) => {
    const w = await start($, on)
    expect(w.own()).toEqual({
      id: SELF,
      name: 'app:feature/x',
      repo: 'app',
      cwd: '/src/app/web',
      checkout: '/src/app',
      branch: 'feature/x',
      isWorktree: false,
      state: 'idle',
      since: NOW,
      contextPercent: 42,
      lastPrompt: '',
      updatedAt: NOW,
    })
  })

  test("tracks the turn and the person's last prompt, not a peer's", async ($, on) => {
    const w = await start($, on)
    await $.prompt.submit({ text: `  fix   the\nbuild ${'x'.repeat(100)}`, wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: '<cross-session-message>hi</cross-session-message>', wait: false, origin: { kind: 'peer' } })
    await $.turn.start({ text: 'fix the build', turnId: 't1' })
    await w.clock.settle()
    const working = w.own()
    expect(working?.state).toBe('working')
    expect(working?.since).toBe(NOW)
    expect(working?.lastPrompt).toHaveLength(80)
    expect(working?.lastPrompt.startsWith('fix the build x')).toBe(true)
  })

  test('an open question reads as waiting until it is answered', async ($, on) => {
    const seen: (string | undefined)[] = []
    const w = world(on)
    on('tool.call', async () => {
      await w.clock.settle()
      seen.push(w.own()?.state)
      return { result: 'Blue' }
    })
    await $.session.start({ cwd: '/src/app/web', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'ask me', turnId: 't1' })
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
    await w.clock.settle()
    expect(seen).toEqual(['waiting'])
    expect(w.own()?.state).toBe('working')
  })

  test('a permission query with no call id is not a dialog', async ($, on) => {
    on('tool.check', () => ({ decision: 'ask' }))
    const w = await start($, on)
    await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })
    await w.clock.settle()
    expect(w.own()?.state).toBe('idle')
  })

  test('git runs once per turn, not per beat', async ($, on) => {
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
    const git = { dirs: '/wt/fx\n/src/vector/.git/worktrees/fx\n/src/vector/.git\n', branch: 'fx\n' }
    const w = await start($, on, { git })
    expect(w.own()).toMatchObject({ repo: 'vector', checkout: '/wt/fx', isWorktree: true, name: 'vector:fx' })
  })

  test('session end deletes the key', async ($, on) => {
    const w = await start($, on)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: SELF, resume: { id: SELF } })
    expect(w.own()).toBeUndefined()
  })
})

describe('/fleet pane', () => {
  test('drops stale rows and prunes keys older than 10 minutes', async ($, on) => {
    const w = await start($, on, {
      stored: {
        'fleet:fresh': peer('fresh', { branch: 'fresh' }),
        'fleet:stale': peer('stale', { branch: 'stale', updatedAt: NOW - LIVE_MS - 1 }),
        'fleet:gone': peer('gone', { branch: 'gone', updatedAt: NOW - PRUNE_MS - 1 }),
      },
    })
    await $.command.run(command('fleet'))
    const ui = await $.ui.mount(PANE)
    const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(text).toContain('fresh')
    expect(text).not.toContain('stale')
    expect(w.store.has('fleet:stale')).toBe(true)
    expect(w.store.has('fleet:gone')).toBe(false)
  })

  test('waiting first, this session marked, a shared checkout in red', async ($, on) => {
    await start($, on, {
      stored: {
        'fleet:a': peer('a', { checkout: '/src/app' }),
        'fleet:b': peer('b', { state: 'waiting', branch: 'b' }),
      },
    })
    await $.command.run(command('fleet'))
    const ui = await $.ui.mount(PANE)
    const rows = await ui.findAll({ type: 'Text' })
    expect(rows.map(r => r.text.slice(0, 12))).toEqual(['   vector  b', '   vector  m', '*  app  feat'])
    expect(rows.map(r => r.props.color)).toEqual(['yellow', 'red', 'red'])
    expect(rows[2]?.text).toContain('same checkout: /src/app')
    expect(await ui.find({ key: `send:${SELF}` })).toBeUndefined()
    expect(await ui.find({ key: 'send:b' })).toBeDefined()
  })

  test('Send opens a field that sends to that session', async ($, on) => {
    const w = await start($, on, { stored: { 'fleet:b': peer('b') } })
    await $.command.run(command('fleet'))
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'send:b' })
    await ui.input({ key: 'send-text', text: 'rebase on develop' })
    expect(w.sends).toMatchObject([{ to: 'b', text: 'rebase on develop' }])
    expect(w.toasts).toEqual(['fleet: sent to vector:main'])
    expect(await ui.find({ key: 'send-text' })).toBeUndefined()
  })
})

describe('band', () => {
  test('passes the band through when nobody waits', async ($, on) => {
    const w = await start($, on, { stored: { 'fleet:a': peer('a', { state: 'working' }) } })
    await w.clock.advance(REFRESH_MS)
    const ui = await $.ui.mount(BAND)
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['core band'])
  })

  test('shows up to two waiting sessions above the rest, then +N', async ($, on) => {
    const w = await start($, on, {
      stored: {
        'fleet:a': peer('a', { state: 'waiting', name: 'vector:feature/x' }),
        'fleet:b': peer('b', { state: 'waiting', name: 'api:main' }),
        'fleet:c': peer('c', { state: 'waiting', name: 'web:main' }),
      },
    })
    await w.clock.advance(REFRESH_MS)
    const ui = await $.ui.mount(BAND)
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual([
      'fleet  ⏸ vector:feature/x waiting 3m  ⏸ api:main waiting 3m  +1',
      'core band',
    ])
  })
})

describe('/send', () => {
  const stored = {
    'fleet:abc123': peer('abc123', { name: 'vector:main' }),
    'fleet:abd456': peer('abd456', { name: 'vector:main-2' }),
  }

  test('an ambiguous prefix toasts the matches and sends nothing', async ($, on) => {
    const w = await start($, on, { stored })
    await $.command.run(command('send', 'ab hello'))
    expect(w.sends).toEqual([])
    expect(w.toasts).toEqual(['fleet: "ab" matches vector:main (abc123), vector:main-2 (abd456)'])
  })

  test('an exact name beats a longer name it prefixes', async ($, on) => {
    const w = await start($, on, { stored })
    await $.command.run(command('send', 'vector:main run the tests'))
    expect(w.sends).toMatchObject([{ to: 'abc123', text: 'run the tests', origin: { kind: 'plugin', name: 'fleet' } }])
    expect(w.toasts).toEqual(['fleet: sent to vector:main'])
  })

  test('an id prefix sends; a failed delivery says why', async ($, on) => {
    const w = await start($, on, { stored, refusal: 'session not running' })
    await $.command.run(command('send', 'abd hi'))
    expect(w.sends).toMatchObject([{ to: 'abd456', text: 'hi' }])
    expect(w.toasts).toEqual(['fleet: send to vector:main-2 failed: session not running'])
  })

  test('no match and no text both toast', async ($, on) => {
    const w = await start($, on, { stored })
    await $.command.run(command('send', 'zzz hi'))
    await $.command.run(command('send', 'abc'))
    expect(w.sends).toEqual([])
    expect(w.toasts).toEqual([
      'fleet: no live session matches "zzz"',
      'fleet: usage /send <session name or id prefix> <text>',
    ])
  })
})
