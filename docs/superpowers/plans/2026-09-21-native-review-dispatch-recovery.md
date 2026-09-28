# Native Review Dispatch Recovery Implementation Plan

> **For Codex:** Use `superpowers:test-driven-development` and `superpowers:executing-plans`. Run the focused tests and ADK guard after every slice. Do not modify Paperclip, create a worktree, or stage unrelated changes.

**Goal:** Recover a valid addressed native-review card when vanilla Paperclip persisted its `interaction_pending` wake but failed to create the reviewer run, without replacing the card repeatedly, posting prose, or calling private dispatch APIs.

**Architecture:** Paperclip remains the owner of reviewer execution. The adapters retain immutable review identity and use a shared exhaustive reducer to distinguish a lost dispatch from a terminal reviewer run. A lost dispatch is recovered on the same card by one deterministic call to Paperclip's public reviewer wake endpoint, carrying `mutation: "interaction"` and the exact interaction identity. Paperclip's idempotency receipt prevents repeated heartbeats or restarts from consuming reviewer quota twice. Card replacement is reserved for a terminal bound reviewer run and remains bounded to one replacement.

**Current evidence:** MAZ-1551 has pending Luna card `1439f400-aea4-43bb-ad34-84746c5ac84a` and persisted Paperclip wake receipt `0e16665c-1981-46bf-bb53-ead556c1d8d7`, but no bound Luna run. The host therefore accepted the interaction write and lost the promotion from wake receipt to reviewer run. Creating another card repeats the failing mechanism and is not a recovery.

**Constraints:** Vanilla Paperclip v2026.916.0 only; adapters repository only; no `/dispatch` or `/reconcile-dispatch`; no comment verdicts; no reviewer assignment to the parent issue; no reviewer timer polling; no API-key workaround; no database mocks in integration tests; no unrelated cleanup or commits.

---

## Task 1: Freeze the failure contract with red tests

- [100%] Add parameterized reducer cases to `packages/common/test/native-review-dispatch.test.ts` for:
  - a fresh pending card with no bound run → `await_native_dispatch`;
  - an overdue attempt-zero card with no run → `recover_dispatch` on the same card;
  - an overdue recovery card with no run → the same deterministic `recover_dispatch`, not another replacement;
  - a queued or running bound run → `await_run`;
  - a successful bound run without a verdict → `await_verdict`;
  - an answered addressed card → `consume_verdict`;
  - a terminal bound run on attempt zero → `replace_card`;
  - a terminal bound run on the replacement → `retry_exhausted`;
  - wrong reviewer/head/revision, duplicate canonical cards, malformed attempt, invalid timestamp, or unbound run → `protocol_failure`.
- [100%] Add failing transport tests to `packages/orchestrator/test/paperclip-http.test.ts` proving an interaction-bound wake contains:

  ```ts
  {
    source: "automation",
    triggerDetail: "system",
    reason: "native_review_dispatch_recovery",
    forceFreshSession: true,
    payload: {
      mutation: "interaction",
      issueId,
      interactionId,
      interactionKind: "request_item_verdicts",
    },
  }
  ```

- [100%] Add matching Jules client tests in `packages/jules/test/paperclip-client.test.ts`. They must expose the current bug: `interactionId` without `payload.mutation = "interaction"` is not a valid native continuation wake.
- [100%] Run the focused tests and save their failing output under `/tmp/paperclip-adapters-native-dispatch-red.log`. Confirm failures are assertions for the missing behavior, not fixture or compilation errors.

Commands:

```bash
pnpm --filter @pilleo/paperclip-adapter-common test -- native-review-dispatch.test.ts
pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- paperclip-http.test.ts native-review-recovery.test.ts native-review-recovery-state.test.ts
pnpm --filter @pilleo/paperclip-jules-adapter test -- paperclip-client.test.ts native-plan-review-lifecycle.test.ts
```

## Task 2: Make lost dispatch a first-class exhaustive state

- [100%] Update `packages/common/src/native-review-dispatch.ts` with a discriminated `recover_dispatch` result carrying the exact card ID, reviewer ID, immutable review identity, and deterministic recovery key inputs.
- [100%] Keep state classification pure. The reducer may inspect cards and bound runs, but it must not know HTTP, Paperclip URLs, logs, or provider-specific session data.
- [100%] Change only the missing-dispatch branch: an overdue pending card with no live or terminal bound run selects `recover_dispatch` on that card. It must not select `replace_card`.
- [100%] Keep `replace_card` only for a terminal bound reviewer run, because that is evidence that Paperclip dispatched successfully and the reviewer execution itself failed.
- [100%] Preserve one replacement per immutable PR head/stage or Jules plan revision/stage. A terminal replacement run exhausts recovery.
- [100%] Defer exhaustive consumer switches to the PR and Jules integration tasks, where each effect executor has the full external boundary available.
- [100%] Run common focused tests and common build. `adkw guard` remains bounded but its runner has not produced a completion receipt; preserve that as degraded verification and rerun at final verification.

## Task 3: Add one typed, provider-neutral public wake operation

- [100%] Introduce a narrow request builder and result parser in `packages/orchestrator/src/core/paperclip-http.ts`; do not scatter raw payload objects across adapters.
- [100%] Make the builder require an `interactionId`, `issueId`, `interactionKind`, reviewer agent ID, and idempotency key. The type makes omission of `mutation: "interaction"` impossible.
- [100%] Assert the idempotency key is derived only from immutable protocol identity: schema version, issue ID, interaction ID, and reviewer agent ID. It contains no timestamps, heartbeat IDs, or process-local counters.
- [100%] Add response-contract tests for `started(runId)`, `skipped(reason)`, rejected, invalid, and transport responses; unknown successful response shapes fail closed.
- [100%] Call only `POST /agents/:reviewerAgentId/wakeup`, using the existing loopback `localTrustedBoardWrites` path. Never substitute the reviewer's API key and never call a private dispatch endpoint.
- [100%] Parse the public response into an exhaustive union:
  - `started` with a concrete run ID;
  - `skipped` with a typed host reason;
  - `rejected` for expected 4xx contract failures;
  - `invalid_response` for an unrecognized 2xx body;
  - `transport_failure` for bounded network failure.
- [100%] Treat only `started(runId)` as recovery success. A durable receipt without a run ID is not success because that is the precise MAZ-1551 failure mode.
- [100%] Add tests proving the same immutable input produces the same idempotency key and repeated calls cannot create distinct logical wakes.
- [100%] Run focused HTTP tests and affected builds; defer the ADK guard to final verification because its captured runner is currently stuck.

## Task 4: Integrate PR-review recovery without card churn

- [60%] Replace the missing-dispatch `replace_card` branch in `packages/orchestrator/src/server/execute.ts` with `recover_dispatch` execution.
- [0%] Immediately before the external write, re-read evidence through `packages/orchestrator/src/core/native-review-recovery.ts` and require all of the following:
  - the exact card is still pending;
  - its addressee is the expected Luna or Terra agent;
  - its PR URL, head SHA, stage, and attempt match the immutable identity;
  - no queued or running bound reviewer run exists;
  - no answered verdict exists;
  - there is exactly one canonical current-stage card.
- [0%] If evidence changed, return to reduction without writing. If evidence is ambiguous, emit a typed protocol failure and fail closed.
- [0%] Send the public interaction-bound wake with the deterministic idempotency key. Do not withdraw the card, create another card, post a comment, assign the reviewer to the issue, or enable timer heartbeats.
- [0%] On `started(runId)`, record the run binding in structured logs and let the next heartbeat observe it normally.
- [0%] On skipped, rejected, invalid, or transport-exhausted results, open the existing capability circuit for that immutable card and emit one loud structured failure containing issue/card/reviewer/head/stage and host result. Suppress repeated writes and repeated error messages until card/run evidence changes.
- [0%] Add real-SQLite integration tests in `packages/orchestrator/test/execute-native-pr-approval.test.ts` and focused tests in `native-review-recovery.test.ts` proving:
  - one wake and zero card/comment/dispatch writes;
  - repeated heartbeats use the same idempotency key;
  - a newly observed run closes the circuit and advances normally;
  - answered cards are never woken;
  - terminal runs use bounded replacement instead;
  - wrong identity and duplicate cards fail closed.
- [0%] Run the focused tests, orchestrator build, affected E2E suites, and ADK guards before continuing.

## Task 5: Apply the same protocol to Jules plan review

- [100%] Extend the Jules lifecycle effect union with a journaled `recover_plan_dispatch` effect carrying card, reviewer, and deterministic idempotency identity.
- [100%] Update `packages/jules/src/server/native-plan-review-lifecycle.ts` so a missing run selects same-card dispatch recovery. Preserve Luna-before-Terra ordering and the immutable plan revision.
- [0%] Execute the effect in `packages/jules/src/server/execute.ts`: journal start, revalidate exact native evidence, send the public interaction-bound wake, then journal the typed outcome.
- [0%] Reconcile crashes by replaying the same effect and idempotency key. Never infer success or a verdict from Jules/reviewer prose.
- [0%] Keep plan-card replacement only for a terminal bound reviewer run and keep the one-replacement budget.
- [0%] Add parameterized lifecycle and real-SQLite journal tests for interruption before wake, after host response but before confirmation, repeated heartbeat, stage transition, terminal-run replacement, and malformed identity.
- [0%] Run Jules focused tests, package build, affected E2E suites, and ADK guards.

## Task 6: Remove contradictory compatibility behavior and document the boundary

- [0%] Keep `prepareAndWakeNativeReview` only if an exported compatibility symbol is still required; mark it deprecated and ensure no production recovery caller uses it.
- [0%] Make `packages/orchestrator/scripts/recover-native-review.mjs` read-only. It may diagnose identity and state but must refuse card mutation or prose decisions.
- [0%] Add repository-wide regression assertions that production code contains no `/dispatch`, `/reconcile-dispatch`, comment-verdict fallback, issue-assignee reviewer dispatch, or reviewer timer enablement.
- [0%] Update orchestrator/Jules documentation to distinguish:
  - normal host-native interaction dispatch;
  - same-card public recovery after a proven lost dispatch;
  - bounded card replacement after a terminal reviewer run;
  - typed exhaustion/protocol failure.
- [0%] Explain why the `mutation: "interaction"` marker is mandatory: vanilla Paperclip strips the interaction binding without it.
- [0%] Explain that the fallback is provider-neutral: it wakes the Paperclip reviewer agent attached to the addressed card and does not call ChatGPT, Jules, Luna, or Terra APIs directly.
- [0%] Run documentation/link checks and exact scope searches.

## Task 7: Verify MAZ-1551 against unchanged vanilla Paperclip

- [0%] Capture `/api/health`, process command, executable path, data directory, and loaded adapter `dist` path before reload. Abort if the host is not vanilla v2026.916.0.
- [0%] Build the affected packages, restart only the same Paperclip service to load adapter output, and recapture the same host evidence afterward.
- [0%] Run one orchestrator heartbeat. For MAZ-1551, require the existing pending Luna card to remain the canonical card and receive exactly one interaction-bound public wake with a new recovery idempotency key.
- [0%] Stop immediately and preserve evidence if the host returns no concrete reviewer run ID. This is a new host/API blocker, not permission to replace the card or post prose.
- [0%] If Luna starts, observe through the typed card only. Require one Luna verdict, then exactly one Terra card/run/verdict, with no prose decision or duplicate reviewer run.
- [0%] Verify the current PR head remains authoritative and the task reaches only the human merge gate. After merge, verify one merge acknowledgement and a terminal issue state.
- [0%] Poll active provider work no more often than every 15 minutes. Save all logs to files before analyzing them.

## Task 8: Run a fresh dependency-order canary

- [0%] Use the existing disposable MAZ project and SSH repository. Do not create another company, project, repository, or worktree.
- [0%] Create one fresh A → B → C chain with `packages/orchestrator/scripts/e2e-real-project-canary.ts` and approve all three execution requests when available.
- [0%] Observe only with `e2e-real-project-canary-verify.ts`; it must perform no recovery writes.
- [0%] Prove approval and dependency admission are independent: A runs first, B only after A is merged, and C only after B is merged.
- [0%] For every task require one Jules session, typed plan review, Luna then Terra typed PR review, one current PR head, one merge acknowledgement, and no duplicate card/run/comment.
- [0%] Re-run the observer after each transition and after one no-op heartbeat to prove idempotence.
- [0%] Stop and capture evidence at the first invariant violation. Do not manually unblock or alter Paperclip while the canary is running.

## Task 9: Final verification and narrow integration

- [0%] Run all focused tests and affected package builds after the final source change.
- [0%] Run the existing E2E suites after every implementation slice, then run the full workspace suite once at the final revision. Report the known baseline failures separately rather than relabeling them.
- [0%] Run `git diff --check`, `pnpm fleet:doctor`, `./scripts/adkw check-backlog`, and ADK guards against the exact final revision.
- [0%] Inspect the diff against the current dirty baseline. Stage only exact files or hunks belonging to this fix; never use `git add -A`.
- [0%] Commit in reviewable slices only after each slice is green:
  1. shared state and red/green reducer tests;
  2. typed public wake transport;
  3. orchestrator integration;
  4. Jules lifecycle integration;
  5. documentation and live-canary evidence.

## Acceptance criteria

- [0%] A valid overdue native card with no bound run is recovered on the same card through one idempotent public Paperclip wake carrying exact interaction identity.
- [0%] Repeated heartbeats and process restarts cannot create additional logical wakes or consume duplicate reviewer quota.
- [0%] Missing dispatch never causes card replacement; terminal reviewer execution remains eligible for one bounded replacement.
- [0%] Review decisions are consumed only from answered addressed native cards.
- [0%] MAZ-1551 reaches the human merge gate through Luna then Terra without manual unblocking, prose verdicts, or duplicate runs.
- [0%] A fresh A → B → C canary completes strictly in dependency order on unchanged vanilla Paperclip.

## Explicitly rejected approaches

- [100%] Repeated card replacement: it re-enters the same lost host-dispatch path and already failed for MAZ-1551.
- [100%] Reviewer timer heartbeats: vanilla actionability checks issue assignment, while the review issue is deliberately unassigned; enabling timers would either do nothing or waste quota.
- [100%] Comment or provider-message verdicts: they bypass the native addressed card and cannot safely encode authorization.
- [100%] Private dispatch endpoints or Paperclip patches: they couple adapters to host internals and violate the vanilla-host requirement.
- [100%] Child reviewer tasks: this is a larger ownership redesign and risks duplicate assignment/card wake paths; it is not needed to recover the confirmed failure.
