import { describe, expect, test } from 'claude-code/testing'

import { detect } from '../hooks/register'

const SSO = 'Error loading SSO Token: Token for my-sso does not exist'

describe('detect: each signature', () => {
  const cases: [string, string, string, string[]][] = [
    ['aws s3 ls', 'Error when retrieving token from sso: Token has expired and refresh failed', 'aws', ['aws', 'sso', 'login']],
    ['aws s3 ls', 'The SSO session associated with this profile has expired or is otherwise invalid.', 'aws', ['aws', 'sso', 'login']],
    ['aws s3 ls', SSO, 'aws', ['aws', 'sso', 'login']],
    ['aws s3 ls', "Your session has expired. Please reauthenticate using 'aws login'.", 'aws', ['aws', 'login']],
    ['gcloud run jobs list', 'Reauthentication required.\nTraceback', 'gcloud', ['gcloud', 'auth', 'login']],
    ['gsutil ls gs://b', 'Reauthentication required.', 'gcloud', ['gcloud', 'auth', 'login']],
    [
      'gcloud logging read x',
      'ERROR: (gcloud.logging.read) There was a problem refreshing your current auth tokens: Reauthentication failed.',
      'gcloud',
      ['gcloud', 'auth', 'login'],
    ],
    ['infisical secrets', 'Your login session has expired. Please run [infisical login]', 'infisical', ['infisical', 'login']],
    ['infisical run -- env', 'You must be logged in to run this command. To login, run [infisical login]', 'infisical', ['infisical', 'login']],
    ['gh pr list', 'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login', 'gh', ['gh', 'auth', 'login', '--web', '--clipboard']],
    ['gh auth status', 'The token in keyring is invalid.\n  - To re-authenticate, run: gh auth login -h github.com', 'gh', ['gh', 'auth', 'login', '--web', '--clipboard']],
  ]
  for (const [command, output, provider, argv] of cases) {
    test(`${provider}: ${output.slice(0, 50)}`, () => {
      expect(detect(command, output, true)).toMatchObject({ sig: { provider }, argv })
    })
  }
})

describe('detect: the gate', () => {
  test('ordinary output is left alone', () => expect(detect('aws s3 ls', 'bucket-a\nbucket-b', true)).toBeUndefined())

  test('a file holding the strings, read with cat, git diff or grep: no match', () => {
    expect(detect('cat notes.md', SSO, true)).toBeUndefined()
    expect(detect('git diff', `+ ${SSO}`, false)).toBeUndefined()
    expect(detect('grep -rn "Error loading SSO" src', `src/a.ts:3: ${SSO}`, true)).toBeUndefined()
  })

  test('the CLI named inside a quoted grep pattern is not an invocation', () => {
    expect(detect('rg "aws s3 ls" docs', `docs/x.md: aws s3 ls\n${SSO}`, true)).toBeUndefined()
  })

  test('a chained command with a clean exit still matches near the end', () => {
    const output = `=== dev ===\nbucket-a\n=== prod ===\n${SSO}`
    expect(detect('aws s3 ls; echo "=== prod ==="; aws s3 ls --profile prod', output, false)).toMatchObject({ sig: { provider: 'aws' } })
  })

  test('a clean exit with the message far from the end does not match', () => {
    const output = [SSO, ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join('\n')
    expect(detect('aws s3 ls', output, false)).toBeUndefined()
    expect(detect('aws s3 ls', output, true)).toBeDefined()
  })

  test('gh 401 only when the command invokes gh', () => {
    expect(detect('curl https://api.github.com', 'HTTP 401: Bad credentials', true)).toBeUndefined()
  })
})

describe('detect: profiles', () => {
  const of = (command: string) => detect(command, SSO, true)
  test('--profile flag', () =>
    expect(of('aws s3 ls --profile dev-admin')).toMatchObject({ profile: 'dev-admin', argv: ['aws', 'sso', 'login', '--profile', 'dev-admin'], label: 'AWS SSO session expired (profile dev-admin)' }))
  test('--profile= flag', () => expect(of('aws s3 ls --profile=prod')?.profile).toBe('prod'))
  test('AWS_PROFILE prefix', () => expect(of("AWS_PROFILE='prod' aws s3 ls")?.profile).toBe('prod'))
  test('none', () => expect(of('aws s3 ls')).toMatchObject({ profile: undefined, unsure: undefined, argv: ['aws', 'sso', 'login'] }))
  test('two profiles: unsure, no guess', () =>
    expect(of('aws s3 ls --profile dev; aws s3 ls --profile prod')).toMatchObject({ profile: undefined, unsure: 'the command names several profiles (dev, prod)' }))
  test('a variable: unsure', () => expect(of('aws s3 ls --profile "$P"')?.unsure).toBe('the profile is $P, not a name'))
})

describe('detect: read-only', () => {
  const ro = (command: string, provider = 'aws') =>
    detect(command, provider === 'gh' ? 'HTTP 401: Bad credentials' : provider === 'gcloud' ? 'Reauthentication required' : SSO, true)?.isReadOnly
  test('aws reads', () => {
    expect(ro('aws s3 ls')).toBe(true)
    expect(ro('aws --profile prod ec2 describe-instances')).toBe(true)
    expect(ro('aws sts get-caller-identity')).toBe(true)
  })
  test('aws writes', () => {
    expect(ro('aws s3 cp a s3://b/a')).toBe(false)
    expect(ro('aws ec2 terminate-instances --instance-ids i-1')).toBe(false)
  })
  test('chains, pipes, redirects and substitutions are never read-only', () => {
    expect(ro('aws s3 ls && aws s3 ls')).toBe(false)
    expect(ro('aws s3 ls | head')).toBe(false)
    expect(ro('aws s3 ls > out.txt')).toBe(false)
    expect(ro('aws s3 ls "$(cat b)"')).toBe(false)
  })
  test('gcloud', () => {
    expect(ro('gcloud run services describe api', 'gcloud')).toBe(true)
    expect(ro('gcloud run deploy api', 'gcloud')).toBe(false)
  })
  test('gh', () => {
    expect(ro('gh pr list', 'gh')).toBe(true)
    expect(ro('gh api repos/o/r', 'gh')).toBe(true)
    expect(ro('gh api -X POST repos/o/r/issues', 'gh')).toBe(false)
    expect(ro('gh api repos/o/r/issues -f title=x', 'gh')).toBe(false)
    expect(ro('gh pr merge 3', 'gh')).toBe(false)
  })
})
