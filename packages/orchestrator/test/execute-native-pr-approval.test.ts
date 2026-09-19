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

function managedAgents() {
  return [
    { id: "jules-1", name: "Jules", adapterType: "jules", status: "idle", reportsTo: "orchestrator-1", metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" } },
    { id: "luna-1", name: "Luna", adapterType: "codex_local", status: "idle", reportsTo: "orchestrator-1", metadata: { managedBy: "paperclip-orchestrator", workerKey: "luna_reviewer", structuredDecisionCapability: { version: 1, transports: ["mcp_tool"], decisionKinds: ["pull_request_review"] } } },
    { id: "terra-1", name: "Terra", adapterType: "codex_local", status: "idle", reportsTo: "orchestrator-1", metadata: { managedBy: "paperclip-orchestrator", workerKey: "terra_reviewer", structuredDecisionCapability: { version: 1, transports: ["mcp_tool"], decisionKinds: ["pull_request_review"] } } },
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

function approvedCard(stage: "luna" | "terra", agentId: string, id: string) {
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

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (originalKey === undefined) delete process.env["PAPERCLIP_API_KEY"];
    else process.env["PAPERCLIP_API_KEY"] = originalKey;
  });

  it("creates one merge approval after answered current-head cards despite a lingering reviewer run", async () => {
    const approvals: unknown[] = [];
    const logs: string[] = [];
    const cards = [approvedCard("luna", "luna-1", "luna-card"), approvedCard("terra", "terra-1", "terra-card")];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents()));
      if (href.includes("/projects")) return new Response(JSON.stringify([{ id: "project-1519", name: "fixture", primaryWorkspace: { cwd: process.cwd() } }]));
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify(issue()));
      if (href.includes(`/api/issues/${issueId}/interactions`)) return new Response(JSON.stringify(cards));
      if (href.includes(`/api/issues/${issueId}/children`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([
        { id: "stale-terra-run", agentId: "terra-1", issueId, interactionId: "terra-card", status: "running" },
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

  it("invalidates only the matching pending merge approval after GitHub confirms an external merge", async () => {
    const logs: string[] = [];
    const mergedIssue = {
      ...issue(),
      workProducts: [{
        ...issue().workProducts[0],
        id: "work-product-1519",
      }],
    };
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
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify(mergedIssue));
      if (href.includes(`/api/issues/${issueId}/comments`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/interactions`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/children`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([]));
      if (method === "GET" && href.includes("/issues")) return new Response(JSON.stringify([mergedIssue]));
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
      if (method === "PATCH" && (href.endsWith(`/api/issues/${issueId}`) || href.endsWith("/api/work-products/work-product-1519"))) {
        return new Response(JSON.stringify({}));
      }
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
    const mergedIssue = {
      ...issue(),
      status: "done",
      workProducts: [{ ...issue().workProducts[0], id: "work-product-outside-window", status: "merged", reviewState: "approved" }],
    };
    vi.mocked(fetchGitHubPullRequests).mockResolvedValue({ openPrs: [], mergedPrs: [], openPrFiles: new Set() });
    vi.mocked(fetchGitHubPullRequest).mockResolvedValue({
      number: 3, title: "MAZ-1519 Jules PR", state: "MERGED", headRefName: "jules/1519", headRefOid: headSha,
      baseRefName: "main", mergedAt: "2026-09-16T12:39:29Z", url: prUrl, files: [],
    });
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (href.includes("/agents")) return new Response(JSON.stringify(managedAgents()));
      if (href.includes("/projects")) return new Response(JSON.stringify([{ id: "project-1519", name: "fixture", primaryWorkspace: { cwd: process.cwd() } }]));
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify(mergedIssue));
      if (href.includes(`/api/issues/${issueId}/comments`)) return new Response(JSON.stringify([{ body: "merge audit already recorded" }]));
      if (href.includes(`/api/issues/${issueId}/interactions`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/children`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([]));
      if (method === "GET" && href.includes("/issues")) return new Response(JSON.stringify([mergedIssue]));
      if (method === "GET" && href.includes("/approvals")) return new Response(JSON.stringify([{
        id: "approval-outside-window", type: "request_board_approval", status: "pending", issueIds: [issueId],
        payload: { action: "task_merge", issueId, prNumber: 3, prUrl },
      }]));
      if (method === "POST" && href.endsWith("/api/approvals/approval-outside-window/reject")) return new Response(JSON.stringify({ id: "approval-outside-window", status: "rejected" }));
      return new Response(JSON.stringify([]));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(execute(context())).resolves.toMatchObject({ exitCode: 0 });

    expect(fetchGitHubPullRequest).toHaveBeenCalledWith(process.cwd(), prUrl);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/api/approvals/approval-outside-window/reject") && (init?.method || "GET").toUpperCase() === "POST",
    )).toBe(true);
  });

  it("retries failed stale-approval invalidation without reviving a merged task", async () => {
    const logs: string[] = [];
    const mergedIssue = {
      ...issue(),
      workProducts: [{ ...issue().workProducts[0], id: "work-product-retry" }],
    };
    let persistedStatus = "in_review";
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
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify({ ...mergedIssue, status: persistedStatus }));
      if (href.includes(`/api/issues/${issueId}/comments`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/interactions`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/children`)) return new Response(JSON.stringify([]));
      if (href.includes(`/api/issues/${issueId}/recovery-actions`)) return new Response(JSON.stringify({ active: null }));
      if (href.includes("/heartbeat-runs")) return new Response(JSON.stringify([]));
      if (method === "GET" && href.includes("/issues")) return new Response(JSON.stringify([{ ...mergedIssue, status: persistedStatus }]));
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
        persistedStatus = JSON.parse(String(init?.body || "{}")).status || persistedStatus;
        return new Response(JSON.stringify({}));
      }
      if (method === "PATCH" && href.endsWith("/api/work-products/work-product-retry")) return new Response(JSON.stringify({}));
      return new Response(JSON.stringify([]));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(execute({ ...context(), onLog: async (_stream, line) => { logs.push(line); } })).resolves.toMatchObject({ exitCode: 0 });
    await expect(execute({ ...context(), onLog: async (_stream, line) => { logs.push(line); } })).resolves.toMatchObject({ exitCode: 0 });

    expect(rejectAttempts).toBe(2);
    expect(persistedStatus).toBe("done");
    expect(logs.join("\n")).toContain("The task will remain terminal and cleanup will retry.");
    expect(logs.join("\n")).toContain("invalidated stale final merge approval approval-retry");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/wakeup"))).toBe(false);
  });
});
