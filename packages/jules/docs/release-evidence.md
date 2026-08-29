# Hardened Jules adapter release evidence

## Mock contract matrix

| Contract | Fixture/assertion | Gate |
|---|---|---|
| create and progress | execute integration + activity checkpoint tests | required |
| plan approval | execute interaction tests | required |
| user feedback | execute interaction tests | required |
| artifact / PR | execute and no-PR tests | required |
| completion/failure | state-machine and execute tests | required |
| restart/reorder/dedupe | checkpoint restart fixture | required |
| readiness/no creation | health tests | required |
| telemetry/redaction | telemetry tests | required |

## Controlled smoke trace template

Record one opted-in sandbox run as an inspectable Paperclip work product with: Paperclip issue ID, Jules session ID, timestamps for create → progress → plan approval → feedback → artifact/PR → completion, interaction IDs, PR/artifact link, checkpoint lag, dedupe count, terminal outcome, and rollback result. Secrets and sensitive prompts must be absent.

## Sandbox verification note

Perform the opted-in trace in a controlled sandbox.

## Release gates

- Mock matrix passes.
- Sandbox trace is attached and linked from the release issue.
- Rollback drill passes on the same opt-in cohort.
- At least three initial opt-in terminal runs are observed.
- A named Paperclip reviewer records approve/reject disposition.

Default rollout remains prohibited until all gates above have evidence.
