import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDependencyReleaseMutation } from "../../packages/orchestrator/test/contract/merge-reconciliation-mutation.mjs";

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "paperclip-autonomous-merge-mutation-"));
const reducerPath = path.join(workspace, "packages/orchestrator/src/core/dependency-gate.ts");
const original = await readFile(reducerPath, "utf8");
let succeeded = false;
try {
  const mutation = await createDependencyReleaseMutation(root, workspace);
  const run = async (label) => {
    const args = ["packages/orchestrator/test/contract/jules-server-restart.mjs", "--autonomous-dependency",
      `--orchestrator-package=${mutation.packagePath}`];
    let result;
    try {
      result = { ...(await exec(process.execPath, args, { cwd: workspace, timeout: 1_800_000, maxBuffer: 32 * 1024 * 1024 })), code: 0 };
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      result = { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
    await writeFile(path.join(root, `${label}.stdout.log`), result.stdout, { mode: 0o600 });
    await writeFile(path.join(root, `${label}.stderr.log`), result.stderr, { mode: 0o600 });
    return result;
  };
  const broken = await run("done-predecessor-held");
  assert.equal(broken.code, 1, "incorrect dependency admission must fail the full autonomous dependency test");
  for (const witness of ["AUTONOMOUS_PR_PRODUCER_CONFIRMED", "AUTONOMOUS_PR_MERGE_GATE_CONFIRMED",
    "AUTONOMOUS_HUMAN_MERGE_WAIT_RESTART_CONFIRMED", "AUTONOMOUS_USER_MERGE_FIXTURE_PUBLISHED",
    "AUTONOMOUS_USER_MERGE_NATIVE_RECONCILED"]) {
    assert.ok(broken.stdout.includes(witness), `negative case must reach ${witness} before failing`);
  }
  assert.ok(broken.stderr.includes("Timed out waiting for scheduled B dispatch after its native user start approval"),
    "an unrelated transport/setup failure is not mutation detection");
  assert.ok(!broken.stdout.includes("AUTONOMOUS_USER_MERGE_DEPENDENCY_RELEASE_CONFIRMED"));
  console.log("AUTONOMOUS_MERGE_MUTATION_DETECTED", JSON.stringify({ mutation: "done-predecessor-incorrectly-unresolved", code: broken.code }));
  await mutation.restore();
  const restored = await run("restored-dependency-admission");
  assert.equal(restored.code, 0, `restored package must pass: ${restored.stderr}`);
  assert.ok(restored.stdout.includes("AUTONOMOUS_USER_MERGE_DEPENDENCY_RELEASE_CONFIRMED"));
  assert.equal(await readFile(reducerPath, "utf8"), original, "repository production source must remain untouched");
  console.log("AUTONOMOUS_MERGE_MUTATION_RESTORED", JSON.stringify({ restored: true, repositorySourceUnchanged: true }));
  succeeded = true;
} finally {
  if (succeeded) await rm(root, { recursive: true, force: true });
  else console.error(`Mutation qualification failed; private evidence retained at ${root}`);
}
