import type { AgentInfo, CommandRunInput, On, SessionMessage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { codeBlocks, collectLinks, latestReply } from '../hooks/register'

const say = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] })
const toolResult: SessionMessage = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't', text: 'x', result: 'x', isError: false }] }
const ran = (tool: string, text: string): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: tool, tool, input: {}, text }] })

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

type World = {
  toasts: string[]
  copied: string[]
  submitted: { text: string; origin: unknown }[]
  opened: string[]
  isTurning: boolean
  submit: 'ok' | 'drop' | 'throw'
  agents: AgentInfo[]
  hold: Promise<{ result: string }> | null
  clock: ReturnType<typeof mock.clock>
}

const run = (command: string, args = ''): CommandRunInput =>
  ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

const complete = (turnId: string, durationMs: number, isAborted = false) =>
  ({ answer: '', durationMs, isAborted, turnId, reason: isAborted ? 'aborted' : 'answer' } as const)

async function start($: Engine, on: On, messages: SessionMessage[] = []): Promise<World> {
  const world: World = {
    toasts: [], copied: [], submitted: [], opened: [], isTurning: false, submit: 'ok', agents: [], hold: null, clock: mock.clock(on),
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.messages', () => ({ value: messages }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, tokens: 62_000, percent: 31 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: world.agents }))
  on('ui.toast', (_$, e) => (world.toasts.push(e.text), { value: undefined }))
  on('ui.copy', (_$, e) => (world.copied.push(e.text), { value: { isCopied: true } }))
  on('ui.open', (_$, e) => (world.opened.push(e.id), { value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', children: ['hint'] }))
  // As in a session, a plugin's submit settles only once no turn is running.
  on('prompt.submit', (_$, e) => {
    world.submitted.push({ text: e.text, origin: e.origin })
    if (world.submit === 'throw') throw new Error('engine said no')
    if (world.submit === 'drop') return { drop: 'blocked by a hook' }
    return world.isTurning ? new Promise(() => {}) : { text: e.text }
  })
  on('turn.start', (_$, e) => ((world.isTurning = true), { turnId: e.turnId }))
  on('turn.complete', (_$, e) => ((world.isTurning = false), { text: e.answer }))
  on('tool.call', () => world.hold ?? { result: 'ok' })
  await $.session.start(SESSION)
  return world
}

// A finished turn, so the mod knows the session is idle.
async function idle($: Engine) {
  await $.turn.start({ text: 'warm up', turnId: 't0' })
  await $.turn.complete(complete('t0', 1000))
}

describe('collectLinks', () => {
  test('groups, dedups, newest first', () => {
    const links = collectLinks([
      say('assistant', 'Opened https://github.com/acme/api/pull/12 and see https://example.com/a.'),
      say('user', 'also https://github.com/acme/api/pull/12/files'),
      ran('Bash', 'https://github.com/acme/api/issues/3'),
      say('assistant', 'Here: [page](https://claude.ai/code/artifact/abc-123) and https://example.com/a/'),
    ])
    expect(links).toEqual([
      { url: 'https://example.com/a/', label: 'https://example.com/a/', group: 'Other' },
      { url: 'https://claude.ai/code/artifact/abc-123', label: 'https://claude.ai/code/artifact/abc-123', group: 'Artifacts' },
      { url: 'https://github.com/acme/api/issues/3', label: 'https://github.com/acme/api/issues/3', group: 'GitHub' },
      { url: 'https://github.com/acme/api/pull/12', label: 'acme/api#12', group: 'PRs' },
    ])
  })

  test('balanced parentheses and trailing underscores stay; a markdown closer goes', () => {
    const urls = collectLinks([say('assistant', [
      'See https://en.wikipedia.org/wiki/Foo_(bar) and (https://x.dev/a_) and [doc](https://x.dev/b).',
    ].join(''))]).map(l => l.url)
    expect(urls).toEqual(['https://x.dev/b', 'https://x.dev/a_', 'https://en.wikipedia.org/wiki/Foo_(bar)'])
  })

  test('the PR number ends at a boundary', () => {
    expect(collectLinks([say('assistant', 'https://github.com/a/b/pull/12abc')])[0]!.group).toBe('GitHub')
  })

  test('only Bash and WebFetch output is harvested', () => {
    const urls = collectLinks([ran('Read', 'https://in-a-file.dev'), ran('Grep', 'https://hit.dev'), ran('WebFetch', 'https://fetched.dev')])
      .map(l => l.url)
    expect(urls).toEqual(['https://fetched.dev'])
  })
})

describe('codeBlocks', () => {
  test('in order, closed', () => {
    expect(codeBlocks('Try:\n```ts\nconst a = 1\n```\nthen\n```bash\nnpm test\n```\n'))
      .toEqual([{ text: 'const a = 1', isPartial: false }, { text: 'npm test', isPartial: false }])
  })

  test('empty block, longer closer, nested shorter fence', () => {
    expect(codeBlocks('```\n```\n````md\n```js\nx\n```\n`````'))
      .toEqual([{ text: '', isPartial: false }, { text: '```js\nx\n```', isPartial: false }])
  })

  test("a list item's indent is removed", () => {
    expect(codeBlocks('1. run:\n   ```sh\n   npm i\n     --save\n   ```')).toEqual([{ text: 'npm i\n  --save', isPartial: false }])
  })

  test('an unclosed fence is a partial block', () => {
    expect(codeBlocks('here:\n```py\nprint(1)\nprint(2')).toEqual([{ text: 'print(1)\nprint(2', isPartial: true }])
  })
})

describe('latestReply', () => {
  test('spans tool rounds and engine-written rows, stops at the prompt', () => {
    expect(latestReply([
      say('assistant', 'old'),
      say('user', 'go'),
      say('assistant', 'part one'),
      toolResult,
      say('user', '<task-notification>build done</task-notification>'),
      say('user', '[Request interrupted by user]'),
      say('assistant', 'part two'),
    ])).toBe('part one\n\npart two')
  })

  test('with skip, the reply before', () => {
    expect(latestReply([say('user', 'a'), say('assistant', 'one'), say('user', 'b'), say('assistant', 'two')], 1)).toBe('one')
  })
})

describe('/yank', () => {
  const reply = 'Try:\n```ts\nconst a = 1\n```\nthen\n```bash\nnpm test\n```\n'

  test('the last block, then the one before', async ($, on) => {
    const world = await start($, on, [say('user', 'q'), say('assistant', reply)])
    await $.command.run(run('yank'))
    await $.command.run(run('yank', '2'))
    expect(world.copied).toEqual(['npm test', 'const a = 1'])
    expect(world.toasts[0]).toBe('copied block 2/2 of the last reply, 8 chars: npm test')
  })

  test('no block: the whole reply', async ($, on) => {
    const world = await start($, on, [say('user', 'q'), say('assistant', 'just prose')])
    await $.command.run(run('yank'))
    expect(world.copied).toEqual(['just prose'])
    expect(world.toasts[0]).toContain('the whole last reply (no code block)')
  })

  test('past the block count copies nothing', async ($, on) => {
    const world = await start($, on, [say('user', 'q'), say('assistant', reply)])
    expect(await $.command.run(run('yank', '3'))).toEqual({})
    expect(world.copied).toEqual([])
    expect(world.toasts).toEqual(['yank: the last reply has 2 code blocks'])
  })

  test('an interrupted reply yields its partial block', async ($, on) => {
    const world = await start($, on, [say('user', 'q'), say('assistant', '```sh\nnpm run bui'), say('user', '[Request interrupted by user]')])
    await $.command.run(run('yank'))
    expect(world.copied).toEqual(['npm run bui'])
    expect(world.toasts[0]).toContain('partial block 1/1')
  })

  test('mid-turn: the last completed reply', async ($, on) => {
    const world = await start($, on, [say('user', 'q'), say('assistant', 'done one'), say('user', 'next'), say('assistant', 'writing...')])
    await $.turn.start({ text: 'next', turnId: 't1' })
    await $.command.run(run('yank'))
    expect(world.copied).toEqual(['done one'])
    expect(world.toasts[0]).toContain('the whole last completed reply')
  })
})

describe('/k', () => {
  test('idle: sends keep going as the user, toasting once it settled', async ($, on) => {
    const world = await start($, on)
    await idle($)
    expect(await $.command.run(run('k'))).toEqual({})
    expect(world.toasts).toEqual([])
    await $.command.run(run('k', ' and add tests '))
    await world.clock.settle()
    expect(world.submitted.map(s => s.text)).toEqual(['keep going', 'keep going. and add tests'])
    expect(world.submitted[0]!.origin).toMatchObject({ kind: 'plugin', asUser: true })
    expect(world.toasts).toEqual(['sent: keep going', 'sent: keep going. and add tests'])
  })

  test('mid-turn: returns at once and says queued', async ($, on) => {
    const world = await start($, on)
    await $.turn.start({ text: 'go', turnId: 't1' })
    expect(await $.command.run(run('k'))).toEqual({})
    await world.clock.settle()
    expect(world.submitted.map(s => s.text)).toEqual(['keep going'])
    expect(world.toasts).toEqual(['queued for when the turn ends: keep going'])
  })

  test('state unknown: a neutral toast, not idle', async ($, on) => {
    const world = await start($, on)
    await $.command.run(run('k'))
    await world.clock.settle()
    expect(world.toasts).toEqual(['submitted; runs when the session is idle: keep going'])
  })

  test('a drop and a rejection each say so', async ($, on) => {
    const world = await start($, on)
    await idle($)
    world.submit = 'drop'
    await $.command.run(run('k'))
    await world.clock.settle()
    world.submit = 'throw'
    await $.command.run(run('k'))
    await world.clock.settle()
    expect(world.toasts).toEqual(['/k not sent: blocked by a hook', expect.stringContaining('/k failed: ')])
  })
})

describe('/now', () => {
  test('before any turn it claims nothing', async ($, on) => {
    const world = await start($, on)
    await $.command.run(run('now'))
    expect(world.toasts).toEqual(['no turn seen since quick loaded · context 31%'])
  })

  test('the prompt hint seeds a turn that started before load', async ($, on) => {
    const world = await start($, on)
    const hint = await $.ui.mount({ plugin: 'quick', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: true, hint: '' } })
    await hint.unmount()
    await $.command.run(run('now'))
    expect(world.toasts).toEqual(['turn running (started before quick loaded) · context 31%'])
  })

  test('during a turn, then after it', async ($, on) => {
    const world = await start($, on)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'npm test\nmore' })
    await world.clock.advance(75_000)
    await $.command.run(run('now'))
    expect(world.toasts.at(-1)).toBe('turn running 1m 15s · last tool Bash: npm test · context 31%')

    await $.turn.complete(complete('t1', 80_000))
    await $.command.run(run('now'))
    expect(world.toasts.at(-1)).toBe('idle, last turn took 1m 20s · last tool Bash: npm test · context 31%')
  })

  test('an interrupted turn says so', async ($, on) => {
    const world = await start($, on)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete(complete('t1', 12_000, true))
    await $.command.run(run('now'))
    expect(world.toasts).toEqual(['idle, last turn interrupted after 12s · context 31%'])
  })

  test('a running tool; an Agent call shows only as a subagent, capped at three', async ($, on) => {
    const world = await start($, on)
    let release = () => {}
    world.agents = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, description: `job ${id}`, type: 'Explore', status: 'running' }))
    await $.turn.start({ text: 'go', turnId: 't1' })
    world.hold = new Promise(resolve => { release = () => resolve({ result: 'ok' }) })
    const pending = Promise.all([
      $.tool.call({ tool: 'Agent', prompt: 'look', description: 'look around', subagent_type: 'Explore' }),
      $.tool.call({ tool: 'Bash', command: 'sleep 9' }),
    ])
    await world.clock.settle()
    await $.command.run(run('now'))
    release()
    await pending
    expect(world.toasts).toEqual([
      expect.stringContaining('· running Bash: sleep 9 · 5 subagents: job a, job b, job c +2 ·'),
    ])
  })
})

describe('/links', () => {
  test('opens the pane; Copy and Copy all copy urls', async ($, on) => {
    const world = await start($, on, [say('assistant', 'https://github.com/a/b/pull/1 https://x.dev/y')])
    await $.command.run(run('links'))
    expect(world.opened).toEqual(['quick-links'])

    const ui = await $.ui.mount({
      plugin: 'quick', surface: 'terminal', component: 'Pane', requestId: 'quick-links',
      props: { title: 'Links', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: 'a/b#1' })).toBeDefined()
    await ui.press({ key: 'copy-1' })
    await ui.press({ key: 'copy-all' })
    expect(world.copied).toEqual(['https://github.com/a/b/pull/1', 'https://x.dev/y\nhttps://github.com/a/b/pull/1'])
    await ui.unmount()
  })

  test('no urls: a toast, no pane', async ($, on) => {
    const world = await start($, on, [say('assistant', 'nothing here')])
    await $.command.run(run('links'))
    expect(world.opened).toEqual([])
    expect(world.toasts).toEqual(["links: no URLs in this session's messages"])
  })
})
