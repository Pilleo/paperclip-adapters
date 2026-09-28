import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { createDisposableHost } from "../../packages/orchestrator/test/contract/disposable-host.mjs";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const worker = `
import http from 'node:http';
import fs from 'node:fs';
const home = process.env.PAPERCLIP_HOME;
const countFile = home + '/starts.txt';
fs.appendFileSync(countFile, process.pid + '\\n');
fs.writeFileSync(home + '/environment.json', JSON.stringify({ apiKey: process.env.JULES_API_KEY, token: process.env.GH_TOKEN }));
if (process.env.IGNORE_TERM === '1') process.on('SIGTERM', () => {});
if (process.env.HANG === '1') setInterval(() => {}, 1000);
else http.createServer((req, res) => { res.writeHead(req.url === '/api/health' ? 200 : 404); res.end('ok'); })
 .listen(Number(process.env.PORT), '127.0.0.1');
`;

test("restart retains the same durable home while using a new owned server process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disposable-host-test-"));
  const script = path.join(root, "server.mjs");
  await writeFile(script, worker);
  const host = createDisposableHost({ root, command: process.execPath, args: [script], port: await freePort(),
    environment: { JULES_API_KEY: "secret-should-not-leak", GH_TOKEN: "secret-should-not-leak" }, readinessTimeoutMs: 3000 });
  try {
    await host.start();
    const first = host.pid;
    assert.equal((await fetch(`${host.url}/api/health`)).status, 200);
    assert.deepEqual(JSON.parse(await readFile(path.join(host.home, "environment.json"), "utf8")), {});
    await host.stop();
    await assert.rejects(fetch(`${host.url}/api/health`, { signal: AbortSignal.timeout(300) }));
    await writeFile(path.join(host.home, "durable-journal.json"), JSON.stringify({ sessionId: "original-session" }));
    await host.start();
    assert.notEqual(host.pid, first);
    assert.deepEqual(JSON.parse(await readFile(path.join(host.home, "durable-journal.json"), "utf8")), { sessionId: "original-session" });
    assert.equal((await readFile(path.join(host.home, "starts.txt"), "utf8")).trim().split("\n").length, 2);
  } finally {
    await host.dispose();
    await assert.rejects(stat(root), { code: "ENOENT" });
  }
});

test("unresponsive server is killed before removing its home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disposable-host-unresponsive-"));
  const script = path.join(root, "server.mjs");
  await writeFile(script, worker);
  const host = createDisposableHost({ root, command: process.execPath, args: [script], port: await freePort(),
    environment: { IGNORE_TERM: "1" }, readinessTimeoutMs: 3000 });
  try {
    await host.start();
    const pid = host.pid;
    await host.dispose();
    assert.equal(host.pid, null);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await host.dispose();
  }
});

test("readiness timeout terminates the owned process and removes storage on disposal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "disposable-host-timeout-"));
  const script = path.join(root, "server.mjs");
  await writeFile(script, worker);
  const host = createDisposableHost({ root, command: process.execPath, args: [script], port: await freePort(),
    environment: { HANG: "1" }, readinessTimeoutMs: 200 });
  try {
    await assert.rejects(host.start(), /readiness.*timeout/i);
    assert.equal(host.pid, null);
  } finally {
    await host.dispose();
    await assert.rejects(stat(root), { code: "ENOENT" });
  }
});
