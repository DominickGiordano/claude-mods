import { describe, expect, test } from 'claude-code/testing'

import { detect, profileOf } from '../hooks/register'

describe('detect', () => {
  const cases: [string, string, string, string[]][] = [
    ['aws s3 ls', 'Error when retrieving token from sso: Token has expired and refresh failed', 'aws', ['aws', 'sso', 'login']],
    ['aws s3 ls', 'The SSO session associated with this profile has expired or is otherwise invalid.', 'aws', ['aws', 'sso', 'login']],
    ['aws s3 ls', 'Error loading SSO Token: Token for lumist does not exist', 'aws', ['aws', 'sso', 'login']],
    ['aws s3 ls', "Your session has expired. Please reauthenticate using 'aws login'.", 'aws', ['aws', 'login']],
    ['gcloud run jobs list', 'Reauthentication required.\nTraceback', 'gcloud', ['gcloud', 'auth', 'login']],
    [
      'gcloud logging read',
      'ERROR: (gcloud.logging.read) There was a problem refreshing your current auth tokens: Reauthentication failed.',
      'gcloud',
      ['gcloud', 'auth', 'login'],
    ],
    ['infisical secrets', 'Your login session has expired. Please run [infisical login]', 'infisical', ['infisical', 'login']],
    ['infisical run -- env', 'You must be logged in to run this command. To login, run [infisical login]', 'infisical', ['infisical', 'login']],
    ['gh pr list', 'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login', 'gh', ['gh', 'auth', 'login', '--web', '--clipboard']],
    ['gh auth status', 'The token in keyring is invalid.\n  - To re-authenticate, run: gh auth login -h github.com', 'gh', ['gh', 'auth', 'login', '--web', '--clipboard']],
  ]

  for (const [command, output, provider, login] of cases) {
    test(`${provider}: ${output.slice(0, 50)}`, () => {
      expect(detect(command, output)).toMatchObject({ provider, login })
    })
  }

  test('ordinary output is left alone', () => {
    expect(detect('ls', 'README.md\nsrc')).toBeUndefined()
    expect(detect('cat notes.md', 'run gh auth login once when you set up')).toBeUndefined()
  })

  test("a command grepping for the message doesn't trip on its own output", () => {
    expect(detect('rg "Error loading SSO Token" src', 'src/a.ts: Error loading SSO Token')).toBeUndefined()
  })

  test('the profile rides into the label and the login', () => {
    expect(detect('aws s3 ls --profile prod', 'Error loading SSO Token: x')).toEqual({
      provider: 'aws',
      label: 'AWS SSO session expired (profile prod)',
      login: ['aws', 'sso', 'login', '--profile', 'prod'],
    })
  })
})

describe('profileOf', () => {
  test('--profile flag', () => expect(profileOf('aws s3 ls --profile lumist-dev-admin')).toBe('lumist-dev-admin'))
  test('--profile= flag', () => expect(profileOf('aws s3 ls --profile=prod')).toBe('prod'))
  test('AWS_PROFILE prefix', () => expect(profileOf("AWS_PROFILE='prod' terraform plan")).toBe('prod'))
  test('none', () => expect(profileOf('aws s3 ls')).toBeUndefined())
})
