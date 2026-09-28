---
title: Jules-owned plan review and PR delivery recovery
status: in_progress
document_type: execution_plan
base_revision: ae92c676deea865c156ae9842e7bf0e22307dc5b
---

# Jules-Owned Review and PR Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Complete the gates in order; preserve the existing dirty workspace and native Paperclip evidence. Do not delegate work or create another task/provider session.

**Goal:** Jules autonomously completes configured native plan reviews, sends one approval, and registers its PR despite restart, lost response, or a provider session that briefly reports outputless `COMPLETED`. Recover existing B/PR #2 through that same path, then release existing C only after a verified B merge.

**Architecture:** Jules owns its provider effect journal, child-review bootstrap, and work-product delivery. Paperclip's native cards and run identities remain the only reviewer authority; the orchestrator owns dependency scheduling and later PR-review/merge coordination, never Jules's plan gate. Evidence is reconciled idempotently at each boundary, not inferred from adapter exit codes or the provider's aggregate state.

**Tech Stack:** pnpm, TypeScript, Vitest, Jules REST, Paperclip `2026.916.0`, authenticated real PostgreSQL contracts, Gemini ACP, GitHub CLI.

**Spec:** The approved Jules-independence design in this conversation; live identities/evidence in `docs/superpowers/evidence/2026-09-27-jules-plan-approval.md` and `docs/superpowers/plans/2026-09-27-verified-disposable-flow-recovery.md`.

## Global Constraints and Current Baseline

- Preserve pre-existing uncommitted changes. Build/reload only at an observed fleet-idle boundary; verify Jules `dist/index.js` loaded and a reconciliation heartbeat finished before a live mutation.
- No new A/B/C issue, no new Jules session, no retry of a terminal reviewer run, no free-text verdict or GitHub PR-thread review, no manual issue-status PATCH, no squash merge. Use only `gh pr merge --merge` after native PR verdict/CI gates.
- **B:** MAZ-1579 `92b5933b-8160-417a-81e3-d23db394727c` is `blocked` and Jules-owned. Its adapter checkpoint is `WAITING_FOR_PLAN_APPROVAL` for Jules session `7847310987553774842`, plan activity `4854253c425b4a00a9d66db6d01cdbfc`, document `5104b4b4-e0aa-4bff-a738-b83d8bde75f6`, revision `ca0f101f-a0ff-42d2-9d71-254efe29dd2d`, and no approval effect entry.
- Luna card `8921eedb-c705-4827-b8fc-ae047982ee98` and Gemini card `babee7d2-3edb-40a6-9384-c247f670fc0c` were answered with typed `approve` on that exact revision by succeeded distinct reviewer runs. One owner-only receipt `/tmp/paperclip-jules-b-terminal-plan-approval-20260927.json` records the **single** accepted `approvePlan` POST; Jules session `7847310987553774842` produced https://github.com/Pilleo/paperclip-adapters-e2e-20260923-vanilla-review/pull/2 at head `d12a9e2482f1e202f6fb21d0480723336b40d6aa`. GitHub PR #2 is `OPEN`, non-draft; B has no Paperclip work product.
- **C:** Existing MAZ-1580 `37de61c8-8704-409a-aa5c-51b13c42220e` remains `todo`, blocked only by B. Old MAZ-1578 and its evidence stay untouched. No current unit/contract test proves the whole B→PR→merge→C path.
- **New recovery incident:** An evidence-backed B recovery triggered Paperclip's `forceFreshSession:true` on the native process wake. Jules mistakenly created cloud session `12793271967265448900` and advanced B's plan document to revision `f7396e9e-e095-4d28-80ff-d7b3f2301841`, although the earlier approved session/PR #2 remain valid historical evidence. Managed Jules is paused; no further live provider/create/approval attempts until the two recorded revisions are reconciled safely. See the evidence document above.

---

### Task 1: Finish one-effect approval behavior (already red-green at reducer boundary)

**Files:** `packages/jules/src/server/plan-provider-decision.ts`, `execute.ts`; `packages/jules/test/plan-provider-decision.test.ts`, `e2e-plan-presentation.test.ts`, `lifecycle-effect-journal.test.ts`.

- [x] Red-test unchanged outputless `COMPLETED` with exact typed approve and no effect → `approve_once` with `approve:<sessionId>:<documentRevisionId>`; started effect → reconcile, never resend. The reducer and v3 strong-child path were corrected, and 89 Jules test files plus affected build passed. These source edits are **not** loaded into the live service yet.
- [ ] Test lost `approvePlan` response: persist started effect before POST; when complete Jules activity history later shows the same plan approved and a PR output, confirm from that exact session/revision without another POST. An unrelated plan, incomplete history, nonempty output *before* approval, or a typed reject must fail closed. Exercise a real serialized session checkpoint across a restart.
- [ ] Add implementation only for the failure proven by the test. Run `./scripts/adkw doctor` and `./scripts/adkw blast-radius decidePlanProviderAction`/`execute` before touching those core symbols; run focused Jules tests then `pnpm --filter @pilleo/paperclip-jules-adapter test` and `pnpm --filter @pilleo/paperclip-jules-adapter build`.

**Gate:** A lost response never produces a second provider approval; an accepted one is tied to a confirmed exact effect, not an inferred `IN_PROGRESS`/`COMPLETED` label.

### Task 2: Deliver provider PR from Jules after a restart

**Files:** `packages/jules/src/server/execute.ts`, `terminal-handler.ts` (only if needed), `session-lifecycle.ts`, `paperclip-client.ts`; tests in `packages/jules/test/execute-reopen.test.ts`, `e2e-jules-orchestration-regression.test.ts`, `paperclip-client.test.ts`.

- [ ] Red-test an exact confirmed approval effect + terminal Jules session with `pullRequest` output, no registered product and an existing parent checkpoint: call `registerPullRequestWorkProduct` once with canonical URL/head/session provenance and retain the Jules owner. Re-enter with the same checkpoint and assert no second product or provider mutation. If GitHub already reports `MERGED`, preserve the true merged state rather than manufacturing an open review.
- [ ] Put provider PR observation and product upsert behind the same durable Jules lifecycle checkpoint; preserve unknown/ambiguous outcomes as visible holds. Do not silently swallow failed product writes. Use the typed Paperclip transition to request in-review when an open PR is actually ready; a merged PR must not start a retroactive PR reviewer card.
- [x] Verify the confirmed-approval, stale-runtime restart, single PR-product registration and immutable-head retention cases in an isolated authenticated unpatched Paperclip host using real PostgreSQL. The actual Jules executor ran twice, with no provider mutation; Jules suite (91 files) and workspace build passed. Additional unknown/lost-effect outcomes remain separate gates.
- [x] Red-test that Paperclip's `execution.reconciled` wake with `forceFreshSession:true` must resume a **matching durable Jules cloud session**, not issue a second provider create; conflicts fail closed. Pure startup and real versioned-store executor tests passed, as did the full 91-file Jules suite/build. Do not reload or resume B until its new revision-2 checkpoint and native hold are dispositioned.

**Gate:** With orchestrator heartbeat disabled, Jules alone can link the provider PR after a restart. The issue cannot become `done` from session completion without the matching work product and authorized review/merge outcome.

### Task 3: Recover **existing B/PR #2** only through evidence-backed native state

**Files:** Focused owner-only recovery script using `packages/jules/src/server/session-store.ts`, `lifecycle-effect-journal.ts` and the validated Task 1/2 reconciliation functions; append a sanitized receipt to `docs/superpowers/evidence/2026-09-27-jules-plan-approval.md`.

- [ ] Preflight B's current issue/revision, both answered native plan cards and succeeded reviewer runs, the exact one-POST receipt, complete Jules `planApproved` activity, and PR #2's immutable URL/head. Check no active Jules/reviewer run or prior canonical approval effect. If any identity differs, stop; do not change B or send another `approvePlan`.
- [x] Adopt the prior external receipt into Jules's **versioned session store through tested APIs**, once, as a confirmed same-session effect; do not write raw checkpoint JSON or store secrets/config in Paperclip metadata. Idempotence and persistence were tested; the one owner-only live receipt is recorded in the evidence document.
- [x] The accidental session and new plan revision were preserved as evidence; its one pending revision-2 card was withdrawn through Paperclip's typed route with the operator's authorization and no active reviewer run. PR #2 from the originally approved revision was registered once as an open work product with truthful `operator_reconciliation` provenance. Paperclip then recovered B from `blocked` to `in_review` and created the native Luna PR-review card on the immutable head. The checkpoint is **not** repaired; managed Jules remains paused.
- [x] Attribute the first `wakeup_skipped`: native wake receipts recorded `issue_dependencies_blocked` by the accidental review child. A journaled dependency-only update restored B's sole blocker to completed MAZ-1582, without touching status. After an idle reload the **existing** parent PR card's native wake was queued, but Paperclip cancelled Luna run `076cc434-d8a9-4090-bcfe-ba25a54721d3` before start with `issue_assignee_changed`: B remains `in_review` and unassigned. The parent-owned card therefore cannot dispatch under this host admission contract; do not send more wakes.
- [ ] **Qualify a versioned issue-scoped PR reviewer protocol before changing routing.** The pending parent card must first be withdrawn through a typed Paperclip endpoint with no active reviewer run, preserving its audit history. In an isolated authenticated real-PostgreSQL host prove that a PR-review child can own the addressed card and reviewer run while its parent retains immutable PR URL/head and in-review ownership. Test one reviewer run per card, Luna→Gemini verdicts, failed/paused reviewer holds, restart, no duplicate wakes and no PR-thread comments. Only then use this lane on B; if Paperclip cannot authorize it, stop without merging PR #2.
- [x] Host admission slice: authenticated child-scoped PR card, Luna assignment and exactly one typed approve succeeded while parent retained Jules ownership and immutable registered PR head. The host may start a second read-only reviewer continuation after the first verdict; a one-run-per-card guarantee remains unproven. Remaining: versioned production protocol, strong review, reject/hold/restart, typed retirement of B's parent card; no live B migration has occurred.
- [ ] Observe native PR review on head `d12a9e2482f1e202f6fb21d0480723336b40d6aa`, CI policy, and addressed typed PR verdicts. Only after these gates and an authorized board merge approval, merge via `gh pr merge --merge`. Require Paperclip's work product and B status to agree with the GitHub merge before treating B as done.

**Gate:** No new issue/session; one product per URL, no repeat provider approval, no unreviewed adapter merge, no clearing a settled hold without exact verified work evidence.

### Task 4: Remove orchestrator ownership from *future* Jules child-review bootstrap

**Files:** `packages/common/src/child-plan-review-bootstrap.ts`, `packages/jules/src/server/paperclip-client.ts`, `execute.ts`; `packages/orchestrator/src/core/child-plan-bootstrap.ts` only for compatibility; `packages/orchestrator/test/contract/native-child-plan-contract.mjs`, `native-child-plan-worker.mjs`.

- [ ] Add a failing authenticated real-PostgreSQL contract with orchestrator dispatch disabled. Jules creates a revision-scoped child that Paperclip authorizes Jules to bootstrap on the **child's own native run**; the bootstrap writes one addressed reviewer card and transfers only child ownership. Test Luna approve, Gemini approve, same-session revision, restart, reviewer-unavailable and failed-run cases without manual card or wake duplication.
- [ ] The existing v3 `ChildPlanReviewIdentity` enforces **three distinct** Jules/bootstrap/reviewer principals. Qualify a versioned Jules-owned bootstrap protocol in the real-host contract; do not set `bootstrapAgentId === julesAgentId` on v3 or weaken historical v3 identity checks.
- [ ] Move the issue-scoped bootstrap entrypoint to the Jules adapter using the existing common typed-card protocol and run-scoped credentials. Preserve old v3 child checkpoint decoding and the current orchestrator bootstrap only for already-issued children; do not reassign existing MAZ-1585/1586 or rewrite their answered verdicts.
- [ ] Prove the full Jules plan ladder and PR registration with orchestrator disabled, then build common/Jules, run affected suites/contracts, and reload idle before testing a fresh future run.

**Gate:** Jules can create, observe and consume native child verdicts with no orchestrator run. This changes future issue creation only; B's already-answered cards keep their recorded identities.

### Task 5: Existing C and final proof

- [ ] Re-read C's `blockedBy` relation and B's authoritative `done`/merged work product; allow its existing native task-start approval to be decided by the operator if Paperclip requests one. Do not pre-approve it in prose.
- [ ] Run C through the **Jules-owned** child review/PR lane from Task 4, then native PR verdict/merge with a merge commit. Preserve old MAZ-1578 as historical held evidence.
- [ ] Run `pnpm build`, affected suites and authenticated real-host contracts, `git diff --check`, `./scripts/adkw check-backlog`; separately report the ten pre-existing backlog-frontmatter errors. Publish an acceptance table with run, card, revision, provider session, PR head, merge commit and dependency transitions for B and C. Mark any missing boundary unverified, not green.
