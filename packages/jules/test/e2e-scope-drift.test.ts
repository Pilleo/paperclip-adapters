import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute.js";
import { JulesClient } from "../src/server/jules-client.js";
import { sessionCodec } from "../src/server/session.js";
import { getPullRequestDetails, getPullRequestPatch, listPullRequestChangedFiles } from "../src/server/ci-status.js";

vi.mock("../src/server/ci-status.js", () => ({
  getPullRequestDetails: vi.fn(),
  getPullRequestCiStatus: vi.fn().mockResolvedValue("success"),
  listPullRequestChangedFiles: vi.fn(),
  getPullRequestPatch: vi.fn(),
}));

vi.mock("../src/server/jules-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/jules-client.js")>();
  const MockedJulesClient = vi.fn();
  MockedJulesClient.prototype.getSession = vi.fn();
  MockedJulesClient.prototype.getActivities = vi.fn();
  MockedJulesClient.prototype.sendMessage = vi.fn();
  MockedJulesClient.prototype.approvePlan = vi.fn();
  return { ...mod, JulesClient: MockedJulesClient };
});

vi.mock("../src/server/paperclip-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/paperclip-client.js")>();
  return {
    ...mod,
    createIssueComment: vi.fn().mockResolvedValue(undefined),
    listIssueComments: vi.fn().mockResolvedValue([]),
    listPaperclipInteractions: vi.fn().mockResolvedValue([]),
    moveIssueToBlocked: vi.fn(),
    moveIssueToInProgress: vi.fn(),
    moveIssueToReview: vi.fn(),
  };
});

const WORK_PACKAGE = `---
title: "Cap SandboxDispatcher poolCache growth"
component: "enforcer"
priority: high
target_files: ["enforcer/src/main/kotlin/io/mazewall/enforcer/SandboxDispatcher.kt"]
target_symbols: ["SandboxDispatcher#getOrCreate"]
---

**Context:** poolCache is unbounded.
**Needed:** Bound the cache at 32 entries with LRU eviction and add tests.
`;

describe("E2E host-plan scope conformity on Jules PRs", () => {
  const session = {
    version: 1 as const,
    paperclipIssueId: "issue-141",
    promptHash: "hash-141",
    promptHashVersion: 2,
    repository: "Pilleo/mazewall",
    source: "sources/github/Pilleo/mazewall",
    baseBranch: "master",
    phase: "RUNNING" as const,
    sessionId: "session-141",
    julesSessionId: "session-141",
    julesSessionUrl: "https://jules.example/session-141",
    attempt: 1,
    failedSessions: [],
    createdAt: "2026-08-30T00:00:00.000Z",
  };

  const adapterConfig = {
    env: { JULES_API_KEY: "test-key" },
    repository: "Pilleo/mazewall",
    baseBranch: "master",
    ciPolicy: "skip",
  };

  function ctx(): AdapterExecutionContext {
    return {
      agent: {
        id: "jules-1",
        companyId: "c-1",
        name: "Jules",
        adapterType: "jules",
        adapterConfig,
      },
      runtime: { sessionParams: sessionCodec.encode(session) },
      context: {
        task: {
          id: "issue-141",
          title: "Cap SandboxDispatcher poolCache growth",
          description: WORK_PACKAGE,
        },
      },
      config: adapterConfig,
      onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext;
  }

  beforeAll(() => {
    process.env.JULES_API_KEY = "test-key";
  });
  afterAll(() => {
    delete process.env.JULES_API_KEY;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-141",
      state: "COMPLETED",
      url: "https://jules.example/session-141",
      rawOutputs: [{ pullRequest: { url: "https://github.com/Pilleo/mazewall/pull/400" } }],
    });
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] });
    vi.mocked(JulesClient.prototype.sendMessage).mockResolvedValue(null);
    vi.mocked(getPullRequestDetails).mockResolvedValue({
      state: "OPEN",
      merged: false,
      ciStatus: "success",
      mergeableStatus: "mergeable",
    });
  });

  it("keeps the Jules session and relays a scoped fix when the PR adds unplanned files", async () => {
    vi.mocked(listPullRequestChangedFiles).mockResolvedValue([
      "enforcer/src/main/kotlin/io/mazewall/enforcer/SandboxDispatcher.kt",
      "README.md",
    ]);
    vi.mocked(getPullRequestPatch).mockResolvedValue("fun getOrCreate()");

    const result = await execute(ctx());
    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBe(false);
    expect(result.resultJson?.scopeConformant).toBe(false);
    expect(result.summary).toMatch(/drifted from the host plan/);
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith(
      "session-141",
      expect.objectContaining({
        prompt: expect.stringContaining("Unplanned"),
      }),
    );
  });

  it("does not flag drift when the PR stays inside declared files and symbols", async () => {
    vi.mocked(listPullRequestChangedFiles).mockResolvedValue([
      "enforcer/src/main/kotlin/io/mazewall/enforcer/SandboxDispatcher.kt",
    ]);
    vi.mocked(getPullRequestPatch).mockResolvedValue("+ fun getOrCreate() { /* LRU */ }");

    const result = await execute(ctx());
    expect(result.resultJson?.scopeConformant).not.toBe(false);
    expect(result.summary).not.toMatch(/drifted from the host plan/);
  });
});
