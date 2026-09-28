import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JulesClient, extractPullRequestUrl } from "../src/server/jules-client.js";
import { asJulesSessionId } from "../src/server/brands.js";
import type { ExternalApprovedPlanReceipt } from "../src/server/external-plan-approval-recovery.js";
import { persistExternalApprovalCheckpoint } from "../src/server/operator-approval-checkpoint.js";
import { findStoredSessionByJulesSessionId, loadStoredSession } from "../src/server/session-store.js";
import { loadKey } from "./qualify-plan-approval.js";

const api = "http://127.0.0.1:3100/api";

function option(name: string): string {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

async function ownerOnlyJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 131072) {
      throw new Error("Approval receipt must be an owner-only regular file");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

async function get(route: string): Promise<Record<string, unknown> | Record<string, unknown>[]> {
  const response = await fetch(api + route, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Paperclip read failed (${response.status})`);
  return await response.json() as Record<string, unknown> | Record<string, unknown>[];
}

async function main() {
  const receiptPath = option("receipt");
  const journalPath = option("journal");
  const issueId = option("issue");
  const headSha = option("head");
  if (!/^[0-9a-f]{40}$/i.test(headSha) || !/^[0-9a-f-]{36}$/i.test(issueId)) throw new Error("Issue/head identity is invalid");
  const raw = await ownerOnlyJson(receiptPath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Approval receipt is invalid");
  const receipt = raw as ExternalApprovedPlanReceipt;
  if (!/^[0-9]{1,30}$/.test(receipt.sessionId) || receipt.issueId !== issueId) throw new Error("Receipt belongs to another task");
  const found = await findStoredSessionByJulesSessionId(receipt.sessionId);
  if (!found || found.paperclipIssueId !== issueId) throw new Error("Jules checkpoint belongs to another issue");
  const session = await loadStoredSession(issueId, found.source, found.baseBranch);
  if (!session || session.julesSessionId !== receipt.sessionId) throw new Error("Exact durable Jules checkpoint is unavailable");
  const issue = await get(`/issues/${encodeURIComponent(issueId)}`) as Record<string, unknown>;
  const plan = issue["planDocument"] as Record<string, unknown> | undefined;
  const ownerId = typeof issue["assigneeAgentId"] === "string" ? issue["assigneeAgentId"] : "";
  const owner = ownerId ? await get(`/agents/${encodeURIComponent(ownerId)}`) as Record<string, unknown> : null;
  if (issue["status"] !== "blocked" || !owner || owner["adapterType"] !== "jules" ||
      owner["companyId"] !== issue["companyId"] ||
      (session.childPlanReview && session.childPlanReview.identity.julesAgentId !== ownerId) ||
      plan?.["id"] !== receipt.documentId || plan["latestRevisionId"] !== receipt.revisionId) {
    throw new Error("Paperclip owner or immutable plan changed");
  }
  const runs = await get(`/issues/${encodeURIComponent(issueId)}/runs`) as Record<string, unknown>[];
  if (runs.some((run) => ["queued", "running"].includes(String(run["status"])))) throw new Error("Parent still has an active run");
  const children = await get(`/companies/${encodeURIComponent(String(issue["companyId"]))}/issues?parentId=${encodeURIComponent(issueId)}&limit=100`) as Record<string, unknown>[];
  for (const reviewer of receipt.reviewers) {
    const childCards = await Promise.all(children.map(async (child) => ({ child,
      cards: await get(`/issues/${encodeURIComponent(String(child["id"]))}/interactions`) as Record<string, unknown>[],
    })));
    const addressed = childCards.find(({ cards }) => cards.some((card) => card["id"] === reviewer.cardId));
    const card = addressed?.cards.find((candidate) => candidate["id"] === reviewer.cardId);
    const target = card?.["payload"] && typeof card["payload"] === "object"
      ? (card["payload"] as Record<string, unknown>)["target"] as Record<string, unknown> | undefined : undefined;
    const result = card?.["result"] as Record<string, unknown> | undefined;
    const verdicts = result?.["items"] as Record<string, unknown>[] | undefined;
    if (!card || card["status"] !== "answered" || card["addresseeAgentId"] !== reviewer.reviewerAgentId ||
        card["resolvedByRunId"] !== reviewer.runId || target?.["documentId"] !== receipt.documentId ||
        target["revisionId"] !== receipt.revisionId || verdicts?.length !== 1 ||
        verdicts[0]?.["id"] !== "plan" || verdicts[0]["verdict"] !== "approve") {
      throw new Error("One addressed typed plan verdict does not match the approval receipt");
    }
    const reviewerRun = await get(`/heartbeat-runs/${encodeURIComponent(reviewer.runId)}`) as Record<string, unknown>;
    const context = reviewerRun["contextSnapshot"] as Record<string, unknown> | undefined;
    if (reviewerRun["status"] !== "succeeded" || reviewerRun["agentId"] !== reviewer.reviewerAgentId ||
        context?.["issueId"] !== addressed.child["id"]) throw new Error("Reviewer run did not settle on its addressed child");
  }
  const client = new JulesClient(await loadKey());
  const provider = await client.getSession(asJulesSessionId(receipt.sessionId));
  if (provider.state !== "COMPLETED") throw new Error("Provider execution has not settled");
  const prUrl = extractPullRequestUrl(provider, session.repository);
  if (!prUrl) throw new Error("Jules did not provide a canonical PR");
  let token: string | undefined;
  const providerActivities = [];
  const pageTokens = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const response = await client.getActivities(asJulesSessionId(receipt.sessionId), token, 100);
    providerActivities.push(...response.activities);
    token = response.nextPageToken;
    if (!token) break;
    if (pageTokens.has(token)) throw new Error("Jules activity pagination repeated");
    pageTokens.add(token);
  }
  if (token) throw new Error("Jules activity history incomplete");
  const pr = JSON.parse(execFileSync("/usr/bin/gh", ["pr", "view", prUrl, "--json", "url,state,headRefOid,baseRefName,isDraft"],
    { encoding: "utf8", timeout: 15_000 })) as Record<string, unknown>;
  if (pr["url"] !== prUrl || pr["headRefOid"] !== headSha || pr["state"] !== "OPEN" ||
      pr["isDraft"] !== false || pr["baseRefName"] !== session.baseBranch) throw new Error("GitHub PR head/base is not the provider result");
  const adoption = await persistExternalApprovalCheckpoint({ session, evidence: { receipt, providerActivities,
    historyComplete: true, providerPrUrl: prUrl, boardDocumentRevisionId: String(plan["latestRevisionId"]) }, journalPath });
  console.log(JSON.stringify({ issueId, sessionId: receipt.sessionId, effectId: receipt.effectId,
    result: adoption.status, prUrl, headSha }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(`External approval reconciliation stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
