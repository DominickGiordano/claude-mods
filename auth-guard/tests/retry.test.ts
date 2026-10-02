import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

const EXPIRED = 'Error loading SSO Token: Token for lumist does not exist'
const CALL = { tool: 'Bash', command: 'aws s3 ls --profile prod' } as const

type World = { bash: number; asks: string[]; runs: string[][] }

// Bash answers from `outputs` in order (the last repeats); the login exits `loginExit`.
function world(on: On, opts: { outputs: string[]; answer?: string | null; loginExit?: number; surfaces?: string[] }): World {
  const w: World = { bash: 0, asks: [], runs: [] }
  on('session.surfaces', () => ({ value: (opts.surfaces ?? ['terminal']) as never }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    w.asks.push(question)
    if (opts.answer === null) throw new Error('dismissed')
    return { result: { answers: { [question]: opts.answer ?? 'Return the error' } } }
  })
  on('process.run', (_$, e) => {
    w.runs.push([...e.argv])
    const exitCode = opts.loginExit ?? 0
    return { value: { exitCode, stdout: '', stderr: exitCode ? 'browser closed' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    const text = opts.outputs[Math.min(w.bash, opts.outputs.length - 1)]!
    w.bash += 1
    return { result: { stdout: text, stderr: '' }, text }
  })
  return w
}

describe('tool.call', () => {
  test('ordinary output passes through with no ask', async ($, on) => {
    const w = world(on, { outputs: ['ok'] })
    expect(await $.tool.call(CALL)).toEqual({ result: { stdout: 'ok', stderr: '' }, text: 'ok' })
    expect(w.asks).toEqual([])
  })

  test('login succeeds: the retry is returned, with a note', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED, 'bucket-a'], answer: 'Log in and retry' })
    const r = await $.tool.call(CALL)
    expect(w.asks).toEqual(['AWS SSO session expired (profile prod). Log in and retry?'])
    expect(w.runs).toEqual([['aws', 'sso', 'login', '--profile', 'prod']])
    expect(w.bash).toBe(2)
    expect(r.text).toBe('bucket-a')
    expect(r.context).toEqual([
      'auth-guard: the first run failed (AWS SSO session expired (profile prod)); logged in with `aws sso login --profile prod` and ran it again',
    ])
  })

  test('login fails: the original result, with the failure appended', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED], answer: 'Log in and retry', loginExit: 1 })
    const r = await $.tool.call(CALL)
    expect(w.bash).toBe(1)
    expect(r.text).toBe(EXPIRED)
    expect(r.context).toEqual([
      'auth-guard: AWS SSO session expired (profile prod); `aws sso login --profile prod` failed (exit 1): browser closed',
    ])
  })

  test('decline: the original result, no login', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED], answer: 'Return the error' })
    const r = await $.tool.call(CALL)
    expect(w.runs).toEqual([])
    expect(r).toEqual({ result: { stdout: EXPIRED, stderr: '' }, text: EXPIRED })
  })

  test('dismissed dialog counts as a decline', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED], answer: null })
    const r = await $.tool.call(CALL)
    expect(w.runs).toEqual([])
    expect(r.text).toBe(EXPIRED)
  })

  test('non-interactive: no ask, a hint for Claude', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED], surfaces: [] })
    const r = await $.tool.call(CALL)
    expect(w.asks).toEqual([])
    expect(w.runs).toEqual([])
    expect(r.context).toEqual(['auth-guard: AWS SSO session expired (profile prod); run `aws sso login --profile prod`'])
  })

  test('still expired after login: one retry, no loop', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED], answer: 'Log in and retry' })
    const r = await $.tool.call(CALL)
    expect(w.asks.length).toBe(1)
    expect(w.runs.length).toBe(1)
    expect(w.bash).toBe(2)
    expect(r.text).toBe(EXPIRED)
  })
})
