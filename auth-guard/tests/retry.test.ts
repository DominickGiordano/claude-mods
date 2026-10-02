import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const EXPIRED = 'Error loading SSO Token: Token for my-sso does not exist'
const READ = { tool: 'Bash', command: 'aws s3 ls --profile prod' } as const
const WRITE = { tool: 'Bash', command: 'aws s3 cp a.txt s3://b/a.txt --profile prod' } as const

type Opts = {
  outputs: string[]
  answer?: string | null
  loginExit?: number
  loginRejects?: true
  surfaces?: string[]
  env?: Record<string, string>
  // Holds every login until the test resolves it.
  gate?: Promise<void>
}

// Bash answers from `outputs` in order (the last repeats).
function world(on: On, opts: Opts) {
  const w = { bash: 0, asks: [] as string[], runs: [] as string[][], toasts: [] as string[] }
  on('session.surfaces', () => ({ value: (opts.surfaces ?? ['terminal']) as never }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('env.get', (_$, e) => ({ value: opts.env?.[e.name] }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    w.asks.push(question)
    if (opts.answer === null) throw new Error('dismissed')
    return { result: { answers: { [question]: opts.answer ?? 'Return the error' } } }
  })
  on('process.run', async (_$, e) => {
    w.runs.push([...e.argv])
    await opts.gate
    if (opts.loginRejects) return { deny: 'spawn aws ENOENT' }
    const exitCode = opts.loginExit ?? 0
    return { value: { exitCode, stdout: '', stderr: exitCode ? 'browser closed' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    const text = opts.outputs[Math.min(w.bash, opts.outputs.length - 1)]!
    w.bash += 1
    return { result: { stdout: text, stderr: '' }, text, isError: true as const }
  })
  return w
}

describe('tool.call', () => {
  test('ordinary output passes through with no ask', async ($, on) => {
    const w = world(on, { outputs: ['ok'] })
    expect((await $.tool.call(READ)).text).toBe('ok')
    expect(w.asks).toEqual([])
  })

  test('read-only command: login, then the retry is returned with a note', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED, 'bucket-a'], answer: 'Log in and retry' })
    const r = await $.tool.call(READ)
    expect(w.asks).toEqual(['AWS SSO session expired (profile prod). Log in and retry?'])
    expect(w.runs).toEqual([['aws', 'sso', 'login', '--profile', 'prod']])
    expect(w.toasts).toEqual(['auth-guard: waiting for browser login (up to 5 min)'])
    expect(w.bash).toBe(2)
    expect(r.text).toBe('bucket-a')
    expect(r.context).toEqual([
      'auth-guard: the first run failed (AWS SSO session expired (profile prod)); logged in via `aws sso login --profile prod` and ran it again',
    ])
  })

  test('command that may write: login, no re-run', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED, 'uploaded'], answer: 'Log in' })
    const r = await $.tool.call(WRITE)
    expect(w.asks).toEqual(['AWS SSO session expired (profile prod). Log in?'])
    expect(w.runs.length).toBe(1)
    expect(w.bash).toBe(1)
    expect(r.text).toBe(EXPIRED)
    expect(r.context).toEqual([
      'auth-guard: logged in via `aws sso login --profile prod`; command NOT re-run because it may repeat side effects — re-run it if safe',
    ])
  })

  test('chained command: login, no re-run', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED, 'ok'], answer: 'Log in' })
    await $.tool.call({ tool: 'Bash', command: 'aws s3 ls && aws s3 ls --profile x' })
    expect(w.runs.length).toBe(1)
    expect(w.bash).toBe(1)
  })

  test('login fails: the original result, with the failure appended', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED], answer: 'Log in and retry', loginExit: 1 })
    const r = await $.tool.call(READ)
    expect(w.bash).toBe(1)
    expect(r.text).toBe(EXPIRED)
    expect(r.context).toEqual(['auth-guard: AWS SSO session expired (profile prod); `aws sso login --profile prod` failed (exit 1): browser closed'])
  })

  test('login cannot start: reported as exit -1 with the reason', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED], answer: 'Log in and retry', loginRejects: true })
    const r = await $.tool.call(READ)
    expect(w.bash).toBe(1)
    expect(r.context?.[0]).toMatch(/^auth-guard: .*failed \(exit -1\): .*ENOENT/)
  })

  test('decline: the original result, no login', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED], answer: 'Return the error' })
    const r = await $.tool.call(READ)
    expect(w.runs).toEqual([])
    expect(r).toEqual({ result: { stdout: EXPIRED, stderr: '' }, text: EXPIRED, isError: true })
  })

  test('dismissed dialog counts as a decline', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED], answer: null })
    expect((await $.tool.call(READ)).text).toBe(EXPIRED)
    expect(w.runs).toEqual([])
  })

  for (const surfaces of [[], ['mobile']]) {
    test(`no local surface (${surfaces.join() || 'none'}): no ask, a hint for Claude`, async ($, on) => {
      const w = world(on, { outputs: [EXPIRED], surfaces })
      const r = await $.tool.call(READ)
      expect(w.asks).toEqual([])
      expect(w.runs).toEqual([])
      expect(r.context).toEqual([
        "auth-guard: AWS SSO session expired (profile prod); ask the user to run `aws sso login --profile prod` (it is interactive, don't run it yourself)",
      ])
    })
  }

  test('still expired after login: one retry, no loop', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED], answer: 'Log in and retry' })
    const r = await $.tool.call(READ)
    expect(w.asks.length).toBe(1)
    expect(w.runs.length).toBe(1)
    expect(w.bash).toBe(2)
    expect(r.text).toBe(EXPIRED)
  })

  test('two profiles: says so, runs nothing', async ($, on) => {
    const w = world(on, { outputs: [EXPIRED], answer: 'OK' })
    const r = await $.tool.call({ tool: 'Bash', command: 'aws s3 ls --profile dev; aws s3 ls --profile prod' })
    expect(w.runs).toEqual([])
    expect(w.asks[0]).toContain('several profiles (dev, prod)')
    expect(r.context?.[0]).toContain('run `aws sso login --profile <name>` in a terminal')
  })

  test('infisical: shows the command, runs nothing', async ($, on) => {
    const w = world(on, { outputs: ['Your login session has expired. Please run [infisical login]'], answer: 'OK' })
    const r = await $.tool.call({ tool: 'Bash', command: 'infisical export' })
    expect(w.runs).toEqual([])
    expect(w.asks).toEqual(['Infisical login expired. Run `infisical login` in a terminal.'])
    expect(r.context).toEqual(['auth-guard: Infisical login expired. The user was told: Run `infisical login` in a terminal'])
  })

  test("gh with GH_TOKEN set: login won't help, runs nothing", async ($, on) => {
    const w = world(on, { outputs: ['HTTP 401: Bad credentials'], answer: 'OK', env: { GH_TOKEN: 'x' } })
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr list' })
    expect(w.runs).toEqual([])
    expect(r.context?.[0]).toContain("GH_TOKEN is set and wins over any gh login, so logging in won't help")
  })

  test('gh: the toast says the code is on the clipboard', async ($, on) => {
    const w = world(on, { outputs: ['HTTP 401: Bad credentials', 'pr-1'], answer: 'Log in and retry' })
    expect((await $.tool.call({ tool: 'Bash', command: 'gh pr list' })).text).toBe('pr-1')
    expect(w.toasts).toEqual(['auth-guard: opening browser — gh code copied to clipboard'])
  })

  test('concurrent expired calls share one ask and one login', async ($, on) => {
    let open!: () => void
    const gate = new Promise<void>(resolve => (open = resolve))
    const w = world(on, { outputs: [EXPIRED, EXPIRED, 'a', 'b'], answer: 'Log in and retry', gate })
    const clock = mock.clock(on)
    const one = $.tool.call(READ)
    await clock.settle()
    const two = $.tool.call(READ)
    await clock.settle()
    expect(w.bash).toBe(2)
    open()
    const [r1, r2] = await Promise.all([one, two])
    expect(w.asks.length).toBe(1)
    expect(w.runs.length).toBe(1)
    expect([r1.text, r2.text].sort()).toEqual(['a', 'b'])
  })
})
