import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";
import { sessionCodec } from "../src/server/session";

vi.mock("../src/server/jules-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/jules-client")>();
  const Mocked = vi.fn();
  Mocked.prototype.getSession = vi.fn();
  Mocked.prototype.getActivities = vi.fn().mockResolvedValue({ activities: [] });
  Mocked.prototype.createSession = vi.fn();
  Mocked.prototype.listSessions = vi.fn().mockResolvedValue({ sessions: [] });
  return { ...mod, JulesClient: Mocked };
});

describe("process-lost reattach", () => {
  beforeAll(() => {
    process.env.JULES_API_KEY = "test-key";
  });
  afterAll(() => {
    delete process.env.JULES_API_KEY;
  });
  beforeEach(() => vi.clearAllMocks());

  it("does not createSession when sessionParams already has a live Jules id", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "IN_PROGRESS",
    } as never);
    vi.mocked(JulesClient.prototype.createSession).mockResolvedValue({
      id: "session-new",
      name: "sessions/session-new",
    } as never);

    const sessionParams = sessionCodec.encode({
      version: 1,
      paperclipIssueId: "issue-1",
      promptHash: "hash",
      promptHashVersion: 2,
      repository: "owner/repo",
      source: "sources/github/owner/repo",
      baseBranch: "main",
      phase: "RETRY_SCHEDULED",
      sessionId: "session-live",
      julesSessionId: "session-live",
      attempt: 1,
      failedSessions: [],
      createdAt: "2026-08-30T00:00:00.000Z",
    } as never);

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 20);
    const result = await execute({
      agent: {
        id: "jules-1",
        companyId: "c-1",
        name: "Jules",
        adapterType: "jules",
        adapterConfig: { repository: "owner/repo", source: "sources/github/owner/repo", baseBranch: "main" },
      },
      config: { env: { JULES_API_KEY: "test-key" } },
      context: { task: { id: "issue-1", title: "Task" } },
      runtime: { sessionId: null, sessionParams, sessionDisplayId: "session-live" },
      runId: "run-lost",
      authToken: "token",
      abortSignal: abort.signal,
      onLog: vi.fn(),
    } as never);

    expect(JulesClient.prototype.createSession).not.toHaveBeenCalled();
    expect(result.clearSession).toBe(false);
    expect(result.sessionDisplayId).toBe("session-live");
  });
});
