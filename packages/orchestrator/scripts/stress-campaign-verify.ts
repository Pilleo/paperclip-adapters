import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";
import { parseChildPlanReviewDescription } from "@pilleo/paperclip-adapter-common";
import { resolveGitHubCliExecutable } from "../src/core/github-sync.js";
import { stressTasks } from "../src/core/stress-campaign-manifest.js";
import { evaluateStressProgress, type StressIssueEvidence, type StressReviewEvidence } from "../src/core/stress-campaign-progress.js";
import { parsePrReviewChildDescription } from "../src/core/pr-review-child.js";
import { parseJulesPrHandoffHandle } from "../src/core/pr-handoff-registration.js";

const exec = promisify(execFile);
const API = process.env["PAPERCLIP_TEST_API_URL"]?.replace(/\/+$/, "");
const COMPANY = process.env["PAPERCLIP_E2E_COMPANY_ID"];
const REPO = "Pilleo/paperclip-adapters-e2e-20260923-vanilla-review";
type Row = Record<string, unknown>;

function row(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label} response`);
  return value as Row;
}

function array(value: unknown, label: string): Row[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label} list`);
  return value.map((item) => row(item, label));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

async function get(path: string): Promise<unknown> {
  if (!API || !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(API)) throw new Error("Loopback PAPERCLIP_TEST_API_URL is required");
  const response = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(30_000) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status})`);
  return raw ? JSON.parse(raw) as unknown : null;
}

async function readGh(args: readonly string[]): Promise<Row> {
  const { stdout } = await exec(resolveGitHubCliExecutable(), [...args], { timeout: 15_000 });
  return row(JSON.parse(stdout) as unknown, "GitHub");
}

async function github(url: string, headSha: string): Promise<StressIssueEvidence["github"]> {
  const match = /^https:\/\/github\.com\/Pilleo\/paperclip-adapters-e2e-20260923-vanilla-review\/pull\/([1-9]\d*)$/i.exec(url);
  if (!match || !/^[a-f0-9]{40}$/i.test(headSha)) throw new Error("PR URL or head is not the declared disposable repository's immutable commit");
  const pr = await readGh(["pr", "view", url, "--json", "state,headRefOid,mergedAt,mergeCommit"]);
  const merge = pr["mergeCommit"] && typeof pr["mergeCommit"] === "object" ? row(pr["mergeCommit"], "merge commit") : null;
  const mergeSha = text(merge?.["oid"]);
  let parents: string[] = [];
  if (pr["state"] === "MERGED") {
    if (!mergeSha || !/^[a-f0-9]{40}$/i.test(mergeSha)) throw new Error("Merged PR has no GitHub merge commit");
    const commit = await readGh(["api", `repos/${REPO}/git/commits/${mergeSha}`]);
    if (!Array.isArray(commit["parents"])) throw new Error("Merged PR has no authoritative GitHub parents");
    parents = commit["parents"].map((parent: unknown) => {
      const sha = text(row(parent, "merge parent")["sha"]);
      if (!sha) throw new Error("Malformed merge parent SHA");
      return sha;
    });
  }
  return { state: text(pr["state"]) ?? "unknown", headSha: text(pr["headRefOid"]) ?? "missing",
    mergedAt: text(pr["mergedAt"]), parents };
}

async function resolvedReview(child: Row, identity: {
  readonly reviewerAgentId: string; readonly stage: string; readonly parentIssueId: string;
  readonly bootstrapAgentId: string; readonly sessionId?: string; readonly headSha?: string;
}): Promise<StressReviewEvidence | null> {
  const childId = text(child["id"]);
  if (!childId || child["parentId"] !== identity.parentIssueId) throw new Error("Native reviewer child has inconsistent parent identity");
  const cards = array(await get(`/api/issues/${encodeURIComponent(childId)}/interactions`), "native reviewer cards")
    .filter((card) => card["kind"] === "request_item_verdicts" && card["status"] === "answered");
  if (cards.length === 0) return null;
  if (cards.length !== 1) throw new Error(`Duplicate answered native reviewer cards for child ${childId}`);
  const card = cards[0]!;
  const result = row(card["result"], "native verdict result");
  const items = array(result["items"], "native verdict items");
  if (items.length !== 1 || card["addresseeAgentId"] !== identity.reviewerAgentId) throw new Error("Native verdict was not addressed to its reviewer");
  const verdict = text(items[0]?.["verdict"]);
  const runId = text(card["resolvedByRunId"]);
  if (!runId || items[0]?.["resolvedByRunId"] !== runId) throw new Error("Native verdict has no exact addressed run attribution");
  const run = row(await get(`/api/heartbeat-runs/${encodeURIComponent(runId)}`), "reviewer run");
  const context = row(run["contextSnapshot"], "reviewer run scope");
  const sourceRunId = text(card["sourceRunId"]);
  if (!sourceRunId) throw new Error("Native verdict has no source run");
  const source = row(await get(`/api/heartbeat-runs/${encodeURIComponent(sourceRunId)}`), "source run");
  const sourceContext = row(source["contextSnapshot"], "source run scope");
  if (run["id"] !== runId || run["agentId"] !== identity.reviewerAgentId || context["issueId"] !== childId ||
      source["status"] !== "succeeded" || source["agentId"] !== identity.bootstrapAgentId || sourceContext["issueId"] !== childId) {
    throw new Error("Native review run identity is not scoped to its reviewer child");
  }
  return { stage: identity.stage, verdict: verdict ?? "missing", runStatus: text(run["status"]) ?? "unknown",
    reviewerAgentId: identity.reviewerAgentId, runAgentId: text(run["agentId"]) ?? "missing", runIssueId: text(context["issueId"]) ?? "missing",
    childId, cardId: text(card["id"]) ?? "missing", runId,
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
    ...(identity.headSha ? { headSha: identity.headSha } : {}) };
}

function approvalFor(approvals: readonly Row[], issueId: string, action: string): StressIssueEvidence["startApproval"] {
  const matched = approvals.filter((approval) => {
    const payload = approval["payload"];
    return payload && typeof payload === "object" && !Array.isArray(payload) &&
      (payload as Row)["issueId"] === issueId && (payload as Row)["action"] === action;
  });
  if (action === "task_start" && matched.length > 1) throw new Error(`Duplicate ${action} approvals for ${issueId}`);
  if (action === "task_merge") {
    const pending = matched.filter((approval) => approval["status"] === "pending");
    if (pending.length > 1) throw new Error(`Duplicate pending merge gates for ${issueId}`);
    if (pending.length === 1) return "pending";
    const approved = matched.filter((approval) => approval["status"] === "approved");
    if (approved.length > 1) throw new Error(`Duplicate approved merge gates for ${issueId}`);
    if (approved.length === 1) return "approved";
  }
  const status = matched[0]?.["status"];
  return status === "pending" || status === "approved" || status === "rejected" ? status : "missing";
}

async function collectIssue(key: string, issueId: string, expectedBlockers: readonly string[], approvals: readonly Row[]): Promise<StressIssueEvidence> {
  const issue = row(await get(`/api/issues/${encodeURIComponent(issueId)}`), `campaign task ${key}`);
  if (issue["id"] !== issueId || issue["projectId"] === null) throw new Error(`Malformed campaign task ${key}`);
  const blockers = array(issue["blockedBy"], "native blockers").map((blocker) => text(blocker["id"]) ?? "invalid");
  if (blockers.length !== expectedBlockers.length || blockers.some((id) => !expectedBlockers.includes(id))) throw new Error(`Campaign task ${key} has invalid native blockers`);
  const products = array(issue["workProducts"], "work products").filter((product) => product["type"] === "pull_request" && product["isPrimary"] === true);
  const product = products[0];
  const metadata = product?.["metadata"] && typeof product["metadata"] === "object" ? row(product["metadata"], "work product metadata") : null;
  const headSha = text(metadata?.["headSha"]);
  const url = text(product?.["url"]);
  const recordedProductSessionId = text(metadata?.["providerSessionId"]);
  const normalized = product && url && headSha ? { url, headSha, status: text(product["status"]) ?? "unknown" } : null;
  if (products.length && !normalized) throw new Error(`Campaign task ${key} has incomplete PR product metadata`);
  const docs = array(await get(`/api/issues/${encodeURIComponent(issueId)}/documents`), "issue documents");
  const sessions = docs.filter((doc) => doc["key"] === "jules-session");
  if (sessions.length > 1) throw new Error(`Campaign task ${key} has duplicate Jules session documents`);
  const startedAt = text(sessions[0]?.["createdAt"]);
  const handle = sessions[0] ? parseJulesPrHandoffHandle(sessions[0]["body"]) : null;
  if (handle && normalized && (handle.prUrl.replace(/\/$/, "") !== normalized.url.replace(/\/$/, "") ||
      handle.headSha !== normalized.headSha)) throw new Error(`Campaign task ${key} session handle does not bind its primary PR head`);
  if (handle && recordedProductSessionId && handle.sessionId !== recordedProductSessionId) {
    throw new Error(`Campaign task ${key} work-product session differs from the original session document`);
  }
  const providerSessionId = handle?.sessionId ?? recordedProductSessionId;
  const children = array(await get(`/api/companies/${COMPANY}/issues?limit=1000&parentId=${encodeURIComponent(issueId)}`), "review children");
  const planReviews: StressReviewEvidence[] = [];
  const prReviews: StressReviewEvidence[] = [];
  for (const child of children) {
    const plan = parseChildPlanReviewDescription(child["description"]);
    const pr = parsePrReviewChildDescription(child["description"]);
    if (plan && plan.parentIssueId === issueId && plan.sessionId === providerSessionId) {
      if (child["createdByAgentId"] !== plan.bootstrapAgentId || plan.companyId !== COMPANY) throw new Error("Plan child provenance mismatch");
      const resolved = await resolvedReview(child, plan);
      if (resolved?.verdict === "approve") planReviews.push({ ...resolved, stage: `${plan.revisionNumber}:${plan.stage}` });
    }
    if (pr && pr.parentIssueId === issueId && pr.prUrl === url && pr.headSha === headSha) {
      if (pr.companyId !== COMPANY || child["createdByAgentId"] !== (pr.version === 2 ? null : pr.bootstrapAgentId)) throw new Error("PR child provenance mismatch");
      const resolved = await resolvedReview(child, pr);
      if (resolved) prReviews.push(resolved);
    }
  }
  const lastRevision = Math.max(0, ...planReviews.map((review) => Number(review.stage.split(":")[0])));
  const currentPlanReviews = planReviews.filter((review) => review.stage.startsWith(`${lastRevision}:`))
    .map((review) => ({ ...review, stage: review.stage.split(":")[1] ?? "invalid" }));
  return { key, id: issueId, status: text(issue["status"]) ?? "unknown", assigneeAgentId: text(issue["assigneeAgentId"]),
    executionRunId: text(issue["executionRunId"]), blockedBy: blockers,
    startApproval: approvalFor(approvals, issueId, "task_start"),
    mergeApproval: approvalFor(approvals, issueId, "task_merge"),
    executionBlocker: issue["executionBlocker"] ? "historical_execution_blocker" : null,
    ...(startedAt ? { startedAt } : {}), ...(providerSessionId ? { providerSessionId, providerSessionIds: [providerSessionId] } : {}),
    productCount: products.length, product: normalized, github: normalized ? await github(normalized.url, normalized.headSha) : null,
    planReviews: currentPlanReviews, prReviews };
}

async function snapshot(runKey: string, projectId: string): Promise<readonly StressIssueEvidence[]> {
  if (!COMPANY) throw new Error("PAPERCLIP_E2E_COMPANY_ID required");
  const issues = array(await get(`/api/companies/${COMPANY}/issues?projectId=${encodeURIComponent(projectId)}&limit=200`), "campaign issues");
  const marked = issues.filter((issue) => typeof issue["description"] === "string" &&
    issue["description"].includes(`<!-- paperclip-adapters:stress-run:${runKey} -->`));
  if (marked.length !== 20) throw new Error(`Expected 20 original run-marked issues; saw ${marked.length}`);
  const approvals = array(await get(`/api/companies/${COMPANY}/approvals`), "company approvals");
  const mapped = new Map<string, string>();
  for (const task of stressTasks(runKey)) {
    const matching = marked.filter((issue) => issue["title"] === `Stress ${task.key}: ${task.exportName} [stress:${runKey}:${task.key}]`);
    if (matching.length !== 1) throw new Error(`Campaign task ${task.key} has ${matching.length} identities`);
    const issueId = text(matching[0]?.["id"]);
    if (!issueId) throw new Error(`Campaign task ${task.key} has no ID`);
    mapped.set(task.key, issueId);
  }
  const results: StressIssueEvidence[] = [];
  // Deliberately sequential: the installed host has previously stalled under
  // wide concurrent detail hydration, and this observer should not compete.
  for (const task of stressTasks(runKey)) {
    results.push(await collectIssue(task.key, mapped.get(task.key)!, task.predecessors.map((key) => mapped.get(key)!), approvals));
  }
  return results;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const runKey = option("--run-key");
  const projectId = option("--project-id");
  const minutes = option("--wait-minutes");
  const reportDir = option("--report-dir");
  if (!runKey || !projectId || !/^[a-f0-9-]{36}$/i.test(projectId)) throw new Error("--run-key and an exact UUID --project-id are required");
  stressTasks(runKey);
  const wait = minutes === undefined ? 0 : Number(minutes);
  if (!Number.isSafeInteger(wait) || wait < 0 || wait > 1440) throw new Error("--wait-minutes must be 1..1440 or omitted");
  if (reportDir) {
    if (!reportDir.startsWith("/tmp/")) throw new Error("Report directory must be under /tmp/");
    await mkdir(reportDir, { mode: 0o700, recursive: true });
    const directory = await stat(reportDir);
    if (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) throw new Error("Report directory must be owner-only");
  }
  const deadline = Date.now() + wait * 60_000;
  let sequence = 0;
  while (true) {
    const issues = await snapshot(runKey, projectId);
    const progress = evaluateStressProgress(stressTasks(runKey), issues);
    sequence += 1;
    const report = { sequence, observedAt: new Date().toISOString(), runKey, projectId, progress,
      issues: issues.map((issue) => ({ key: issue.key, id: issue.id, status: issue.status, blockedBy: issue.blockedBy,
        startApproval: issue.startApproval, mergeApproval: issue.mergeApproval, providerSessionId: issue.providerSessionId,
        product: issue.product, github: issue.github, executionBlocker: issue.executionBlocker,
        planReviews: issue.planReviews, prReviews: issue.prReviews })) };
    console.log(JSON.stringify(report));
    if (reportDir) await writeFile(`${reportDir}/snapshot-${String(sequence).padStart(4, "0")}.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (progress.kind === "invalid" || progress.kind === "failed") throw new Error(`Campaign ${progress.kind}: ${progress.reason}`);
    if (progress.kind === "passed" || wait === 0) return;
    if (Date.now() >= deadline) throw new Error(`Campaign did not complete within ${wait} minutes: ${progress.kind}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, deadline - Date.now())));
  }
}

main().catch((error) => {
  console.error(`Read-only stress verifier failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
