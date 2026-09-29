---
title: Retire blocked stress campaign and qualify clean replay
status: in_progress
document_type: execution_plan
base_revision: fb45e9f
---

# Retire Blocked Stress Campaign and Qualify Clean Replay Implementation Plan

> **For agentic workers:** Execute inline on `master`, task by task, using red/green tests and real-host verification. No subagents, worktrees, public GitHub review comments, automatic PR merges, or blind provider retries.

**Goal:** Preserve the failed twenty-card campaign's audit, qualify native cancellation, safely retire its source issues without fabricating completion, then run a two-root live pilot before repeating the complete DAG.

**Architecture:** The existing project `db166929-2e4e-454d-aee9-25f5380543c4` and run `stress-20260929-20pr-a` are immutable audit identities. A separate real-PostgreSQL contract probes installed Paperclip 2026.916.0 status transitions. A journaled retirement tool validates exact original IDs, pending review/merge gates and active runs before one native board mutation per issue; the create/verifier tooling accepts a second run in the *same* marked project only after every old issue is terminal. A two-root pilot using new unique filenames exercises the new handoff guard; only after its actual native verdicts and user GitHub merge will a third run create a fresh twenty-card DAG.

**Tech Stack:** Node 24, pnpm, TypeScript/tsx, Vitest, installed Paperclip 2026.916.0 with real embedded PostgreSQL, Jules provider GET-only client, GitHub CLI GET-only observation.

**Spec:** User-approved staged recovery plan in the conversation; original project/run contract `docs/superpowers/specs/2026-09-29-disposable-twenty-pr-stress-campaign-design.md` and observed evidence `docs/superpowers/evidence/2026-09-29-twenty-pr-stress-campaign.md`.

## Global Constraints

- Only the user merges live GitHub PRs. Leave PR #4 and #5 OPEN until the user explicitly decides whether to close them; no agent `gh pr merge`, close, or review.
- Never interpret `/recovery-actions` `{ active: null, actions: [] }` as absence of a settled automatic no-replay action. Do not attempt `restored/todo` on MAZ-1596 while it is `in_review`/unassigned. Do not relabel the reviewed PR #4 as unreviewed or erase PR #5's typed rejection.
- At every mutation, re-read all-company active runs, exact issue owner/status/blocker, relevant native interactions and approvals. One owner-only intent per call before POST/PATCH; on uncertain response, GET exact identity and stop if effect is unresolved.
- No new campaign card, worker wake, or project until the old twenty original issues are terminal and the current project checkout is clean. Do not create a replacement task with the old run marker or silently rewire descendant `blockedByIssueIds`.
- A standard task `cancelled` is failure history, not an implementation success. Preserve old PR work products, typed verdicts and recovery evidence.
- Existing full unit/type/build and pinned-host positive chain plus exact-run auto-blocker recovery contracts must remain green. A fresh positive host cancellation/race contract is required before live pilot. Do not mock database calls in integration tests.

## File Responsibilities

- `packages/orchestrator/test/contract/terminal-auto-blocker.mjs`: opt-in installed-host real-PostgreSQL source-retirement characterization. Existing terminal-blocker modes remain unchanged.
- `packages/orchestrator/test/contract/native-plan-concurrency.mjs`: one opt-in later-Jules-run/PR-handoff scenario, using the existing isolated-host harness and requiring no replacement/replay after stale run observation.
- `packages/orchestrator/src/core/stress-campaign-receipts.ts` and `test/stress-campaign-receipts.test.ts`: exact marked-project selection for subsequent run keys; refuse active old runs.
- `packages/orchestrator/src/core/stress-campaign-manifest.ts` and `test/stress-campaign-manifest.test.ts`: two-root pilot manifest and stricter `safeInt` acceptance boundary (`Number.isSafeInteger` and max-safe boundary tests), preserving original twenty-task manifests.
- `packages/orchestrator/scripts/stress-campaign-create.ts` and `test/stress-campaign-create-cli.test.ts`: explicit `PAPERCLIP_STRESS_PROJECT_ID` reuse only after verified previous-run terminality; journal the new run's own intents, then activate/wake only that run.
- `packages/orchestrator/scripts/stress-campaign-retire.ts` and `test/stress-campaign-retire-cli.test.ts`: scoped dry-run, exact preflight and intent/readback native terminalization; no implicit PR or review decision.
- `packages/orchestrator/scripts/stress-campaign-verify.ts`: observe pilot by its exact two issue IDs in pilot mode; continue twenty-card strict mode for replay.
- `docs/superpowers/evidence/2026-09-29-twenty-pr-stress-campaign.md`: append sanitized old-run retirement IDs/receipts and separate pilot verdict evidence.

## Task 1 — qualify installed-host cancellation and race semantics

- [ ] Write a failing opt-in real-host test against `terminal-auto-blocker.mjs --retire-blocked-source --require-safe` for a stopped failure with a resolved automatic no-replay action: changing the *same* source to `cancelled` must preserve its historical run/action/work product and leave no runnable issue; a second attempted cancel must have no new effect. Cover both `blocked`+Jules-owned and `in_review`+unassigned projections; if host rejects either, treat that shape as **not qualified** and stop before live cancellation. Do not claim clearing its blocker.
- [ ] Run the opt-in scenario and record the expected pre-implementation failure (unsupported flag/terminal result), then implement the narrow real PostgreSQL fixture and `--require-safe` assertion. Do not patch the host or replace DB calls with mocks. Rerun and keep the report.
- [ ] Add an isolated later-Jules-run handoff case to the pinned-host harness with a real `running` run entering after PR observation, then assert no `issue_reassigned` cancellation and no native reviewer child before the run settles. Run with `--require-safe`. If this fails because the host offers no conditional PATCH, stop and address host authority before any live replay rather than weakening the test.
- [ ] Commit separately from live mutations after the focused contracts, `pnpm test`, `pnpm build`, `pnpm typecheck:invariants` and `git diff --check` pass.

## Task 2 — replay-safe project selection and two-root manifest

- [ ] Red tests in `test/stress-campaign-receipts.test.ts`: the second run cannot reuse the marked project while any prior run-marked original issue is nonterminal; after exactly twenty previous terminal readbacks, the *explicit* project ID/SSH repo/ref can be reused without a new project. Ambiguous project, mismatched checkout or uncertain prior POST must fail closed.
- [ ] Implement `selectStressProject` reuse with `PAPERCLIP_STRESS_PROJECT_ID` and a complete prior-run terminality check in `stress-campaign-create.ts`. Preserve run-specific title/description and journal identity for every new issue; never alter existing old issue IDs or products. Run focused tests red then green; commit.
- [ ] Red tests for exactly two pilot roots `safeInt` and `safeDecimal`, each with a unique new run key and shared run-qualified `numbers.js`. Extend descriptions to require finite safe integers and boundary tests on MAX_SAFE_INTEGER/above; `safeDecimal` retains finite-decimal requirements. Implement `stressPilotTasks` without changing the old run's 20 identities; run focused tests red then green; commit.
- [ ] Provide pilot-specific verifier cardinality without weakening twenty-task completion or native DAG/merge checks. Prove both modes fail closed on a missing product, a mismatched head, a duplicate session and a premature shared-file start.

## Task 3 — journaled retirement operator and old-cohort preflight

- [ ] Red HTTP-fixture tests: `--dry-run` sends only GETs and lists the exact twenty original issue IDs; a changed status, active source/reviewer run, duplicate pending native review card or unknown recovery action stops before any write; a lost cancellation response is reconciled by GET and **never** blindly resent. No DB mocks.
- [ ] Implement an owner-only journaled `--retire` scoped to project ID `db166929-2e4e-454d-aee9-25f5380543c4` and run key `stress-20260929-20pr-a`. Resolve MAZ-1596's pending *operator merge gate* through its typed board route only after qualifying the addressed card/run state; answered Luna/strong verdicts remain immutable. For each issue, preflight exact ID/status/owner/blocker and use only host-qualified native cancellation, followed by GET readback. Stop on the first unsupported issue and report partial progress; no global cancellation loop after a 409/422.
- [ ] Verify old twenty status `cancelled`, no active descendant/reviewer runs and no pending merge gate, while historical work products and executionBlockers remain attributable. Leave GitHub PR #4/#5 unmerged/open for the user's decision. Commit sanitized evidence without owner-only journal contents.

## Task 4 — human-gated pilot then full replay

- [ ] At all-company fleet idle, reload the built external adapter if Task 1–2 changed it; confirm startup `dist/index.js` and one successful managed-fleet orchestrator heartbeat before live cards.
- [ ] Journal a new run key `stress-20260929-pilot-b` inside the **same** marked project. Create exactly two `backlog` pilot roots, read back scopes and empty blockers, then activate and issue one project-scoped wake. The user decides both native task starts, all operator merge gates and both standard GitHub PR merges. Observe direct Jules GETs, immutable native plan/PR verdicts, two-parent merge ancestry and no executionBlocker. Timeout or a missing approval is awaiting-human/progress, not green.
- [ ] Only if both pilot tasks reach `done` with verified merged products, choose fresh run key `stress-20260929-20pr-b`; create the original twenty-task DAG with unique new files through the same journaled CLI, after asserting no active pilot tasks. The user again approves task starts and merges reviewed PRs. Monitor read-only and stop at first invalid state.
