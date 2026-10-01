import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createMergeReconciliationMutation, createDependencyReleaseMutation, createApprovalObservationMutation } from "../../packages/orchestrator/test/contract/merge-reconciliation-mutation.mjs";

test("compiled private mutation disables merge completion and restoration leaves repository source intact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "merge-reconciliation-mutation-test-"));
  const workspace = fileURLToPath(new URL("../..", import.meta.url));
  const sourcePath = path.join(workspace, "packages/orchestrator/src/core/pull-request-reconciliation.ts");
  const original = await readFile(sourcePath, "utf8");
  try {
    const mutation = await createMergeReconciliationMutation(root, workspace);
    const modulePath = pathToFileURL(path.join(mutation.packagePath, "dist/core/pull-request-reconciliation.js"));
    const input = { issueId: "source-issue", issueStatus: "in_review", auditAlreadyRecorded: false,
      pullRequest: { number: 1, url: "https://github.com/fixture/repo/pull/1", state: "MERGED", mergedAt: "2026-09-30T12:00:00Z" } };
    const broken = await import(`${modulePath.href}?mutated`);
    assert.equal(broken.decidePullRequestReconciliation(input).action, "NOOP");
    await mutation.restore();
    const restored = await import(`${modulePath.href}?restored`);
    assert.equal(restored.decidePullRequestReconciliation(input).action, "COMPLETE_MERGED_PR");
    assert.equal(await readFile(sourcePath, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiled Jules mutation rejects approval observation and restoration confirms it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "approval-observation-mutation-test-"));
  const workspace = fileURLToPath(new URL("../..", import.meta.url));
  const sourcePath = path.join(workspace, "packages/jules/src/server/native-plan-effect-reconciler.ts");
  const original = await readFile(sourcePath, "utf8");
  try {
    const mutation = await createApprovalObservationMutation(root, workspace);
    const modulePath = pathToFileURL(path.join(mutation.packagePath, "dist/server/native-plan-effect-reconciler.js"));
    const effect = { kind: "approve_plan", sessionId: "session", revisionId: "revision" };
    const evidence = { approval: { kind: "same_session_progressed", state: "IN_PROGRESS" } };
    const broken = await import(`${modulePath.href}?mutated`);
    assert.deepEqual(broken.reconcileNativePlanEffect(effect, evidence), { kind: "await_observation" });
    await mutation.restore();
    const restored = await import(`${modulePath.href}?restored`);
    assert.deepEqual(restored.reconcileNativePlanEffect(effect, evidence), { kind: "confirmed", receipt: "provider:IN_PROGRESS" });
    assert.equal(await readFile(sourcePath, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiled dependency mutation holds a done predecessor and restoration releases it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dependency-release-mutation-test-"));
  const workspace = fileURLToPath(new URL("../..", import.meta.url));
  const sourcePath = path.join(workspace, "packages/orchestrator/src/core/dependency-gate.ts");
  const original = await readFile(sourcePath, "utf8");
  try {
    const mutation = await createDependencyReleaseMutation(root, workspace);
    const modulePath = pathToFileURL(path.join(mutation.packagePath, "dist/core/dependency-gate.js"));
    const issue = { blockedBy: [{ id: "predecessor", status: "done" }] };
    const broken = await import(`${modulePath.href}?mutated`);
    assert.equal(broken.evaluateAuthoritativeDependencies(issue).safe, false);
    await mutation.restore();
    const restored = await import(`${modulePath.href}?restored`);
    assert.deepEqual(restored.evaluateAuthoritativeDependencies(issue), { safe: true });
    assert.equal(await readFile(sourcePath, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
