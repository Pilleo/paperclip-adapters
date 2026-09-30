---
title: Fix Jules PR handoff starvation
document_type: execution_plan
base_revision: 09f6232
status: completed
date: 2026-09-30
---

# Jules PR Handoff Starvation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop host continuation churn after a completed Jules PR so the normal orchestrator can safely route native review.

**Architecture:** The Jules adapter must establish a verified native durable wait between PR registration and ownership release. The orchestrator must consume exact terminal-producer evidence while retaining the live-run fence, then clear that wait with the existing native-review cleanup transition. Test the actual recovery sweep and actual adapters together against the installed host.

**Tech Stack:** TypeScript, pnpm, Vitest, Paperclip 2026.916.0, embedded real PostgreSQL, existing native monitor and PR-child protocols.

**Spec:** `docs/superpowers/specs/2026-09-30-jules-pr-handoff-starvation-design.md`

## Global Constraints

- Work inline on `master`; no worktrees or subagents.
- Preserve original issue, Jules session, immutable PR head and historical verdicts.
- Do not cancel live/queued runs to make tests pass; never force owner release over an active run.
- User alone merges live PRs; all review decisions use addressed native verdict cards.
- Do not modify installed Paperclip files in place or mock databases in integration tests.
- Run ADK outline, doctor and blast-radius before source changes; use TDD.
- Stage only task-owned changes. Preserve unrelated AGENTS.md, MCP and jbcontext work.

## Files and responsibilities

- `packages/jules/src/server/execute.ts`: terminal PR result, product-registration order, native wait establishment, same-session delayed handoff poll.
- `packages/jules/src/server/paperclip-client.ts`: verified native monitor scheduling/readback; reuse existing helpers.
- `packages/jules/src/server/session.ts`: only add an exact-head handoff checkpoint if runtime discrimination cannot use existing terminal session state.
- `packages/jules/test/execute.test.ts`, `test/execute-heartbeat-yield.test.ts`, `test/paperclip-client.test.ts`: result honesty, monitor lifecycle and failure paths.
- `packages/orchestrator/src/core/jules-monitor-state.ts` and `test/jules-monitor-state.test.ts`: exact terminal producer versus authoritative provider monitor classification.
- `packages/orchestrator/src/server/execute.ts` and `test/execute-native-pr-approval.test.ts`: fresh run fence and safe transition.
- `packages/orchestrator/test/contract/native-plan-concurrency.mjs`, `native-child-plan-worker.mjs`: real host recovery race and normal reviewer routing.
- `docs/superpowers/evidence/2026-09-29-twenty-pr-stress-campaign.md`: isolated and live evidence.

### Task 1: Reproduce the actual continuation starvation in the installed-host harness

- [ ] Outline the two existing fixture files and inspect `stable_child_chain_abc_later_jules_run` and `stable_child_executor_pr_board_reject`. Use the existing loopback provider and real host routes.
- [ ] Add opt-in scenario `stable_child_terminal_pr_handoff_wait` using actual Jules execute and actual orchestrator. After exact PR registration, finish the Jules run, invoke `heartbeat.reconcileStrandedAssignedIssues()` before the orchestrator, and record every issue-scoped wake/run/product/monitor.
- [ ] Assert no new generic continuation is admitted between registration and the next orchestrator tick:

```js
const before = await runRows();
await heartbeat.reconcileStrandedAssignedIssues();
await heartbeat.drainActiveRunExecutions();
const after = await runRows();
assert.equal(after.filter(run => !before.some(old => old.id === run.id) &&
  run.contextSnapshot?.issueId === config.issueId &&
  run.contextSnapshot?.wakeReason === 'issue_continuation_needed').length, 0);
```

- [ ] Assert one native durable wait is present after the terminal Jules run; then wake the actual orchestrator, finish its transition, and verify unassigned `in_review` parent, cleared wait, exactly one head-bound native PR child/card. Check source and reviewer run provenance through the existing helpers.
- [ ] Run `pnpm test:contract:plan-handback --scenario=stable_child_terminal_pr_handoff_wait --require-safe`. Record RED at the missing durable wait/continuation enqueue boundary. Do not seed a monitor to hide the defect.

### Task 2: Establish a durable, honest terminal-PR wait in Jules

- [ ] Add failing execute tests: terminal green-PR registration persists a verified monitor before returning; result has `julesState: COMPLETED` and `handoffPending: true`; summary says awaiting native handoff; result does not assert `issueStatus: in_review` when the actual host is `in_progress`.
- [ ] Cover transient/authorization monitor PATCH failure: retain original session and product, return visible failed/pending outcome according to existing failure conventions; do not clear the only wait and return success.
- [ ] Cover a second due poll with unchanged PR/head: renew wait without provider create/sendMessage/approvePlan and without new product or status comment. Cover changed head, rejection and red CI returning to their existing paths.
- [ ] Replace terminal `clearJulesSessionMonitor` with verified monitor scheduling after registration succeeds. Use `scheduleJulesSessionMonitor` with the configured poll cadence and session deadline; ensure the requested nextCheckAt is in the future. Distinguish handoff notes from active provider notes. Read back the exact head-bound registered product before declaring the wait authoritative.
- [ ] Extend terminal result with exact producer evidence:

```ts
resultJson: {
  provider: 'jules',
  julesSessionId: session.julesSessionId,
  julesState: 'COMPLETED',
  prUrl: session.currentPrUrl,
  headSha: session.currentPrHeadSha,
  handoffPending: true,
  issueStatus: 'in_progress',
}
```

Use an observed host status if it differs; do not blindly label an already handed-off issue in_progress. Keep `clearSession: false`.
- [ ] Run `pnpm --filter @pilleo/paperclip-jules-adapter exec vitest run test/execute.test.ts test/execute-heartbeat-yield.test.ts test/paperclip-client.test.ts`. Verify RED before implementation and GREEN after.

### Task 3: Consume terminal handoff evidence without weakening live-run fences

- [ ] Add failing pure cases in `jules-monitor-state.test.ts`: future handoff monitor plus hydrated succeeded original producer with completed original session → `terminal_pr_handoff`; live later run → `active_or_unverified_monitor`; absent/mismatched session/head or producer → held.
- [ ] Add execute regressions in `execute-native-pr-approval.test.ts`: terminal producer with future wait is handed to review only after fresh run check, and cleanup removes monitor. Re-read any differing executionRunId: queued/running referenced run holds; exact scoped succeeded historical run alone must not lock ownership forever; missing or wrong-scope run fails closed.
- [ ] Keep the current four-field `nativePrReviewCleanupPatch()` and readback check. Do not replace them with a bare status PATCH. Keep rejection disposition before handoff eligibility.
- [ ] Populate enough immutable terminal result evidence in the Jules producer for existing `isCompletedJulesProducer` to prove completion; extend parsing only where the new declared field is needed.
- [ ] Run `pnpm --filter @pilleo/paperclip-orchestrator-adapter exec vitest run test/jules-monitor-state.test.ts test/execute-native-pr-approval.test.ts test/board-reconciliation.test.ts`.

### Task 4: Prove delayed handoff, live-run safety and bounded retry with real host sweeps

- [ ] Extend the new scenario to delay orchestrator routing while running multiple normal recovery sweeps. Verify no generic continuation and no new product/comment/provider POST. Advance the existing native monitor once and verify one same-session GET poll renews the wait.
- [ ] Hold a later actual Jules run during its provider GET. Run orchestrator reconciliation and verify the issue owner and active run remain intact. Release it, reconcile again and prove review dispatch occurs.
- [ ] Verify typed rejection still returns to the original session and that native plan/no-PR waits are unaffected. Run:

```bash
pnpm test:contract:plan-handback --scenario=stable_child_terminal_pr_handoff_wait --require-safe
pnpm test:contract:plan-handback --scenario=stable_child_chain_abc_later_jules_run --require-safe
pnpm test:contract:plan-handback --scenario=stable_child_executor_pr_board_reject --require-safe
pnpm exec tsx packages/jules/test/contract/no-pr-confirmation-recovery.mjs --require-safe
```

- [ ] Run `pnpm test`, `pnpm build`, `pnpm typecheck:invariants`, `pnpm --filter @pilleo/paperclip-orchestrator-adapter exec tsc -p tsconfig.stress.json`, `pnpm check:secrets`, `git diff --check`, and `./scripts/adkw check-backlog`. Record existing unrelated backlog errors separately.
- [ ] Review diff inline, stage only owned source/tests/evidence and commit the fix.

### Task 5: Reload and verify the existing live PR #7 through native review

- [ ] Capture owner-only sanitized readbacks for MAZ-1623, original session, PR #7/head/product, latest runs and native cards; PR #6 and its queued run must retain their identities.
- [ ] Check all six company live-run endpoints; never use a bounded latest-run list as an idle proof. Wait for running work to settle. If the continuation loop never offers a safe reload boundary, stop and report it; do not cancel a run or force release merely to proceed.
- [ ] Reload the tested adapters at the verified boundary. Confirm startup logs loaded both `dist/index.js` and one succeeding orchestrator heartbeat. Record any unchanged queued run explicitly.
- [ ] Observe one current original-session terminal run establishing the durable handoff wait. Then verify the orchestrator clears it after the worker is terminal and creates one PR #7 exact-head native Luna card on an addressed reviewer child.
- [ ] Observe the native reviewer run and typed verdict; do not substitute comments or provider prose. A reviewer reject is valid. Do not retry terminal reviewer failures without inspecting the result and qualified native recovery authority.
- [ ] Verify no new Jules session or duplicate feedback POST, no reopened no-PR card, no failed-run blocker, and no issue_reassigned cancellation. Confirm PR #6 remains untouched and neither PR merged. Update evidence and save durable lessons.

## Completion boundary

The fix is complete when the isolated sweep/monitor/live-run contracts pass and live PR #7 reaches its addressed native review card automatically. Approval and merging are subsequent user-controlled stages; a registered product or succeeded Jules run alone is not a completed native handoff.

## Execution notes

- Reused the existing `stable_child_executor_pr_board_reject` scenario with `PAPERCLIP_TEST_TERMINAL_HANDOFF_WAIT=1` rather than adding another nearly identical scenario. It failed first at the absent terminal monitor. The passing probe executes three normal host recovery sweeps, advances one actual due Jules monitor, asserts a renewed bounded wait and one product with zero provider POSTs, then exercises typed native rejection delivery.
- The fixture process wrapper did not persist actual `AdapterExecutionResult.resultJson` into the host run; it stored only process output. The harness now copies the **actual returned executor result** into its succeeded fixture run before producer hydration. No fabricated completion decision or live host record is used.
- Existing orchestrator terminal-producer logic already consumes the corrected `julesState: COMPLETED` result. No production orchestrator source change was needed. The actual-orchestrator `stable_child_chain_abc_later_jules_run --require-safe` passed through the later-live-run hold, release and A→B→C review chain.
- Full workspace tests, build, invariant and strict stress-script typechecks, and the no-PR confirmation recovery host contract passed after implementation. Live reload and PR #7 native-review readback remain the final gate.
- Fix committed as `1e9a9df`. Reload confirmed Jules/orchestrator `dist/index.js`; post-reload heartbeat `31747bf9-ae62-4350-bad7-b0ea1666a741` succeeded. PR #7 is unassigned `in_review`, with exact-head answered Luna and strong approvals and pending user merge gate `2fc471e1-2e17-4f73-9990-38b612f17ac1`. Those native approvals occurred **before** this reload: the old race eventually found a routing gap. They are live review evidence, not proof the new code caused that handoff. The deterministic no-churn/delayed-wait/race contracts qualify the deployed fix. No live PR was merged or provider feedback repeated.
