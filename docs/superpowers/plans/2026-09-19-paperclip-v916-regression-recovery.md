# Paperclip v2026.916.0 Regression Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the adapters against unpatched Paperclip `v2026.916.0`, reconcile managed agents without 409 conflicts or redaction-driven write loops, and prove the autonomous review path on unit, integration, and live E2E evidence.

**Architecture:** Keep Paperclip on the upstream release and move compatibility behavior into `paperclip-adapters`. Extract fleet drift calculation into a pure typed decision module: identity changes, visible configuration changes, and hidden/redacted configuration changes are represented separately. Persist only a SHA-256 fingerprint of the complete desired managed configuration in agent metadata, conditionally send identity fields, and retain fail-closed handling for real authorization or mutation failures.

**Tech Stack:** TypeScript 5.7, Vitest, pnpm workspaces, Paperclip HTTP API, embedded PostgreSQL, Node `crypto`.

**Spec:** This plan is the recovery specification; it is based on live heartbeat `f61ab0ce-14b3-4c6e-b17e-18ad2f0a397c` and Paperclip release `v2026.916.0`.

## Global Constraints

- Paperclip production runtime must be based on upstream tag `v2026.916.0`; do not replay the old local server patch wholesale.
- Preserve `backup/pre-v2026.916.0-20260919` until the complete live canary passes.
- Do not use Git worktrees.
- Use TDD: demonstrate each regression with a failing test before changing implementation.
- Run existing focused tests after every source slice and the complete adapter suites before live verification.
- Never post a review decision as a normal comment or provider message; only resolve the addressed native Paperclip verdict card.
- Never use squash merges.
- Do not compare or persist plaintext secret values; metadata may contain only a one-way desired-configuration digest.
- Do not claim completion until two consecutive live heartbeats are free of fleet 401/403/409 errors and a disposable native-review canary reaches merge approval.

## Review Focus

- An existing agent with the desired name but stale configuration must be updated without sending `name` and without triggering Paperclip's self-shortname 409.
- Redacted or omitted `adapterConfig.env` must not cause a write on every heartbeat once the desired fingerprint is recorded.
- A genuine managed-agent rename must still send `name`; an unrelated agent already owning that shortname must fail loudly rather than mutate the wrong agent.
- A rejected PATCH (401, 403, 409, or 5xx) must not advance the stored fingerprint or report a successful reconciliation.
- Local-trusted requests must omit bearer authorization while remote Paperclip requests retain it and both preserve `X-Paperclip-Run-Id`.

---

### Task 1: Return Paperclip Master to the Upstream Release Contract

**Files:**
- Modify in `/home/leanid/Documents/code/java/paperclip`: `packages/shared/package.json`
- Verify: `/home/leanid/Documents/code/java/paperclip/package.json`
- Verify: `/home/leanid/Documents/code/java/paperclip/server/src/index.ts`

**Interfaces:**
- Consumes: upstream tag `v2026.916.0`, merge commit `56a9f7133`, backup branch `backup/pre-v2026.916.0-20260919`.
- Produces: local `master` whose source differs from the tag only by an explicit merge/history record, not runtime patches.

- [x] **[100%] Step 1: Record the exact remaining Paperclip delta**

  Run:

  ```bash
  git -C /home/leanid/Documents/code/java/paperclip diff --name-status v2026.916.0..master
  git -C /home/leanid/Documents/code/java/paperclip diff v2026.916.0..master -- packages/shared/package.json
  ```

  Expected: only the local `@paperclipai/shared` export-map patch is behaviorally relevant.

- [x] **[100%] Step 2: Establish the release baseline before removing the patch**

  Run:

  ```bash
  pnpm --dir /home/leanid/Documents/code/java/paperclip build
  pnpm --dir /home/leanid/Documents/code/java/paperclip-adapters --filter @pilleo/paperclip-jules-adapter exec vitest run test/package-load.test.ts
  ```

  Expected: both pass on the merged tree, proving the baseline is healthy.

- [x] **[100%] Step 3: Remove the unnecessary local export override**

  Restore `packages/shared/package.json` to the exact `v2026.916.0` content. Do not alter the database, migration journal, or the backup branch.

- [x] **[100%] Step 4: Verify stock-release package loading**

  Re-run the commands from Step 2. Expected: PASS. If package loading fails, stop and retain only the smallest package-export compatibility commit supported by that failure; do not restore the historical server patch.

- [x] **[100%] Step 5: Commit the upstream-clean runtime**

  ```bash
  git -C /home/leanid/Documents/code/java/paperclip add packages/shared/package.json
  git -C /home/leanid/Documents/code/java/paperclip commit -m "chore: align local runtime with Paperclip v2026.916.0"
  ```

---

### Task 2: Reproduce the Paperclip PATCH and Redaction Regressions

**Files:**
- Modify: `packages/orchestrator/test/fleet-manager.test.ts`
- Test: `packages/orchestrator/test/fleet-manager.test.ts`

**Interfaces:**
- Consumes: `reconcileManagedFleet(apiUrl, companyId, config)`.
- Produces: failing contract tests for conditional identity mutation and redacted configuration idempotence.

- [x] **[100%] Step 1: Add a Paperclip-compatible self-shortname test double**

  Add a helper that returns 409 when a PATCH includes `name` equal to the existing agent's name, records successful patch bodies, and returns the patched metadata on the next GET.

  ```ts
  type RecordedPatch = Readonly<{ url: string; body: Readonly<Record<string, unknown>> }>;

  function rejectSelfShortnamePatch(existingName: string, patches: RecordedPatch[]) {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (init?.method === "PATCH" && body["name"] === existingName) {
        return new Response(JSON.stringify({ error: `Agent shortname is already in use` }), { status: 409 });
      }
      if (init?.method === "PATCH") patches.push({ url, body });
      return new Response(JSON.stringify({}), { status: 200 });
    };
  }
  ```

- [x] **[100%] Step 2: Test same-name stale configuration**

  Parameterize Luna and Terra. Return an existing managed reviewer with the desired name and stale model/protocol metadata. Assert one successful PATCH, `body.name === undefined`, and the desired non-identity fields are present.

- [x] **[100%] Step 3: Test redacted environment idempotence**

  First GET returns a reviewer with absent/redacted `adapterConfig.env` and no managed configuration fingerprint. After the first successful PATCH, the second reconciliation returns the persisted fingerprint but still-redacted environment. Assert the first call patches once and the second call performs no mutation.

- [x] **[100%] Step 4: Test genuine rename and failed mutation behavior**

  Add cases asserting:

  ```ts
  expect(renamePatch.body.name).toBe(desiredName);
  expect(result.updatedCount).toBe(0); // when the server rejects the patch
  expect(result.resolvedIds[workerKey]).toBe(existingAgentId);
  ```

- [x] **[100%] Step 5: Run the tests and capture the expected red state**

  ```bash
  pnpm --filter @pilleo/paperclip-orchestrator-adapter exec vitest run test/fleet-manager.test.ts
  ```

  Expected before implementation: same-name tests observe `name` in the PATCH and receive 409; redacted-env test observes a second unnecessary PATCH.

- [x] **[100%] Step 6: Commit tests only**

  ```bash
  git add packages/orchestrator/test/fleet-manager.test.ts
  git commit -m "test(orchestrator): reproduce fleet patch regressions"
  ```

---

### Task 3: Add a Typed Managed-Agent Patch Decision

**Files:**
- Create: `packages/orchestrator/src/core/managed-agent-patch.ts`
- Create: `packages/orchestrator/test/managed-agent-patch.test.ts`
- Modify: `packages/orchestrator/src/core/fleet-manager.ts`

**Interfaces:**
- Consumes: observed managed agent, desired name/title/capabilities/adapter/runtime/metadata configuration.
- Produces:

  ```ts
  export type ManagedAgentPatchDecision =
    | { readonly kind: "unchanged"; readonly desiredFingerprint: string }
    | { readonly kind: "patch"; readonly desiredFingerprint: string; readonly patch: ManagedAgentPatch };

  export function decideManagedAgentPatch(input: ManagedAgentPatchInput): ManagedAgentPatchDecision;
  ```

- [x] **[100%] Step 1: Write parameterized pure-function tests**

  Cover the cross-product below with `it.each`:

  | Name | Visible config | Fingerprint | Expected |
  |---|---|---|---|
  | same | same | current | `unchanged` |
  | same | stale | current | patch without `name` |
  | same | redacted env | current | `unchanged` |
  | same | any | missing/stale | patch without `name` and new fingerprint |
  | different | same | current | patch with `name` |

  Also assert that semantically equal objects with different key insertion order produce the same fingerprint.

- [x] **[100%] Step 2: Run the pure tests red**

  ```bash
  pnpm --filter @pilleo/paperclip-orchestrator-adapter exec vitest run test/managed-agent-patch.test.ts
  ```

  Expected: FAIL because the module does not exist.

- [x] **[100%] Step 3: Implement canonical fingerprinting**

  Recursively sort object keys, preserve array order, JSON-encode the complete desired managed configuration, and hash it with SHA-256. Store only the hex digest as metadata key `managedConfigFingerprint`; never store canonical JSON or secret values.

- [x] **[100%] Step 4: Implement exhaustive patch decisions**

  Build the patch from independently typed drift flags. Add `name` only for `identityDrift === "name_changed"`. Exclude redacted `env` from visible drift comparison and use `managedConfigFingerprint` to detect adapter-owned hidden configuration changes.

- [x] **[100%] Step 5: Integrate the decision into fleet reconciliation**

  Replace the monolithic `needsUpdate` boolean and unconditional body in `fleet-manager.ts`. Keep authorization classification, replacement creation, instruction-bundle writes, and `updatedCount` semantics unchanged.

- [x] **[100%] Step 6: Run focused tests green**

  ```bash
  pnpm --filter @pilleo/paperclip-orchestrator-adapter exec vitest run test/managed-agent-patch.test.ts test/fleet-manager.test.ts test/execute-projects.test.ts test/execute-auth.test.ts
  ```

  Expected: all pass; captured same-name PATCH bodies omit `name`.

- [x] **[100%] Step 7: Commit the typed reconciliation fix**

  ```bash
  git add packages/orchestrator/src/core/managed-agent-patch.ts packages/orchestrator/src/core/fleet-manager.ts packages/orchestrator/test/managed-agent-patch.test.ts packages/orchestrator/test/fleet-manager.test.ts
  git commit -m "fix(orchestrator): make fleet patches identity-safe"
  ```

---

### Task 4: Remove the Misleading Process-Local Single-Flight Workaround

**Files:**
- Modify: `packages/orchestrator/src/core/fleet-manager.ts`
- Modify: `packages/orchestrator/test/fleet-manager.test.ts`
- Test: `packages/orchestrator/test/execute-projects.test.ts`

**Interfaces:**
- Consumes: `executeAllProjects` company heartbeat contract, where exactly one project receives `reconcileFleet: true`.
- Produces: direct async `reconcileManagedFleet` with no process-local correctness claim.

- [x] **[100%] Step 1: Strengthen the company-scope execution test**

  Preserve the existing assertion `reconcileFleet === true` for exactly one runnable project and add a failure-path case proving that all remaining project contexts receive `false` even when the reconciling project returns a failed result.

- [x] **[100%] Step 2: Run the execution test green before removal**

  ```bash
  pnpm --filter @pilleo/paperclip-orchestrator-adapter exec vitest run test/execute-projects.test.ts
  ```

- [x] **[100%] Step 3: Remove `inFlightFleetReconciliations` and its unit test**

  Restore `reconcileManagedFleet` as the direct async implementation. Retain the comment at the caller explaining that company-scoped reconciliation is assigned to one project context by `executeAllProjects`.

- [x] **[100%] Step 4: Re-run focused reconciliation and execution tests**

  ```bash
  pnpm --filter @pilleo/paperclip-orchestrator-adapter exec vitest run test/fleet-manager.test.ts test/managed-agent-patch.test.ts test/execute-projects.test.ts
  ```

- [x] **[100%] Step 5: Commit the cleanup**

  ```bash
  git add packages/orchestrator/src/core/fleet-manager.ts packages/orchestrator/test/fleet-manager.test.ts packages/orchestrator/test/execute-projects.test.ts
  git commit -m "refactor(orchestrator): keep fleet scope at heartbeat boundary"
  ```

---

### Task 5: Document the v2026.916 Compatibility Contract

**Files:**
- Modify: `packages/orchestrator/README.md`
- Modify: `AGENTS.md`
- Modify: `packages/orchestrator/src/core/managed-agent-patch.ts` comments

**Interfaces:**
- Consumes: Paperclip's redacted agent response and shortname uniqueness behavior.
- Produces: maintainer guidance explaining why identity fields are conditional and why metadata fingerprints exist.

- [x] **[100%] Step 1: Document the compatibility rules**

  Record that Paperclip `v2026.916.0` redacts agent environment values, managed configuration uses a digest for idempotence, unchanged names must not be resent, and a failed PATCH never advances reconciliation state.

- [x] **[100%] Step 2: Add source comments at the non-obvious boundary**

  Explain the motivation, not the syntax: Paperclip derives/checks shortnames when `name` is present, and API redaction makes response equality insufficient for hidden fields.

- [x] **[100%] Step 3: Run documentation and secret checks**

  ```bash
  pnpm run check:secrets
  git diff --check
  ```

- [x] **[100%] Step 4: Commit documentation**

  ```bash
  git add AGENTS.md packages/orchestrator/README.md packages/orchestrator/src/core/managed-agent-patch.ts
  git commit -m "docs(orchestrator): explain managed fleet reconciliation"
  ```

---

### Task 6: Run Full Automated Verification

**Files:**
- Verify: all workspace source and tests
- Evidence: `/tmp/paperclip-v916-regression-*.log`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: revision-bound build/test evidence.

- [x] **[100%] Step 1: Run orchestrator tests**

  ```bash
  pnpm --filter @pilleo/paperclip-orchestrator-adapter test > /tmp/paperclip-v916-regression-orchestrator.log 2>&1
  ```

- [x] **[100%] Step 2: Run all adapter tests and build**

  ```bash
  pnpm test > /tmp/paperclip-v916-regression-all-tests.log 2>&1
  pnpm build > /tmp/paperclip-v916-regression-adapters-build.log 2>&1
  ```

- [x] **[100%] Step 3: Run Paperclip release build and focused server contracts**

  ```bash
  pnpm --dir /home/leanid/Documents/code/java/paperclip build > /tmp/paperclip-v916-regression-paperclip-build.log 2>&1
  pnpm --dir /home/leanid/Documents/code/java/paperclip --filter @paperclipai/server test -- heartbeat-retry-scheduling.test.ts heartbeat-stale-queue-invalidation.test.ts > /tmp/paperclip-v916-regression-paperclip-tests.log 2>&1
  ```

- [x] **[100%] Step 4: Validate exact repository states**

  Run `git diff --check`, secret scan, and `git status --short --branch` in both repositories. `.taskplane/` remains untracked runtime state and must not be committed.

---

### Task 7: Verify Two Live Heartbeats and Native Review End to End

**Files:**
- Runtime: `/home/leanid/Documents/code/java/paperclip` on port 3100
- Runtime: adapter `dist/index.js` files
- Evidence: `/tmp/paperclip-v916-live-startup.log`, `/tmp/paperclip-v916-live-heartbeats.log`, `/tmp/paperclip-v916-live-canary.json`

**Interfaces:**
- Consumes: built upstream Paperclip and built adapters.
- Produces: live evidence that reconciliation is idempotent and structured review still works after the release upgrade.

- [x] **[100%] Step 1: Restart Paperclip and verify release startup**

  Confirm port 3100 has one listener, startup reports all migrations applied, and logs show orchestrator, Jules, Vibe, and Antigravity loading from their current `dist/index.js` paths.

- [x] **[100%] Step 2: Trigger one authoritative orchestrator heartbeat**

  Use `scripts/fleet/wake_orchestrator.sh`. Capture the heartbeat run ID and wait on its terminal status rather than sleeping blindly.

- [x] **[100%] Step 3: Verify first-heartbeat migration behavior**

  Assert Luna and Terra configuration PATCHes return 200, same-name bodies do not contain `name`, metadata contains `managedConfigFingerprint`, no plaintext environment values appear in the API response, and logs contain no fleet 401/403/409.

- [x] **[100%] Step 4: Trigger and verify a second heartbeat**

  Assert no Luna/Terra configuration PATCH occurs on the second heartbeat. Jules may reconcile independently only when its own visible desired state differs.

- [ ] **[55%] Step 5: Run a disposable native-review canary**

  Use the existing disposable Paperclip project and repository. Create one minimal approved task through the repository's issue-generation script. Verify this exact chain:

  ```text
  approved task -> Jules plan/card -> implementation PR -> green CI
  -> Luna native verdict -> Terra native verdict -> human merge approval
  ```

  Neither reviewer may emit a free-text verdict, normal issue comment, or GitHub PR comment. The strong reviewer must not start before Luna approves the same immutable PR head.

  Live recovery evidence before the clean canary:

  - `e54432b` reattaches a v2026.916.0 detached Jules monitor while preserving review stages.
  - `68f51c6` reconciles a terminal `jules_polling_error` through Paperclip's typed recovery route.
  - `f0aab42` treats every non-null Paperclip `executionBlocker` as a fail-closed dispatch hold, preventing generic same-tick wakeups from racing the server-owned reconciliation outbox.
  - Legacy MAZ-1535 contained multiple historical no-replay actions created before these guards and was cancelled as a poisoned disposable fixture.
  - Fresh dependency chain MAZ-1543 -> MAZ-1544 -> MAZ-1545 was created in the existing disposable project. All three task-start approvals are pending; no task started before approval.

- [ ] **[0%] Step 6: Verify terminal reconciliation**

  After the operator merges with a standard merge commit, wait for Paperclip to mark the task done, link the merged PR once, avoid duplicate merge reports, and schedule the next dependency-ready task only if it is already approved.

- [ ] **[0%] Step 7: Preserve evidence and retire the backup only later**

  Save run/card/PR identifiers and final statuses in `/tmp/paperclip-v916-live-canary.json`. Keep `backup/pre-v2026.916.0-20260919` until a later cleanup request; successful verification does not itself authorize deleting it.

## Completion Criteria

- Paperclip `master` builds from upstream `v2026.916.0` without the historical runtime patch.
- Focused red tests fail for the original reasons, then pass after the typed patch decision is integrated.
- Complete adapter and Paperclip verification commands pass.
- Two consecutive live heartbeats show no fleet authorization or shortname conflict and the second is mutation-idempotent.
- A disposable task reaches structured Luna approval, structured Terra approval, human merge approval, merge detection, and terminal completion without review spam or free-text verdicts.
