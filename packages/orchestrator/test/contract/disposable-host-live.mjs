/** Opt-in, installed-host restart contract. Never connects to an implicit Paperclip board. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createDisposableHost } from "./disposable-host.mjs";

const { stdout: installedVersion } = await promisify(execFile)("paperclipai", ["--version"], { timeout: 10_000 });
assert.match(installedVersion, /^2026\.916\.0\b/, "qualify another host version separately");
const root = await mkdtemp(path.join(tmpdir(), "paperclip-real-restart-contract-"));
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const host = createDisposableHost({ root, command: "paperclipai", args: ["onboard", "--config", path.join(root, "home", "config.json"),
  "--data-dir", path.join(root, "home"), "--bind", "loopback", "--yes", "--no-install-service"],
port, readinessTimeoutMs: 60_000 });
try {
  await host.start();
  const firstPid = host.pid;
  const created = await fetch(`${host.url}/api/companies`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Disposable persistent restart contract" }) });
  if (created.status !== 201) throw new Error(`Company creation failed (${created.status}): ${await created.text()}`);
  const { id } = await created.json();
  assert.equal(typeof id, "string");
  await host.stop();
  await host.start();
  assert.notEqual(host.pid, firstPid, "a second executor call in one process is not a host restart");
  const companies = await fetch(`${host.url}/api/companies`);
  assert.equal(companies.status, 200);
  assert.ok((await companies.json()).some((company) => company.id === id), "the retained real database must preserve acknowledged company state");
  console.log("DISPOSABLE_HOST_RESTART_CONFIRMED", JSON.stringify({ companyId: id, controlPlaneVersion: installedVersion.trim() }));
} finally {
  await host.dispose();
}
