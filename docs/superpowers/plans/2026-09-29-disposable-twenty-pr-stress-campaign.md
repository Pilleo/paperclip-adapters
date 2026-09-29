---
title: Disposable twenty-PR stress campaign
status: in_progress
document_type: execution_plan
base_revision: a22564a
---

# Disposable Twenty-PR Stress Campaign Implementation Plan

> **For agentic workers:** Implement inline on `master`, task by task, with a red/green/review/commit checkpoint. Do not create a worktree, use subagents, approve board cards, or merge a live GitHub PR.

**Goal:** Create one isolated live Mazewall campaign with 20 recoverably-provisioned, native-DAG-gated PR tasks; give the user safe task-start approvals and a read-only completion report.

**Architecture:** A pure manifest owns the graph and task contracts. An operator-only CLI validates and journals each Paperclip project/workspace/issue POST, creates issues in `backlog`, reads them back, activates them only after all 20 are verified, and wakes only the campaign project. A second read-only verifier checks issue/dependency/review/merge evidence and reports waiting/invalid/passed without sending provider or GitHub mutations.

**Tech Stack:** TypeScript/tsx, Node 24, pnpm/Vitest, installed Paperclip `2026.916.0`, native Paperclip HTTP API, `gh` read-only CLI and the existing Jules GET-only client.

**Spec:** `docs/superpowers/specs/2026-09-29-disposable-twenty-pr-stress-campaign-design.md`

## Global Constraints

- Existing v2 project `d53718c7-90c3-462b-b8bb-4ff7d54fa37e` and its 11 nonterminal marked issues are untouched. New project uses only `<!-- paperclip-adapters:stress-project:v1 -->`, same existing SSH GitHub repo, default `master`, and a distinct managed checkout.
- 20 tasks exactly, six roots, canonical first-block orchestrator metadata, native `blockedByIssueIds`, run-qualified unique files except shared 03/04 `numbers.js`, `ciPolicy: skip`. All tasks start as `backlog`; only activate to `todo` after complete readback.
- Every POST/PATCH/wake has a durable owner-only intent before the call and post-call readback; if its outcome is unknown, discover exact identity and fail closed. Do not blindly repeat uncertain mutations.
- Only user approves native task-start/merge gates and performs 20 standard GitHub merges. Use addressed native typed plan and PR verdicts; do not post GitHub review comments.
- No adapter refactors during the live campaign. Load built adapters only at six-company fleet idle, confirm `dist/index.js` and one configuration-reconciliation heartbeat before launch.
- Offline tests may use HTTP fixtures but may not mock state-machine database calls. Positive pinned-host A→B→C and exact-run recovery contracts are preflight gates.

## File Responsibilities

- `packages/orchestrator/src/core/stress-campaign-manifest.ts`: frozen 20-task DAG, run-qualified filenames, canonical descriptions and pure validation; no network calls.
- `packages/orchestrator/test/stress-campaign-manifest.test.ts`: DAG, declared file conflict, canonical issue request, malformed/duplicate graph tests.
- `packages/orchestrator/src/core/stress-campaign-receipts.ts`: pure recorded-intent/readback equality checks, project/issue identity, and native blocker comparisons.
- `packages/orchestrator/test/stress-campaign-receipts.test.ts`: unknown response, duplicate title, wrong project/blocker, no unsafe repost decisions.
- `packages/orchestrator/scripts/stress-campaign-create.ts`: opt-in dry-run, provision, create, activate, wake operations. One explicit `--run-key` and journal directory; no implicit task approvals.
- `packages/orchestrator/src/core/stress-campaign-progress.ts`: pure typed state evaluation from read-only snapshots; rejects early starts, overlapping 03/04, wrong PR/review/merge evidence, active blockers.
- `packages/orchestrator/test/stress-campaign-progress.test.ts`: awaiting-user/provider, invalid state, full 20-task pass, orphan/stale review/merge tests.
- `packages/orchestrator/scripts/stress-campaign-verify.ts`: GET-only Paperclip/GitHub adapter and bounded status snapshots, no write methods or approval calls.
- `docs/superpowers/evidence/2026-09-29-twenty-pr-stress-campaign.md`: sanitized live identities, timeline, pending user approvals/merges, pass or exact first failure.

## Task 1 — deterministic manifest and fail-closed graph validation

**Interfaces:** `stressTasks(runKey: string): readonly StressTask[]`, `validateStressTasks(tasks: readonly StressTask[]): {ok:true}|{ok:false;reason:string}`, `buildStressIssue(task, projectId, predecessorIds): Record<string,unknown>`; `StressTask` has `key`, `predecessors`, `implementationFile`, `testFile`, `exportName`, `contract`.

- [ ] Write failing Vitest tests requiring keys 01–20, six roots, edges `07<-01`, `13<-11,12`, `14<-03,04`, `20<-19`, and only 03/04 sharing an implementation path. Confirm missing predecessor, cycle, duplicate test path, invalid run key and non-topological order fail. Assert each issue starts `backlog`, uses exact Paperclip ID blockers, first-block YAML, run marker, `ciPolicy: skip`, and a test command using its own run-qualified filename.
- [ ] Run `pnpm --filter @pilleo/paperclip-orchestrator-adapter exec vitest run test/stress-campaign-manifest.test.ts`; expect failure due to missing module/functions.
- [ ] Implement the 20 contracts from the spec with detailed small CommonJS behavior/examples. Build descriptions with `target_files` for implementation and test, `---` YAML before the run marker, and unique `[stress:<run-key>:<key>]` in the title. Validate acyclic ordered IDs, disjoint test names and only the allowed implementation collision. Reject unsafe run-key characters rather than silently reusing filenames.
- [ ] Run the focused test, `pnpm --filter @pilleo/paperclip-orchestrator-adapter build`, `git diff --check`; commit the manifest and tests.

## Task 2 — provision/create/activate safely

**Interfaces:** `assertStressReadback(task, expectedIssue, detail, predecessorIds): void`, `selectStressProject(projects, runKey): {kind:"missing"}|{kind:"found";project}|{kind:"invalid";reason}`. CLI: `pnpm exec tsx packages/orchestrator/scripts/stress-campaign-create.ts --run-key <key> --dry-run|--provision|--create|--activate|--wake`. Require loopback `PAPERCLIP_TEST_API_URL`, company/orchestrator/repository env vars and explicit owner-only `PAPERCLIP_STRESS_JOURNAL_DIR` for every write operation.

- [ ] Write failing pure receipt tests: zero/one/multiple marker matches; uncertain issue response followed by exactly one matching GET; duplicate markers, changed description, wrong project, wrong blocker list or non-backlog status are fatal. An existing verified issue resumes without POST; ambiguous outcome never triggers automatic repost. Cover unknown workspace POST response by looking up exactly one project-owned matching primary workspace.
- [ ] Run the receipt Vitest test and confirm red. Implement project and issue matching helpers with exact marker/title/project/description/native blocker set equality; return explicit `create`, `resume`, or `stop` decisions. Keep the original v2 project outside candidate matching.
- [ ] Implement CLI HTTP GET/POST/PATCH with a bounded timeout and no authorization in logs, append durable JSONL intent (create/sync journal file before network mutation), and write receipts after authoritative GET. `--dry-run` runs offline manifest validation and prints all 20 contracts. `--provision` reuses the exact marked project or creates *one* marked project and primary git_repo workspace, then checks expected SSH URL/master and checkout distinct from v2. `--create` uses run-key lookup and explicit `backlog` issues in numeric order, resolving native predecessor IDs; all 20 GETs must match before success. `--activate` first verifies the complete graph, then moves exactly those 20 to `todo` and reads each back. `--wake` verifies activation and sends exactly one run-key-scoped orchestrator wake. Fail closed on any ambiguous write.
- [ ] Add a bounded loopback HTTP fixture test covering the CLI dry-run and recoverable readback without simulating database calls. Run focused tests, `pnpm build`, `pnpm check:secrets`, `git diff --check`; commit.

## Task 3 — read-only 20-task observer and terminal proof

**Interfaces:** `evaluateStressProgress(tasks, snapshots): {kind:"awaiting_user_start"|"awaiting_user_merge"|"awaiting_provider"|"invalid"|"failed"|"passed";reason?:string}`; CLI: `pnpm exec tsx packages/orchestrator/scripts/stress-campaign-verify.ts --run-key <key> --project-id <id> [--wait-minutes <positive-integer>]`, with read-only GET and gh `pr view`/`api`/`git` reads only.

- [ ] Write failing tests for 20 all-backlog/awaiting-start; approved roots running with dependent held; dependent started before every predecessor is `done` with verified two-parent merge; simultaneous 03/04 execution; wrong/native PR verdict head or failed addressed run; duplicate original provider session, product or active card; unexpected failed executor, actionable blocker on `done`; missing second-parent GitHub ancestry; terminal 20 correctly merged and reviewed => `passed`. Timeout => failure rather than pass.
- [ ] Run focused test red. Implement pure evaluation separating `awaiting_user_start`, `awaiting_user_merge`, and `awaiting_provider` from `invalid` and `failed`. Require exact head/merge ancestry and board-attributed typed verdicts; never infer success from issue `done` alone.
- [ ] Build the CLI collector: list project issues with explicit limit/pagination, GET exact original details/native child cards/runs, inspect each PR with read-only GitHub CLI; write sanitized snapshots only, bounded polling and explicit nonzero exit for timeout/failure. Reject broad `gh` mutations by construction; no POST/PATCH in verifier source. Add a loopback read-only HTTP test detecting non-GET calls, then run focused tests, `pnpm build`, `pnpm check:secrets`, `git diff --check`; commit.

## Task 4 — preflight and live user-gated campaign

- [ ] Establish clean baseline: `pnpm test`, `pnpm build`, `pnpm typecheck:invariants`, `pnpm test:contract:plan-handback --scenario=stable_child_chain_abc_complete --require-safe` and `pnpm test:contract:plan-handback --scenario=stable_child_chain_abc_recover_auto_blocker --require-safe` (confirm CLI flag from installed harness before invocation), `./scripts/adkw check-backlog`. Record existing ten unrelated frontmatter failures separately.
- [ ] GET `/api/companies`, each `/api/companies/<id>/live-runs`, version and existing v2 project; at **all-company idle**, restart `paperclipai`, confirm both changed adapters loaded from `dist/index.js`, then wait for and verify one orchestrator reconciliation run. Confirm `master`/SSH GitHub remote and permissions with read-only commands.
- [ ] Run CLI `--dry-run`, choose one explicit run key, then journal and run `--provision`, `--create`, `--activate`, `--wake` **once each** with readback and owner-only receipts. If any step is uncertain, stop and inspect rather than repeating. Record the new project, 20 issue IDs, 20 native blockers, start approvals and sanitized hashes in evidence. Never touch the old v2 tasks.
- [ ] Give the user the 20 native task-start approval cards. Run verifier in snapshot mode; after user approval, watch provider sessions, native reviewer cards, merge approvals and PRs read-only. Each GitHub merge is user-only. Publish an evidence table and final pass/fail once all 20 tasks reach terminal states, or capture the precise first blocker if not.
