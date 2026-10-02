import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Item } from '../hooks/register'
import { KEEP_MS, PREFIX, handoffs, hash } from '../hooks/register'

const NOW = 1_000_000_000
const ROOT = '/src/acme'
const idOf = (cmd: string, root = ROOT) => hash(`${root}\n${cmd}`).slice(0, 6)

const MERGE = 'gh pr merge 42 --squash --delete-branch'
const TAG = 'git fetch origin && git tag v1.2.0 origin/main'
const HANDOFF = [
  "The merge is blocked in auto mode, so you'll need to run these yourself with `!`:",
  '',
  '```bash',
  '# merge the release PR',
  'gh pr merge 42 --squash \\',
  '  --delete-branch',
  '',
  '# then tag it',
  'git fetch origin &&',
  '  git tag v1.2.0 origin/main',
  '```',
  '',
  "After that I'll check the deploy.",
].join('\n')

const EXPLAINER = [
  'The hook loads every script in order:',
  '',
  '```bash',
  'for f in hooks/*.sh; do',
  '  source "$f"',
  'done',
  '```',
  '',
  'Each file defines one function, and the last one wins.',
].join('\n')

const TYPESCRIPT = ["You'll need to widen the type:", '', '```typescript', 'const limit: number | null = null', '```'].join('\n')

const BAND = {
  plugin: 'handoff', surface: 'terminal', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'handoff', surface: 'terminal', component: 'Pane', requestId: 'handoff',
  props: { title: 'Handoff', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const run = (args = '') => ({ command: 'handoff', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as const

function world(on: On) {
  const w = {
    root: ROOT,
    store: new Map<string, unknown>(),
    contexts: [] as (readonly string[] | undefined)[],
    copied: [] as string[],
    toasts: [] as string[],
    opened: [] as string[],
    clock: mock.clock(on, { now: NOW }),
    list: (root = ROOT) => (w.store.get(PREFIX + hash(root)) ?? []) as Item[],
    stateOf: (id: string) => w.list().find(i => i.id === id)?.state,
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: w.root }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    w.contexts.push(e.context)
    return { text: e.text }
  })
  // Yields between read and write so unserialized writers would interleave and lose items.
  on('store.get', async ($, e) => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
    return { value: w.store.get(e.key) }
  })
  on('store.set', async ($, e) => {
    await Promise.resolve()
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    w.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.title ?? '')
    return { value: { isPlaced: true } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'core band' })
  })
  return w
}

async function start($: Engine, on: On) {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  return w
}

const reply = ($: Engine, answer: string) => $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
// The row bash mode appends. The kit has no bottom for session.append and refuses a test hook
// that answers it, so the append itself rejects; the plugin's hook has run by then.
const bang = ($: Engine, cmd: string) =>
  $.session.append({ message: { type: 'user', role: 'user', content: [{ type: 'text', text: `<bash-input>${cmd}</bash-input>` }] }, door: 'command', origin: { kind: 'composer' }, uuid: 'row-1' })
    .catch((err: unknown) => expect(String(err)).toContain('no implementation for session.append'))

describe('capture', () => {
  test('a hand-off reply yields one item per logical command, labelled by its comment', () => {
    expect(handoffs(HANDOFF)).toEqual([
      { cmd: MERGE, label: 'merge the release PR' },
      { cmd: TAG, label: 'then tag it' },
    ])
  })

  test('explanatory and non-shell blocks are not hand-offs', () => {
    expect(handoffs(EXPLAINER)).toEqual([])
    expect(handoffs(TYPESCRIPT)).toEqual([])
    expect(handoffs("I'll run the suite next.\n\n```bash\nnpm test\n```")).toEqual([])
  })

  test('a console block keeps the $ lines and drops the output', () => {
    expect(handoffs('Paste this in your terminal:\n\n```console\n$ gh auth login\nLogged in as you\n```')).toEqual([{ cmd: 'gh auth login', label: '' }])
  })

  test('turn.complete stores items for the session repo; a subagent turn does not', async ($, on) => {
    const w = await start($, on)
    await $.turn.complete({ answer: HANDOFF, durationMs: 1, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'a1' })
    expect(w.list()).toEqual([])
    await reply($, HANDOFF)
    expect(w.list()).toEqual([
      { id: idOf(MERGE), cmd: MERGE, label: 'merge the release PR', repo: 'acme', root: ROOT, createdAt: NOW, state: 'todo', updatedAt: NOW },
      { id: idOf(TAG), cmd: TAG, label: 'then tag it', repo: 'acme', root: ROOT, createdAt: NOW, state: 'todo', updatedAt: NOW },
    ])
  })

  test('re-handing does not duplicate, and reopens a done item', async ($, on) => {
    const w = await start($, on)
    await reply($, HANDOFF)
    await reply($, HANDOFF)
    expect(w.list()).toHaveLength(2)
    await reply($, `[done #${idOf(MERGE)}] merged.`)
    expect(w.stateOf(idOf(MERGE))).toBe('confirmed')
    await w.clock.advance(60_000)
    await reply($, HANDOFF)
    expect(w.list()).toHaveLength(2)
    expect(w.list().find(i => i.id === idOf(MERGE))).toMatchObject({ state: 'todo', updatedAt: NOW + 60_000, createdAt: NOW })
  })

  test('each repo keeps its own list; /handoff all shows both', async ($, on) => {
    const w = await start($, on)
    await reply($, HANDOFF)
    w.root = '/src/widgets'
    await $.command.run(run('add make deploy'))
    expect(w.list('/src/widgets').map(i => i.cmd)).toEqual(['make deploy'])
    expect(w.list().map(i => i.cmd)).toEqual([MERGE, TAG])

    await $.command.run(run('all'))
    expect(w.opened).toEqual(['Handoff: all repos'])
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Text', text: `widgets · #${idOf('make deploy', '/src/widgets')} · just now` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `acme · #${idOf(MERGE)} · just now` })).toBeDefined()
    await ui.unmount()
  })
})

describe('ran and confirmed', () => {
  test('a ! bash-mode run marks the matching item ran', async ($, on) => {
    const w = await start($, on)
    await reply($, HANDOFF)
    await bang($, ' gh   pr merge 42 --squash --delete-branch')
    expect(w.stateOf(idOf(MERGE))).toBe('ran')
    expect(w.stateOf(idOf(TAG))).toBe('todo')
  })

  test('pasted terminal output that echoes the command marks it ran; a substring does not', async ($, on) => {
    const w = await start($, on)
    await $.command.run(run('add ls'))
    await reply($, HANDOFF)
    await say($, `done:\n$ git fetch origin && git tag v1.2.0 origin/main\nFrom github.com:acme/app\nalso fine`)
    expect(w.stateOf(idOf(TAG))).toBe('ran')
    expect(w.stateOf(idOf('ls'))).toBe('todo')
  })

  test('the context block lists pending items only while any are pending', async ($, on) => {
    const w = await start($, on)
    await say($, 'hi')
    expect(w.contexts[0]).toBeUndefined()
    await reply($, HANDOFF)
    await say($, 'ok')
    expect(w.contexts[1]).toEqual([
      `Commands you handed the user to run themselves, not yet verified:\n#${idOf(MERGE)} ${MERGE}\n#${idOf(TAG)} ${TAG}\nWhen you have verified one of these took effect, write [done #id] in your reply.`,
    ])
    await reply($, `Both landed. [done #${idOf(MERGE)}] [DONE #${idOf(TAG)}]`)
    expect(w.list().map(i => i.state)).toEqual(['confirmed', 'confirmed'])
    await say($, 'thanks')
    expect(w.contexts[2]).toBeUndefined()
  })
})

describe('band', () => {
  test('hidden with nothing pending, counts to-run and ran above the other rows', async ($, on) => {
    const w = await start($, on)
    let band = await $.ui.mount(BAND)
    expect((await band.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['core band'])
    await band.unmount()

    await reply($, HANDOFF)
    await $.command.run(run('add make deploy'))
    await bang($, MERGE)
    band = await $.ui.mount(BAND)
    expect((await band.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['handoff  ☐ 2 to run  ✓ 1 ran', 'core band'])
    await band.press({ key: 'handoff-open' })
    expect(w.opened).toEqual(['Handoff'])
    await band.unmount()
  })
})

describe('pane', () => {
  test('copy, check, dismiss, copy all and clear done', async ($, on) => {
    const w = await start($, on)
    await reply($, HANDOFF)
    await $.command.run(run('add make deploy'))
    await $.command.run(run())
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Text', text: 'To run (3)' })).toBeDefined()

    await ui.press({ key: `copy:${idOf(MERGE)}` })
    expect(w.copied).toEqual([MERGE])
    await ui.press({ key: 'copy-all' })
    expect(w.copied[1]).toBe(`${MERGE}\n${TAG}\nmake deploy`)

    await ui.press({ key: `check:${idOf(MERGE)}` })
    await ui.press({ key: `dismiss:${idOf(TAG)}` })
    expect(w.stateOf(idOf(MERGE))).toBe('done')
    expect(w.stateOf(idOf(TAG))).toBe('dismissed')
    expect(await ui.find({ type: 'Text', text: 'Done (1)' })).toBeDefined()

    await ui.press({ key: 'clear-done' })
    expect(w.list().map(i => [i.cmd, i.state])).toEqual([[TAG, 'dismissed'], ['make deploy', 'todo']])
    await ui.unmount()
  })
})

describe('store', () => {
  test('finished items are pruned after 7 days; pending ones stay', async ($, on) => {
    const w = await start($, on)
    await reply($, HANDOFF)
    await reply($, `[done #${idOf(MERGE)}]`)
    await w.clock.advance(KEEP_MS + 1)
    await $.command.run(run('add make deploy'))
    expect(w.list().map(i => i.cmd)).toEqual([TAG, 'make deploy'])
  })

  test('concurrent writes are serialized and lose nothing', async ($, on) => {
    const w = await start($, on)
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(c => $.command.run(run(`add make ${c}`))))
    expect(w.list().map(i => i.cmd).sort()).toEqual(['make a', 'make b', 'make c', 'make d', 'make e'])
  })
})
