import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { expectedContractVersion, resolveContractHost } from "../../packages/orchestrator/test/contract/host-installation.mjs";

test("only exact baseline and candidate targets can enter qualification", () => {
  assert.equal(expectedContractVersion({}), "2026.916.0");
  assert.equal(expectedContractVersion({ PAPERCLIP_CONTRACT_VERSION: "2026.1001.0" }), "2026.1001.0");
  for (const value of ["latest", "2026.1001", "2026.1001.1", ""]) {
    assert.throws(() => expectedContractVersion({ PAPERCLIP_CONTRACT_VERSION: value }), /Unknown contract host target/);
  }
});

for (const globalLayout of [false, true]) test(`CLI and server must come from the same pinned installation (global=${globalLayout})`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "contract-installation-test-"));
  const nodeModules = path.join(root, globalLayout ? "paperclipai/node_modules" : "node_modules");
  const cliDir = globalLayout ? path.join(root, "paperclipai") : path.join(nodeModules, "paperclipai");
  const serverDir = path.join(nodeModules, "@paperclipai/server");
  await mkdir(serverDir, { recursive: true });
  await mkdir(path.join(cliDir, "dist"), { recursive: true });
  const environment = { PAPERCLIP_CONTRACT_NODE_MODULES: nodeModules, PAPERCLIP_CONTRACT_VERSION: "2026.1001.0" };
  try {
    await writeFile(path.join(serverDir, "package.json"), JSON.stringify({ name: "@paperclipai/server", version: "2026.1001.0" }));
    await writeFile(path.join(cliDir, "package.json"), JSON.stringify({ name: "paperclipai", version: "2026.1001.0", bin: { paperclipai: "dist/index.js" } }));
    await writeFile(path.join(cliDir, "dist/index.js"), "");
    const result = resolveContractHost(environment);
    assert.equal(result.command, process.execPath);
    assert.deepEqual(result.args, [path.join(cliDir, "dist/index.js")]);
    assert.equal(result.version, "2026.1001.0");
    await writeFile(path.join(cliDir, "package.json"), JSON.stringify({ name: "paperclipai", version: "2026.916.0", bin: "dist/index.js" }));
    assert.throws(() => resolveContractHost(environment), /Installed host must match/);
    await writeFile(path.join(serverDir, "package.json"), JSON.stringify({ version: "2026.916.0" }));
    assert.throws(() => resolveContractHost(environment), /Installed host must match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
