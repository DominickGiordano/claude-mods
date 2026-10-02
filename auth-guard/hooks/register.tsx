import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register, ToolCallResult } from 'claude-code'

import type { Problem } from '../types'

type Signature = {
  provider: string
  label: string
  pattern: RegExp
  login: (command: string) => string[]
}

// "Confirmed" means seen in a real Bash result in ~/.claude/projects transcripts.
// The rest come from the CLI binaries' own strings and have not been seen firing.
export const SIGNATURES: readonly Signature[] = [
  {
    provider: 'aws',
    label: 'AWS SSO session expired',
    // Confirmed: the first and third. Unconfirmed: "The SSO session associated...".
    pattern:
      /Token has expired and refresh failed|The SSO session associated with this profile has expired|Error loading SSO Token/,
    login: command => withProfile(['aws', 'sso', 'login'], command),
  },
  {
    provider: 'aws',
    label: 'AWS login session expired',
    // Confirmed, and the most common AWS one: console-credential sessions from `aws login`.
    pattern: /Please reauthenticate using 'aws login'/,
    login: command => withProfile(['aws', 'login'], command),
  },
  {
    provider: 'gcloud',
    label: 'gcloud auth expired',
    // Confirmed, both.
    pattern: /Reauthentication required|There was a problem refreshing your current auth tokens/,
    login: () => ['gcloud', 'auth', 'login'],
  },
  {
    provider: 'infisical',
    label: 'Infisical login expired',
    // Unconfirmed: "Your login session has expired. Please run [infisical login]" and
    // "To login, run [infisical login]" are from the infisical binary.
    pattern: /run(?:ning)? \[infisical login\]/,
    login: () => ['infisical', 'login'],
  },
  {
    provider: 'gh',
    label: 'GitHub CLI login invalid',
    // Unconfirmed: from the gh binary. --clipboard because process.run captures
    // the device code gh prints, so the user would never see it.
    pattern:
      /HTTP 401: Bad credentials|(?:authenticating with|please run|log in, run|re-authenticate, run|Re-authenticate with):?\s+gh auth login/,
    login: () => ['gh', 'auth', 'login', '--web', '--clipboard'],
  },
]

const CHECKS: Record<string, readonly string[]> = {
  aws: ['aws', 'sts', 'get-caller-identity'],
  gcloud: ['gcloud', 'auth', 'print-access-token'],
  gh: ['gh', 'auth', 'status'],
  // Unconfirmed: what `login status` prints and exits with on an expired session.
  infisical: ['infisical', 'login', 'status'],
}

// Logins open a browser and wait for the person.
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const RETRY = 'Log in and retry'

const problems = atom({ plugin: 'auth-guard', key: 'problems' } as const, [] as readonly Problem[])

export function profileOf(command: string): string | undefined {
  return (
    /--profile[= ]['"]?([\w.@+-]+)/.exec(command)?.[1] ??
    /\bAWS_PROFILE=['"]?([\w.@+-]+)/.exec(command)?.[1]
  )
}

function withProfile(argv: string[], command: string): string[] {
  const profile = profileOf(command)
  return profile ? [...argv, '--profile', profile] : argv
}

export function detect(command: string, output: string) {
  for (const sig of SIGNATURES) {
    const match = sig.pattern.exec(output)
    // A command grepping for the message would otherwise trip on its own output.
    if (match && !command.includes(match[0])) {
      const login = sig.login(command)
      const profile = profileOf(command)
      const label = profile && login.includes('--profile') ? `${sig.label} (profile ${profile})` : sig.label
      return { provider: sig.provider, label, login }
    }
  }
  return undefined
}

type Answered = Exclude<ToolCallResult, { deny: string }>

function withContext(result: Answered, line: string): Answered {
  return { ...result, context: [...(result.context ?? []), line] }
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-3).join(' | ').slice(0, 300)
}

async function run($: EngineInterface, argv: readonly string[], timeoutMs: number): Promise<ProcessRunResult> {
  // A missing binary or a timeout rejects; report it the way a failed exit is.
  return $.process.run(argv, { timeoutMs }).catch((err: unknown) => ({
    exitCode: -1,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
    isStdoutTruncated: false,
    isStderrTruncated: false,
  }))
}

async function check($: EngineInterface, provider: string): Promise<Problem | null> {
  const argv = CHECKS[provider]
  if (!argv) return { provider, state: 'unknown provider' }
  const result = await run($, argv, 20_000)
  if (result.exitCode === 0) return null
  const found = detect('', `${result.stdout}\n${result.stderr}`)
  if (found?.provider !== provider) return { provider, state: 'check failed' }
  return { provider, state: 'expired', login: found.login }
}

async function preflight($: EngineInterface, providers: readonly string[]) {
  const rows = await Promise.all(providers.map(provider => check($, provider)))
  await update($, problems, () => rows.filter(row => row !== null))
}

async function loginFromBand($: EngineInterface, problem: Problem) {
  const setState = (state: Problem['state']) =>
    update($, problems, rows => rows.map(row => (row.provider === problem.provider ? { ...row, state } : row)))
  if (!problem.login) return
  await setState('logging in')
  const result = await run($, problem.login, LOGIN_TIMEOUT_MS)
  if (result.exitCode !== 0) {
    $.ui.toast(`auth-guard: ${problem.login.join(' ')} failed: ${tail(result.stderr || result.stdout)}`)
    await setState('login failed')
    return
  }
  const after = await check($, problem.provider)
  await update($, problems, rows =>
    rows.flatMap(row => (row.provider !== problem.provider ? [row] : after ? [after] : [])),
  )
}

export const register: Register = (on, options) => {
  const providers = (options.preflight ?? []) as readonly string[]

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // The vendored types declare no built-in tool inputs, so `e.command` is unknown.
    const command = typeof e.command === 'string' ? e.command : ''
    const first = await next(e)
    if (first.deny !== undefined) return first
    const found = detect(command, first.text ?? '')
    if (!found) return first

    const login = found.login.join(' ')
    if ((await $.session.surfaces()).length === 0) {
      return withContext(first, `auth-guard: ${found.label}; run \`${login}\``)
    }
    // Rejects when dismissed; that is a decline.
    const answer = await $.ui
      .ask(`${found.label}. Log in and retry?`, { header: 'auth', options: [RETRY, 'Return the error'] })
      .catch(() => undefined)
    if (answer !== RETRY) return first

    $.ui.toast(`auth-guard: running ${login}`)
    const result = await run($, found.login, LOGIN_TIMEOUT_MS)
    if (result.exitCode !== 0) {
      return withContext(
        first,
        `auth-guard: ${found.label}; \`${login}\` failed (exit ${result.exitCode}): ${tail(result.stderr || result.stdout)}`,
      )
    }
    const retried = await next(e)
    if (retried.deny !== undefined) return retried
    return withContext(retried, `auth-guard: the first run failed (${found.label}); logged in with \`${login}\` and ran it again`)
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Checks take seconds; a timer keeps them off the session's start.
    if (e.isInteractive && providers.length > 0) $.clock.after(0, () => void preflight($, providers))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const rows = await read($, problems)
    if (rows.length === 0 || e.props.hasSurvey) return below

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
              {row.login && row.state !== 'logging in' ? (
                <Button key={`login-${row.provider}`} label="Log in" onPress={() => loginFromBand($, row)} />
              ) : null}
            </Box>
          ))}
        </Box>
        {below}
      </Box>
    )
  })
}
