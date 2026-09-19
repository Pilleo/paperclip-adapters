# Immutable Running Heartbeat Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a late on-demand, project-scoped wake from widening an already-running timer heartbeat into a company-wide orchestrator run.

**Architecture:** A heartbeat run's context becomes immutable when it is claimed as `running`. Paperclip queues an on-demand wake that arrives after that transition as a successor run instead of merging its context into the live timer. The adapter continues to derive scope from the current run's canonical snapshot and treats malformed authority as a failure, never a broad tick.

**Tech Stack:** Paperclip server TypeScript/Drizzle, Paperclip adapter TypeScript, Vitest, pnpm.

**Evidence:** `75b116c6-9b0e-4dd3-bf2d-7dfcbadac90b` began as a timer and processed nine projects after a project wake was merged too late. `b1938fbe-97b2-4dc5-baf5-e11bfa528adc`, created directly, logged the expected `project:7af1570b-2285-41a8-ae44-045cf7a4f3f0` scope and ran one project.

## Global Constraints

- Do not merge an on-demand wake into a `running` heartbeat run.
- Preserve same-scope coalescing for `queued` and `scheduled_retry` runs.
- A queued successor retains the request's source, reason, payload, idempotency key, and canonical scope context.
- Use real database-backed server tests; do not mock database calls.
- Run the complete relevant server and adapter suites after every source slice.
- Do not approve MAZ-1533 during verification.

---

### Task 1: Make running-run coalescing an explicit state transition in Paperclip

**Repository:** `/home/leanid/Documents/code/java/paperclip`

**Files:**
- Modify: `server/src/services/heartbeat.ts:19025-19120`
- Test: the existing heartbeat wake/coalescing integration test file containing `mergeCoalescedContextSnapshot`

**Interfaces:**
- Consumes: `sameScopeRunningRun`, `sameScopeQueuedRun`, `sameScopeScheduledRetryRun`, `enrichedContextSnapshot`, and wake request metadata.
- Produces: either a merged not-yet-running run or a newly queued successor run.

- [ ] **Step 1: Write the failing database-backed regression test**

Create one timer run in `running` status, invoke the normal on-demand project wake API/service with the reserved project envelope, and assert:

```ts
expect(await heartbeat.getRun(timerRun.id)).toMatchObject({
  status: "running",
  contextSnapshot: expect.not.objectContaining({
    wakeSource: "on_demand",
  }),
});
const successor = await findQueuedRunForWake(idempotencyKey);
expect(successor).toMatchObject({
  status: "queued",
  invocationSource: "on_demand",
  contextSnapshot: expect.objectContaining({
    wakeSource: "on_demand",
    wakeReason: `paperclip-orchestrator-scope/v1/project/${projectId}`,
  }),
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run the existing focused server test. Expected: it fails because the current `coalescedTargetRun` includes `sameScopeRunningRun` and overwrites the live timer context.

- [ ] **Step 3: Implement the smallest transition change**

In `enqueueWakeup`, select coalesce targets only from `queued` and `scheduled_retry` records. When the same-scope record is `running` and the new wake is on-demand, bypass `mergeCoalescedContextSnapshot` and enter the existing transaction that inserts `agentWakeupRequests` and a queued `heartbeatRuns` successor. Keep the existing zombie filtering and idempotency handling unchanged.

- [ ] **Step 4: Run focused and full server tests**

Run the focused coalescing test, then the complete server test command. Expected: a running timer remains immutable; queued/scheduled-retry same-scope requests still coalesce; no duplicate successor exists for the same idempotency key.

- [ ] **Step 5: Commit the server slice**

```bash
git add server/src/services/heartbeat.ts server/src/**/__tests__/*heartbeat*
git commit -m "fix(heartbeat): queue wakes after a run starts"
```

### Task 2: Lock the adapter contract to immutable authoritative run scope

**Repository:** `/home/leanid/Documents/code/java/paperclip-adapters`

**Files:**
- Modify: `packages/orchestrator/test/execute-projects.test.ts`
- Modify only if needed: `packages/orchestrator/src/server/execute.ts`

**Interfaces:**
- Consumes: `GET /api/heartbeat-runs/:runId` snapshot at adapter start.
- Produces: exactly one selected project for a project-scoped successor; all projects only for a timer snapshot with no later merged scope.

- [ ] **Step 1: Write the failing adapter contract test**

Model two independent run records: an immutable timer run with `{ source: "scheduler", reason: "interval_elapsed" }`, and a queued on-demand successor with the explicit project envelope. Assert the first selects the timer's normal project set and the successor selects only `project-b`; do not model either record changing after `executeAllProjects` starts.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- execute-projects.test.ts
```

Expected: RED until the fixture and selection assertions distinguish the two immutable runs.

- [ ] **Step 3: Implement only necessary adapter changes**

Keep `classifyAuthoritativeHeartbeatScope` as the sole parser. Do not add sleep, retry, polling, or a timer heuristic: the server transition, not timing, establishes the safe authority boundary.

- [ ] **Step 4: Verify adapter regression suite**

Run the focused test, the complete orchestrator suite, build, and `git diff --check`. Expected: 90 test files pass and the built adapter contains the scope classifier.

- [ ] **Step 5: Commit the adapter test slice**

```bash
git add packages/orchestrator/test/execute-projects.test.ts packages/orchestrator/src/server/execute.ts
git commit -m "test(orchestrator): require immutable heartbeat scope"
```

### Task 3: Verify the server/adapter boundary with the disposable project

**Files:**
- Modify if necessary: `packages/orchestrator/scripts/e2e-real-project-canary.ts`
- Test: `packages/orchestrator/test/real-e2e-canary-fixture.test.ts`

- [ ] **Step 1: Preserve the project-scoped canary wake builder test**

Keep the assertion that the wake builder emits:

```ts
{
  source: "on_demand",
  reason: `paperclip-orchestrator-scope/v1/project/${projectId}`,
  payload: { projectId },
}
```

- [ ] **Step 2: Reload both built components**

Build Paperclip and the orchestrator adapter, restart the local Paperclip service, and verify the startup log names `packages/orchestrator/dist/index.js`.

- [ ] **Step 3: Controlled live race verification**

While one ordinary timer run is `running`, send exactly one idempotent project-scoped wake. Verify through `/api/heartbeat-runs/:id` that:

1. the timer run keeps timer-only canonical context;
2. a distinct queued/successor run contains the explicit project envelope;
3. the successor's stdout says `project:<configured-disposable-project-id>` and `Processed 1 project(s)`;
4. MAZ-1533 has exactly one pending `task_start` approval; MAZ-1534 and MAZ-1535 remain unassigned.

- [ ] **Step 4: Commit documentation**

```bash
git add packages/orchestrator/README.md docs/superpowers/plans/2026-09-17-running-wake-coalescing.md
git commit -m "docs(orchestrator): record immutable wake requirement"
```
