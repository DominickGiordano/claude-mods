# auth-guard

When a Bash call fails on an expired CLI login, auth-guard asks before Claude sees the error:

> AWS SSO session expired (profile prod). Log in and retry?  [Log in and retry] [Return the error]

**Log in and retry** runs the login (it opens your browser, 5 minute limit) and re-runs the command
once. Claude gets the retried result plus a note that it ran twice. If the login fails, Claude gets
the original error with the login failure appended. Under `-p` or the SDK nobody is asked; Claude
gets a one-line hint with the login command instead.

| Provider | Spotted by | Login |
|---|---|---|
| AWS SSO | `Token has expired and refresh failed`, `Error loading SSO Token`, `The SSO session associated with this profile has expired` | `aws sso login [--profile p]` |
| AWS console login | `Please reauthenticate using 'aws login'` | `aws login [--profile p]` |
| gcloud | `Reauthentication required`, `There was a problem refreshing your current auth tokens` | `gcloud auth login` |
| Infisical | `run [infisical login]` | `infisical login` |
| gh | `HTTP 401: Bad credentials`, `Try authenticating with: gh auth login` | `gh auth login --web --clipboard` |

The profile comes from `--profile` or an `AWS_PROFILE=` prefix in the failed command. The retry
re-runs the whole command, so a chain whose first steps succeeded runs them again.

## Preflight

Set `preflight` to a list of providers (`aws`, `gcloud`, `gh`, `infisical`) to check them when a
session starts. An expired one gets a band row with a Log in button:

```
auth  ✗ aws expired [Log in]
```

A check that fails for another reason shows `? aws check failed` with no button.
