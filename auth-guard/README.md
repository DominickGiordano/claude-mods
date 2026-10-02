# auth-guard

When a Bash call fails on an expired CLI login, auth-guard asks before Claude sees the error:

> AWS SSO session expired (profile prod). Log in and retry?  [Log in and retry] [Return the error]

It fires only when the command itself runs that provider's CLI and the message is in an errored
result or the last 15 lines of output. Reading a file that mentions these errors doesn't trip it.

The login opens your browser (5 minute limit). What happens after depends on the command:

- **Read-only** (one simple command such as `aws s3 ls`, `aws ec2 describe-*`, `gcloud ... list`,
  `gh pr view`, `gh api` with GET): it re-runs once and Claude gets the new result.
- **Anything else** (chains, pipes, redirects, writes): it logs in and does not re-run. Claude is
  told the command was not re-run because it may repeat side effects.

If the login fails, Claude gets the original error with the failure appended. Two expired calls at
once share one login.

It tells you what to run instead of running it when:

- the login is `infisical login`, an interactive TUI;
- the command names several AWS profiles, or a profile held in a variable;
- `gh` got a 401 while `GH_TOKEN` or `GITHUB_TOKEN` is set, since that token wins over any login.

With no local terminal or desktop attached (`-p`, the SDK, mobile), nobody is asked. Claude gets a
one-line hint to ask you to run the login.

| Provider | Spotted by | Login |
|---|---|---|
| AWS SSO | `Token has expired and refresh failed`, `Error loading SSO Token`, `The SSO session associated with this profile has expired` | `aws sso login [--profile p]` |
| AWS console login | `Please reauthenticate using 'aws login'` | `aws login [--profile p]` |
| gcloud (`gcloud`, `gsutil`, `bq`) | `Reauthentication required`, `There was a problem refreshing your current auth tokens` | `gcloud auth login` |
| Infisical | `run [infisical login]` | you run `infisical login` |
| gh | `HTTP 401: Bad credentials`, `Try authenticating with: gh auth login` | `gh auth login --web --clipboard` |

The profile comes from `--profile` or `AWS_PROFILE=` in the failed command.

## Preflight

Set `preflight` to a list of providers (`aws`, `gcloud`, `gh`, `infisical`) to check them when a
session starts and every 10 minutes after. Rows show only for providers with a problem:

```
auth  ✗ aws expired 3m ago [Log in]  ? gh check failed just now [Why]  ? gcloud not installed just now
```
