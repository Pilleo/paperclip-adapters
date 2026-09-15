import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

vi.mock("../src/core/github-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/github-sync.js")>();
  return {
    ...actual,
    fetchGitHubPullRequests: vi.fn(),
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
    expect(approvals).toHaveLength(1);
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
});
