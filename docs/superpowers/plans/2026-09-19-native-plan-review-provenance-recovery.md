# Native Plan Review Provenance Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore reliable Luna→Terra plan review by keeping native verdict cards on the Jules parent issue, and migrate existing cross-issue child cards without duplicate reviews or free-text decisions.

**Architecture:** A Jules plan is an artifact of the parent implementation issue, so its native `request_item_verdicts` interaction must live on that same issue. Reviewer identity belongs in `addresseeAgentId`; it does not require changing issue ownership or creating a reviewer child. The Jules state machine owns card creation and verdict consumption, while the orchestrator owns cross-agent dispatch and bounded recovery. Existing child-card sessions are handled by one explicit typed migration transition.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces, Paperclip native interactions, real local Paperclip v2026.916.0 for final E2E verification.

**Spec:** Live regression evidence from MAZ-1543/MAZ-1547 and `docs/superpowers/plans/2026-09-19-jules-plan-review-live-path-recovery.md`.

## Global Constraints

- No normal issue comment, provider prose, or GitHub comment may substitute for a structured native verdict.
- Never dispatch more than one active reviewer run for one pending interaction.
- Luna must approve before Terra receives a card.
- A rejection must return to the same Jules provider session and create at most one replacement plan generation.
- Keep compatibility reads for legacy reviewer-child sessions until their persisted state has migrated.
- Do not modify Paperclip core for this adapter-side repair; encode the host provenance contract in adapter tests and documentation.
- Run the focused E2E suite after every implementation slice and the full workspace suite before live recovery.

## Root-cause evidence

- [100%] Paperclip `buildExecutionContinuation` resolves `triggerInteraction.sourceRunId` only when that run's `contextSnapshot.issueId` equals the interaction's issue; otherwise it throws `continuation_source_context_missing`.
- [100%] MAZ-1547 card `b00ac1bb-58a1-41bc-8948-11a4ceb01023` lives on reviewer child MAZ-1547 but cites parent Jules run `92effc5e-6f65-4a3c-9bd8-a6f72280da7c`, whose issue is MAZ-1543.
- [100%] The last successful MAZ-1535 Luna and Terra cards lived directly on MAZ-1535, and each source Jules run was scoped to MAZ-1535.
- [100%] Commit `16bc2f3` replaced `createJulesPlanReviewInteraction(taskId, ...)` with child creation plus `createJulesPlanReviewChildInteraction(reviewerChild.id, ...)`; this violated the host's same-issue continuation provenance invariant.
- [100%] Current adapter tests mock dispatch acceptance and therefore did not model Paperclip's source-run/interaction issue equality check.

## Review Focus

- A parent-scoped Jules run creates a parent-scoped Luna card and never creates a reviewer child.
- An existing child-scoped card with a parent-scoped source run migrates exactly once to the parent and is withdrawn only after the replacement exists.
- A legacy child card that is already answered remains authoritative and is never replayed or migrated.
- Luna approval creates one parent-scoped Terra card; Luna rejection creates no Terra card.
- Recovery never falls back to generic wake, free-text comment, issue reassignment, or a second active run.

---

### Task 1: Encode the Paperclip provenance invariant

**Files:**
- Create: `packages/jules/src/server/native-review-provenance.ts`
- Create: `packages/jules/test/native-review-provenance.test.ts`
- Modify: `packages/jules/src/server/native-plan-review-lifecycle.ts`
- Test: `packages/jules/test/native-plan-review-lifecycle.test.ts`

**Interfaces:**
- Consumes: parent issue ID, review issue ID, source-run issue ID, interaction status.
- Produces: `NativePlanReviewLocation` and exhaustive `NativePlanReviewMigrationDecision` unions.

- [x] [100%] **Step 1: Write parameterized failing provenance tests**

  Cover the Cartesian cases: parent card/same source, child card/parent source, child card/child source, answered legacy child, missing source identity. Assert only pending child-card/parent-source yields `migrate_to_parent`; answered cards yield `consume_existing`; valid parent cards yield `keep`.

- [x] [100%] **Step 2: Run the red tests**

  Run: `pnpm --filter @pilleo/paperclip-jules-adapter exec vitest run test/native-review-provenance.test.ts test/native-plan-review-lifecycle.test.ts`

  Expected: FAIL because the provenance types and migration transition do not exist.

- [x] [100%] **Step 3: Implement the pure exhaustive state machine**

  Add branded non-empty issue IDs and a discriminated union with no boolean combinations. Use exhaustive `switch` statements for `keep`, `migrate_to_parent`, `consume_existing`, and `fail_closed`. Keep host-specific provenance rules out of `execute.ts`.

- [x] [100%] **Step 4: Run focused tests and guard receipts**

  Run the focused Vitest command, then `./scripts/adkw guard packages/jules/src/server/native-review-provenance.ts --stage test`.

- [x] [100%] **Step 5: Commit**

  Commit: `test(jules): model native review provenance`

### Task 2: Restore parent-owned native plan cards

**Files:**
- Modify: `packages/jules/src/server/paperclip-client.ts`
- Modify: `packages/jules/src/server/execute.ts`
- Modify: `packages/jules/src/server/session.ts`
- Modify: `packages/jules/src/server/plan-review-protocol.ts`
- Test: `packages/jules/test/paperclip-client.test.ts`
- Test: `packages/jules/test/e2e-plan-presentation.test.ts`
- Test: `packages/jules/test/session-codec.test.ts`

**Interfaces:**
- Consumes: `createJulesPlanReviewInteraction(parentIssueId, ...)` and the Task 1 provenance decision.
- Produces: parent-scoped Luna/Terra cards and persisted `reviewIssueId` equal to the parent task ID.

- [x] [100%] **Step 1: Write failing parent-card tests**

  Assert initial Luna creation, legacy human-card migration, Luna→Terra promotion, cancelled-card restoration, and revised-plan generation all POST interactions to the parent `taskId`. Assert no `createJulesPlanReviewChild` or `activateInternalReviewIssue` call occurs for plan review.

- [x] [100%] **Step 2: Run the red E2E slice**

  Run: `pnpm --filter @pilleo/paperclip-jules-adapter exec vitest run test/paperclip-client.test.ts test/e2e-plan-presentation.test.ts test/session-codec.test.ts`

  Expected: existing child-card assertions fail.

- [x] [100%] **Step 3: Replace child creation with parent interaction creation**

  Restore one typed `createJulesPlanReviewInteraction` API. Keep `addresseeAgentId`, immutable Jules session/revision identity, `continuationPolicy: "none"`, and idempotency key unchanged. Persist `reviewIssueId: taskId`; decode legacy `reviewerChildIssueId` only as migration input.

- [x] [100%] **Step 4: Remove plan-only child activation paths**

  Delete plan-review calls to `createJulesPlanReviewChild` and `activateInternalReviewIssue`. Do not alter question-adjudication children, which have a different ownership and escalation contract.

- [x] [100%] **Step 5: Run the focused E2E suite and build**

  Run the Step 2 command and `pnpm --filter @pilleo/paperclip-jules-adapter build`.

- [x] [100%] **Step 6: Commit**

  Commit: `fix(jules): keep plan verdicts on parent issue`

### Task 3: Migrate pending legacy child cards exactly once

**Files:**
- Modify: `packages/jules/src/server/execute.ts`
- Modify: `packages/jules/src/server/native-plan-review-lifecycle.ts`
- Modify: `packages/jules/src/server/session.ts`
- Test: `packages/jules/test/e2e-plan-presentation.test.ts`
- Test: `packages/jules/test/execute-heartbeat-yield.test.ts`

**Interfaces:**
- Consumes: `migrate_to_parent` from Task 1 and parent-card creation from Task 2.
- Produces: one replacement parent card, a persisted replacement pointer, and one withdrawn obsolete child card.

- [x] [100%] **Step 1: Write failing migration tests**

  Model MAZ-1543/1547 exactly: persisted pending child card, failed reviewer run with `continuation_source_context_missing`, parent source run, and no active reviewer run. Assert ordering: create/recover parent card → persist new pointer → withdraw old child card. Replaying the heartbeat must perform zero writes.

- [x] [100%] **Step 2: Add fail-closed edge tests**

  Assert no migration when the child card is answered, when a reviewer run is queued/running, when the parent revision changed, or when replacement creation fails. The old card must remain visible on replacement failure.

- [x] [100%] **Step 3: Run red tests**

  Run: `pnpm --filter @pilleo/paperclip-jules-adapter exec vitest run test/e2e-plan-presentation.test.ts test/execute-heartbeat-yield.test.ts`

- [x] [100%] **Step 4: Implement checkpointed migration**

  Use the existing mutation checkpoint mechanism with an idempotency key derived from parent issue, provider session, revision, stage, and legacy card ID. Never infer migration from error text alone; require the typed cross-issue provenance mismatch plus a pending card and terminal/no reviewer run.

- [x] [100%] **Step 5: Run focused tests and build**

  Run the Step 3 command and Jules build.

- [x] [100%] **Step 6: Commit**

  Commit: `fix(jules): migrate cross-issue plan cards`

### Task 4: Make orchestrator recovery parent-card aware

**Files:**
- Modify: `packages/orchestrator/src/core/native-review-recovery-state.ts`
- Modify: `packages/orchestrator/src/server/execute.ts`
- Test: `packages/orchestrator/test/native-review-recovery-state.test.ts`
- Test: `packages/orchestrator/test/execute-jules-plan-review-recovery.test.ts`

**Interfaces:**
- Consumes: parent issue interactions, legacy child interactions, reviewer runs, and persisted Jules card identity.
- Produces: exhaustive recovery actions `await_owner_migration`, `dispatch_parent_card`, `await_active_run`, `consume_answered`, or `no_action`.

- [x] [100%] **Step 1: Write failing table-driven recovery tests**

  Include: valid pending parent card/no run; pending child card with provenance failure; answered parent card; active exact-card run; stale failed unrelated run; and both parent plus obsolete child cards. Assert parent card wins and only its exact interaction can be dispatched.

- [x] [100%] **Step 2: Run red orchestrator tests**

  Run: `pnpm --filter @pilleo/paperclip-orchestrator-adapter exec vitest run test/native-review-recovery-state.test.ts test/execute-jules-plan-review-recovery.test.ts`

- [x] [100%] **Step 3: Implement parent-card recovery selection**

  Scan the Jules parent interactions first. Treat a child provenance failure as a signal to wake/recover the Jules owner for typed migration, not as a reason to retry Luna. Dispatch only through `dispatchNativeReview`/`prepareAndWakeNativeReview`; retain final card/run revalidation immediately before the write.

- [x] [100%] **Step 4: Prove no compatibility spam**

  Assert repeated orchestrator ticks during migration produce neither Luna wakes nor comments. Once the parent card exists, exactly one Luna dispatch is allowed.

- [x] [100%] **Step 5: Run focused tests and orchestrator build**

  Run the Step 2 command and `pnpm --filter @pilleo/paperclip-orchestrator-adapter build`. The real server-backed lifecycle script remains in Task 6 after adapter reload; running it against the stopped old server would not verify this revision.

- [x] [100%] **Step 6: Commit**

  Commit: `0447c4c fix(orchestrator): restore typed provider ownership`

### Task 5: Add a host-contract regression harness

**Files:**
- Modify: `packages/orchestrator/scripts/e2e-jules-recovery.ts`
- Modify: `packages/orchestrator/test/e2e-paperclip-lifecycle.test.ts` or the existing server-backed lifecycle test owning native interactions
- Modify: `packages/orchestrator/README.md`

**Interfaces:**
- Consumes: real Paperclip interaction and heartbeat-run responses.
- Produces: an E2E assertion that the interaction issue, source-run issue, reviewer-run issue, and card identity remain consistent.

- [x] [100%] **Step 1: Write the failing server-backed assertion**

  The fixture must reject a card when `interaction.issueId !== sourceRun.contextSnapshot.issueId`, matching Paperclip v2026.916.0. It must also assert reviewer context contains the exact interaction ID and kind.

- [x] [100%] **Step 2: Demonstrate the old child-card fixture fails**

  Run the focused server-backed test against a child card sourced by a parent run and capture `continuation_source_context_missing`.

- [x] [100%] **Step 3: Switch the fixture to the parent-card path**

  Verify Luna answers the structured card, Terra is created only after Luna approval, and no free-text comment appears.

- [x] [100%] **Step 4: Document the invariant and upstream boundary**

  Explain that Paperclip continuation provenance is issue-scoped; reviewer routing belongs to `addresseeAgentId`; reviewer children must not host Jules plan cards. Document removal criteria for legacy child migration after persisted v2 sessions age out.

- [x] [100%] **Step 5: Run focused E2E tests**

  Run the server-backed lifecycle script and both package-focused suites.

- [x] [100%] **Step 6: Commit**

  Commit: `25cbe2c test(e2e): enforce plan review provenance`

### Task 6: Reload and recover MAZ-1543 without manual verdicts

**Files:**
- Modify only if evidence requires: `docs/superpowers/plans/2026-09-19-jules-plan-review-live-path-recovery.md`

**Interfaces:**
- Consumes: built adapters and existing MAZ-1543/1547 persisted state.
- Produces: one migrated parent Luna card, one Luna verdict, conditional Terra verdict, and resumed Jules execution.

- [x] [100%] **Step 1: Run complete static verification**

  Run: `pnpm test`, `pnpm build`, `pnpm fleet:doctor`, `./scripts/adkw check-backlog`, and `git diff --check`.

- [x] [100%] **Step 2: Restart Paperclip and verify adapter load paths**

  Confirm startup logs name the current orchestrator and Jules `dist/index.js`. Allow one orchestrator heartbeat to reconcile managed agents.

- [ ] [70%] **Step 3: Observe bounded legacy migration**

  Verify MAZ-1547's pending child card is replaced by exactly one parent MAZ-1543 Luna card and withdrawn only after replacement persistence. Verify no duplicate Luna run and no ordinary issue comment.

- [ ] [0%] **Step 4: Follow the live ladder**

  Require Luna's structured verdict. If approved, require exactly one Terra card and verdict; if rejected, require exactly one Jules revision message and a new parent Luna generation. Stop and capture evidence on any new failure family.

- [ ] [0%] **Step 5: Verify provider execution resumes**

  Confirm Jules receives final approval once, continues the existing provider session, and MAZ-1543 leaves the review hold. Verify the parent monitor remains live while provider work continues.

- [ ] [0%] **Step 6: Record evidence and commit docs**

  Update the live recovery plan with run IDs, interaction IDs, verdicts, and timestamps. Commit: `docs: record native plan recovery evidence`.

### Task 7: Final regression review

**Files:**
- Review all files changed by Tasks 1–6.

**Interfaces:**
- Consumes: exact final Git revision and ADK verification receipts.
- Produces: evidence-backed completion verdict.

- [ ] [0%] **Step 1: Review diff and blast radius**

  Run `./scripts/adkw doctor`, `./scripts/adkw blast-radius createJulesPlanReviewInteraction`, `./scripts/adkw blast-radius managedWakeup`, and inspect `git diff --stat` plus `git diff --check`. Record PARTIAL/UNAVAILABLE evidence explicitly.

- [ ] [0%] **Step 2: Run final tests at the exact revision**

  Run full `pnpm test`, `pnpm build`, and the real lifecycle E2E. Preserve logs in `/tmp` and reference the exact commit SHA.

- [ ] [0%] **Step 3: Verify forbidden outcomes remain absent**

  Confirm no plan-review child creation, no generic reviewer wake, no free-text verdict, no duplicate pending card, no duplicate reviewer run, and no `continuation_source_context_missing` in the canary chain.

- [ ] [0%] **Step 4: Request code review**

  Review specifically for provenance equality, migration ordering/idempotency, exhaustive state handling, and preservation of question-adjudication child behavior.
