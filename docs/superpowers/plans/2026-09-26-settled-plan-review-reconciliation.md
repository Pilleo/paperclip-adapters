---
title: Settled native plan review reconciliation
status: in_progress
document_type: execution_plan
base_revision: ae92c676deea865c156ae9842e7bf0e22307dc5b
---

# Settled native plan review reconciliation

## Goal

Return a settled native reviewer issue to its existing Jules provider session
through an authenticated orchestrator run on unpatched vanilla Paperclip.

**Design superseded for new plan reviews:** stable-parent v3 child reviews
are now implemented and pass the authenticated vanilla-host contract suite.
They avoid parent handback altogether. See
`packages/orchestrator/test/contract/STABLE-CHILD-RESULTS.md`. The no-go finding
below remains valid for the old parent read-then-PATCH design and is retained
as evidence, not as a prerequisite for the v3 protocol.

## Verified contract

Installed vanilla Paperclip `2026.916.0`, disposable embedded PostgreSQL,
real process-adapter reviewer and reconciler runs, host `actorMiddleware`
in authenticated mode, host-minted JWTs, and an active responsible-user
company membership were used for the authorization experiment.

The live orchestrator's visible role/permissions were read without modifying
them: `general`, with `canAssignTasks`, `canCreateAgents`, and `canCreateSkills`.
The disposable fixture uses these permissions and puts workers under the
orchestrator in the reporting hierarchy. This establishes the fixture's
contract, not full equivalence to every live authorization-policy setting.

1. A generic orchestrator run with no source issue is rejected on the issue
   PATCH with `cross_issue_influence_run_context_required`, despite valid
   authentication and the run header.
2. An orchestrator run assigned to its own maintenance issue is permitted to
   update the reviewed issue. The host logs the cross-issue write against its
   per-run cap of 20.
3. Removing the review policy from that separate process returns ownership to
   Jules and produces a Jules assignment run.

Evidence: `run-6c36de8ec168` (unscoped denial), `run-dfd8a1f977d5`
(issue-scoped handback and Jules continuation). Temporary harness:
`/tmp/paperclip-vanilla-plan-proof/settled-orchestrator-contract.mjs`, worker:
`/tmp/paperclip-vanilla-plan-proof/settled-orchestrator-worker.mjs`.
The fixture is exploratory: Jules is seeded, the provider is not exercised,
and process-adapter follow-up runs must not be confused with a full ladder
or crash-recovery proof.

## Implemented decision layer

`packages/orchestrator/src/core/native-plan-review-reconciliation.ts`
validates untrusted snapshots and returns explicit wait, conflict, handback,
or continuation-verification decisions. It performs no mutations.

It requires exact company, issue, session, card, revision, owner, reviewer,
source run, verdict run, and deterministic native stage evidence. It rejects
incomplete run indexes, ambiguous cards, recovery holds, foreign policies,
and monitors; it waits for active or queued/scheduled reviewer execution.
An answered verdict from a failed/cancelled run is not automatically released.
Returned ownership is not treated as proof of a durable Jules continuation.

## Remaining concurrency gate

**2026-09-26 measured update:** the deterministic seven-scenario contract
experiment is implemented under `packages/orchestrator/test/contract/`.
`pnpm test:contract:plan-handback --require-safe` completed all scenarios and
exited 2: a reviewer started after the final read was cancelled by the stale
PATCH, and a queued-after-read case left the Jules wake deferred throughout
the bounded observation window. See
`packages/orchestrator/test/contract/RESULTS.md` for causal evidence and the
required upstream atomic-transition contract. This is a no-go for the current
read-then-PATCH executor on `2026.916.0`.

The installed issue PATCH schema/route exposes no conditional version,
assignee, or execution-run precondition. Its reassignment path explicitly
cancels the current active run before changing ownership. Reading run state
immediately before PATCH does not serialize that read against a new host wake.

The supported safe-recovery hand-back route does check conflicting execution
locks, but refuses pending native review stages (`recovery_governed_stage_pending`)
and requires the recorded original owner to remain assigned. It cannot be
used as a substitute for this reviewer-to-Jules transfer.

Therefore the decision layer is not wired into the live mutation loop yet.
Before integration, prove a supported host-side serialization mechanism that
cannot cancel a reviewer started between the evidence read and PATCH. An
in-memory adapter lock alone is insufficient, as it cannot lock host dispatch.
Do not treat a second read as an atomic fence or add undocumented PATCH fields.

## Work remaining

- [ ] Establish serialization for the handback mutation versus host dispatch.
- [ ] Add an issue-scoped maintenance execution path with host-authenticated
      writes and a bounded cross-issue mutation budget.
- [ ] Add read-after-write continuation reconciliation, including lost PATCH
      and wake responses. Do not treat an in-memory deduplication key as a
      durable success receipt.
- [ ] Remove reviewer self-handback only when the replacement executor is
      ready; coordinate legacy monitor/PR recovery paths to avoid two owners.
- [ ] Complete stage provenance transport and pre-transfer restart recovery.
- [ ] Test the actual MCP bridge, provider session, rejection/revision cycle,
      interrupted transfers, and full Luna/Terra ladder on disposable vanilla.
- [ ] Diagnose the offline orchestration regression timeouts, run all checks,
      then reload and run one bounded live canary.

No live issue, hold, agent configuration, or installed host file was changed
for this experiment. No adapter reload was performed.
