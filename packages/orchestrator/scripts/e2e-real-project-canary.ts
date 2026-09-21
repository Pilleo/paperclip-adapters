import process from "node:process";
import { assertProjectBackedGitWorkspace } from "../src/core/real-e2e-project-contract.js";
import { assertAuthoritativeCanaryChain, buildCanaryA, buildCanaryB, buildCanaryC, buildCanaryOrchestratorWake } from "../src/core/real-e2e-canary-fixture.js";
import { parseCanaryIssueSnapshot } from "../src/core/real-e2e-canary-progress.js";
import { assertProjectReadyForCanary, canaryProjectIssuesPath, selectExistingDisposableProject } from "../src/core/real-e2e-project-registry.js";

const apiUrl = process.env["PAPERCLIP_TEST_API_URL"]?.replace(/\/+$/, "");
const companyId = process.env["PAPERCLIP_E2E_COMPANY_ID"];
const repoUrl = process.env["PAPERCLIP_E2E_REPOSITORY_SSH_URL"];
const orchestratorId = process.env["PAPERCLIP_E2E_ORCHESTRATOR_ID"];
const projectId = process.env["PAPERCLIP_E2E_PROJECT_ID"];

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

  if (!companyId || !repoUrl || !orchestratorId || !projectId) throw new Error("PAPERCLIP_E2E_COMPANY_ID, PAPERCLIP_E2E_PROJECT_ID, PAPERCLIP_E2E_REPOSITORY_SSH_URL, and PAPERCLIP_E2E_ORCHESTRATOR_ID are required");
  if (!/^(git@|ssh:\/\/git@)/.test(repoUrl)) throw new Error("PAPERCLIP_E2E_REPOSITORY_SSH_URL must use SSH transport");

  const projects = await request(`/api/companies/${companyId}/projects`, "GET");
  const selection = selectExistingDisposableProject(Array.isArray(projects) ? projects : [], projectId);
  if (selection.kind === "invalid_missing") throw new Error(`Configured disposable project does not exist in this company: ${selection.projectId}`);
  const projectRecord = selection.project;
  const contract = assertProjectBackedGitWorkspace(projectRecord, repoUrl, "master");
  if (!contract.ok) throw new Error(`Disposable project must already own the configured SSH repository: ${contract.reason}`);
  const issues = await request(canaryProjectIssuesPath(companyId, projectId), "GET");
  const readiness = assertProjectReadyForCanary(Array.isArray(issues) ? issues : []);
  if (!readiness.ok) throw new Error(`Previous canary remains nonterminal: ${readiness.blockingIssueIds.join(", ")}`);
  const runKey = `${Date.now()}-${process.pid}`;
  const issueA = object(await request(`/api/companies/${companyId}/issues`, "POST", buildCanaryA(projectId, runKey)), "issue A");
  const issueB = object(await request(`/api/companies/${companyId}/issues`, "POST", buildCanaryB(projectId, runKey, String(issueA["id"]))), "issue B");
  const issueC = object(await request(`/api/companies/${companyId}/issues`, "POST", buildCanaryC(projectId, runKey, String(issueB["id"]))), "issue C");
  const issueADetail = object(await request(`/api/issues/${issueA["id"]}`, "GET"), "issue A detail");
  const issueBDetail = object(await request(`/api/issues/${issueB["id"]}`, "GET"), "issue B detail");
  const issueCDetail = object(await request(`/api/issues/${issueC["id"]}`, "GET"), "issue C detail");
  const chain = assertAuthoritativeCanaryChain(issueADetail, issueBDetail, issueCDetail);
  if (!chain.ok) throw new Error(`Paperclip did not persist native canary blockers: ${chain.reason}`);
  for (const [label, detail] of [["A", issueADetail], ["B", issueBDetail], ["C", issueCDetail]] as const) {
    const snapshot = parseCanaryIssueSnapshot(detail);
    if ("kind" in snapshot) throw new Error(`Paperclip persisted malformed ${label} canary detail: ${snapshot.reason}`);
    if (!snapshot.orchestratorManaged) throw new Error(`Paperclip persisted ${label} as unmanaged despite its canonical task contract`);
  }
  const wake = object(await request(
    `/api/agents/${orchestratorId}/wakeup`,
    "POST",
    buildCanaryOrchestratorWake(projectId, runKey),
  ), "orchestrator wake");
  console.log(JSON.stringify({ companyId, projectId, workspacePath: contract.workspacePath, orchestratorId, heartbeatRunId: wake["id"], issueA: issueA["id"], issueB: issueB["id"], issueC: issueC["id"], next: "Await the three task-scoped approvals created by the orchestrator." }, null, 2));
}

main().catch((error) => {
  console.error(`Real project canary failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
