import { open, readFile, stat } from "node:fs/promises";
import process from "node:process";
import { assertProjectBackedGitWorkspace } from "../src/core/real-e2e-project-contract.js";
import { buildCanaryOrchestratorWake } from "../src/core/real-e2e-canary-fixture.js";
import { buildStressIssue, stressPilotTasks, stressTasks, validateStressPilotTasks, validateStressTasks } from "../src/core/stress-campaign-manifest.js";
import { assertStressProjectReadyForRun, assertStressReadback, selectStressProject, STRESS_PROJECT_MARKER, stressIssueDecision } from "../src/core/stress-campaign-receipts.js";

type JsonObject = Record<string, unknown>;
type Mode = "--dry-run" | "--provision" | "--create" | "--activate" | "--wake";
const REPO = "ssh://git@github.com/Pilleo/paperclip-adapters-e2e-20260923-vanilla-review.git";
const OLD_PROJECT_ID = "d53718c7-90c3-462b-b8bb-4ff7d54fa37e";
const API = process.env["PAPERCLIP_TEST_API_URL"]?.replace(/\/+$/, "");
const COMPANY = process.env["PAPERCLIP_E2E_COMPANY_ID"];
const ORCHESTRATOR = process.env["PAPERCLIP_E2E_ORCHESTRATOR_ID"];
const JOURNAL = process.env["PAPERCLIP_STRESS_JOURNAL_DIR"];
const PROJECT_ID = process.env["PAPERCLIP_STRESS_PROJECT_ID"];
const CAMPAIGN_KIND = process.env["PAPERCLIP_STRESS_KIND"] ?? "full";

function tasksForRun(runKey: string): ReturnType<typeof stressTasks> {
  if (CAMPAIGN_KIND === "pilot") return stressPilotTasks(runKey);
  if (CAMPAIGN_KIND === "full") return stressTasks(runKey);
  throw new Error(`Unknown PAPERCLIP_STRESS_KIND ${CAMPAIGN_KIND}`);
}

function record(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label} response`);
  return value as JsonObject;
}

function list(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label} list`);
  return value.map((item) => record(item, label));
}

async function request(path: string, method = "GET", body?: unknown): Promise<unknown> {
  if (!API || !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(API)) throw new Error("Loopback PAPERCLIP_TEST_API_URL is required");
  const response = await fetch(`${API}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) as unknown : null;
}

async function journal(runKey: string, event: string, identity: JsonObject): Promise<void> {
  if (!JOURNAL || !JOURNAL.startsWith("/tmp/") || !JOURNAL.endsWith("/")) {
    throw new Error("PAPERCLIP_STRESS_JOURNAL_DIR must be an existing owner-only /tmp/ directory ending with /");
  }
  const directory = await stat(JOURNAL);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) {
    throw new Error("Stress journal directory must be owned by this user with no group/other permissions");
  }
  const file = await open(`${JOURNAL}paperclip-stress-${runKey}.jsonl`, "a", 0o600);
  try {
    await file.writeFile(`${JSON.stringify({ time: new Date().toISOString(), runKey, event, ...identity })}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function hasIntent(runKey: string, event: string, task?: string): Promise<boolean> {
  if (!JOURNAL || !JOURNAL.startsWith("/tmp/") || !JOURNAL.endsWith("/")) throw new Error("Owner-only stress journal required");
  let contents: string;
  try {
    contents = await readFile(`${JOURNAL}paperclip-stress-${runKey}.jsonl`, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  return contents.trim().split("\n").some((line) => {
    const entry = record(JSON.parse(line) as unknown, "journal entry");
    return entry["runKey"] === runKey && entry["event"] === event && (task === undefined || entry["task"] === task);
  });
}

async function projects(): Promise<JsonObject[]> {
  return list(await request(`/api/companies/${COMPANY}/projects`), "projects");
}

async function projectForRun(runKey: string): Promise<JsonObject> {
  const result = selectStressProject(await projects(), runKey, PROJECT_ID);
  if (result.kind !== "found") throw new Error(`Expected one provisioned campaign project: ${result.kind}`);
  return result.project as JsonObject;
}

async function requirePreviousRunsTerminal(projectId: string, runKey: string): Promise<void> {
  const issues = await issueList(projectId);
  if (issues.length >= 200) throw new Error("Project issue list reached its bounded read limit; previous run cannot be verified");
  const readiness = assertStressProjectReadyForRun(issues, runKey);
  if (!readiness.ok) throw new Error(`Previous stress run has unfinished nonterminal issues: ${readiness.blockingIssueIds.join(",")}`);
}

function idOf(item: JsonObject, label: string): string {
  const id = item["id"];
  if (typeof id !== "string" || !id) throw new Error(`Missing ${label} ID`);
  return id;
}

async function issueList(projectId: string): Promise<JsonObject[]> {
  return list(await request(`/api/companies/${COMPANY}/issues?projectId=${encodeURIComponent(projectId)}&limit=200`), "project issues");
}

async function detail(issueId: string): Promise<JsonObject> {
  return record(await request(`/api/issues/${encodeURIComponent(issueId)}`), `issue ${issueId}`);
}

async function existingIssue(projectId: string, task: ReturnType<typeof stressTasks>[number], expected: JsonObject, allowedStatus: "backlog" | "todo" | "either" = "backlog"): Promise<string | null> {
  const matches = (await issueList(projectId)).filter((issue) => issue["title"] === expected["title"] ||
    (typeof issue["description"] === "string" &&
      issue["description"].includes(`<!-- paperclip-adapters:stress-run:${task.runKey} -->`) &&
      issue["description"].includes(`<!-- paperclip-adapters:stress-task:${task.key} -->`)));
  const hydrated = await Promise.all(matches.map(async (issue) => detail(idOf(issue, "candidate issue"))));
  const decision = stressIssueDecision(hydrated, task, expected, allowedStatus);
  if (decision.kind === "stop") throw new Error(`Conflicting campaign issue ${task.key}: ${decision.reason}`);
  return decision.kind === "resume" ? decision.issueId : null;
}

async function provision(runKey: string): Promise<void> {
  if (!COMPANY) throw new Error("PAPERCLIP_E2E_COMPANY_ID is required");
  const selection = selectStressProject(await projects(), runKey, PROJECT_ID);
  if (selection.kind === "invalid") throw new Error(`Cannot provision: ${selection.reason}`);
  let project = selection.kind === "found" ? selection.project as JsonObject : undefined;
  if (!project) {
    if (PROJECT_ID) throw new Error("Explicit stress project does not exist; refusing to create a replacement");
    if (await hasIntent(runKey, "project_create_intent")) throw new Error("Unresolved project creation intent; inspect the exact prior POST before continuing");
    await journal(runKey, "project_create_intent", { companyId: COMPANY });
    try {
      project = record(await request(`/api/companies/${COMPANY}/projects`, "POST", {
        name: `Disposable stress [stress:${runKey}]`, description: `${STRESS_PROJECT_MARKER}\nRun ${runKey}: isolated twenty-PR dependency campaign`,
      }), "created project");
    } catch (error) {
      const recovered = selectStressProject(await projects(), runKey);
      if (recovered.kind !== "found") throw error;
      project = recovered.project as JsonObject;
    }
  }
  const projectId = idOf(project, "project");
  project = await projectForRun(runKey);
  await requirePreviousRunsTerminal(projectId, runKey);
  await journal(runKey, "project_identity", { projectId });
  const workspacePath = `/api/projects/${encodeURIComponent(projectId)}/workspaces`;
  const existing = list(await request(workspacePath), "workspaces").filter((item) => item["isPrimary"] === true);
  if (existing.length > 1) throw new Error("Ambiguous campaign primary workspace");
  if (existing.length === 0) {
    if (await hasIntent(runKey, "workspace_create_intent")) throw new Error("Unresolved workspace creation intent; inspect the exact prior POST before continuing");
    await journal(runKey, "workspace_create_intent", { projectId });
    try {
      await request(workspacePath, "POST", {
        name: "Stress campaign managed checkout", sourceType: "git_repo", repoUrl: REPO, defaultRef: "master", isPrimary: true,
      });
    } catch (error) {
      const recovered = list(await request(workspacePath), "workspaces").filter((item) => item["isPrimary"] === true);
      if (recovered.length !== 1 || recovered[0]?.["sourceType"] !== "git_repo" ||
          recovered[0]?.["repoUrl"] !== REPO || recovered[0]?.["defaultRef"] !== "master") throw error;
    }
  } else if (existing[0]?.["sourceType"] !== "git_repo" || existing[0]?.["repoUrl"] !== REPO || existing[0]?.["defaultRef"] !== "master") {
    throw new Error("Campaign primary workspace differs from approved Git repository/ref");
  }
  const updated = await projectForRun(runKey);
  const contract = assertProjectBackedGitWorkspace(updated, REPO, "master");
  if (!contract.ok) throw new Error(`Campaign project git checkout: ${contract.reason}`);
  const old = (await projects()).find((item) => item["id"] === OLD_PROJECT_ID);
  const oldCodebase = old?.["codebase"];
  if (!old || !oldCodebase || typeof oldCodebase !== "object" || contract.workspacePath === (oldCodebase as JsonObject)["effectiveLocalFolder"]) {
    throw new Error("Campaign checkout not isolated from the historical v2 project");
  }
  await journal(runKey, "workspace_verified", { projectId, workspacePath: contract.workspacePath });
  console.log(JSON.stringify({ runKey, projectId, workspacePath: contract.workspacePath, stage: "provisioned" }));
}

async function verifiedGraph(runKey: string, allowed: "backlog" | "backlog_or_todo" | "todo"): Promise<{ projectId: string; ids: Map<string, string> }> {
  const project = await projectForRun(runKey);
  const projectId = idOf(project, "project");
  await requirePreviousRunsTerminal(projectId, runKey);
  const tasks = tasksForRun(runKey);
  const found = new Map<string, string>();
  for (const task of tasks) {
    const predecessorIds = task.predecessors.map((key) => {
      const predecessor = found.get(key);
      if (!predecessor) throw new Error(`Missing predecessor ${key}`);
      return predecessor;
    });
    const expected = buildStressIssue(task, projectId, predecessorIds);
    const issueId = await existingIssue(projectId, task, expected, allowed === "backlog_or_todo" ? "either" : allowed);
    if (!issueId) throw new Error(`Missing task ${task.key}`);
    const observed = await detail(issueId);
    const status = observed["status"];
    if (status !== "backlog" && (status !== "todo" || allowed === "backlog")) throw new Error(`Unexpected task ${task.key} status ${String(status)}`);
    if (allowed === "todo" && status !== "todo") throw new Error(`Task ${task.key} has not been activated`);
    assertStressReadback(task, expected, observed, status);
    found.set(task.key, issueId);
  }
  const marked = (await issueList(projectId)).filter((issue) => typeof issue["description"] === "string" &&
    issue["description"].includes(`<!-- paperclip-adapters:stress-run:${runKey} -->`));
  if (marked.length !== tasks.length || new Set(marked.map((issue) => issue["id"])).size !== tasks.length) throw new Error("Campaign does not contain exactly its uniquely marked tasks");
  return { projectId, ids: found };
}

async function create(runKey: string): Promise<void> {
  const project = await projectForRun(runKey);
  const projectId = idOf(project, "project");
  if (!assertProjectBackedGitWorkspace(project, REPO, "master").ok) throw new Error("Campaign project workspace is not qualified");
  await requirePreviousRunsTerminal(projectId, runKey);
  const ids = new Map<string, string>();
  for (const task of tasksForRun(runKey)) {
    const predecessorIds = task.predecessors.map((key) => {
      const id = ids.get(key);
      if (!id) throw new Error(`Missing predecessor ${key}`);
      return id;
    });
    const expected = buildStressIssue(task, projectId, predecessorIds);
    let issueId = await existingIssue(projectId, task, expected);
    if (!issueId) {
      if (await hasIntent(runKey, "issue_create_intent", task.key)) throw new Error(`Unresolved task ${task.key} creation intent; inspect prior POST before continuing`);
      await journal(runKey, "issue_create_intent", { projectId, task: task.key });
      try {
        const posted = record(await request(`/api/companies/${COMPANY}/issues`, "POST", expected), `created task ${task.key}`);
        issueId = idOf(posted, `task ${task.key}`);
      } catch (error) {
        issueId = await existingIssue(projectId, task, expected);
        if (!issueId) throw error;
      }
    }
    assertStressReadback(task, expected, await detail(issueId));
    ids.set(task.key, issueId);
    await journal(runKey, "issue_verified", { task: task.key, issueId, predecessorIds });
  }
  await verifiedGraph(runKey, "backlog");
  console.log(JSON.stringify({ runKey, projectId, stage: `${ids.size}_backlog_issues_verified`, issues: Object.fromEntries(ids) }));
}

async function activate(runKey: string): Promise<void> {
  const { projectId, ids } = await verifiedGraph(runKey, "backlog_or_todo");
  for (const [key, issueId] of ids) {
    const observed = await detail(issueId);
    if (observed["status"] === "backlog") {
      if (await hasIntent(runKey, "issue_activate_intent", key)) throw new Error(`Unresolved task ${key} activation intent; inspect prior PATCH before continuing`);
      await journal(runKey, "issue_activate_intent", { task: key, issueId });
      try {
        await request(`/api/issues/${encodeURIComponent(issueId)}`, "PATCH", { status: "todo" });
      } catch (error) {
        if ((await detail(issueId))["status"] !== "todo") throw error;
      }
    }
    if ((await detail(issueId))["status"] !== "todo") throw new Error(`Task ${key} did not activate to todo`);
    await journal(runKey, "issue_activated", { task: key, issueId });
  }
  await verifiedGraph(runKey, "todo");
  console.log(JSON.stringify({ runKey, projectId, stage: `${ids.size}_issues_activated` }));
}

async function wake(runKey: string): Promise<void> {
  if (!ORCHESTRATOR) throw new Error("PAPERCLIP_E2E_ORCHESTRATOR_ID is required");
  const { projectId } = await verifiedGraph(runKey, "todo");
  if (!JOURNAL || !JOURNAL.startsWith("/tmp/") || !JOURNAL.endsWith("/")) throw new Error("Owner-only journal directory required");
  if (await hasIntent(runKey, "wake_intent")) throw new Error("Campaign wake intent already exists; inspect the exact run before another wake");
  await journal(runKey, "wake_intent", { projectId });
  const result = record(await request(`/api/agents/${ORCHESTRATOR}/wakeup`, "POST", buildCanaryOrchestratorWake(projectId, runKey)), "orchestrator wake");
  const runId = idOf(result, "orchestrator run");
  await journal(runKey, "wake_receipt", { projectId, runId });
  console.log(JSON.stringify({ runKey, projectId, stage: "waiting_for_user_start_approvals", runId }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modes: readonly Mode[] = ["--dry-run", "--provision", "--create", "--activate", "--wake"];
  const mode = args.find((arg): arg is Mode => modes.includes(arg as Mode));
  const keyAt = args.indexOf("--run-key");
  const runKey = keyAt >= 0 ? args[keyAt + 1] : undefined;
  if (!mode || !runKey || args.length !== 3 || (keyAt !== 0 && keyAt !== 1) || args.filter((arg) => modes.includes(arg as Mode)).length !== 1) {
    throw new Error("Usage: stress-campaign-create.ts --dry-run|--provision|--create|--activate|--wake --run-key <safe-key>");
  }
  const tasks = tasksForRun(runKey);
  const validated = CAMPAIGN_KIND === "pilot" ? validateStressPilotTasks(tasks) : validateStressTasks(tasks);
  if (!validated.ok) throw new Error(`Invalid stress campaign: ${validated.reason}`);
  if (mode === "--dry-run") {
    console.log(JSON.stringify({ runKey, graph: tasks.map((task) => ({ key: task.key, predecessors: task.predecessors, implementationFile: task.implementationFile, testFile: task.testFile, description: buildStressIssue(task, "dry-run-project", task.predecessors)["description"] })) }, null, 2));
    return;
  }
  if (!COMPANY || !JOURNAL) throw new Error("PAPERCLIP_E2E_COMPANY_ID and PAPERCLIP_STRESS_JOURNAL_DIR are required for writes");
  switch (mode) {
    case "--provision": return provision(runKey);
    case "--create": return create(runKey);
    case "--activate": return activate(runKey);
    case "--wake": return wake(runKey);
    default: throw new Error(`Unknown operation ${mode}`);
  }
}

main().catch((error) => {
  console.error(`Stress campaign creation stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
