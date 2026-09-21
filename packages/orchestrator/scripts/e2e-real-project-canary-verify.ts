import process from "node:process";
import { evaluateCanaryDependencyProgress, parseCanaryIssueSnapshot } from "../src/core/real-e2e-canary-progress.js";

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

async function main(): Promise<void> {
  if (process.env["PAPERCLIP_REAL_E2E"] !== "1") {
    throw new Error("Refusing live canary verification; set PAPERCLIP_REAL_E2E=1 explicitly");
  }
  if (!apiUrl || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(apiUrl)) {
    throw new Error(`PAPERCLIP_TEST_API_URL must be a loopback Paperclip server, got ${apiUrl || "missing"}`);
  }

  const [aRaw, bRaw, cRaw] = await Promise.all([
    fetchIssue(requiredEnv("PAPERCLIP_E2E_CANARY_A_ID", issueIds.a)),
    fetchIssue(requiredEnv("PAPERCLIP_E2E_CANARY_B_ID", issueIds.b)),
    fetchIssue(requiredEnv("PAPERCLIP_E2E_CANARY_C_ID", issueIds.c)),
  ]);
  const progress = evaluateCanaryDependencyProgress({
    julesAgentId: requiredEnv("PAPERCLIP_E2E_JULES_AGENT_ID", julesAgentId),
    a: parsePersistedIssue("a", aRaw),
    b: parsePersistedIssue("b", bRaw),
    c: parsePersistedIssue("c", cRaw),
  });
  console.log(JSON.stringify({ issueIds, progress }, null, 2));
  if (progress.kind === "invalid") throw new Error(`Dependency canary invariant failed: ${progress.reason}`);
}

main().catch((error) => {
  console.error(`Real project canary verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
