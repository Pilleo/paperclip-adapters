# Reliable Disposable Dependency Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver and prove an autonomous, dependency-safe Paperclip flow in which A, B, and C may be approved early but execute, review, and merge strictly one at a time.

**Architecture:** Add a typed scope resolver before project execution, separate task authorization from dispatch routing, retain an authoritative dependency gate, and bound external Git operations. Replace the contaminated test fixture with one stable replacement project under Mazewall and verify the complete real lifecycle.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces, Paperclip HTTP API, local Paperclip server, Jules, GitHub CLI.

**Spec:** docs/superpowers/specs/2026-09-17-disposable-e2e-project-isolation-design.md

## Global constraints

- Do not use Git worktrees.
- Do not modify MAZ-1450.
- Do not create additional companies.
- Create at most one replacement disposable project; reuse it only after all prior canary tasks are terminal.
- Preserve the configured SSH repository transport.
- Use only native Paperclip approvals and review verdicts. Free-text comments never satisfy a decision.
- Use package name @pilleo/paperclip-orchestrator-adapter in every focused pnpm command.
- Run the focused tests after each implementation slice and the existing orchestrator E2E tests after every source change.
- Use git absorb --and-rebase for iterative corrections to an existing slice; create one atomic commit per completed slice.
- Rebuild and restart Paperclip after adapter changes, then prove dist/index.js was loaded before live verification.
- Save live logs under /tmp and never print credentials.

---

### Task 1: Characterize scope and liveness before changing behavior

**Files:**
- Create: packages/orchestrator/test/heartbeat-scope-characterization.test.ts
- Create: packages/orchestrator/test/project-operation-timeouts.test.ts

**Interfaces:**
- Characterization fixtures describe the current Paperclip wake contexts:
  issueId/taskId, approvalId, direct projectId, and unscoped timer.
- Timeout fixtures inject subprocess runners; they do not sleep in real time.

- [ ] Write a failing characterization showing payload.issueId becomes context.issueId while payload.projectId is unavailable to the adapter.
- [ ] Write failing cases showing an approval-only context must be resolvable from approval.payload.issueId and that multiple linked issues from different projects are ambiguous.
- [ ] Write failing fake-runner cases for git ls-remote, fetch, pull, clone, and merge that never resolve unless supplied a timeout.
- [ ] Run:
  pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- heartbeat-scope-characterization.test.ts project-operation-timeouts.test.ts
  Expected: red because scope resolution and complete Git deadlines do not exist.
- [ ] Record the old live heartbeat id and its last persisted event in the test evidence notes. Do not cancel it during this task.

### Task 2: Implement an exhaustive heartbeat scope resolver

**Files:**
- Create: packages/orchestrator/src/core/heartbeat-project-scope.ts
- Create: packages/orchestrator/test/heartbeat-project-scope.test.ts
- Modify: packages/orchestrator/src/server/execute.ts
- Modify: packages/orchestrator/test/execute-projects.test.ts

**Interfaces:**
- HeartbeatScopeReference =
  { kind: "project", projectId } |
  { kind: "issue", issueId } |
  { kind: "approval", approvalId } |
  { kind: "unscoped_timer" }.
- HeartbeatProjectSelection =
  { kind: "scoped", project } |
  { kind: "all_projects", projects } |
  { kind: "invalid", reason: "unknown_project" | "unknown_issue" | "unknown_approval" | "missing_issue_project" | "cross_project_approval" }.
- resolveHeartbeatProjectSelection reads at most one issue after resolving an approval.

- [ ] Write parameterized red tests for direct project, issue/task, approval payload issueId, approval issueIds, cross-project approval, unknown references, and unscoped timer.
- [ ] Assert that reason = approval_approved plus approvalId resolves a single project even when issueId is absent.
- [ ] Run:
  pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- heartbeat-project-scope.test.ts execute-projects.test.ts
- [ ] Implement the pure reference parser and I/O resolver. Use exhaustive switches; invalid scoped input returns exit code 1 and never widens to all projects.
- [ ] Change executeAllProjects to allocate capacity and run workers only for selected projects. Preserve all-project behavior only for a genuinely unscoped timer.
- [ ] Add integration assertions: scoped project B gets one callback and full configured capacity; project A is untouched; fleet reconciliation runs once.
- [ ] Run:
  pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- heartbeat-project-scope.test.ts execute-projects.test.ts project-workspaces.test.ts
- [ ] Commit:
  git add packages/orchestrator/src/core/heartbeat-project-scope.ts packages/orchestrator/src/server/execute.ts packages/orchestrator/test/heartbeat-scope-characterization.test.ts packages/orchestrator/test/heartbeat-project-scope.test.ts packages/orchestrator/test/execute-projects.test.ts
  git commit -m "fix(orchestrator): scope issue and approval heartbeats"

### Task 3: Bound project-tick external operations

**Files:**
- Create: packages/orchestrator/src/core/external-operation-deadlines.ts
- Modify: packages/orchestrator/src/core/consistency.ts
- Modify: packages/orchestrator/src/core/project-managed-checkout.ts
- Modify: packages/orchestrator/src/server/execute.ts
- Modify: packages/orchestrator/test/consistency-deep.test.ts
- Modify: packages/orchestrator/test/project-managed-checkout.test.ts
- Modify: packages/orchestrator/test/project-operation-timeouts.test.ts

**Interfaces:**
- PROJECT_GIT_INSPECTION_TIMEOUT_MS = 8_000.
- PROJECT_GIT_REMOTE_TIMEOUT_MS = 30_000.
- PROJECT_GIT_CLONE_TIMEOUT_MS = 120_000.
- PROJECT_GIT_MERGE_TIMEOUT_MS = 120_000.
- timeoutExecOptions(kind) returns a readonly Node execFile options object.
- No whole-executeProject Promise.race is allowed.

- [ ] Keep the Task 1 timeout tests red and add exact expected timeout values for each operation kind.
- [ ] Add timeout options to every git command in checkWorkspaceConsistency, checkout detection/materialization, and gh pr merge.
- [ ] Preserve GIT_TERMINAL_PROMPT=0 for noninteractive Git. Timeout failures become typed unhealthy observations and cannot dispatch work.
- [ ] Add start/finish/error log records with projectId around each project worker invocation so a future stalled boundary is visible.
- [ ] Run:
  pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- project-operation-timeouts.test.ts consistency-deep.test.ts project-managed-checkout.test.ts execute-projects.test.ts
- [ ] Commit:
  git add packages/orchestrator/src/core/external-operation-deadlines.ts packages/orchestrator/src/core/consistency.ts packages/orchestrator/src/core/project-managed-checkout.ts packages/orchestrator/src/server/execute.ts packages/orchestrator/test/project-operation-timeouts.test.ts packages/orchestrator/test/consistency-deep.test.ts packages/orchestrator/test/project-managed-checkout.test.ts packages/orchestrator/test/execute-projects.test.ts
  git commit -m "fix(orchestrator): bound project external operations"

### Task 4: Separate task authorization from executor routing

**Files:**
- Create: packages/orchestrator/src/core/start-approval-scheduling.ts
- Create: packages/orchestrator/test/start-approval-scheduling.test.ts
- Modify: packages/orchestrator/src/core/approvals.ts
- Modify: packages/orchestrator/test/approvals.test.ts
- Modify: packages/orchestrator/src/server/execute.ts
- Create: packages/orchestrator/test/execute-approval-dispatch.test.ts

**Interfaces:**
- selectStartApprovalCandidates returns orchestrator-managed backlog/todo implementation issues, excluding open-question issues and delegated review/recovery children.
- evaluateTaskStartApproval no longer requires targetAgentId.
- CREATE_APPROVAL_REQUEST authorizes issue id, immutable scope summary, priority, and target files/symbols. targetAgentId is optional legacy metadata and is not an authorization constraint.
- Dispatch chooses Jules or Vibe only after capacity and conflicts are evaluated.

- [ ] Write red tests proving A/B/C are all approval candidates while B/C have unresolved dependencies.
- [ ] Add exclusions for terminal, active, open-question, delegated-review, and diagnostic recovery cards.
- [ ] Write backward-compatibility tests proving existing approvals containing targetAgentId remain valid and new approvals without it are recognized.
- [ ] Run:
  pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- start-approval-scheduling.test.ts approvals.test.ts
- [ ] Implement a dedicated approval phase after project issue loading but before sync/capacity dispatch exits. It may create approval cards while a dependency is unresolved or capacity is zero; it must not patch issue state or wake a worker.
- [ ] Ensure approvals are created by the active orchestrator heartbeat identity. Add an integration assertion that requestedByAgentId equals the orchestrator and the approval is linked to exactly one issue. A board-created requester-less approval is not a valid E2E fixture.
- [ ] Add dispatch regressions: with all approvals approved and A nonterminal, only A dispatches; executor selection may choose the currently available managed lane without invalidating task authorization.
- [ ] Run:
  pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- start-approval-scheduling.test.ts approvals.test.ts execute-approval-dispatch.test.ts
- [ ] Commit:
  git add packages/orchestrator/src/core/start-approval-scheduling.ts packages/orchestrator/src/core/approvals.ts packages/orchestrator/src/server/execute.ts packages/orchestrator/test/start-approval-scheduling.test.ts packages/orchestrator/test/approvals.test.ts packages/orchestrator/test/execute-approval-dispatch.test.ts
  git commit -m "fix(orchestrator): decouple task approval from executor routing"

### Task 5: Make dependency decisions exhaustive without changing valid live edges

**Files:**
- Modify: packages/orchestrator/src/core/dependency-gate.ts
- Modify: packages/orchestrator/test/dependency-gate.test.ts
- Modify: packages/orchestrator/test/execute-approval-dispatch.test.ts

**Interfaces:**
- DependencyGateResult =
  { safe: true } |
  { safe: false, kind: "missing_projection" } |
  { safe: false, kind: "malformed_blocker", blockerIndex } |
  { safe: false, kind: "nonterminal_blocker", blockerId, status }.
- blockedBy from GET /api/issues/:id is authoritative. blockedByIssueIds is neither required nor sufficient at dispatch.

- [ ] Add parameterized red tests for absent projection, malformed record, backlog, todo, in_progress, in_review, blocked, done, and cancelled.
- [ ] Implement the union and one exhaustive formatter.
- [ ] Add a stale-list test: compact list has no relations, detail has A todo, therefore B cannot patch/wake; detail changes to A done, therefore B dispatches exactly once.
- [ ] Add a regression using the actual MAZ-1531/1532 response shape where blockedByIssueIds is absent but blockedBy is valid.
- [ ] Run:
  pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- dependency-gate.test.ts execute-approval-dispatch.test.ts
- [ ] Commit:
  git add packages/orchestrator/src/core/dependency-gate.ts packages/orchestrator/test/dependency-gate.test.ts packages/orchestrator/test/execute-approval-dispatch.test.ts
  git commit -m "refactor(orchestrator): type authoritative dependency outcomes"

### Task 6: Build one reusable replacement project fixture

**Files:**
- Modify: packages/orchestrator/src/core/real-e2e-canary-fixture.ts
- Modify: packages/orchestrator/test/real-e2e-canary-fixture.test.ts
- Create: packages/orchestrator/src/core/real-e2e-project-registry.ts
- Create: packages/orchestrator/test/real-e2e-project-registry.test.ts
- Modify: packages/orchestrator/scripts/e2e-real-project-canary.ts
- Modify: packages/orchestrator/README.md

**Interfaces:**
- Stable project description marker: `<!-- paperclip-adapters:e2e-project:v2 -->`.
- Stable issue description marker: `<!-- paperclip-adapters:e2e-run:<run-key> -->`.
- ensureSingleDisposableProject returns existing, create, or invalid_duplicate.
- assertProjectReadyForCanary rejects any nonterminal prior task carrying the canary marker.
- buildCanaryA(projectId, runKey), buildCanaryB(projectId, runKey, aId), buildCanaryC(projectId, runKey, bId).
- B and C include blockedByIssueIds atomically in POST creation.
- assertAuthoritativeCanaryChain reads blockedBy, not blockedByIssues or blockedByIssueIds.

- [ ] Write red tests: zero marked projects creates one; one reuses it; two fail closed; a nonterminal previous run refuses to create more cards.
- [ ] Write red fixture tests proving B -> A and C -> B and rejecting wrong/absent blockedBy.
- [ ] Use disjoint files: increment.js, decrement.js, and is-zero.js.
- [ ] Require PAPERCLIP_E2E_COMPANY_ID for Mazewall and a reusable repository slug/SSH URL. Remove create-company behavior.
- [ ] Create or reuse exactly one v2 project. Do not reuse the historical project with 538 cards.
- [ ] Create the chain, read it back, then wake the orchestrator with payload.issueId = A.id. Do not send payload.projectId.
- [ ] Wait for the orchestrator-created native approvals and assert all three have requestedByAgentId = orchestrator id and correct issue linkage before printing their URLs.
- [ ] Run:
  pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- real-e2e-canary-fixture.test.ts real-e2e-project-registry.test.ts heartbeat-project-scope.test.ts
- [ ] Commit:
  git add packages/orchestrator/src/core/real-e2e-canary-fixture.ts packages/orchestrator/src/core/real-e2e-project-registry.ts packages/orchestrator/scripts/e2e-real-project-canary.ts packages/orchestrator/test/real-e2e-canary-fixture.test.ts packages/orchestrator/test/real-e2e-project-registry.test.ts packages/orchestrator/README.md
  git commit -m "test(orchestrator): create one reusable dependency canary"

### Task 7: Add a production-path lifecycle regression

**Files:**
- Create: packages/orchestrator/test/disposable-chain-lifecycle.test.ts

**Interfaces:**
- A stateful fake Paperclip server supplies projects, issue detail, approvals, and wake records.
- The test invokes executeAllProjects and executeProject through production HTTP seams.

- [ ] Parameterize these states:
  - approvals pending: three approval cards, zero worker wakes.
  - all approved, A backlog: A wakes exactly once.
  - A done, B todo: B wakes exactly once.
  - B done, C backlog: C wakes exactly once.
  - missing/malformed blocker projection: zero worker wakes.
  - approval-only wake context: selected project only.
  - unrelated project dirty or hanging: no call from the scoped heartbeat.
- [ ] Make the fake reject a task transition when blockedBy contains a nonterminal issue. This prevents tests from passing if the adapter bypasses detail validation.
- [ ] Assert no free-text decision comment, duplicate approval, duplicate worker wake, or cross-project mutation.
- [ ] Run:
  pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- disposable-chain-lifecycle.test.ts execute-projects.test.ts execute-approval-dispatch.test.ts
- [ ] Commit:
  git add packages/orchestrator/test/disposable-chain-lifecycle.test.ts
  git commit -m "test(orchestrator): cover scoped dependency lifecycle"

### Task 8: Deploy and prove the complete real flow

**Files:**
- No source files expected.
- Save evidence under /tmp/paperclip-disposable-chain-<run-key>/.

- [ ] Run:
  pnpm --filter @pilleo/paperclip-orchestrator-adapter test
  pnpm test
  pnpm build
  Stop on any failure.
- [ ] Restart Paperclip and save startup evidence proving orchestrator, Jules, Vibe, and Antigravity loaded their dist/index.js files.
- [ ] After the bounded-operation code is deployed, cancel the specifically identified stale heartbeat 087d5954-fc7a-407d-bad0-eafcd42e5198 if it is still running. Do not cancel any other run.
- [ ] Run the fixture once. Before user approval assert: one v2 project, A/B/C native edges correct, three pending orchestrator-requested approvals, and no executionRunId.
- [ ] After all three approvals are approved, observe the automatic approval wake. Assert it scopes to the v2 project and starts only A.
- [ ] Poll Jules no more frequently than every 15 minutes while active. Capture plan approval/question interactions, PR registration, green CI, Luna native verdict, Terra native verdict, merge approval, and merge detection.
- [ ] After A merges, verify B starts automatically and C does not. After B merges, verify C starts automatically.
- [ ] Completion requires all three tasks terminal, exactly one implementation session and PR per task, exactly one Luna and Terra verdict per PR head, no free-text substitute, no duplicate wakes, and no cross-project writes.
- [ ] If any assertion fails, save the new error and stop. Do not patch live cards manually to manufacture a pass.

## Self-review

- Corrects the earlier false claim that native edges were missing.
- Uses the actual pnpm package name.
- Uses Paperclip's real issueId/approvalId wake contract.
- Prevents project/company proliferation.
- Keeps approval task-scoped so dispatch-time routing cannot invalidate it.
- Covers the still-running heartbeat through bounded external operations and explicit project logs.
- Preserves fail-closed native dependency and review semantics.
