import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createConflictPolicyMutation, createConflictReviewMutation } from "../../packages/orchestrator/test/contract/conflict-recovery-mutation.mjs";

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "paperclip-conflict-mutations-"));
for (const [name, factory, mode, failure, source] of [
  ["manual-bypass", createConflictPolicyMutation, "manual", "manual_conflict_wait_bypassed_into_merge_gate", "core/conflict-recovery.ts"],
  ["review-restart", createConflictReviewMutation, "agent", "conflict repair must not create additional native review cards", "core/conflict-review-continuity.ts"],
]) {
  const originalPath = path.join(workspace, "packages/orchestrator/src", source);
  const original = await readFile(originalPath, "utf8");
  const mutation = await factory(path.join(root, name), workspace);
  const qualify = async (label) => {
    let result;
    try {
      result = { ...(await exec(process.execPath, ["packages/orchestrator/test/contract/conflict-recovery-live.mjs",
        `--conflict-recovery-mode=${mode}`, "--repair-agent-adapter=process", `--orchestrator-package=${mutation.packagePath}`],
      { cwd: workspace, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })), code: 0 };
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    await writeFile(path.join(root, `${name}-${label}.stdout.log`), result.stdout, { mode: 0o600 });
    await writeFile(path.join(root, `${name}-${label}.stderr.log`), result.stderr, { mode: 0o600 });
    return result;
  };
  const broken = await qualify("broken");
  assert.equal(broken.code, 1);
  assert.ok(broken.stderr.includes(failure), `Wrong failure boundary for ${name}: ${broken.stderr.slice(-4000)}`);
  console.log("CONFLICT_MUTATION_DETECTED", JSON.stringify({ name, failure }));
  await mutation.restore();
  const restored = await qualify("restored");
  assert.equal(restored.code, 0, restored.stderr.slice(-4000));
  assert.ok(restored.stdout.includes("CONFLICT_RECOVERY_CONFIRMED"));
  assert.equal(await readFile(originalPath, "utf8"), original);
  console.log("CONFLICT_MUTATION_RESTORED", JSON.stringify({ name, fullWorkflow: true, sourceUnchanged: true, root }));
}
