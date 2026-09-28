# Durable Jules Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the overlapping Jules recovery heuristics with one typed, restart-safe lifecycle that carries an approved task from provider session creation through plan review, implementation, PR review, merge reconciliation, and dependent-task dispatch exactly once.

**Architecture:** A pure exhaustive reducer will consume one normalized lifecycle snapshot and one typed event, then emit idempotent effects. A durable effect journal will distinguish operations that were never attempted, confirmed, or left uncertain by a process interruption. Jules owns provider-session, plan-card, and provider-monitor continuation; the orchestrator owns dependency admission and PR/reviewer orchestration and may only act on Jules through the reducer's typed continuation contract.

**Tech Stack:** TypeScript 5, Vitest, Fastify/HTTP test fixtures, Paperclip v2026.916.0, SQLite-backed Paperclip integration tests, pnpm workspaces.

**Spec:** `docs/superpowers/plans/2026-09-19-paperclip-v916-regression-recovery.md`

> **Execution status:** Tasks 1–4 are retained as completed evidence. Task 5 is an incomplete typed-runner experiment and Tasks 6–8 depend on assumptions disproved by the current code review. Do not execute further steps from this plan; use `docs/superpowers/plans/2026-09-20-native-plan-protocol-consolidation.md` for the corrective sequence. The `[92%]` Task 5 step records partial source work only, not a deployable lifecycle.

## Global Constraints

- Work directly on `master`; do not create Git worktrees.
- Follow red-green-refactor: every production slice begins with a failing test and runs the existing E2E suite after it passes.
- Never infer provider or reviewer state from prose, comments, regexes, or issue labels.
- Never post review decisions as free text; only resolve the addressed native Paperclip verdict card.
- Never create a replacement Jules session while the durable session is remotely live or recoverable.
- Never replay an uncertain remote mutation until read-after-write reconciliation proves it did not happen.
- One build and one Paperclip restart are allowed for final live verification; no code edits or restarts after that canary begins.
- Preserve the current dirty plan file and `.taskplane/` data unless separately authorized.

## Review Focus

- Process interruption after a native card is answered but before the verdict reaches Jules must resume the exact card and never create another review.
- Process interruption before, during, and after a Jules mutation must yield `execute`, `reconcile`, and `observe` respectively, never an unconditional replay.
- Legacy cards without `providerActivityId` must migrate only when parent, session, revision, reviewer, and resolved run form one unique identity.
- A blocked Paperclip issue with a live Jules continuation must be rearmed when the interrupted run performed no provider mutation, but preserved when the mutation outcome is uncertain.
- Duplicate heartbeats, stale cards, stale runs, and provider activity reordering must not create duplicate sessions, messages, cards, reviews, or merge reports.

---

### Task 1: Capture the Current Failure as a Black-Box Restart Test

**Files:**
- Create: `packages/orchestrator/test/fixtures/scripted-jules-server.ts`
- Create: `packages/orchestrator/test/e2e-jules-restart-lifecycle.test.ts`
- Modify: `packages/orchestrator/scripts/e2e-jules-recovery.ts`

**Interfaces:**
- Produces: `startScriptedJulesServer(script: readonly JulesFixtureStep[]): Promise<ScriptedJulesServer>`.
- Produces: a real-process test that uses Paperclip's HTTP API, a real SQLite database, and built adapter `dist` files.

- [x] [100%] **Step 1: Write a failing restart regression**

  Script provider states `PLANNING -> AWAITING_PLAN_APPROVAL -> AWAITING_USER_FEEDBACK`, resolve Luna's native reject card, terminate Paperclip after the card is answered but before provider delivery, restart it, and assert the same session, card, and revision resume. Assert exactly one reject reaches the scripted provider and exactly one next monitor exists.

- [x] [100%] **Step 2: Prove the regression fails on the current code**

  Run `pnpm build && pnpm exec vitest run packages/orchestrator/test/e2e-jules-restart-lifecycle.test.ts --reporter=verbose`. Expected failure: the restarted issue remains blocked/monitorless or a duplicate card/session appears.

- [ ] [0%] **Step 3: Add crash-boundary parameterization**

  Use `it.each` for `before_effect`, `effect_started`, and `effect_confirmed`; assert expected next operation `execute`, `reconcile`, and `observe` respectively.

- [ ] [0%] **Step 4: Run the pre-existing E2E suites unchanged**

  Run `pnpm test:e2e` and `pnpm test:e2e:jules-recovery`; preserve their output as baseline evidence under `/tmp`.

- [ ] [0%] **Step 5: Commit the red test only**

  Commit message: `test(e2e): reproduce interrupted Jules lifecycle`.

### Task 2: Define One Exhaustive Lifecycle Aggregate

**Files:**
- Create: `packages/common/src/jules-lifecycle.ts`
- Create: `packages/common/test/jules-lifecycle.test.ts`
- Modify: `packages/common/src/index.ts`

**Interfaces:**
- Produces: `JulesLifecycleState`, `JulesLifecycleEvent`, `JulesLifecycleEffect`, `reduceJulesLifecycle(state, event)`.
- Consumes: no Paperclip client, network, clock, or environment dependency.

- [x] [100%] **Step 1: Write table-driven transition tests**

  Cover provider phase, native gate, run lease, monitor, and effect-attempt combinations. Include stale revision, duplicate heartbeat, legacy unique-card migration, interrupted pre-effect run, and uncertain remote effect.

- [x] [100%] **Step 2: Verify the tests fail because the aggregate does not exist**

  Run `pnpm exec vitest run packages/common/test/jules-lifecycle.test.ts`.

- [x] [100%] **Step 3: Add discriminated unions with no optional-state booleans**

  Define states equivalent to:

  ```ts
  type EffectAttempt =
    | { kind: "not_started" }
    | { kind: "started"; effectId: string; startedAt: string }
    | { kind: "confirmed"; effectId: string; receipt: string };

  type ReviewGate =
    | { kind: "none" }
    | { kind: "pending"; cardId: string; revisionId: string; reviewer: "luna" | "terra" }
    | { kind: "resolved"; cardId: string; revisionId: string; verdict: "approve" | "reject"; runId: string };
  ```

  Model provider, lease, and monitor phases similarly. Use exhaustive `switch` statements and `assertNever` for every state/event pair.

- [x] [100%] **Step 4: Implement the minimal reducer to satisfy the matrix**

  Effects are data only: `create_card`, `deliver_verdict`, `poll_provider`, `rearm_monitor`, `reconcile_effect`, `preserve`, `complete_issue`, and `report_invariant_violation`.

- [x] [100%] **Step 5: Run common tests, workspace typecheck, and existing E2E**

  Run `pnpm exec vitest run packages/common/test/jules-lifecycle.test.ts`, `pnpm typecheck`, and `pnpm test:e2e:jules-recovery`.

- [x] [100%] **Step 6: Commit**

  Commit message: `refactor(common): model exhaustive Jules lifecycle`.

### Task 3: Normalize Paperclip and Jules Evidence Once

**Files:**
- Create: `packages/jules/src/server/lifecycle-snapshot.ts`
- Create: `packages/jules/test/lifecycle-snapshot.test.ts`
- Modify: `packages/jules/src/server/paperclip-client.ts`
- Modify: `packages/jules/src/server/native-review-attestation.ts`
- Modify: `packages/jules/src/server/plan-gate-state.ts`

**Interfaces:**
- Produces: `buildJulesLifecycleSnapshot(input: RawLifecycleEvidence): SnapshotResult` where `SnapshotResult` is `valid | legacy_unique | inconsistent`.
- Consumes: complete native interaction provenance including `resolvedByAgentId`, `resolvedByUserId`, and `resolvedByRunId`.

- [x] [100%] **Step 1: Write parser tests using raw Paperclip v2026.916.0 HTTP payloads**

  Do not mock `listPaperclipInteractions`; pass the actual response shape through `interactionFromResponse`. Cover local-board resolution with a valid `resolvedByRunId`, direct agent resolution, missing provider activity identity, and two ambiguous matching plan activities.

- [x] [100%] **Step 2: Verify the tests fail at the transport boundary**

  Run `pnpm exec vitest run packages/jules/test/paperclip-client.test.ts packages/jules/test/lifecycle-snapshot.test.ts`.

- [x] [100%] **Step 3: Preserve all provenance in the transport schema**

  Parse fields once and reject malformed combinations explicitly. The snapshot builder may return `legacy_unique` only when exactly one parent/session/revision/reviewer/run tuple matches.

- [ ] [0%] **Step 4: Replace attestation and plan-gate projection helpers with snapshot queries**

  Keep temporary compatibility wrappers only where callers still compile; mark them for removal in Task 7.

- [ ] [0%] **Step 5: Run focused tests, all Jules tests, typecheck, and E2E**

  Run `pnpm exec vitest run packages/jules/test/paperclip-client.test.ts packages/jules/test/lifecycle-snapshot.test.ts packages/jules/test/native-review-attestation.test.ts packages/jules/test/plan-gate-state.test.ts`, `pnpm --filter @pilleo/paperclip-adapter-jules test`, `pnpm typecheck`, and `pnpm test:e2e:jules-recovery`.

- [x] [100%] **Step 6: Commit**

  Commit message: `refactor(jules): normalize lifecycle evidence once`.

### Task 4: Add a Durable Effect Journal and Restart Semantics

**Files:**
- Create: `packages/jules/src/server/lifecycle-effect-journal.ts`
- Create: `packages/jules/test/lifecycle-effect-journal.test.ts`
- Modify: `packages/jules/src/server/session.ts`
- Modify: `packages/jules/src/server/session-store.ts`
- Modify: `packages/jules/src/server/mutation-checkpoint.ts`

**Interfaces:**
- Produces: `beginEffect`, `confirmEffect`, `classifyInterruptedEffect`, and versioned journal entries keyed by deterministic `effectId`.
- Consumes: reducer effects from Task 2.

- [x] [100%] **Step 1: Write persistence and crash-boundary tests against the real session store**

  Parameterize interruption before journal write, after `started`, and after `confirmed`. Assert restart classification `execute`, `reconcile`, and `observe`; never infer success from process exit status.

- [x] [100%] **Step 2: Verify the tests fail**

  Run `pnpm exec vitest run packages/jules/test/lifecycle-effect-journal.test.ts packages/jules/test/execute-checkpoint-restart.test.ts`.

- [x] [100%] **Step 3: Implement versioned journal persistence**

  Persist before network mutation and confirm only with a provider/Paperclip receipt. For uncertain Jules mutations, reconcile by correlation marker and activity identity before sending anything again.

- [x] [100%] **Step 4: Migrate old checkpoints without replay**

  Decode old sessions as `started` when a mutation may have escaped; force read-after-write reconciliation instead of treating absence of a receipt as absence of the mutation.

- [x] [100%] **Step 5: Run focused, package, and type tests; defer process E2E to Task 7's isolated server harness**

  Run `pnpm exec vitest run packages/jules/test/lifecycle-effect-journal.test.ts packages/jules/test/mutation-checkpoint.test.ts packages/jules/test/execute-checkpoint-restart.test.ts`, `pnpm --filter @pilleo/paperclip-adapter-jules test`, `pnpm typecheck`, and `pnpm test:e2e:jules-recovery`.

- [x] [100%] **Step 6: Commit**

  Commit message: `feat(jules): journal lifecycle effects durably`.

### Task 5: Make the Reducer the Only Jules Control-Flow Authority

**Files:**
- Create: `packages/jules/src/server/lifecycle-runner.ts`
- Create: `packages/jules/test/lifecycle-runner.test.ts`
- Modify: `packages/jules/src/server/execute.ts`
- Modify: `packages/jules/test/e2e-plan-presentation.test.ts`
- Modify: `packages/jules/test/review-feedback-relay.test.ts`

**Interfaces:**
- Produces: `runJulesLifecycle(snapshot, dependencies): Promise<AdapterExecutionResult>`.
- Consumes: normalized snapshot, pure reducer, and effect journal.

- [x] [100%] **Step 1: Write runner tests that reject duplicate or prose-based effects**

  Assert one resolved native card produces exactly one typed transition: Luna approval creates Terra's card, Terra approval calls `approvePlan`, and rejection prepares a revision request. Assert repeated heartbeats never duplicate an already-confirmed transition and no native-plan review path calls `sendMessage`.

- [x] [100%] **Step 2: Verify the tests fail**

  Run `pnpm exec vitest run packages/jules/test/lifecycle-runner.test.ts packages/jules/test/e2e-plan-presentation.test.ts`.

- [ ] [92%] **Step 3: Implement effect execution behind typed adapters**

  Keep provider I/O, Paperclip mutations, and persistence in dependency interfaces. Every effect begins and confirms through Task 4's journal.

- [ ] [0%] **Step 4: Reduce `execute.ts` to input extraction and lifecycle delegation**

  Remove plan-review, monitor-repair, and interrupted-run branching from `execute.ts` as each behavior migrates. Do not preserve duplicate fallback paths.

- [ ] [0%] **Step 5: Run ADK blast-radius and guards**

  Run `./scripts/adkw doctor`, `./scripts/adkw blast-radius runJulesLifecycle`, and `./scripts/adkw guard packages/jules/src/server/lifecycle-runner.ts --stage test`. Record PARTIAL/UNAVAILABLE evidence as degraded instead of claiming parser verification.

- [ ] [0%] **Step 6: Run Jules package, typecheck, and both E2E suites**

  Run `pnpm --filter @pilleo/paperclip-adapter-jules test`, `pnpm typecheck`, `pnpm test:e2e`, and `pnpm test:e2e:jules-recovery`.

- [ ] [0%] **Step 7: Commit**

  Commit message: `refactor(jules): centralize lifecycle execution`.

### Task 6: Establish a Single Ownership Boundary with the Orchestrator

**Files:**
- Create: `packages/orchestrator/src/core/jules-continuation-contract.ts`
- Create: `packages/orchestrator/test/jules-continuation-contract.test.ts`
- Modify: `packages/orchestrator/src/core/jules-execution-blocker-reconciliation.ts`
- Modify: `packages/orchestrator/src/core/jules-monitor-reconciliation.ts`
- Modify: `packages/orchestrator/src/core/jules-plan-verdict-continuation.ts`
- Modify: `packages/orchestrator/src/server/execute.ts`

**Interfaces:**
- Produces: `decideJulesContinuation(snapshot): preserve | dispatch_jules | complete` with an evidence-bearing reason.
- Consumes: Jules lifecycle projection; never reconstructs provider semantics independently.

- [ ] [0%] **Step 1: Write a cross-product ownership test**

  Parameterize issue status, execution run status, provider continuation, effect attempt, and monitor status. A pre-effect interrupted run with a live session must dispatch Jules; an uncertain effect must preserve and request reconciliation; a confirmed continuation must monitor; no row may create a session or deliver a verdict.

- [ ] [0%] **Step 2: Verify the test fails against current overlapping reducers**

  Run `pnpm exec vitest run packages/orchestrator/test/jules-continuation-contract.test.ts packages/orchestrator/test/jules-execution-blocker-reconciliation.test.ts packages/orchestrator/test/jules-monitor-reconciliation.test.ts`.

- [ ] [0%] **Step 3: Implement the continuation contract and exhaustive switch**

  Orchestrator owns dependency admission, reviewer lane ordering, PR reconciliation, and merge completion. Jules owns session reuse, plan cards, provider questions, verdict delivery, and provider monitor rearming.

- [ ] [0%] **Step 4: Delete superseded orchestrator heuristics**

  Fold blocker, monitor, and plan-verdict continuation into the contract. Keep no second interpretation of `providerStopped`, monitor-clear reason, or native-card provenance.

- [ ] [0%] **Step 5: Run orchestrator package, typecheck, and E2E**

  Run `pnpm --filter @pilleo/paperclip-adapter-orchestrator test`, `pnpm typecheck`, `pnpm test:e2e`, and `pnpm test:e2e:jules-recovery`.

- [ ] [0%] **Step 6: Commit**

  Commit message: `refactor(orchestrator): enforce Jules continuation ownership`.

### Task 7: Prove the Entire Lifecycle Under Restart and Remove Old Hacks

**Files:**
- Modify: `packages/orchestrator/test/e2e-jules-restart-lifecycle.test.ts`
- Modify: `packages/orchestrator/scripts/e2e-paperclip-lifecycle.ts`
- Modify: `packages/orchestrator/scripts/e2e-jules-recovery.ts`
- Modify: `packages/jules/src/server/execute.ts`
- Delete only after zero references: superseded compatibility helpers from plan-gate, attestation, blocker, and monitor reconciliation modules.

**Interfaces:**
- Consumes: all previous task interfaces.
- Produces: a CI gate for task approval through dependent-task dispatch.

- [ ] [0%] **Step 1: Extend the black-box test through merge and dependency release**

  Script task A and dependent task B. Approve both upfront; assert B remains unscheduled until A's PR is recognized as merged and A becomes done, then B receives exactly one provider session.

- [ ] [0%] **Step 2: Inject restarts at every durable boundary**

  Cover plan observed, card created, card answered, verdict effect started, verdict confirmed, revised plan observed, Luna approved, Terra approved, PR observed, merge observed, and dependent release.

- [ ] [0%] **Step 3: Add cardinality assertions**

  Assert one Jules session per task, one card per stage/revision, one verdict delivery per card, one PR link, one merge report, zero free-text reviews, and zero repeated waiting-status comments.

- [ ] [0%] **Step 4: Run the complete gate**

  Run `pnpm test`, `pnpm build`, `pnpm typecheck`, `pnpm test:e2e`, `pnpm test:e2e:jules-recovery`, `pnpm test:fleet`, `pnpm check:secrets`, and `git diff --check`.

- [ ] [0%] **Step 5: Remove only behavior proven redundant by the passing matrix**

  Search for old recovery entry points and delete wrappers with no callers. Re-run Task 7 Step 4 after each deletion batch.

- [ ] [0%] **Step 6: Commit**

  Commit message: `test(e2e): gate durable Jules lifecycle`.

### Task 8: Migrate MAZ-1543 Once, Then Run a Frozen Live Canary

**Files:**
- Create: `packages/orchestrator/src/core/legacy-jules-migration.ts`
- Create: `packages/orchestrator/test/legacy-jules-migration.test.ts`
- Modify: `packages/orchestrator/scripts/e2e-real-project-canary.ts`
- Modify: `packages/jules/docs/failure-recovery.md`
- Modify: `packages/orchestrator/README.md`

**Interfaces:**
- Produces: `classifyLegacyJulesMigration(snapshot): no_op | rearm_exact_continuation | manual_intervention`.
- Consumes: exact session, revision, card, run receipt, and effect-journal evidence.

- [ ] [0%] **Step 1: Write a fixture from MAZ-1543's current blocked state**

  Assert the interrupted run that performed no provider effect rearms the existing session/card continuation. Assert ambiguous or uncertain evidence fails closed and requests manual intervention without creating a session or card.

- [ ] [0%] **Step 2: Verify the migration test fails, implement the pure classifier, and pass it**

  Run `pnpm exec vitest run packages/orchestrator/test/legacy-jules-migration.test.ts` before and after implementation.

- [ ] [0%] **Step 3: Build once and restart Paperclip once**

  Record Git SHA and hashes of loaded `packages/jules/dist/index.js` and `packages/orchestrator/dist/index.js`. Confirm startup logs name those exact files. Allow one orchestrator heartbeat to reconcile managed agents.

- [ ] [0%] **Step 4: Freeze code and recover MAZ-1543**

  Do not edit, rebuild, or restart during observation. Apply the idempotent migration once, then verify stable session ID, exact resumed card/revision, no duplicate message, and a newly scheduled monitor.

- [ ] [0%] **Step 5: Run a fresh disposable dependency canary A -> B**

  Approve both tasks upfront. Observe A through plan ladder, implementation, PR, both required reviews, and waiting-for-user merge. After a standard merge commit, verify A is done and B is scheduled exactly once; repeat through B completion.

- [ ] [0%] **Step 6: Apply hard success gates**

  Do not declare completion unless there is no session churn, no duplicate native card, no free-text verdict, no repeated waiting comment, no blocked issue with an executable continuation, no `in_progress` issue without a live lease, and no duplicate merge report.

- [ ] [0%] **Step 7: Document ownership and upstream gaps**

  Explain why the effect journal exists, why orchestrator cannot infer provider outcomes, how legacy migration is bounded, and which Paperclip contracts would eventually remove adapter compatibility code.

- [ ] [0%] **Step 8: Commit**

  Commit message: `fix(lifecycle): recover and verify durable Jules flow`.

## Self-Review Record

- Spec coverage: approval, plan review, provider questions, restart recovery, PR review, merge, and dependency release are all covered.
- Placeholder scan: no deferred implementation steps or unspecified tests remain.
- Type consistency: reducer, snapshot, journal, runner, continuation contract, and migration interfaces are introduced before consumption.
- Risk coverage: uncertain remote effects, legacy identity, stale artifacts, restart boundaries, duplicate heartbeat delivery, and dependency ordering each have an owning test.
- Execution rule: do not live-test intermediate slices. Complete Tasks 1–7 locally, commit a clean revision, then perform Task 8 with one restart and a frozen binary.
