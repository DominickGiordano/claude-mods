import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const URL = 'https://github.com/o/r/pull/12'
const MINUTE = 60_000

type View = Record<string, unknown>

const ran = (exitCode: number, stdout: string, stderr: string) => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

const OPEN_GREEN: View = {
  number: 12, title: 'Add thing', state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  baseRefName: 'develop', headRefName: 'feature/x', url: URL,
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
}
const RUNNING: View = { ...OPEN_GREEN, mergeStateStatus: 'UNSTABLE', statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS', conclusion: '' }] }
const RED: View = { ...OPEN_GREEN, statusCheckRollup: [{ name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }, { context: 'ci/legacy', state: 'SUCCESS' }] }
const CONFLICTS: View = { ...OPEN_GREEN, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }
const MERGED: View = { ...OPEN_GREEN, state: 'MERGED', mergedAt: '2026-10-02T00:00:00Z' }

const BAND = {
  plugin: 'pr-watch', surface: 'terminal', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'pr-watch', surface: 'terminal', component: 'Pane', requestId: 'pr-watch',
  props: { title: 'PRs', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

// gh answers `pr view` with whatever `state.view` holds and `pr merge` with `state.merge`.
function world(on: On, view: View | string) {
  const state = { view, merge: ran(0, '', '') }
  const clock = mock.clock(on, { now: 100 * MINUTE })
  const runs: string[][] = []
  const toasts: string[] = []
  const prompts: string[] = []
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', () => ({ type: 'Text', children: ['other mod'] }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({ result: { stdout: `Creating pull request\n${URL}\n`, stderr: '', interrupted: false } }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.argv[2] === 'merge') return { value: state.merge }
    if (typeof state.view === 'string') return { value: ran(1, '', state.view) }
    const url = String(e.argv[3])
    return { value: ran(0, JSON.stringify({ ...state.view, url, number: Number(url.split('/').pop()) }), '') }
  })
  return { state, clock, runs, toasts, prompts }
}

async function opened($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', tool_use_id: 't1', command: 'gh pr create --base develop --fill' })
}

async function band($: Engine) {
  const ui = await $.ui.mount(BAND)
  const drawn = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
  const buttons = (await ui.findAll({ type: 'Button' })).map(b => b.key)
  return { ui, drawn, buttons }
}

describe('capture', () => {
  test('gh pr create output is tracked and viewed', async ($, on) => {
    const w = world(on, OPEN_GREEN)
    await opened($)
    expect(w.runs[0]?.slice(0, 4)).toEqual(['gh', 'pr', 'view', URL])
    expect((await band($)).drawn).toContain('#12 ✓ CI · mergeable')
  })

  test('other Bash commands track nothing', async ($, on) => {
    const w = world(on, OPEN_GREEN)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Bash', tool_use_id: 't1', command: `echo ${URL}` })
    expect(w.runs).toEqual([])
    expect((await band($)).drawn).toBe('other mod')
  })

  test('/prs add takes owner/repo#n, /prs drop removes it', async ($, on) => {
    world(on, OPEN_GREEN)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    const run = (args: string) => $.command.run({ command: 'prs', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(await run('add o/r#12')).toEqual({})
    expect((await band($)).drawn).toContain('#12')
    await run('drop 12')
    expect((await band($)).drawn).toBe('other mod')
  })

  test('/clear keeps the watched PRs', async ($, on) => {
    world(on, OPEN_GREEN)
    // The kit keeps $.state across /clear; a session empties it.
    let wiped = false
    on('session.end', ($, e) => {
      wiped = true
      return { sessionId: e.sessionId }
    })
    on('state.get', ($, e, next) => (wiped ? { value: { value: undefined, version: 0 } } : next(e)))
    on('state.set', ($, e, next) => {
      wiped = false
      return next(e)
    })
    await opened($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    expect((await band($)).drawn).toBe('other mod')
    await $.turn.start({ text: 'next', turnId: 'turn-1' })
    expect((await band($)).drawn).toContain('#12')
  })
})

describe('band', () => {
  const cases: [string, View, string][] = [
    ['running', RUNNING, '#12 ● CI running'],
    ['failed', RED, '#12 ✗ CI failed'],
    ['conflicts', CONFLICTS, '#12 ✗ conflicts'],
    ['merged', MERGED, '#12 merged'],
  ]
  for (const [name, view, text] of cases) {
    test(name, async ($, on) => {
      world(on, view)
      await opened($)
      expect((await band($)).drawn).toContain(text)
    })
  }

  test('colors follow state', async ($, on) => {
    const w = world(on, OPEN_GREEN)
    await opened($)
    const color = async () => (await (await $.ui.mount(BAND)).find({ type: 'Text', text: /#12/ }))?.props.color
    expect(await color()).toBe('green')
    w.state.view = RED
    await w.clock.advance(MINUTE)
    expect(await color()).toBe('red')
    w.state.view = RUNNING
    await w.clock.advance(MINUTE)
    expect(await color()).toBe('yellow')
  })

  test('keeps the other mods row below', async ($, on) => {
    world(on, OPEN_GREEN)
    await opened($)
    expect((await band($)).drawn).toContain('other mod')
  })

  test('a failed poll shows stale, never the last good value', async ($, on) => {
    const w = world(on, OPEN_GREEN)
    await opened($)
    w.state.view = 'error connecting to api.github.com'
    await w.clock.advance(MINUTE)
    await w.clock.advance(2 * MINUTE)
    const { drawn, buttons } = await band($)
    expect(drawn).toContain('#12 ? gh failed 2m ago')
    expect(drawn).not.toContain('mergeable')
    expect(buttons).toEqual([])
  })

  test('drops a merged PR 10 minutes after it merged', async ($, on) => {
    const w = world(on, OPEN_GREEN)
    await opened($)
    w.state.view = MERGED
    await w.clock.advance(MINUTE)
    await w.clock.advance(9 * MINUTE)
    expect((await band($)).drawn).toContain('#12 merged')
    await w.clock.advance(MINUTE)
    expect((await band($)).drawn).toBe('other mod')
  })
})

describe('merge', () => {
  test('Merge squashes, deletes the feature branch, and toasts', async ($, on) => {
    const w = world(on, OPEN_GREEN)
    await opened($)
    await (await $.ui.mount(BAND)).press({ key: 'merge-12' })
    expect(w.runs).toContainEqual(['gh', 'pr', 'merge', URL, '--squash', '--delete-branch'])
    expect(w.toasts).toContain('pr-watch: merged #12 into develop')
  })

  test('no --delete-branch when the head is develop', async ($, on) => {
    const w = world(on, { ...OPEN_GREEN, headRefName: 'develop', baseRefName: 'release' })
    await opened($)
    await (await $.ui.mount(BAND)).press({ key: 'merge-12' })
    expect(w.runs).toContainEqual(['gh', 'pr', 'merge', URL, '--squash'])
  })

  test('gh stderr reaches a toast', async ($, on) => {
    const w = world(on, OPEN_GREEN)
    w.state.merge = ran(1, '', 'Pull request is not mergeable')
    await opened($)
    await (await $.ui.mount(BAND)).press({ key: 'merge-12' })
    expect(w.toasts).toContain('pr-watch: merge #12 failed: Pull request is not mergeable')
  })

  test('base main gets no merge button, the pane says why', async ($, on) => {
    world(on, { ...OPEN_GREEN, baseRefName: 'main', headRefName: 'develop' })
    await opened($)
    expect((await band($)).buttons).toEqual([])
    const pane = await $.ui.mount(PANE)
    expect(await pane.findAll({ type: 'Button' })).toEqual([])
    expect(await pane.find({ type: 'Text', text: 'promotion: merge by hand' })).toBeDefined()
  })

  test('pane buttons carry digit hotkeys and failed check names', async ($, on) => {
    world(on, RED)
    await opened($)
    const pane = await $.ui.mount(PANE)
    expect((await pane.findAll({ type: 'Button' })).map(b => b.props.hotkey)).toEqual(['1', '2'])
    expect(await pane.find({ type: 'Text', text: 'failed: lint' })).toBeDefined()
  })

  test('merge when green waits for green, then merges once', async ($, on) => {
    const w = world(on, RUNNING)
    await opened($)
    await (await $.ui.mount(BAND)).press({ key: 'auto-12' })
    await w.clock.advance(MINUTE)
    expect(w.runs.filter(r => r[2] === 'merge')).toEqual([])
    w.state.view = OPEN_GREEN
    await w.clock.advance(MINUTE)
    expect(w.runs.filter(r => r[2] === 'merge')).toHaveLength(1)
    await w.clock.advance(MINUTE)
    expect(w.runs.filter(r => r[2] === 'merge')).toHaveLength(1)
  })

  test('merge when green cancels when checks fail', async ($, on) => {
    const w = world(on, RUNNING)
    await opened($)
    await (await $.ui.mount(BAND)).press({ key: 'auto-12' })
    w.state.view = RED
    await w.clock.advance(MINUTE)
    w.state.view = OPEN_GREEN
    await w.clock.advance(MINUTE)
    expect(w.runs.filter(r => r[2] === 'merge')).toEqual([])
    expect(w.toasts).toContain('pr-watch: #12 checks failed, merge when green cancelled')
  })
})

describe('nudge', () => {
  test('sent once when idle', async ($, on) => {
    const w = world(on, OPEN_GREEN)
    await opened($)
    w.state.view = MERGED
    await w.clock.advance(MINUTE)
    await w.clock.advance(MINUTE)
    expect(w.prompts).toEqual(['PR #12 (feature/x → develop) merged.'])
  })

  test('held while a turn runs, sent once it ends', async ($, on) => {
    const w = world(on, OPEN_GREEN)
    await opened($)
    await $.turn.start({ text: 'go', turnId: 'turn-1' })
    w.state.view = MERGED
    await w.clock.advance(MINUTE)
    expect(w.prompts).toEqual([])
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'turn-1', reason: 'answer' })
    await w.clock.advance(MINUTE)
    expect(w.prompts).toEqual(['PR #12 (feature/x → develop) merged.'])
  })

  test('several merges in one poll make one prompt', async ($, on) => {
    const w = world(on, OPEN_GREEN)
    await opened($)
    const other = 'https://github.com/o/r/pull/13'
    await $.command.run({ command: 'prs', args: `add ${other}`, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    w.state.view = MERGED
    await w.clock.advance(MINUTE)
    expect(w.prompts).toEqual(['PRs merged: #12 (feature/x → develop), #13 (feature/x → develop).'])
  })

  test('off when the nudge option is false', { options: { nudge: false } }, async ($, on) => {
    const w = world(on, OPEN_GREEN)
    await opened($)
    w.state.view = MERGED
    await w.clock.advance(MINUTE)
    expect(w.prompts).toEqual([])
  })
})
