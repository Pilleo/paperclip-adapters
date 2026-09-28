# Native plan handback concurrency result — 2026-09-26

**Decision: NO-GO for integrating the client-read-then-PATCH reconciler on
unpatched Paperclip `2026.916.0`.** The concurrency defect is now reproduced,
not merely inferred from source code.

## Reproduction

```sh
CONTRACT_REPORT_DIR=/tmp/paperclip-handback-contract-final pnpm test:contract:plan-handback --require-safe
```

Measured run: `run-b0aafd63f172`. All seven scenarios completed their fixture
preconditions and produced observations. The command exited **2**, the explicit
integration-gate failure code, rather than 1 (harness failure).
Machine-readable full reports were written to the directory above; a compact
sanitized result is saved alongside this document in `results-2026-09-26.json`.

| Scenario | Observation | Gate |
| --- | --- | --- |
| Baseline | Typed verdict retained; ownership returned; Jules process started | Pass |
| Reviewer active before final read | Decision waited; no handback PATCH | Pass |
| Reviewer queued before final read | Decision waited; no handback PATCH | Pass |
| Reviewer starts after final read | PATCH returned 200 and cancelled the running reviewer as `issue_reassigned` | **Fail** |
| Reviewer queues after final read | Queued reviewer cancelled before start as `issue_assignee_changed`; Jules wake remained deferred and no Jules process started within 30s | **Fail** |
| Overlapping reconciliation wakes | Same-issue wake coalesced into current reconciler at concurrency 1; replay issued no second PATCH | Pass for this configuration |
| Lost handback response | Restart read authoritative returned state; no second PATCH | Pass |

The overlap test observes the host's normal admission/coalescing behavior. It
does not force simultaneous runs or claim to prove safety for a different
concurrency configuration. The live orchestrator's `maxConcurrentRuns: 1`, role,
and visible permissions were confirmed read-only during this task. Automatic
periodic timers are disabled in the fixture for determinism.

## Decisive running-reviewer race

The worker barrier is after the reconciler's final evidence read and before it
sends PATCH. A normal host scheduler wake then admits another reviewer process
on the same issue. That process reads the existing answered card and waits; it
does not create or resolve another card.

| Sequence | UTC time | Evidence |
| --- | --- | --- |
| 4 | 11:55:14.058 | Original verdict run settled |
| 5 | 11:55:16.484 | Reconciler saw no execution run and only succeeded reviewer runs; decision `return_to_jules` |
| 6 | 11:55:16.540 | Reconciler reached `PATCH_READY` |
| 7 | 11:55:17.665 | Competing reviewer process confirmed running |
| — | 11:55:17.788 | Host cancelled competing run `d9d1fadb-6ded-429b-82cf-fe99d34c2fb9` with `issue_reassigned` |
| 8 | 11:55:17.997 | Handback PATCH returned 200, issue `in_progress`, assignee Jules |
| 9 | 11:55:18.859 | Jules process started and read the original answered card |

The competing run actually started at `11:55:16.687Z`, after the final evidence
read. Its cancellation is not a pre-start stale-queue cleanup. The original
card stayed answered with its original resolver run. Additional cancelled
execution-recovery records appear in the final snapshot; they are not evidence
that the competing run was protected.

This proves that a correct client-side liveness decision can become stale
before vanilla's unconditional PATCH. Moving the check closer to PATCH or
locking only the orchestrator cannot close that window against host dispatch.

## Queued-reviewer continuation result

The second failing scenario holds Luna's sole worker slot with a different
issue, then admits a queued run on the reviewed issue after `PATCH_READY`.
The PATCH returns 200 and ownership returns to Jules. Releasing the other
issue's barrier allows the host to cancel the stale queued reviewer before
start (`startedAt: null`, `issue_assignee_changed`).

At the final observation, Jules's new wake was:

```json
{
  "reason": "issue_execution_deferred",
  "status": "deferred_issue_execution",
  "runId": null
}
```

No Jules continuation process was observed in the bounded 30-second window.
This is a measured liveness gap, not a claim that no later host sweep could
ever recover it. Issue ownership alone is insufficient completion evidence.

## Required host capability / upstream reproduction

The minimal race reproduction is:

```sh
pnpm test:contract:plan-handback --scenario=starts_after_read --require-safe
```

The executor needs a supported atomic handback operation (or documented
equivalent) that:

1. Compares the expected reviewer, stage, issue and immutable review target.
2. Checks reviewer execution/queued ownership under the same serialization
   boundary used by host dispatch, rejecting stale requests without cancellation.
3. Transfers ownership and records a durable continuation in a way that survives
   lost responses and stale queued work.
4. Recognizes repeated requests for the same typed verdict idempotently.

Prepare this fixture and the two failing scenarios for an upstream report;
no GitHub issue or public review was posted by this task. Qualify an official
release with the same matrix before integrating. The evidence is specific to
this PATCH-based design and this installed version; it does not establish that
every possible vanilla-host workflow is impossible.

## Scope and current deployment

These are process-adapter contract workers, not model-driven reviewers or a
Google Jules cloud session. The test verifies real native-card attribution,
authentication, run lifecycle, queue behavior, and HTTP transition behavior.
It does not claim provider-session continuity or complete Luna/Terra progression.

No runtime adapter source was changed for this experiment. The production
reconciler remains disconnected. No live task, hold, or server installation
was mutated and no service was reloaded.
