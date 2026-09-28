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
  const post = async (route, body) => {
    const response = await fetch(`${host.url}/api${route}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Native restart fixture POST ${route} failed (${response.status}): ${await response.text()}`);
    return response.json();
  };
  const reviewer = await post(`/companies/${id}/agents`, { name: "Native restart reviewer", role: "qa",
    adapterType: "process", adapterConfig: { command: "true" }, status: "idle",
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
  const issue = await post(`/companies/${id}/issues`, { title: "Persist one addressed native review across host restart",
    description: "Disposable restart contract: the original addressed verdict card remains pending.",
    status: "in_review", assigneeAgentId: null });
  const reviewHead = "a".repeat(40);
  const reviewPrUrl = "https://github.com/paperclip-contract/fixture/pull/1";
  const cardKey = `pr-review:v13:${issue.id}:${reviewPrUrl}:${reviewHead}:luna`;
  const nativeCard = await post(`/issues/${issue.id}/interactions`, { kind: "request_item_verdicts",
    idempotencyKey: cardKey, title: "Review the exact disposable PR head",
    summary: "One card survives a real Paperclip server restart.", addresseeAgentId: reviewer.id,
    continuationPolicy: "none", resolverPolicy: "anyone",
    payload: { version: 1, prompt: "Resolve only this addressed native verdict card.",
      detailsMarkdown: "The review card must retain native attribution across a real process restart.",
      items: [{ id: "pull_request", label: "Pull request", description: "Immutable disposable head" }],
      verdicts: ["approve", "reject"], requireReasonOn: ["reject"],
      reasonLabel: "Reason", allowBulkApprove: true, supersedeOnUserComment: false } });
  assert.equal(nativeCard.status, "pending", "the addressed native card must be durably pending before restart");
  const pendingCardId = nativeCard.id;
  assert.ok(pendingCardId, "a genuine pending native review card must be persisted before process restart");
  const liveBeforeRestart = await fetch(`${host.url}/api/companies/${id}/live-runs?limit=50&minCount=0`);
  assert.equal(liveBeforeRestart.status, 200);
  assert.equal((await liveBeforeRestart.json()).length, 0,
    "restart a pending native review only after every addressed run has settled");
  await host.stop();
  await host.start();
  assert.notEqual(host.pid, firstPid, "a second executor call in one process is not a host restart");
  const companies = await fetch(`${host.url}/api/companies`);
  assert.equal(companies.status, 200);
  assert.ok((await companies.json()).some((company) => company.id === id), "the retained real database must preserve acknowledged company state");
  const recoveredIssue = await fetch(`${host.url}/api/issues/${issue.id}`).then((response) => response.json());
  const cards = await fetch(`${host.url}/api/issues/${issue.id}/interactions`).then((response) => response.json());
  assert.equal(recoveredIssue.status, "in_review");
  assert.equal(recoveredIssue.assigneeAgentId, null);
  assert.equal(cards.length, 1, "restart must neither lose nor duplicate the addressed native review");
  assert.equal(cards[0].id, pendingCardId);
  assert.equal(cards[0].status, "pending");
  assert.equal(cards[0].addresseeAgentId, reviewer.id);
  assert.equal(cards[0].idempotencyKey, cardKey);
  console.log("DISPOSABLE_HOST_RESTART_CONFIRMED", JSON.stringify({ companyId: id,
    issueId: issue.id, pendingCardId, controlPlaneVersion: installedVersion.trim() }));
} finally {
  await host.dispose();
}
