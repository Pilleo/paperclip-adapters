import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

vi.mock("../src/core/github-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/github-sync.js")>();
  return {
    ...actual,
    fetchGitHubPullRequests: vi.fn(),
    fetchGitHubPullRequest: vi.fn(),
    fetchPullRequestHeadSha: vi.fn(),
    checkPrCiIsGreen: vi.fn(),
  };
});

vi.mock("../src/core/git-safety.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/git-safety.js")>();
  return { ...actual, checkPrMergeability: vi.fn() };
});

import { execute } from "../src/server/execute.js";
import {
  checkPrCiIsGreen,
  fetchGitHubPullRequest,
  fetchGitHubPullRequests,
  fetchPullRequestHeadSha,
} from "../src/core/github-sync.js";
import { checkPrMergeability } from "../src/core/git-safety.js";
import { prReviewChildDescription } from "../src/core/pr-review-child.js";

const companyId = "company-1519";
const issueId = "issue-1519";
const prUrl = "https://github.com/Pilleo/paperclip-adapters-e2e-1789425372464-3042474/pull/3";
const headSha = "d6f346173cd77018fc40ac2d761384db5096e061";

function context(): AdapterExecutionContext {
  return {
    runId: "orchestrator-run-1519",
    agent: { id: "orchestrator-1", companyId, name: "Orchestrator", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null },
    config: { workspacePath: process.cwd(), apiUrl: "https://paperclip.test", reconcileFleet: false },
    context: { companyId },
    onLog: vi.fn().mockResolvedValue(undefined),
  } as AdapterExecutionContext;
}

function managedAgents(includeGemini = false) {
  return [
    { id: "jules-1", name: "Jules", adapterType: "jules", status: "idle", reportsTo: "orchestrator-1", metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" } },
    { id: "luna-1", name: "Luna", adapterType: "codex_local", status: "idle", reportsTo: "orchestrator-1", metadata: { managedBy: "paperclip-orchestrator", workerKey: "luna_reviewer", structuredDecisionCapability: { version: 1, transports: ["mcp_tool"], decisionKinds: ["pull_request_review"] } } },
    { id: "terra-1", name: "Terra", adapterType: "codex_local", status: "idle", reportsTo: "orchestrator-1", metadata: { managedBy: "paperclip-orchestrator", workerKey: "terra_reviewer", structuredDecisionCapability: { version: 1, transports: ["mcp_tool"], decisionKinds: ["pull_request_review"] } } },
    ...(includeGemini ? [{ id: "gemini-1", name: "Gemini", adapterType: "antigravity", status: "idle", reportsTo: "orchestrator-1", metadata: { managedBy: "paperclip-orchestrator", workerKey: "antigravity", structuredDecisionCapability: { version: 1, transports: ["mcp_tool"], decisionKinds: ["plan_review", "pull_request_review"] } } }] : []),
  ];
}

function issue() {
  return {
    id: issueId,
    identifier: "MAZ-1519",
    title: "native review completion canary",
    description: "---\norchestrator_managed: true\n---\nCreate an immutable PR review handoff.",
    status: "in_review",
    projectId: "project-1519",
    assigneeAgentId: null,
    executionPolicy: null,
    executionState: { status: "idle", monitor: { kind: "external_service", serviceName: "jules", status: "cleared" } },
    workProducts: [{
      type: "pull_request", url: prUrl, title: "Jules pull request", status: "ready_for_review", reviewState: "none", isPrimary: true,
      metadata: { source: "jules", producer: "paperclip-jules-adapter" },
    }],
  };
}

function approvedCard(stage: "luna" | "terra" | "strong", agentId: string, id: string) {
  return {
    id,
    kind: "request_item_verdicts",
    status: "answered",
    addresseeAgentId: agentId,
    idempotencyKey: `pr-review:v13:${issueId}:${prUrl}:${headSha}:${stage}`,
    result: { version: 1, outcome: "resolved", complete: true, items: [{ id: "pull_request", verdict: "approve" }] },
  };
}

describe("orchestrator native PR completion", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env["PAPERCLIP_API_KEY"];

  beforeEach(() => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
    vi.mocked(fetchGitHubPullRequests).mockResolvedValue({
      openPrs: [{ number: 3, title: "MAZ-1519 Jules PR", state: "OPEN", headRefName: "jules/1519", headRefOid: headSha, baseRefName: "main", mergedAt: null, url: prUrl, files: [] }],
      mergedPrs: [],
      openPrFiles: new Set(),
    });
    vi.mocked(fetchGitHubPullRequest).mockResolvedValue(undefined);
    vi.mocked(fetchPullRequestHeadSha).mockResolvedValue(headSha);
    vi.mocked(checkPrCiIsGreen).mockResolvedValue({ isGreen: true, status: "success" });
    vi.mocked(checkPrMergeability).mockResolvedValue({ prNumber: 3, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
  });

  it("does not reopen a rejected Jules PR head after its addressed v2 Luna child verdict", async () => {
    const parent = { ...issue(), companyId, status: "blocked", assigneeAgentId: "jules-1",
      executionPolicy: null, workProducts: [{ ...issue().workProducts[0],
        metadata: { source: "jules", producer: "operator_reconciliation", headSha } }] };
    const identity = { version: 2 as const, creatorPrincipal: "board" as const, companyId,
      parentIssueId: issueId, prUrl, headSha, stage: "luna" as const,
      reviewerAgentId: "luna-1", bootstrapAgentId: "orchestrator-1" };
    const childId = "pr-child-rejected";
    const child = { id: childId, companyId, parentId: issueId, status: "in_progress",
      assigneeAgentId: "luna-1", createdByAgentId: null,
      description: prReviewChildDescription(identity) };
    const patches: Record<string, unknown>[] = [];
    const logs: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "PATCH" && href.endsWith(`/api/issues/${issueId}`)) {
        patches.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify(parent));
      }
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents(true)));
      if (href.includes("/projects")) return new Response(JSON.stringify([{ id: "project-1519", name: "fixture", primaryWorkspace: { cwd: process.cwd() } }]));
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify(parent));
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}/work-products`)) return new Response(JSON.stringify(parent.workProducts));
      if (method === "GET" && href.endsWith(`/api/issues/${childId}`)) return new Response(JSON.stringify(child));
      if (method === "GET" && href.includes("/parentId=")) return new Response(JSON.stringify([child]));
      if (method === "GET" && href.includes("parentId=")) return new Response(JSON.stringify([child]));
      if (method === "GET" && href.endsWith(`/api/issues/${childId}/interactions`)) return new Response(JSON.stringify([{
        id: "typed-child-reject", kind: "request_item_verdicts", status: "answered",
        idempotencyKey: `pr-review:v13:${childId}:${prUrl}:${headSha}:luna`, addresseeAgentId: "luna-1",
        sourceRunId: "bootstrap-run", resolvedByAgentId: "luna-1", resolvedByRunId: "reviewer-run",
        result: { outcome: "resolved", complete: true, items: [{ id: "pull_request", verdict: "reject",
          reason: "Fractional input must throw TypeError." }] },
      }]));
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}/interactions`)) return new Response(JSON.stringify([]));
      if (method === "GET" && href.endsWith("/api/heartbeat-runs/bootstrap-run")) return new Response(JSON.stringify({
        id: "bootstrap-run", companyId, agentId: "orchestrator-1", status: "succeeded", contextSnapshot: { issueId: childId },
      }));
      if (method === "GET" && href.endsWith("/api/heartbeat-runs/reviewer-run")) return new Response(JSON.stringify({
        id: "reviewer-run", companyId, agentId: "luna-1", status: "succeeded", contextSnapshot: { issueId: childId },
      }));
      if (href.includes(`/api/issues/${issueId}/documents`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/children`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([]));
      if (method === "GET" && href.includes("/issues")) return new Response(JSON.stringify([parent]));
      if (href.includes("/approvals")) return new Response(JSON.stringify([]));
      return new Response(JSON.stringify([]));
    }) as typeof fetch;

    const result = await execute({ ...context(), onLog: async (_stream, text) => { logs.push(text); } });

    expect(result.exitCode).toBe(0);
    expect(patches.some((patch) => patch["status"] === "in_review")).toBe(false);
    expect(logs.join("\n")).toContain("Deferring rejected-head recovery");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (originalKey === undefined) delete process.env["PAPERCLIP_API_KEY"];
    else process.env["PAPERCLIP_API_KEY"] = originalKey;
  });

  it.each(["without a parent card", "from company timer without a maintenance issue", "with a pending parent card", "with unavailable GitHub PR discovery", "while Jules provider PR is not registered", "with a newer GitHub head than the registered product", "from todo with a cleared Jules monitor", "from compact unassigned todo projection"] as const)(
    "routes a Jules PR %s without another parent Luna verdict or wake", async (parentCardState) => {
    if (parentCardState === "with unavailable GitHub PR discovery") vi.mocked(fetchGitHubPullRequests).mockResolvedValue({
      openPrs: [], mergedPrs: [], openPrFiles: new Set(), error: "provider unavailable",
    });
    // The convergence guard is process-global. Give each independent recovery
    // fixture its own issue identity so a prior successful test cannot absorb
    // this scenario's project-loop status transition.
    const effectiveIssueId = parentCardState === "from compact unassigned todo projection"
      ? "issue-compact-1519" : issueId;
    const ready = { ...issue(), id: effectiveIssueId, companyId,
      ...(["from todo with a cleared Jules monitor", "from compact unassigned todo projection"].includes(parentCardState) ? { status: "todo",
        executionState: { status: "idle", monitor: { serviceName: "jules", externalRef: "[redacted]",
          status: "cleared", clearReason: "invalid_status" } } } : {}),
      ...(parentCardState === "while Jules provider PR is not registered" ? { executionState: {
        status: "idle", monitor: { serviceName: "jules", externalRef: "[redacted]", status: "cleared" },
      } } : {}),
      workProducts: parentCardState === "while Jules provider PR is not registered" ? [] : [{ ...issue().workProducts[0], metadata: {
      source: "jules", producer: ["from todo with a cleared Jules monitor", "from compact unassigned todo projection"].includes(parentCardState)
        ? "operator_reconciliation" : "paperclip-jules-adapter",
      headSha: parentCardState === "with a newer GitHub head than the registered product" ? "a".repeat(40) : headSha,
    } }] };
    let persistedIssue = ready;
    const childPosts: Array<Record<string, unknown>> = [];
    const childBootstrapPatches: Array<Record<string, unknown>> = [];
    const parentCardPosts: unknown[] = [];
    const issuePatches: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "POST" && href.endsWith(`/api/issues/${effectiveIssueId}/children`)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        childPosts.push(body);
        return new Response(JSON.stringify({ ...body, id: "review-child", companyId, parentId: effectiveIssueId,
          createdByAgentId: parentCardState === "from company timer without a maintenance issue" ? null : "orchestrator-1" }), { status: 201 });
      }
      if (method === "PATCH" && href.endsWith("/api/issues/review-child")) {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        childBootstrapPatches.push(patch);
        return new Response(JSON.stringify({ id: "review-child", companyId, parentId: effectiveIssueId,
          status: patch["status"], assigneeAgentId: patch["assigneeAgentId"] }));
      }
      if (method === "POST" && href.endsWith(`/api/issues/${effectiveIssueId}/interactions`)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body["kind"] === "request_item_verdicts") parentCardPosts.push(body);
        return new Response(JSON.stringify({ id: "wrong-parent-card" }), { status: 201 });
      }
      if (method === "PATCH" && href.endsWith(`/api/issues/${effectiveIssueId}`)) {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        issuePatches.push(patch);
        persistedIssue = { ...persistedIssue, ...patch };
        return new Response(JSON.stringify(persistedIssue));
      }
      if (method === "POST" && href.includes("/wakeup")) return new Response(JSON.stringify({ status: "started", runId: "bootstrap-run" }), { status: 202 });
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents(true)));
      if (href.includes("/projects")) return new Response(JSON.stringify([{ id: "project-1519", name: "fixture",
        primaryWorkspace: { cwd: process.cwd() } }]));
      if (method === "GET" && href.endsWith("/api/issues/maintenance-1519")) return new Response(JSON.stringify({ id: "maintenance-1519", projectId: null }));
      if (method === "GET" && href.endsWith(`/api/issues/${effectiveIssueId}`)) return new Response(JSON.stringify(persistedIssue));
      if (method === "GET" && href.endsWith(`/api/issues/${effectiveIssueId}/work-products`)) return new Response(JSON.stringify(ready.workProducts));
      if (method === "GET" && href.includes(`/api/companies/${companyId}/issues?`) && href.includes("parentId=")) return new Response(JSON.stringify([]));
      if (method === "GET" && href.endsWith(`/api/issues/${effectiveIssueId}/interactions`)) return new Response(JSON.stringify(
        ["with a pending parent card", "from todo with a cleared Jules monitor", "from compact unassigned todo projection"].includes(parentCardState) ? [{ id: "parent-pr-card", kind: "request_item_verdicts",
          status: "pending", createdByAgentId: null, addresseeAgentId: "luna-1",
          idempotencyKey: `pr-review:v13:${effectiveIssueId}:${prUrl}:${headSha}:luna` }] : [],
      ));
      if (href.includes(`/api/issues/${effectiveIssueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([]));
      if (method === "GET" && href.includes("/issues")) return new Response(JSON.stringify([
        parentCardState === "from compact unassigned todo projection"
          ? { ...persistedIssue, workProducts: undefined } : persistedIssue,
      ]));
      if (href.includes("/approvals")) return new Response(JSON.stringify([]));
      return new Response(JSON.stringify([]));
    }) as typeof fetch;

    const runContext = context();
    const result = await execute({ ...runContext,
      ...(parentCardState === "from company timer without a maintenance issue"
        ? { config: { ...runContext.config, apiUrl: "http://127.0.0.1:3100" } } : {}),
      context: parentCardState === "from company timer without a maintenance issue"
        ? { companyId } : { companyId, issueId: "maintenance-1519" },
      onLog: async (_stream, line) => { logs.push(line); } });

    expect(result.exitCode).toBe(0);
    expect(childPosts).toHaveLength(["without a parent card", "from company timer without a maintenance issue"].includes(parentCardState) ? 1 : 0);
    if (childPosts[0]) {
      expect(childPosts[0]).toMatchObject({ status: "backlog", assigneeAgentId: "orchestrator-1", blockParentUntilDone: false });
      if (parentCardState === "from company timer without a maintenance issue") {
        expect(String(childPosts[0]["description"])).toContain("paperclip-pr-review-child:v2");
        expect(childBootstrapPatches).toEqual([{ status: "todo", assigneeAgentId: "orchestrator-1" }]);
        expect(vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url).includes("/api/agents/orchestrator-1/wakeup"))).toHaveLength(0);
      }
    }
    expect(parentCardPosts).toEqual([]);
    expect(issuePatches.some((patch) => patch["status"] === "todo")).toBe(false);
    if (parentCardState === "with a newer GitHub head than the registered product") {
      expect(logs.join("\n")).toContain("registered PR head differs from GitHub");
    }
    if (parentCardState === "while Jules provider PR is not registered") {
      expect(logs.join("\n")).toContain("Jules PR work product is missing");
    }
    if (parentCardState === "from todo with a cleared Jules monitor" || parentCardState === "from compact unassigned todo projection") {
      expect(vi.mocked(globalThis.fetch).mock.calls.filter(([url, init]) => String(url).endsWith(`/api/issues/${effectiveIssueId}`) &&
        (init?.method ?? "GET") === "GET").length).toBeGreaterThan(0);
      expect(issuePatches).toContainEqual(expect.objectContaining({ status: "in_review", assigneeAgentId: null }));
    }
    if (parentCardState === "with a pending parent card" || parentCardState === "from todo with a cleared Jules monitor" || parentCardState === "from compact unassigned todo projection") {
      expect(logs.join("\n")).toContain("Preserving board-created parent PR card");
      const calls = vi.mocked(globalThis.fetch).mock.calls;
      expect(calls.filter(([url]) => String(url).includes("/api/agents/luna-1/wakeup"))).toHaveLength(0);
    }
  });

  it("bounds issue detail requests when a project has many terminal issues", async () => {
    const issues = Array.from({ length: 18 }, (_, index) => ({
      id: `terminal-${index}`, identifier: `MAZ-${index}`, title: `Finished ${index}`,
      status: "done", projectId: "project-1519", assigneeAgentId: null,
    }));
    let inFlight = 0;
    let peakInFlight = 0;
    let completed = 0;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents()));
      if (href.includes("/projects")) return new Response(JSON.stringify([
        { id: "project-1519", name: "fixture", primaryWorkspace: { cwd: process.cwd() } },
      ]));
      if ((init?.method ?? "GET") === "GET" && /\/api\/issues\/terminal-\d+$/.test(href)) {
        const id = href.split("/").at(-1);
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight--;
        completed++;
        return new Response(JSON.stringify(issues.find((item) => item.id === id)));
      }
      if (href.includes("/issues") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify(issues));
      }
      return new Response(JSON.stringify([]));
    }) as typeof fetch;

    await execute(context());

    expect(completed).toBe(18);
    expect(peakInFlight).toBeLessThanOrEqual(6);
  });

  it("fails closed when a required issue detail cannot be read", async () => {
    const logs: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents()));
      if (href.includes("/projects")) return new Response(JSON.stringify([
        { id: "project-1519", name: "fixture", primaryWorkspace: { cwd: process.cwd() } },
      ]));
      if ((init?.method ?? "GET") === "GET" && href.endsWith("/api/issues/unavailable")) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      if (href.includes("/issues") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify([{
          id: "unavailable", identifier: "MAZ-503", title: "Needs PR observation",
          status: "in_review", projectId: "project-1519",
        }]));
      }
      return new Response(JSON.stringify([]));
    }) as typeof fetch;

    const result = await execute({
      ...context(),
      onLog: async (_stream, line) => { logs.push(line); },
    });

    expect(result.exitCode).toBe(1);
    expect(logs.some((line) => line.includes("unavailable") && line.includes("issue detail"))).toBe(true);
  });

  it("creates one merge approval after answered current-head cards despite a lingering reviewer run", async () => {
    const approvals: unknown[] = [];
    const logs: string[] = [];
    const cards = [approvedCard("luna", "luna-1", "luna-card"), approvedCard("strong", "gemini-1", "gemini-card")];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents(true)));
      if (href.includes("/projects")) return new Response(JSON.stringify([{ id: "project-1519", name: "fixture", primaryWorkspace: { cwd: process.cwd() } }]));
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify(issue()));
      if (href.includes(`/api/issues/${issueId}/interactions`)) return new Response(JSON.stringify(cards));
      if (href.includes(`/api/issues/${issueId}/children`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([
        { id: "stale-gemini-run", agentId: "gemini-1", issueId, interactionId: "gemini-card", status: "running" },
      ]));
      if (href.includes("/issues") && method === "GET") return new Response(JSON.stringify([issue()]));
      if (href.includes("/approvals") && method === "POST") {
        approvals.push(JSON.parse(String(init?.body || "{}")));
        return new Response(JSON.stringify({ id: "merge-approval-1", status: "pending" }), { status: 201 });
      }
      if (href.includes("/approvals")) return new Response(JSON.stringify([{
        id: "unrelated-pr-number-collision",
        type: "request_board_approval",
        status: "pending",
        payload: {
          action: "task_merge",
          issueId: "unrelated-issue",
          prNumber: 3,
          prUrl: "https://github.com/Pilleo/paperclip-adapters/pull/3",
        },
      }]));
      return new Response(JSON.stringify([]));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await execute({ ...context(), onLog: async (_stream, line) => { logs.push(line); } });

    expect(result.exitCode).toBe(0);
    expect(approvals, logs.join("\n")).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      type: "request_board_approval",
      issueIds: [issueId],
      payload: { action: "task_merge", issueId, prNumber: 3, prUrl },
    });
    const reviewerDialogs = fetchMock.mock.calls.filter(([url, init]) => {
      if ((init?.method || "GET").toUpperCase() !== "POST" || !String(url).includes("/interactions")) return false;
      return JSON.parse(String(init?.body || "{}"))["kind"] === "request_item_verdicts";
    });
    expect(reviewerDialogs).toEqual([]);
    expect(logs.join("\n")).toContain("[Review outcome] [MAZ-1519] pipeline:CREATE_MERGE_APPROVAL");
  });

  it("recovers one overdue orphaned Luna card through one interaction-bound public wake", async () => {
    const interactions = [{
      id: "orphaned-luna-card",
      kind: "request_item_verdicts",
      status: "pending",
      continuationPolicy: "none",
      addresseeAgentId: "luna-1",
      idempotencyKey: `pr-review:v13:${issueId}:${prUrl}:${headSha}:luna`,
      createdAt: "2026-09-20T10:00:00.000Z",
    }];
    const withdrawals: string[] = [];
    const creations: Record<string, unknown>[] = [];
    const reviewerWakes: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (href.includes("/agents/") && href.endsWith("/wakeup") && method === "POST") {
        reviewerWakes.push(JSON.parse(String(init?.body || "{}")));
        return new Response(JSON.stringify({ id: "luna-recovery-run", status: "queued" }), { status: 202 });
      }
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents()));
      if (href.includes("/projects")) return new Response(JSON.stringify([{ id: "project-1519", name: "fixture", primaryWorkspace: { cwd: process.cwd() } }]));
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify(issue()));
      if (method === "POST" && href.endsWith(`/api/issues/${issueId}/interactions/orphaned-luna-card/withdraw`)) {
        withdrawals.push("orphaned-luna-card");
        interactions[0]!.status = "cancelled";
        return new Response(JSON.stringify({ id: "orphaned-luna-card", status: "cancelled" }));
      }
      if (method === "POST" && href.endsWith(`/api/issues/${issueId}/interactions`)) {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        if (body["kind"] === "request_item_verdicts") creations.push(body);
        return new Response(JSON.stringify({ id: body["kind"] === "request_item_verdicts" ? "replacement-luna-card" : "other-card", status: "pending" }), { status: 201 });
      }
      if (href.endsWith(`/api/issues/${issueId}/interactions`)) return new Response(JSON.stringify(interactions));
      if (href.includes(`/api/issues/${issueId}/children`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (method === "PATCH" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify(issue()));
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([]));
      if (href.includes("/issues") && method === "GET") return new Response(JSON.stringify([issue()]));
      if (href.includes("/approvals")) return new Response(JSON.stringify([]));
      return new Response(JSON.stringify([]));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await execute(context());
    const repeated = await execute(context());

    expect(result.exitCode).toBe(0);
    expect(repeated.exitCode).toBe(0);
    expect(withdrawals).toEqual([]);
    expect(creations).toEqual([]);
    expect(reviewerWakes).toEqual([{
      source: "automation",
      triggerDetail: "system",
      reason: "native_review_dispatch_recovery",
      forceFreshSession: true,
      payload: {
        issueId,
        mutation: "interaction",
        interactionId: "orphaned-luna-card",
        interactionKind: "request_item_verdicts",
      },
    }]);
  });

  it("keeps a red Jules PR in provider remediation for the whole heartbeat", async () => {
    const redIssueId = "issue-red-ci";
    const redIssue = {
      ...issue(),
      id: redIssueId,
      identifier: "MAZ-red-ci",
      status: "in_progress",
      assigneeAgentId: "jules-1",
      executionPolicy: null,
    };
    vi.mocked(checkPrCiIsGreen).mockResolvedValue({ isGreen: false, status: "failure" });
    const patches: Record<string, unknown>[] = [];
    const wakes: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (href.includes("/agents/jules-1/wakeup") && method === "POST") {
        wakes.push(JSON.parse(String(init?.body || "{}")));
        return new Response(JSON.stringify({ status: "started" }), { status: 202 });
      }
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents()));
      if (href.includes("/projects")) return new Response(JSON.stringify([{ id: "project-1519", name: "fixture", primaryWorkspace: { cwd: process.cwd() } }]));
      if (method === "GET" && href.endsWith(`/api/issues/${redIssueId}`)) return new Response(JSON.stringify(redIssue));
      if (href.endsWith(`/api/issues/${redIssueId}/documents`)) return new Response(JSON.stringify([{
        key: "jules-session",
        body: `julesSessionId: session-red-ci\nprUrl: ${prUrl}\nprHeadSha: ${headSha}`,
      }]));
      if (href.includes(`/api/issues/${redIssueId}/interactions`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${redIssueId}/children`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${redIssueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (method === "PATCH" && href.endsWith(`/api/issues/${redIssueId}`)) {
        patches.push(JSON.parse(String(init?.body || "{}")));
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([]));
      if (href.includes("/issues") && method === "GET") return new Response(JSON.stringify([redIssue]));
      if (href.includes("/approvals")) return new Response(JSON.stringify([]));
      return new Response(JSON.stringify([]));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await execute(context());

    expect(result.exitCode).toBe(0);
    expect(patches).toContainEqual(expect.objectContaining({
      status: "in_progress",
      assigneeAgentId: "jules-1",
      executionPolicy: expect.objectContaining({ monitor: expect.objectContaining({ serviceName: "jules", externalRef: "session-red-ci" }) }),
    }));
    expect(patches).not.toContainEqual(expect.objectContaining({ status: "in_review" }));
    expect(wakes).toHaveLength(1);
  });

  it("hands a completed Jules PR producer to native review instead of retaining its stale monitor", async () => {
    const terminalProducerRunId = "jules-pr-producer";
    const terminalIssue = {
      ...issue(),
      status: "in_progress",
      assigneeAgentId: "jules-1",
      executionPolicy: {
        mode: "normal",
        stages: [],
        monitor: {
          kind: "external_service",
          serviceName: "jules",
          externalRef: "session-pr-11",
          nextCheckAt: "2026-09-21T09:31:46.000Z",
        },
      },
      executionState: { status: "idle", monitor: { kind: "external_service", serviceName: "jules", status: "scheduled" } },
      workProducts: [{
        ...issue().workProducts[0],
        id: "work-product-terminal-handoff",
        createdByRunId: terminalProducerRunId,
        metadata: { source: "jules", producer: "paperclip-jules-adapter", headSha },
      }],
    };
    let persistedIssue = terminalIssue;
    const patches: Record<string, unknown>[] = [];
    const wakes: string[] = [];
    const logs: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "POST" && href.includes("/wakeup")) {
        wakes.push(href);
        return new Response(JSON.stringify({ status: "started" }), { status: 202 });
      }
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents()));
      if (href.includes("/projects")) return new Response(JSON.stringify([{ id: "project-1519", name: "fixture", primaryWorkspace: { cwd: process.cwd() } }]));
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify(persistedIssue));
      if (method === "PATCH" && href.endsWith(`/api/issues/${issueId}`)) {
        const patch = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        patches.push(patch);
        persistedIssue = { ...persistedIssue, ...patch };
        return new Response(JSON.stringify(persistedIssue));
      }
      if (href.includes(`/api/issues/${issueId}/interactions`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/children`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (method === "GET" && href.endsWith(`/api/heartbeat-runs/${terminalProducerRunId}`)) return new Response(JSON.stringify({
        id: terminalProducerRunId,
        agentId: "jules-1",
        status: "succeeded",
        startedAt: "2026-09-21T09:16:30.000Z",
        finishedAt: "2026-09-21T09:16:46.000Z",
        contextSnapshot: { issueId },
        resultJson: {
          provider: "jules",
          julesSessionId: "session-pr-11",
          julesState: "COMPLETED",
          stopReason: "completed",
          pending: true,
          retryNotBefore: "2099-09-21T09:31:46.000Z",
        },
      }));
      // Paperclip's list endpoint omits `resultJson`; the recovery decision
      // must hydrate the exact work-product producer rather than treating a
      // lossy list projection as an active provider session.
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([{
        id: terminalProducerRunId,
        agentId: "jules-1",
        status: "succeeded",
        startedAt: "2026-09-21T09:16:30.000Z",
        finishedAt: "2026-09-21T09:16:46.000Z",
        resultJson: null,
      }]));
      if (method === "GET" && href.includes("/issues")) return new Response(JSON.stringify([persistedIssue]));
      if (method === "GET" && href.includes("/approvals")) return new Response(JSON.stringify([]));
      return new Response(JSON.stringify([]));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(execute({ ...context(), onLog: async (_stream, line) => { logs.push(line); } })).resolves.toMatchObject({ exitCode: 0 });

    expect(patches).toContainEqual({
      status: "in_review",
      assigneeAgentId: null,
      executionPolicy: null,
      executionState: null,
    });
    expect(wakes).toEqual([]);
    expect(logs.join("\n")).toContain("Recovered open Jules PR for [MAZ-1519] into native review.");
  });

  it("invalidates only the matching pending merge approval after GitHub confirms an external merge", async () => {
    const logs: string[] = [];
    const mergedIssue = {
      ...issue(),
      workProducts: [{
        ...issue().workProducts[0],
        id: "work-product-1519",
      }],
    };
    let persistedIssue = mergedIssue;
    vi.mocked(fetchGitHubPullRequests).mockResolvedValue({
      openPrs: [],
      mergedPrs: [{
        number: 3,
        title: "MAZ-1519 Jules PR",
        state: "MERGED",
        headRefName: "jules/1519",
        headRefOid: headSha,
        baseRefName: "main",
        mergedAt: "2026-09-16T12:39:29Z",
        url: prUrl,
        files: [],
      }],
      openPrFiles: new Set(),
    });
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents()));
      if (href.includes("/projects")) return new Response(JSON.stringify([{ id: "project-1519", name: "fixture", primaryWorkspace: { cwd: process.cwd() } }]));
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify(persistedIssue));
      if (href.includes(`/api/issues/${issueId}/comments`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/interactions`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/children`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([]));
      if (method === "GET" && href.includes("/issues")) return new Response(JSON.stringify([persistedIssue]));
      if (method === "GET" && href.includes("/approvals")) {
        return new Response(JSON.stringify([{
          id: "approval-wrong-pr",
          type: "request_board_approval",
          status: "pending",
          issueIds: [issueId],
          payload: {
            action: "task_merge",
            issueId,
            prNumber: 3,
            prUrl: "https://github.com/Pilleo/another-repository/pull/3",
          },
        }, {
          id: "approval-1519",
          type: "request_board_approval",
          status: "pending",
          issueIds: [issueId],
          payload: { action: "task_merge", issueId, prNumber: 3, prUrl },
        }]));
      }
      if (method === "POST" && href.endsWith("/api/approvals/approval-1519/reject")) {
        return new Response(JSON.stringify({ id: "approval-1519", status: "rejected" }));
      }
      if (method === "PATCH" && href.endsWith(`/api/issues/${issueId}`)) {
        persistedIssue = { ...persistedIssue, ...JSON.parse(String(init?.body || "{}")) };
        return new Response(JSON.stringify(persistedIssue));
      }
      if (method === "PATCH" && href.endsWith("/api/work-products/work-product-1519")) return new Response(JSON.stringify({}));
      return new Response(JSON.stringify([]));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(execute({ ...context(), onLog: async (_stream, line) => { logs.push(line); } })).resolves.toMatchObject({ exitCode: 0 });

    const rejectCalls = fetchMock.mock.calls.filter(([url, init]) =>
      String(url).endsWith("/api/approvals/approval-1519/reject") && (init?.method || "GET").toUpperCase() === "POST",
    );
    expect(rejectCalls).toHaveLength(1);
    expect(JSON.parse(String((rejectCalls[0]?.[1] as RequestInit).body))).toEqual({
      decisionNote: "Superseded automatically: GitHub confirmed PR #3 is merged. This is not a rejection of the implementation.",
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/interactions"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/wakeup"))).toBe(false);
    expect(logs.join("\n")).toContain("invalidated stale final merge approval approval-1519");
  });

  it("hydrates a registered PR outside the discovery window before invalidating its stale merge approval", async () => {
    const logs: string[] = [];
    const mergedIssue = {
      ...issue(),
      status: "done",
      workProducts: [{ ...issue().workProducts[0], id: "work-product-outside-window", status: "merged", reviewState: "approved" }],
    };
    let persistedIssue = mergedIssue;
    vi.mocked(fetchGitHubPullRequests).mockResolvedValue({ openPrs: [], mergedPrs: [], openPrFiles: new Set() });
    vi.mocked(fetchGitHubPullRequest).mockResolvedValue({
      number: 3, title: "MAZ-1519 Jules PR", state: "MERGED", headRefName: "jules/1519", headRefOid: headSha,
      baseRefName: "main", mergedAt: "2026-09-16T12:39:30Z", url: prUrl, files: [],
    });
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents()));
      if (href.includes("/projects")) return new Response(JSON.stringify([{ id: "project-1519", name: "fixture", primaryWorkspace: { cwd: process.cwd() } }]));
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify(persistedIssue));
      if (href.includes(`/api/issues/${issueId}/comments`)) return new Response(JSON.stringify([{ body: "merge audit already recorded" }]));
      if (href.includes(`/api/issues/${issueId}/interactions`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/children`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([]));
      if (method === "GET" && href.includes("/issues")) return new Response(JSON.stringify([persistedIssue]));
      if (method === "GET" && href.includes("/approvals")) return new Response(JSON.stringify([{
        id: "approval-outside-window", type: "request_board_approval", status: "pending", issueIds: [issueId],
        payload: { action: "task_merge", issueId, prNumber: 3, prUrl },
      }]));
      if (method === "POST" && href.endsWith("/api/approvals/approval-outside-window/reject")) return new Response(JSON.stringify({ id: "approval-outside-window", status: "rejected" }));
      if (method === "PATCH" && href.endsWith(`/api/issues/${issueId}`)) {
        persistedIssue = { ...persistedIssue, ...JSON.parse(String(init?.body || "{}")) };
        return new Response(JSON.stringify(persistedIssue));
      }
      return new Response(JSON.stringify([]));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(execute({ ...context(), onLog: async (_stream, line) => { logs.push(line); } })).resolves.toMatchObject({ exitCode: 0 });

    expect(fetchGitHubPullRequest).toHaveBeenCalledWith(process.cwd(), prUrl);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/api/approvals/approval-outside-window/reject") && (init?.method || "GET").toUpperCase() === "POST",
    )).toBe(true);
    expect(logs.join("\n")).not.toContain("Failed to reconcile merged issue");
  });

  it("directly reconciles an omitted merged PR before host review recovery can revive its blocked task", async () => {
    const mergedIssue = {
      ...issue(),
      status: "blocked",
      assigneeAgentId: "luna-1",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{ type: "review", participants: [{ type: "agent", agentId: "luna-1" }] }],
      },
      executionState: { status: "pending", currentStage: "luna" },
      workProducts: [{
        ...issue().workProducts[0],
        id: "work-product-blocked-merged",
        status: "ready_for_review",
        reviewState: "none",
      }],
    };
    let persistedIssue = mergedIssue;
    const issuePatches: Record<string, unknown>[] = [];
    const cancelledRunIds: string[] = [];
    vi.mocked(fetchGitHubPullRequests).mockResolvedValue({ openPrs: [], mergedPrs: [], openPrFiles: new Set() });
    vi.mocked(fetchGitHubPullRequest).mockResolvedValue({
      number: 3, title: "MAZ-1519 Jules PR", state: "MERGED", headRefName: "jules/1519", headRefOid: headSha,
      baseRefName: "main", mergedAt: "2026-09-21T07:13:23Z", url: prUrl, files: [],
    });
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents()));
      if (href.includes("/projects")) return new Response(JSON.stringify([{ id: "project-1519", name: "fixture", primaryWorkspace: { cwd: process.cwd() } }]));
      if (method === "POST" && href.endsWith("/api/heartbeat-runs/host-luna-run/cancel")) {
        cancelledRunIds.push("host-luna-run");
        return new Response(JSON.stringify({ id: "host-luna-run", status: "cancelled" }));
      }
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify(persistedIssue));
      if (method === "PATCH" && href.endsWith(`/api/issues/${issueId}`)) {
        const patch = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        issuePatches.push(patch);
        persistedIssue = { ...persistedIssue, ...patch };
        return new Response(JSON.stringify(persistedIssue));
      }
      if (method === "PATCH" && href.endsWith("/api/work-products/work-product-blocked-merged")) return new Response(JSON.stringify({}));
      if (href.includes(`/api/issues/${issueId}/comments`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/interactions`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/children`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([
        { id: "host-luna-run", agentId: "luna-1", status: "running", contextSnapshot: { issueId } },
      ]));
      if (method === "GET" && href.includes("/issues")) return new Response(JSON.stringify([persistedIssue]));
      if (method === "GET" && href.includes("/approvals")) return new Response(JSON.stringify([]));
      if (href.includes("/wakeup") || href.includes("/interactions") && method === "POST") {
        return new Response(JSON.stringify({ error: "a merged task must not wake an executor or reviewer" }), { status: 500 });
      }
      return new Response(JSON.stringify([]));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(execute(context())).resolves.toMatchObject({ exitCode: 0 });

    expect(fetchGitHubPullRequest).toHaveBeenCalledWith(process.cwd(), prUrl);
    expect(cancelledRunIds).toEqual(["host-luna-run"]);
    expect(issuePatches).toContainEqual({
      status: "done",
      assigneeAgentId: null,
      executionPolicy: null,
      executionState: null,
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/wakeup"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).includes("/interactions") && (init?.method || "GET").toUpperCase() === "POST",
    )).toBe(false);
  });

  it("retries failed stale-approval invalidation without reviving a merged task", async () => {
    const logs: string[] = [];
    const mergedIssue = {
      ...issue(),
      workProducts: [{ ...issue().workProducts[0], id: "work-product-retry" }],
    };
    let persistedIssue = mergedIssue;
    vi.mocked(fetchGitHubPullRequests).mockResolvedValue({
      openPrs: [],
      mergedPrs: [{
        number: 3, title: "MAZ-1519 Jules PR", state: "MERGED", headRefName: "jules/1519", headRefOid: headSha,
        baseRefName: "main", mergedAt: "2026-09-16T12:40:29Z", url: prUrl, files: [],
      }],
      openPrFiles: new Set(),
    });
    let rejectAttempts = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents()));
      if (href.includes("/projects")) return new Response(JSON.stringify([{ id: "project-1519", name: "fixture", primaryWorkspace: { cwd: process.cwd() } }]));
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify(persistedIssue));
      if (href.includes(`/api/issues/${issueId}/comments`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/interactions`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/children`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([]));
      if (method === "GET" && href.includes("/issues")) return new Response(JSON.stringify([persistedIssue]));
      if (method === "GET" && href.includes("/approvals")) return new Response(JSON.stringify([{
        id: "approval-retry", type: "request_board_approval", status: "pending", issueIds: [issueId],
        payload: { action: "task_merge", issueId, prNumber: 3, prUrl },
      }]));
      if (method === "POST" && href.endsWith("/api/approvals/approval-retry/reject")) {
        rejectAttempts++;
        return rejectAttempts === 1
          ? new Response('{"error":"board decision forbidden"}', { status: 403 })
          : new Response(JSON.stringify({ id: "approval-retry", status: "rejected" }));
      }
      if (method === "PATCH" && href.endsWith(`/api/issues/${issueId}`)) {
        persistedIssue = { ...persistedIssue, ...JSON.parse(String(init?.body || "{}")) };
        return new Response(JSON.stringify(persistedIssue));
      }
      if (method === "PATCH" && href.endsWith("/api/work-products/work-product-retry")) return new Response(JSON.stringify({}));
      return new Response(JSON.stringify([]));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(execute({ ...context(), onLog: async (_stream, line) => { logs.push(line); } })).resolves.toMatchObject({ exitCode: 0 });
    await expect(execute({ ...context(), onLog: async (_stream, line) => { logs.push(line); } })).resolves.toMatchObject({ exitCode: 0 });

    expect(rejectAttempts).toBe(2);
    expect(persistedIssue.status).toBe("done");
    expect(logs.join("\n")).toContain("The task will remain terminal and cleanup will retry.");
    expect(logs.join("\n")).toContain("invalidated stale final merge approval approval-retry");
    expect(logs.join("\n")).not.toContain("Failed to reconcile merged issue");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/wakeup"))).toBe(false);
  });
});
