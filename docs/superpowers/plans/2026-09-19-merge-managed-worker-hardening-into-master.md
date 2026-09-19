# Merge Managed Worker Hardening into Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the valid uncommitted fixes currently attached to `master`, move `master` back to the primary checkout, merge `jules-18036993849073318863-b259ffba` with a normal merge commit, and verify the combined adapter lifecycle.

**Architecture:** Treat the dirty `master` checkout as a recovery source, not as a long-lived development worktree. Commit its two independent behavioral fixes with focused regression coverage, remove only that now-clean linked worktree, switch the primary checkout to `master`, and resolve the branch merge by state-machine boundary: Jules lifecycle, GitHub/CI projection, native review recovery, and scheduler/fleet state. Preserve fail-closed behavior for unknown transport/authentication states while treating an authoritative zero-check GitHub response as a valid no-CI repository.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Git, Paperclip external adapters, Jules API, GitHub REST/CLI integration.

**Spec:** Current repository state, commit `4328275563cebbb834f55624023c61bd2366a71d`, the uncommitted `master` diff in `.worktrees/verify-maz1240-origin-master`, and the merge-tree conflict report `/tmp/merge-conflict-summary-20260919.log`.

## Global Constraints

- Do not create another worktree.
- Use standard merge commits; never squash.
- Preserve all existing commits and branch references; do not reset or force-update `master`.
- Keep native review decisions in Paperclip structured verdict cards; never replace them with comments.
- Unknown, unavailable, malformed, unauthorized, or rate-limited CI data remains fail-closed.
- An authoritative successful GitHub response containing zero configured checks is terminal green for repositories that intentionally have no CI.
- Paperclip nested PATCH semantics require `executionPolicy.monitor: null` to clear a Jules monitor.
- Run focused tests after each conflict group and the existing E2E suites after the complete merge.

## Review Focus

- A successful GitHub checks response with `check_runs: []` must be green, while request failures and malformed responses must remain non-green.
- Terminal Jules handoff must explicitly clear the monitor and must detect if Paperclip retains it.
- Plan and question activities must preserve exact revision/activity identity across merge conflict resolution.
- Native review recovery must keep one authoritative card and suppress wakes for answered cards, active reviewer runs, grace periods, and read failures.
- Scheduler lane state must not reintroduce locally counted Jules quotas or allow dependency-blocked tasks to dispatch.

---

### Task 1: Convert the dirty master checkout into reviewed commits

**Files:**
- Modify: `.worktrees/verify-maz1240-origin-master/packages/jules/src/server/paperclip-client.ts`
- Modify: `.worktrees/verify-maz1240-origin-master/packages/jules/test/paperclip-client.test.ts`
- Modify: `.worktrees/verify-maz1240-origin-master/packages/orchestrator/src/core/github-sync.ts`
- Modify: `.worktrees/verify-maz1240-origin-master/packages/orchestrator/test/github-sync.test.ts`
- Delete: `.worktrees/verify-maz1240-origin-master/canary.txt`

**Interfaces:**
- Consumes: Paperclip `PATCH /api/issues/:id` merge semantics and GitHub check-runs responses.
- Produces: terminal monitor tombstones and a tested no-CI disposition for later merge resolution.

- [ ] **Step 1: Add direct zero-check CI regression coverage**

Add focused cases around `checkPrCiIsGreen` using a stubbed successful response:

```ts
it("treats an authoritative empty check-runs response as green", async () => {
  global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ check_runs: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await expect(checkPrCiIsGreen("Pilleo/repo", "abc123", "token"))
    .resolves.toEqual({ isGreen: true, status: "none" });
});

it.each([500, 401, 403, 429])("keeps HTTP %s fail-closed", async (status) => {
  global.fetch = vi.fn().mockResolvedValue(new Response("failure", { status }));
  expect((await checkPrCiIsGreen("Pilleo/repo", "abc123", "token")).isGreen).toBe(false);
});
```

- [ ] **Step 2: Prove the direct test detects the old behavior**

Temporarily change only the empty-check branch to return `{ isGreen: false, status: "none" }`, run:

```bash
pnpm --filter @pilleo/paperclip-adapter-orchestrator test -- github-sync.test.ts
```

Expected: the authoritative-empty-check test fails. Restore the intended return value immediately and rerun; expected: PASS.

- [ ] **Step 3: Verify terminal monitor cleanup coverage**

Run:

```bash
pnpm --filter @pilleo/paperclip-adapter-jules test -- paperclip-client.test.ts
```

Expected: the request body assertion proves `executionPolicy.monitor` is explicitly `null`, and the focused suite passes.

- [ ] **Step 4: Commit the two behavioral fixes separately**

```bash
git -C .worktrees/verify-maz1240-origin-master add packages/jules/src/server/paperclip-client.ts packages/jules/test/paperclip-client.test.ts
git -C .worktrees/verify-maz1240-origin-master commit -m "fix(jules): clear terminal session monitor"
git -C .worktrees/verify-maz1240-origin-master add packages/orchestrator/src/core/github-sync.ts packages/orchestrator/test/github-sync.test.ts
git -C .worktrees/verify-maz1240-origin-master commit -m "fix(orchestrator): accept repositories without CI checks"
git -C .worktrees/verify-maz1240-origin-master add canary.txt
git -C .worktrees/verify-maz1240-origin-master commit -m "chore: remove disposable canary residue"
```

- [ ] **Step 5: Verify the master checkout is clean**

Run `git -C .worktrees/verify-maz1240-origin-master status --short --branch`.

Expected: no tracked or untracked changes.

### Task 2: Return master ownership to the primary checkout

**Files:**
- Remove checkout only: `.worktrees/verify-maz1240-origin-master`
- Preserve local runtime artifact: `.taskplane/`

**Interfaces:**
- Consumes: the clean `master` branch produced by Task 1.
- Produces: the primary repository checkout on `master`, with the feature branch still available by name.

- [ ] **Step 1: Record safety references**

Run:

```bash
git rev-parse master
git rev-parse jules-18036993849073318863-b259ffba
git status --short --branch
git worktree list --porcelain
```

Save the output under `/tmp/paperclip-adapters-pre-merge-safety-20260919.log` and verify that `.taskplane/` is the only primary-checkout residue.

- [ ] **Step 2: Remove only the clean worktree that owns master**

Run:

```bash
git worktree remove .worktrees/verify-maz1240-origin-master
git worktree prune
```

Do not remove any other linked checkout or branch.

- [ ] **Step 3: Switch the primary checkout to master**

Run `git switch master`.

Expected: the primary checkout is on `master`; `.taskplane/` remains untracked and untouched.

### Task 3: Merge the feature history and resolve documentation/backlog conflicts

**Files:**
- Modify: `docs/ONBOARDING.md`
- Modify: `docs/internals/backlog/code_health/issue-20260902-214256-deduplicate-e2e-canary-logging-and-isolate-test-telemetry.md`
- Modify: `docs/internals/backlog/code_health/issue-20260902-214257-extract-a-typed-paperclip-disposable-environment-e2e-client.md`
- Modify: `docs/internals/backlog/code_health/issue-20260902-214303-retire-the-deprecated-jules-pr-compatibility-timer-after-nat.md`
- Modify: `docs/internals/backlog/issue-20260830-210200-planning-engine-ts-test-discovery.md`
- Modify: `docs/internals/backlog/testing/issue-20260902-214239-add-negative-recovery-cases-to-the-paperclip-jules-canary.md`
- Modify: `docs/internals/backlog/testing/issue-20260904-120001-add-server-backed-jules-recovery-canary.md`

**Interfaces:**
- Consumes: both branch histories and existing Paperclip issue identifiers.
- Produces: conflict-free documentation that retains real issue IDs and current operational rules.

- [ ] **Step 1: Start a normal merge commit**

Run:

```bash
git merge --no-ff jules-18036993849073318863-b259ffba -m "merge: harden managed worker lanes"
```

Expected: Git stops with the conflicts listed by the merge-tree preview; do not abort.

- [ ] **Step 2: Resolve documentation conflicts semantically**

Keep current operational guidance from both sides. For backlog front matter, preserve every non-empty `paperclip_issue_id` and `paperclip_identifier`; never replace a populated identifier with an empty string. Remove all conflict markers.

- [ ] **Step 3: Validate documentation and backlog metadata**

Run:

```bash
rg -n '^(<<<<<<<|=======|>>>>>>>)' docs
./scripts/adkw check-backlog
```

Expected: no conflict markers and backlog validation succeeds.

### Task 4: Resolve Jules lifecycle and GitHub/CI conflicts

**Files:**
- Modify: `packages/jules/src/server/ci-status.ts`
- Modify: `packages/jules/src/server/execute.ts`
- Modify: `packages/jules/src/server/interaction-engine.ts`
- Modify: `packages/jules/src/server/paperclip-client.ts`
- Modify: `packages/jules/src/server/plan-gate-state.ts`
- Modify: `packages/jules/src/server/session-lifecycle.ts`
- Modify: corresponding tests under `packages/jules/test/`

**Interfaces:**
- Consumes: terminal monitor tombstone, provider activity identity, plan revision state, and authoritative CI status.
- Produces: one exhaustive Jules lifecycle that preserves questions/plans, retries transient provider failures, and hands PRs to structured review once.

- [ ] **Step 1: Resolve CI status as an exhaustive disposition**

Preserve these cases in `ci-status.ts` and tests:

```ts
[]                         // authoritative no-CI => "success"
incomplete check           // => "pending"
completed unsuccessful     // => "failed"
transport/parse/auth error // => "unknown" or fail-closed equivalent
```

Retain immutable PR head SHA and head-ref data used to invalidate stale review cards.

- [ ] **Step 2: Resolve provider interaction identity**

Preserve both `supersededPlanActivityId` and any newer fingerprint/revision fields required by the current session schema. A replay of the same provider activity must not create another card; a genuinely new activity must create exactly one current card.

- [ ] **Step 3: Resolve terminal lifecycle and monitor cleanup**

Keep bounded transient retry, missing-PR continuation, pending-plan restoration, explicit `monitor: null`, and verification that Paperclip actually removed the monitor. Do not convert provider questions or plans into comments.

- [ ] **Step 4: Run focused Jules suites**

```bash
pnpm --filter @pilleo/paperclip-adapter-jules test -- ci-status.test.ts interaction-engine.test.ts paperclip-client.test.ts plan-gate-state.test.ts session-lifecycle.test.ts e2e-plan-presentation.test.ts
```

Expected: all focused Jules tests pass with no snapshots or assertions weakened.

### Task 5: Resolve orchestrator review, fleet, and scheduler conflicts

**Files:**
- Modify: `packages/orchestrator/src/core/approvals.ts`
- Modify: `packages/orchestrator/src/core/fleet-manager.ts`
- Modify: `packages/orchestrator/src/core/native-review-mcp-home.ts`
- Modify: `packages/orchestrator/src/core/native-review-recovery.ts`
- Modify: `packages/orchestrator/src/core/parser.ts`
- Modify: `packages/orchestrator/src/core/telemetry-card.ts`
- Modify: `packages/orchestrator/src/core/types.ts`
- Modify: `packages/orchestrator/src/server/execute.ts`
- Modify: `packages/orchestrator/src/server/index.ts`
- Modify: `packages/orchestrator/src/server/native-review-mcp-stdio.ts`
- Modify: corresponding tests under `packages/orchestrator/test/`

**Interfaces:**
- Consumes: `WorkerLaneState`, native interaction/card identity, reviewer run status, project-scoped wake reasons, and dependency approval state.
- Produces: deterministic per-project scheduling and one Luna-then-Terra structured review ladder without duplicate wakes.

- [ ] **Step 1: Preserve the typed worker-lane model**

Use `worker-lane-state.ts` as the single scheduler admission model. Do not restore deleted local Jules quota counting. Provider 402/quota/capacity responses degrade or defer that lane without inventing a local active-session limit.

- [ ] **Step 2: Preserve native review recovery guards**

The merged recovery transition must require the exact pending card and addressed reviewer, then suppress compatibility wakes when the card is answered, a reviewer run is queued/running, the grace period is active, or the final card/run re-read fails.

- [ ] **Step 3: Preserve project and dependency boundaries**

Timer ticks may process all projects asynchronously. Explicit wakes remain project/issue scoped. Approved dependency-blocked issues retain approval but do not dispatch until all blockers are terminally resolved.

- [ ] **Step 4: Run focused orchestrator suites**

```bash
pnpm --filter @pilleo/paperclip-adapter-orchestrator test -- approvals.test.ts fleet-manager.test.ts native-review-mcp-home.test.ts native-review-mcp-stdio.test.ts native-review-recovery.test.ts telemetry-card.test.ts execute-projects.test.ts execute-jules-plan-review-recovery.test.ts worker-lane-state.test.ts github-sync.test.ts
```

Expected: all focused suites pass, including direct no-CI and final revalidation cases.

### Task 6: Resolve E2E harness conflicts and complete the merge commit

**Files:**
- Modify: `packages/orchestrator/scripts/e2e-jules-recovery.ts`
- Modify: `packages/orchestrator/scripts/e2e-paperclip-lifecycle.ts`
- Modify: `packages/orchestrator/README.md`
- Modify: any remaining files reported by `git diff --name-only --diff-filter=U`

**Interfaces:**
- Consumes: merged project-scoped wakes, structured reviewer cards, worker lanes, and no-CI semantics.
- Produces: runnable regression harnesses and the final merge commit.

- [ ] **Step 1: Resolve E2E scripts around public behavior**

Keep project-scoped wake reasons, structured reviewer capabilities, exact native verdict submission, explicit dependency sequencing, no-check repository support, and bounded Jules polling. Do not encode local active-session counting.

- [ ] **Step 2: Prove no merge artifacts remain**

```bash
git diff --name-only --diff-filter=U
rg -n '^(<<<<<<<|=======|>>>>>>>)' --glob '!pnpm-lock.yaml' .
git diff --check
```

Expected: no unmerged files, no conflict markers, and no whitespace errors.

- [ ] **Step 3: Build and run package suites**

```bash
pnpm build
pnpm test
```

Expected: all workspace builds and tests pass.

- [ ] **Step 4: Complete the merge commit**

```bash
git add -A
git commit
```

Expected: Git completes the existing `merge: harden managed worker lanes` commit; do not create a squash commit.

### Task 7: Reload adapters and verify the merged lifecycle

**Files:**
- Runtime only; no expected source changes.

**Interfaces:**
- Consumes: built merged adapters and the local Paperclip server.
- Produces: evidence that Paperclip loaded the merged `dist/index.js` files and reconciled one healthy fleet tick.

- [ ] **Step 1: Run pre-flight and E2E verification**

```bash
pnpm fleet:doctor
pnpm test:e2e:jules-recovery
pnpm test:e2e
```

Expected: pre-flight passes; the recovery canary and lifecycle canary complete without duplicate cards, free-text verdicts, or per-minute Jules spam.

- [ ] **Step 2: Restart Paperclip and verify adapter loading**

Restart the existing port-3100 Paperclip process using the repository's current startup command. Save startup logs under `/tmp`, then verify the log names each external adapter's `dist/index.js`. Allow one orchestrator heartbeat to reconcile managed agents.

- [ ] **Step 3: Inspect live state without mutating it**

Confirm that no new duplicate review cards were created, no completed Jules monitor remains scheduled, and scheduler telemetry reports typed lane state rather than a locally counted Jules quota.

- [ ] **Step 4: Record final evidence**

```bash
git status --short --branch
git log --oneline --decorate --graph -8
git show --summary --format=fuller HEAD
```

Expected: primary checkout is `master`, the merge has two parents, source is clean except intentionally ignored/local runtime artifacts, and all verification commands are recorded.
