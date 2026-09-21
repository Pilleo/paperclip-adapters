import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createServerAdapter } from "../../jules/src/server/index.js";
import { sessionCodec } from "../../jules/src/server/session.js";
import {
  getPaperclipJson,
  listPaperclipInteractions,
  readJulesSessionHandleState,
} from "../../jules/src/server/paperclip-client.js";
import {
  startScriptedJulesServer,
  type ScriptedJulesServer,
} from "./fixtures/scripted-jules-server.js";

vi.mock("../../jules/src/server/paperclip-client.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../jules/src/server/paperclip-client.js")>();
  return {
    ...mod,
    getPaperclipJson: vi.fn(),
    listPaperclipInteractions: vi.fn(),
    readJulesSessionHandleState: vi.fn().mockResolvedValue(null),
    scheduleJulesSessionMonitor: vi.fn().mockResolvedValue(undefined),
    upsertJulesSessionHandle: vi.fn().mockResolvedValue(undefined),
  };
});

describe("Jules restart lifecycle adapter boundary", () => {
  let server: ScriptedJulesServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    delete process.env.PAPERCLIP_ADAPTER_E2E;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_ADAPTER_E2E = "1";
    vi.mocked(readJulesSessionHandleState).mockResolvedValue(null);
    vi.mocked(getPaperclipJson).mockResolvedValue({
      id: "terra-run-1",
      agentId: "00000000-0000-4000-8000-000000000002",
      status: "succeeded",
      contextSnapshot: { issueId: "issue-1" },
      resultJson: {
        stdout: `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            server: "paperclip_review",
            tool: "submit_native_review_verdict",
            status: "completed",
            result: { structured_content: { interactionId: "terra-card-1", verdict: "approve" } },
          },
        })}\n`,
      },
    } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "terra-card-1",
      kind: "request_item_verdicts",
      status: "answered",
      addresseeAgentId: "00000000-0000-4000-8000-000000000002",
      resolvedByAgentId: "00000000-0000-4000-8000-000000000002",
      resolvedByRunId: "terra-run-1",
      idempotencyKey: "jules:plan-review:v2:issue-1:session-1:revision-1:terra",
      payload: {
        items: [{ id: "plan" }],
        target: { type: "issue_document", issueId: "issue-1", documentId: "document-1", key: "plan", revisionId: "revision-1", revisionNumber: 1 },
      },
      result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "approve" }] },
    }] as never);
  });

  it("reconciles an interrupted Terra approval through the adapter boundary after restart", async () => {
    // Break protected by this test: `execute` previously reconstructed every
    // reducer state as `not_started`, so a restarted adapter could not turn
    // durable provider progress into a cleared native-plan gate.
    server = await startScriptedJulesServer([
      {
        method: "GET",
        pathname: "/v1alpha/sessions/session-1",
        response: { status: 200, body: { name: "sessions/session-1", state: "AWAITING_PLAN_APPROVAL" } },
      },
      {
        method: "GET",
        pathname: "/v1alpha/sessions/session-1/activities",
        response: { status: 200, body: { activities: [] } },
      },
      {
        method: "GET",
        pathname: "/v1alpha/sessions/session-1",
        response: { status: 200, body: { name: "sessions/session-1", state: "IN_PROGRESS" } },
      },
      { method: "GET", pathname: "/v1alpha/sessions/session-1/activities", response: { status: 200, body: { activities: [] } } },
    ]);
    const adapter = createServerAdapter();
    const context = {
      agent: {
        id: "agent-jules", companyId: "company-1", name: "Jules", adapterType: "jules",
        adapterConfig: {
          source: "sources/github/example/repository", repository: "example/repository", baseBranch: "main",
          planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001",
          planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002", e2eProviderBaseUrl: server.baseUrl,
        },
      },
      runtime: {
        sessionId: "session-1",
        sessionParams: sessionCodec.encode({
          version: 1, paperclipIssueId: "issue-1", promptHash: "hash-1", promptHashVersion: 2,
          repository: "example/repository", source: "sources/github/example/repository", baseBranch: "main",
          phase: "WAITING_FOR_PLAN_APPROVAL", sessionId: "session-1", julesSessionId: "session-1",
          julesSessionUrl: "https://jules.example/session-1", attempt: 1, failedSessions: [], createdAt: "2026-09-20T00:00:00.000Z",
          pendingInteraction: {
            type: "plan_native_review", protocolVersion: 2, julesActivityId: "activity-plan-1", paperclipInteractionId: "terra-card-1",
            question: "Plan", planDocumentId: "document-1", planRevisionId: "revision-1", planRevisionNumber: 1,
            reviewerAgentId: "00000000-0000-4000-8000-000000000002", stage: "terra", createdAt: "2026-09-20T00:00:00.000Z",
          },
          lifecycleEffectJournal: {
            version: 1,
            effects: [{ effectId: "approve:session-1:revision-1", kind: "approve_plan", attempt: { kind: "started", startedAt: "2026-09-20T00:01:00.000Z" } }],
          },
        }),
        taskKey: "issue-1",
      },
      config: { env: { JULES_API_KEY: "test-key" } },
      context: { task: { id: "issue-1", title: "Restart canary", description: "Prove durable approval recovery." } },
      runId: "run-1", authToken: "jwt-token", onLog: vi.fn(),
    } as AdapterExecutionContext;

    const first = await adapter.execute(context);
    const restarted = await adapter.execute({ ...context, runtime: { ...context.runtime, sessionParams: first.sessionParams } });

    expect(sessionCodec.decode(restarted.sessionParams!)?.pendingInteraction).toBeUndefined();
    expect(server.requests()).toEqual([
      { method: "GET", pathname: "/v1alpha/sessions/session-1", body: undefined },
      { method: "GET", pathname: "/v1alpha/sessions/session-1/activities", body: undefined },
      { method: "GET", pathname: "/v1alpha/sessions/session-1", body: undefined },
      { method: "GET", pathname: "/v1alpha/sessions/session-1/activities", body: undefined },
    ]);
    expect(server.remainingSteps()).toEqual([]);
  });
});
