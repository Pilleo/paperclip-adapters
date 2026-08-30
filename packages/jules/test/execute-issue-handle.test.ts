import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";
import { readJulesSessionHandle } from "../src/server/paperclip-client";
import { loadStoredSession } from "../src/server/session-store";

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
    readJulesSessionHandle: vi.fn(),
    upsertJulesSessionHandle: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/server/session-store", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/session-store")>();
  return {
    ...mod,
    loadStoredSession: vi.fn().mockResolvedValue(null),
    saveStoredSession: vi.fn().mockResolvedValue(undefined),
  };
});

describe("Paperclip issue session handle restore", () => {
  beforeAll(() => {
    process.env.JULES_API_KEY = "test-key";
  });
  afterAll(() => {
    delete process.env.JULES_API_KEY;
  });
  beforeEach(() => vi.clearAllMocks());

  it("resumes from runtime.sessionId like Cursor Cloud when sessionParams are empty", async () => {
    vi.mocked(loadStoredSession).mockResolvedValue(null);
    vi.mocked(readJulesSessionHandle).mockResolvedValue(null);
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "cursor-style-id",
      state: "IN_PROGRESS",
    } as never);

    const result = await execute({
      agent: {
        id: "jules-1",
        companyId: "c-1",
        name: "Jules",
        adapterType: "jules",
        adapterConfig: { repository: "owner/repo", source: "sources/github/owner/repo", baseBranch: "main" },
      },
      config: { env: { JULES_API_KEY: "test-key" } },
      context: { task: { id: "issue-821", title: "Ping" } },
      runtime: { sessionId: "cursor-style-id", sessionParams: null, sessionDisplayId: "cursor-style-id" },
      runId: "run-runtime-id",
      authToken: "token",
      onLog: vi.fn(),
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.createSession).not.toHaveBeenCalled();
    expect(result.clearSession).toBe(false);
    expect(result.sessionDisplayId).toBe("cursor-style-id");
  });

  it("resumes the issue-handle session instead of createSession when runtime and disk are empty", async () => {
    vi.mocked(loadStoredSession).mockResolvedValue(null);
    vi.mocked(readJulesSessionHandle).mockResolvedValue("2024763132299585220");
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "2024763132299585220",
      state: "IN_PROGRESS",
    } as never);

    const result = await execute({
      agent: {
        id: "jules-1",
        companyId: "c-1",
        name: "Jules",
        adapterType: "jules",
        adapterConfig: { repository: "owner/repo", source: "sources/github/owner/repo", baseBranch: "main" },
      },
      config: { env: { JULES_API_KEY: "test-key" } },
      context: { task: { id: "issue-821", title: "Ping" } },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null },
      runId: "run-handle",
      authToken: "token",
      onLog: vi.fn(),
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.createSession).not.toHaveBeenCalled();
    expect(result.clearSession).toBe(false);
    expect(result.sessionDisplayId).toBe("2024763132299585220");
    expect(result.summary).toMatch(/2024763132299585220/);
  });
});
