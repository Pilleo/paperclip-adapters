import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveGitHubCliExecutable } from "../src/core/github-sync.js";
import { evaluateCanaryDependencyProgress, parseCanaryIssueSnapshot } from "../src/core/real-e2e-canary-progress.js";

const execFileAsync = promisify(execFile);

const apiUrl = process.env["PAPERCLIP_TEST_API_URL"]?.replace(/\/+$/, "");
const julesAgentId = process.env["PAPERCLIP_E2E_JULES_AGENT_ID"];
const issueIds = {
  a: process.env["PAPERCLIP_E2E_CANARY_A_ID"],
  b: process.env["PAPERCLIP_E2E_CANARY_B_ID"],
  c: process.env["PAPERCLIP_E2E_CANARY_C_ID"],
} as const;

/**
 * Read-only observer for the disposable A → B → C canary.  It must never
 * wake, assign, or mutate a Paperclip issue: a failing state needs diagnosis,
 * not a second actor racing the scheduler under test.
 */
async function fetchIssue(id: string): Promise<unknown> {
  if (!apiUrl) throw new Error("PAPERCLIP_TEST_API_URL is required");
  const response = await fetch(`${apiUrl}/api/issues/${id}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`GET /api/issues/${id} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) as unknown : null;
}

function requiredEnv(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function parsePersistedIssue(label: "a" | "b" | "c", raw: unknown) {
  const parsed = parseCanaryIssueSnapshot(raw);
  if ("kind" in parsed) throw new Error(`${label} persisted issue snapshot is invalid: ${parsed.reason}`);
  return parsed;
}

async function verifyGitHubMerge(label: "a" | "b" | "c", snapshot: ReturnType<typeof parsePersistedIssue>): Promise<void> {
  const [product] = snapshot.workProducts.filter((item) => item.type === "pull_request" && item.status === "merged" && item.url);
  if (!product?.url || !product.headSha || !/^[a-f0-9]{40}$/i.test(product.headSha)) {
    throw new Error(`${label} GitHub merge cannot be verified: registered PR head is absent`);
  }
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/i.exec(product.url);
  if (!match) throw new Error(`${label} GitHub PR URL is not canonical: ${product.url}`);
  const gh = resolveGitHubCliExecutable();
  const { stdout } = await execFileAsync(gh, ["pr", "view", product.url, "--json", "state,headRefOid,mergeCommit"], { timeout: 10_000 });
  const pr: unknown = JSON.parse(stdout);
  if (!pr || typeof pr !== "object" || Array.isArray(pr)) throw new Error(`${label} GitHub PR response is invalid`);
  const state = (pr as Record<string, unknown>)["state"];
  const head = (pr as Record<string, unknown>)["headRefOid"];
  const commit = (pr as Record<string, unknown>)["mergeCommit"];
  const sha = commit && typeof commit === "object" && !Array.isArray(commit) ? (commit as Record<string, unknown>)["oid"] : null;
  if (state !== "MERGED" || head !== product.headSha || typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error(`${label} GitHub merge/head differs from registered reviewed PR head`);
  }
  const { stdout: rawCommit } = await execFileAsync(gh, ["api", `repos/${match[1]}/${match[2]}/git/commits/${sha}`], { timeout: 10_000 });
  const merge: unknown = JSON.parse(rawCommit);
  if (!merge || typeof merge !== "object" || Array.isArray(merge)) throw new Error(`${label} GitHub merge commit is invalid`);
  const parents = (merge as Record<string, unknown>)["parents"];
  if (!Array.isArray(parents) || parents.length !== 2 || parents[1]?.sha !== product.headSha) {
    throw new Error(`${label} GitHub merge commit must have reviewed head as its second parent`);
  }
}

async function main(): Promise<void> {
  if (process.env["PAPERCLIP_REAL_E2E"] !== "1") {
    throw new Error("Refusing live canary verification; set PAPERCLIP_REAL_E2E=1 explicitly");
  }
  if (!apiUrl || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(apiUrl)) {
    throw new Error(`PAPERCLIP_TEST_API_URL must be a loopback Paperclip server, got ${apiUrl || "missing"}`);
  }

  const waiting = process.argv.includes("--wait-for-completion");
  const option = (name: string, fallback: number, maximum: number): number => {
    const values = process.argv.filter((argument) => argument.startsWith(`${name}=`));
    if (values.length > 1) throw new Error(`Repeated ${name}`);
    if (!values.length) return fallback;
    const value = Number(values[0]?.slice(name.length + 1));
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`);
    return value;
  };
  const timeoutMs = option("--timeout-ms", 30 * 60_000, 24 * 60 * 60_000);
  const intervalMs = option("--interval-ms", 5000, 60_000);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const [aRaw, bRaw, cRaw] = await Promise.all([
      fetchIssue(requiredEnv("PAPERCLIP_E2E_CANARY_A_ID", issueIds.a)),
      fetchIssue(requiredEnv("PAPERCLIP_E2E_CANARY_B_ID", issueIds.b)),
      fetchIssue(requiredEnv("PAPERCLIP_E2E_CANARY_C_ID", issueIds.c)),
    ]);
    const snapshots = {
      julesAgentId: requiredEnv("PAPERCLIP_E2E_JULES_AGENT_ID", julesAgentId),
      a: parsePersistedIssue("a", aRaw),
      b: parsePersistedIssue("b", bRaw),
      c: parsePersistedIssue("c", cRaw),
    };
    const progress = evaluateCanaryDependencyProgress(snapshots);
    console.log(JSON.stringify({ issueIds, progress }, null, 2));
    if (progress.kind === "invalid") throw new Error(`Dependency canary invariant failed: ${progress.reason}`);
    if (progress.kind === "complete" && (waiting || process.argv.includes("--require-complete"))) {
      for (const label of ["a", "b", "c"] as const) await verifyGitHubMerge(label, snapshots[label]);
      console.log(JSON.stringify({ result: "passed", issueIds }));
      return;
    }
    if (!waiting) {
      if (process.argv.includes("--require-complete")) throw new Error(`Dependency canary is not complete: ${progress.kind}`);
      return;
    }
    if (Date.now() >= deadline) throw new Error(`Dependency canary timeout: not complete (${progress.kind}) after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())));
  }
}

main().catch((error) => {
  console.error(`Real project canary verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
