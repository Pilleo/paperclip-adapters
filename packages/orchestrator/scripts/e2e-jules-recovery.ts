import path from "node:path";
import { projectRecoveryCanaryState } from "../src/core/recovery-canary-state.js";

/**
 * Fast, destructive-by-design E2E canary for the Jules open-PR recovery path.
 *
 * It is destructive only inside a newly-created Paperclip company. GitHub and
 * Jules are represented by a temporary `gh` fixture, so this test cannot spend
 * provider quota or mutate a real repository. The explicit API URL guard is
 * intentional: invoking this against the default board must be a conscious
 * choice, not an accidental local default.
 */
const apiUrl = process.env["PAPERCLIP_TEST_API_URL"]?.replace(/\/+$/, "");
const workspacePath = path.resolve(process.env["WORKSPACE_PATH"] || process.cwd());

type Json = Record<string, any> | any[] | null;

async function request(pathname: string, method: string, body?: unknown): Promise<Json> {
  const response = await fetch(`${apiUrl}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let value: Json = null;
  try { value = text ? JSON.parse(text) as Json : null; } catch { value = text as any; }
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${text.slice(0, 500)}`);
  return value;
}

function requireObject(value: Json, label: string): Record<string, any> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} response was not an object`);
  return value;
}

async function main(): Promise<void> {
  if (!apiUrl) throw new Error("PAPERCLIP_TEST_API_URL is required; refusing to run against an implicit board");
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(apiUrl)) {
    throw new Error(`Recovery canary accepts only a loopback Paperclip API, got ${apiUrl}`);
  }
  const health = requireObject(await request("/api/health", "GET"), "health");
  if (health.status !== "ok") throw new Error("Paperclip health check failed");

  let companyId = "";
  let backlogDir = "";
  let fakeGhDir = "";
  const previousPath = process.env["PATH"];
  try {
    const company = requireObject(await request("/api/companies", "POST", { name: `Jules recovery canary ${Date.now()}` }), "company");
    companyId = String(company.id || "");
    if (!companyId) throw new Error("Paperclip did not return a canary company id");

    const project = requireObject(await request(`/api/companies/${companyId}/projects`, "POST", {
      name: `Jules recovery workspace ${Date.now()}`,
      description: "Disposable workspace for the Jules recovery canary",
      workspace: { name: "Canary local workspace", sourceType: "local_path", cwd: workspacePath, isPrimary: true },
    }), "project");
    if (!project.id) throw new Error("Paperclip did not return a canary project id");

    const orch = requireObject(await request(`/api/companies/${companyId}/agents`, "POST", {
      name: "Canary Orchestrator", role: "general", adapterType: "orchestrator",
    }), "orchestrator agent");
    const jules = requireObject(await request(`/api/companies/${companyId}/agents`, "POST", {
      name: "Canary Jules", role: "general", adapterType: "jules", reportsTo: orch.id,
      metadata: { managedBy: "paperclip-orchestrator" },
    }), "Jules agent");
    const vibe = requireObject(await request(`/api/companies/${companyId}/agents`, "POST", {
      name: "Canary Vibe", role: "general", adapterType: "vibe", reportsTo: orch.id,
      metadata: { managedBy: "paperclip-orchestrator" },
    }), "Vibe agent");
    void vibe;
    const key = requireObject(await request(`/api/agents/${orch.id}/keys`, "POST", { name: `canary-${Date.now()}` }), "agent key");
    if (typeof key.token !== "string" || key.token.length < 16) throw new Error("Paperclip did not return a canary agent token");

    backlogDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-jules-recovery-").replace(/\\/g, path.sep));
    const resolvedDir = path.join(backlogDir, "resolved");
    fs.mkdirSync(resolvedDir, { recursive: true });
    const marker = `e2e-jules-recovery-${Date.now()}`;
    const issueFile = path.join(backlogDir, `${marker}.md`);
    fs.writeFileSync(issueFile, `---
title: "${marker}"
severity: "HIGH"
status: "open"
orchestrator_managed: true
priority: high
component: "e2e"
target_modules: [":e2e"]
target_files: ["${marker}.txt"]
target_symbols: []
open_questions: false
---

# Jules recovery canary
`, "utf8");

    const context = {
      authToken: key.token,
      agent: { id: orch.id, companyId, name: "Canary Orchestrator", adapterType: "orchestrator", adapterConfig: {} },
      workspace: { cwd: workspacePath },
      context: { company: { id: companyId } },
      config: {
        apiUrl, backlogDirectory: backlogDir, resolvedDirectory: resolvedDir,
        requireApproval: false, reconcileFleet: false, maxConcurrentJules: 1, maxConcurrentVibe: 1,
        julesAgentId: jules.id, vibeAgentId: vibe.id,
      },
      onLog: async (_stream: string, chunk: string) => process.stdout.write(chunk),
    } as any;

    await execute(context);
    const frontmatter = parseMarkdownFrontmatter<Record<string, unknown>>(fs.readFileSync(issueFile, "utf8"));
    const issueId = String(frontmatter.frontmatter["paperclip_issue_id"] || "");
    if (!issueId) throw new Error("Canary issue was not imported");

    const prUrl = "https://github.com/e2e/paperclip-canary/pull/991";
    await request(`/api/issues/${issueId}/work-products`, "POST", {
      type: "pull_request", provider: "github", title: "Canary Jules PR", url: prUrl,
      externalId: prUrl, status: "ready_for_review", isPrimary: true, metadata: { source: "jules" },
    });
    const childIds: string[] = [];
    for (const markerText of ["jules-session-supervisor", "jules-question-adjudication"]) {
      const child = requireObject(await request(`/api/issues/${issueId}/children`, "POST", {
        title: `${marker} stale child`, description: `${markerText} canary`, status: "todo", priority: "medium",
      }), "child");
      childIds.push(String(child.id));
    }
    await request(`/api/issues/${issueId}`, "PATCH", { status: "in_progress", assigneeAgentId: jules.id });

    fakeGhDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-gh-canary-"));
    const fakeGh = path.join(fakeGhDir, "gh");
    fs.writeFileSync(fakeGh, `#!/bin/sh
case "$*" in
  *"pr list"*) printf '%s\\n' '[{"number":991,"title":"${marker}","state":"OPEN","headRefName":"canary","headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseRefName":"main","mergedAt":null,"url":"${prUrl}","files":[]}]' ;;
  *"pr checks"*) printf '%s\\n' '[{"state":"SUCCESS","bucket":"pass","name":"canary"}]' ;;
  *) exit 1 ;;
esac
`, "utf8");
    fs.chmodSync(fakeGh, 0o755);
    process.env["PATH"] = `${fakeGhDir}${path.delimiter}${previousPath || ""}`;

    await execute(context);
    const recovered = requireObject(await request(`/api/issues/${issueId}`, "GET"), "recovered issue");
    if (recovered.status !== "in_review" || recovered.assigneeAgentId !== null) throw new Error("Canary did not enter native review");
    for (const childId of childIds) {
      const child = requireObject(await request(`/api/issues/${childId}`, "GET"), "stale child");
      if (child.status !== "done") throw new Error(`Stale child ${childId} was not closed`);
    }
    const childrenBefore = childIds.map((id) => id);
    await execute(context);
    const repeated = requireObject(await request(`/api/issues/${issueId}`, "GET"), "repeated issue");
    if (repeated.status !== "in_review" || childrenBefore.length !== childIds.length) throw new Error("Canary recovery was not idempotent");
    console.log("Jules recovery canary passed: recovery, cleanup, and repeat-heartbeat idempotency verified.");
  } finally {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    if (fakeGhDir) fs.rmSync(fakeGhDir, { recursive: true, force: true });
    if (backlogDir) fs.rmSync(backlogDir, { recursive: true, force: true });
    if (companyId) await request(`/api/companies/${companyId}`, "DELETE").catch(() => null);
  }
}

main().catch((error: unknown) => {
  console.error("Jules recovery canary failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
