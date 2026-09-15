import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { assertProjectBackedGitWorkspace } from "../src/core/real-e2e-project-contract.js";
import { buildDisposableCanaryBootstrapIssue } from "../src/core/real-e2e-canary-fixture.js";

const execFileAsync = promisify(execFile);
const apiUrl = process.env["PAPERCLIP_TEST_API_URL"]?.replace(/\/+$/, "");
const repoOwner = process.env["PAPERCLIP_E2E_GITHUB_OWNER"] || "Pilleo";

type Json = Record<string, any> | any[] | null;

async function request(pathname: string, method: string, body?: unknown): Promise<Json> {
  if (!apiUrl) throw new Error("PAPERCLIP_TEST_API_URL is required");
  const response = await fetch(`${apiUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) as Json : null;
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${text}`);
  return value;
}

function object(value: Json, label: string): Record<string, any> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} was not an object`);
  return value;
}

async function main(): Promise<void> {
  if (process.env["PAPERCLIP_REAL_E2E"] !== "1") {
    throw new Error("Refusing real-provider canary; set PAPERCLIP_REAL_E2E=1 explicitly");
  }
  if (!apiUrl || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(apiUrl)) {
    throw new Error(`PAPERCLIP_TEST_API_URL must be a loopback Paperclip server, got ${apiUrl || "missing"}`);
  }

  const suffix = `${Date.now()}-${process.pid}`;
  const repoName = `paperclip-adapters-e2e-${suffix}`;
  const fullRepo = `${repoOwner}/${repoName}`;
  // Paperclip clones project workspaces non-interactively. Register the SSH
  // remote explicitly so the canary exercises the same credential path used
  // by this workstation; an HTTPS URL would fall back to askpass and fail
  // after the project has already been created.
  const repoUrl = `ssh://git@github.com/${fullRepo}.git`;
  const seed = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-real-e2e-seed-"));
  let companyId = "";
  let repoCreated = false;
  try {
    await fs.writeFile(path.join(seed, "package.json"), JSON.stringify({ name: repoName, private: true, scripts: { test: "node --test" } }, null, 2) + "\n");
    await fs.writeFile(path.join(seed, "canary.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('canary', () => assert.equal(2 + 2, 4));\n");
    await fs.writeFile(path.join(seed, ".github-workflow.yml"), "canary fixture\n");
    await execFileAsync("git", ["init", "--initial-branch=master"], { cwd: seed });
    await execFileAsync("git", ["config", "user.email", "paperclip-e2e@example.invalid"], { cwd: seed });
    await execFileAsync("git", ["config", "user.name", "Paperclip E2E"], { cwd: seed });
    await execFileAsync("git", ["add", "."], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", "chore: seed disposable canary repository"], { cwd: seed });
    await execFileAsync("gh", ["repo", "create", fullRepo, "--private", "--source", seed, "--remote", "origin", "--push"]);
    repoCreated = true;

    const company = object(await request("/api/companies", "POST", { name: `Real E2E ${suffix}` }), "company");
    companyId = String(company["id"] || "");
    if (!companyId) throw new Error("Paperclip did not return a company id");
    const project = object(await request(`/api/companies/${companyId}/projects`, "POST", {
      name: `Disposable project ${suffix}`,
      description: "Real-provider E2E project; repository ownership is intentionally project-backed.",
    }), "project");
    const projectId = String(project["id"] || "");
    if (!projectId) throw new Error("Paperclip did not return a project id");
    await request(`/api/projects/${projectId}/workspaces`, "POST", {
      name: repoName,
      sourceType: "git_repo",
      repoUrl,
      repoRef: "master",
      defaultRef: "master",
      isPrimary: true,
    });
    const projects = await request(`/api/companies/${companyId}/projects`, "GET");
    const projectRecord = (Array.isArray(projects) ? projects : []).find((candidate) => candidate?.id === projectId);
    const contract = assertProjectBackedGitWorkspace(projectRecord, repoUrl, "master");
    if (!contract.ok) throw new Error(`Paperclip project did not own the canary repository: ${contract.reason}`);
    const orchestrator = object(await request(`/api/companies/${companyId}/agents`, "POST", {
      name: "Disposable E2E Orchestrator",
      role: "ceo",
      adapterType: "orchestrator",
      adapterConfig: { apiUrl, reconcileFleet: true, maxConcurrentJules: 1, maxConcurrentVibe: 0 },
      permissions: { canAssignTasks: true, canCreateAgents: true, canCreateSkills: true, trustPreset: "standard" },
    }), "orchestrator agent");
    const jules = object(await request(`/api/companies/${companyId}/agents`, "POST", {
      name: "Disposable E2E Jules",
      role: "engineer",
      adapterType: "jules",
      reportsTo: orchestrator["id"],
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 900, maxConcurrentRuns: 1 } },
      metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" },
    }), "Jules agent");
    const bootstrap = object(await request(
      `/api/companies/${companyId}/issues`,
      "POST",
      buildDisposableCanaryBootstrapIssue(projectId),
    ), "bootstrap issue");
    const issueA = object(await request(`/api/companies/${companyId}/issues`, "POST", {
      title: "Canary: implement deterministic arithmetic helper",
      description: "---\norchestrator_managed: true\ncomponent: \"core\"\ntarget_files: [\"add.js\", \"add.test.js\"]\n---\n\nAdd a tiny exported arithmetic helper and a behavioral test. Work only in the declared files.",
      projectId,
      status: "todo",
      priority: "high",
    }), "issue A");
    const issueB = object(await request(`/api/companies/${companyId}/issues`, "POST", {
      title: "Canary: extend arithmetic helper",
      description: "---\norchestrator_managed: true\ncomponent: \"core\"\ntarget_files: [\"add.js\", \"add.test.js\"]\n---\n\nExtend the helper after the first canary task is complete. Work only in the declared files.",
      projectId,
      status: "todo",
      priority: "medium",
    }), "issue B");
    const wake = object(await request(`/api/agents/${orchestrator["id"]}/wakeup`, "POST", {
      source: "on_demand",
      reason: "real_project_canary",
      idempotencyKey: `real-project-canary:${companyId}:orchestrator-bootstrap`,
      // The issue is the Paperclip-owned project binding. A projectId nested
      // in payload is not consumed by Paperclip's workspace resolver.
      payload: { issueId: bootstrap["id"], projectId },
    }), "orchestrator wake");
    console.log(JSON.stringify({ companyId, projectId, repo: fullRepo, workspacePath: contract.workspacePath, orchestratorId: orchestrator["id"], julesId: jules["id"], heartbeatRunId: wake["id"], bootstrapIssue: bootstrap["id"], issueA: issueA["id"], issueB: issueB["id"], next: "Approve Task A in Paperclip; the production orchestrator must execute it from this project workspace." }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), companyId, repo: fullRepo, retained: true }, null, 2));
    throw error;
  } finally {
    await fs.rm(seed, { recursive: true, force: true });
    if (companyId && process.env["PAPERCLIP_E2E_KEEP_FAILURE_ARTIFACTS"] !== "1") {
      // Keep the company while debugging provider failures; successful cleanup
      // is performed only by the explicit operator after the full flow passes.
      void repoCreated;
    }
  }
}

main().catch((error) => {
  console.error(`Real project canary failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
