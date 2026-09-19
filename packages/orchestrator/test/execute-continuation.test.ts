import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execute } from "../src/server/execute.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

function ctx(): AdapterExecutionContext {
  return {
    runId: "run-orch",
    agent: {
      id: "orch-1",
      companyId: "co-1",
      name: "Task Orchestrator",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null },
    config: { workspacePath: process.cwd() },
    context: { companyId: "co-1" },
    onLog: vi.fn().mockResolvedValue(undefined),
  } as AdapterExecutionContext;
}

describe("orchestrator live session continuation", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env["PAPERCLIP_API_KEY"];

  beforeEach(() => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env["PAPERCLIP_API_KEY"];
    else process.env["PAPERCLIP_API_KEY"] = originalKey;
  });

  it("requests an issue-scoped managed Jules continuation when the poll is due", async () => {
    const wakeupBodies: unknown[] = [];
    const finishedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (href.includes("/agents") && href.includes("/wakeup") && method === "POST") {
        wakeupBodies.push(JSON.parse(String(init?.body || "{}")));
        return new Response("{}", { status: 202 });
      }
      if (href.includes("/heartbeat-runs")) {
        return new Response(
          JSON.stringify([
            {
              id: "hb-1",
              agentId: "jules-orch",
              status: "succeeded",
              startedAt: finishedAt,
              finishedAt,
              sessionIdBefore: "2024763132299585220",
              sessionIdAfter: "2024763132299585220",
              contextSnapshot: { issueId: "issue-821" },
              resultJson: { julesSessionId: "2024763132299585220", pending: true },
            },
          ]),
          { status: 200 }
        );
      }
      if (href.endsWith("/agents") || href.includes("/agents?")) {
        return new Response(
          JSON.stringify([
            {
              id: "jules-orch",
              name: "[Orchestrated] Jules Async Worker",
              adapterType: "jules",
              status: "idle",
              reportsTo: "orch-1",
              metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" },
            },
          ]),
          { status: 200 }
        );
      }
      if (href.includes("/projects")) {
        return new Response(JSON.stringify([
          { id: "project-1", name: "paperclip-adapters", primaryWorkspace: { cwd: process.cwd() } },
        ]), { status: 200 });
      }
      if (method === "GET" && href.endsWith("/api/issues/issue-821")) {
        return new Response(JSON.stringify({
          id: "issue-821",
          identifier: "MAZ-821",
          title: "PROBE: Jules reattach ping",
          status: "in_progress",
          projectId: "project-1",
          assigneeAgentId: "jules-orch",
          updatedAt: finishedAt,
        }), { status: 200 });
      }
      if (href.includes("/issues")) {
        return new Response(
          JSON.stringify([
            {
              id: "issue-821",
              identifier: "MAZ-821",
              title: "PROBE: Jules reattach ping",
              status: "in_progress",
              projectId: "project-1",
              assigneeAgentId: "jules-orch",
              updatedAt: finishedAt,
            },
          ]),
          { status: 200 }
        );
      }
      if (href.includes("/approvals")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === "POST" || method === "PATCH") {
        return new Response("{}", { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await execute(ctx());
    expect(result.exitCode).toBe(0);
    expect(wakeupBodies).toEqual([{
      source: "on_demand",
      triggerDetail: "ping",
      reason: "Poll supervised Jules session 2024763132299585220",
      forceFreshSession: false,
      payload: { issueId: "issue-821", resumeFromRunId: "hb-1" },
    }]);
    // The Jules adapter performed the explicit resume wake first, so the
    // generic continuation pass correctly finds no second session to wake.
    expect(String(result.summary)).toContain("continued 0 live sessions");
  });

  it("does not wake when retryNotBefore is still in the future", async () => {
    const wakeupUrls: string[] = [];
    const finishedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const retryNotBefore = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (href.includes("/wakeup")) {
        wakeupUrls.push(href);
        return new Response("{}", { status: 202 });
      }
      if (href.includes("/heartbeat-runs")) {
        return new Response(
          JSON.stringify([
            {
              id: "hb-1",
              agentId: "jules-orch",
              status: "succeeded",
              finishedAt,
              sessionIdAfter: "sess-live",
              contextSnapshot: { issueId: "issue-821" },
              resultJson: { julesSessionId: "sess-live", retryNotBefore },
            },
          ]),
          { status: 200 }
        );
      }
      if (href.includes("/agents")) {
        return new Response(
          JSON.stringify([
            {
              id: "jules-orch",
              name: "[Orchestrated] Jules Async Worker",
              adapterType: "jules",
              status: "idle",
              reportsTo: "orch-1",
              metadata: { managedBy: "paperclip-orchestrator" },
            },
          ]),
          { status: 200 }
        );
      }
      if (href.includes("/projects")) {
        return new Response(JSON.stringify([
          { id: "project-1", name: "paperclip-adapters", primaryWorkspace: { cwd: process.cwd() } },
        ]), { status: 200 });
      }
      if (href.includes("/issues")) {
        return new Response(
          JSON.stringify([
            {
              id: "issue-821",
              title: "ping",
              status: "in_progress",
              projectId: "project-1",
              assigneeAgentId: "jules-orch",
              updatedAt: finishedAt,
            },
          ]),
          { status: 200 }
        );
      }
      if (href.includes("/approvals")) return new Response("[]", { status: 200 });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const result = await execute(ctx());
    expect(result.exitCode).toBe(0);
    expect(wakeupUrls).toEqual([]);
    expect(String(result.summary)).toContain("continued 0 live sessions");
  });

  it("reattaches an expired native Jules monitor without creating a provider session", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const expired = new Date(Date.now() - 60_000).toISOString();
    const issue = {
      id: "issue-836",
      identifier: "MAZ-836",
      title: "native monitor canary",
      status: "blocked",
      projectId: "project-1",
      // Failed-run recovery can return ownership to the orchestrator before
      // this reducer restores the durable Jules monitor.
      assigneeAgentId: "orch-1",
      updatedAt: expired,
      executionPolicy: {
        mode: "normal",
        stages: [],
        monitor: {
          nextCheckAt: expired,
          timeoutAt: expired,
          serviceName: "jules",
          externalRef: "jules-session-836",
        },
      },
    };
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "PATCH" && href.includes("/api/issues/issue-836")) {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        patches.push(body);
        Object.assign(issue, body);
        return new Response("{}", { status: 200 });
      }
      if (href.includes("/heartbeat-runs")) return new Response("[]", { status: 200 });
      if (href.endsWith("/agents") || href.includes("/agents?")) {
        return new Response(JSON.stringify([{
          id: "jules-orch",
          name: "[Orchestrated] Jules Async Worker",
          adapterType: "jules",
          status: "idle",
          reportsTo: "orch-1",
          metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" },
        }]), { status: 200 });
      }
      if (href.includes("/projects")) return new Response(JSON.stringify([
        { id: "project-1", name: "paperclip-adapters", primaryWorkspace: { cwd: process.cwd() } },
      ]), { status: 200 });
      if (method === "GET" && href.endsWith("/api/issues/issue-836")) return new Response(JSON.stringify(issue), { status: 200 });
      if (href.includes("/issues")) return new Response(JSON.stringify([issue]), { status: 200 });
      if (href.includes("/approvals")) return new Response("[]", { status: 200 });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const result = await execute(ctx());
    expect(result.exitCode).toBe(0);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      status: "in_progress",
      // The monitor's recoveryPolicy wakes the issue owner. Reattachment must
      // therefore restore the Jules worker, not retain the orchestrator that
      // performed the recovery patch.
      assigneeAgentId: "jules-orch",
    });
    const monitor = (patches[0]?.executionPolicy as Record<string, unknown>)?.monitor as Record<string, unknown>;
    expect(monitor).toMatchObject({ serviceName: "jules", externalRef: "jules-session-836" });
    expect(Date.parse(String(monitor.nextCheckAt))).toBeGreaterThan(Date.now());
    expect(String(result.summary)).toContain("0 new dev tasks dispatched");

    await execute(ctx());
    expect(patches).toHaveLength(1);
  });

  it("reattaches a blocked detached Jules monitor atomically instead of issuing a bare orphan-unblock patch", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const issueId = "issue-1535";
    const sessionId = "jules-session-1535";
    const future = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const issue = {
      id: issueId,
      identifier: "MAZ-1535",
      title: "detached provider canary",
      status: "blocked",
      projectId: "project-1",
      assigneeAgentId: "jules-orch",
      updatedAt: new Date().toISOString(),
      executionState: {
        status: "idle",
        monitor: {
          kind: "external_service",
          serviceName: "jules",
          status: "triggered",
          externalRef: "[redacted]",
          timeoutAt: future,
          recoveryPolicy: "wake_owner",
        },
      },
      // Paperclip v2026.916.0 can retain the review stages while stripping
      // only the provider monitor. This is still a detached Jules monitor;
      // reattachment must preserve these stages.
      executionPolicy: {
        mode: "normal",
        stages: [{ id: "luna", type: "review", participants: [] }],
        commentRequired: true,
      },
    };
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "PATCH" && href.includes(`/api/issues/${issueId}`)) {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        patches.push(body);
        Object.assign(issue, body);
        return new Response("{}", { status: 200 });
      }
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}/documents`)) {
        return new Response(JSON.stringify([{
          key: "jules-session",
          body: `julesSessionId: ${sessionId}\nurl: https://jules.google.com/session/${sessionId}`,
        }]), { status: 200 });
      }
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) {
        return new Response(JSON.stringify(issue), { status: 200 });
      }
      if (href.includes("/heartbeat-runs")) return new Response("[]", { status: 200 });
      if (href.endsWith("/agents") || href.includes("/agents?")) {
        return new Response(JSON.stringify([{
          id: "jules-orch",
          name: "[Orchestrated] Jules Async Worker",
          adapterType: "jules",
          status: "idle",
          reportsTo: "orch-1",
          metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" },
        }]), { status: 200 });
      }
      if (href.includes("/projects")) return new Response(JSON.stringify([
        { id: "project-1", name: "paperclip-adapters", primaryWorkspace: { cwd: process.cwd() } },
      ]), { status: 200 });
      if (href.includes("/issues")) return new Response(JSON.stringify([issue]), { status: 200 });
      if (href.includes("/approvals")) return new Response("[]", { status: 200 });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const result = await execute(ctx());
    expect(result.exitCode).toBe(0);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      status: "in_progress",
      assigneeAgentId: "jules-orch",
      executionPolicy: {
        stages: [{ id: "luna", type: "review", participants: [] }],
        commentRequired: true,
        monitor: {
          serviceName: "jules",
          externalRef: sessionId,
          recoveryPolicy: "wake_owner",
        },
      },
    });
  });

  it("reconciles a terminal Jules polling blocker before attempting monitor reattachment", async () => {
    const issueId = "issue-1535-blocked";
    const recoveryActionId = "9e44e46e-a8eb-422f-a35a-236e3cad1cc0";
    const failedRunId = "c3c1a60e-12b1-4a7e-8cc3-79498b705f27";
    const sessionId = "jules-session-1535";
    const patches: Array<Record<string, unknown>> = [];
    const resolutions: Array<Record<string, unknown>> = [];
    const issue = {
      id: issueId,
      identifier: "MAZ-1535",
      title: "provider continuation held by legacy recovery",
      status: "blocked",
      projectId: "project-1",
      assigneeAgentId: "jules-orch",
      updatedAt: new Date().toISOString(),
      executionBlocker: {
        recoveryActionId,
        runId: failedRunId,
        agentId: "jules-orch",
        cause: "legacy_execution_requires_reconciliation",
        nextAction: "Automatic recovery stopped.",
      },
      executionState: {
        status: "idle",
        monitor: {
          kind: "external_service",
          serviceName: "jules",
          status: "cleared",
          clearReason: "invalid_status",
          externalRef: "[redacted]",
          timeoutAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          recoveryPolicy: "wake_owner",
        },
      },
      executionPolicy: {
        mode: "normal",
        stages: [{ id: "luna", type: "review", participants: [] }],
        commentRequired: true,
      },
    };
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "POST" && href.endsWith(`/api/issues/${issueId}/recovery-actions/resolve`)) {
        resolutions.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
        issue.status = "todo";
        return new Response(JSON.stringify({ issue }), { status: 200 });
      }
      if (method === "PATCH" && href.includes(`/api/issues/${issueId}`)) {
        patches.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      }
      if (method === "GET" && href.endsWith(`/api/heartbeat-runs/${failedRunId}`)) {
        return new Response(JSON.stringify({
          id: failedRunId,
          status: "failed",
          agentId: "jules-orch",
          errorCode: "jules_polling_error",
          error: "Paperclip API request failed (422): Entering blocked requires unresolved blockers, a pending interaction/approval, or unblockDescriptor",
          finishedAt: new Date().toISOString(),
        }), { status: 200 });
      }
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}/documents`)) {
        return new Response(JSON.stringify([{
          key: "jules-session",
          body: `julesSessionId: ${sessionId}\nurl: https://jules.google.com/session/${sessionId}`,
        }]), { status: 200 });
      }
      if (method === "GET" && href.endsWith(`/api/issues/${issueId}`)) {
        return new Response(JSON.stringify(issue), { status: 200 });
      }
      if (href.includes("/heartbeat-runs")) return new Response("[]", { status: 200 });
      if (href.endsWith("/agents") || href.includes("/agents?")) {
        return new Response(JSON.stringify([{
          id: "jules-orch",
          name: "[Orchestrated] Jules Async Worker",
          adapterType: "jules",
          status: "idle",
          reportsTo: "orch-1",
          metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" },
        }]), { status: 200 });
      }
      if (href.includes("/projects")) return new Response(JSON.stringify([
        {
          id: "project-1",
          name: "paperclip-adapters",
          primaryWorkspace: {
            cwd: process.cwd(),
            repoUrl: "https://github.com/Pilleo/paperclip-adapters.git",
            repoRef: "master",
          },
        },
      ]), { status: 200 });
      if (href.includes("/issues")) return new Response(JSON.stringify([issue]), { status: 200 });
      if (href.includes("/approvals")) return new Response("[]", { status: 200 });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const result = await execute(ctx());

    expect(result.exitCode).toBe(0);
    expect(resolutions).toEqual([{
      actionId: recoveryActionId,
      outcome: "restored",
      sourceIssueStatus: "todo",
      resolutionNote: expect.stringContaining("Jules polling run"),
      executionReconciliation: {
        runId: failedRunId,
        providerStopped: true,
        actionOutcome: "mixed",
        outcomeEvidence: expect.stringContaining(sessionId),
      },
    }]);
    expect(patches).toEqual([]);
  });

  it("restores a manually cleared Jules parent and wakes it once after its exact plan verdict", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const childPatches: Array<Record<string, unknown>> = [];
    const wakes: unknown[] = [];
    const parentId = "issue-1450";
    const childId = "plan-child-1450";
    const sessionId = "session-1450";
    const revisionId = "revision-1450";
    const parent = {
      id: parentId,
      identifier: "MAZ-1450",
      title: "resume typed plan verdict",
      // Paperclip may normalize a parent waiting on a child-owned native form
      // to blocked. The bridge must still consume the exact typed verdict;
      // accepting only backlog strands the Jules session indefinitely.
      status: "blocked",
      projectId: "project-1",
      assigneeAgentId: "jules-orch",
      updatedAt: new Date().toISOString(),
      executionPolicy: null,
      executionState: {
        status: "idle",
        monitor: {
          serviceName: "jules",
          status: "cleared",
          clearReason: "manual",
          externalRef: "[redacted]",
          timeoutAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    };
    const child = {
      id: childId,
      parentId,
      identifier: "MAZ-1451",
      title: "Review Jules plan",
      description: "<!-- jules-question-adjudication:v2|parent=issue-1450 -->",
      status: "backlog",
      projectId: "project-1",
      assigneeAgentId: "luna-1",
      updatedAt: new Date().toISOString(),
    };
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "POST" && href.includes("/agents/jules-orch/wakeup")) {
        wakes.push(JSON.parse(String(init?.body || "{}")));
        return new Response("{}", { status: 202 });
      }
      if (method === "PATCH" && href.endsWith(`/api/issues/${parentId}`)) {
        const patch = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        patches.push(patch);
        Object.assign(parent, patch);
        return new Response("{}", { status: 200 });
      }
      if (method === "PATCH" && href.endsWith(`/api/issues/${childId}`)) {
        const patch = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        childPatches.push(patch);
        Object.assign(child, patch);
        return new Response("{}", { status: 200 });
      }
      if (href.endsWith(`/api/issues/${parentId}/documents`)) {
        return new Response(JSON.stringify([{
          key: "jules-session",
          body: `julesSessionId: ${sessionId}\nurl: https://jules.google.com/session/${sessionId}`,
        }]), { status: 200 });
      }
      if (href.endsWith(`/api/issues/${childId}/interactions`)) {
        return new Response(JSON.stringify([{
          id: "plan-card-1450",
          kind: "request_item_verdicts",
          status: "answered",
          idempotencyKey: `jules:plan-review:v2:${parentId}:${sessionId}:${revisionId}:luna`,
          payload: { target: { type: "issue_document", issueId: parentId, key: "plan", revisionId } },
        }]), { status: 200 });
      }
      if (href.includes("/heartbeat-runs")) return new Response("[]", { status: 200 });
      if (href.endsWith("/agents") || href.includes("/agents?")) return new Response(JSON.stringify([{
        id: "jules-orch", name: "[Orchestrated] Jules Async Worker", adapterType: "jules", status: "idle", reportsTo: "orch-1",
        metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" },
      }]), { status: 200 });
      if (href.includes("/projects")) return new Response(JSON.stringify([
        { id: "project-1", name: "paperclip-adapters", primaryWorkspace: { cwd: process.cwd() } },
      ]), { status: 200 });
      if (method === "GET" && href.endsWith(`/api/issues/${parentId}`)) return new Response(JSON.stringify(parent), { status: 200 });
      if (href.includes("/issues")) return new Response(JSON.stringify([parent, child]), { status: 200 });
      if (href.includes("/approvals")) return new Response("[]", { status: 200 });
      if (method === "POST" || method === "PATCH") return new Response("{}", { status: 200 });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const result = await execute(ctx());
    expect(result.exitCode).toBe(0);
    // Paperclip's child relation can remain a real dependency even when the
    // adapter requested a non-blocking internal-review child. Close only the
    // exact child that owns the resolved v2 form before reviving its parent.
    expect(childPatches).toEqual([{ status: "done", blockParentUntilDone: false }]);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ status: "in_progress", assigneeAgentId: "jules-orch" });
    expect(wakes).toEqual([{
      source: "on_demand",
      triggerDetail: "ping",
      // This is the Jules adapter's closed protocol signal for an immediate
      // provider synchronization. It is not reviewer prose.
      reason: "synchronize_provider_plan_ready",
      forceFreshSession: false,
      payload: { issueId: parentId },
    }]);
    await execute(ctx());
    expect(childPatches).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(wakes).toHaveLength(1);
  });
});
