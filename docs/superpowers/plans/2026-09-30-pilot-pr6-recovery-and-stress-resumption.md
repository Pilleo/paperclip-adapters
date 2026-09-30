---
title: Recover remaining pilot PR and resume stress campaign
document_type: execution_plan
base_revision: b69acd1
status: ready_recovered_pilot_replay
date: 2026-09-30
---

# Remaining Pilot Recovery and Stress Resumption Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute inline with evidence checkpoints. No subagents or worktrees.

**Goal:** Finish the remaining original pilot through corrected PR #6, fresh native review and user merge before launching a fresh twenty-task stress run.

**Architecture:** Preserve the existing Paperclip issue, original Jules session and rejected PR. First diagnose and qualify recovery of the host queue that prevents typed feedback delivery. Then let the adapter deliver the exact rejection once, verify the amended shared-file PR against merged pilot-03 work, and resume the campaign only after both pilots are genuinely merged and done.

**Tech Stack:** Paperclip 2026.916.0, original Jules sessions, TypeScript, pnpm/Vitest, real isolated PostgreSQL, GitHub standard merge commits, owner-only mutation journals.

**Spec / authority:** Existing user-approved pilot/replay workflow in `docs/superpowers/plans/2026-09-29-stress-campaign-retirement-and-replay.md`; observed state in `docs/superpowers/evidence/2026-09-29-twenty-pr-stress-campaign.md`. This plan does not authorize unqualified cancellation or provider replay.

## Verified starting point

- PR #7: `MERGED` at `2026-09-30T02:25:18Z`, approved head `0a69c3efcdb9cce173e72273b1083aa131be16f9`.
- Merge commit `6f7eb2511f861462efa456852bd74efd92f46460` has parents `bc665139b608b06f5a01668d0636efddd1a92173` and the approved head; GitHub comparison to `master` is `identical`.
- MAZ-1623 `81b75464-37a4-4b08-bdbb-6257a1f80cc1`: `done`; product `d7b38d24-9293-4fd9-a869-252253bf9b6f`: `merged`; no executionBlocker. The normal heartbeat reconciled it without an operator status PATCH.
- MAZ-1624 `2248bede-a343-42d5-84e7-6ca350cc3c7d`: Jules-owned `in_progress`, PR #6 OPEN at rejected head `7e1fb1412ae5f85892a36f738e93c356b2e7f137`, product `c51310d7-ce2a-4bbe-b1e5-3bdc35ca2d08`: `ready_for_review`.
- Its issue-scoped monitor run `d0734f83-5374-43e3-9751-148af43ddaa8` remains queued and never started. No active native recovery action is exposed. Original Jules session is `10473218640444907799`.

## Global constraints

- User alone approves operator merge gates and merges live GitHub PRs; use standard merges, never squash.
- Never infer review decisions from comments/provider prose; use exact addressed native verdict cards.
- Preserve cancelled/failed-run history and merged pilot-03 work. Do not reopen MAZ-1623 or send it another follow-up.
- No direct live database writes, installed-host patches, forced `done`, blind provider POST retries or cancellation to manufacture a scheduling gap.
- Recheck fresh issue/session/head/run identities before each mutation. Journal intent before POST and inspect an uncertain response instead of replaying it.
- Any new bug stops campaign advancement. Fix through failing tests and installed-host contracts before live reload.

### Task 1: Diagnose why the original PR #6 monitor run cannot start

- [ ] Capture owner-only sanitized snapshots of MAZ-1624, exact queued run/wake, original session checkpoint, typed Luna rejection, agent/runtime policy and issue live-runs.
- [ ] Use authoritative company `/live-runs?minCount=0&limit=50`, not a recent-run window or the ignored heartbeat `status` filter. Reject saturated results as incomplete.
- [ ] Trace installed host `resumeQueuedRuns`, `startNextQueuedRunForAgent`, `claimQueuedRun`, run dispatch and issue execution-lock ownership. Check concurrency, invokability, dependency/hold/budget gates, queue receipt linkage, controller/lease state and scheduler suppression.
- [ ] Establish a specific evidenced admission failure before choosing a mutation. No additional generic wake while the exact queued run already owns the issue lock.

### Task 2: Qualify the smallest supported queue recovery

**Files:** existing `packages/orchestrator/test/contract/native-plan-concurrency.mjs` and `native-child-plan-worker.mjs`; use a separate small contract file only if queue setup cannot fit the existing fixture cleanly.

- [ ] Reproduce the identified queue condition using real host admission and real isolated PostgreSQL, not fabricated successful runs.
- [ ] Prefer resuming the original queued host run through an existing supported route or repairing the exact underlying admission condition.
- [ ] If the only supported recovery requires retiring that never-started run, first prove its board cancellation/release semantics, preserve audit and original provider identity, and obtain explicit authorization for that concrete live mutation. Do not use a terminal reviewer retry or provider-session replacement as a substitute.
- [ ] Assert recovery creates at most one issue-scoped worker continuation, retains Jules session `10473218640444907799`, does not replay provider effects, and does not touch MAZ-1623/PR #7.
- [ ] If adapter source must change, follow TDD, full tests/build and relevant typed-rejection/handoff contracts. Reload only after verified running-work quiescence; record preserved queued work and succeeding post-reload heartbeat.

### Task 3: Deliver the existing typed PR #6 rejection once

**Files:** existing `packages/jules/src/server/pr-child-feedback.ts`, `packages/jules/src/server/execute.ts`, `packages/orchestrator/src/server/execute.ts`; change only if new failing evidence requires it.

- [ ] Re-read original Luna child `46ccf782-1873-41f4-a219-9f843a44878b`, answered card `b190e5b7-f6ce-403b-8bea-126a451d6315`, exact PR/head and succeeded addressed reviewer run.
- [ ] Let the qualified issue-scoped original-session worker consume the verified rejection through the deployed typed feedback path. Do not send a duplicate manual review message.
- [ ] Verify checkpoint intent/delivery and exact provider `userMessaged` echo. If the response is lost, wait for that echo; never repost merely because a GET is initially stale.
- [ ] Confirm original Jules session resumes and amends PR #6 rather than creating a new session or duplicate PR.

### Task 4: Revalidate amended PR #6 against the newly merged shared file

- [ ] Require decimal-format validation rejecting hexadecimal, binary and octal strings, with corresponding tests; `Number(value)` alone is insufficient.
- [x] Verify PR #6's amended branch integrates current `master` with PR #7's `safeInt` export/tests preserved. Per the user's correction, resolve the integration locally on that original branch, not through Jules or by changing already merged task03.
- [ ] Run both `node --test stress-stress-20260929-pilot-b-03.test.js` and `node --test stress-stress-20260929-pilot-b-04.test.js` at the amended immutable head. Verify target-file scope and GitHub mergeability.
- [ ] Register the new product head and require a fresh exact-head Luna→strong native review ladder. Old-head approval/rejection cannot satisfy it.
- [ ] On typed approval, expose the native operator merge gate and wait for the user's decision and GitHub merge. No automated merge.

### Task 5: Verify both pilots before twenty-task replay

- [ ] Verify PR #6 user merge has two parents and includes its approved head, belongs to `master` ancestry, and Paperclip marks MAZ-1624 `done`/product `merged` with no actionable blocker.
- [ ] Re-read MAZ-1623 remains `done`, PR #7 product remains merged, and original no-PR/feedback journals contain no unresolved attempted effect.
- [ ] Run the existing read-only pilot verifier with run key `stress-20260929-pilot-b` and project `db166929-2e4e-454d-aee9-25f5380543c4`. Stop if either pilot has a missing verdict, unmerged product or active implementation/reviewer execution.

### Task 6: Launch the fresh stress run in the same marked project

**Files:** existing `packages/orchestrator/scripts/stress-campaign-create.ts`, `stress-campaign-verify.ts`, manifest and receipt tests.

- [ ] Dry-run fresh key `stress-20260929-20pr-b` with unique run-qualified files. Verify 20 original tasks, declared shared-file pair, both fan-in gates and exact native `blockedBy` graph. Do not reuse old issue IDs.
- [ ] Reuse the existing marked project and clean managed checkout only after old twenty-task originals are terminal and both pilots pass Task 5.
- [ ] Journal create/readback; activate only that new run; wake one project-scoped orchestrator heartbeat. The user decides the 20 native task-start cards.
- [ ] Observe each original provider session, exact plan/PR verdicts, shared-file scheduling, approved head and user merge ancestry. Pause at the first invalid state; retain existing artifacts rather than spawning replacements.

## Completion boundary

Next milestone is a corrected, natively reviewed and user-merged **PR #6**, with both pilot tasks genuinely done. A queued-run cancellation, succeeded adapter run, or provider message echo alone is not that milestone. Twenty-task replay remains gated until both pilots pass.

## Execution checkpoint: exact queue failure qualified

- Read-only PostgreSQL evidence and the installed host's own `readChatControlRecoveryStop` report a 65-run same-issue/same-agent automatic ancestry, `historical` admission and an `unresolved` proof. The host caps proof traversal at 64; claim returns without dispatch or terminalizing the run. This explains why monitor attempts repeatedly update/reschedule while `d0734f83` never starts.
- New real-PostgreSQL contract `packages/orchestrator/test/contract/queued-ancestry-board-recovery.mjs` constructs the chain using actual host-admitted/dispatched process runs. It ages completed fixture timestamps outside the unrelated rewake cooldown and models only the live historical queued issue-lock field; it does not fabricate successful runs.
- A fresh native Board wake remains durably deferred behind that exact queued lock; it does **not** resume the original run. Qualified recovery journals one fresh Board intent, then retires only the never-started queued host run via the native cancel route. Host lock release promotes the already deferred request, preserving issue/owner. Do not post another wake after cancellation.
- Passing contract: `pnpm exec tsx packages/orchestrator/test/contract/queued-ancestry-board-recovery.mjs`; safe receipt proves exactly one cancelled never-started run, a succeeded fresh issue-scoped run, and unchanged issue/owner.
- No live recovery POST, cancellation or provider message has been sent. Task 2's explicit approval gate now concerns only retirement of host run `d0734f83-5374-43e3-9751-148af43ddaa8`; the issue, original Jules session and typed rejection are preserved. After approval, journal fresh request and exact cancellation separately, verify promotion, then let existing adapter typed feedback process the original rejection once.

## Subsequent live execution

- The user explicitly approved the exact host-run retirement. One journaled fresh Board request was deferred, then native cancellation of never-started run `d0734f83` promoted worker `8e3fbb70-cbf5-4bdd-888b-dae1a1ca0f11`, which succeeded. Receipt journal: `/tmp/paperclip-stress-20260929-pilot-b/pr6-queued-host-recovery.jsonl`. Original session `10473218640444907799` received typed rejection `b190e5b7` once; checkpoint and provider echo confirmed it resumed and amended original PR #6 to `1bd21ca7687b3230cef66cbb2b9e9a6ce8318a56`.
- User rejected asking Jules to resolve the resulting master conflict. No proposed integration provider message was sent: the integration script creation was aborted and no delivery journal existed. User then approved local conflict integration to continue the review/merge-flow test.
- Disposable clone `/tmp/paperclip-pr6-integration-TQ6mYE` merged master into the original PR #6 branch. Both function bodies and both test files were preserved verbatim; only the module export object combined `safeInt` and `safeDecimal`. Both suites passed together (11/11). Normal pushed merge commit `b806c158302dd88223a9aa84ace9e2ad03b9cea0` has parents the amended PR head and master `6f7eb2511f861462efa456852bd74efd92f46460`. PR #6 is OPEN/MERGEABLE; no PR merge or force push occurred.
- Next bug: product `c51310d7` updates to this head but keeps legacy producer run `93a6079c-3029-4e85-b501-fdd1e6b48047`, whose succeeded result lacks `julesState`. Later same-session run `34321b66-9f12-4cd7-9a2f-d976685557cb` has `julesState: COMPLETED`, exact new `headSha` and `handoffPending: true`. Orchestrator repeatedly logs its provider monitor remains authoritative and creates no new-head reviewer child. Campaign advancement stops at this legacy-producer handoff boundary, not at the already resolved GitHub conflict. Fix must hydrate/verify later same-session exact-PR/head completion without weakening active-run guards or rewriting old producer evidence.
- Legacy handoff fix `e3e910d` hydrates the latest run of the exact producer agent and validates company/run/issue, original session, exact PR/head, explicit completed/pending-handoff result, timestamps and absence of any newer/live issue run. The historical producer record is not rewritten. Pure/execute regressions and `PAPERCLIP_TEST_LEGACY_PRODUCER=1 ... --scenario=stable_child_chain_abc_later_jules_run --require-safe` passed, including the held later worker and complete native review chain; full workspace test/build/invariant/strict script checks passed. An all-six-company idle reload loaded dist and routed actual PR #6 integrated head to native reviewer children.
- Fresh Luna child `c1b4b31b-8229-4b7b-b743-c7fe397e6ff2`, card `e640b722-ef58-42d4-b10f-de3ad573eea8`, was typed-approved by run `8b86de8e-066d-494f-abb0-bfcc31678fc2` for exact head `b806c158302dd88223a9aa84ace9e2ad03b9cea0`. Strong child `2eb5ebd1-c3ff-4ad4-9cdf-6a69b08aa591` has pending card `a3a77ac2-2b0f-4cf3-95e9-d82c073e3084`; addressed run `b2565ab0-fdc2-4805-ac58-a5e6d6b8d53f` timed out at `2026-09-30T04:20:49Z` with no verdict. Child is blocked with that executionBlocker, no active run and no active recovery card projection. Next step is exact native reviewer-run diagnosis/recovery, not a duplicate wake or synthetic approval; PR #6 remains unmerged and full replay gated.
- Timeout diagnosis found Antigravity's default `timeoutSec: 300`, with the original native card still pending. TDD managed-fleet fix `f923b27` sets an explicit bounded 900-second execution budget. Fleet test, full workspace tests/build and installed-host `stable_child_executor_pr_failed --require-safe` passed. Six-company idle reload and succeeded reconciliation `bece2a8b-9109-4600-807c-548c5ba9c96a` verified the live reviewer config at 900 seconds.
- Journaled native clear-error plus exact settled-action `fd6a3933-8d88-44a7-ade7-bc950e3950dc` restoration of timed-out run `b2565ab0` produced one host-dispatched run `eaa1d749-0578-4915-ab83-b71a8d3eadbf` on the original strong child/card. No manual wake or replacement card was issued. That run completed after about twelve minutes and typed-approved card `a3a77ac2` on exact integrated head; its status is `succeeded`. The child later acquired host continuation `e3a9782a-9f0a-44a7-a059-609944335594`; do not claim one-host-run-per-card or retry that active continuation manually.
- Parent MAZ-1624 is unassigned `in_review`, no executionBlocker, product at the dual-approved `b806c158...` head. GitHub PR #6 remains OPEN/MERGEABLE. Pending native user merge gate `15ca6ab0-ac61-4b96-8c65-20d5821ed297` now exists. Wait for the user's standard GitHub merge, then execute Tasks 5 and 6; no automated merge or premature stress launch.
- User merged PR #6 at `2026-09-30T05:04:29Z`. GitHub verified merge `4d2ebe60d0085f6969b8f0da7f0a98c55eb9e3a3` has parents master `6f7eb2511f861462efa456852bd74efd92f46460` and dual-approved head `b806c158302dd88223a9aa84ace9e2ad03b9cea0`; comparison to master is identical. Normal Paperclip heartbeat marked MAZ-1624 `done` and original product `merged`, no source blocker. MAZ-1623 remains done/merged and both sources have no live runs.
- Strict read-only pilot verifier returned `invalid: shared_03_04_interval_overlap`. This pilot contains user-approved early same-session recovery and local shared-file integration, so it must not be represented as a clean serialized scheduling acceptance run. Retain the verifier result and explicit exception evidence. Before Task 6, decide and qualify a separately observable recovered-pilot disposition or run a fresh strictly serialized pilot; do not silently relax full-campaign interval checking or start twenty new tasks under a failed verifier gate.
- User approved explicit recovered-pilot accounting. `evaluateRecoveredPilot` now checks an owner-only authorization receipt bound to run/project and both original issue/session/PR/head identities, then delegates every dependency/start/session/native-review/merge proof to unchanged `evaluateStressProgress`. It changes only an already completed, unassigned, run-free pilot's historical `shared_03_04_interval_overlap` to `kind: recovered`. Reports retain `strictProgress: invalid` and the receipt reference; full mode rejects the receipt option.
- Live verification with `/tmp/paperclip-stress-20260929-pilot-b/recovered-pilot-authorization.json` passed as **recovered**, not clean scheduling passed; owner-only report `/tmp/paperclip-stress-20260929-pilot-b/recovered-verification/snapshot-0001.json` preserves both outcomes. Full workspace tests/build and strict stress-script typecheck passed. Fresh `stress-20260929-20pr-b` twenty-task manifest dry-run passed, with unique run-qualified files and original DAG. No replay tasks were created during this accounting step.
