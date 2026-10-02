import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Item } from '../hooks/register'
import { KEEP_MS, PREFIX, echoes, handoffs, hash } from '../hooks/register'

const NOW = 1_000_000_000
const HOUR = 3_600_000
const ROOT = '/src/acme'
const idOf = (cmd: string, root = ROOT) => hash(`${root}\n${cmd}`)

const MERGE = 'gh pr merge 42 --squash \\\n  --delete-branch'
const LOOP = 'for f in build/*.log; do\n  gzip "$f"\ndone\ncat > .env <<EOF\nA=1\n\nB=2\nEOF'
const HANDOFF = [
  'Auto mode blocks the merge, so this one is yours:',
  '',
  '```handoff',
  '# merge the release PR',
  MERGE,
  '```',
  '',
  'And the cleanup, labelled by its first line:',
  '',
  '~~~handoff',
  LOOP,
  '~~~',
].join('\n')

const BAND = {
  plugin: 'handoff', surface: 'terminal', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'handoff', surface: 'terminal', component: 'Pane', requestId: 'handoff',
  props: { title: 'Handoff', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const run = (args = '') => ({ command: 'handoff', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as const

function world(on: On) {
  const w = {
    root: ROOT,
    broken: false,
    store: new Map<string, unknown>(),
    contexts: [] as (readonly string[] | undefined)[],
    copied: [] as string[],
    toasts: [] as string[],
    opened: [] as string[],
    clock: mock.clock(on, { now: NOW }),
    list: (root = ROOT) => (w.store.get(PREFIX + hash(root)) ?? []) as Item[],
    stateOf: (cmd: string) => w.list().find(i => i.cmd === cmd)?.state,
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
    if (w.broken) throw new Error('EACCES')
    return { value: w.store.get(e.key) }
  })
  on('store.set', async ($, e) => {
    await Promise.resolve()
    if (w.broken) throw new Error('EACCES')
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('ui.log', () => ({ value: undefined }))
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

const reply = ($: Engine, answer: string, reason: 'answer' | 'aborted' | 'error' = 'answer') =>
  $.turn.complete({ answer, durationMs: 1000, isAborted: reason === 'aborted', turnId: 't1', reason })
const say = ($: Engine, text: string, kind: 'composer' | 'task-notification' = 'composer') => $.prompt.submit({ text, wait: false, origin: { kind } })
const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

describe('capture', () => {
  test('handoff fences of every spelling, each block whole, labelled by comment or first line', () => {
    expect(handoffs(HANDOFF)).toEqual([
      { cmd: MERGE, label: 'merge the release PR' },
      { cmd: LOOP, label: 'for f in build/*.log; do' },
    ])
    expect(handoffs('````handoff\n# log in\ngh auth login\n````')).toEqual([{ cmd: 'gh auth login', label: 'log in' }])
  })

  test('plain shell blocks are not captured', () => {
    expect(handoffs('Run this yourself:\n\n```bash\ngh auth login\n```\n\n```sh\nmake\n```')).toEqual([])
  })

  test('turn.complete stores the session repo; aborted, errored and subagent turns are skipped', async ($, on) => {
    const w = await start($, on)
    await reply($, HANDOFF, 'aborted')
    await reply($, HANDOFF, 'error')
    await $.turn.complete({ answer: HANDOFF, durationMs: 1, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'a1' })
    expect(w.list()).toEqual([])
    await reply($, HANDOFF)
    expect(w.list()[0]).toEqual({ id: idOf(MERGE), cmd: MERGE, label: 'merge the release PR', repo: 'acme', root: ROOT, createdAt: NOW, state: 'todo', updatedAt: NOW })
    expect(w.list()).toHaveLength(2)
    expect(idOf(MERGE).length).toBeGreaterThanOrEqual(8)
  })

  test('re-handing: ran reopens to todo, dismissed stays dismissed, nothing duplicates', async ($, on) => {
    const w = await start($, on)
    await reply($, HANDOFF)
    await say($, `~/src/acme ❯ ${MERGE}\nMerged`)
    expect(w.stateOf(MERGE)).toBe('ran')
    await $.command.run(run())
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: `dismiss:${idOf(LOOP)}` })
    await ui.unmount()
    await reply($, HANDOFF)
    expect(w.list().map(i => i.state)).toEqual(['todo', 'dismissed'])
  })

  test('the fence instruction rides the first person prompt of each conversation', async ($, on) => {
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    const w = await start($, on)
    await say($, 'tick', 'task-notification')
    await say($, 'hi')
    await say($, 'again')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await say($, 'fresh')
    expect(w.contexts.map(c => c?.map(t => t.includes('```handoff')))).toEqual([undefined, [true], undefined, [true]])
  })
})

describe('ran', () => {
  test('a pasted terminal line marks ran, with ❯ or $, continuations normalized', () => {
    expect(echoes(`~/src/acme ❯ gh pr merge 42 --squash --delete-branch\n✓ Merged`, MERGE)).toBe(true)
    expect(echoes(`$ gh pr merge 42 --squash \\\n    --delete-branch`, MERGE)).toBe(true)
    expect(echoes('root@box:/srv# for f in build/*.log; do', LOOP)).toBe(true)
  })

  test('a plain mention is not a run', () => {
    expect(echoes('should I run gh pr merge 42 --squash --delete-branch now?', MERGE)).toBe(false)
    expect(echoes('gh pr merge 42 --squash --delete-branch', MERGE)).toBe(false)
  })

  test('only a person-origin prompt marks ran', async ($, on) => {
    const w = await start($, on)
    await reply($, HANDOFF)
    await say($, `$ ${MERGE}`, 'task-notification')
    expect(w.stateOf(MERGE)).toBe('todo')
    await say($, `$ ${MERGE}`)
    expect(w.stateOf(MERGE)).toBe('ran')
  })
})

describe('context and confirm', () => {
  test('person prompts carry the 5 newest pending items under 48h; none when nothing pending', async ($, on) => {
    const w = await start($, on)
    await say($, 'hi')
    await say($, 'nothing pending')
    expect(w.contexts.at(-1)).toBeUndefined()
    await $.command.run(run('add make old'))
    await w.clock.advance(49 * HOUR)
    for (const n of [1, 2, 3, 4, 5, 6]) {
      await $.command.run(run(`add make ${n}`))
      await w.clock.advance(1000)
    }
    await say($, 'ok')
    expect(w.contexts.at(-1)).toEqual([
      [6, 5, 4, 3, 2].map(n => `#${idOf(`make ${n}`)} make ${n}`).join('\n') + '\nIf you verify a handoff took effect, write [done #id].',
    ])
    await say($, 'tick', 'task-notification')
    expect(w.contexts.at(-1)).toBeUndefined()
  })

  test('[done #id] counts in prose, not in code', async ($, on) => {
    const w = await start($, on)
    await reply($, HANDOFF)
    await reply($, `Example: \`[done #${idOf(LOOP)}]\`\n\n\`\`\`\n[done #${idOf(LOOP)}]\n\`\`\`\n\nThe merge landed. [done #${idOf(MERGE)}]`)
    expect(w.stateOf(MERGE)).toBe('confirmed')
    expect(w.stateOf(LOOP)).toBe('todo')
  })
})

describe('band and pane', () => {
  test('band hidden with nothing pending; counts above the other rows; Open opens', async ($, on) => {
    const w = await start($, on)
    let band = await $.ui.mount(BAND)
    expect(await texts(band)).toEqual(['core band'])
    await band.unmount()
    await reply($, HANDOFF)
    await say($, `$ ${MERGE}`)
    band = await $.ui.mount(BAND)
    expect(await texts(band)).toEqual(['handoff  ☐ 1 to run  ✓ 1 ran', 'core band'])
    await band.press({ key: 'handoff-open' })
    expect(w.opened).toEqual(['Handoff'])
    await band.unmount()
  })

  test('copy is verbatim; check, dismiss, collapsed dismissed group, clear done clears both', async ($, on) => {
    const w = await start($, on)
    await reply($, HANDOFF)
    await $.command.run(run('add make deploy'))
    await $.command.run(run())
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: `copy:${idOf(LOOP)}` })
    await ui.press({ key: 'copy-all' })
    expect(w.copied).toEqual([LOOP, `${MERGE}\n${LOOP}\nmake deploy`])

    await ui.press({ key: `check:${idOf(MERGE)}` })
    await ui.press({ key: `dismiss:${idOf(LOOP)}` })
    expect([w.stateOf(MERGE), w.stateOf(LOOP)]).toEqual(['done', 'dismissed'])
    expect(await ui.find({ type: 'Text', text: 'Done (1)' })).toBeDefined()
    expect(await ui.find({ key: `copy:${idOf(LOOP)}` })).toBeUndefined()
    await ui.press({ key: 'toggle-dismissed' })
    expect(await ui.find({ key: `copy:${idOf(LOOP)}` })).toBeDefined()

    await ui.press({ key: 'clear-done' })
    expect(w.list().map(i => i.cmd)).toEqual(['make deploy'])
    await ui.unmount()
  })

  test('/handoff all lists every repo and offers no copy all', async ($, on) => {
    const w = await start($, on)
    await reply($, HANDOFF)
    w.root = '/src/widgets'
    await $.command.run(run('add make deploy'))
    expect(w.list('/src/widgets').map(i => i.cmd)).toEqual(['make deploy'])
    await $.command.run(run('all'))
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Text', text: `widgets · #${idOf('make deploy', '/src/widgets')}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `acme · #${idOf(MERGE)}` })).toBeDefined()
    expect(await ui.find({ key: 'copy-all' })).toBeUndefined()
    await ui.unmount()
  })

  test('an unknown subcommand gets usage', async ($, on) => {
    const w = await start($, on)
    await $.command.run(run('bogus'))
    expect(w.toasts).toEqual(['handoff: usage /handoff [add <cmd> | all]'])
    expect(w.opened).toEqual([])
  })
})

describe('store', () => {
  test('a failing store toasts once and marks the band stale', async ($, on) => {
    const w = await start($, on)
    await reply($, HANDOFF)
    w.broken = true
    await say($, 'hi')
    await $.command.run(run('add make x'))
    // A test hook that throws is skipped, so the error the mod sees is the kit's, not EACCES.
    expect(w.toasts).toEqual([expect.stringContaining('handoff: store unavailable: ')])
    const band = await $.ui.mount(BAND)
    expect(await texts(band)).toEqual(['handoff: store unavailable  (last seen ☐ 2 to run)', 'core band'])
    await band.unmount()
  })

  test('malformed stored items are skipped', async ($, on) => {
    const w = world(on)
    w.store.set(PREFIX + hash(ROOT), [{ id: 'x' }, { id: 'abcdefgh', cmd: 'make', label: 'make', repo: 'acme', root: ROOT, createdAt: NOW, state: 'todo', updatedAt: NOW }])
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const band = await $.ui.mount(BAND)
    expect(await texts(band)).toEqual(['handoff  ☐ 1 to run', 'core band'])
    await band.unmount()
  })

  test('finished items are pruned after 7 days; pending ones stay', async ($, on) => {
    const w = await start($, on)
    await reply($, HANDOFF)
    await reply($, `[done #${idOf(MERGE)}]`)
    await w.clock.advance(KEEP_MS + 1)
    await $.command.run(run('add make deploy'))
    expect(w.list().map(i => i.cmd)).toEqual([LOOP, 'make deploy'])
  })

  test('concurrent writes are serialized and lose nothing', async ($, on) => {
    const w = await start($, on)
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(c => $.command.run(run(`add make ${c}`))))
    expect(w.list().map(i => i.cmd).sort()).toEqual(['make a', 'make b', 'make c', 'make d', 'make e'])
  })
})
