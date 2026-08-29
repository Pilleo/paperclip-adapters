import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";

let storedSession: Record<string, unknown> | null = null;

vi.mock("../src/server/jules-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/jules-client")>();
  const MockedJulesClient = vi.fn();
  MockedJulesClient.prototype.createSession = vi.fn();
  MockedJulesClient.prototype.getSession = vi.fn();
  MockedJulesClient.prototype.getActivities = vi.fn().mockResolvedValue({ activities: [] });
  return { ...mod, JulesClient: MockedJulesClient };
});

vi.mock("../src/server/session-store", () => ({
  loadStoredSession: vi.fn(async () => storedSession),
  saveStoredSession: vi.fn(async (session) => {
    storedSession = session;
  }),
  deleteStoredSession: vi.fn(async () => {
    storedSession = null;
  }),
}));

describe("terminal Jules sessions", () => {
  const baseContext: AdapterExecutionContext = {
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Jules",
      adapterType: "jules",
      adapterConfig: {
        source: "sources/github/example/repository",
        repository: "example/repository",
        baseBranch: "main",
      },
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue-1" },
    config: { env: { JULES_API_KEY: 'test-key' } },
    context: { task: { id: "issue-1", title: "Original task", description: "Original description" } },
    runId: "run-1",
    onLog: vi.fn(),
  } as AdapterExecutionContext;

  beforeAll(() => {
    process.env.JULES_API_KEY = "test-key";
  });

  afterAll(() => {
    delete process.env.JULES_API_KEY;
  });

  beforeEach(() => {
    storedSession = null;
    vi.clearAllMocks();
  });

  it("clears a completed session so a reopened issue creates a fresh Jules task", async () => {
    vi.mocked(JulesClient.prototype.createSession)
      .mockResolvedValueOnce({ id: "session-a", name: "sessions/session-a" } as never)
      .mockResolvedValueOnce({ id: "session-b", name: "sessions/session-b" } as never);
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValueOnce({
      id: "session-a",
      name: "sessions/session-a",
      state: "COMPLETED",
      rawOutputs: [{ pullRequest: { url: "https://github.com/example/repository/pull/1" } }],
    } as never);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const checkpoint = await execute(baseContext);
    const completed = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: checkpoint.sessionParams! },
      authToken: "paperclip-token",
    });

    expect(completed.clearSession).toBe(true);
    expect(storedSession).toBeNull();
    expect(baseContext.onLog).toHaveBeenCalledWith(
      "stdout",
      expect.stringContaining("Reopening this Paperclip issue will start a new Jules task"),
    );

    const abortController = new AbortController();
    abortController.abort();
    const reopened = await execute({
      ...baseContext,
      runId: "run-2",
      runtime: { ...baseContext.runtime, sessionParams: null },
      context: {
        task: {
          id: "issue-1",
          title: "Reopened task",
          description: "Address the review feedback",
        },
      },
      abortSignal: abortController.signal,
    } as AdapterExecutionContext);

    expect(reopened.clearSession).toBe(false);
    expect(JulesClient.prototype.createSession).toHaveBeenCalledTimes(2);
    expect(JulesClient.prototype.getSession).toHaveBeenCalledTimes(1);
    expect(JulesClient.prototype.createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Reopened task",
        prompt: expect.stringContaining("Address the review feedback"),
      }),
    );
    expect(reopened.sessionParams).toMatchObject({ sessionId: "session-b", julesSessionId: "session-b" });
  });
});
