import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Compile the real package with one behavioural defect, exclusively in an owned private copy. */
export async function createMergeReconciliationMutation(root, workspace) {
  return createPrivateMutation(root, workspace, "pull-request-reconciliation.ts",
    'if (input.pullRequest.state === "MERGED") {',
    'if (input.pullRequest.state === "MERGED" && Number.isNaN(0)) {');
}

export async function createDependencyReleaseMutation(root, workspace) {
  return createPrivateMutation(root, workspace, "dependency-gate.ts",
    'if (status !== "done" && status !== "cancelled") {', 'if (status !== "cancelled") {');
}

async function createPrivateMutation(root, workspace, file, guard, changed) {
  assert.ok(path.isAbsolute(root) && path.isAbsolute(workspace));
  const originalPackage = path.join(workspace, "packages/orchestrator");
  const packagePath = path.join(root, "packages/orchestrator");
  await mkdir(packagePath, { recursive: true });
  await cp(path.join(originalPackage, "src"), path.join(packagePath, "src"), { recursive: true });
  for (const name of ["package.json", "tsconfig.json"]) await cp(path.join(originalPackage, name), path.join(packagePath, name));
  await symlink(path.join(originalPackage, "node_modules"), path.join(packagePath, "node_modules"), "dir");
  const sourcePath = path.join(packagePath, "src/core", file);
  const original = await readFile(sourcePath, "utf8");
  assert.equal(original.split(guard).length, 2, "mutation requires exactly one known guard");
  const compile = () => exec("pnpm", ["exec", "tsc", "-p", path.join(packagePath, "tsconfig.json"), "--noEmitOnError"],
    { cwd: workspace, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  await writeFile(sourcePath, original.replace(guard, changed));
  await compile();
  return {
    packagePath,
    async restore() { await writeFile(sourcePath, original); await compile(); },
  };
}
