# Jules adapter operator runbook

## Release policy

The hardened path is disabled by default. Enable `PAPERCLIP_JULES_HARDENED=1` for named agents only. Observe at least three terminal runs (including one approval wait) before expanding. Default rollout requires the release matrix, sandbox trace, rollback drill, and a named Paperclip reviewer disposition.

## Readiness

Run the adapter environment test before opt-in. It verifies configuration, writes and removes a local-state probe, and makes only `GET /sessions?pageSize=1` against Jules. It never calls session creation. `local_state_unavailable` names the directory and repair; `jules_credentials_invalid` requires rotating/rebinding `JULES_API_KEY`.

## Operational response

- Credential failure: rotate the Paperclip secret binding, run readiness, then resume. Never paste a key in an issue or log.
- Rate limit: retain session state, honor `Retry-After`, and let the bounded retry schedule resume. Alert after 10 minutes or five retries.
- Stuck approval/feedback: inspect interaction age and confirm the referenced interaction is open. Alert at 30 minutes; at two hours page the issue owner. Do not approve on the operator's behalf.
- Expired/missing Jules session: move the issue to blocked with the session ID and recovery owner. Recreate only after confirming the prior session cannot resume.
- Missing PR: inspect Jules outputs. If work completed without a PR, use the no-PR completion confirmation; never mark done solely from terminal state.
- Restart recovery: verify the local state directory, resume the same Paperclip issue, and confirm the first poll advances from the persisted checkpoint.
- Safe replay: stop the opted-in agent, copy its state record, resume with the overlap cursor intact, and verify duplicate suppression. Never delete the state record while Jules is active.

## SLOs and alerts

| Signal | Target | Alert |
|---|---:|---:|
| API success latency p95 | < 5 s | p95 > 10 s for 15 min |
| Checkpoint lag p95 | < 10 min | > 20 min |
| Active wait interaction age | < 30 min | > 30 min warning; > 2 h page |
| Terminal outcome delivery | 99.9% within 10 min | any > 20 min |
| Duplicate Paperclip delivery | 0 | any occurrence |
| Readiness success | 99.9% | 3 consecutive failures |

Required structured fields are `event`, `paperclipIssueId`, `julesSessionId`, and `timestamp`; event fields cover latency/error class, pages/items, checkpoint lag, retries, wait duration, dedupe count, interaction age, and outcome. Credential-, token-, secret-, authorization-, password-, and prompt-keyed values are recursively redacted.

## Rollback drill

1. Set `PAPERCLIP_JULES_HARDENED=0` for the opted-in agent and stop new hardened sessions.
2. Leave active session records intact; allow the previous adapter path to resume by canonical session ID.
3. Run readiness and one read-only poll. Confirm no new Jules session was created and no duplicate Paperclip activity appeared.
4. Record issue/session IDs, checkpoint, dedupe count, and outcome in release evidence.
5. Re-enable only after the triggering alert is resolved and a reviewer approves expansion.
