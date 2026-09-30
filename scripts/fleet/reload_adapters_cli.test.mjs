import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./reload_adapters.mjs", import.meta.url));
const companyId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";

test("CLI records drain before systemd restart, verifies both dist packages and fresh heartbeat", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reload-cli-"));
  let draining = false, startedAt = null, expiresAt = null, boot = null;
  const methods = [];
  const server = createServer(async (request, response) => {
    methods.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url === "/__test/restart") { draining = false; startedAt = null; boot = new Date().toISOString(); response.end("{}"); return; }
    if (request.url === "/api/instance/task-drain") {
      if (request.method === "POST") {
        let body = ""; for await (const part of request) body += part;
        draining = true; startedAt = new Date().toISOString(); expiresAt = new Date(Date.now() + JSON.parse(body).ttlMs).toISOString();
        response.end(JSON.stringify({ startedAt, expiresAt })); return;
      }
      response.end(JSON.stringify({ draining, startedAt, expiresAt, activeRuns: 0, pendingWakes: 0, quiescent: true })); return;
    }
    if (request.url === "/api/companies") { response.end(JSON.stringify([{ id: companyId }])); return; }
    if (request.url.includes("/live-runs")) { response.end("[]"); return; }
    if (request.url === "/api/health") { response.end('{"status":"ok"}'); return; }
    if (request.url.includes("/heartbeat-runs")) { response.end(JSON.stringify([{ id: "new-heartbeat", companyId, agentId,
      status: "succeeded", startedAt: boot, finishedAt: boot }])); return; }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const systemctl = path.join(dir, "systemctl"), journalctl = path.join(dir, "journalctl");
    await writeFile(systemctl, `#!/usr/bin/env node\nfetch('${base}/__test/restart',{method:'POST'}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1));\n`);
    await writeFile(journalctl, `#!/usr/bin/env node\nconsole.log('Loading external adapter package ${fileURLToPath(new URL("../../packages/orchestrator/dist/index.js", import.meta.url))}');\nconsole.log('Loading external adapter package ${fileURLToPath(new URL("../../packages/jules/dist/index.js", import.meta.url))}');\n`);
    await chmod(systemctl, 0o700); await chmod(journalctl, 0o700);
    const journal = path.join(dir, "receipts.jsonl");
    const { stdout } = await exec(process.execPath, [script, "--journal", journal,
      "--reconcile-company", companyId, "--reconcile-agent", agentId, "--wait-seconds", "1"], {
      timeout: 20_000, env: { ...process.env, PAPERCLIP_API_URL: base, PATH: `${dir}:${process.env.PATH}` },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.reconciliation.runId, "new-heartbeat");
    const receipts = (await readFile(journal, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(receipts.findIndex((entry) => entry.event === "drain_started") < receipts.findIndex((entry) => entry.event === "restart_intent"));
    assert.equal(receipts.at(-1).event, "reload_verified");
    assert.equal(methods.some((method) => method.startsWith("DELETE")), false);
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI rejects a remote API before any administrative effect", async () => {
  await assert.rejects(exec(process.execPath, [script, "--journal", "/tmp/unused-reload-receipt.jsonl",
    "--reconcile-company", companyId, "--reconcile-agent", agentId], {
    timeout: 10_000, env: { ...process.env, PAPERCLIP_API_URL: "https://example.test" },
  }), /loopback/);
});
