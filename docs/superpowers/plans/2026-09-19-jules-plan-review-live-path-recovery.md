# Jules Plan Review Live-Path Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Jules implementation task survive the plan-review ladder without Paperclip creating unbound reviewer runs, repeatedly retrying the parent, or blocking either issue as having no live execution path.

**Architecture:** Treat the Jules parent and reviewer child as two independent typed continuations. The parent retains a durable Jules monitor while waiting. The reviewer child owns one addressed `request_item_verdicts` card and is started exactly once through a wake carrying `{ issueId, interactionId, interactionKind }`; automatic issue-status wakes and nonexistent interaction-dispatch routes are not part of the protocol. A pure state machine decides create, wake, await, recover, or escalate from card and run evidence.

**Tech Stack:** TypeScript, Zod, Vitest, Paperclip HTTP API, Jules provider adapter, orchestrator reconciliation, SQLite-backed Paperclip E2E.

**Spec:** Current native-review invariants in `AGENTS.md`, `packages/orchestrator/README.md`, and the live MAZ-1543/MAZ-1546 evidence captured on 2026-09-19.

## Global Constraints

- The fix must remain adapter-only; do not patch the local Paperclip checkout.
- Reviews are valid only as structured verdicts on the addressed Paperclip interaction.
- Do not create replacement cards while the canonical card is pending.
- Do not post comments or provider messages as verdict fallbacks.
- Do not clear the Jules parent monitor merely because a reviewer child exists.
- Poll live Jules sessions at the configured cadence (currently 15 minutes), not through Paperclip's rapid generic continuation recovery.
- Recovery must be idempotent across server restart, adapter restart, and repeated orchestrator heartbeats.
- Integration tests use real Paperclip persistence; do not mock database calls.
- Run the focused E2E regression after every implementation slice.

## Root-Cause Evidence

- [100%] MAZ-1543 successfully created Jules session `3178032221283871174` and a valid plan-review child, MAZ-1546.
- [100%] MAZ-1546 contained one pending addressed `request_item_verdicts` card, but its only Luna run failed in 130 ms with `continuation_source_context_missing`.
- [100%] The plan card currently uses `continuationPolicy: "wake_assignee"`; Paperclip's automatic `issue_status_changed` wake does not carry the typed interaction context required by the reviewer.
- [100%] The Jules adapter deliberately clears the parent monitor while `plan_native_review` is pending. Paperclip therefore sees successful parent continuations with no remaining live path, retries them repeatedly, and finally blocks the parent.
- [100%] The adapter's supposed `/interactions/:id/dispatch` route is absent from Paperclip v2026.916.0 source, so mocked tests currently prove a transport that the live server does not provide.

## Review Focus

- Addressed plan card created while the reviewer has no prior session: exactly one bound run starts.
- Reviewer run fails before verdict: the same pending card is recoverable once; no replacement card or free-text fallback appears.
- Parent waits on Luna/Terra longer than one recovery sweep: its Jules monitor remains scheduled and no `issue_continuation_needed` storm is produced.
- Server/adapter restart between card creation and wake: state converges from persisted card/run evidence without duplicate runs.
- Luna reject, Luna approve then Terra reject, and Luna+Terra approve: only the valid next transition occurs and Jules receives exactly one typed outcome.

---

### Task 1: Encode the reviewer-child lifecycle as an exhaustive state machine

**Files:**
- Create: `packages/jules/src/server/native-plan-review-lifecycle.ts`
- Create: `packages/jules/test/native-plan-review-lifecycle.test.ts`

**Interfaces:**
- Consumes: canonical card status, addressed reviewer ID, bound heartbeat runs, child status, and current time.
- Produces: `decideNativePlanReviewLifecycle(input): NativePlanReviewAction`, where the exhaustive action union is `create_card | wake_card | await_run | await_verdict | recover_card | consume_verdict | escalate_protocol_failure`.

- [ ] [10%] Write a parameterized table covering every card/run combination, including missing card, pending card without run, queued/running bound run, succeeded run without verdict, failed unbound run, answered card, duplicate pending cards, and identity mismatch.
- [ ] [0%] Run `pnpm --filter @pilleo/paperclip-jules-adapter test -- native-plan-review-lifecycle.test.ts` and verify RED because the reducer does not exist.
- [ ] [0%] Implement strict Zod parsers and an exhaustive `switch` over discriminated states; malformed or ambiguous evidence must return `escalate_protocol_failure`, never `wake_card`.
- [ ] [0%] Re-run the focused unit test and `./scripts/adkw guard packages/jules/src/server/native-plan-review-lifecycle.ts --stage syntax`.
- [ ] [0%] Run `packages/orchestrator/scripts/e2e-jules-recovery.ts` before continuing.

### Task 2: Replace automatic card wake with an explicit typed wake supported by v2026.916.0

**Files:**
- Modify: `packages/jules/src/server/paperclip-client.ts`
- Modify: `packages/jules/test/paperclip-client.test.ts`
- Modify: `packages/jules/test/e2e-plan-presentation.test.ts`

**Interfaces:**
- Produces: `wakeJulesPlanReviewer({ reviewerAgentId, childIssueId, interactionId, idempotencyKey, ... }): Promise<WakeResult>`.
- Wire contract: `POST /api/agents/:reviewerAgentId/wakeup` with `forceFreshSession: true` and payload `{ issueId: childIssueId, interactionId, interactionKind: "request_item_verdicts" }`.

- [ ] [0%] Add a failing request-shape test proving an addressed plan card uses `continuationPolicy: "none"`, not `wake_assignee`.
- [ ] [0%] Add a failing request-shape test proving the wake puts all execution identity under `payload`, includes the exact card ID, and uses a deterministic idempotency key.
- [ ] [0%] Add a contract test against a real local Paperclip server that fails if the selected endpoint is missing or if the resulting run lacks `contextSnapshot.issueId` and the interaction binding.
- [ ] [0%] Implement the typed wake in the Jules client; remove plan-review reliance on `activateInternalReviewIssue` producing an automatic wake.
- [ ] [0%] Keep the reviewer child non-runnable until the card is durable, then make it visible and issue exactly one explicit wake according to Task 1's decision.
- [ ] [0%] Run the focused Jules tests, build Jules, and run the recovery E2E script.

### Task 3: Preserve the parent Jules monitor during native plan review

**Files:**
- Modify: `packages/jules/src/server/execute.ts`
- Modify: `packages/jules/test/execute-heartbeat-yield.test.ts`
- Modify: `packages/jules/test/e2e-plan-presentation.test.ts`

**Interfaces:**
- Consumes: `pendingInteraction.type === "plan_native_review"` and configured poll cadence.
- Produces: a normal scheduled Jules monitor on the parent while the reviewer child owns the verdict card.

- [ ] [0%] Add a failing test proving `yieldHeartbeat` schedules, rather than clears, the parent monitor during Luna and Terra waits.
- [ ] [0%] Add a failing test proving repeated parent polls before a verdict do not create another child, card, or reviewer wake.
- [ ] [0%] Remove the obsolete monitor-clear branch whose comment assumes the verdict card lives on the parent; document that reviewer ownership is isolated on a child issue.
- [ ] [0%] Ensure the pending result declares a durable monitor disposition so Paperclip recovery does not classify the successful run as productive-but-stranded.
- [ ] [0%] Run the focused Jules tests, Jules build, and recovery E2E script.

### Task 4: Make recovery reuse the canonical card and reject unbound runs

**Files:**
- Modify: `packages/jules/src/server/execute.ts`
- Modify: `packages/jules/src/server/plan-gate-state.ts`
- Modify: `packages/jules/test/e2e-plan-presentation.test.ts`
- Modify: `packages/orchestrator/src/core/native-review-recovery-state.ts`
- Modify: `packages/orchestrator/test/native-review-recovery-state.test.ts`

**Interfaces:**
- Consumes: Task 1's action union and exact plan identity `{ parentIssueId, sessionId, revisionId, stage, reviewerAgentId }`.
- Produces: one recovery wake for the same card only after every prior bound run is terminal; unbound runs such as MAZ-1546's failed automatic wake are diagnostic evidence, not canonical attempts.

- [ ] [0%] Add parameterized RED tests for restart, failed unbound run, failed bound run, active bound run, answered card, stale revision, and duplicate-card protocol failure.
- [ ] [0%] Implement recovery through the typed wake from Task 2; never call the absent `/interactions/:id/dispatch` route.
- [ ] [0%] Add a bounded retry budget keyed by the immutable card identity; exhaustion creates one visible protocol failure and stops spending reviewer quota.
- [ ] [0%] Verify Luna rejection never starts Terra, while Luna approval creates and wakes exactly one Terra card.
- [ ] [0%] Run focused Jules and orchestrator tests, both package builds, and recovery E2E.

### Task 5: Add a true server-backed regression for the MAZ-1543 failure

**Files:**
- Modify: `packages/orchestrator/scripts/e2e-jules-recovery.ts`
- Modify: `packages/orchestrator/scripts/e2e-paperclip-lifecycle.ts`
- Test fixtures only where already supported by those scripts.

**Interfaces:**
- Exercises real Paperclip HTTP routes, persisted interactions, heartbeat runs, monitor projection, and dependency scheduling.

- [ ] [0%] Add a canary scenario that creates parent A plus dependent B, persists a fake-but-durable Jules session, emits a plan, and waits for Luna then Terra verdicts.
- [ ] [0%] Assert the reviewer run context contains the child issue and exact interaction ID; fail on `continuation_source_context_missing`.
- [ ] [0%] Advance simulated time/recovery sweeps beyond the old escalation threshold and assert the parent remains `in_progress` with a scheduled Jules monitor.
- [ ] [0%] Assert there is one Luna card/run, then one Terra card/run, no replacement cards, no generic continuation comments, and no free-text verdict comments.
- [ ] [0%] Submit structured approvals, assert Jules resumes, produces a PR, and only then allow dependent B to dispatch.
- [ ] [0%] Run this E2E after each remaining slice and preserve logs under `/tmp` for comparison.

### Task 6: Recover MAZ-1543/MAZ-1546 without replacing their durable identities

**Files:**
- No source files; use the adapter operations runbook and existing recovery scripts.

**Interfaces:**
- Existing card: `46409761-51dc-4349-b27f-47aa4a4ab812`.
- Existing Jules session: `3178032221283871174`.

- [ ] [0%] Build affected packages, restart Paperclip, and confirm startup loaded the new Jules and orchestrator `dist/index.js` files.
- [ ] [0%] Wait one orchestrator heartbeat and verify managed Luna/Terra configuration is healthy.
- [ ] [0%] Re-read MAZ-1546; if its canonical card is still pending and no bound reviewer run is active, issue exactly one typed recovery wake for that card.
- [ ] [0%] Verify the same card becomes answered by Luna; do not create another card or comment.
- [ ] [0%] Verify Terra is created only after Luna approval, then verify Jules receives the final plan decision and resumes session `3178032221283871174`.
- [ ] [0%] Verify MAZ-1543 reaches PR review/merge, then MAZ-1544 starts, followed by MAZ-1545.

### Task 7: Full verification and documentation

**Files:**
- Modify: `packages/orchestrator/README.md`
- Modify: `packages/jules/README.md` if present; otherwise document in the nearest existing Jules operations section.
- Modify: comments adjacent to the compatibility wake and monitor ownership code.

- [ ] [0%] Remove or correct documentation claiming `/interactions/:id/dispatch` exists on the supported Paperclip version.
- [ ] [0%] Document why addressed cards use `continuationPolicy: "none"`, why explicit payload binding is mandatory, and why the parent monitor remains live during child review.
- [ ] [0%] Run `pnpm --filter @pilleo/paperclip-jules-adapter test` and `pnpm --filter @pilleo/paperclip-orchestrator-adapter test`.
- [ ] [0%] Run `pnpm build`, `pnpm fleet:doctor`, both real E2E scripts, and `./scripts/adkw check-backlog`.
- [ ] [0%] Run `git diff --check`, inspect the final diff, and record exact test/log evidence before claiming completion.

## Stop Conditions

- Stop immediately on a new error family, a duplicate card/run, or any free-text substitute; capture evidence before changing another subsystem.
- If the real server rejects a typed generic wake carrying interaction context, do not add another fallback. Re-open the transport design using the observed server contract.
- Do not mark the repair complete until the real chain advances in dependency order and waits only at the user's merge gate.
