# Jules settings reference

Settings resolve in this order: issue `julesSettings` override, agent adapter settings, then safe defaults. Repository identity and the default branch may also come from the Paperclip workspace. Startup fails before session creation when repository and branch metadata are incomplete or incompatible; diagnostics redact URL credentials and token-shaped values.

## Minimum configuration

With a Paperclip GitHub workspace whose provider metadata includes its default branch, no adapter fields are required. Without workspace metadata:

```json
{ "repository": "acme/widgets", "baseBranch": "main" }
```

`repository` is the canonical field. It accepts `owner/repo`, HTTPS GitHub URLs, and SSH GitHub URLs. Never configure credentials in it.

## Policy examples

Safe code-changing default (plan approval and PR when a remote exists):

```json
{ "planApprovalPolicy": "required", "prPolicy": "auto" }
```

Trusted automation with a shorter feedback loop:

```json
{ "planApprovalPolicy": "trusted_opt_out", "pollCadenceSeconds": 60, "progressVerbosity": "verbose" }
```

No-PR work:

```json
{ "prPolicy": "never" }
```

Completion then uses Paperclip's no-PR confirmation. `prPolicy: "always"` is rejected when no remote exists.

## Fields and bounds

| Field | Values / bounds | Safe default |
|---|---|---|
| `planApprovalPolicy` | `required`, `trusted_opt_out` | `required` |
| `prPolicy` | `auto`, `always`, `never` | `auto` |
| `pollCadenceSeconds` | 30–3600 | 300 |
| `requestTimeoutSeconds` | 5–300 | 30 |
| `retryBudget` | 0–10 | 3 |
| `sessionDeadlineMinutes` | 15–10080 | 360 |
| `progressVerbosity` | `quiet`, `normal`, `verbose` | `normal` |

## Compatibility migration

Legacy `source`, `requirePlanApproval`, `maxAutomaticRestarts`, and `pollIntervalSeconds` remain accepted and emit startup warnings. A legacy source such as `sources/github/acme/widgets` migrates to canonical `repository: "acme/widgets"`. When `source` and `repository` disagree, startup stops rather than silently changing repository intent.
