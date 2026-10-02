import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register, ToolCallResult } from 'claude-code'

import type { Problem } from '../types'

type Signature = {
  provider: string
  // The command words that count as invoking this provider.
  clis: readonly string[]
  label: string
  pattern: RegExp
  login: readonly string[]
  // infisical login is an interactive TUI; process.run has no terminal to give it.
  isManual?: true
}

// "Confirmed" means seen in a real Bash result in ~/.claude/projects transcripts.
// The rest come from the CLI binaries' own strings and have not been seen firing.
const SIGNATURES: readonly Signature[] = [
  // Confirmed: the first and third. Unconfirmed: "The SSO session associated...".
  { provider: 'aws', clis: ['aws'], label: 'AWS SSO session expired', login: ['aws', 'sso', 'login'],
    pattern: /Token has expired and refresh failed|The SSO session associated with this profile has expired|Error loading SSO Token/ },
  // Confirmed, and the most common AWS one: console-credential sessions from `aws login`.
  { provider: 'aws', clis: ['aws'], label: 'AWS login session expired', login: ['aws', 'login'],
    pattern: /Please reauthenticate using 'aws login'/ },
  // Confirmed, both.
  { provider: 'gcloud', clis: ['gcloud', 'gsutil', 'bq'], label: 'gcloud auth expired', login: ['gcloud', 'auth', 'login'],
    pattern: /Reauthentication required|There was a problem refreshing your current auth tokens/ },
  // Unconfirmed: "Your login session has expired. Please run [infisical login]" and
  // "To login, run [infisical login]" are from the infisical binary.
  { provider: 'infisical', clis: ['infisical'], label: 'Infisical login expired', login: ['infisical', 'login'], isManual: true,
    pattern: /run(?:ning)? \[infisical login\]/ },
  // Unconfirmed: from the gh binary. --clipboard because process.run captures
  // the device code gh prints, so the user would never see it.
  { provider: 'gh', clis: ['gh'], label: 'GitHub CLI login invalid', login: ['gh', 'auth', 'login', '--web', '--clipboard'],
    pattern: /HTTP 401: Bad credentials|(?:authenticating with|please run|log in, run|re-authenticate, run|Re-authenticate with):?\s+gh auth login/ },
]

const CHECKS: Record<string, readonly string[]> = {
  aws: ['aws', 'sts', 'get-caller-identity'],
  gcloud: ['gcloud', 'auth', 'print-access-token'],
  gh: ['gh', 'auth', 'status'],
  // A real subcommand (its --help says so); its exit code on an expired session is unconfirmed.
  infisical: ['infisical', 'login', 'status'],
}

const READ_ONLY: Record<string, (words: string[], args: string[]) => boolean> = {
  aws: ([service, op = '']) =>
    /^(describe|list|get)-/.test(op) || (service === 's3' && op === 'ls') || (service === 'sts' && op === 'get-caller-identity'),
  gcloud: words => words.some(word => word === 'list' || word === 'describe' || word === 'read'),
  gh: (words, args) =>
    words[0] === 'api' ? isGetApi(args) : words[0] === 'status' || ['list', 'view', 'status'].includes(words[1] ?? ''),
  infisical: ([first, second]) => first === 'export' || (first === 'secrets' && second === 'get'),
}

// Logins open a browser and wait for the person.
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const RECHECK_MS = 10 * 60 * 1000
const RETRY = 'Log in and retry'
const LOGIN = 'Log in'
const PREFIXES = new Set(['sudo', 'env', 'time', 'command', 'exec', 'nohup'])

const problems = atom({ plugin: 'auth-guard', key: 'problems' } as const, [] as readonly Problem[])
const inflight = new Map<string, Promise<ProcessRunResult>>()

type Parsed = { segments: string[][]; isSimple: boolean }

// Words per simple command, quotes removed. Not a shell parser: it only has to
// tell a real `aws ...` from one quoted inside a grep pattern.
export function parse(command: string): Parsed {
  const segments: string[][] = [[]]
  for (const [token] of command.matchAll(/(?:[^\s'";&|]|'[^']*'|"[^"]*")+|[;&|\n]/g)) {
    if (/^[;&|\n]$/.test(token)) segments.push([])
    else segments[segments.length - 1]!.push(token.replace(/'([^']*)'|"([^"]*)"/g, '$1$2'))
  }
  // Any operator, substitution or redirect makes it more than one simple command.
  const isSimple = segments.length === 1 && !/`|\$\(|[<>]/.test(command.replace(/'[^']*'/g, ''))
  return { segments: segments.filter(words => words.length > 0), isSimple }
}

function argsOf(words: string[]): string[] {
  let i = 0
  while (i < words.length && (PREFIXES.has(words[i]!) || /^\w+=/.test(words[i]!))) i++
  return words.slice(i)
}

// Arguments after the CLI that aren't flags. `--flag value` drops its value, so a
// boolean long flag drops the next word too: that can only hide a read-only verb.
function positionals(args: string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < args.length; i++) {
    const word = args[i]!
    if (!word.startsWith('-')) out.push(word)
    else if (word.startsWith('--') && !word.includes('=')) i++
  }
  return out
}

function isGetApi(args: string[]): boolean {
  return args.every((word, i) => {
    // Fields switch `gh api` to POST unless a method says otherwise; treat them as writes.
    if (/^(-f|-F|--field|--raw-field|--input)/.test(word)) return false
    const method = word === '-X' || word === '--method' ? args[i + 1] : /^(?:-X|--method=)(.+)$/.exec(word)?.[1]
    return method === undefined || method.toUpperCase() === 'GET'
  })
}

function profileOf(parsed: Parsed): { profile?: string; unsure?: string } {
  const found = new Set<string>()
  for (const words of parsed.segments) {
    words.forEach((word, i) => {
      const value =
        /^AWS_PROFILE=(.*)$/.exec(word)?.[1] ?? /^--profile=(.*)$/.exec(word)?.[1] ?? (word === '--profile' ? words[i + 1] : undefined)
      if (value !== undefined) found.add(value)
    })
  }
  const [profile, ...rest] = [...found]
  if (profile === undefined) return {}
  if (rest.length > 0) return { unsure: `the command names several profiles (${[...found].join(', ')})` }
  if (!/^\w[\w.@+-]*$/.test(profile)) return { unsure: `the profile is ${profile}, not a name` }
  return { profile }
}

export function detect(command: string, output: string, isError: boolean) {
  const parsed = parse(command)
  // A clean exit only counts when the message is near the end, where a CLI's own error lands.
  const text = isError ? output : output.split('\n').slice(-15).join('\n')
  for (const sig of SIGNATURES) {
    const calls = parsed.segments.map(argsOf).filter(args => sig.clis.includes(args[0]?.split('/').pop() ?? ''))
    if (calls.length === 0 || !sig.pattern.test(text)) continue
    const { profile, unsure } = sig.provider === 'aws' ? profileOf(parsed) : {}
    const call = calls[0]!
    return {
      sig,
      profile,
      unsure,
      label: profile ? `${sig.label} (profile ${profile})` : sig.label,
      argv: profile ? [...sig.login, '--profile', profile] : [...sig.login],
      isReadOnly: parsed.isSimple && calls.length === 1 && READ_ONLY[sig.provider]!(positionals(call), call),
    }
  }
  return undefined
}

type Found = NonNullable<ReturnType<typeof detect>>
type Answered = Exclude<ToolCallResult, { deny: string }>

function withContext(result: Answered, line: string): Answered {
  return { ...result, context: [...(result.context ?? []), line] }
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-3).join(' | ').slice(0, 300)
}

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`
}

// Logins open a browser on this machine; only a local terminal or desktop has one.
async function canOffer($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).some(surface => surface === 'terminal' || surface === 'desktop')
}

async function run($: EngineInterface, argv: readonly string[], timeoutMs: number): Promise<ProcessRunResult> {
  // A missing binary or a timeout rejects; report it as exit -1 with the reason.
  return $.process.run(argv, { timeoutMs }).catch((err: unknown) => {
    const stderr = err instanceof Error ? err.message : String(err)
    return { exitCode: -1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false }
  })
}

// One login per provider at a time; a second expired call waits on the first's.
function login($: EngineInterface, provider: string, argv: readonly string[]): Promise<ProcessRunResult> {
  const pending = inflight.get(provider)
  if (pending) return pending
  $.ui.toast(provider === 'gh' ? 'auth-guard: opening browser — gh code copied to clipboard' : 'auth-guard: waiting for browser login (up to 5 min)')
  const started = run($, argv, LOGIN_TIMEOUT_MS).finally(() => inflight.delete(provider))
  inflight.set(provider, started)
  return started
}

// Why auth-guard won't run the login itself, as a sentence for the user and Claude.
async function manualReason($: EngineInterface, found: Found): Promise<string | undefined> {
  if (found.unsure) return `${found.unsure}, so it won't guess: run \`${found.sig.login.join(' ')} --profile <name>\` in a terminal`
  if (found.sig.isManual) return `Run \`${found.argv.join(' ')}\` in a terminal`
  if (found.sig.provider !== 'gh') return undefined
  const name = (await $.env.get('GH_TOKEN')) ? 'GH_TOKEN' : (await $.env.get('GITHUB_TOKEN')) ? 'GITHUB_TOKEN' : undefined
  return name && `${name} is set and wins over any gh login, so logging in won't help: fix or unset it`
}

async function check($: EngineInterface, provider: string): Promise<Problem | null> {
  const argv = CHECKS[provider]
  const checkedAt = await $.clock.now()
  if (!argv) return { provider, state: 'unknown provider', checkedAt }
  const result = await run($, argv, 20_000)
  if (result.exitCode === 0) return null
  if (result.exitCode === -1 && /ENOENT|not found|no such file/i.test(result.stderr)) return { provider, state: 'not installed', checkedAt }
  const found = detect(argv.join(' '), `${result.stdout}\n${result.stderr}`, true)
  if (found?.sig.provider !== provider) {
    return { provider, state: 'check failed', checkedAt, detail: `exit ${result.exitCode}: ${tail(result.stderr || result.stdout)}` }
  }
  if (found.sig.isManual) return { provider, state: 'expired', checkedAt, detail: `run \`${found.argv.join(' ')}\` in a terminal` }
  return { provider, state: 'expired', checkedAt, login: found.argv }
}

async function refresh($: EngineInterface, providers: readonly string[]) {
  if (providers.length === 0 || !(await canOffer($))) return
  const rows = await Promise.all(providers.map(provider => check($, provider)))
  await update($, problems, old => [
    ...old.filter(row => !providers.includes(row.provider)),
    ...rows.filter(row => row !== null),
  ])
}

async function loginFromBand($: EngineInterface, problem: Problem) {
  if (!problem.login) return
  const setState = (state: Problem['state']) =>
    update($, problems, rows => rows.map(row => (row.provider === problem.provider ? { ...row, state } : row)))
  await setState('logging in')
  const result = await login($, problem.provider, problem.login)
  if (result.exitCode !== 0) {
    $.ui.toast(`auth-guard: ${problem.login.join(' ')} failed: ${tail(result.stderr || result.stdout)}`)
    await setState('login failed')
    return
  }
  await refresh($, [problem.provider])
}

export const register: Register = (on, options) => {
  const providers = (options.preflight ?? []) as readonly string[]

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // The vendored types declare no built-in tool inputs, so `e.command` is unknown.
    const command = typeof e.command === 'string' ? e.command : ''
    const first = await next(e)
    if (first.deny !== undefined) return first
    const found = detect(command, first.text ?? '', first.isError === true)
    if (!found) return first

    const cmd = found.argv.join(' ')
    if (!(await canOffer($))) {
      return withContext(first, `auth-guard: ${found.label}; ask the user to run \`${cmd}\` (it is interactive, don't run it yourself)`)
    }
    const manual = await manualReason($, found)
    if (manual) {
      await $.ui.ask(`${found.label}. ${manual}.`, { header: 'auth', options: ['OK', 'Dismiss'] }).catch(() => undefined)
      return withContext(first, `auth-guard: ${found.label}. The user was told: ${manual}`)
    }

    const retry = first.isReadOnly === true || found.isReadOnly
    if (!inflight.has(found.sig.provider)) {
      const offer = retry ? RETRY : LOGIN
      // Rejects when dismissed; that is a decline.
      const answer = await $.ui
        .ask(`${found.label}. ${offer}?`, { header: 'auth', options: [offer, 'Return the error'] })
        .catch(() => undefined)
      if (answer !== offer) return first
    }
    const result = await login($, found.sig.provider, found.argv)
    if (result.exitCode !== 0) {
      return withContext(first, `auth-guard: ${found.label}; \`${cmd}\` failed (exit ${result.exitCode}): ${tail(result.stderr || result.stdout)}`)
    }
    if (providers.includes(found.sig.provider)) await refresh($, [found.sig.provider])
    if (!retry) {
      return withContext(first, `auth-guard: logged in via \`${cmd}\`; command NOT re-run because it may repeat side effects — re-run it if safe`)
    }
    const retried = await next(e)
    if (retried.deny !== undefined) return retried
    return withContext(retried, `auth-guard: the first run failed (${found.label}); logged in via \`${cmd}\` and ran it again`)
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (providers.length === 0) return result
    // Checks take seconds; timers keep them off the session's start.
    $.clock.after(0, () => void refresh($, providers))
    $.clock.every(RECHECK_MS, () => void refresh($, providers))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const rows = await read($, problems)
    if (rows.length === 0 || e.props.hasSurvey) return below

    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>auth </Text>
          {rows.map(row => (
            <Box key={row.provider}>
              <Text color={row.state === 'logging in' ? undefined : 'red'}>
                {' '}
                {row.state === 'logging in' ? '…' : row.state === 'expired' ? '✗' : '?'} {row.provider} {row.state}{' '}
              </Text>
              <Text dimColor>{ago(now - row.checkedAt)} </Text>
              {row.login && row.state !== 'logging in' ? (
                <Button key={`login-${row.provider}`} label="Log in" onPress={() => loginFromBand($, row)} />
              ) : row.detail ? (
                <Button key={`why-${row.provider}`} label="Why" onPress={() => $.ui.toast(`auth-guard: ${row.provider} ${row.detail}`)} />
              ) : null}
            </Box>
          ))}
        </Box>
        {below}
      </Box>
    )
  })
}
