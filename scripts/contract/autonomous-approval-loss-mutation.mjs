import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createApprovalObservationMutation } from "../../packages/orchestrator/test/contract/merge-reconciliation-mutation.mjs";

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "paperclip-approval-loss-mutation-"));
const sourcePath = path.join(workspace, "packages/jules/src/server/native-plan-effect-reconciler.ts");
const original = await readFile(sourcePath, "utf8");
let succeeded = false;
try {
  const mutation = await createApprovalObservationMutation(root, workspace);
  const run = async (label) => {
    let result;
    try {
      result = { ...(await exec(process.execPath, ["packages/orchestrator/test/contract/jules-server-restart.mjs",
        "--autonomous-lost-approval-restart", `--jules-package=${mutation.packagePath}`],
      { cwd: workspace, timeout: 1_800_000, maxBuffer: 32 * 1024 * 1024 })), code: 0 };
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      result = { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
    await writeFile(path.join(root, `${label}.stdout.log`), result.stdout, { mode: 0o600 });
    await writeFile(path.join(root, `${label}.stderr.log`), result.stderr, { mode: 0o600 });
    return result;
  };
  const broken = await run("approval-evidence-ignored");
  assert.equal(broken.code, 1, "ignoring provider approval evidence must fail recovery");
  assert.ok(broken.stdout.includes("AUTONOMOUS_LOST_APPROVAL_UNCERTAIN"));
  assert.ok(broken.stdout.includes("AUTONOMOUS_UNCERTAIN_APPROVAL_RESTART_CONFIRMED"));
  assert.ok(broken.stderr.includes("Timed out waiting for normal scheduling reconciles accepted approval from provider evidence"),
    "only the intended receipt-recovery stall counts as detection");
  assert.ok(!broken.stdout.includes("AUTONOMOUS_LOST_APPROVAL_RECONCILED"));
  console.log("AUTONOMOUS_APPROVAL_LOSS_MUTATION_DETECTED", JSON.stringify({ mutation: "approval-observation-ignored", code: broken.code }));
  await mutation.restore();
  const restored = await run("approval-evidence-restored");
  assert.equal(restored.code, 0, `restored Jules must pass recovery: ${restored.stderr}`);
  assert.ok(restored.stdout.includes("AUTONOMOUS_LOST_APPROVAL_RECONCILED"));
  assert.ok(restored.stdout.includes("AUTONOMOUS_HUMAN_MERGE_WAIT_RESTART_CONFIRMED"));
  assert.equal(await readFile(sourcePath, "utf8"), original, "repository production source must remain unchanged");
  console.log("AUTONOMOUS_APPROVAL_LOSS_MUTATION_RESTORED", JSON.stringify({ restored: true, repositorySourceUnchanged: true }));
  succeeded = true;
} finally {
  if (succeeded) await rm(root, { recursive: true, force: true });
  else console.error(`Approval-loss mutation failed; private evidence retained at ${root}`);
}
