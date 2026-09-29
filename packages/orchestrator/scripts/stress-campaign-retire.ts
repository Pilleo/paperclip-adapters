/** Board-only operator tool for retiring exactly the failed 2026-09-29 campaign. */
import { open, readFile, stat } from "node:fs/promises";
import process from "node:process";
import { buildStressIssue, stressTasks } from "../src/core/stress-campaign-manifest.js";

const companyId = "8f4ef932-d769-43b2-981a-d273ed715162";
const projectId = "db166929-2e4e-454d-aee9-25f5380543c4";
const runKey = "stress-20260929-20pr-a";
const api = process.env["PAPERCLIP_TEST_API_URL"]?.replace(/\/+$/, "");
const journalDir = process.env["PAPERCLIP_STRESS_JOURNAL_DIR"];
type Row = Record<string, unknown>;

function row(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Malformed ${label}`);
  return value as Row;
}
function list(value: unknown, label: string): Row[] {
  if (!Array.isArray(value)) throw new Error(`Malformed ${label} list`);
  return value.map((item) => row(item, label));
}
function value(record: Row, key: string, label: string): string {
  const result = record[key];
  if (typeof result !== "string" || !result) throw new Error(`Missing ${label} ${key}`);
  return result;
}
async function request(path: string, method = "GET", body?: unknown): Promise<unknown> {
  if (!api || !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(api)) throw new Error("Loopback PAPERCLIP_TEST_API_URL required");
  const response = await fetch(`${api}${path}`, { method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} rejected (${response.status}): ${raw.slice(0, 200)}`);
  return raw ? JSON.parse(raw) as unknown : null;
}
async function issue(id: string): Promise<Row> { return row(await request(`/api/issues/${encodeURIComponent(id)}`), `issue ${id}`); }
async function approvals(): Promise<Row[]> {
  return list(await request(`/api/companies/${companyId}/approvals`), "approvals");
}
async function ownerOnlyJournal(): Promise<string> {
  if (!journalDir || !journalDir.startsWith("/tmp/") || !journalDir.endsWith("/")) throw new Error("Owner-only /tmp/ journal directory required");
  const directory = await stat(journalDir);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) {
    throw new Error("Owner-only journal directory required");
  }
  return `${journalDir}paperclip-stress-retirement-${runKey}.jsonl`;
}
async function receiptEntries(): Promise<Row[]> {
  const path = await ownerOnlyJournal();
  try {
    const contents = await readFile(path, "utf8");
    return contents.trim() ? contents.trim().split("\n").map((line) => row(JSON.parse(line) as unknown, "retirement journal")) : [];
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
async function journal(event: string, fields: Row): Promise<void> {
  const handle = await open(await ownerOnlyJournal(), "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ time: new Date().toISOString(), runKey, event, ...fields })}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}
async function originalIssueIds(): Promise<Map<string, string>> {
  const originalFile = await ownerOnlyJournal();
  const contents = await readFile(originalFile.replace("paperclip-stress-retirement-", "paperclip-stress-"), "utf8");
  const found = new Map<string, string>();
  for (const line of contents.trim().split("\n")) {
    const entry = row(JSON.parse(line) as unknown, "campaign journal");
    if (entry["event"] !== "issue_verified" || entry["runKey"] !== runKey) continue;
    const key = value(entry, "task", "task");
    const id = value(entry, "issueId", "issue");
    if (found.has(key) && found.get(key) !== id) throw new Error(`Ambiguous original issue ${key}`);
    found.set(key, id);
  }
  if (found.size !== 20) throw new Error("Missing exact twenty original issue receipts");
  return found;
}
async function currentGraph(requireJournal = false): Promise<{ ids: Map<string, string>; details: Map<string, Row>; mergeGate: Row | null }> {
  const projectIssues = list(await request(`/api/companies/${companyId}/issues?projectId=${projectId}&limit=200`), "project issues")
    .filter((item) => typeof item["description"] === "string" && item["description"].includes(`<!-- paperclip-adapters:stress-run:${runKey} -->`));
  if (projectIssues.length !== 20 || new Set(projectIssues.map((entry) => entry["id"])).size !== 20) throw new Error("Original run is not exactly twenty unique issue IDs");
  const ids = requireJournal ? await originalIssueIds() : new Map(stressTasks(runKey).map((task) => {
    const matches = projectIssues.filter((entry) => typeof entry["title"] === "string" &&
      entry["title"].includes(`[stress:${runKey}:${task.key}]`));
    if (matches.length !== 1) throw new Error(`Task ${task.key} identity is ambiguous`);
    return [task.key, value(matches[0]!, "id", "issue")] as const;
  }));
  const details = new Map<string, Row>();
  for (const task of stressTasks(runKey)) {
    const id = ids.get(task.key);
    if (!id || !projectIssues.some((entry) => entry["id"] === id)) throw new Error(`Task ${task.key} issue identity changed`);
    const observed = await issue(id);
    const expected = buildStressIssue(task, projectId, task.predecessors.map((key) => ids.get(key)!));
    if (observed["id"] !== id || observed["projectId"] !== projectId ||
        observed["title"] !== expected["title"] || observed["description"] !== expected["description"]) {
      throw new Error(`Task ${task.key} immutable scope changed`);
    }
    const blockedBy = list(observed["blockedBy"], "native blockedBy").map((b) => value(b, "id", "blocker"));
    const expectedBlockers = task.predecessors.map((key) => ids.get(key)!);
    if (blockedBy.length !== expectedBlockers.length || blockedBy.some((b) => !expectedBlockers.includes(b))) throw new Error(`Task ${task.key} DAG changed`);
    if (!["todo", "blocked", "in_review", "cancelled"].includes(String(observed["status"]))) {
      throw new Error(`Task ${task.key} has unexpected ${String(observed["status"])} status`);
    }
    details.set(task.key, observed);
  }
  const mergeApprovals = (await approvals()).filter((a) => {
    const payload = a["payload"];
    return payload && typeof payload === "object" && !Array.isArray(payload) &&
      (payload as Row)["action"] === "task_merge" && (payload as Row)["issueId"] === ids.get("01");
  });
  if (mergeApprovals.length !== 1) throw new Error("Expected exactly one task 01 merge approval");
  const mergeGate = mergeApprovals[0]!;
  const payload = row(mergeGate["payload"], "merge gate payload");
  if (payload["prUrl"] !== "https://github.com/Pilleo/paperclip-adapters-e2e-20260923-vanilla-review/pull/4" ||
      !["pending", "rejected"].includes(String(mergeGate["status"]))) throw new Error("Original task 01 merge gate changed");
  return { ids, details, mergeGate };
}
async function noLiveRuns(): Promise<void> {
  const companies = list(await request("/api/companies"), "companies");
  if (!companies.some((entry) => entry["id"] === companyId)) throw new Error("Mazewall company not found");
  for (const company of companies) {
    const id = value(company, "id", "company");
    const active = list(await request(`/api/companies/${encodeURIComponent(id)}/live-runs`), "live runs");
    if (active.length) throw new Error(`Fleet is active in company ${id}; do not retire source issues`);
  }
}
async function noPendingReviewer(roots: readonly Row[]): Promise<void> {
  for (const root of roots) {
    const parentId = value(root, "id", "parent");
    const children = list(await request(`/api/companies/${companyId}/issues?limit=1000&parentId=${encodeURIComponent(parentId)}`), "review children");
    for (const child of children) {
      if (typeof child["description"] !== "string" || !child["description"].includes("paperclip-pr-review-child:")) continue;
      const childId = value(child, "id", "child");
      const cards = list(await request(`/api/issues/${encodeURIComponent(childId)}/interactions`), "review cards");
      if (cards.some((card) => card["status"] === "pending") || cards.length > 1) {
        throw new Error(`Task ${parentId} has an unresolved addressed native review card on ${childId}`);
      }
    }
  }
}
async function rejectGate(gate: Row): Promise<void> {
  if (gate["status"] === "rejected") return;
  const id = value(gate, "id", "merge gate");
  const previous = await receiptEntries();
  if (previous.some((entry) => entry["event"] === "merge_reject_intent" && entry["approvalId"] === id)) {
    throw new Error("Unresolved merge gate rejection intent; inspect before retrying");
  }
  await noLiveRuns();
  await journal("merge_reject_intent", { approvalId: id, issueId: "28f4b726-364b-4fa2-ba88-1ea88838357d" });
  try { await request(`/api/approvals/${encodeURIComponent(id)}/reject`, "POST", {
    decisionNote: "Superseded by the failed stress-20260929-20pr-a campaign. PR #4 remains unmerged and its native review verdicts remain historical; this does not reject its implementation.",
  }); } catch (error) {
    const matched = (await approvals()).find((entry) => entry["id"] === id);
    if (matched?.["status"] !== "rejected") throw error;
  }
  const matched = (await approvals()).find((entry) => entry["id"] === id);
  if (matched?.["status"] !== "rejected") throw new Error("Merge gate rejection was not confirmed");
  await journal("merge_gate_rejected", { approvalId: id });
}
async function retire(): Promise<void> {
  if (process.env["PAPERCLIP_E2E_COMPANY_ID"] !== companyId ||
      process.env["PAPERCLIP_STRESS_PROJECT_ID"] !== projectId ||
      process.env["PAPERCLIP_STRESS_RUN_KEY"] !== runKey) throw new Error("Exact old campaign environment required for retirement");
  const original = await currentGraph(true);
  await noPendingReviewer([original.details.get("01")!, original.details.get("03")!]);
  await rejectGate(original.mergeGate!);
  for (const task of [...stressTasks(runKey)].reverse()) {
    const id = original.ids.get(task.key)!;
    const graph = await currentGraph(true);
    const observed = graph.details.get(task.key)!;
    if (observed["status"] === "cancelled") continue;
    const actions = row(await request(`/api/issues/${encodeURIComponent(id)}/recovery-actions`), "native recovery actions");
    if (actions["active"] != null) throw new Error(`Task ${task.key} has an active native recovery action`);
    if (observed["executionRunId"] != null) throw new Error(`Task ${task.key} has a live execution-run pointer`);
    await noLiveRuns();
    await noPendingReviewer([observed]);
    if ((await receiptEntries()).some((entry) => entry["event"] === "issue_cancel_intent" && entry["issueId"] === id)) {
      throw new Error(`Task ${task.key} has an unresolved cancellation intent; inspect exact board state`);
    }
    const products = Array.isArray(observed["workProducts"]) ? observed["workProducts"] as Row[] : [];
    await journal("issue_cancel_intent", { task: task.key, issueId: id,
      sourceStatus: observed["status"], blockerRunId: (observed["executionBlocker"] as Row | null)?.["runId"] ?? null });
    try {
      await request(`/api/issues/${encodeURIComponent(id)}`, "PATCH", {
        status: "cancelled", assigneeAgentId: null, executionPolicy: null, executionState: null,
      });
    } catch (error) {
      if ((await issue(id))["status"] !== "cancelled") throw error;
    }
    const settled = await issue(id);
    if (settled["status"] !== "cancelled" || settled["assigneeAgentId"] != null) throw new Error(`Task ${task.key} did not terminalize`);
    const currentProducts = Array.isArray(settled["workProducts"]) ? settled["workProducts"] as Row[] : [];
    if (JSON.stringify(products.map((p) => [p["id"], p["url"], p["status"]])) !==
        JSON.stringify(currentProducts.map((p) => [p["id"], p["url"], p["status"]]))) {
      throw new Error(`Task ${task.key} PR product changed during retirement`);
    }
    await journal("issue_cancelled", { task: task.key, issueId: id });
    console.log(JSON.stringify({ task: task.key, issueId: id, status: "cancelled" }));
  }
  const final = await currentGraph(true);
  if ([...final.details.values()].some((detail) => detail["status"] !== "cancelled")) throw new Error("Original run still contains a nonterminal task");
  console.log(JSON.stringify({ runKey, projectId, retiredIssues: 20, mergeGate: "rejected" }));
}
async function main(): Promise<void> {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["--dry-run", "--retire"].includes(mode ?? "")) throw new Error("Use --dry-run or --retire");
  if (process.env["PAPERCLIP_E2E_COMPANY_ID"] !== companyId ||
      process.env["PAPERCLIP_STRESS_PROJECT_ID"] !== projectId ||
      process.env["PAPERCLIP_STRESS_RUN_KEY"] !== runKey) throw new Error("Exact company/project/run identity required");
  if (mode === "--retire") return retire();
  const graph = await currentGraph();
  const roots = [graph.details.get("01")!, graph.details.get("03")!];
  await noPendingReviewer(roots);
  console.log(JSON.stringify({ runKey, projectId, originalIssues: graph.ids.size,
    retirementOrder: [...graph.ids.keys()].reverse(), pendingMergeGate: graph.mergeGate?.["status"] === "pending" ? graph.mergeGate["id"] : null,
    statuses: Object.fromEntries([...graph.details].map(([key, detail]) => [key, detail["status"]])) }));
}
main().catch((error) => {
  console.error(`Stress campaign retirement stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
