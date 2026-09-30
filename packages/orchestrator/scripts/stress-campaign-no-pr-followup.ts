/** One-shot original-session recovery for the user-approved MAZ-1623 missing-PR pilot. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { planNoPrFollowup } from "../src/core/no-pr-followup.js";
import { deliverNoPrFollowupOnce } from "../src/core/no-pr-followup-delivery.js";

const companyId = "8f4ef932-d769-43b2-981a-d273ed715162";
const issueId = "81b75464-37a4-4b08-bdbb-6257a1f80cc1";
const siblingId = "2248bede-a343-42d5-84e7-6ca350cc3c7d";
const sessionId = "9473602080744226872";
const cardId = "a313a5e8-7e57-4e6e-863d-a9a8cde0615b";
const prUrl = "https://github.com/Pilleo/paperclip-adapters-e2e-20260923-vanilla-review/pull/6";
const prHeadSha = "7e1fb1412ae5f85892a36f738e93c356b2e7f137";
const repo = "Pilleo/paperclip-adapters-e2e-20260923-vanilla-review";
const journalPath = "/tmp/paperclip-stress-20260929-pilot-b/no-pr-followup-81b75464-37a4-4b08-bdbb-6257a1f80cc1.jsonl";
const julesUrl = "https://jules.googleapis.com/v1alpha";
const api = process.env["PAPERCLIP_TEST_API_URL"] ?? "http://127.0.0.1:3100";
const mode = process.argv[2];
if (mode !== "--dry-run" && mode !== "--deliver") throw new Error("Specify exactly --dry-run or --deliver");
if (process.argv.length !== 3) throw new Error("Unexpected follow-up arguments");
if (new URL(api).hostname !== "127.0.0.1") throw new Error("Paperclip preflight must use local loopback");

const getPaperclip = async <T>(route: string): Promise<T> => {
  const response = await fetch(`${api}/api${route}`, { redirect: "error", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Paperclip GET ${route} returned ${response.status}`);
  return await response.json() as T;
};
const getGitHub = <T>(route: string): T => JSON.parse(execFileSync("gh", ["api", route], {
  encoding: "utf8", timeout: 20_000, maxBuffer: 1_000_000,
})) as T;
const targetFiles = (description: unknown, task: "03" | "04"): string[] => {
  if (typeof description !== "string" ||
      !description.includes(`<!-- paperclip-adapters:stress-task:${task} -->`)) {
    throw new Error(`Original pilot-${task} task contract changed`);
  }
  const match = description.match(/^target_files:\s*(\[[^\n]+\])/m);
  const files: unknown = match ? JSON.parse(match[1]!) : null;
  if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) {
    throw new Error("Original task file scope is invalid");
  }
  return files as string[];
};

// Source is a private checked-in credential file, not a shell-sourced environment.
const readKey = async (): Promise<string> => {
  const file = path.resolve(".ENV");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 131072) {
      throw new Error(".ENV must be owner-only, regular and not a symlink");
    }
    const data = await handle.readFile("utf8");
    const matches = data.split("\n").map((line) => line.match(/^\s*(?:export\s+)?JULES_API_KEY\s*=\s*(.*?)\s*$/))
      .filter((match): match is RegExpMatchArray => match !== null);
    if (matches.length !== 1) throw new Error("Expected one Jules key");
    let key = matches[0]![1]!.trim();
    if ((key.startsWith("\"") && key.endsWith("\"")) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
    if (!key || /[^\x21-\x7e]/.test(key)) throw new Error("Malformed Jules key");
    return key;
  } finally { await handle.close(); }
};

async function main() {
  type Issue = { id: string; status: string; assigneeAgentId: string | null; description: string;
    executionBlocker?: { runId: string } | null };
  type Card = { id: string; status: string; kind: string; idempotencyKey?: string };
  type Product = { type: string; url: string; status: string; metadata?: { headSha?: string } };
  type LiveRun = { id: string; status: string };
  const [issue, sibling, cards, products, siblingProducts, liveRuns] = await Promise.all([
    getPaperclip<Issue>(`/issues/${issueId}`), getPaperclip<Issue>(`/issues/${siblingId}`),
    getPaperclip<Card[]>(`/issues/${issueId}/interactions`),
    getPaperclip<Product[]>(`/issues/${issueId}/work-products`),
    getPaperclip<Product[]>(`/issues/${siblingId}/work-products`),
    getPaperclip<LiveRun[]>(`/issues/${issueId}/live-runs`),
  ]);
  assert.equal(issue.id, issueId);
  assert.equal(sibling.id, siblingId);
  if (issue.executionBlocker || liveRuns.length) throw new Error("Original task has an active execution hold or live run");
  const julesAgentId = issue.assigneeAgentId;
  if (!julesAgentId || sibling.assigneeAgentId !== julesAgentId) throw new Error("Managed Jules issue ownership changed");
  const allCards = cards.filter((card) => card.kind === "request_confirmation" &&
    card.idempotencyKey?.startsWith(`jules:no-pr-completion:${issueId}:${sessionId}`));
  const original = allCards.find((card) => card.id === cardId);
  if (original?.status !== "cancelled" || allCards.filter((card) => card.status === "pending").length !== 1) {
    throw new Error("Expected one reissued native no-PR confirmation after cancelled original");
  }
  const siblingProduct = siblingProducts.filter((product) => product.type === "pull_request" &&
    product.url === prUrl && product.metadata?.headSha === prHeadSha && product.status === "ready_for_review");
  if (siblingProduct.length !== 1) throw new Error("Sibling PR work product changed");
  const githubPr = getGitHub<{ state: string; head: { sha: string } }>(`repos/${repo}/pulls/6`);
  const pulls = getGitHub<Array<{ number: number; head: { ref: string }; title: string }>>(
    `repos/${repo}/pulls?state=all&per_page=100`);
  const remotePullRequests = pulls.filter((pr) => pr.number !== 6 &&
    (pr.head.ref.includes("pilot-b-03") || pr.head.ref.includes(sessionId) || pr.title.includes("MAZ-1623")))
    .map((pr) => `https://github.com/${repo}/pull/${pr.number}`);
  const branches = getGitHub<Array<{ name: string }>>(`repos/${repo}/branches?per_page=100`);
  if (branches.some((branch) => branch.name.includes("pilot-b-03") || branch.name.includes(sessionId))) {
    throw new Error("Pilot-03 branch already exists; inspect it before any provider send");
  }
  const key = await readKey();
  const jules = async <T>(route: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${julesUrl}${route}`, { ...init, redirect: "error",
      headers: { "X-Goog-Api-Key": key, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Jules ${init?.method ?? "GET"} returned ${response.status}`);
    return await response.json() as T;
  };
  const session = await jules<{ name: string; state: string }>(`/sessions/${sessionId}`);
  if (session.name !== `sessions/${sessionId}`) throw new Error("Original Jules provider identity changed");
  const checkpointFile = "/home/leanid/.paperclip/jules-adapter-sessions/v2/352a664328f1ebf63a0b6c938827d3ecae0b2f44195c928c73b63eaa91750733.json";
  const checkpointHandle = await open(checkpointFile, "r");
  let checkpoint: { julesSessionId: string; paperclipIssueId: string; currentPrUrl?: string | null };
  try { checkpoint = JSON.parse(await checkpointHandle.readFile("utf8")) as typeof checkpoint; }
  finally { await checkpointHandle.close(); }
  if (checkpoint.julesSessionId !== sessionId || checkpoint.paperclipIssueId !== issueId || checkpoint.currentPrUrl) {
    throw new Error("Original durable Jules session or PR pointer changed");
  }
  const decision = planNoPrFollowup({ issueId, sessionId, durableSessionId: checkpoint.julesSessionId,
    julesAgentId, assigneeAgentId: issue.assigneeAgentId, issueStatus: issue.status,
    providerState: session.state, prRequired: issue.description.includes("Create exactly one PR for this task"),
    noPrConfirmation: "pending", products, remotePullRequests,
    targetFiles: targetFiles(issue.description, "03"), sharedFileOverride: { siblingIssueId: siblingId, prUrl, headSha: prHeadSha },
    siblings: [{ id: siblingId, status: sibling.status, targetFiles: targetFiles(sibling.description, "04"),
      prProductStatus: siblingProduct[0]!.status, githubPrState: githubPr.state.toUpperCase(),
      prUrl, headSha: githubPr.head.sha }],
  });
  if (decision.kind !== "ready") throw new Error(`Follow-up held: ${decision.reason}`);
  const messages = async (): Promise<string[]> => {
    const userMessages: string[] = [];
    let pageToken: string | undefined;
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const query = new URLSearchParams({ pageSize: "100", ...(pageToken ? { pageToken } : {}) });
      const page = await jules<{ activities?: Array<{ userMessaged?: { userMessage?: string } }>; nextPageToken?: string }>(
        `/sessions/${sessionId}/activities?${query}`);
      for (const activity of page.activities ?? []) {
        if (typeof activity.userMessaged?.userMessage === "string") userMessages.push(activity.userMessaged.userMessage);
      }
      if (!page.nextPageToken) return userMessages;
      if (seen.has(page.nextPageToken)) throw new Error("Jules activity pagination repeated");
      seen.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    }
    throw new Error("Jules activity pagination incomplete");
  };
  if (mode === "--dry-run") {
    const priorEcho = (await messages()).some((message) => message === decision.prompt);
    console.log(JSON.stringify({ mode, issueId, sessionId, siblingPr: prUrl,
      nativeCardId: allCards.find((card) => card.status === "pending")!.id,
      originalProviderState: session.state, priorEcho, decision: decision.kind }));
    return;
  }
  const outcome = await deliverNoPrFollowupOnce({ issueId, sessionId, marker: decision.marker,
    prompt: decision.prompt, journalPath, userMessages: messages,
    send: async () => { await jules(`/sessions/${sessionId}:sendMessage`, {
      method: "POST", body: JSON.stringify({ prompt: decision.prompt }),
    }); },
  });
  console.log(JSON.stringify({ mode, outcome, issueId, sessionId, nativeCardId: allCards.find((card) => card.status === "pending")!.id }));
}

await main();
