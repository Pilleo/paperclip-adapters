# Authoritative Heartbeat Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every orchestrator heartbeat derive its project authority from the canonical Paperclip run record, so missing context can never widen an on-demand wake into a company-wide scheduling tick.

**Architecture:** Add a pure, exhaustive scope-authority state machine beside the existing project selector. `executeAllProjects` will load the current heartbeat run before listing projects, validate run and agent identity, classify either one scoped reference or a positively identified timer, and fail closed otherwise. The existing real-project canary will keep a documented wake-reason envelope until Paperclip preserves typed payloads through coalescing.

**Tech Stack:** TypeScript, Vitest, Paperclip HTTP API, pnpm workspaces, existing Paperclip systemd development service.

**Spec:** `docs/superpowers/specs/2026-09-17-authoritative-heartbeat-scope-design.md`

## Global Constraints

- Work in the current checkout; do not create a git worktree.
- Use TDD for every behavioral slice and observe the intended failure before source changes.
- Run the complete orchestrator suite after each source slice; loopback transport tests require an unsandboxed rerun if sandbox binding returns `EPERM`.
- Never post review decisions as comments and never bypass native task-start approvals.
- Never allow an empty or unverified wake context to mean all-project authority.
- Save live logs under `/tmp` and analyze them from files.
- After adapter changes: build, restart Paperclip, verify `packages/orchestrator/dist/index.js` in startup logs, and allow one fleet-reconciliation heartbeat before live testing.
- Do not approve MAZ-1533 during the approval-gate verification phase.

---

### Task 1: Model authoritative heartbeat scope as an exhaustive state machine

**Files:**
- Modify: `packages/orchestrator/src/core/heartbeat-project-scope.ts`
- Modify: `packages/orchestrator/test/heartbeat-project-scope.test.ts`

**Interfaces:**
- Consumes: invocation `runId`, current orchestrator `agentId`, invocation context, and a raw heartbeat run record.
- Produces: `HeartbeatScopeAuthorityDecision`, an exhaustive union of `resolved` and `invalid`; `resolved.reference` remains compatible with `resolveHeartbeatProjectSelection`.

- [ ] **Step 1: Run repository preflight and blast-radius checks**

Run:

```bash
./scripts/adkw doctor
./scripts/adkw blast-radius parseHeartbeatScopeReference
./scripts/adkw blast-radius executeAllProjects
```

Expected: preflight succeeds, or any index warning is recorded without replacing source-backed analysis.

- [ ] **Step 2: Replace the current narrow parser cases with a parameterized authority matrix**

Add table-driven cases equivalent to:

```ts
it.each([
  {
    name: "scoped run snapshot overrides omitted invocation scope",
    runId: "run-1",
    agentId: "orch-1",
    invocation: { companyId: "company-1" },
    run: {
      id: "run-1",
      agentId: "orch-1",
      contextSnapshot: {
        wakeSource: "on_demand",
        wakeReason: "paperclip-orchestrator-scope/v1/project/project-b",
      },
    },
    expected: { kind: "resolved", reference: { kind: "project", projectId: "project-b" } },
  },
  {
    name: "real timer is the only all-project authority",
    runId: "run-1",
    agentId: "orch-1",
    invocation: {},
    run: {
      id: "run-1",
      agentId: "orch-1",
      contextSnapshot: { source: "scheduler", reason: "interval_elapsed" },
    },
    expected: { kind: "resolved", reference: { kind: "unscoped_timer" } },
  },
  {
    name: "unscoped on-demand wake fails closed",
    runId: "run-1",
    agentId: "orch-1",
    invocation: {},
    run: {
      id: "run-1",
      agentId: "orch-1",
      contextSnapshot: { wakeSource: "on_demand", wakeReason: "manual" },
    },
    expected: { kind: "invalid", reason: "unscoped_on_demand" },
  },
  {
    name: "run identity mismatch fails closed",
    runId: "run-1",
    agentId: "orch-1",
    invocation: {},
    run: { id: "run-2", agentId: "orch-1", contextSnapshot: {} },
    expected: { kind: "invalid", reason: "run_identity_mismatch" },
  },
  {
    name: "agent identity mismatch fails closed",
    runId: "run-1",
    agentId: "orch-1",
    invocation: {},
    run: { id: "run-1", agentId: "other", contextSnapshot: {} },
    expected: { kind: "invalid", reason: "agent_identity_mismatch" },
  },
  {
    name: "conflicting explicit scopes fail closed",
    runId: "run-1",
    agentId: "orch-1",
    invocation: { projectId: "project-a" },
    run: { id: "run-1", agentId: "orch-1", contextSnapshot: { projectId: "project-b" } },
    expected: { kind: "invalid", reason: "scope_conflict" },
  },
] as const)("$name", ({ runId, agentId, invocation, run, expected }) => {
  expect(classifyAuthoritativeHeartbeatScope({ runId, agentId, invocationContext: invocation, run })).toEqual(expected);
});
```

Also cover: missing run ID, non-object/missing `contextSnapshot`, malformed reserved envelope, direct issue scope, direct approval scope, and matching duplicated evidence.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- heartbeat-project-scope.test.ts
```

Expected: FAIL because `classifyAuthoritativeHeartbeatScope` and the new invalid reasons do not exist.

- [ ] **Step 4: Implement the minimal discriminated unions and classifier**

Implement these public shapes:

```ts
export type HeartbeatScopeAuthorityInvalidReason =
  | "missing_run_id"
  | "invalid_run_record"
  | "run_identity_mismatch"
  | "agent_identity_mismatch"
  | "missing_context_snapshot"
  | "malformed_explicit_scope"
  | "unscoped_on_demand"
  | "missing_timer_evidence"
  | "scope_conflict";

export type HeartbeatScopeAuthorityDecision =
  | { readonly kind: "resolved"; readonly reference: HeartbeatScopeReference }
  | { readonly kind: "invalid"; readonly reason: HeartbeatScopeAuthorityInvalidReason };

export interface HeartbeatRunScopeRecord {
  readonly id?: unknown;
  readonly agentId?: unknown;
  readonly contextSnapshot?: unknown;
}

export function classifyAuthoritativeHeartbeatScope(input: {
  readonly runId: string | null | undefined;
  readonly agentId: string;
  readonly invocationContext: Readonly<Record<string, unknown>>;
  readonly run: HeartbeatRunScopeRecord;
}): HeartbeatScopeAuthorityDecision;
```

Classification order must be: validate identities → parse authoritative explicit scope → reject malformed/on-demand-without-scope → recognize positive timer evidence → compare any explicit invocation scope → return resolved or conflict. An empty object is `missing_timer_evidence`, never `unscoped_timer`.

- [ ] **Step 5: Run focused and complete tests**

Run:

```bash
pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- heartbeat-project-scope.test.ts
pnpm --filter @pilleo/paperclip-orchestrator-adapter test
```

Expected: focused matrix passes; complete suite remains green. If loopback tests fail only with `listen EPERM`, rerun the same complete suite with the required local-network permission and require 90/90 files to pass.

- [ ] **Step 6: Commit the pure state-machine slice**

```bash
git add packages/orchestrator/src/core/heartbeat-project-scope.ts packages/orchestrator/test/heartbeat-project-scope.test.ts
git commit -m "fix(orchestrator): classify authoritative heartbeat scope"
```

---

### Task 2: Add a typed heartbeat-run lookup to the Paperclip client

**Files:**
- Modify: `packages/orchestrator/src/core/paperclip-http.ts`
- Modify: `packages/orchestrator/test/paperclip-http.test.ts`

**Interfaces:**
- Consumes: canonical Paperclip heartbeat run ID.
- Produces: `getHeartbeatRun<T = unknown>(runId: string): Promise<T>` using `GET /api/heartbeat-runs/:runId` and existing authentication/error semantics.

- [ ] **Step 1: Write the failing client contract test**

```ts
it("loads the authoritative heartbeat run by encoded id", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    id: "run/1",
    agentId: "orch-1",
    contextSnapshot: { projectId: "project-b" },
  }), { status: 200 }));
  globalThis.fetch = fetchMock as typeof fetch;
  const pc = createPaperclipHttp({ apiUrl: "http://127.0.0.1:3100", authToken: "token", runId: "run/1" });

  await expect(pc.getHeartbeatRun("run/1")).resolves.toMatchObject({ id: "run/1" });
  expect(fetchMock).toHaveBeenCalledWith(
    "http://127.0.0.1:3100/api/heartbeat-runs/run%2F1",
    expect.objectContaining({ method: "GET" }),
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- paperclip-http.test.ts
```

Expected: FAIL because `getHeartbeatRun` is absent.

- [ ] **Step 3: Add the minimal client method**

```ts
async getHeartbeatRun<T = unknown>(runId: string): Promise<T> {
  return getJson<T>(`/api/heartbeat-runs/${encodeURIComponent(runId)}`);
},
```

Do not catch 404 or authorization failures here; authoritative scope lookup must surface them so execution can fail closed.

- [ ] **Step 4: Run focused and complete tests**

```bash
pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- paperclip-http.test.ts
pnpm --filter @pilleo/paperclip-orchestrator-adapter test
```

Expected: all tests pass.

- [ ] **Step 5: Commit the HTTP slice**

```bash
git add packages/orchestrator/src/core/paperclip-http.ts packages/orchestrator/test/paperclip-http.test.ts
git commit -m "feat(orchestrator): read authoritative heartbeat runs"
```

---

### Task 3: Gate project enumeration on authoritative scope

**Files:**
- Modify: `packages/orchestrator/src/server/execute.ts:168`
- Modify: `packages/orchestrator/test/execute-projects.test.ts`

**Interfaces:**
- Consumes: `classifyAuthoritativeHeartbeatScope`, `PaperclipHttp.getHeartbeatRun`, `context.runId`, and `context.agent.id`.
- Produces: `executeAllProjects` that returns before `listProjects` or `runProject` when scope authority is invalid.

- [ ] **Step 1: Add integration tests for the observed fan-out and failure paths**

Add tests with URL-sensitive fetch fixtures:

```ts
it("recovers omitted invocation scope from the authoritative run and runs one project", async () => {
  globalThis.fetch = vi.fn(async (input) => {
    const url = String(input);
    if (url.endsWith("/api/heartbeat-runs/run-scoped")) {
      return new Response(JSON.stringify({
        id: "run-scoped",
        agentId: "orchestrator",
        contextSnapshot: {
          wakeSource: "on_demand",
          wakeReason: "paperclip-orchestrator-scope/v1/project/project-b",
        },
      }), { status: 200 });
    }
    if (url.includes("/api/companies/company-1/projects")) {
      return new Response(JSON.stringify([
        { id: "project-a", primaryWorkspace: { cwd: process.cwd() } },
        { id: "project-b", primaryWorkspace: { cwd: "/tmp" } },
      ]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const runProject = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "ok" }));
  const result = await executeAllProjects(scopedContext("run-scoped", {}), runProject);

  expect(result.exitCode).toBe(0);
  expect(runProject).toHaveBeenCalledOnce();
  expect((runProject.mock.calls[0]![0].context as Record<string, unknown>)["projectId"]).toBe("project-b");
});
```

Add separate cases asserting `runProject` and `/projects` are never called when: run lookup returns 404/500, run ID mismatches, agent ID mismatches, authoritative scope conflicts with invocation scope, or an on-demand run has no scope. Add one positive timer case proving only positive scheduler evidence runs all projects.

- [ ] **Step 2: Run the focused integration test and verify RED**

```bash
pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- execute-projects.test.ts
```

Expected: the observed-case test reports two project calls, and invalid cases incorrectly enumerate projects.

- [ ] **Step 3: Resolve authority before listing projects**

Refactor the beginning of `executeAllProjects` to follow this sequence:

```ts
const rawContext = (context.context as Record<string, unknown> | undefined) ?? {};
const runId = context.runId?.trim() || process.env["PAPERCLIP_RUN_ID"]?.trim() || "";
const agentId = context.agent?.id?.trim() || "";
const pc = createPaperclipHttp({ apiUrl, authToken, runId: runId || undefined, localTrustedBoardWrites: true });

let authority: HeartbeatScopeAuthorityDecision;
try {
  const run = runId ? await pc.getHeartbeatRun<HeartbeatRunScopeRecord>(runId) : {};
  authority = classifyAuthoritativeHeartbeatScope({
    runId,
    agentId,
    invocationContext: rawContext,
    run,
  });
} catch (error: unknown) {
  return failedScopeResult(context, `authoritative_run_lookup_failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (authority.kind === "invalid") {
  return failedScopeResult(context, `invalid_heartbeat_scope:${authority.reason}`);
}
```

Only after this block may the function call `listProjects`. Pass
`authority.reference` to `resolveHeartbeatProjectSelection`; do not parse the
raw invocation context a second time. Log one concise scope line containing the
run ID, decision kind, and selected project/reference, without credentials or
the entire context snapshot.

- [ ] **Step 4: Preserve direct test execution without restoring the unsafe default**

Existing unit fixtures that intentionally call `executeProject` remain
unchanged. Existing `executeAllProjects` tests must provide a heartbeat run
response. Do not add `NODE_ENV`, missing-run, or test-only bypasses to
production code.

- [ ] **Step 5: Run focused, complete, build, and ADK guards**

```bash
pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- execute-projects.test.ts
pnpm --filter @pilleo/paperclip-orchestrator-adapter test
pnpm --filter @pilleo/paperclip-orchestrator-adapter build
./scripts/adkw guard packages/orchestrator/src/core/heartbeat-project-scope.ts --stage test
./scripts/adkw guard packages/orchestrator/src/server/execute.ts --stage delivery
```

Expected: 90/90 orchestrator test files and 611+ tests pass; TypeScript and ADK guards pass.

- [ ] **Step 6: Commit the execution gate**

```bash
git add packages/orchestrator/src/server/execute.ts packages/orchestrator/test/execute-projects.test.ts
git commit -m "fix(orchestrator): fail closed before project fan-out"
```

---

### Task 4: Make the canary and documentation describe the complete compatibility contract

**Files:**
- Modify: `packages/orchestrator/scripts/e2e-real-project-canary.ts`
- Modify: `packages/orchestrator/README.md:124`
- Modify: `docs/superpowers/specs/2026-09-17-authoritative-heartbeat-scope-design.md` only if implementation names differ from the approved interfaces.

**Interfaces:**
- Consumes: `EXPLICIT_PROJECT_WAKE_REASON_PREFIX` and the existing disposable project ID.
- Produces: one project-scoped on-demand wake carrying both the compatibility reason envelope and `payload.projectId`.

- [ ] **Step 1: Add a pure canary wake-request builder test**

Move request construction into `buildCanaryOrchestratorWake(projectId, runKey)` in `real-e2e-canary-fixture.ts`, then test:

```ts
expect(buildCanaryOrchestratorWake("project-1", "run-1")).toEqual({
  source: "on_demand",
  reason: "paperclip-orchestrator-scope/v1/project/project-1",
  idempotencyKey: "real-project-canary:project-1:run-1",
  payload: { projectId: "project-1" },
});
```

- [ ] **Step 2: Run the fixture test and verify RED**

```bash
pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- real-e2e-canary-fixture.test.ts
```

Expected: FAIL because the builder does not exist.

- [ ] **Step 3: Implement and use the builder**

The script must call the builder rather than duplicating the envelope. Update
the README to state that the run record—not the invocation context or payload—is
authoritative, and retain the upstream removal condition.

- [ ] **Step 4: Run focused and complete verification**

```bash
pnpm --filter @pilleo/paperclip-orchestrator-adapter test -- real-e2e-canary-fixture.test.ts
pnpm --filter @pilleo/paperclip-orchestrator-adapter test
pnpm --filter @pilleo/paperclip-orchestrator-adapter build
git diff --check
```

Expected: all checks pass and the script compiles.

- [ ] **Step 5: Commit canary and documentation**

```bash
git add packages/orchestrator/src/core/real-e2e-canary-fixture.ts packages/orchestrator/test/real-e2e-canary-fixture.test.ts packages/orchestrator/scripts/e2e-real-project-canary.ts packages/orchestrator/README.md docs/superpowers/specs/2026-09-17-authoritative-heartbeat-scope-design.md
git commit -m "test(orchestrator): verify scoped real canary wake"
```

---

### Task 5: Reload and verify the approval gate against MAZ-1533

**Files:**
- Runtime evidence only: `/tmp/paperclip-authoritative-scope-*.json` and `/tmp/paperclip-authoritative-scope-*.log`

**Interfaces:**
- Consumes: existing company `8f4ef932-d769-43b2-981a-d273ed715162`, disposable project `7af1570b-2285-41a8-ae44-045cf7a4f3f0`, orchestrator `f9bf7329-0649-4c0d-bfe0-680cfd9e8c9a`, and chain MAZ-1533/1534/1535.
- Produces: one pending native task-start approval for MAZ-1533, with no task assignment or execution.

- [ ] **Step 1: Capture the precondition snapshot**

Save the three issues, their approvals, and active orchestrator runs to `/tmp`.
Require MAZ-1533/1534/1535 to be `todo`, unassigned, without
`executionRunId`; require no active orchestrator run before waking. If any
precondition differs, stop and diagnose rather than rewriting live state.

- [ ] **Step 2: Reload the adapter correctly**

```bash
pnpm --filter @pilleo/paperclip-orchestrator-adapter build
systemctl --user restart paperclip-server-3100.service
```

Save the fresh journal to `/tmp` and require explicit lines for:

```text
packages/orchestrator/dist/index.js
Server listening on 127.0.0.1:3100
```

Allow one ordinary heartbeat to reconcile the fleet, then wait until the
orchestrator has no queued/running run.

- [ ] **Step 3: Send exactly one project-scoped wake**

POST one wake whose reason is:

```text
paperclip-orchestrator-scope/v1/project/7af1570b-2285-41a8-ae44-045cf7a4f3f0
```

Use a unique idempotency key and `payload.projectId` with the same ID. Record
the returned heartbeat run ID. Do not send an issue-scoped wake because
Paperclip rejects it before adapter execution for an unassigned issue.

- [ ] **Step 4: Monitor the run-specific evidence and contain divergence**

Poll the run at short intervals while it is active. Its adapter log must emit
one authoritative scope line for only the disposable project. If it logs any
other project workspace, cancel that exact heartbeat run immediately and mark
the acceptance test failed. Do not wake it again until a new failing test
reproduces that divergence.

- [ ] **Step 5: Verify approval-only state**

Require all of the following after the run finishes:

```text
MAZ-1533.status == todo
MAZ-1533.assigneeAgentId == null
MAZ-1533.executionRunId == null
exactly one pending task_start approval references MAZ-1533
MAZ-1534 and MAZ-1535 remain todo, unassigned, and without executionRunId
no task_start approval exists for MAZ-1534 or MAZ-1535
```

Also compare run-attributed logs against the precondition snapshot and require
zero unrelated issue mutations from this heartbeat.

- [ ] **Step 6: Run final repository verification**

```bash
pnpm --filter @pilleo/paperclip-orchestrator-adapter test
pnpm --filter @pilleo/paperclip-orchestrator-adapter build
pnpm fleet:doctor
git diff --check
git status --short
```

Expected: tests/build/doctor pass; only planned files are changed or committed;
no generated logs, secrets, `.vibe`, or runtime data are tracked.

- [ ] **Step 7: Commit the plan and any final documentation correction**

```bash
git add docs/superpowers/plans/2026-09-17-authoritative-heartbeat-scope.md docs/superpowers/specs/2026-09-17-authoritative-heartbeat-scope-design.md
git commit -m "docs(orchestrator): plan authoritative heartbeat scoping"
```

Do not approve MAZ-1533 in this task. Approval and downstream execution are a
separate live checkpoint after this plan proves the gate itself is correct.
