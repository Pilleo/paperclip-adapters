# Native Jules Plan Protocol Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an approved Jules task traverse plan review exactly once through Luna then Terra, recover every interrupted external mutation without replaying it blindly, and never derive plan control flow from reviewer comments, prose, or local model fallbacks.

**Architecture:** Native plan review becomes a single protocol with three layers: a pure projection derives `JulesLifecycleState` from persisted session/card/provider evidence; the common reducer chooses the next typed transition; and a Jules-only runner journals, reconciles, and executes that transition. The orchestrator remains a narrow wake bridge for an exact answered native card and must not recreate cards, send Jules messages, or decide provider state. Legacy review records are accepted only as input to a one-way migration into a Luna v2 card; they can never again be interpreted as a verdict.

**Tech Stack:** TypeScript 5, Zod, Vitest 3, strict local HTTP fixtures, real SQLite-backed Paperclip process E2E, pnpm workspaces, Paperclip v2026.916.0.

**Spec:** `docs/superpowers/plans/2026-09-20-durable-jules-lifecycle.md` (Tasks 5–8 are superseded for future execution by this corrective plan; Tasks 1–4 remain recorded historical evidence).

## Evidence That Changes This Plan

- `packages/jules/src/server/execute.ts:3716-3768` still consumes `plan_agent_review` by reading a reviewer comment and `parsePlanAdjudication`; that is a second, prose-based protocol.
- `execute.ts:2047-2088` and `execute.ts:4620-4725` create Luna cards directly, while `execute.ts:3574-3709` invokes the new runner only after a card is answered. The reducer therefore does not own card creation.
- Each current `runJulesLifecycle` invocation hard-codes `effect: { kind: "not_started" }`, even if `lifecycleEffectJournal` records the same effect as `started`. A restart can bypass reconciliation.
- `lifecycle-runner.ts` has a reconciliation hook but live `execute.ts` does not supply it. Its current `not_confirmed` result also cannot distinguish a retry proven safe from an outcome that is still unknown.
- `plan-review-protocol.ts` rejects recovery-suffixed native keys while the orchestrator has an independent regex that accepts them. That is two incompatible parsers for the same durable identity.
- `packages/orchestrator/test/e2e-jules-restart-lifecycle.test.ts` currently proves only raw `JulesClient` HTTP calls; it does not execute the adapter, persist a session, restart it, or operate a native Paperclip verdict card.
- `liveSessionPollDelayMs` repeatedly applies the five-second initial delay and the one-minute revision delay on paths that call `yieldHeartbeat(..., true)`. Poll scheduling is not persisted, so it can produce repeated monitor writes instead of one configured cadence.

## Global Constraints

- Work directly on `master`; do not create Git worktrees.
- Preserve the current uncommitted Task 5 files until they are covered by the red tests in Task 1. Do not deploy or restart Paperclip from this intermediate revision.
- Follow red-green-refactor: each production slice starts with a failing focused test, then runs its existing focused E2E coverage before moving to the next slice.
- Never parse comments, reviewer prose, labels, or provider transcripts as a plan verdict. The only automated plan decisions are an attested `request_item_verdicts` result from the addressed Luna or Terra agent.
- Luna is the only weak plan reviewer and Terra is the only strong plan reviewer. Terra is created only after a confirmed Luna approve verdict. Vibe/local API-key reviewers must not be used as a fallback plan gate.
- A human escalation remains `resolverPolicy: "human_only"` and is reserved for an existing typed provider-question escalation. It is not a substitute for a missing reviewer configuration or an invalid plan-review protocol.
- Do not replay an uncertain remote mutation. Re-execution is allowed only after effect-specific read-after-write evidence proves it was not applied.
- Parent-owned v2 cards use `continuationPolicy: "none"`; the existing orchestrator bridge may wake the parent only from the shared, typed card identity.
- Use `./scripts/workspace-node.sh` for detached/systemd test commands so Node 24, not the system Node 22, executes pnpm and Vitest.
- Do not modify live MAZ issues or create replacement Jules sessions while this plan is being implemented. Live recovery happens only in Task 7 from a clean, frozen binary.

## Review Focus

- A crash after a remote POST succeeds but before the journal receipt/pending-card pointer persists must recover the exact card or provider transition, never create a duplicate.
- An old `plan_agent_review` with an active or terminal child must be retired/migrated without reading its comment and without dispatching a parallel Luna review.
- A human-resolved reviewer card is not Luna/Terra approval; it must either produce one bounded typed recovery generation or fail closed, never hang silently or approve Jules.
- A required plan policy with one or both native reviewer IDs absent must fail with a visible configuration error and make zero local-model, provider-approval, child-card, or human-card calls.
- Repeated heartbeats during a healthy provider run must retain one scheduled monitor at the configured cadence and produce no waiting-status comments or duplicate wake mutations.

---

### Task 1: Freeze the Actual Regressions Before Extending the Partial Runner

**Files:**
- Modify: `packages/jules/test/lifecycle-runner.test.ts`
- Modify: `packages/jules/test/e2e-plan-presentation.test.ts`
- Modify: `packages/jules/test/lifecycle-effect-journal.test.ts`
- Modify: `packages/jules/test/execute-heartbeat-yield.test.ts`
- Modify: `packages/orchestrator/test/e2e-jules-restart-lifecycle.test.ts`
- Modify: `scripts/workspace-node.sh`
- Test: `scripts/workspace-node.test.mjs`

**Interfaces:**
- Characterizes the current runner entry point `runJulesLifecycle(input)` and its durable `LifecycleEffectJournal` input.
- Produces red regressions for journal projection, effect-specific restart recovery, legacy prose isolation, and the real adapter lifecycle boundary.

- [ ] [100%] **Step 1: Record a clean baseline without staging unrelated work**

  Run:

  ```bash
  git diff --check
  ./scripts/workspace-node.sh node --test scripts/workspace-node.test.mjs
  ./scripts/workspace-node.sh pnpm --filter @pilleo/paperclip-jules-adapter exec vitest run \
    test/lifecycle-runner.test.ts test/lifecycle-effect-journal.test.ts test/e2e-plan-presentation.test.ts
  ```

  Save all command output under `/tmp/pc-adapters-native-plan-baseline/`. Confirm the only changed paths are the existing Task 5 implementation plus the pre-existing user plan and `.taskplane/` data. Do not stage the user-owned files.

- [ ] [100%] **Step 2: Add red crash-boundary tests against `execute`, not only the pure runner**

  Add a parameterized fixture in `e2e-plan-presentation.test.ts` that persists and re-enters `execute()` at these durable boundaries:

  ```ts
  type CrashBoundary =
    | "before_luna_card_post"
    | "after_luna_card_post_before_pointer"
    | "after_luna_approve_before_terra_pointer"
    | "after_terra_approve_before_receipt"
    | "after_reject_message_before_echo";
  ```

  Assert exact cardinalities: one Luna card per revision/generation, one Terra card only after Luna approve, one `approvePlan` call only after Terra approve, and one revision-request marker. Seed `lifecycleEffectJournal` with `started` at the three post-mutation boundaries and assert `execute()` calls the reconciliation path rather than recreating/sending the effect.

- [ ] [100%] **Step 3: Add red protocol-isolation and configuration tests**

  Add tests that deserialize both `pendingInteraction` and `deferredPlanReview` as `plan_agent_review`, include a valid-looking legacy JSON comment, and assert that the next adapter run makes no `listIssueComments`, `parsePlanAdjudication`, `createJulesPlanReviewChild`, `evaluatePlanClarity`, `createCheapReviewer`, or `approvePlan` call. Add `it.each` cases for no Luna ID, no Terra ID, and both missing under required plan approval; each must return `native_plan_review_agents_unconfigured` and create no form.

- [ ] [1%] **Step 4: Replace the client-only restart test with an adapter boundary red test**

  Extend `packages/orchestrator/test/fixtures/scripted-jules-server.ts` with strict stateful responses for `getSession`, activities, `approvePlan`, and `sendMessage`. Add a strict Paperclip interaction HTTP fixture that stores exact idempotency keys and typed verdict results. The test must invoke the built Jules adapter twice with serialized session parameters, simulating a process restart between calls; it must fail on the current code because `execute` projects `started` as `not_started` and because the runner lacks a live reconciliation dependency.

- [ ] [0%] **Step 5: Prove every new test is red for its stated reason**

  Run the focused commands individually, capturing output:

  ```bash
  ./scripts/workspace-node.sh pnpm --filter @pilleo/paperclip-jules-adapter exec vitest run test/lifecycle-runner.test.ts
  ./scripts/workspace-node.sh pnpm --filter @pilleo/paperclip-jules-adapter exec vitest run test/e2e-plan-presentation.test.ts
  ./scripts/workspace-node.sh pnpm --filter @pilleo/paperclip-adapter-orchestrator exec vitest run test/e2e-jules-restart-lifecycle.test.ts
  ```

  Expected failures: missing journal-derived projection/reconciliation dependency, legacy prose branch still reachable, and client-only restart assertion replaced by a real adapter failure. Do not implement a fix in this task.

- [ ] [0%] **Step 6: Commit only the characterization tests**

  ```bash
  git add packages/jules/test/lifecycle-runner.test.ts packages/jules/test/e2e-plan-presentation.test.ts \
    packages/jules/test/lifecycle-effect-journal.test.ts packages/jules/test/execute-heartbeat-yield.test.ts \
    packages/orchestrator/test/e2e-jules-restart-lifecycle.test.ts packages/orchestrator/test/fixtures/scripted-jules-server.ts \
    scripts/workspace-node.sh scripts/workspace-node.test.mjs
  git commit -m "test(jules): characterize durable native plan protocol"
  ```

### Task 2: Put the Native Card Identity and Effect Projection Behind Exhaustive Types

**Files:**
- Create: `packages/common/src/jules-plan-review-identity.ts`
- Create: `packages/common/test/jules-plan-review-identity.test.ts`
- Modify: `packages/common/src/jules-lifecycle.ts`
- Modify: `packages/common/test/jules-lifecycle.test.ts`
- Modify: `packages/common/src/index.ts`
- Modify: `packages/jules/src/server/plan-review-protocol.ts`
- Modify: `packages/jules/test/plan-review-protocol.test.ts`
- Modify: `packages/orchestrator/src/core/jules-plan-verdict-continuation.ts`
- Modify: `packages/orchestrator/test/jules-plan-verdict-continuation.test.ts`

**Interfaces:**
- Produces `JulesPlanReviewIdentity`, `JulesPlanReviewGeneration`, `planReviewIdempotencyKey(identity)`, and `parsePlanReviewIdempotencyKey(value)` from `packages/common`.
- Produces `projectEffectAttempt(effect, journal): JulesEffectAttempt`, the only function allowed to turn a journal entry into a reducer `effect` state.
- Consumes exact issue/session/revision/stage/provider-card evidence; it consumes no prompt text, reviewer comment, or provider prose.

- [ ] [0%] **Step 1: Write table-driven identity tests before moving any parser**

  Cover primary and recovery generation identities, malformed keys, wrong issue/session/revision/stage, and the existing `v2` primary shape:

  ```ts
  expect(planReviewIdempotencyKey({
    issueId: "issue-985", sessionId: "session-985", revisionId: "revision-29",
    stage: "luna", generation: 0,
  })).toBe("jules:plan-review:v2:issue-985:session-985:revision-29:luna");

  expect(parsePlanReviewIdempotencyKey(
    "jules:plan-review:v2:issue-985:session-985:revision-29:luna:recovery:1",
  )).toMatchObject({ stage: "luna", generation: 1 });
  ```

  The same table must be imported by the Jules protocol test and the orchestrator bridge test. Delete the independent orchestrator regex expectation.

- [ ] [0%] **Step 2: Write reducer tests for generation and journal projection**

  Extend `JulesReviewGate` with `generation: number` on `pending`, `resolved`, and an `untrusted` state. Assert an untrusted Luna/Terra terminal card produces exactly one same-stage recovery generation, and a second untrusted terminal card emits `report_invariant_violation`. Assert `projectEffectAttempt` maps no entry to `not_started`, a matching `started` entry to `started`, and a matching confirmed entry to `confirmed`; mismatched effect kinds or receipts are invariant violations.

- [ ] [0%] **Step 3: Implement the common identity and projection functions with exhaustive switches**

  Add the shared types:

  ```ts
  export type JulesPlanReviewGeneration = 0 | 1;
  export interface JulesPlanReviewIdentity {
    readonly issueId: string;
    readonly sessionId: string;
    readonly revisionId: string;
    readonly stage: "luna" | "terra";
    readonly generation: JulesPlanReviewGeneration;
  }

  export type ProjectedEffectAttempt =
    | { readonly kind: "not_started" }
    | { readonly kind: "started"; readonly effectId: string; readonly startedAt: string }
    | { readonly kind: "confirmed"; readonly effectId: string; readonly receipt: string }
    | { readonly kind: "inconsistent"; readonly reason: string };
  ```

  Preserve the existing v2 primary key exactly. For generation 1 append only `:recovery:1`. Make `plan-review-protocol.ts` delegate key parsing to this common module, and make the orchestrator bridge import the same parser instead of owning a regular expression.

- [ ] [0%] **Step 4: Make every native-card reducer transition generation-aware**

  Update `JulesLifecycleEffect.create_card` to carry `generation`; use stable primary effect IDs for generation 0 and append `:recovery:1` only for recovery. Add exhaustive `switch` cases for `untrusted`, never a boolean flag. The reducer must still create Terra only after a Luna `approve`, while a Luna/Terra `reject` remains `request_plan_revision`.

- [ ] [0%] **Step 5: Run focused common/Jules/orchestrator tests and verify no parser disagreement remains**

  ```bash
  ./scripts/workspace-node.sh pnpm --filter @pilleo/paperclip-adapter-common exec vitest run test/jules-plan-review-identity.test.ts test/jules-lifecycle.test.ts
  ./scripts/workspace-node.sh pnpm --filter @pilleo/paperclip-jules-adapter exec vitest run test/plan-review-protocol.test.ts
  ./scripts/workspace-node.sh pnpm --filter @pilleo/paperclip-adapter-orchestrator exec vitest run test/jules-plan-verdict-continuation.test.ts
  rg -n 'PLAN_VERDICT_KEY|jules:plan-review:v2.*\\^|split\(.*plan-review' packages/orchestrator packages/jules
  ```

  Expected final search result: no independently maintained native-plan key parser.

- [ ] [0%] **Step 6: Commit**

  ```bash
  git add packages/common/src packages/common/test packages/jules/src/server/plan-review-protocol.ts \
    packages/jules/test/plan-review-protocol.test.ts packages/orchestrator/src/core/jules-plan-verdict-continuation.ts \
    packages/orchestrator/test/jules-plan-verdict-continuation.test.ts
  git commit -m "refactor(common): share typed Jules plan identity"
  ```

### Task 3: Make Effect Reconciliation Explicit, Effect-Specific, and Restart-Safe

**Files:**
- Create: `packages/jules/src/server/native-plan-effect-reconciler.ts`
- Create: `packages/jules/test/native-plan-effect-reconciler.test.ts`
- Modify: `packages/jules/src/server/lifecycle-effect-journal.ts`
- Modify: `packages/jules/test/lifecycle-effect-journal.test.ts`
- Modify: `packages/jules/src/server/lifecycle-runner.ts`
- Modify: `packages/jules/test/lifecycle-runner.test.ts`
- Modify: `packages/jules/src/server/paperclip-client.ts`
- Modify: `packages/jules/test/paperclip-client.test.ts`
- Modify: `packages/jules/src/server/plan-revision-request.ts`
- Modify: `packages/jules/test/plan-revision-request.test.ts`

**Interfaces:**
- Produces `reconcileNativePlanEffect(effect, evidence): NativePlanEffectReconciliation` where every result is one of `confirmed`, `retry_safe`, `await_observation`, or `inconsistent`.
- Produces `findJulesPlanReviewInteraction(identity, expectedTarget)` that verifies an existing parent card by shared key, stage, addressee, and issue-document target.
- Produces `retryStartedEffect(journal, effectId, now)`; it is callable only after `retry_safe` and increments a bounded attempt count.

- [ ] [0%] **Step 1: Write red reconciliation state tables for all three native mutations**

  Use `it.each` with these outcomes:

  | Effect | Read-after-write evidence | Required result |
  | --- | --- | --- |
  | `create_card` | exact v2 parent card exists | `confirmed(cardId)` |
  | `create_card` | authoritative interaction list lacks the exact card | `retry_safe` |
  | `approve_plan` | matching plan is still `AWAITING_PLAN_APPROVAL` | `retry_safe` |
  | `approve_plan` | provider progressed after the exact plan activity | `confirmed(provider-state receipt)` |
  | `approve_plan` | provider question/failed/unknown state | `await_observation` or `inconsistent`, never retry |
  | `request_plan_revision` | exact opaque marker is mirrored as `userMessaged` | `confirmed(activityId)` |
  | `request_plan_revision` | marker has not appeared | `await_observation`, never resend |

  Include a test that a network exception after POST leaves `started` and does not issue a second POST until the table returns `retry_safe`.

- [ ] [0%] **Step 2: Expand the journal only for verified retries**

  Replace the implicit “existing started means throw” behavior with a typed attempt counter:

  ```ts
  type LifecycleEffectAttempt =
    | { readonly kind: "started"; readonly startedAt: string; readonly attempts: number }
    | { readonly kind: "confirmed"; readonly receipt: string };
  ```

  Decode existing `started` entries as `attempts: 1`. `retryStartedEffect` must reject missing/confirmed effects and cap native card/approval retries at two total attempts. A result of `await_observation` preserves the journal unchanged and requests only a later monitor observation.

- [ ] [0%] **Step 3: Factor exact parent-card lookup and provider proof**

  Extract parent-card construction/lookup from `createJulesPlanReviewInteraction` so posting and recovery use the same `JulesPlanReviewIdentity`. For `approvePlan`, read `getSession` plus activities before retrying; confirm progress only when the session remains the same and the observed plan activity is not superseded. For rejection delivery, change `PlanRevisionRequest` from `prepared | delivered` to `prepared | sent_unconfirmed | confirmed`; only the marker echo confirms the journal effect.

- [ ] [0%] **Step 4: Rework `runJulesLifecycle` around reconciliation results**

  Pass the full `NativePlanEffect`, not only its string ID, to the reconciler. Derive the reducer effect state via Task 2 before every call. On `confirmed`, persist the receipt. On `retry_safe`, record the bounded retry and execute the same idempotent operation. On `await_observation`, return `{ disposition: "deferred" }` without a network mutation. On `inconsistent`, return the reducer's invariant effect and make `execute` surface a stable error code rather than silently blocking.

- [ ] [0%] **Step 5: Run focused tests plus the Task 1 crash matrix**

  ```bash
  ./scripts/workspace-node.sh pnpm --filter @pilleo/paperclip-jules-adapter exec vitest run \
    test/lifecycle-effect-journal.test.ts test/native-plan-effect-reconciler.test.ts \
    test/lifecycle-runner.test.ts test/plan-revision-request.test.ts test/paperclip-client.test.ts \
    test/e2e-plan-presentation.test.ts
  ```

  Expected final assertions: a `started` journal entry never becomes a new POST without a corresponding `retry_safe` read; a confirmed receipt never invokes its dependency.

- [ ] [0%] **Step 6: Commit**

  ```bash
  git add packages/jules/src/server/native-plan-effect-reconciler.ts packages/jules/src/server/lifecycle-effect-journal.ts \
    packages/jules/src/server/lifecycle-runner.ts packages/jules/src/server/paperclip-client.ts \
    packages/jules/src/server/plan-revision-request.ts packages/jules/test
  git commit -m "fix(jules): reconcile native plan effects before retry"
  ```

### Task 4: Replace Legacy Plan Review With a One-Way Native Migration

**Files:**
- Create: `packages/jules/src/server/legacy-plan-review-migration.ts`
- Create: `packages/jules/test/legacy-plan-review-migration.test.ts`
- Modify: `packages/jules/src/server/session.ts`
- Modify: `packages/jules/test/session-codec.test.ts`
- Modify: `packages/jules/src/server/interaction-relay.ts`
- Modify: `packages/jules/test/interaction-relay.test.ts`
- Modify: `packages/jules/src/server/execute.ts`
- Modify: `packages/jules/test/e2e-plan-presentation.test.ts`
- Modify: `packages/jules/test/e2e-scope-drift.test.ts`
- Modify: `packages/jules/test/e2e-jules-orchestration-regression.test.ts`
- Delete: `packages/jules/src/server/plan-adjudication.ts`
- Delete: `packages/jules/src/server/plan-review-client.ts`
- Delete: `packages/jules/test/plan-adjudication.test.ts` if present
- Delete: `packages/jules/test/coverage-completion.test.ts` cases that exercise `createJulesPlanReviewChild`

**Interfaces:**
- Produces `decideLegacyPlanReviewMigration(input): retire_legacy_child | create_native_luna | await_retirement | fail_closed`.
- Consumes a decoded legacy `plan_agent_review`, exact child/run evidence, current immutable plan document/revision, and configured Luna/Terra IDs.
- Produces only a v2 parent-owned `plan_native_review`; new session encodes never emit `plan_agent_review`.

- [ ] [0%] **Step 1: Write the legacy migration truth table**

  Cover pending and deferred legacy plan reviews for both old `vibe` and `strong` stages. For every legacy reviewer JSON comment—including `APPROVE`, `PASS_TO_STRONG`, `REQUEST_REVISION`, and `ESCALATE`—assert the result is independent of the comment body. Cases are:

  ```ts
  ["legacy child is active", "await_retirement"],
  ["legacy child is cancellable", "retire_legacy_child"],
  ["legacy child is cancelled", "create_native_luna"],
  ["legacy evidence is ambiguous", "fail_closed"],
  ["provider question owns the session", "await_retirement"],
  ```

  Test that retirement sends one explicit `status: "cancelled"` patch with `blockParentUntilDone: false`; it must not mark an active child `done`, swallow a 409, or create a parallel Luna card.

- [ ] [0%] **Step 2: Add an inbound-only session representation**

  Keep `plan_agent_review` in the decode union solely for old stored sessions. Introduce a migration record with exact legacy child identity and phase, and make `deferredPlanReview` accept the new native/migration gate instead of only `PlanAgentReviewSchema`. On encode, reject any attempt to serialize a raw `plan_agent_review`; after a successful migration serialize `plan_native_review` with `protocolVersion: 2`, `generation: 0`, and `reviewIssueId` equal to the Jules parent.

- [ ] [0%] **Step 3: Implement the migration with journal ordering**

  Implement `retireLegacyPlanReviewIssue` in `paperclip-client.ts` as an explicit cancellative patch. Persist the migration phase before the PATCH. Only after a confirmed cancelled legacy child may the Task 3 journal create the parent-owned Luna card. Only after the Luna card receipt and `pendingInteraction` pointer persist may the migration marker be cleared. If retirement is locked or the evidence does not name one exact legacy child, preserve the session and return a typed retryable/fail-closed result; never consume the child comment.

- [ ] [0%] **Step 4: Remove the prose path and local-plan-review fallback**

  Delete the `pendingPlanAgentReview` branch at `execute.ts:3716-3768`, its comment APIs, `parsePlanAdjudication`, and `createJulesPlanReviewChild` import. Move the still-needed `composePlanForReview` presentation helper from `plan-reviewer.ts` into `plan-document.ts`; delete `evaluatePlanClarity`, `createCheapReviewer`, `createTerraCodexReviewer`, and their plan-gate fallback. Under required plan approval, missing either configured native reviewer returns `native_plan_review_agents_unconfigured`; under a non-required policy, preserve the provider's configured behavior without creating an implicit review.

- [ ] [0%] **Step 5: Update dependent tests to native evidence**

  Rewrite scope-drift and provider-question fixtures to defer a `plan_native_review`/migration gate rather than a raw legacy child. Update linter fixtures that point at `plan-reviewer.ts` to target `plan-document.ts`. Replace child-card tests with assertions that no source path can call `createJulesPlanReviewChildInteraction`; remove that invalid API after its callers are gone. Preserve question-adjudication tests, which are a different typed workflow.

- [ ] [0%] **Step 6: Run the full Jules package test suite under the workspace launcher**

  ```bash
  ./scripts/workspace-node.sh pnpm --filter @pilleo/paperclip-jules-adapter test
  ./scripts/workspace-node.sh pnpm --filter @pilleo/paperclip-adapter-common test
  ./scripts/workspace-node.sh pnpm typecheck
  rg -n 'plan_agent_review|parsePlanAdjudication|createJulesPlanReviewChild|evaluatePlanClarity|createCheapReviewer' packages/jules/src
  ```

  Expected final search result: `plan_agent_review` appears only in explicitly named legacy decode/migration code; the other four symbols have zero source references.

- [ ] [0%] **Step 7: Commit**

  ```bash
  git add -A packages/jules packages/common/test/linter.test.ts
  git restore --staged docs/superpowers/plans/2026-09-19-paperclip-v916-regression-recovery.md .taskplane
  git commit -m "refactor(jules): migrate plan review to native cards"
  ```

### Task 5: Delegate All Native Plan Control Flow From `execute.ts` to One Coordinator

**Files:**
- Create: `packages/jules/src/server/native-plan-lifecycle-coordinator.ts`
- Create: `packages/jules/test/native-plan-lifecycle-coordinator.test.ts`
- Modify: `packages/jules/src/server/execute.ts`
- Modify: `packages/jules/src/server/lifecycle-runner.ts`
- Modify: `packages/jules/test/e2e-plan-presentation.test.ts`
- Modify: `packages/jules/test/execute-heartbeat-yield.test.ts`
- Modify: `packages/jules/src/server/native-review-provenance.ts`
- Modify: `packages/jules/test/native-review-provenance.test.ts`
- Modify: `packages/jules/src/server/native-plan-review-lifecycle.ts`
- Modify: `packages/jules/test/native-plan-review-lifecycle.test.ts`

**Interfaces:**
- Produces `reconcileNativePlanLifecycle(input): Promise<NativePlanLifecycleOutcome>`.
- Consumes a decoded session, provider state/activity evidence, Paperclip interactions/runs, configuration, and the effect journal.
- Produces one of `await_card`, `advanced_card`, `revision_requested`, `approved`, `await_provider_observation`, `fail_closed`; `execute.ts` only applies that typed outcome and yields.

- [ ] [0%] **Step 1: Write coordinator tests for all plan states before extracting code**

  Use a table over:

  ```ts
  type NativePlanLifecycleOutcome =
    | { readonly kind: "await_card" }
    | { readonly kind: "advanced_card"; readonly cardId: string; readonly stage: "luna" | "terra" }
    | { readonly kind: "revision_requested"; readonly markerActivityId?: string }
    | { readonly kind: "approved" }
    | { readonly kind: "await_provider_observation" }
    | { readonly kind: "fail_closed"; readonly code: string; readonly reason: string };
  ```

  Cover new plan/no card, pending parent card, attested Luna approve, attested Terra approve, typed reject, untrusted resolver, v1 child migration, child v2 migration, started journal entries for every mutation, and a stale newer provider plan. Assert every row makes either zero or exactly one declared operation.

- [ ] [0%] **Step 2: Extract provider/card evidence and construct the reducer state once**

  Build the `JulesLifecycleState` in the coordinator only after reading provider/card/run evidence. It must call Task 2's effect projection, then call `runJulesLifecycle` with the corresponding `heartbeat` or `review_card_resolved` event. Remove all hard-coded `effect: { kind: "not_started" }` literals from `execute.ts`.

- [ ] [0%] **Step 3: Make pointer repair part of the typed outcome**

  If a confirmed card receipt exists but the session still points to the prior stage or has no pointer, reconstruct `plan_native_review` from the current immutable document/revision/stage/generation and persist it before yielding. If a confirmed Terra approval receipt exists but `planApprovedAt` was not persisted, write `planApprovedAt`, `planApprovedActivityId`, `planReviewOutcome: "approved"`, and clear the native gate without calling `approvePlan` again. This closes both local crash windows.

- [ ] [0%] **Step 4: Keep old child-v2 handling as a bounded compatibility adapter**

  Retain `native-review-provenance.ts` and `native-plan-review-lifecycle.ts` only for an already-persisted `reviewerChildIssueId`. Their output may migrate a pending v2 child to the parent, await/retire the child, or fail closed. They must not create a new child, parse a comment, or participate in the normal parent-card flow. Add a test asserting newly created sessions never enter that branch.

- [ ] [0%] **Step 5: Reduce `execute.ts` to sequencing, precedence, and typed outcomes**

  Keep priority ordering explicit: immutable same-session PR rejection first, unresolved provider question second, native plan coordinator third, ordinary provider state fourth. Remove direct `createJulesPlanReviewInteraction`, direct plan `approvePlan`, plan `sendMessage`, and all native-card parsing from `execute.ts`; the only remaining plan call is `reconcileNativePlanLifecycle(...)` plus an exhaustive outcome switch.

- [ ] [0%] **Step 6: Run guards and the focused adapter matrix**

  ```bash
  ./scripts/adkw doctor
  ./scripts/adkw blast-radius reconcileNativePlanLifecycle
  ./scripts/adkw guard packages/jules/src/server/native-plan-lifecycle-coordinator.ts --stage test
  ./scripts/workspace-node.sh pnpm --filter @pilleo/paperclip-jules-adapter exec vitest run \
    test/native-plan-lifecycle-coordinator.test.ts test/native-plan-review-lifecycle.test.ts \
    test/native-review-provenance.test.ts test/e2e-plan-presentation.test.ts test/execute-heartbeat-yield.test.ts
  ```

  Record any ADK `PARTIAL`/`UNAVAILABLE` output as degraded evidence; do not claim parser-backed coverage from a lexical fallback.

- [ ] [0%] **Step 7: Commit**

  ```bash
  git add packages/jules/src/server packages/jules/test
  git commit -m "refactor(jules): centralize native plan lifecycle"
  ```

### Task 6: Stabilize Monitor Ownership Without Turning the Orchestrator Into a Provider Engine

**Files:**
- Create: `packages/jules/src/server/jules-monitor-schedule.ts`
- Create: `packages/jules/test/jules-monitor-schedule.test.ts`
- Modify: `packages/jules/src/server/session.ts`
- Modify: `packages/jules/src/server/execute.ts`
- Modify: `packages/jules/test/execute-heartbeat-yield.test.ts`
- Modify: `packages/orchestrator/src/core/jules-monitor-reconciliation.ts`
- Modify: `packages/orchestrator/test/jules-monitor-reconciliation.test.ts`
- Modify: `packages/orchestrator/src/core/jules-plan-verdict-continuation.ts`
- Modify: `packages/orchestrator/test/jules-plan-verdict-continuation.test.ts`

**Interfaces:**
- Produces `decideJulesMonitorSchedule(input): schedule | retain | none` from persisted `nextPollNotBefore`, provider state, and configured cadence.
- Produces an orchestrator decision that may only `preserve` or issue one parent wake from a shared parsed v2 card identity.

- [ ] [0%] **Step 1: Write monitor cadence tests before changing timing**

  Parameterize a session with a 900-second configured cadence. Assert the initial five-second poll is allowed exactly once after a durable provider mutation; subsequent healthy `yieldHeartbeat` calls before `nextPollNotBefore` return `retain` and do not call `scheduleJulesSessionMonitor`. Plan rejection/marker observation must use the configured cadence, not an unconditional sixty seconds. Human-only waits produce `none`.

- [ ] [0%] **Step 2: Persist the next poll decision**

  Add a typed `julesMonitorSchedule` session field containing `nextPollNotBefore`, `reason`, and `initialObservationConsumed`. Persist it before the monitor request. After a successful request persist its monitor identity/timestamp; after a transient request failure preserve the same schedule and return a retryable adapter result without posting a comment. Eliminate calls that pass `true` merely because a normal branch wants to yield.

- [ ] [0%] **Step 3: Narrow the orchestrator bridge to a wake-only compatibility seam**

  Replace the orchestrator's native-plan regex with Task 2's parser. Its `resolvedJulesPlanVerdict` input must require the exact parent/session/revision/stage/generation/target and may wake at most once per interaction ID. It must never patch a review card, create a card, approve a plan, send a provider message, or inspect reviewer prose. Keep the motivation comment: remove this seam when Paperclip provides a parent-continuation target for addressed native verdicts.

- [ ] [0%] **Step 4: Add the cross-owner negative tests**

  Assert no combination of parent status (`backlog`, `todo`, `blocked`, `in_progress`), card state (pending/answered/untrusted), and monitor state lets both adapter and orchestrator issue the same wake. Assert a stale/foreign/recovery-malformed key yields `preserve`. Assert that an answered typed card wakes the Jules parent once but cannot dispatch Terra or approve Jules from the orchestrator.

- [ ] [0%] **Step 5: Run both package matrices and full existing E2E scripts**

  ```bash
  ./scripts/workspace-node.sh pnpm --filter @pilleo/paperclip-jules-adapter exec vitest run test/jules-monitor-schedule.test.ts test/execute-heartbeat-yield.test.ts
  ./scripts/workspace-node.sh pnpm --filter @pilleo/paperclip-adapter-orchestrator exec vitest run test/jules-monitor-reconciliation.test.ts test/jules-plan-verdict-continuation.test.ts test/execute-continuation.test.ts
  ./scripts/workspace-node.sh pnpm test:e2e
  ./scripts/workspace-node.sh pnpm test:e2e:jules-recovery
  ```

- [ ] [0%] **Step 6: Commit**

  ```bash
  git add packages/jules/src/server packages/jules/test packages/orchestrator/src/core packages/orchestrator/test
  git commit -m "fix(jules): persist native monitor cadence"
  ```

### Task 7: Prove the Whole Protocol in a Real Process Before Any Live Recovery

**Files:**
- Modify: `packages/orchestrator/test/fixtures/scripted-jules-server.ts`
- Modify: `packages/orchestrator/test/e2e-jules-restart-lifecycle.test.ts`
- Modify: `packages/orchestrator/scripts/e2e-jules-recovery.ts`
- Modify: `packages/orchestrator/scripts/e2e-paperclip-lifecycle.ts`
- Modify: `packages/jules/docs/failure-recovery.md`
- Modify: `packages/orchestrator/README.md`

**Interfaces:**
- Produces a process-level executable proof using the built adapters, a real local Paperclip SQLite database, strict Jules/Paperclip HTTP fixtures, and no mocked database calls.
- Produces machine-checkable cardinality assertions for sessions, native cards, typed decisions, provider mutations, monitors, PR links, merge reports, and dependency release.

- [ ] [0%] **Step 1: Extend the strict fixture from transport calls to a stateful lifecycle**

  Model provider phases `PLANNING → AWAITING_PLAN_APPROVAL → IN_PROGRESS → COMPLETED`, v2 parent-card creation/answering, and a mergeable PR work product. The fixture must reject unexpected calls and expose counts by identity. It must serve an exact same-session new plan after a typed rejection and reject any second `sendMessage` for the same marker.

- [ ] [0%] **Step 2: Write the full restart matrix using real adapter processes**

  Start Paperclip with a temporary SQLite home and installed built `dist/index.js` adapters. Execute task A, approve its plan through Luna then Terra fixture cards, inject one process termination at each Task 1 crash boundary, restart, and assert convergence. After PR review/merge, assert A is `done`; create B with an explicit dependency on A, approve B upfront, and assert B receives no Jules session before A is done and exactly one session afterward.

- [ ] [0%] **Step 3: Add non-negotiable cardinality assertions**

  The test must assert:

  ```ts
  expect(counts).toMatchObject({
    julesSessionsPerIssue: 1,
    lunaCardsPerRevision: 1,
    terraCardsPerLunaApproval: 1,
    nativeVerdictDeliveriesPerCard: 1,
    providerRevisionMessagesPerReject: 1,
    prLinksPerIssue: 1,
    mergeReportsPerIssue: 1,
    waitingStatusComments: 0,
    prosePlanVerdictReads: 0,
  });
  ```

  Include one untrusted human override test that yields exactly one recovery generation and no approval; include a second override that fails closed with a visible code.

- [ ] [0%] **Step 4: Run the complete local gate with output captured**

  ```bash
  ./scripts/workspace-node.sh pnpm test
  ./scripts/workspace-node.sh pnpm build
  ./scripts/workspace-node.sh pnpm typecheck
  ./scripts/workspace-node.sh pnpm test:e2e
  ./scripts/workspace-node.sh pnpm test:e2e:jules-recovery
  ./scripts/workspace-node.sh pnpm test:fleet
  ./scripts/workspace-node.sh pnpm check:secrets
  git diff --check
  ```

  Save each complete result in `/tmp/pc-adapters-native-plan-final/`; do not treat truncated terminal output as verification evidence.

- [ ] [0%] **Step 5: Document the resulting ownership and recovery contract**

  Update the recovery guide and README with: the native-only Luna→Terra ladder; the exact journal states and reconciliation table; inbound-only legacy migration; why the adapter, not the orchestrator, owns provider mutations; the persisted poll cadence; the sole current Paperclip compatibility bridge; and the upstream feature that would remove it.

- [ ] [0%] **Step 6: Commit**

  ```bash
  git add packages/orchestrator packages/jules/docs packages/orchestrator/README.md
  git commit -m "test(e2e): prove durable Jules native plan flow"
  ```

### Task 8: Perform One Frozen Live Canary and Recover Existing Work Safely

**Files:**
- Modify: `packages/jules/docs/failure-recovery.md`
- Modify: `packages/orchestrator/README.md`

**Interfaces:**
- Consumes the clean commit and Task 7 proof only.
- Produces an evidence record for one real disposable project run; it does not modify source after observation begins.

- [ ] [0%] **Step 1: Preflight the exact deployed binary**

  From a clean tree at the Task 7 commit, run `pnpm build`, record `git rev-parse HEAD` and SHA-256 hashes of `packages/jules/dist/index.js` and `packages/orchestrator/dist/index.js`, then restart Paperclip once. Confirm startup logs load those two exact files and allow one orchestrator heartbeat to reconcile agents. If the deployment does not load those hashes, stop; do not use live tasks as a debugger.

- [ ] [0%] **Step 2: Run one disposable A → B dependency canary**

  Create two minimal relevant disposable issues in one existing disposable Paperclip project with B explicitly depending on A. Approve both before execution. Observe A through Jules plan, Luna typed approval, Terra typed approval, implementation, PR registration, required PR reviews, and a standard merge commit. Observe B remain unscheduled until A becomes `done`, then repeat the same path for B.

- [ ] [0%] **Step 3: Apply success gates and preserve forensic evidence**

  The canary passes only if its session IDs remain stable, every card is parent-owned and typed, no reviewer comment is read as protocol input, no waiting-status message repeats, the monitor cadence stays at the configured interval, each PR has one link and merge report, and both tasks become `done` in dependency order. Export issue/interactions/runs/session evidence to `/tmp/pc-adapters-native-plan-live-canary/` before considering any real MAZ recovery.

- [ ] [0%] **Step 4: Recover existing work only through the migration classifier**

  For an existing issue, collect its stored session, provider state/activities, parent interactions, child/run evidence, and journal. Run `decideLegacyPlanReviewMigration`/the native coordinator in dry-run mode. Apply only a `retire_legacy_child` or exact parent-card recovery that the classifier proves; any `fail_closed` result remains visible for manual investigation and must not create a new Jules session.

- [ ] [0%] **Step 5: Commit documentation-only canary evidence references**

  ```bash
  git add packages/jules/docs/failure-recovery.md packages/orchestrator/README.md
  git commit -m "docs(jules): record native lifecycle canary procedure"
  ```

## Self-Review Record

- **Root cause coverage:** Tasks 2–5 remove the duplicated legacy/comment state machine, direct out-of-runner operations, `started → not_started` projection bug, parser disagreement, and monitor-churn condition at their sources.
- **Safety coverage:** Task 3 distinguishes `confirmed`, `retry_safe`, `await_observation`, and `inconsistent`; only the first two can mutate, and only `retry_safe` permits a replay.
- **Migration coverage:** Task 4 treats all old Vibe/strong child results as non-authoritative input and retires/migrates them before a new Luna review. No new source path can create a legacy child.
- **Provider-independence:** The protocol uses Paperclip native forms and the existing Jules API contract, but its typed reducer/journal/identity separation applies to any provider adapter that implements the same typed effect boundary.
- **Type consistency:** Shared card identity enters Common before both Jules and orchestrator consume it; effect reconciliation enters Jules before the coordinator; session migration precedes removal of old branches; E2E follows the final integration.
- **TDD coverage:** Every production task has explicit red tests, focused green commands, package-level regression commands, and a commit boundary. Task 7 is the only completion proof; Task 8 is a frozen deployment observation, not a development loop.
- **Known upstream gap:** Paperclip presently does not provide a parent-continuation target for an addressed native verdict. The orchestrator wake bridge remains documented, identity-limited, and removable; it cannot make a review decision or provider mutation.
