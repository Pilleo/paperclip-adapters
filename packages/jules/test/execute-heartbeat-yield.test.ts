import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";
import { sessionCodec } from "../src/server/session";
import { listPaperclipInteractions } from "../src/server/paperclip-client";

vi.mock("../src/server/jules-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/jules-client")>();
  const Mocked = vi.fn();
  Mocked.prototype.getSession = vi.fn();
  Mocked.prototype.getActivities = vi.fn().mockResolvedValue({ activities: [] });
  Mocked.prototype.createSession = vi.fn();
  Mocked.prototype.listSessions = vi.fn().mockResolvedValue({ sessions: [] });
  Mocked.prototype.approvePlan = vi.fn();
  Mocked.prototype.sendMessage = vi.fn();
  return { ...mod, JulesClient: Mocked };
});

vi.mock("../src/server/paperclip-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/paperclip-client")>();
  return {
    ...mod,
    listPaperclipInteractions: vi.fn().mockResolvedValue([]),
    listIssueComments: vi.fn().mockResolvedValue([]),
    getPaperclipInteraction: vi.fn(),
  };
});

describe("heartbeat yield vs session deadline", () => {
  const session = {
    version: 1 as const,
    paperclipIssueId: "issue-yield",
    promptHash: "hash",
    promptHashVersion: 2,
    repository: "owner/repo",
    source: "sources/github/owner/repo",
    baseBranch: "main",
    phase: "RUNNING" as const,
    sessionId: "session-live",
    julesSessionId: "session-live",
    attempt: 1,
    failedSessions: [],
    createdAt: new Date().toISOString(),
  };

  const ctx = (): AdapterExecutionContext =>
    ({
      agent: {
        id: "jules-1",
        companyId: "c-1",
        name: "Jules",
        adapterType: "jules",
        adapterConfig: {
          repository: "owner/repo",
          source: "sources/github/owner/repo",
          baseBranch: "main",
          pollCadenceSeconds: 30,
        },
      },
      config: { env: { JULES_API_KEY: "test-key" } },
      context: { task: { id: "issue-yield", title: "Ping" } },
      runtime: {
        sessionId: "session-live",
        sessionParams: sessionCodec.encode(session as never),
        sessionDisplayId: "session-live",
      },
      runId: "run-yield",
      authToken: "token",
      onLog: vi.fn(),
    }) as AdapterExecutionContext;

  beforeAll(() => {
    process.env.JULES_API_KEY = "test-key";
  });
  afterAll(() => {
    delete process.env.JULES_API_KEY;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);
  });

  it("yields after one IN_PROGRESS poll and keeps the Jules session id", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "IN_PROGRESS",
    } as never);

    const before = Date.now();
    const result = await execute(ctx());

    expect(JulesClient.prototype.createSession).not.toHaveBeenCalled();
    expect(JulesClient.prototype.getSession).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBe(false);
    expect(result.sessionDisplayId).toBe("session-live");
    expect(sessionCodec.decode(result.sessionParams!)?.julesSessionId).toBe("session-live");
    expect(result.summary).toMatch(/resume polling/);
    const retryAt = new Date(result.retryNotBefore!).getTime();
    expect(retryAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(retryAt).toBeLessThan(before + 90_000);
  });

  it("relays an accepted plan when Jules is AWAITING_PLAN_APPROVAL even if pendingInteraction is missing", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "AWAITING_PLAN_APPROVAL",
    } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([
      {
        id: "plan-card-accepted",
        kind: "request_confirmation",
        status: "accepted",
        result: { planRevisionId: "rev-1" },
      },
    ] as never);

    const result = await execute(ctx());

    expect(JulesClient.prototype.approvePlan).toHaveBeenCalledWith("session-live");
    expect(JulesClient.prototype.createSession).not.toHaveBeenCalled();
    expect(result.clearSession).toBe(false);
    expect(result.sessionDisplayId).toBe("session-live");
    const decoded = sessionCodec.decode(result.sessionParams!);
    expect(decoded?.planApprovedAt).toBeTruthy();
    expect(decoded?.pendingInteraction).toBeUndefined();
  });

  it("keeps polling a live Jules session older than sessionDeadlineMinutes and does not create a replacement", async () => {
    const aged = {
      ...session,
      createdAt: new Date(Date.now() - 2881 * 60 * 1000).toISOString(),
    };
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "IN_PROGRESS",
    } as never);

    const result = await execute({
      ...ctx(),
      runtime: {
        sessionId: "session-live",
        sessionParams: sessionCodec.encode(aged as never),
        sessionDisplayId: "session-live",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBe(false);
    expect(result.sessionDisplayId).toBe("session-live");
    expect(JulesClient.prototype.createSession).not.toHaveBeenCalled();
    expect(JulesClient.prototype.getSession).toHaveBeenCalledTimes(1);
  });
});
