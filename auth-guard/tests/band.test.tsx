import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'auth-guard',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const SSO = 'Error loading SSO Token: Token for lumist does not exist'

// `exits` maps an argv's first two words to exit codes in order (the last repeats).
function world(on: On, exits: Record<string, number[]>) {
  const runs: string[][] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    const key = e.argv.slice(0, 2).join(' ')
    const codes = exits[key] ?? [0]
    const seen = runs.filter(argv => argv.slice(0, 2).join(' ') === key).length
    const exitCode = codes[Math.min(seen - 1, codes.length - 1)]!
    return { value: { exitCode, stdout: '', stderr: exitCode ? SSO : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>another mod</Text>
  })
  return { runs, clock: mock.clock(on) }
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

describe('preflight band', () => {
  test('an expired provider gets a row above the band below; Log in clears it', { options: { preflight: ['aws', 'gh'] } }, async ($, on) => {
    const w = world(on, { 'aws sts': [255, 0] })
    await $.session.start(START)
    await w.clock.advance(1)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /aws expired/ }))).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /another mod/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /gh/ })).toBeUndefined()

    await ui.press({ key: 'login-aws' })
    expect(w.runs).toContainEqual(['aws', 'sso', 'login'])
    expect(await ui.find({ type: 'Text', text: /aws/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /another mod/ })).toBeDefined()
  })

  test('all fine: the band is left to the mods below', { options: { preflight: ['aws', 'gcloud'] } }, async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    await w.clock.advance(1)
    expect(w.runs.length).toBe(2)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /auth/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /another mod/ })).toBeDefined()
  })

  test('a check that fails for another reason says so, with no button', { options: { preflight: ['gh'] } }, async ($, on) => {
    const w = world(on, { 'gh auth': [1] })
    await $.session.start(START)
    await w.clock.advance(1)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /gh check failed/ })).toBeDefined()
    expect(await ui.find({ key: 'login-gh' })).toBeUndefined()
  })

  test('no preflight by default: nothing runs', async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    await w.clock.advance(1)
    expect(w.runs).toEqual([])
  })
})
