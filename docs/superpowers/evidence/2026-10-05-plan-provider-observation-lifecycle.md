# Native plan provider-observation lifecycle

## Approved scope

The operator approved the lifecycle fix and explicitly required MAZ-1650 and
MAZ-1740 to converge through adapter code, rather than manual issue recovery.
Their original provider sessions, plan revisions, and native children remain
the workflow identities. User task-start and merge approvals remain unchanged.

## Root cause and reproduction

Both recorded provider creates included `requirePlanApproval: true`. The only
non-GET provider request in their recorded parent runs was session creation.
After Luna approved, the original strong child was created in backlog. A later
GET reported IN_PROGRESS with a plan-only history and no approval journal.
The pre-verdict guard returned `native_child_plan_provider_state_conflict`,
which Paperclip converted to a legacy execution recovery hold. That stopped
polling before the provider reported outputless COMPLETED and prevented the
strong child from being activated. The provider's unexplained transition is
not itself evidence that approval or implementation took place.

The real Paperclip 2026.916.0 red contract reproduced exactly this chain:
`/home/leanid/.local/state/agent-output/run-hpg41a80/stderr.log`.
The unit red run was `run-aa3f6559583f` (three expected failures).

## Fix

- Outputless unapproved IN_PROGRESS is an explicit `observe_provider` decision.
  It permits native review coordination, but no provider approval/revision write.
- `planProviderObservation` records the exact session, activity, revision, first
  and latest observation times. The normal durable monitor retains the existing
  continuation cadence and configured session deadline.
- Provider state/outputs are read after the final complete activity scan before
  verdict-driven mutations. Returned session identity and cancellation are checked.
- A started approval plus generic progress is not confirmation. The exact
  `planApproved` activity must match the provider plan and persisted attempt.
  The older pending-native checkpoint path also retains the typed verdict
  boundary and only schedules its observation monitor once Jules owns the issue.
- Legacy migration validates the exact failed run and host task-session row,
  original provider and plan-document revision, child descriptor, and absence of
  an uncertain mutation. Retained cards require exact native target/key and
  succeeded, child-scoped source/resolver provenance. Active or uncertain child
  executions prevent migration. The mirroring cursor is not treated as a plan ID.
- Normal orchestrator reconciliation uses the existing typed recovery API and
  retains `actionOutcome: mixed`; it does not infer effects absent from logs.
  It validates the returned owner/run/action receipt before reporting convergence.
  The existing loopback local-trusted orchestrator transport is unchanged; no
  new credential fallback or host patch was introduced.

## Verification

The initial autonomous drift probe passed through PR producer, both native PR
reviews, the pending user merge gate, and restart of that wait, with one provider
create, one approval, and zero observation-driver mutations:
`/tmp/paperclip-plan-drift-green-report.json`.

The initial sequential matrix passed all five lanes:
`/tmp/paperclip-plan-observation-contracts/status.json`:

1. 2026.916.0 legacy observation-hold migration.
2. 2026.916.0 provider drift and restart.
3. 2026.1001.0 legacy observation-hold migration.
4. 2026.1001.0 provider drift and restart.
5. 2026.916.0 lost approval response, without replay.

Final reviewed builds are qualified separately in
`/tmp/paperclip-plan-observation-final/status.json`: all four baseline/candidate
drift and legacy-migration lanes passed. The new CI lanes are mandatory
on both supported host versions. The legacy lane deploys a corrected private
package over an actual old-behavior host hold; the driver sends no rescue request.

Review-discovered regressions were tested red before fixing: legacy generic
progress confirmation, state drift/cancellation during the final history scan,
generic activity cursors, and bootstrap-owned pending native cards.

`pnpm -r build` and the final focused suites passed. Mandatory commit hooks
rechecked the final build and all 2,267 workspace tests successfully
(`run-b91770e79a0a`). An older restart fixture was corrected to supply a real
same-plan approval activity instead of expecting generic progress to confirm it.
`pnpm typecheck:invariants` passed. Required ADK doctor/blast-radius checks
reported a stale Codanna index; source and call-site evidence was inspected
directly. Backlog validation still reports the ten pre-existing historical
plan frontmatter failures.

## Live automatic convergence

The journaled restart loaded the required Jules and orchestrator `dist/index.js`
packages. The wrapper's verification wait timed out after restart acknowledgement;
GET-only verification continued without another restart. Orchestrator heartbeat
`8b8c2db1-982b-4e30-8a24-fb0dfff7d2b4` succeeded and validated both typed recovery
receipts through normal reconciliation. No manual issue recovery or reviewer
wake was sent.

Artifacts: `/tmp/paperclip-plan-observation-live-reload/` contains
`receipts.jsonl`, `automatic-convergence-receipts.json`,
`native-review-observations.jsonl`, `live-native-review-proof.json`, and
`provider-write-audit.json`.

| Source | Original session | Original strong child | Strong card | Successful resolver |
| --- | --- | --- | --- | --- |
| MAZ-1650 | `14113825466128029126` | `86c3a928-88bf-4b85-88e0-8edcca527691` | `51cc59b8-f467-4ba5-ba7d-e93429ad0266` | `a774a099-214a-4b0b-bff0-e05f208ee19b` |
| MAZ-1740 | `1689905502063840609` | `1a773e4a-004a-40f6-93c6-576c79612bf3` | `d9fd598c-deb0-4127-86f7-27c366a67af5` | `84559081-9cc1-422e-a4c6-c5de2ebc80e7` |

Both native cards were answered with strong approvals on their original plan
revisions; both child-scoped resolver runs succeeded. Both source execution holds
cleared and each original session has one confirmed approval effect. Recorded
provider telemetry independently shows exactly one successful `approvePlan`
POST per source: run `c9a27f72-c03e-4b36-9060-1a9e3712f90d` for MAZ-1650 and
`7630dac5-83fc-4990-98d1-c5d8a4a7459e` for MAZ-1740.

The provider emitted two `planApproved` activities per session despite only one
recorded approval request. Activity count must not be mistaken for API write count.
Direct GET subsequently showed MAZ-1650 IN_PROGRESS and MAZ-1740 COMPLETED with
actual progress and session-completion activities. At the last source snapshot,
both issues remained in_progress without execution blockers while normal PR
handoff polling continued; this is not a claim that their implementation PRs
have merged.

## Qualification boundary

PR #21's missing pre-merge strong verdict remains the permanent
`04_terminal_proof_incomplete` exception. These lifecycle contracts do not
retroactively supply that evidence or authorize the live 2026.1001.0 upgrade.
