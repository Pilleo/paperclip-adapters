import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute.js";

const issueId = "issue-plan-1";
const terraCardId = "terra-plan-card-1";

function context(): AdapterExecutionContext {
  return {
    runId: "orchestrator-run-1",
    agent: { id: "orchestrator-1", companyId: "company-1", name: "Orchestrator", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null },
    config: { workspacePath: process.cwd(), apiUrl: "https://paperclip.test" },
    context: { companyId: "company-1" },
    onLog: vi.fn().mockResolvedValue(undefined),
  } as AdapterExecutionContext;
}

describe("orchestrator Jules plan native-review recovery", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env["PAPERCLIP_API_KEY"];
  const originalHome = process.env["PAPERCLIP_HOME"];
  let paperclipHome = "";

  beforeEach(() => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
    paperclipHome = mkdtempSync(path.join(tmpdir(), "paperclip-plan-review-recovery-"));
    process.env["PAPERCLIP_HOME"] = paperclipHome;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env["PAPERCLIP_API_KEY"];
    else process.env["PAPERCLIP_API_KEY"] = originalKey;
    if (originalHome === undefined) delete process.env["PAPERCLIP_HOME"];
    else process.env["PAPERCLIP_HOME"] = originalHome;
    rmSync(paperclipHome, { recursive: true, force: true });
  });

  it("wakes an overdue addressed Terra plan card without changing the Jules issue projection", async () => {
    const patches: unknown[] = [];
    const comments: unknown[] = [];
    const wakes: unknown[] = [];
    const createdAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const issue = {
      id: issueId,
      identifier: "MAZ-1519",
      title: "plan recovery canary",
      description: "---\norchestrator_managed: true\n---\nRecover the typed Jules plan card.",
      status: "in_progress",
      projectId: "project-1",
      assigneeAgentId: "jules-1",
      updatedAt: createdAt,
      executionState: {
        status: "idle",
        monitor: {
          kind: "external_service",
          serviceName: "jules",
          status: "scheduled",
          nextCheckAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          timeoutAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        },
      },
      executionPolicy: {
        mode: "normal",
        stages: [],
        monitor: {
          kind: "external_service",
          serviceName: "jules",
          status: "scheduled",
          externalRef: "jules-session-1",
          nextCheckAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          timeoutAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        },
      },
    };
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "POST" && href.includes("/agents/terra-1/wakeup")) {
        wakes.push(JSON.parse(String(init?.body || "{}")));
        return new Response(JSON.stringify({ status: "started" }), { status: 202 });
      }
      if (method === "PATCH" && href.includes(`/api/issues/${issueId}`)) {
        patches.push(JSON.parse(String(init?.body || "{}")));
        return new Response("{}", { status: 200 });
      }
      if (method === "POST" && href.includes(`/api/issues/${issueId}/comments`)) {
        comments.push(JSON.parse(String(init?.body || "{}")));
        return new Response("{}", { status: 201 });
      }
      if (href.includes(`/api/issues/${issueId}/comments`)) {
        return new Response(JSON.stringify([{ id: "jules-session-link", body: "[Open Jules session](https://jules.google.com/session/1)" }]), { status: 200 });
      }
      if (href.includes(`/api/issues/${issueId}/interactions`)) {
        return new Response(JSON.stringify([{
          id: terraCardId,
          kind: "request_item_verdicts",
          status: "pending",
          addresseeAgentId: "terra-1",
          createdAt,
          idempotencyKey: `jules:plan-review:v2:${issueId}:session-1:revision-1:terra`,
        }]), { status: 200 });
      }
      if (href.includes("/heartbeat-runs")) return new Response("[]", { status: 200 });
      if (href.endsWith("/agents") || href.includes("/agents?")) {
        return new Response(JSON.stringify([
          { id: "jules-1", name: "Jules", adapterType: "jules", status: "idle", reportsTo: "orchestrator-1", metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" } },
          { id: "luna-1", name: "Luna", adapterType: "codex_local", status: "idle", reportsTo: "orchestrator-1", metadata: { managedBy: "paperclip-orchestrator", workerKey: "luna_reviewer", structuredDecisionCapability: { version: 1, transports: ["mcp_tool"], decisionKinds: ["plan_review", "pull_request_review"] } } },
          { id: "terra-1", name: "Terra", adapterType: "codex_local", status: "idle", reportsTo: "orchestrator-1", metadata: { managedBy: "paperclip-orchestrator", workerKey: "terra_reviewer", structuredDecisionCapability: { version: 1, transports: ["mcp_tool"], decisionKinds: ["plan_review", "pull_request_review"] } } },
        ]), { status: 200 });
      }
      if (href.includes("/projects")) return new Response(JSON.stringify([
        { id: "project-1", name: "fixture", primaryWorkspace: { cwd: process.cwd() } },
      ]), { status: 200 });
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify(issue), { status: 200 });
      if (href.includes("/issues")) return new Response(JSON.stringify([issue]), { status: 200 });
      if (href.includes("/approvals")) return new Response("[]", { status: 200 });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const result = await execute(context());

    expect(result.exitCode).toBe(0);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      // Paperclip v831 permits an addressed foreign reviewer only for a
      // recognized comment-origin wake. The anchor is the existing Jules
      // session-link comment; recovery never posts a fresh comment.
      reason: "issue_commented",
      forceFreshSession: true,
      payload: {
        issueId,
        interactionId: terraCardId,
        interactionKind: "request_item_verdicts",
        commentId: "jules-session-link",
      },
    });
    expect(patches).not.toContainEqual(expect.objectContaining({ status: expect.anything() }));
    expect(patches).not.toContainEqual(expect.objectContaining({ assigneeAgentId: expect.anything() }));
    expect(comments).toEqual([]);

    await execute(context());
    expect(wakes).toHaveLength(1);
    expect(comments).toEqual([]);
  });

  it("does not emit a compatibility wake when the addressed card is answered during final revalidation", async () => {
    const wakes: unknown[] = [];
    const comments: unknown[] = [];
    const createdAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const answeredIssueId = "issue-plan-answered-before-wake";
    const answeredCardId = "terra-plan-card-answered-before-wake";
    let terraRunReads = 0;
    const issue = {
      id: answeredIssueId,
      identifier: "MAZ-answered-race",
      title: "final card revalidation canary",
      description: "---\norchestrator_managed: true\n---\nDo not wake an already answered card.",
      status: "in_progress",
      projectId: "project-1",
      assigneeAgentId: "jules-1",
      updatedAt: createdAt,
      executionState: { status: "idle" },
      executionPolicy: { mode: "normal", stages: [] },
    };
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "POST" && href.includes("/agents/terra-1/wakeup")) {
        wakes.push(JSON.parse(String(init?.body || "{}")));
        return new Response(JSON.stringify({ status: "started" }), { status: 202 });
      }
      if (method === "POST" && href.includes(`/api/issues/${answeredIssueId}/comments`)) {
        comments.push(JSON.parse(String(init?.body || "{}")));
        return new Response("{}", { status: 201 });
      }
      if (href.includes(`/api/issues/${answeredIssueId}/comments`)) {
        return new Response(JSON.stringify([{ id: "jules-session-link", body: "[Open Jules session](https://jules.google.com/session/1)" }]), { status: 200 });
      }
      if (href.includes("/heartbeat-runs")) {
        if (href.includes("agentId=terra-1")) terraRunReads++;
        return new Response("[]", { status: 200 });
      }
      if (href.includes(`/api/issues/${answeredIssueId}/interactions`)) {
        return new Response(JSON.stringify([{
          id: answeredCardId,
          kind: "request_item_verdicts",
          // The scheduler saw the pending card. The final read, made only
          // after the exact Terra run read, sees Paperclip's verdict.
          status: terraRunReads >= 1 ? "answered" : "pending",
          addresseeAgentId: "terra-1",
          createdAt,
          idempotencyKey: `jules:plan-review:v2:${answeredIssueId}:session-1:revision-1:terra`,
        }]), { status: 200 });
      }
      if (href.endsWith("/agents") || href.includes("/agents?")) {
        return new Response(JSON.stringify([
          { id: "jules-1", name: "Jules", adapterType: "jules", status: "idle", reportsTo: "orchestrator-1", metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" } },
          { id: "luna-1", name: "Luna", adapterType: "codex_local", status: "idle", reportsTo: "orchestrator-1", metadata: { managedBy: "paperclip-orchestrator", workerKey: "luna_reviewer", structuredDecisionCapability: { version: 1, transports: ["mcp_tool"], decisionKinds: ["plan_review", "pull_request_review"] } } },
          { id: "terra-1", name: "Terra", adapterType: "codex_local", status: "idle", reportsTo: "orchestrator-1", metadata: { managedBy: "paperclip-orchestrator", workerKey: "terra_reviewer", structuredDecisionCapability: { version: 1, transports: ["mcp_tool"], decisionKinds: ["plan_review", "pull_request_review"] } } },
        ]), { status: 200 });
      }
      if (href.includes("/projects")) return new Response(JSON.stringify([{ id: "project-1", name: "fixture", primaryWorkspace: { cwd: process.cwd() } }]), { status: 200 });
      if (method === "GET" && href.endsWith(`/api/issues/${answeredIssueId}`)) return new Response(JSON.stringify(issue), { status: 200 });
      if (href.includes("/issues")) return new Response(JSON.stringify([issue]), { status: 200 });
      if (href.includes("/approvals")) return new Response("[]", { status: 200 });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const result = await execute(context());

    expect(result.exitCode).toBe(0);
    expect(terraRunReads).toBeGreaterThanOrEqual(1);
    expect(wakes).toEqual([]);
    expect(comments).toEqual([]);
  });
});
