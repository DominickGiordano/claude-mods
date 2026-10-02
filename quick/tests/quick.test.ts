import type { CommandRunInput, On, SessionMessage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { codeBlocks, collectLinks, latestReply } from '../hooks/register'

const say = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] })

const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

type World = {
  toasts: string[]
  copied: string[]
  submitted: { text: string; origin: unknown }[]
  opened: string[]
  isTurning: boolean
  clock: ReturnType<typeof mock.clock>
}

const run = (command: string, args = ''): CommandRunInput =>
  ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

async function start($: Engine, on: On, messages: SessionMessage[] = []): Promise<World> {
  const world: World = { toasts: [], copied: [], submitted: [], opened: [], isTurning: false, clock: mock.clock(on) }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.messages', () => ({ value: messages }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, tokens: 62_000, percent: 31 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('ui.toast', (_$, e) => (world.toasts.push(e.text), { value: undefined }))
  on('ui.copy', (_$, e) => (world.copied.push(e.text), { value: { isCopied: true } }))
  on('ui.open', (_$, e) => (world.opened.push(e.id), { value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  // As in a session, a plugin's submit settles only once no turn is running.
  on('prompt.submit', (_$, e) => {
    world.submitted.push({ text: e.text, origin: e.origin })
    return world.isTurning ? new Promise(() => {}) : { text: e.text }
  })
  on('turn.start', (_$, e) => ((world.isTurning = true), { turnId: e.turnId }))
  on('turn.complete', (_$, e) => ((world.isTurning = false), { text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start(SESSION)
  return world
}

describe('collectLinks', () => {
  test('groups, dedups, newest first', () => {
    const links = collectLinks([
      say('assistant', 'Opened https://github.com/acme/api/pull/12 and see https://example.com/a.'),
      say('user', 'also https://github.com/acme/api/pull/12/files'),
      { role: 'assistant', text: 'done', toolUses: [{ tool_use_id: 't', tool: 'Bash', input: {}, text: 'https://github.com/acme/api/issues/3' }] },
      say('assistant', 'Here: [page](https://claude.ai/code/artifact/abc-123) and https://example.com/a'),
    ])
    expect(links).toEqual([
      { url: 'https://example.com/a', label: 'https://example.com/a', group: 'Other' },
      { url: 'https://claude.ai/code/artifact/abc-123', label: 'https://claude.ai/code/artifact/abc-123', group: 'Artifacts' },
      { url: 'https://github.com/acme/api/issues/3', label: 'https://github.com/acme/api/issues/3', group: 'GitHub' },
      { url: 'https://github.com/acme/api/pull/12', label: 'acme/api#12', group: 'PRs' },
    ])
  })
})

describe('yank selection', () => {
  const reply = 'Try:\n```ts\nconst a = 1\n```\nthen\n```bash\nnpm test\n```\n'

  test('code blocks in order', () => {
    expect(codeBlocks(reply)).toEqual(['const a = 1', 'npm test'])
  })

  test('the latest reply spans tool rounds and stops at the prompt', () => {
    const messages: SessionMessage[] = [
      say('assistant', 'old'),
      say('user', 'go'),
      say('assistant', 'part one'),
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't', text: 'x', result: 'x', isError: false }] },
      say('assistant', 'part two'),
    ]
    expect(latestReply(messages)).toBe('part one\n\npart two')
  })

  test('/yank copies the last block, /yank 2 the one before', async ($, on) => {
    const world = await start($, on, [say('user', 'q'), say('assistant', reply)])
    await $.command.run(run('yank'))
    await $.command.run(run('yank', '2'))
    expect(world.copied).toEqual(['npm test', 'const a = 1'])
    expect(world.toasts[0]).toBe('copied block 2/2, 8 chars: npm test')
  })

  test('/yank with no block copies the whole reply; past the count copies nothing', async ($, on) => {
    const world = await start($, on, [say('user', 'q'), say('assistant', 'just prose')])
    await $.command.run(run('yank'))
    expect(world.copied).toEqual(['just prose'])
    expect(world.toasts[0]).toContain('whole reply')
  })

  test('/yank past the block count says so', async ($, on) => {
    const world = await start($, on, [say('user', 'q'), say('assistant', reply)])
    expect(await $.command.run(run('yank', '3'))).toEqual({})
    expect(world.copied).toEqual([])
    expect(world.toasts).toEqual(['yank: the last reply has 2 code blocks'])
  })
})

describe('/k', () => {
  test('idle: sends keep going as the user', async ($, on) => {
    const world = await start($, on)
    expect(await $.command.run(run('k'))).toEqual({})
    await $.command.run(run('k', ' and add tests '))
    await world.clock.settle()
    expect(world.submitted.map(s => s.text)).toEqual(['keep going', 'keep going. and add tests'])
    expect(world.submitted[0]!.origin).toMatchObject({ kind: 'plugin', asUser: true })
    expect(world.toasts[0]).toBe('sent: keep going')
  })

  test('mid-turn: returns without waiting for the turn and says queued', async ($, on) => {
    const world = await start($, on)
    await $.turn.start({ text: 'go', turnId: 't1' })
    expect(await $.command.run(run('k'))).toEqual({})
    await world.clock.settle()
    expect(world.submitted.map(s => s.text)).toEqual(['keep going'])
    expect(world.toasts).toEqual(['queued for when the turn ends: keep going'])
  })
})

describe('/now', () => {
  test('during a turn, then after it', async ($, on) => {
    const world = await start($, on)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'npm test\nmore' })
    await world.clock.advance(75_000)
    await $.command.run(run('now'))
    expect(world.toasts.at(-1)).toBe('turn running 1m 15s · last tool Bash: npm test · context 31%')

    await $.turn.complete({ answer: 'done', durationMs: 80_000, isAborted: false, turnId: 't1', reason: 'answer' })
    await $.command.run(run('now'))
    expect(world.toasts.at(-1)).toBe('idle, last turn took 1m 20s · last tool Bash: npm test · context 31%')
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
