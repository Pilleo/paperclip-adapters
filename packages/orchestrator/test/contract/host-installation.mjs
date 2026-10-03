import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// An explicit test target is not a claim of compatibility. Only passing reports qualify it.
export function expectedContractVersion(environment = process.env) {
  const version = environment.PAPERCLIP_CONTRACT_VERSION ?? "2026.916.0";
  assert.ok(["2026.916.0", "2026.1001.0"].includes(version), `Unknown contract host target: ${version}`);
  return version;
}

export function assertContractVersion(actual, expected = expectedContractVersion()) {
  assert.equal(actual, expected, "Installed host must match the explicitly selected contract target");
  return actual;
}

/** Resolve the CLI and server from one installation, never from ambient PATH. */
export function resolveContractHost(environment = process.env) {
  const version = expectedContractVersion(environment);
  const nodeModules = path.resolve(environment.PAPERCLIP_CONTRACT_NODE_MODULES ??
    path.join(homedir(), ".paperclip/cli/current/node_modules"));
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  const server = read(path.join(nodeModules, "@paperclipai/server/package.json"));
  assertContractVersion(server.version, version);
  let cliFile = path.join(nodeModules, "paperclipai/package.json");
  let cli;
  try { cli = read(cliFile); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Global npm installs nest the server inside the CLI package's node_modules.
    cliFile = path.join(nodeModules, "../package.json");
    cli = read(cliFile);
  }
  assert.equal(cli.name, "paperclipai", "Contract CLI package identity changed");
  assertContractVersion(cli.version, version);
  const bin = typeof cli.bin === "string" ? cli.bin : cli.bin?.paperclipai;
  assert.equal(typeof bin, "string", "Contract CLI entrypoint missing");
  const cliEntry = realpathSync(path.resolve(path.dirname(cliFile), bin));
  return { version, nodeModules, command: process.execPath, args: [cliEntry] };
}
