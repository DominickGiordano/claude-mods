import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'auth-guard',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const SSO = 'Error loading SSO Token: Token for my-sso does not exist'
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const TEN_MINUTES = 10 * 60 * 1000

type Answer = number | 'ENOENT'

// `answers` maps an argv's first two words to exit codes in order (the last repeats).
function world(on: On, answers: Record<string, Answer[]>, surfaces = ['terminal']) {
  const runs: string[][] = []
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: surfaces as never }))
  on('env.get', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    return { result: { answers: { [question]: 'Log in and retry' } } }
  })
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    const key = e.argv.slice(0, 2).join(' ')
    const codes = answers[key] ?? [0]
    const seen = runs.filter(argv => argv.slice(0, 2).join(' ') === key).length
    const answer = codes[Math.min(seen - 1, codes.length - 1)]!
    if (answer === 'ENOENT') return { deny: `spawn ${e.argv[0]} ENOENT` }
    return { value: { exitCode: answer, stdout: '', stderr: answer ? SSO : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>another mod</Text>
  })
  return { runs, toasts, clock: mock.clock(on) }
}

const BELOW = { type: 'Text', text: /another mod/ } as const

describe('preflight band', () => {
  test('an expired provider gets a row above the band below; Log in clears it', { options: { preflight: ['aws', 'gh'] } }, async ($, on) => {
    const w = world(on, { 'aws sts': [255, 0] })
    await $.session.start(START)
    await w.clock.advance(1)

    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /aws expired/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /just now/ })).toBeDefined()
    expect(await ui.find(BELOW)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /gh/ })).toBeUndefined()

    await ui.press({ key: 'login-aws' })
    expect(w.runs).toContainEqual(['aws', 'sso', 'login'])
    expect(await ui.find({ type: 'Text', text: /aws/ })).toBeUndefined()
    expect(await ui.find(BELOW)).toBeDefined()
  })

  test('all fine: the band is left to the mods below', { options: { preflight: ['aws', 'gcloud'] } }, async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    await w.clock.advance(1)
    expect(w.runs.length).toBe(2)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /auth/ })).toBeUndefined()
    expect(await ui.find(BELOW)).toBeDefined()
  })

  test('a check that fails for another reason: no Log in, Why shows the exit and stderr', { options: { preflight: ['gh'] } }, async ($, on) => {
    const w = world(on, { 'gh auth': [1] })
    await $.session.start(START)
    await w.clock.advance(1)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /gh check failed/ })).toBeDefined()
    expect(await ui.find({ key: 'login-gh' })).toBeUndefined()
    await ui.press({ key: 'why-gh' })
    expect(w.toasts).toEqual([`auth-guard: gh exit 1: ${SSO}`])
  })

  test('a CLI that will not start reads as not installed', { options: { preflight: ['gcloud'] } }, async ($, on) => {
    const w = world(on, { 'gcloud auth': ['ENOENT'] })
    await $.session.start(START)
    await w.clock.advance(1)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /gcloud not installed/ })).toBeDefined()
  })

  test('re-checks every 10 minutes, and the row says how old it is', { options: { preflight: ['aws'] } }, async ($, on) => {
    const w = world(on, { 'aws sts': [255, 255, 0] })
    await $.session.start(START)
    await w.clock.advance(1)
    const ui = await $.ui.mount(BAND)
    await w.clock.advance(3 * 60 * 1000)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /3m ago/ })).toBeDefined()
    await w.clock.advance(TEN_MINUTES)
    expect(w.runs.filter(argv => argv[0] === 'aws').length).toBe(2)
    await w.clock.advance(TEN_MINUTES)
    expect(await ui.find({ type: 'Text', text: /aws/ })).toBeUndefined()
  })

  test("a login from a Bash call clears the provider's stale row", { options: { preflight: ['aws'] } }, async ($, on) => {
    const w = world(on, { 'aws sts': [255, 0] })
    let bash = 0
    on('tool.call', { tool: 'Bash' }, () => {
      const text = bash++ === 0 ? SSO : 'bucket-a'
      return { result: { stdout: text, stderr: '' }, text, isError: true as const }
    })
    await $.session.start(START)
    await w.clock.advance(1)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /aws expired/ })).toBeDefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'aws s3 ls' })).text).toBe('bucket-a')
    expect(await ui.find({ type: 'Text', text: /aws/ })).toBeUndefined()
  })

  test('no local surface: no checks', { options: { preflight: ['aws'] } }, async ($, on) => {
    const w = world(on, {}, [])
    await $.session.start(START)
    await w.clock.advance(1)
    expect(w.runs).toEqual([])
  })

  test('no preflight by default: nothing runs', async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    await w.clock.advance(TEN_MINUTES + 1)
    expect(w.runs).toEqual([])
  })
})
