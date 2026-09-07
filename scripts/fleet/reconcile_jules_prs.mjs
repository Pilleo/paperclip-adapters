#!/usr/bin/env node
/**
 * Board-owned convergence for a Jules task that has already produced a PR.
 *
 * This deliberately runs outside adapter heartbeats. Paperclip currently
 * forbids one agent from waking another and rejects unscoped cross-issue
 * repairs; the authenticated board CLI is the correct local privilege
 * boundary for this temporary compatibility bridge.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PRODUCTIVITY_REVIEW_ORIGIN = "issue_productivity_review";
// Keep this in sync with scripts/fleet/common.sh. It is an identifier, not a
// credential, and allows the timer to run without loading a developer .ENV.
const DEFAULT_COMPANY_ID = "8f4ef932-d769-43b2-981a-d273ed715162";
const JULES_WORKER_AGENT_ID = "6e722f1f-ae06-425a-938d-e3c734bf7344";
const SUPERVISOR_MARKER = "jules-session-supervisor";
const ADJUDICATION_MARKER = "jules-question-adjudication";
const READY_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export function isReadyPullRequest(pr) {
  if (!pr || pr.state !== "OPEN" || pr.isDraft || pr.mergeable !== "MERGEABLE") return false;
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  return checks.length > 0 && checks.every((check) =>
    check?.status === "COMPLETED" && READY_CHECK_CONCLUSIONS.has(check?.conclusion),
  );
}

function isJulesIssue(detail) {
  return Array.isArray(detail?.documentSummaries) &&
    detail.documentSummaries.some((document) => document?.key === "jules-session") &&
    Array.isArray(detail?.workProducts) &&
    detail.workProducts.some((product) => product?.type === "pull_request" && product?.metadata?.source === "jules");
}

export function buildReconciliationPlan(issues, detailsById, prByUrl) {
  const actions = [];
  for (const issue of issues) {
    if (!["blocked", "in_progress", "in_review"].includes(issue.status)) continue;
    const detail = detailsById.get(issue.id);
    if (!isJulesIssue(detail)) continue;
    const pr = detail.workProducts.find((product) => product?.type === "pull_request" && product?.metadata?.source === "jules");
    if (!pr?.url || !isReadyPullRequest(prByUrl.get(pr.url))) continue;

    const sourceChildren = issues.filter((candidate) => candidate.parentId === issue.id &&
      !["done", "cancelled"].includes(candidate.status));
    const falseProductivityReviews = issues.filter((candidate) =>
      candidate.originKind === PRODUCTIVITY_REVIEW_ORIGIN &&
      candidate.originId === issue.id &&
      !["done", "cancelled"].includes(candidate.status),
    );
    const staleCompatibilityChildren = sourceChildren.filter((candidate) => {
      const description = candidate.description ?? "";
      return description.includes(SUPERVISOR_MARKER) || description.includes(ADJUDICATION_MARKER);
    });
    actions.push({
      issue,
      pr,
      completeIssueIds: [...falseProductivityReviews, ...staleCompatibilityChildren].map((candidate) => candidate.id),
      transitionToReview: issue.status !== "in_review",
    });
  }
  return actions;
}

async function command(command, args) {
  const { stdout } = await execFileAsync(command, args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function jsonCommand(commandName, args) {
  const output = await command(commandName, args);
  return JSON.parse(output || "null");
}

async function getIssue(companyId, issueId) {
  // `issue get` resolves within the authenticated board context; unlike list,
  // it intentionally has no company-id flag.
  return jsonCommand("paperclipai", ["issue", "get", issueId, "--json"]);
}

async function getPullRequest(url) {
  return jsonCommand("gh", ["pr", "view", url, "--json", "url,state,isDraft,mergeable,statusCheckRollup"]);
}

async function updateIssue(issueId, status, comment) {
  return jsonCommand("paperclipai", ["issue", "update", issueId, "--status", status, "--comment", comment, "--json"]);
}

function parseArguments(argv) {
  const args = new Set(argv);
  for (const arg of args) {
    if (!["--dry-run", "--json"].includes(arg)) throw new Error(`Usage: reconcile_jules_prs.mjs [--dry-run] [--json]`);
  }
  return { dryRun: args.has("--dry-run"), json: args.has("--json") };
}

export async function reconcile({ companyId, dryRun = false, listIssues = null, loadIssue = getIssue, loadPullRequest = getPullRequest, mutateIssue = updateIssue } = {}) {
  const effectiveCompanyId = companyId ?? process.env.COMPANY_ID ?? DEFAULT_COMPANY_ID;
  const issues = listIssues ?? await jsonCommand("paperclipai", [
    "issue", "list", "-C", effectiveCompanyId, "--status", "blocked,in_progress,in_review,todo", "--json",
  ]);
  // The board can have a large historical backlog. Only hydrate plausible
  // provider candidates; the authoritative document/work-product check below
  // still prevents false matches from this inexpensive prefilter.
  const candidates = issues.filter((issue) =>
    issue.assigneeAgentId === JULES_WORKER_AGENT_ID ||
    String(issue.monitorNotes ?? "").toLowerCase().includes("jules") ||
    String(issue.description ?? "").toLowerCase().includes("jules"),
  );
  const details = await Promise.all(candidates.map(async (issue) => [
    issue.id,
    await loadIssue(effectiveCompanyId, issue.id),
  ]));
  const detailsById = new Map(details);
  const prByUrl = new Map();
  const prUrls = [...new Set([...detailsById.values()].flatMap((detail) =>
    (detail?.workProducts ?? [])
      .filter((product) => product?.type === "pull_request" && product?.metadata?.source === "jules" && product.url)
      .map((product) => product.url),
  ))];
  const pullRequests = await Promise.all(prUrls.map(async (url) => [url, await loadPullRequest(url)]));
  for (const [url, pr] of pullRequests) prByUrl.set(url, pr);

  const plan = buildReconciliationPlan(issues, detailsById, prByUrl);
  const result = { candidates: plan.length, closedBlockers: 0, transitionedToReview: 0, failures: [] };
  for (const action of plan) {
    const evidence = `Jules PR reconciler: ${action.pr.url} is open, mergeable, and all reported GitHub checks passed.`;
    try {
      for (const issueId of action.completeIssueIds) {
        if (!dryRun) await mutateIssue(issueId, "done", `${evidence} Closing obsolete provider-polling blocker.`);
        result.closedBlockers++;
      }
      if (action.transitionToReview) {
        if (!dryRun) await mutateIssue(action.issue.id, "in_review", evidence);
        result.transitionedToReview++;
      }
    } catch (error) {
      result.failures.push({ issueId: action.issue.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await reconcile({ dryRun: options.dryRun });
  if (options.json) console.log(JSON.stringify(result));
  else console.log(`Jules PR reconciliation: candidates=${result.candidates}, blockers_closed=${result.closedBlockers}, transitioned_to_review=${result.transitionedToReview}, failures=${result.failures.length}`);
  if (result.failures.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Jules PR reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
